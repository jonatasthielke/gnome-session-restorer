# GNOME Session Restorer Extension

A lightweight, high-performance, automatic session saving and window restoration extension built natively for GNOME 50 Wayland.

## Features

- **Event-Driven Architecture**: 0.00% CPU overhead, 0 polling loops. Only saves when windows finish moving or closing.
- **Debounced Real-Time State Persistence**: Saves window locations, sizes, and workspaces 1 second after window movements.
- **Freeze-on-Shutdown Protection**: Intercepts DBus `PrepareForShutdown` from `org.gnome.SessionManager` and freezes writes so partial app closures during system shutdown never overwrite your complete session file.
- **Cryptographic HMAC-SHA256 Integrity Verification**: Protects `session.json` with a secret key (`.key`) signature check. Tampered or modified session files are automatically rejected on boot.
- **Automatic Log Rotation**: Writes persistent logs to `~/.config/gnome-session-restorer/session-restorer.log` with a 1 MB size limit to prevent disk bloat.

## Security & Privacy

- Configuration directory permissions set to `0700` (read/write/exec exclusively by owner).
- Secret key stored at `~/.config/gnome-session-restorer/.key` with `0600` permissions.
- Atomic file writes using `GLib.file_set_contents` (writes to `.tmp` and renames atomically) ensuring zero file corruption during power outages.

## Monitoring & Logs

### Viewing Persistent Logs
```bash
cat ~/.config/gnome-session-restorer/session-restorer.log
```

### Live Monitoring
```bash
tail -f ~/.config/gnome-session-restorer/session-restorer.log
```

### Systemd Journal Inspection
```bash
journalctl --user -u gnome-shell -f | grep "[Session Restorer]"
```

## Installation & Git Repository

The extension is installed locally at:
`~/.local/share/gnome-shell/extensions/session-restorer@thielke`

### Pushing to GitHub
1. Create a repository named `gnome-session-restorer` on GitHub.
2. Push your commits:
   ```bash
   cd ~/.local/share/gnome-shell/extensions/session-restorer@thielke
   git push -u origin main
   ```
