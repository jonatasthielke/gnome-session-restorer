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
        this._logFile = GLib.build_filenamev([this._configDir, 'session-restorer.log']);
        this._isShuttingDown = false;
        this._windowSignals = new Map();
        this._saveTimeoutId = 0;

        // Ensure private user permissions (0700) for security
        GLib.mkdir_with_parents(this._configDir, 0o700);

        this._log('INFO', 'Extension enabled. Initializing Session Restorer.');

        // Self-Integrity Verification: Detect code tampering on disk
        if (!this._verifySelfIntegrity()) {
            this._log('SECURITY', 'CRITICAL ALERT: Extension initialization aborted due to code tampering on extension.js.');
            return;
        }

        this._windowTracker = Shell.WindowTracker.get_default();
        this._appSystem = Shell.AppSystem.get_default();
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

        // Save current initial open window state immediately
        this._saveCurrentSessionDebounced();

        // Restore previously saved session on login
        this._restoreSession();
    }

    disable() {
        this._log('INFO', 'Extension disabling. Cleaning up resources.');

        if (this._saveTimeoutId) {
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
        }

        if (this._windowCreatedId) {
            this._display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }

        if (this._globalRestoreSignalId) {
            this._display.disconnect(this._globalRestoreSignalId);
            this._globalRestoreSignalId = 0;
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

    _verifySelfIntegrity() {
        try {
            let extensionJsPath = GLib.build_filenamev([this.path, 'extension.js']);
            let signaturePath = GLib.build_filenamev([this.path, '.code-signature']);

            if (!GLib.file_test(extensionJsPath, GLib.FileTest.EXISTS) || !GLib.file_test(signaturePath, GLib.FileTest.EXISTS)) {
                return true;
            }

            let [success, contents] = GLib.file_get_contents(extensionJsPath);
            if (!success) return false;

            let [sigSuccess, sigContents] = GLib.file_get_contents(signaturePath);
            if (!sigSuccess) return false;

            let fileData = new TextDecoder().decode(contents);
            let expectedHash = new TextDecoder().decode(sigContents).trim();
            let currentHash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, fileData, -1);

            if (currentHash !== expectedHash) {
                this._log('SECURITY', `CRITICAL SECURITY ALERT: extension.js SHA-256 hash mismatch! Current: ${currentHash}, Expected: ${expectedHash}`);
                return false;
            }
            return true;
        } catch (e) {
            return true;
        }
    }

    _log(level, msg) {
        let timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
        let formattedMsg = `[${timestamp}] [${level}] ${msg}`;

        if (level === 'ERROR' || level === 'SECURITY') {
            console.error(`[Session Restorer] ${formattedMsg}`);
        } else {
            console.log(`[Session Restorer] ${formattedMsg}`);
        }

        try {
            if (!this._logFile) return;

            // Rotate log file if > 1 MB
            if (GLib.file_test(this._logFile, GLib.FileTest.EXISTS)) {
                let fileObj = Gio.File.new_for_path(this._logFile);
                let info = fileObj.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
                if (info && info.get_size() > 1024 * 1024) {
                    GLib.file_set_contents(this._logFile, `${formattedMsg}\n[Log Rotated]\n`);
                    return;
                }
            }

            let file = Gio.File.new_for_path(this._logFile);
            let stream = file.append_to_path(Gio.FileCreateFlags.NONE, null);
            let encoder = new TextEncoder();
            stream.write_all(encoder.encode(`${formattedMsg}\n`), null);
            stream.close(null);
        } catch (e) {
            // Ignore persistent log writing errors
        }
    }

    _getSecretKey() {
        if (GLib.file_test(this._keyFile, GLib.FileTest.EXISTS)) {
            let [success, contents] = GLib.file_get_contents(this._keyFile);
            if (success) return new TextDecoder().decode(contents).trim();
        }

        // Cryptographically secure PRNG using OS entropy (getrandom / urandom via GLib.uuid_string_random)
        let csprngEntropy = `${GLib.uuid_string_random()}-${GLib.uuid_string_random()}-${GLib.get_real_time()}`;
        let secretKey = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, csprngEntropy, -1);
        GLib.file_set_contents(this._keyFile, secretKey);
        GLib.chmod(this._keyFile, 0o600);
        this._log('INFO', 'Generated new CSPRNG-backed HMAC secret key file.');
        return secretKey;
    }

    _computeHMAC(dataString) {
        let secretKey = this._getSecretKey();
        return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, `${dataString}:${secretKey}`, -1);
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
                        this._log('INFO', 'PrepareForShutdown DBus signal received. Session state frozen.');
                    });
                    this._log('INFO', 'Connected to org.gnome.SessionManager PrepareForShutdown signal.');
                } catch (e) {
                    this._log('ERROR', `Failed to init DBus shutdown proxy: ${e}`);
                }
            });
        } catch (e) {
            this._log('ERROR', `DBus setup error: ${e}`);
        }
    }

    _resolveAppForWindow(win) {
        if (!win) return null;

        let app = this._windowTracker.get_window_app(win);
        if (app && app.get_id()) return app.get_id();

        let wmClass = win.get_wm_class ? win.get_wm_class() : null;
        if (wmClass) {
            let matchedApp = this._appSystem.lookup_app_by_wmclass(wmClass);
            if (matchedApp && matchedApp.get_id()) return matchedApp.get_id();
        }

        let wmInstance = win.get_wm_class_instance ? win.get_wm_class_instance() : null;
        if (wmInstance) {
            let matchedApp = this._appSystem.lookup_app_by_wmclass(wmInstance);
            if (matchedApp && matchedApp.get_id()) return matchedApp.get_id();
        }

        let gtkId = win.get_gtk_application_id ? win.get_gtk_application_id() : null;
        if (gtkId) {
            let matchedApp = this._appSystem.lookup_app(`${gtkId}.desktop`);
            if (matchedApp && matchedApp.get_id()) return matchedApp.get_id();
        }

        return null;
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
            this._log('DEBUG', 'Shutdown in progress. Preserving last complete session on disk.');
            return;
        }

        try {
            let workspaceManager = global.workspace_manager;
            let nWorkspaces = workspaceManager.n_workspaces;
            let openApps = [];

            for (let i = 0; i < nWorkspaces; i++) {
                let ws = workspaceManager.get_workspace_by_index(i);
                let windows = ws.list_windows();
                let stackIndex = 0;

                for (let win of windows) {
                    if (!win || win.skip_taskbar) continue;

                    let appId = this._resolveAppForWindow(win);
                    if (!appId) continue;

                    let rect = win.get_frame_rect();

                    openApps.push({
                        app_id: appId,
                        workspace: i,
                        stack_index: stackIndex++,
                        monitor: win.get_monitor ? win.get_monitor() : 0,
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                        is_maximized: win.is_maximized ? win.is_maximized() : false,
                    });
                }
            }

            // Protective Guard: Never overwrite session with an empty list if shutting down or if windows were already closed by OS!
            if (openApps.length === 0) {
                this._log('DEBUG', 'Skipping overwrite: openApps list is empty.');
                return;
            }

            let payloadObj = { timestamp: Date.now(), apps: openApps };
            let payloadStr = JSON.stringify(payloadObj);
            let signature = this._computeHMAC(payloadStr);

            let data = JSON.stringify({ ...payloadObj, signature }, null, 2);
            GLib.file_set_contents(this._sessionFile, data);
            this._log('INFO', `Saved session state successfully (${openApps.length} apps with stack Z-index).`);
        } catch (e) {
            this._log('ERROR', `Error saving session: ${e}`);
        }
    }

    _restoreSession() {
        try {
            if (!GLib.file_test(this._sessionFile, GLib.FileTest.EXISTS)) {
                this._log('INFO', 'No previous session.json file found to restore.');
                return;
            }

            let [success, contents] = GLib.file_get_contents(this._sessionFile);
            if (!success) {
                this._log('ERROR', 'Failed to read session.json file contents.');
                return;
            }

            let session = JSON.parse(new TextDecoder().decode(contents));
            if (!session || !session.apps || session.apps.length === 0 || !session.signature) {
                this._log('WARN', 'Invalid session file structure or missing HMAC signature.');
                return;
            }

            // Cryptographic HMAC Integrity Check
            let { signature, ...payloadObj } = session;
            let payloadStr = JSON.stringify(payloadObj);
            let expectedSignature = this._computeHMAC(payloadStr);

            if (signature !== expectedSignature) {
                this._log('SECURITY', 'SECURITY WARNING: HMAC signature mismatch! Tampering detected. Session discarded.');
                return;
            }

            // Sort apps by workspace and Z-index stack order so windows open from back to front
            session.apps.sort((a, b) => (a.stack_index || 0) - (b.stack_index || 0));

            this._log('INFO', `Session signature verified successfully. Restoring ${session.apps.length} apps in Z-index stack order.`);

            let launchedApps = new Set();
            let matchedWindows = new Set();
            let workspaceManager = global.workspace_manager;

            // Global window-created signal listener for single-pass 1-to-1 window matching
            this._globalRestoreSignalId = this._display.connect('window-created', (display, win) => {
                if (matchedWindows.has(win)) return;

                let winAppId = this._resolveAppForWindow(win);
                let wmClass = win.get_wm_class ? win.get_wm_class() : null;

                // Find the first unmatched stored item that corresponds to this newly created window
                let targetItem = session.apps.find(item => {
                    if (item._matched) return false;
                    let isMatch = (winAppId && winAppId === item.app_id) || 
                                  (wmClass && item.app_id.toLowerCase().includes(wmClass.toLowerCase()));
                    return isMatch;
                });

                if (targetItem) {
                    targetItem._matched = true;
                    matchedWindows.add(win);

                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                        try {
                            if (win && win.get_workspace) {
                                this._log('INFO', `Restoring window position for ${targetItem.app_id} [Stack Z-index ${targetItem.stack_index || 0}]: (${targetItem.x}, ${targetItem.y}) ${targetItem.width}x${targetItem.height}`);
                                
                                // Restore workspace assignment
                                if (targetItem.workspace !== undefined && workspaceManager) {
                                    let ws = workspaceManager.get_workspace_by_index(targetItem.workspace);
                                    if (ws && win.change_workspace) {
                                        win.change_workspace(ws);
                                    }
                                }

                                win.move_resize_frame(false, targetItem.x, targetItem.y, targetItem.width, targetItem.height);

                                if (targetItem.is_maximized && win.maximize) {
                                    win.maximize(Meta.MaximizeFlags.BOTH);
                                }

                                if (win.raise) {
                                    win.raise();
                                }
                            }
                        } catch (err) {}
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });

            // Disconnect global restore listener after 15 seconds
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
                if (this._globalRestoreSignalId) {
                    this._display.disconnect(this._globalRestoreSignalId);
                    this._globalRestoreSignalId = 0;
                }
                return GLib.SOURCE_REMOVE;
            });

            // Staggered launch queue: launch apps with 400ms delay between each app to prevent boot CPU/RAM I/O storms
            let delayOffset = 0;

            session.apps.forEach((item) => {
                if (!item.app_id || typeof item.app_id !== 'string') return;

                // Security Check: Sanitize app_id against directory traversal or suspicious paths
                if (item.app_id.includes('/') || item.app_id.includes('..') || !item.app_id.endsWith('.desktop')) {
                    this._log('SECURITY', `SECURITY WARNING: Invalid or suspicious app_id rejected: ${item.app_id}`);
                    return;
                }

                let app = this._appSystem.lookup_app(item.app_id);
                if (app) {
                    if (!launchedApps.has(item.app_id)) {
                        launchedApps.add(item.app_id);

                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayOffset, () => {
                            try {
                                this._log('INFO', `Staggered launching application: ${item.app_id}`);
                                app.launch(0, -1, Gio.AppLaunchContext.new());
                            } catch (err) {
                                this._log('ERROR', `Failed to launch ${item.app_id}: ${err}`);
                            }
                            return GLib.SOURCE_REMOVE;
                        });

                        delayOffset += 400; // 400ms stagger interval per app
                    }
                } else {
                    this._log('WARN', `Could not find desktop app for ID: ${item.app_id}`);
                }
            });
        } catch (e) {
            this._log('ERROR', `Error restoring session: ${e}`);
        }
    }
}
