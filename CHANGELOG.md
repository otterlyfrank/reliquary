# Changelog

## 1.4.0 — 2026-08-27

### First-class Ollama + xAI (private-enough cloud)

Optional AI is no longer a raw URL field.

- **Provider picker:** Off (default) · Ollama (this machine) · xAI Grok API · custom
- **Local proxy** (`serve.py`, used by `./start.sh`): xAI key from `Reliquary/.env` never has to sit in the browser vault; Ollama models are listed from this machine
- **Ollama:** discovers installed models, warns on 3B-class names (`llama3.2`). Use 8B+
- **xAI:** privacy acknowledgement required; drafts still leave the machine. No training on API traffic by default; ~30-day logs; team **Zero Data Retention** is a Console toggle (the response header is shown if present)
- Default Grok model: **grok-4.6** (low reasoning effort for fragmenting)
- Service worker does not cache `/api/llm/*`
- **Settings** has numbered API-key steps (console.x.ai → `.env` → restart → Test)
- **Clean launch:** `./start.sh` waits until HTTP answers before opening the browser, and takes over a stale `python -m http.server` on :8780. Port-in-use prints a fix instead of a traceback.

Hard-refresh (`Cmd+Shift+R`). Restart `./start.sh` so the proxy is running. Copy `.env.example` → `.env` if you use xAI.

## 1.3.4 — 2026-08-24

### Fragment desk, not a filing cabinet

Reliquary was gluing whole files into a couple of labeled cards. That’s your job. The tool’s job is to **cut**.

- Default split is **fine hybrid**, dialogue **ripped out** of narration (including inline `"quotes"`)
- **Ideas** dumps (filename, bullets, “another thought…”) explode into separate cards
- Blank-line paragraphs stay separate instead of packing into one scene
- Short dialogue is no longer thrown away as junk
- **Sources → Re-split all sources…** recuts everything already imported
- Optional AI prompt is “split into fragments,” never “classify this document”
- Settings presets: **Ollama (local)** vs **xAI Grok API** (drafts leave the machine; no training by default, ~30-day logs, team ZDR)

Hard-refresh (Cmd+Shift+R) after pull. Then **Sources → Re-split** on files you already imported.

## 1.3.3 — 2026-08-24

### Messy-folder import is more honest

- Import **HTML** and **text PDFs** (scans still fail — you’ll see why)
- Skip Word lock files (`~$…`), duplicates already in the vault, and junk “Page 3” cards
- After a folder import, the ribbon lists skipped PDFs / images / Pages instead of failing silently

## 1.3.2 — 2026-08-24

### Whole-folder import that actually walks the pile

- **Whole folder** is the primary import button (the usual case: all drafts in one place)
- Drop a **folder** on the box — nested `.docx` / `.md` / `.txt` / `.odt` are collected (not just loose files)
- Subfolders included (up to 8 levels); `.git` / `node_modules` skipped
- Source names keep relative paths (`Novel/2019/ch3.docx`) so you can tell copies apart
- Confirm before importing 200+ files

## 1.3.1 — 2026-08-14

### UX: quieter desk

- After the first import, nav says **Import** (not “Start here”)
- `/` focuses piece search; Esc closes the reading modal
- Empty sources list has an import button

## 1.3.0 — 2026-08-14

### Desk memory + empty-shelf UX

- Last view, search, label, and card density persist across refresh
- Empty shelves explain *why* they’re empty and offer **Import drafts** / **Clear filters**
- `?` opens a short shortcuts sheet (⌘K still opens the palette)
- Service worker cache **v6** so installed apps pick up the shell

## 1.2.2 — 2026-08-05

### Icon rework — more otter character

- App icons (192 / 512 / apple-touch) rebuilt from the LEGO otter vault with a friendlier otter, gold glow, and floating manuscript scraps
- Sidebar / boot mark uses the characterful PNG; SVG monogram redrawn with otter crest + vault + parchment
- Full hero still available as `public/reliquary-icon-hero.jpg` (museum LEGO art stays at `reliquary-otter-lego.jpg`)
- Service worker → **reliquary-shell-v3**

## 1.2.1 — 2026-07-29

### Fixes

- Collection → Storyboard migrate now finds pieces via `collectionIds` and name tags (not only `pieceIds`)
- Vault import preserves collection `pieceIds` / notes
- Service worker precache includes monogram, yield helper, and parse worker (`reliquary-shell-v2`)

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
