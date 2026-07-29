# Changelog

## 1.1.0 — 2026-07-29

### Install as app (PWA)

- Progressive Web App support: `manifest.webmanifest`, service worker (`sw.js`), 192/512 icons
- **Install app** control in the sidebar (when the browser offers a prompt) and **Settings → Install Reliquary** with Chrome / Edge / Safari / iOS instructions
- Standalone window experience (Applications / Start menu / Dock / taskbar pin) without requiring a native binary
- README + START-HERE: browser install is the primary path; Tauri desktop packaging remains optional

### Notes for builders

- Serve over HTTP(S) — `./start.sh` / `start.bat` or any static host. Do not open `index.html` via `file://`
- Public HTTPS host later reuses the same Install flow for end users
- Service worker uses network-first caching for same-origin assets so local development stays fresh
- Optional Tauri shell (`src-tauri/`) is unchanged and not required for normal use
