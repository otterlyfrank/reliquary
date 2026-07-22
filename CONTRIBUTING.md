# Contributing to Reliquary

Thank you for helping writers excavate their own past work.

## Ground rules

1. **Local-first** — never require a cloud account for core features.  
2. **Respect the source** — chunking and AI must not invent the writer’s text.  
3. **Beauty is a feature** — UI changes should stay calm, readable, and inviting.  
4. **Keep it light** — prefer vanilla JS and small modules; avoid heavy frameworks unless the gain is clear.

## Dev setup

```bash
cd reliquary
python3 -m http.server 8780   # or: python -m http.server 8780 on Windows
```

Open http://127.0.0.1:8780

## Architecture

| Layer | Path |
|-------|------|
| Ingestion | `src/ingest/parse.js` |
| Chunking | `src/chunk/engine.js` |
| Storage | `src/storage/db.js` |
| AI (optional) | `src/ai/client.js` |
| UI | `src/app.js`, `src/styles.css` |

## Pull requests

- Small, focused PRs  
- Describe the writer-facing benefit  
- Test with a multi-page `.md` or `.docx` draft  

## Code of conduct

Be kind. Critique ideas and code, not people.
