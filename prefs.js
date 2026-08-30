import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SessionRestorerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        
        // General Settings Group
        const group = new Adw.PreferencesGroup({
            title: _('General Settings'),
            description: _('Configure session saving and restoration behavior')
        });
        page.add(group);

        // Debounce Delay Setting
        const debounceRow = new Adw.SpinRow({
            title: _('Save Debounce Delay (seconds)'),
            subtitle: _('Time to wait after window movement before writing session state to disk'),
            adjustment: new Gtk.Adjustment({
                value: 1,
                lower: 1,
                upper: 10,
                step_increment: 1,
            }),
        });
        group.add(debounceRow);

        // HMAC Security Verification Setting
        const hmacRow = new Adw.SwitchRow({
            title: _('HMAC-SHA256 Integrity Protection'),
            subtitle: _('Cryptographically verify session file signature with secret key before launch'),
            active: true,
        });
        group.add(hmacRow);

        // Security & Storage Group
        const storageGroup = new Adw.PreferencesGroup({
            title: _('Security & Privacy Specs'),
            description: _('Directory permissions and cryptographic verification')
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
            description: _('Persistent rotating log file location')
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
