# GNOME Session Restorer Extension

A lightweight, automatic session saving and window restoration extension for GNOME 50 Wayland.

## Features
- **Automatic Session Tracking**: Continuously saves running desktop applications and window geometries.
- **Shutdown Resilience**: Captures open applications before system shutdown/reboot via DBus `org.gnome.SessionManager`.
- **Seamless Restoration**: Automatically launches and positions open applications upon logging into GNOME.
