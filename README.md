# Reliquary

**Local-first writing archaeology.**  
Excavate valuable ideas, fragments, characters, and passages from years of messy notes and drafts — then act on them before they rot.

> *Reliquary*: a container for sacred or precious remains. Your old drafts hold gold; this is the vault and the dig kit.

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Local-first](https://img.shields.io/badge/data-local--first-green)
![No build step](https://img.shields.io/badge/install-no%20build%20step-orange)

---

## For writers who hate tech

You are not installing “an app stack.” You open a vault on **your** computer.  
**Plain English guide:** [START-HERE.md](./START-HERE.md)

| You | What to do |
|-----|------------|
| Prefer double-click | Windows: `start.bat` · Mac: Terminal + `./start.sh` |
| Prefer browser only | Yes — after the start script, everything is a normal web page |
| Want it in Applications / taskbar | **Install as app** (PWA) — see below. No native binary required |

Nothing is uploaded. Optional AI is off until you flip it on.

**Release notes:** [CHANGELOG.md](./CHANGELOG.md)

---

## Install as an app (recommended)

Reliquary is a **Progressive Web App**. After it’s open in the browser:

1. **Chrome / Edge** — install icon in the address bar, or menu → **Install Reliquary…** / **Install page as app**  
2. **Safari (Mac)** — **File → Add to Dock…**  
3. **iPhone / iPad** — Share → **Add to Home Screen**

That puts Reliquary in Applications / Start menu and lets you **pin it to the Dock or taskbar**, in a chrome-less window.

In-app: sidebar **Install app** (when offered) or **Settings → Install Reliquary**.

> **Public host (later):** serve this folder on HTTPS. Visitors can try the vault in the browser, then install the same way.

---

## First open (local, 60 seconds)

You need:

1. A modern browser (Chrome, Edge, Firefox, or Safari)
2. [Python 3](https://www.python.org/downloads/) — already on most Macs; on Windows, check **“Add Python to PATH”** when installing

### Mac / Linux

```bash
git clone https://github.com/otterlyfrank/reliquary.git
cd reliquary
chmod +x start.sh
./start.sh
```

Your browser should open **http://127.0.0.1:8780**.  
If it doesn’t, open that URL yourself. Then use **Install as an app** above.

### Windows

1. Download this repo: **Code → Download ZIP**, unzip it  
   (or `git clone https://github.com/otterlyfrank/reliquary.git`)
2. Double-click **`start.bat`**
3. Open **http://127.0.0.1:8780** if the browser doesn’t open

### Manual (any OS)

```bash
cd reliquary
python3 serve.py
```

Then open **http://127.0.0.1:8780**.

> **Why a tiny server?** Browsers block some features when you open `index.html` as a raw file. Serving locally keeps everything private on your machine — nothing is uploaded.

### Optional: native desktop shell (Tauri)

A **Tauri** wrapper lives in `src-tauri/` for people who want a classic `.dmg` / `.exe`. **You do not need this for normal use** — the PWA path is preferred.

| Path | How |
|------|-----|
| **Browser + PWA (recommended)** | `./start.sh` / `start.bat` → Install as app |
| **Local Tauri build** | [Rust](https://rustup.rs) + `npm install` then `npm run desktop:build` |
| **CI installers** | Tag `v1.0.1` or **Actions → Desktop installers** |

---

## What it does

| Area | What you get |
|------|----------------|
| **Ingestion** | `.txt`, `.md`, `.docx`, `.odt`, legacy `.doc` (best-effort) · **whole folder** (nested) · drop a folder · large text off main thread |
| **Chunking** | **Fragments, not whole files** — fine hybrid default, dialogue ripped out, idea-dumps exploded · optional AI refine |
| **Optional AI chunk** | If you configure an LLM, import/re-split can refine *boundaries* (off by default). Never required. |
| **Labels** | Configurable multi-label taxonomy (defaults included) + free tags |
| **Cards** | Star / pin / energy / develop / archive · compact density · multi-select · shelves + pagination |
| **Develop queue** | Send fragments to a “Work on later” shelf |
| **Storyboards** | Brainstorm / outline / draft · drag or Alt+↑↓ reorder · headings & notes · export Markdown |
| **Vault backup** | Settings → full local export/import (API keys redacted by default) |
| **Keyboard** | **⌘K** command palette · mobile bottom nav + drawer |
| **Export** | Per-piece, views, storyboards, or full vault JSON |
| **Local-first** | IndexedDB only · no account · no cloud required · system fonts first |

---

## Philosophy

Writers accumulate hundreds of pages of incomplete documents — gold mixed with noise. Reliquary:

1. **Ingests** old files  
2. **Chunks** them into discrete fragments you can reorder (dialogue, ideas, scraps)  
3. **Labels** only when the signal is obvious — you file the rest  
4. Puts everything on **cards** so you actually open the tool again  

No mandatory cloud. No collaboration theater. Respect for past work.

---

## Optional AI

Offline split is the product. LLM assist is optional, for messy cuts only.

In **Settings → Optional AI**, pick a provider:

| Provider | Drafts leave the machine? | Setup |
|----------|---------------------------|--------|
| **Off** | No | Default |
| **Ollama** | No | [ollama.com](https://ollama.com) + `ollama pull llama3.1` (8B+; not llama3.2 3B) |
| **xAI Grok** | Yes | Settings has numbered steps: key from [console.x.ai](https://console.x.ai), copy `.env.example` → `.env`, restart, Test. Or paste the key in Settings. Privacy box required. |
| **Custom** | Depends | OpenAI-compatible URL from the browser (not proxied) |

**xAI privacy (API, not grok.com):** they do not train on API inputs/outputs unless you opt in. Default ~30-day encrypted logs for abuse audit. [Zero Data Retention](https://docs.x.ai/developers/faq/security) is a team Console toggle — it stops disk retention; the text still goes to xAI.

`./start.sh` runs a localhost proxy so the xAI key can stay in `.env` instead of IndexedDB. Never commit `.env`.

Uses: optional AI-assisted fragmenting on import / re-split, and multi-select → **AI structure…**.

---

## Project layout

```text
reliquary/
  index.html
  LICENSE
  README.md
  CONTRIBUTING.md
  start.sh · start.bat · serve.py · .env.example
  samples/messy-draft.md
  src/
    main.js · app.js · styles.css
    storage/db.js
    ingest/parse.js
    chunk/engine.js
    ai/client.js
    lib/export.js
```

**Pipeline:** ingestion → fragmenting → optional labels → interface.

---

## Support Reliquary

Reliquary is free and open source (MIT). If it helps you recover work that would otherwise stay buried, please consider supporting development:

- **[Ko-fi — otterlyfrank](https://ko-fi.com/otterlyfrank)** — coffee money keeps the dig going  

The app defaults to this Ko-fi link (empty GitHub Sponsors is hidden). You can override URLs in Settings if needed.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Ideas especially welcome around:

- Better semantic chunking  
- Import fidelity (Office formats)  
- Accessibility and typography  
- Export packs for specific workflows  
- Tauri / native installers  

---

## Non-goals (v1)

Real-time collaboration · cloud sync · heavy publishing · mobile-native apps.

---

## License

[MIT](./LICENSE) © Reliquary contributors
