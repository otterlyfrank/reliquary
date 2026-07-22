/**
 * Reliquary — presentation layer
 */

import {
  getSettings,
  setSettings,
  listPieces,
  putPiece,
  updatePiece,
  deletePiece,
  putPiecesBulk,
  putDocument,
  listDocuments,
  deleteDocument,
  listCollections,
  putCollection,
  deleteCollection,
  listStoryboards,
  getStoryboard,
  putStoryboard,
  deleteStoryboard,
  addPiecesToStoryboard,
  makeHeadingItem,
  makeNoteItem,
  STORYBOARD_MODES,
  DEFAULT_LABELS,
} from './storage/db.js';
import {
  parseFile,
  isSupportedFile,
  SUPPORTED_EXTENSIONS,
  formatHelpLine,
} from './ingest/parse.js';
import { chunkDocument, buildAiChunkPrompt } from './chunk/engine.js';
import { chatCompletion, checkLlm, developPrompt, parseJsonArray } from './ai/client.js';
import {
  downloadText,
  pieceToMarkdown,
  collectionToMarkdown,
  storyboardToMarkdown,
  formatDate,
} from './lib/export.js';

/** @type {any} */
let state = {
  view: 'excavate',
  settings: null,
  pieces: [],
  documents: [],
  collections: [],
  storyboards: [],
  /** @type {string | null} */
  activeStoryboardId: null,
  filter: 'active',
  label: '',
  q: '',
  selected: new Set(),
  busy: false,
};

let rootEl = null;

export async function mountApp(root) {
  rootEl = root;
  try {
    state.settings = await getSettings();
    applyTheme(state.settings.theme);
    await reload();
    render();
  } catch (err) {
    console.error('[Reliquary] mount failed', err);
    throw err;
  }
}

async function reload() {
  const filter = {};
  if (state.filter === 'starred') filter.starred = true;
  else if (state.filter === 'develop') filter.develop = true;
  else if (state.filter === 'archive') filter.status = 'archive';
  else if (state.filter === 'active') filter.status = 'active';
  if (state.label) filter.label = state.label;
  if (state.q) filter.q = state.q;
  // starred may also be active
  if (state.filter === 'starred') {
    state.pieces = (await listPieces({ q: state.q, label: state.label })).filter((p) => p.starred);
  } else if (state.filter === 'all') {
    state.pieces = await listPieces({ q: state.q, label: state.label });
  } else {
    state.pieces = await listPieces(filter);
  }
  state.documents = await listDocuments();
  state.collections = await listCollections();
  state.storyboards = await listStoryboards();
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

function $(sel, r = document) {
  return r.querySelector(sel);
}

function toast(msg, kind = '') {
  let host = $('#toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Render ─────────────────────────────────────────────────

function render() {
  if (!rootEl) return;
  const counts = {
    active: 0,
    develop: 0,
    starred: 0,
    archive: 0,
  };
  // badges from full set — async free: approximate from current load on next reload
  rootEl.innerHTML = `
    <aside class="sidebar" id="sidebar">
      <div class="brand">
        <img class="brand-mark" src="./public/reliquary-otter-lego.jpg" alt="" width="56" height="56" />
        <div>
          <h1>Reliquary</h1>
          <p>Your draft vault</p>
        </div>
      </div>
      <button type="button" class="nav-btn ${state.view === 'excavate' ? 'active' : ''}" data-nav="excavate">Start here</button>
      <button type="button" class="nav-btn ${state.view === 'pieces' && state.filter === 'active' ? 'active' : ''}" data-nav="pieces" data-filter="active">My pieces</button>
      <button type="button" class="nav-btn ${state.view === 'storyboards' ? 'active' : ''}" data-nav="storyboards">Storyboards</button>
      <button type="button" class="nav-btn ${state.filter === 'starred' ? 'active' : ''}" data-nav="pieces" data-filter="starred">Starred</button>
      <button type="button" class="nav-btn ${state.filter === 'develop' ? 'active' : ''}" data-nav="pieces" data-filter="develop">Work on later</button>
      <button type="button" class="nav-btn ${state.filter === 'archive' ? 'active' : ''}" data-nav="pieces" data-filter="archive">Archive</button>
      <button type="button" class="nav-btn ${state.view === 'collections' ? 'active' : ''}" data-nav="collections">Collections</button>
      <button type="button" class="nav-btn ${state.view === 'sources' ? 'active' : ''}" data-nav="sources">Imported files</button>
      <button type="button" class="nav-btn ${state.view === 'settings' ? 'active' : ''}" data-nav="settings">Settings</button>
      <div class="sidebar-foot">
        <p>Stays on your computer · free</p>
        <p><a href="#support" data-nav="settings">Support Reliquary</a></p>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <h2 id="view-title">${esc(viewTitle())}</h2>
        <div class="topbar-actions" id="top-actions"></div>
      </header>
      <div class="content" id="view-root"></div>
    </div>
  `;

  bindNav();
  const viewRoot = $('#view-root');
  const actions = $('#top-actions');
  if (state.view === 'excavate') renderExcavate(viewRoot, actions);
  else if (state.view === 'pieces') renderPieces(viewRoot, actions);
  else if (state.view === 'storyboards') renderStoryboards(viewRoot, actions);
  else if (state.view === 'collections') renderCollections(viewRoot, actions);
  else if (state.view === 'sources') renderSources(viewRoot, actions);
  else renderSettings(viewRoot, actions);
}

function viewTitle() {
  if (state.view === 'excavate') return 'Start here';
  if (state.view === 'storyboards') {
    if (state.activeStoryboardId) {
      const b = state.storyboards.find((s) => s.id === state.activeStoryboardId);
      return b ? b.name : 'Storyboard';
    }
    return 'Storyboards';
  }
  if (state.view === 'collections') return 'Collections';
  if (state.view === 'sources') return 'Imported files';
  if (state.view === 'settings') return 'Settings';
  if (state.filter === 'starred') return 'Starred';
  if (state.filter === 'develop') return 'Work on later';
  if (state.filter === 'archive') return 'Archive';
  return 'My pieces';
}

function bindNav() {
  rootEl.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.view = btn.dataset.nav;
      if (btn.dataset.filter) state.filter = btn.dataset.filter;
      if (state.view === 'pieces' && !btn.dataset.filter) state.filter = 'active';
      if (state.view === 'storyboards' && !btn.dataset.keepBoard) state.activeStoryboardId = null;
      state.selected = new Set();
      await reload();
      render();
    });
  });
}

// ── Excavate (import) ──────────────────────────────────────

function renderExcavate(root, actions) {
  const isFirstRun = !state.documents.length;
  actions.innerHTML = `
    ${isFirstRun ? `<button type="button" class="btn" id="btn-sample">Try a sample</button>` : ''}
    <button type="button" class="btn" id="btn-folder">Whole folder</button>
    <button type="button" class="btn primary" id="btn-files">Choose files</button>
  `;
  root.innerHTML = `
    ${
      isFirstRun
        ? `<div class="welcome-hero">
            <img class="welcome-art" src="./public/reliquary-otter-lego.jpg" alt="LEGO medieval reliquary with otter crest" />
            <div>
              <h3>Welcome — this is your vault for unfinished writing</h3>
              <p class="muted">Everything stays on <strong>your</strong> computer. Nothing is uploaded. Dusty Word docs, half-novels, Notes exports: this is for that pile.</p>
              <ol class="how-to">
                <li><strong>Bring files in</strong> — choose, drag, or try the sample</li>
                <li>We split them into small <strong>pieces</strong> you can actually read</li>
                <li>Star the gold · stack keepers on a <strong>Storyboard</strong></li>
              </ol>
              <p class="dim" style="margin:0.75rem 0 0">Nervous? Hit <strong>Try a sample</strong> first — no real drafts required.</p>
            </div>
          </div>`
        : ''
    }
    <div class="drop-zone" id="drop">
      <h3>${isFirstRun ? 'Drop old drafts here' : 'Bring more drafts in'}</h3>
      <p class="muted">Drag files onto this box, or use the buttons. One file or a whole mess of folders is fine.</p>
      <p class="dim" style="margin-top:0.75rem">${esc(formatHelpLine())}</p>
      <div style="margin-top:1rem; display:flex; gap:0.5rem; justify-content:center; flex-wrap:wrap">
        <button type="button" class="btn primary" id="btn-files-2">Choose files</button>
        <button type="button" class="btn" id="btn-folder-2">Whole folder</button>
        ${isFirstRun ? `<button type="button" class="btn" id="btn-sample-2">Try a sample</button>` : ''}
      </div>
    </div>
    <div class="import-tips">
      <h4>Quick tips</h4>
      <ul>
        <li><strong>Word:</strong> .docx is best. Old .doc works roughly — “Save As → .docx” if text looks weird.</li>
        <li><strong>Not yet:</strong> PDF scans (images of pages). Export text from Word/Google Docs first.</li>
        <li><strong>After import:</strong> you’ll land in <strong>My pieces</strong>. Nothing leaves your machine.</li>
      </ul>
    </div>
    <div class="stats">
      <span>${state.documents.length} files imported</span>
      <span id="piece-count">… pieces</span>
      <span>Split size: <strong>${esc(state.settings.chunkMode)}</strong> <span class="dim">(Settings)</span></span>
    </div>
    <div id="import-progress" class="import-progress" hidden></div>
    <p class="muted">Next: open <strong>My pieces</strong> → star keepers → <strong>Storyboards</strong> to outline or draft. Your words stay local.</p>
    ${supportBlock()}
  `;
  listPieces({}).then((all) => {
    const el = $('#piece-count');
    if (el) el.textContent = `${all.length} pieces`;
  });

  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = [
      ...SUPPORTED_EXTENSIONS,
      'text/plain',
      'text/markdown',
      'text/rtf',
      'application/rtf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.oasis.opendocument.text',
    ].join(',');
    input.onchange = () => ingestFiles([...input.files]);
    input.click();
  };
  const loadSample = () => ingestSampleDraft();
  $('#btn-files').onclick = pick;
  $('#btn-files-2').onclick = pick;
  $('#btn-folder').onclick = importFolder;
  $('#btn-folder-2')?.addEventListener('click', importFolder);
  $('#btn-sample')?.addEventListener('click', loadSample);
  $('#btn-sample-2')?.addEventListener('click', loadSample);

  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    const all = [...e.dataTransfer.files];
    const files = all.filter(isSupportedFile);
    const skipped = all.length - files.length;
    if (skipped > 0 && !files.length) {
      toast(`None of those ${all.length} file(s) are supported yet. Use Word, text, or Markdown.`, 'err');
      return;
    }
    if (skipped > 0) toast(`Skipping ${skipped} unsupported file(s)`, '');
    ingestFiles(files);
  });
}

async function ingestSampleDraft() {
  try {
    const res = await fetch('./samples/messy-draft.md');
    if (!res.ok) throw new Error('Sample file missing');
    const text = await res.text();
    const file = new File([text], 'sample-messy-draft.md', { type: 'text/markdown' });
    await ingestFiles([file]);
  } catch (err) {
    toast(err.message || 'Could not load sample', 'err');
  }
}

async function importFolder() {
  try {
    if (window.showDirectoryPicker) {
      const dir = await window.showDirectoryPicker();
      const files = [];
      for await (const entry of walkDir(dir, 0, 3)) {
        if (entry.kind === 'file') {
          const f = await entry.getFile();
          if (isSupportedFile(f)) files.push(f);
        }
      }
      if (!files.length) {
        toast('No supported drafts in that folder', 'err');
        return;
      }
      await ingestFiles(files);
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.warn(err);
  }
  // Fallback: webkitdirectory
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.webkitdirectory = true;
  input.onchange = () => {
    const files = [...input.files].filter(isSupportedFile);
    if (!files.length) {
      toast('No supported drafts in that folder', 'err');
      return;
    }
    ingestFiles(files);
  };
  input.click();
}

/** Walk folder tree up to maxDepth (0 = this folder only). */
async function* walkDir(dirHandle, depth = 0, maxDepth = 3) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') yield entry;
    else if (entry.kind === 'directory' && depth < maxDepth) {
      try {
        yield* walkDir(entry, depth + 1, maxDepth);
      } catch {
        /* ignore locked subfolders */
      }
    }
  }
}

function setImportProgress(msg, pct) {
  const el = $('#import-progress');
  if (!el) return;
  el.hidden = !msg;
  if (!msg) {
    el.innerHTML = '';
    return;
  }
  const width = Math.max(0, Math.min(100, pct ?? 0));
  el.innerHTML = `
    <div class="import-progress-bar"><div style="width:${width}%"></div></div>
    <p class="dim">${esc(msg)}</p>`;
}

async function ingestFiles(files) {
  if (!files?.length) {
    toast('No supported files found', 'err');
    return;
  }
  if (state.busy) {
    toast('Already importing…', 'err');
    return;
  }
  state.busy = true;
  let totalPieces = 0;
  let okFiles = 0;
  const problems = [];
  const warnings = [];
  toast(`Importing ${files.length} file(s)…`);
  setImportProgress(`Starting… 0 / ${files.length}`, 0);
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setImportProgress(`Reading “${file.name}”… (${i + 1} / ${files.length})`, ((i + 0.3) / files.length) * 100);
      try {
        const parsed = await parseFile(file);
        if (parsed.warnings?.length) warnings.push(...parsed.warnings.map((w) => `${file.name}: ${w}`));
        if (!parsed.text || parsed.text.trim().length < 12) {
          problems.push(`${file.name}: almost no text found`);
          continue;
        }
        setImportProgress(`Splitting “${file.name}”…`, ((i + 0.6) / files.length) * 100);
        const doc = await putDocument({
          name: parsed.name,
          kind: parsed.kind,
          text: parsed.text,
        });
        let chunks = chunkDocument(parsed.text, {
          mode: state.settings.chunkMode || 'balanced',
          sourceName: parsed.name,
        });

        if (state.settings.useAiChunk && state.settings.llmBaseUrl && parsed.text.length < 12000) {
          try {
            const { content } = await chatCompletion({
              baseUrl: state.settings.llmBaseUrl,
              apiKey: state.settings.llmApiKey,
              model: state.settings.llmModel,
              messages: [
                {
                  role: 'system',
                  content: 'You split writing into reusable fragments. JSON array only.',
                },
                { role: 'user', content: buildAiChunkPrompt(parsed.text, state.settings.chunkMode) },
              ],
            });
            const arr = parseJsonArray(content);
            if (arr.length) {
              chunks = arr
                .map((c) => ({
                  text: String(c.text || '').trim(),
                  labels: Array.isArray(c.labels) ? c.labels.map(String) : [],
                  isLarge: !!c.isLarge,
                  tags: [`src:${parsed.name.slice(0, 40)}`],
                  preview: String(c.text || '').slice(0, 320),
                }))
                .filter((c) => c.text.length >= 12);
            }
          } catch (e) {
            console.warn('AI chunk failed, using structural', e);
          }
        }

        if (!chunks.length) {
          // Keep at least one piece so short notes still land
          chunks = [
            {
              text: parsed.text.trim(),
              preview: parsed.text.slice(0, 320),
              labels: [],
              tags: [`src:${parsed.name.slice(0, 40)}`],
              isLarge: parsed.text.length >= 1200,
            },
          ];
        }

        const records = chunks.map((c) => ({
          documentId: doc.id,
          sourceName: parsed.name,
          text: c.text,
          preview: c.preview,
          labels: c.labels || [],
          tags: c.tags || [],
          isLarge: c.isLarge,
          status: 'active',
        }));
        await putPiecesBulk(records);
        await putDocument({ ...doc, pieceCount: records.length, text: parsed.text });
        totalPieces += records.length;
        okFiles += 1;
      } catch (err) {
        console.error(file.name, err);
        problems.push(err.message || `${file.name}: failed`);
      }
      setImportProgress(`Done “${file.name}”`, ((i + 1) / files.length) * 100);
    }

    if (warnings.length) {
      console.info('[Reliquary] import warnings', warnings);
    }

    if (okFiles === 0) {
      toast(problems[0] || 'Nothing imported', 'err');
      setImportProgress(
        problems.length
          ? `Couldn’t import. ${problems.slice(0, 2).join(' · ')}`
          : 'Nothing imported',
        100
      );
      return;
    }

    toast(
      `Imported ${okFiles} file(s) → ${totalPieces} piece(s)${problems.length ? ` · ${problems.length} skipped` : ''}`,
      'ok'
    );
    state.view = 'pieces';
    state.filter = 'active';
    await reload();
    render();
    // brief success note on pieces view
    if (problems.length) {
      setTimeout(() => toast(`Skipped ${problems.length}: ${problems[0]}`, 'err'), 600);
    }
  } finally {
    state.busy = false;
  }
}

// ── Pieces ─────────────────────────────────────────────────

function renderPieces(root, actions) {
  const labels = state.settings.labels || DEFAULT_LABELS;
  actions.innerHTML = `
    <button type="button" class="btn" id="btn-export-view" ${!state.pieces.length ? 'disabled' : ''}>Export view</button>
    <button type="button" class="btn primary" id="btn-import-more">Import more</button>
  `;
  $('#btn-import-more').onclick = () => {
    state.view = 'excavate';
    render();
  };
  $('#btn-export-view').onclick = () => {
    const md = collectionToMarkdown(viewTitle(), state.pieces);
    downloadText(`reliquary-${state.filter || 'pieces'}`, md, 'text/markdown');
    toast('Exported Markdown', 'ok');
  };

  root.innerHTML = `
    <div class="filter-row">
      <input class="search" id="q" placeholder="Search pieces…" value="${esc(state.q)}" />
      <button type="button" class="chip ${!state.label ? 'active' : ''}" data-label="">All labels</button>
      ${labels
        .slice(0, 12)
        .map(
          (l) =>
            `<button type="button" class="chip ${state.label === l ? 'active' : ''}" data-label="${esc(l)}">${esc(l)}</button>`
        )
        .join('')}
    </div>
    <div class="stats">
      <span>${state.pieces.length} shown</span>
      <span>${state.selected.size} selected</span>
    </div>
    ${
      state.pieces.length
        ? `<div class="card-grid" id="grid">
            ${state.pieces.map((p) => renderCard(p)).join('')}
          </div>`
        : `<div class="empty">
            <img class="empty-art" src="./public/reliquary-otter-lego.jpg" alt="" />
            <h3>Nothing here yet</h3>
            <p>Go to <strong>Start here</strong> and open an old draft. We’ll break it into readable pieces.</p>
          </div>`
    }
    ${
      state.selected.size
        ? `<div class="multi-bar">
            <span>${state.selected.size} selected</span>
            <button type="button" class="btn primary" id="ms-board">＋ Storyboard</button>
            <button type="button" class="btn" id="ms-star">Star</button>
            <button type="button" class="btn" id="ms-develop">Work on later</button>
            <button type="button" class="btn" id="ms-archive">Archive</button>
            <button type="button" class="btn" id="ms-ai">AI structure…</button>
            <button type="button" class="btn ghost" id="ms-clear">Clear selection</button>
          </div>`
        : ''
    }
  `;

  $('#q').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      state.q = e.target.value.trim();
      await reload();
      render();
    }
  });
  root.querySelectorAll('[data-label]').forEach((btn) => {
    btn.onclick = async () => {
      state.label = btn.dataset.label || '';
      await reload();
      render();
    };
  });

  root.querySelectorAll('.piece-card').forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('[data-select]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      render();
    });
    card.querySelector('[data-star]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = state.pieces.find((x) => x.id === id);
      await updatePiece(id, { starred: !p.starred });
      await reload();
      render();
    });
    card.querySelector('[data-pin]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = state.pieces.find((x) => x.id === id);
      await updatePiece(id, { pinned: !p.pinned });
      await reload();
      render();
    });
    card.querySelector('[data-develop]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await updatePiece(id, { status: 'develop' });
      toast('Sent to Develop further', 'ok');
      await reload();
      render();
    });
    card.querySelector('[data-archive]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await updatePiece(id, { status: 'archive' });
      await reload();
      render();
    });
    card.querySelector('[data-open]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openReading(id);
    });
    card.querySelector('[data-export]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = state.pieces.find((x) => x.id === id);
      downloadText(`reliquary-piece`, pieceToMarkdown(p), 'text/markdown');
    });
    card.querySelector('[data-board]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = state.pieces.find((x) => x.id === id);
      if (p) openAddToStoryboard([p]);
    });
    card.querySelector('[data-del]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this piece permanently?')) return;
      await deletePiece(id);
      state.selected.delete(id);
      await reload();
      render();
    });
    card.querySelector('[data-energy]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = state.pieces.find((x) => x.id === id);
      const next = ((p.energy || 0) + 1) % 4;
      await updatePiece(id, { energy: next });
      await reload();
      render();
    });
  });

  $('#ms-clear')?.addEventListener('click', () => {
    state.selected = new Set();
    render();
  });
  $('#ms-star')?.addEventListener('click', async () => {
    for (const id of state.selected) await updatePiece(id, { starred: true });
    toast('Starred', 'ok');
    await reload();
    render();
  });
  $('#ms-develop')?.addEventListener('click', async () => {
    for (const id of state.selected) await updatePiece(id, { status: 'develop' });
    toast('Queued for development', 'ok');
    state.selected = new Set();
    await reload();
    render();
  });
  $('#ms-archive')?.addEventListener('click', async () => {
    for (const id of state.selected) await updatePiece(id, { status: 'archive' });
    state.selected = new Set();
    await reload();
    render();
  });
  $('#ms-ai')?.addEventListener('click', () => openAiDevelop([...state.selected]));
  $('#ms-board')?.addEventListener('click', () => {
    const pieces = state.pieces.filter((p) => state.selected.has(p.id));
    openAddToStoryboard(pieces);
  });
}

function renderCard(p) {
  const selected = state.selected.has(p.id);
  const energy = '★'.repeat(p.energy || 0) + '☆'.repeat(3 - (p.energy || 0));
  return `
    <article class="piece-card ${p.isLarge ? 'large' : ''} ${selected ? 'selected' : ''}" data-id="${p.id}">
      <label class="select-box"><input type="checkbox" data-select ${selected ? 'checked' : ''} /></label>
      <div class="card-source">${esc(p.sourceName || '—')} · ${formatDate(p.updatedAt)}</div>
      <p class="piece-text">${esc(p.text)}</p>
      <div class="piece-meta">
        ${(p.labels || []).map((l) => `<span class="label-pill">${esc(l)}</span>`).join('')}
        ${(p.tags || []).map((t) => `<span class="tag-pill">#${esc(t)}</span>`).join('')}
      </div>
      <div class="piece-actions">
        <button type="button" class="icon-btn ${p.starred ? 'on' : ''}" data-star title="Star">★</button>
        <button type="button" class="icon-btn ${p.pinned ? 'on' : ''}" data-pin title="Pin">📌</button>
        <button type="button" class="icon-btn" data-energy title="Energy">${energy}</button>
        <button type="button" class="icon-btn" data-open title="Read">Read</button>
        <button type="button" class="icon-btn" data-board title="Add to storyboard">Board</button>
        <button type="button" class="icon-btn" data-develop title="Work on later">✎</button>
        <button type="button" class="icon-btn" data-archive title="Archive">Archive</button>
        <button type="button" class="icon-btn" data-export title="Export">↓</button>
        <button type="button" class="icon-btn danger" data-del title="Delete">✕</button>
      </div>
    </article>
  `;
}

async function openReading(id) {
  const p = await listPieces({}).then((all) => all.find((x) => x.id === id));
  if (!p) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal wide" role="dialog">
      <h2>${esc((p.labels || [])[0] || 'Fragment')}</h2>
      <p class="dim">${esc(p.sourceName || '')} · ${formatDate(p.updatedAt)}</p>
      <div class="reading-body">${esc(p.text)}</div>
      <div class="field" style="margin-top:1rem">
        <label>Labels (comma-separated)</label>
        <input id="edit-labels" value="${esc((p.labels || []).join(', '))}" />
      </div>
      <div class="field">
        <label>Tags</label>
        <input id="edit-tags" value="${esc((p.tags || []).join(', '))}" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="r-close">Close</button>
        <button type="button" class="btn" id="r-board">＋ Storyboard</button>
        <button type="button" class="btn" id="r-export">Export MD</button>
        <button type="button" class="btn primary" id="r-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  $('#r-close', backdrop).onclick = close;
  $('#r-board', backdrop).onclick = () => {
    close();
    openAddToStoryboard([p]);
  };
  $('#r-export', backdrop).onclick = () => {
    downloadText('reliquary-piece', pieceToMarkdown(p), 'text/markdown');
  };
  $('#r-save', backdrop).onclick = async () => {
    const labels = $('#edit-labels', backdrop)
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const tags = $('#edit-tags', backdrop)
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    await updatePiece(id, { labels, tags });
    toast('Saved', 'ok');
    close();
    await reload();
    render();
  };
}

async function openAiDevelop(ids) {
  if (!state.settings.llmBaseUrl) {
    toast('Add an LLM URL in Settings (optional AI)', 'err');
    state.view = 'settings';
    render();
    return;
  }
  const pieces = [];
  for (const id of ids) {
    const all = state.pieces.find((p) => p.id === id);
    if (all) pieces.push(all);
  }
  if (!pieces.length) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal wide">
      <h2>Development assistance</h2>
      <p class="muted">${pieces.length} piece(s) · preserves your wording; suggests structure only</p>
      <div class="field">
        <label>Intent</label>
        <select id="ai-intent">
          <option value="short story outline">Short story outline</option>
          <option value="essay structure">Essay structure</option>
          <option value="poem development">Poem development</option>
          <option value="chapter expansion">Chapter expansion</option>
          <option value="structure">General structure</option>
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="ai-close">Close</button>
        <button type="button" class="btn primary" id="ai-run">Generate suggestions</button>
      </div>
      <div id="ai-result" class="ai-out" hidden></div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  $('#ai-close', backdrop).onclick = close;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  $('#ai-run', backdrop).onclick = async () => {
    const intent = $('#ai-intent', backdrop).value;
    const out = $('#ai-result', backdrop);
    out.hidden = false;
    out.textContent = 'Thinking…';
    try {
      const { content } = await chatCompletion({
        baseUrl: state.settings.llmBaseUrl,
        apiKey: state.settings.llmApiKey,
        model: state.settings.llmModel,
        messages: [
          {
            role: 'system',
            content:
              'You help writers develop excavated fragments. Preserve voice. Be concrete and brief.',
          },
          { role: 'user', content: developPrompt(pieces, intent) },
        ],
      });
      out.textContent = content;
    } catch (err) {
      out.textContent = err.message || String(err);
    }
  };
}

// ── Storyboards ────────────────────────────────────────────

function modeLabel(mode) {
  return STORYBOARD_MODES.find((m) => m.id === mode)?.label || mode || 'Brainstorm';
}

function openAddToStoryboard(pieces) {
  if (!pieces?.length) {
    toast('No pieces selected', 'err');
    return;
  }
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const boards = state.storyboards || [];
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-label="Add to storyboard">
      <h2>Add to storyboard</h2>
      <p class="muted">${pieces.length} fragment(s) — collect them into a working draft, outline, or brainstorm.</p>
      ${
        boards.length
          ? `<div class="board-pick-list">
              ${boards
                .map(
                  (b) => `
                <button type="button" class="board-pick" data-add-board="${b.id}">
                  <strong>${esc(b.name)}</strong>
                  <span class="dim">${esc(modeLabel(b.mode))} · ${(b.items || []).length} items</span>
                </button>`
                )
                .join('')}
            </div>`
          : `<p class="muted">No storyboards yet — create one below.</p>`
      }
      <div class="field" style="margin-top:1rem">
        <label>Or create new</label>
        <input id="new-board-name" placeholder="e.g. Novel outline, Essay skeleton, Chaos dump…" />
      </div>
      <div class="field">
        <label>Type</label>
        <select id="new-board-mode">
          ${STORYBOARD_MODES.map((m) => `<option value="${m.id}">${esc(m.label)} — ${esc(m.hint)}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="ab-cancel">Cancel</button>
        <button type="button" class="btn primary" id="ab-create">Create & add</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  $('#ab-cancel', backdrop).onclick = close;
  backdrop.querySelectorAll('[data-add-board]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await addPiecesToStoryboard(btn.dataset.addBoard, pieces);
        toast(`Added to storyboard`, 'ok');
        state.selected = new Set();
        close();
        await reload();
        render();
      } catch (err) {
        toast(err.message || String(err), 'err');
      }
    };
  });
  $('#ab-create', backdrop).onclick = async () => {
    const name = $('#new-board-name', backdrop).value.trim() || 'Untitled storyboard';
    const mode = $('#new-board-mode', backdrop).value;
    const board = await putStoryboard({ name, mode, items: [] });
    await addPiecesToStoryboard(board.id, pieces);
    toast(`Created “${name}” and added fragments`, 'ok');
    state.selected = new Set();
    close();
    await reload();
    state.view = 'storyboards';
    state.activeStoryboardId = board.id;
    render();
  };
}

async function renderStoryboards(root, actions) {
  if (state.activeStoryboardId) {
    await renderStoryboardEditor(root, actions, state.activeStoryboardId);
    return;
  }

  actions.innerHTML = `<button type="button" class="btn primary" id="btn-new-board">New storyboard</button>`;
  $('#btn-new-board').onclick = () => openNewStoryboardDialog();

  root.innerHTML = `
    <p class="muted intro-blurb">
      A <strong>storyboard</strong> is where chaos becomes a plan. Drop fragments you like into a brainstorm, order them into an outline, or grow a working draft — without losing the original pieces.
    </p>
    ${
      state.storyboards.length
        ? `<div class="card-grid">
            ${state.storyboards
              .map((b) => {
                const n = (b.items || []).length;
                const pieces = (b.items || []).filter((i) => i.kind === 'piece').length;
                return `
              <article class="piece-card board-card" data-open-board="${b.id}">
                <div class="card-source">${esc(modeLabel(b.mode))} · updated ${formatDate(b.updatedAt)}</div>
                <h3 class="board-title">${esc(b.name)}</h3>
                <p class="muted" style="margin:0">${n} item${n === 1 ? '' : 's'} · ${pieces} fragment${pieces === 1 ? '' : 's'}</p>
                ${b.notes ? `<p class="dim board-notes-preview">${esc(b.notes.slice(0, 120))}${b.notes.length > 120 ? '…' : ''}</p>` : ''}
                <div class="piece-actions">
                  <button type="button" class="btn primary" data-open-board="${b.id}">Open</button>
                  <button type="button" class="btn" data-export-board="${b.id}">Export MD</button>
                  <button type="button" class="btn danger" data-del-board="${b.id}">Delete</button>
                </div>
              </article>`;
              })
              .join('')}
          </div>`
        : `<div class="empty">
            <img class="empty-art" src="./public/reliquary-otter-lego.jpg" alt="" />
            <h3>No storyboards yet</h3>
            <p>When you find gold in <strong>My pieces</strong>, select fragments → <strong>＋ Storyboard</strong>, or create a board here.</p>
            <p style="margin-top:1rem"><button type="button" class="btn primary" id="btn-new-board-2">Create storyboard</button></p>
          </div>`
    }
  `;

  $('#btn-new-board-2')?.addEventListener('click', () => openNewStoryboardDialog());
  root.querySelectorAll('[data-open-board]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      state.activeStoryboardId = el.dataset.openBoard;
      render();
    };
  });
  root.querySelectorAll('[data-export-board]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const board = await getStoryboard(btn.dataset.exportBoard);
      if (!board) return;
      downloadText(`reliquary-${board.name}`, storyboardToMarkdown(board), 'text/markdown');
      toast('Exported storyboard', 'ok');
    };
  });
  root.querySelectorAll('[data-del-board]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this storyboard? Original pieces stay safe.')) return;
      await deleteStoryboard(btn.dataset.delBoard);
      await reload();
      render();
    };
  });
}

function openNewStoryboardDialog() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog">
      <h2>New storyboard</h2>
      <p class="muted">Organize fragments into a brainstorm, outline, or working draft.</p>
      <div class="field">
        <label>Name</label>
        <input id="nb-name" placeholder="e.g. Chapter 3 outline" autofocus />
      </div>
      <div class="field">
        <label>Type</label>
        <select id="nb-mode">
          ${STORYBOARD_MODES.map((m) => `<option value="${m.id}">${esc(m.label)} — ${esc(m.hint)}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="nb-cancel">Cancel</button>
        <button type="button" class="btn primary" id="nb-go">Create</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  $('#nb-cancel', backdrop).onclick = close;
  const create = async () => {
    const name = $('#nb-name', backdrop).value.trim() || 'Untitled storyboard';
    const mode = $('#nb-mode', backdrop).value;
    const board = await putStoryboard({ name, mode, items: [] });
    close();
    await reload();
    state.activeStoryboardId = board.id;
    state.view = 'storyboards';
    render();
  };
  $('#nb-go', backdrop).onclick = create;
  $('#nb-name', backdrop).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') create();
  });
}

async function renderStoryboardEditor(root, actions, boardId) {
  let board = await getStoryboard(boardId);
  if (!board) {
    state.activeStoryboardId = null;
    await reload();
    render();
    return;
  }

  actions.innerHTML = `
    <button type="button" class="btn" id="sb-back">← All storyboards</button>
    <button type="button" class="btn" id="sb-export">Export MD</button>
    <button type="button" class="btn primary" id="sb-save">Save</button>
  `;

  const items = board.items || [];
  root.innerHTML = `
    <div class="sb-header">
      <div class="field sb-name-field">
        <label>Title</label>
        <input id="sb-name" value="${esc(board.name)}" />
      </div>
      <div class="field">
        <label>Type</label>
        <select id="sb-mode">
          ${STORYBOARD_MODES.map(
            (m) =>
              `<option value="${m.id}" ${board.mode === m.id ? 'selected' : ''}>${esc(m.label)}</option>`
          ).join('')}
        </select>
      </div>
    </div>
    <div class="field">
      <label>Working notes (yours — not from fragments)</label>
      <textarea id="sb-notes" rows="3" placeholder="Thesis, questions, tone, what this board is trying to become…">${esc(board.notes || '')}</textarea>
    </div>
    <div class="sb-toolbar">
      <button type="button" class="btn" id="sb-add-heading">＋ Section heading</button>
      <button type="button" class="btn" id="sb-add-note">＋ Free note</button>
      <button type="button" class="btn" id="sb-add-pieces">＋ From My pieces</button>
      <span class="dim">${items.length} item${items.length === 1 ? '' : 's'}</span>
    </div>
    <div class="sb-lane" id="sb-lane">
      ${
        items.length
          ? items
              .map((item, idx) => renderStoryboardItem(item, idx, items.length))
              .join('')
          : `<div class="empty sb-empty">
              <h3>Empty board</h3>
              <p>Add fragments from <strong>My pieces</strong> (Board button or multi-select), or drop a section heading to start an outline.</p>
            </div>`
      }
    </div>
  `;

  const readForm = () => ({
    name: $('#sb-name').value.trim() || 'Untitled storyboard',
    mode: $('#sb-mode').value,
    notes: $('#sb-notes').value,
  });

  const persist = async (nextItems = items) => {
    const form = readForm();
    board = await putStoryboard({
      ...board,
      ...form,
      items: nextItems,
    });
    await reload();
    return board;
  };

  $('#sb-back').onclick = async () => {
    await persist(items);
    state.activeStoryboardId = null;
    await reload();
    render();
  };
  $('#sb-save').onclick = async () => {
    // re-read item texts from DOM
    const next = collectItemsFromDom(board.items || []);
    await persist(next);
    toast('Storyboard saved', 'ok');
    board = await getStoryboard(boardId);
    render();
  };
  $('#sb-export').onclick = async () => {
    const next = collectItemsFromDom(board.items || []);
    const saved = await persist(next);
    downloadText(`reliquary-${saved.name}`, storyboardToMarkdown(saved), 'text/markdown');
    toast('Exported Markdown', 'ok');
  };
  $('#sb-add-heading').onclick = async () => {
    const title = prompt('Section heading:', 'Act / Chapter / Beat');
    if (title === null) return;
    const next = collectItemsFromDom(board.items || []);
    next.push(makeHeadingItem(title.trim() || 'Section'));
    await persist(next);
    render();
  };
  $('#sb-add-note').onclick = async () => {
    const next = collectItemsFromDom(board.items || []);
    next.push(makeNoteItem('Your note…'));
    await persist(next);
    render();
  };
  $('#sb-add-pieces').onclick = () => {
    state.view = 'pieces';
    state.filter = 'active';
    state.activeStoryboardId = boardId; // remember which board to return? optional
    // Keep active id so picker can default? We'll just go to pieces
    toast('Select fragments → ＋ Storyboard', 'ok');
    render();
  };

  bindStoryboardItemActions(board, persist, () => collectItemsFromDom(board.items || []));
}

function collectItemsFromDom(fallbackItems) {
  const lane = $('#sb-lane');
  if (!lane) return fallbackItems;
  const cards = [...lane.querySelectorAll('.sb-item')];
  if (!cards.length) return fallbackItems;
  return cards.map((el) => {
    const id = el.dataset.itemId;
    const kind = el.dataset.kind;
    const base = fallbackItems.find((i) => i.id === id) || { id, kind };
    if (kind === 'heading') {
      const text = el.querySelector('[data-item-text]')?.value ?? base.text;
      return { ...base, kind: 'heading', text };
    }
    if (kind === 'note') {
      const text = el.querySelector('[data-item-text]')?.value ?? base.text;
      return { ...base, kind: 'note', text };
    }
    // piece: optional edit
    const text = el.querySelector('[data-item-text]')?.value ?? base.text;
    return { ...base, kind: 'piece', text };
  });
}

function renderStoryboardItem(item, idx, total) {
  if (item.kind === 'heading') {
    return `
      <div class="sb-item sb-heading" data-item-id="${item.id}" data-kind="heading">
        <div class="sb-item-rail">
          <button type="button" class="icon-btn" data-up title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="icon-btn" data-down title="Move down" ${idx >= total - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="icon-btn danger" data-remove title="Remove">✕</button>
        </div>
        <div class="sb-item-body">
          <span class="sb-kind-pill">Section</span>
          <input class="sb-heading-input" data-item-text value="${esc(item.text || '')}" />
        </div>
      </div>`;
  }
  if (item.kind === 'note') {
    return `
      <div class="sb-item sb-note" data-item-id="${item.id}" data-kind="note">
        <div class="sb-item-rail">
          <button type="button" class="icon-btn" data-up title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="icon-btn" data-down title="Move down" ${idx >= total - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="icon-btn danger" data-remove title="Remove">✕</button>
        </div>
        <div class="sb-item-body">
          <span class="sb-kind-pill">Note</span>
          <textarea data-item-text rows="2">${esc(item.text || '')}</textarea>
        </div>
      </div>`;
  }
  return `
    <div class="sb-item sb-piece" data-item-id="${item.id}" data-kind="piece">
      <div class="sb-item-rail">
        <span class="sb-idx">${idx + 1}</span>
        <button type="button" class="icon-btn" data-up title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn" data-down title="Move down" ${idx >= total - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="icon-btn danger" data-remove title="Remove from board">✕</button>
      </div>
      <div class="sb-item-body">
        <div class="card-source">${esc(item.sourceName || 'Fragment')}${(item.labels || []).length ? ' · ' + (item.labels || []).map(esc).join(', ') : ''}</div>
        <textarea data-item-text rows="4" class="sb-piece-text">${esc(item.text || '')}</textarea>
      </div>
    </div>`;
}

function bindStoryboardItemActions(board, persist, getItems) {
  const lane = $('#sb-lane');
  if (!lane) return;

  const move = async (id, dir) => {
    const items = getItems();
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    await persist(next);
    render();
  };

  lane.querySelectorAll('.sb-item').forEach((el) => {
    const id = el.dataset.itemId;
    el.querySelector('[data-up]')?.addEventListener('click', () => move(id, -1));
    el.querySelector('[data-down]')?.addEventListener('click', () => move(id, 1));
    el.querySelector('[data-remove]')?.addEventListener('click', async () => {
      const items = getItems().filter((x) => x.id !== id);
      await persist(items);
      toast('Removed from board (piece still in vault)', 'ok');
      render();
    });
  });
}

// ── Collections ────────────────────────────────────────────

function renderCollections(root, actions) {
  actions.innerHTML = `<button type="button" class="btn primary" id="btn-new-col">New collection</button>`;
  $('#btn-new-col').onclick = async () => {
    const name = prompt('Collection name:');
    if (!name?.trim()) return;
    await putCollection({ name: name.trim() });
    await reload();
    render();
  };
  root.innerHTML = state.collections.length
    ? `<div class="card-grid">
        ${state.collections
          .map(
            (c) => `
          <article class="piece-card">
            <h3 style="font-family:var(--serif);margin:0">${esc(c.name)}</h3>
            <p class="muted" style="margin:0">${esc(c.description || '—')}</p>
            <div class="piece-actions">
              <button type="button" class="btn" data-export-col="${c.id}">Export MD</button>
              <button type="button" class="btn danger" data-del-col="${c.id}">Delete</button>
            </div>
          </article>`
          )
          .join('')}
      </div>
      <p class="muted" style="margin-top:1rem">Tip: open a piece → add collection IDs in a future pass, or multi-select and file from Develop. For v1, export collections after tagging pieces with matching tags, or star pieces into a working set and export the Starred view.</p>`
    : `<div class="empty"><h3>No collections yet</h3><p>Create named shelves for projects and archives.</p></div>`;

  root.querySelectorAll('[data-export-col]').forEach((btn) => {
    btn.onclick = async () => {
      const col = state.collections.find((c) => c.id === btn.dataset.exportCol);
      const pieces = await listPieces({ collectionId: col.id });
      // also include pieces tagged with collection name
      const tagged = (await listPieces({})).filter(
        (p) => (p.tags || []).includes(col.name) || (p.collectionIds || []).includes(col.id)
      );
      const set = new Map([...pieces, ...tagged].map((p) => [p.id, p]));
      downloadText(`reliquary-${col.name}`, collectionToMarkdown(col.name, [...set.values()]), 'text/markdown');
      toast('Exported', 'ok');
    };
  });
  root.querySelectorAll('[data-del-col]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete collection?')) return;
      await deleteCollection(btn.dataset.delCol);
      await reload();
      render();
    };
  });
}

// ── Sources ────────────────────────────────────────────────

function renderSources(root, actions) {
  actions.innerHTML = '';
  root.innerHTML = state.documents.length
    ? `<div class="card-grid">
        ${state.documents
          .map(
            (d) => `
          <article class="piece-card">
            <h3 style="font-family:var(--serif);margin:0;font-size:1rem">${esc(d.name)}</h3>
            <p class="muted" style="margin:0">${d.charCount?.toLocaleString?.() || d.charCount} chars · ${d.pieceCount || '?'} pieces · ${esc(d.kind)}</p>
            <p class="dim" style="margin:0">${formatDate(d.importedAt)}</p>
            <div class="piece-actions">
              <button type="button" class="btn danger" data-del-doc="${d.id}">Remove source & pieces</button>
            </div>
          </article>`
          )
          .join('')}
      </div>`
    : `<div class="empty"><h3>No files imported yet</h3><p>Go to <strong>Start here</strong> and choose a draft.</p></div>`;
  root.querySelectorAll('[data-del-doc]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this source and all its pieces?')) return;
      await deleteDocument(btn.dataset.delDoc);
      await reload();
      render();
    };
  });
}

// ── Settings ───────────────────────────────────────────────

function renderSettings(root, actions) {
  actions.innerHTML = '';
  const s = state.settings;
  root.innerHTML = `
    <div class="piece-card" style="max-width:36rem">
      <h3 style="font-family:var(--serif);margin:0 0 0.75rem">Appearance & chunking</h3>
      <div class="field">
        <label>Theme</label>
        <select id="s-theme">
          <option value="dark" ${s.theme !== 'light' ? 'selected' : ''}>Dark</option>
          <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option>
        </select>
      </div>
      <div class="field">
        <label>Chunking aggressiveness</label>
        <select id="s-chunk">
          <option value="conservative" ${s.chunkMode === 'conservative' ? 'selected' : ''}>Conservative — larger pieces</option>
          <option value="balanced" ${s.chunkMode === 'balanced' || !s.chunkMode ? 'selected' : ''}>Balanced</option>
          <option value="atomic" ${s.chunkMode === 'atomic' ? 'selected' : ''}>Atomic — smaller fragments</option>
        </select>
      </div>
      <label class="field" style="flex-direction:row;align-items:center;gap:0.5rem">
        <input type="checkbox" id="s-ai-chunk" ${s.useAiChunk ? 'checked' : ''} />
        AI-assisted chunking on import (optional, needs LLM; slower)
      </label>
    </div>
    <div class="piece-card" style="max-width:36rem;margin-top:1rem">
      <h3 style="font-family:var(--serif);margin:0 0 0.75rem">Labels</h3>
      <div class="field">
        <label>One label per line (your taxonomy)</label>
        <textarea id="s-labels" rows="8">${esc((s.labels || DEFAULT_LABELS).join('\n'))}</textarea>
      </div>
    </div>
    <div class="piece-card" style="max-width:36rem;margin-top:1rem">
      <h3 style="font-family:var(--serif);margin:0 0 0.5rem">Optional AI</h3>
      <p class="muted" style="margin-top:0">Clearly optional. Local Ollama or any OpenAI-compatible API (including Grok).</p>
      <div class="field">
        <label>Base URL</label>
        <input id="s-llm-url" value="${esc(s.llmBaseUrl || '')}" placeholder="http://localhost:11434/v1" />
      </div>
      <div class="field">
        <label>Model</label>
        <input id="s-llm-model" value="${esc(s.llmModel || '')}" placeholder="llama3.2 or grok-…" />
      </div>
      <div class="field">
        <label>API key (if needed)</label>
        <input id="s-llm-key" type="password" value="${esc(s.llmApiKey || '')}" />
      </div>
      <div class="piece-actions">
        <button type="button" class="btn" id="s-test">Test connection</button>
      </div>
      <p id="s-llm-status" class="dim"></p>
    </div>
    <div class="piece-card" style="max-width:36rem;margin-top:1rem">
      <h3 style="font-family:var(--serif);margin:0 0 0.75rem">Support links (shown in app)</h3>
      <div class="field">
        <label>GitHub Sponsors URL</label>
        <input id="s-gh" value="${esc(s.supportGithubSponsors || '')}" />
      </div>
      <div class="field">
        <label>Ko-fi URL</label>
        <input id="s-kofi" value="${esc(s.supportKofi || '')}" />
      </div>
    </div>
    <div class="piece-actions" style="margin-top:1rem">
      <button type="button" class="btn primary" id="s-save">Save settings</button>
    </div>
    <div id="support">${supportBlock()}</div>
  `;

  $('#s-save').onclick = async () => {
    const labels = $('#s-labels')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    state.settings = await setSettings({
      theme: $('#s-theme').value,
      chunkMode: $('#s-chunk').value,
      useAiChunk: $('#s-ai-chunk').checked,
      llmBaseUrl: $('#s-llm-url').value.trim(),
      llmModel: $('#s-llm-model').value.trim(),
      llmApiKey: $('#s-llm-key').value.trim(),
      labels: labels.length ? labels : DEFAULT_LABELS,
      supportGithubSponsors: $('#s-gh').value.trim(),
      supportKofi: $('#s-kofi').value.trim(),
    });
    applyTheme(state.settings.theme);
    toast('Settings saved', 'ok');
    render();
  };
  $('#s-test').onclick = async () => {
    const r = await checkLlm($('#s-llm-url').value.trim(), $('#s-llm-key').value.trim());
    $('#s-llm-status').textContent = r.ok ? r.message : r.reason;
    toast(r.ok ? 'LLM OK' : r.reason, r.ok ? 'ok' : 'err');
  };
}

function supportBlock() {
  const s = state.settings || {};
  return `
    <div class="support-card">
      <h3>Support Reliquary</h3>
      <p>${esc(s.supportNote || 'Reliquary is free and open source. If it helps you excavate your work, consider supporting development.')}</p>
      <div class="support-links">
        <a class="btn" href="${esc(s.supportGithubSponsors || 'https://github.com/sponsors')}" target="_blank" rel="noopener">GitHub Sponsors</a>
        <a class="btn" href="${esc(s.supportKofi || 'https://ko-fi.com')}" target="_blank" rel="noopener">Ko-fi</a>
      </div>
    </div>`;
}
