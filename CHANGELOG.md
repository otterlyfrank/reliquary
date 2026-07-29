# Changelog

## 1.2.0 — 2026-07-29

### Mobile, vault, and shell (P0–P2)

- **Mobile:** bottom primary nav (Start / Pieces / Boards / More), hamburger + drawer sidebar with backdrop, safe-area padding
- **Vault backup:** Settings → export / import full IndexedDB snapshot (API keys redacted by default)
- **IA:** primary nav collapsed under **More** (Starred, Work on later, Archive, Collections, Settings)
- **A11y:** skip link, `aria-current` / live regions on toasts, icon button labels, reduced-motion aware toasts
- **Support:** Ko-fi defaults to `otterlyfrank`; empty GitHub Sponsors is hidden (no generic placeholder)
- **Fonts:** system stack first; optional Google Fonts load non-blocking when online
- **Pieces:** shelf chips, pagination (48/page), post-import excavation ribbon
- **Shell:** partial chrome updates (no full rebuild every navigation)
- **Monogram:** `public/reliquary-mark.svg` brand mark
- **Storyboards:** keyboard reorder (Alt/⌥ + ↑↓), focusable items
- **Collections → Storyboard** one-click migration
- **⌘K / Ctrl+K** command palette for navigation and vault actions
- **Import:** cooperative yield between files; large plain-text parse off main thread when Workers available
- **Tests:** `npm test` covers offline chunk engine

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
