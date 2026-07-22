# Reliquary

**Local-first writing archaeology.**  
Excavate valuable ideas, fragments, characters, and passages from years of messy notes and drafts — then act on them before they rot.

> *Reliquary*: a container for sacred or precious remains. Your old drafts hold gold; this is the vault and the dig kit.

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Local-first](https://img.shields.io/badge/data-local--first-green)
![No build step](https://img.shields.io/badge/install-no%20build%20step-orange)

---

## Install in 60 seconds (no coding required)

You need:

1. A modern browser (Chrome, Edge, Firefox, or Safari)
2. [Python 3](https://www.python.org/downloads/) — already on most Macs; on Windows, check “Add Python to PATH” when installing

### Mac / Linux

```bash
git clone https://github.com/otterlyfrank/reliquary.git
cd reliquary
chmod +x start.sh
./start.sh
```

Your browser should open **http://127.0.0.1:8780**.  
If it doesn’t, open that URL yourself.

### Windows

1. Download this repo: **Code → Download ZIP**, unzip it  
   (or `git clone https://github.com/otterlyfrank/reliquary.git`)
2. Double-click **`start.bat`**
3. Open **http://127.0.0.1:8780** if the browser doesn’t open

### Manual (any OS)

```bash
cd reliquary
python3 -m http.server 8780
# Windows may need: python -m http.server 8780
```

Then open **http://127.0.0.1:8780**.

> **Why a tiny server?** Browsers block some features when you open `index.html` as a raw file. Serving locally keeps everything private on your machine — nothing is uploaded.

**Native .exe / .dmg installers** are planned (Tauri) once the release pipeline is set up. For now the start scripts are the easy path.

---

## What it does

| Area | What you get |
|------|----------------|
| **Ingestion** | `.txt`, `.md`, `.docx`, `.odt`, legacy `.doc` (best-effort) · multi-file · folder import |
| **Chunking** | Structural (headings, blanks, breaks) + heuristics · Conservative / Balanced / Atomic |
| **Optional AI chunk** | If you configure an LLM, import can refine boundaries (off by default) |
| **Labels** | Configurable multi-label taxonomy (defaults included) + free tags |
| **Cards** | Readable, star / pin / energy / develop / archive / export · large cards for long passages |
| **Develop queue** | Send fragments to a “Develop further” shelf |
| **Multi-select + AI** | Structural suggestions (story / essay / poem / chapter) via optional LLM |
| **Export** | Per-piece or whole view as Markdown |
| **Local-first** | IndexedDB only · no account · no cloud required |

---

## Philosophy

Writers accumulate hundreds of pages of incomplete documents — gold mixed with noise. Reliquary:

1. **Ingests** old files  
2. **Chunks** them into discrete, readable pieces  
3. **Classifies** lightly (your labels, your tags)  
4. Puts everything on **beautiful cards** so you actually open the tool again  

No mandatory cloud. No collaboration theater. Respect for past work.

---

## Optional AI

In **Settings**:

| Field | Example |
|-------|---------|
| Base URL | `http://localhost:11434/v1` (Ollama) or your Grok/OpenAI-compatible endpoint |
| Model | `llama3.2` or provider model id |
| API key | if required |

Uses: multi-select → **AI structure…**, and optional AI-assisted chunking on import.

---

## Project layout

```text
reliquary/
  index.html
  LICENSE
  README.md
  CONTRIBUTING.md
  start.sh · start.bat
  samples/messy-draft.md
  src/
    main.js · app.js · styles.css
    storage/db.js
    ingest/parse.js
    chunk/engine.js
    ai/client.js
    lib/export.js
```

**Pipeline:** ingestion → chunking → classification → interface.

---

## Support Reliquary

Reliquary is free and open source (MIT). If it helps you recover work that would otherwise stay buried, please consider supporting development:

- **[GitHub Sponsors](https://github.com/sponsors)** — set your sponsor URL in Settings  
- **[Ko-fi](https://ko-fi.com)** — set your Ko-fi URL in Settings  

Links appear in the app under **Support Reliquary**.

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
