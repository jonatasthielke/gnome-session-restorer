# GNOME Session Restorer Extension

A lightweight, high-performance, automatic session saving and window restoration extension built natively for GNOME 50 Wayland.

## Features

- **Event-Driven Architecture**: 0.00% CPU overhead, 0 polling loops. Only saves when windows finish moving or closing.
- **Debounced Real-Time State Persistence**: Saves window locations, sizes, and workspaces 1 second after window movements.
- **Freeze-on-Shutdown Protection**: Intercepts DBus `PrepareForShutdown` from `org.gnome.SessionManager` and freezes writes so partial app closures during system shutdown never overwrite your complete session file.
- **Cryptographic HMAC-SHA256 Integrity Verification**: Protects `session.json` with a secret key (`.key`) signature check. Tampered or modified session files are automatically rejected on boot.
- **Automatic Log Rotation**: Writes persistent logs to `~/.config/gnome-session-restorer/session-restorer.log` with a 1 MB size limit to prevent disk bloat.

## Installation

To install and enable this extension on GNOME Shell 45, 46, 47, 48, 49, or 50:

### 1. Clone the repository into your GNOME extensions directory
```bash
mkdir -p ~/.local/share/gnome-shell/extensions
git clone https://github.com/jonatasthielke/gnome-session-restorer.git ~/.local/share/gnome-shell/extensions/session-restorer@thielke
```

### 2. Enable the extension
```bash
gnome-extensions enable session-restorer@thielke
```

*Note: On Wayland, you must log out and log back in (or restart your desktop session) after installation so GNOME Shell loads the new extension into memory.*

### 3. Verify status
```bash
gnome-extensions info session-restorer@thielke
```

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

## Development & Contributions

Contributions are welcome! Please follow these steps to submit a Pull Request:

1. **Fork** the repository on GitHub.
2. **Clone** your fork to your local GNOME extensions directory:
   ```bash
   git clone https://github.com/<your-username>/gnome-session-restorer.git ~/.local/share/gnome-shell/extensions/session-restorer@thielke
   ```
3. **Create a branch** for your feature or fix:
   ```bash
   git checkout -b feature/my-feature-name
   ```
4. **Commit** your changes:
   ```bash
   git commit -m "Add descriptive commit message"
   ```
5. **Push** to your fork and open a **Pull Request**:
   ```bash
   git push origin feature/my-feature-name
   ```
