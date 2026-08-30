import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class SessionRestorer extends Extension {
    enable() {
        this._configDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'gnome-session-restorer']);
        this._sessionFile = GLib.build_filenamev([this._configDir, 'session.json']);
        this._keyFile = GLib.build_filenamev([this._configDir, '.key']);
        this._isShuttingDown = false;
        this._windowSignals = new Map();
        this._saveTimeoutId = 0;

        // Ensure private user permissions (0700) for security
        GLib.mkdir_with_parents(this._configDir, 0o700);

        this._windowTracker = Shell.WindowTracker.get_default();
        this._display = global.display;

        // Listen for window creation to track open apps
        this._windowCreatedId = this._display.connect('window-created', (display, window) => {
            this._onWindowCreated(window);
        });

        // Track existing windows on extension startup
        let workspaceManager = global.workspace_manager;
        let nWorkspaces = workspaceManager.n_workspaces;
        for (let i = 0; i < nWorkspaces; i++) {
            let ws = workspaceManager.get_workspace_by_index(i);
            let windows = ws.list_windows();
            for (let win of windows) {
                this._onWindowCreated(win);
            }
        }

        // Listen for session shutdown signals via DBus
        this._connectShutdownSignals();

        // Restore previously saved session on login
        this._restoreSession();
    }

    disable() {
        if (this._saveTimeoutId) {
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
        }

        if (this._windowCreatedId) {
            this._display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }

        if (this._sessionProxy && this._shutdownSignalId) {
            this._sessionProxy.disconnectSignal(this._shutdownSignalId);
            this._shutdownSignalId = 0;
        }

        // Clean up connected window signals to prevent memory leaks
        for (let [win, signals] of this._windowSignals.entries()) {
            try {
                for (let sigId of signals) {
                    win.disconnect(sigId);
                }
            } catch (e) {}
        }
        this._windowSignals.clear();
    }

    _getSecretKey() {
        if (GLib.file_test(this._keyFile, GLib.FileTest.EXISTS)) {
            let [success, contents] = GLib.file_get_contents(this._keyFile);
            if (success) return new TextDecoder().decode(contents).trim();
        }

        let randomSeed = `${GLib.get_monotonic_time()}-${GLib.get_host_name()}-${Math.random()}`;
        let secretKey = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, randomSeed);
        GLib.file_set_contents(this._keyFile, secretKey);
        GLib.chmod(this._keyFile, 0o600);
        return secretKey;
    }

    _computeHMAC(dataString) {
        let secretKey = this._getSecretKey();
        return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, `${dataString}:${secretKey}`);
    }

    _connectShutdownSignals() {
        try {
            this._sessionProxy = new Gio.DBusProxy({
                g_bus_type: Gio.BusType.SESSION,
                g_name: 'org.gnome.SessionManager',
                g_object_path: '/org/gnome/SessionManager',
                g_interface_name: 'org.gnome.SessionManager',
            });

            this._sessionProxy.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, res) => {
                try {
                    this._sessionProxy.init_finish(res);
                    this._shutdownSignalId = this._sessionProxy.connectSignal('PrepareForShutdown', () => {
                        this._isShuttingDown = true;
                        console.log('[Session Restorer] PrepareForShutdown signal received. Session state frozen.');
                    });
                } catch (e) {
                    console.error('[Session Restorer] Failed to connect DBus shutdown signal:', e);
                }
            });
        } catch (e) {
            console.error('[Session Restorer] DBus setup error:', e);
        }
    }

    _onWindowCreated(window) {
        if (!window || window.skip_taskbar) return;

        let rectId = window.connect('notify::frame-rect', () => {
            if (!this._isShuttingDown) {
                this._saveCurrentSessionDebounced();
            }
        });

        let unmanageId = window.connect('unmanaging', () => {
            if (this._windowSignals.has(window)) {
                let signals = this._windowSignals.get(window);
                for (let sigId of signals) {
                    try { window.disconnect(sigId); } catch (e) {}
                }
                this._windowSignals.delete(window);
            }
            if (!this._isShuttingDown) {
                this._saveCurrentSessionDebounced();
            }
        });

        this._windowSignals.set(window, [rectId, unmanageId]);
    }

    _saveCurrentSessionDebounced() {
        if (this._saveTimeoutId) {
            GLib.source_remove(this._saveTimeoutId);
        }
        this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._saveTimeoutId = 0;
            this._saveCurrentSession();
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveCurrentSession() {
        if (this._isShuttingDown) {
            console.log('[Session Restorer] Shutdown in progress. Preserving last complete session on disk.');
            return;
        }

        try {
            let workspaceManager = global.workspace_manager;
            let nWorkspaces = workspaceManager.n_workspaces;
            let openApps = [];

            for (let i = 0; i < nWorkspaces; i++) {
                let ws = workspaceManager.get_workspace_by_index(i);
                let windows = ws.list_windows();

                for (let win of windows) {
                    if (!win || win.skip_taskbar) continue;

                    let app = this._windowTracker.get_window_app(win);
                    if (!app) continue;

                    let appId = app.get_id(); // e.g. com.google.Chrome.desktop or antigravity.desktop
                    if (!appId) continue;

                    let rect = win.get_frame_rect();

                    openApps.push({
                        app_id: appId,
                        workspace: i,
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                        is_maximized: win.is_maximized(),
                    });
                }
            }

            // Protective Guard: Never overwrite session with an empty list if shutting down or if windows were already closed by OS!
            if (openApps.length === 0) {
                console.log('[Session Restorer] Skipping overwrite: openApps list is empty.');
                return;
            }

            let payloadObj = { timestamp: Date.now(), apps: openApps };
            let payloadStr = JSON.stringify(payloadObj);
            let signature = this._computeHMAC(payloadStr);

            let data = JSON.stringify({ ...payloadObj, signature }, null, 2);
            GLib.file_set_contents(this._sessionFile, data);
            console.log('[Session Restorer] Saved open session apps with signature verification:', openApps.length);
        } catch (e) {
            console.error('[Session Restorer] Error saving session:', e);
        }
    }

    _restoreSession() {
        try {
            if (!GLib.file_test(this._sessionFile, GLib.FileTest.EXISTS)) {
                return;
            }

            let [success, contents] = GLib.file_get_contents(this._sessionFile);
            if (!success) return;

            let session = JSON.parse(new TextDecoder().decode(contents));
            if (!session || !session.apps || session.apps.length === 0 || !session.signature) {
                console.warn('[Session Restorer] Invalid session file structure or missing signature.');
                return;
            }

            // Cryptographic HMAC Integrity Check
            let { signature, ...payloadObj } = session;
            let payloadStr = JSON.stringify(payloadObj);
            let expectedSignature = this._computeHMAC(payloadStr);

            if (signature !== expectedSignature) {
                console.error('[Session Restorer] SECURITY WARNING: Session file signature mismatch! Tampering detected. Session discarded.');
                return;
            }

            console.log('[Session Restorer] Session signature verified successfully. Restoring apps:', session.apps.length);

            let appSystem = Shell.AppSystem.get_default();
            let launchedApps = new Set();

            session.apps.forEach(item => {
                if (!item.app_id) return;

                let app = appSystem.lookup_app(item.app_id);
                if (app) {
                    if (!launchedApps.has(item.app_id)) {
                        launchedApps.add(item.app_id);
                        app.launch(0, -1, Gio.AppLaunchContext.new());
                    }

                    // Connect to new windows of this app to position them
                    let onWindowCreated = (display, win) => {
                        let winApp = this._windowTracker.get_window_app(win);
                        if (winApp && winApp.get_id() === item.app_id) {
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                                try {
                                    if (win && win.get_workspace) {
                                        win.move_resize_frame(false, item.x, item.y, item.width, item.height);
                                    }
                                } catch (err) {}
                                return GLib.SOURCE_REMOVE;
                            });
                        }
                    };

                    let signalId = this._display.connect('window-created', onWindowCreated);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                        this._display.disconnect(signalId);
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
        } catch (e) {
            console.error('[Session Restorer] Error restoring session:', e);
        }
    }
}
