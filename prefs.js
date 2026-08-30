import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SessionRestorerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        // General Settings Group
        const group = new Adw.PreferencesGroup({
            title: _('General Settings'),
            description: _('Configure session saving and restoration behavior'),
        });
        page.add(group);

        // Bug 4 fix: Debounce Delay — bound to GSettings key 'debounce-delay'
        const debounceRow = new Adw.SpinRow({
            title: _('Save Debounce Delay (seconds)'),
            subtitle: _('Time to wait after a window event before saving session state to disk'),
            adjustment: new Gtk.Adjustment({
                value: settings.get_int('debounce-delay'),
                lower: 1,
                upper: 10,
                step_increment: 1,
            }),
        });
        settings.bind('debounce-delay', debounceRow, 'value', 0);
        group.add(debounceRow);

        // Bug 4 fix: HMAC toggle — bound to GSettings key 'hmac-enabled'
        const hmacRow = new Adw.SwitchRow({
            title: _('HMAC-SHA256 Integrity Protection'),
            subtitle: _('Cryptographically verify session file signature before restoring apps on login'),
        });
        settings.bind('hmac-enabled', hmacRow, 'active', 0);
        group.add(hmacRow);

        // Security & Storage Group
        const storageGroup = new Adw.PreferencesGroup({
            title: _('Security & Privacy Specs'),
            description: _('Directory permissions and cryptographic verification'),
        });
        page.add(storageGroup);

        const configPathRow = new Adw.ActionRow({
            title: _('Configuration Directory'),
            subtitle: '~/.config/gnome-session-restorer (Permissions: 0700)',
        });
        storageGroup.add(configPathRow);

        const keyPathRow = new Adw.ActionRow({
            title: _('Cryptographic Key File'),
            subtitle: '~/.config/gnome-session-restorer/.key (Permissions: 0600)',
        });
        storageGroup.add(keyPathRow);

        // Logs & Troubleshooting Group
        const logsGroup = new Adw.PreferencesGroup({
            title: _('Logs & Diagnostics'),
            description: _('Persistent rotating log file location'),
        });
        page.add(logsGroup);

        const viewLogsRow = new Adw.ActionRow({
            title: _('Session Restorer Log File'),
            subtitle: '~/.config/gnome-session-restorer/session-restorer.log (Max 1 MB)',
        });
        logsGroup.add(viewLogsRow);

        window.add(page);
    }
}
