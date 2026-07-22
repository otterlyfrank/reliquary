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
import {
  chunkDocument,
  buildAiChunkPrompt,
  resolveChunkOptions,
  describeChunkOptions,
  estimatePieceCount,
  CHUNK_UNITS,
  CHUNK_SIZE_PRESETS,
} from './chunk/engine.js';
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
  /** Compact storyboard cards */
  sbDense: true,
  filter: 'active',
  label: '',
  q: '',
  selected: new Set(),
  busy: false,
  /** Card density: comfortable | compact */
  cardDensity: 'comfortable',
  /**
   * Per-session offline split overrides for the next import (null = use Settings).
   * @type {null | Record<string, any>}
   */
  importChunk: null,
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
      <span>Split: <strong>${esc(describeChunkOptions(activeChunkSettings()))}</strong></span>
    </div>
    ${renderImportSplitPanel()}
    <div id="import-progress" class="import-progress" hidden></div>
    <p class="muted">Next: open <strong>My pieces</strong> → star keepers → <strong>Storyboards</strong> to outline or draft. Your words stay local.</p>
    ${supportBlock()}
  `;
  listPieces({}).then((all) => {
    const el = $('#piece-count');
    if (el) el.textContent = `${all.length} pieces`;
  });
  bindImportSplitPanel();

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
        const chunkOpts = {
          ...activeChunkSettings(),
          sourceName: parsed.name,
        };
        let chunks = chunkDocument(parsed.text, chunkOpts);

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
                {
                  role: 'user',
                  content: buildAiChunkPrompt(parsed.text, chunkOpts),
                },
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
  const dense = state.cardDensity === 'compact';
  actions.innerHTML = `
    <button type="button" class="btn" id="btn-density">${dense ? 'Comfortable cards' : 'Compact cards'}</button>
    <button type="button" class="btn" id="btn-select-all" ${!state.pieces.length ? 'disabled' : ''}>Select all</button>
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
  $('#btn-density').onclick = () => {
    state.cardDensity = dense ? 'comfortable' : 'compact';
    render();
  };
  $('#btn-select-all').onclick = () => {
    if (state.selected.size === state.pieces.length) state.selected = new Set();
    else state.selected = new Set(state.pieces.map((p) => p.id));
    render();
  };

  root.innerHTML = `
    <div class="filter-row">
      <input class="search" id="q" placeholder="Search pieces…" value="${esc(state.q)}" />
      <button type="button" class="chip ${!state.label ? 'active' : ''}" data-label="">All labels</button>
      ${labels
        .slice(0, 14)
        .map(
          (l) =>
            `<button type="button" class="chip ${state.label === l ? 'active' : ''}" data-label="${esc(l)}">${esc(l)}</button>`
        )
        .join('')}
    </div>
    <div class="stats">
      <span>${state.pieces.length} shown</span>
      <span>${state.selected.size} selected</span>
      <span class="dim">${dense ? 'compact' : 'comfortable'}</span>
    </div>
    ${
      state.pieces.length
        ? `<div class="card-grid ${dense ? 'compact' : ''}" id="grid">
            ${state.pieces.map((p) => renderCard(p, dense)).join('')}
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
            <button type="button" class="btn" id="ms-label">＋ Label</button>
            <button type="button" class="btn" id="ms-tag">＋ Tag</button>
            <button type="button" class="btn" id="ms-star">Star</button>
            <button type="button" class="btn" id="ms-unstar">Unstar</button>
            <button type="button" class="btn" id="ms-develop">Work on later</button>
            <button type="button" class="btn" id="ms-active">Restore active</button>
            <button type="button" class="btn" id="ms-archive">Archive</button>
            <button type="button" class="btn" id="ms-export">Export MD</button>
            <button type="button" class="btn" id="ms-ai">AI structure…</button>
            <button type="button" class="btn ghost" id="ms-clear">Clear</button>
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
    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, label, input, a')) return;
      openReading(id);
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
      toast('Sent to Work on later', 'ok');
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
    card.querySelector('[data-quick-label]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const lab = e.currentTarget.dataset.quickLabel;
      const p = state.pieces.find((x) => x.id === id);
      if (!p || !lab) return;
      const set = new Set(p.labels || []);
      if (set.has(lab)) set.delete(lab);
      else set.add(lab);
      await updatePiece(id, { labels: [...set] });
      await reload();
      render();
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
  $('#ms-unstar')?.addEventListener('click', async () => {
    for (const id of state.selected) await updatePiece(id, { starred: false });
    toast('Unstarred', 'ok');
    await reload();
    render();
  });
  $('#ms-develop')?.addEventListener('click', async () => {
    for (const id of state.selected) await updatePiece(id, { status: 'develop' });
    toast('Queued for later', 'ok');
    state.selected = new Set();
    await reload();
    render();
  });
  $('#ms-active')?.addEventListener('click', async () => {
    for (const id of state.selected) await updatePiece(id, { status: 'active' });
    toast('Restored to active', 'ok');
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
  $('#ms-export')?.addEventListener('click', () => {
    const pieces = state.pieces.filter((p) => state.selected.has(p.id));
    downloadText('reliquary-selection', collectionToMarkdown('Selection', pieces), 'text/markdown');
    toast('Exported selection', 'ok');
  });
  $('#ms-label')?.addEventListener('click', async () => {
    const lab = prompt('Label to add (must match or create via Settings later):', labels[0] || 'Concept');
    if (!lab?.trim()) return;
    const name = lab.trim();
    for (const id of state.selected) {
      const p = await listPieces({}).then((all) => all.find((x) => x.id === id));
      if (!p) continue;
      const set = new Set(p.labels || []);
      set.add(name);
      await updatePiece(id, { labels: [...set] });
    }
    // ensure label in settings taxonomy
    if (!(state.settings.labels || []).includes(name)) {
      state.settings = await setSettings({
        labels: [...(state.settings.labels || DEFAULT_LABELS), name],
      });
    }
    toast(`Labeled “${name}”`, 'ok');
    await reload();
    render();
  });
  $('#ms-tag')?.addEventListener('click', async () => {
    const tag = prompt('Tag to add (no # needed):', '');
    if (!tag?.trim()) return;
    const name = tag.trim().replace(/^#/, '');
    for (const id of state.selected) {
      const p = state.pieces.find((x) => x.id === id);
      if (!p) continue;
      const set = new Set(p.tags || []);
      set.add(name);
      await updatePiece(id, { tags: [...set] });
    }
    toast(`Tagged #${name}`, 'ok');
    await reload();
    render();
  });
  $('#ms-ai')?.addEventListener('click', () => openAiDevelop([...state.selected]));
  $('#ms-board')?.addEventListener('click', () => {
    const pieces = state.pieces.filter((p) => state.selected.has(p.id));
    openAddToStoryboard(pieces);
  });
}

function renderCard(p, dense = false) {
  const selected = state.selected.has(p.id);
  const energy = '★'.repeat(p.energy || 0) + '☆'.repeat(3 - (p.energy || 0));
  const preview = dense
    ? esc((p.text || '').slice(0, 220)) + ((p.text || '').length > 220 ? '…' : '')
    : esc(p.text);
  const quickLabels = (state.settings.labels || DEFAULT_LABELS).slice(0, dense ? 4 : 6);
  return `
    <article class="piece-card ${p.isLarge && !dense ? 'large' : ''} ${dense ? 'dense' : ''} ${selected ? 'selected' : ''}" data-id="${p.id}">
      <label class="select-box"><input type="checkbox" data-select ${selected ? 'checked' : ''} /></label>
      <div class="card-source">${esc(p.sourceName || '—')} · ${formatDate(p.updatedAt)}${p.starred ? ' · ★' : ''}${p.pinned ? ' · 📌' : ''}</div>
      <p class="piece-text">${preview}</p>
      <div class="piece-meta">
        ${(p.labels || []).map((l) => `<span class="label-pill">${esc(l)}</span>`).join('')}
        ${(p.tags || []).map((t) => `<span class="tag-pill">#${esc(t)}</span>`).join('')}
      </div>
      <div class="quick-labels">
        ${quickLabels
          .map((l) => {
            const on = (p.labels || []).includes(l);
            return `<button type="button" class="chip micro ${on ? 'active' : ''}" data-quick-label="${esc(l)}">${esc(l)}</button>`;
          })
          .join('')}
      </div>
      <div class="piece-actions">
        <button type="button" class="icon-btn ${p.starred ? 'on' : ''}" data-star title="Star">★</button>
        <button type="button" class="icon-btn ${p.pinned ? 'on' : ''}" data-pin title="Pin">📌</button>
        <button type="button" class="icon-btn" data-energy title="Energy">${energy}</button>
        <button type="button" class="icon-btn" data-open title="Read (or double-click card)">Read</button>
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
  const all = await listPieces({});
  let idx = all.findIndex((x) => x.id === id);
  if (idx < 0) return;
  let p = all[idx];
  const labelsTax = state.settings.labels || DEFAULT_LABELS;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const paint = () => {
    p = all[idx];
    backdrop.innerHTML = `
    <div class="modal wide" role="dialog">
      <div class="reading-nav">
        <button type="button" class="btn ghost" id="r-prev" ${idx <= 0 ? 'disabled' : ''}>← Prev</button>
        <span class="dim">${idx + 1} / ${all.length}</span>
        <button type="button" class="btn ghost" id="r-next" ${idx >= all.length - 1 ? 'disabled' : ''}>Next →</button>
      </div>
      <h2>${esc((p.labels || [])[0] || 'Fragment')}</h2>
      <p class="dim">${esc(p.sourceName || '')} · ${formatDate(p.updatedAt)}</p>
      <div class="reading-body">${esc(p.text)}</div>
      <div class="quick-labels reading-labels">
        ${labelsTax
          .slice(0, 10)
          .map((l) => {
            const on = (p.labels || []).includes(l);
            return `<button type="button" class="chip micro ${on ? 'active' : ''}" data-r-label="${esc(l)}">${esc(l)}</button>`;
          })
          .join('')}
      </div>
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
    bindReading();
  };

  const bindReading = () => {
    const close = () => backdrop.remove();
    backdrop.onclick = (e) => {
      if (e.target === backdrop) close();
    };
    $('#r-close', backdrop).onclick = close;
    $('#r-prev', backdrop).onclick = () => {
      if (idx > 0) {
        idx--;
        paint();
      }
    };
    $('#r-next', backdrop).onclick = () => {
      if (idx < all.length - 1) {
        idx++;
        paint();
      }
    };
    $('#r-board', backdrop).onclick = () => {
      close();
      openAddToStoryboard([p]);
    };
    $('#r-export', backdrop).onclick = () => {
      downloadText('reliquary-piece', pieceToMarkdown(p), 'text/markdown');
    };
    backdrop.querySelectorAll('[data-r-label]').forEach((btn) => {
      btn.onclick = () => {
        const lab = btn.dataset.rLabel;
        const cur = ($('#edit-labels', backdrop).value || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const set = new Set(cur);
        if (set.has(lab)) set.delete(lab);
        else set.add(lab);
        $('#edit-labels', backdrop).value = [...set].join(', ');
        btn.classList.toggle('active');
      };
    });
    $('#r-save', backdrop).onclick = async () => {
      const labels = $('#edit-labels', backdrop)
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const tags = $('#edit-tags', backdrop)
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await updatePiece(p.id, { labels, tags });
      p.labels = labels;
      p.tags = tags;
      all[idx] = { ...p };
      toast('Saved', 'ok');
      await reload();
    };
  };

  document.body.appendChild(backdrop);
  paint();
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

  const dense = state.sbDense !== false;
  actions.innerHTML = `
    <button type="button" class="btn" id="sb-back">← All storyboards</button>
    <button type="button" class="btn" id="sb-density">${dense ? 'Roomy' : 'Dense'}</button>
    <button type="button" class="btn" id="sb-export">Export MD</button>
    <button type="button" class="btn primary" id="sb-save">Save</button>
  `;

  const items = board.items || [];
  root.innerHTML = `
    <div class="sb-header ${dense ? 'dense' : ''}">
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
    <div class="field ${dense ? 'sb-notes-dense' : ''}">
      <label>Working notes</label>
      <textarea id="sb-notes" rows="${dense ? 2 : 3}" placeholder="Thesis, questions, tone…">${esc(board.notes || '')}</textarea>
    </div>
    <div class="sb-toolbar">
      <button type="button" class="btn" id="sb-add-heading">＋ Section</button>
      <button type="button" class="btn" id="sb-add-note">＋ Note</button>
      <button type="button" class="btn" id="sb-add-pieces">＋ From pieces</button>
      <span class="dim">${items.length} item${items.length === 1 ? '' : 's'} · drag to reorder</span>
    </div>
    <div class="sb-lane ${dense ? 'dense' : ''}" id="sb-lane">
      ${
        items.length
          ? items
              .map((item, idx) => renderStoryboardItem(item, idx, items.length, dense))
              .join('')
          : `<div class="empty sb-empty">
              <h3>Empty board</h3>
              <p>Add fragments from <strong>My pieces</strong>, or drop a section heading to start an outline. Drag cards to reorder.</p>
            </div>`
      }
    </div>
  `;

  const readForm = () => ({
    name: $('#sb-name').value.trim() || 'Untitled storyboard',
    mode: $('#sb-mode').value,
    notes: $('#sb-notes').value,
  });

  const persist = async (nextItems) => {
    const form = readForm();
    board = await putStoryboard({
      ...board,
      ...form,
      items: nextItems,
    });
    await reload();
    return board;
  };

  const getItems = () => collectItemsFromDom(board.items || []);

  $('#sb-density').onclick = () => {
    state.sbDense = !dense;
    render();
  };
  $('#sb-back').onclick = async () => {
    await persist(getItems());
    state.activeStoryboardId = null;
    await reload();
    render();
  };
  $('#sb-save').onclick = async () => {
    await persist(getItems());
    toast('Storyboard saved', 'ok');
    render();
  };
  $('#sb-export').onclick = async () => {
    const saved = await persist(getItems());
    downloadText(`reliquary-${saved.name}`, storyboardToMarkdown(saved), 'text/markdown');
    toast('Exported Markdown', 'ok');
  };
  $('#sb-add-heading').onclick = async () => {
    const title = prompt('Section heading:', 'Act / Chapter / Beat');
    if (title === null) return;
    const next = getItems();
    next.push(makeHeadingItem(title.trim() || 'Section'));
    await persist(next);
    render();
  };
  $('#sb-add-note').onclick = async () => {
    const next = getItems();
    next.push(makeNoteItem('Your note…'));
    await persist(next);
    render();
  };
  $('#sb-add-pieces').onclick = () => {
    state.view = 'pieces';
    state.filter = 'active';
    state.activeStoryboardId = boardId;
    toast('Select fragments → ＋ Storyboard', 'ok');
    render();
  };

  bindStoryboardItemActions(persist, getItems);
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
    const text = el.querySelector('[data-item-text]')?.value ?? base.text;
    return { ...base, kind: 'piece', text };
  });
}

function renderStoryboardItem(item, idx, total, dense = true) {
  const rail = `
    <div class="sb-item-rail">
      <span class="sb-drag" title="Drag to reorder" aria-hidden="true">⠿</span>
      <span class="sb-idx">${idx + 1}</span>
      <button type="button" class="icon-btn" data-up title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="icon-btn" data-down title="Move down" ${idx >= total - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="icon-btn danger" data-remove title="Remove">✕</button>
    </div>`;
  if (item.kind === 'heading') {
    return `
      <div class="sb-item sb-heading ${dense ? 'dense' : ''}" draggable="true" data-item-id="${item.id}" data-kind="heading">
        ${rail}
        <div class="sb-item-body">
          <span class="sb-kind-pill">Section</span>
          <input class="sb-heading-input" data-item-text value="${esc(item.text || '')}" />
        </div>
      </div>`;
  }
  if (item.kind === 'note') {
    return `
      <div class="sb-item sb-note ${dense ? 'dense' : ''}" draggable="true" data-item-id="${item.id}" data-kind="note">
        ${rail}
        <div class="sb-item-body">
          <span class="sb-kind-pill">Note</span>
          <textarea data-item-text rows="${dense ? 1 : 2}">${esc(item.text || '')}</textarea>
        </div>
      </div>`;
  }
  return `
    <div class="sb-item sb-piece ${dense ? 'dense' : ''}" draggable="true" data-item-id="${item.id}" data-kind="piece">
      ${rail}
      <div class="sb-item-body">
        <div class="card-source">${esc(item.sourceName || 'Fragment')}${(item.labels || []).length ? ' · ' + (item.labels || []).map(esc).join(', ') : ''}</div>
        <textarea data-item-text rows="${dense ? 2 : 4}" class="sb-piece-text">${esc(item.text || '')}</textarea>
      </div>
    </div>`;
}

function bindStoryboardItemActions(persist, getItems) {
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

  let dragId = null;
  lane.querySelectorAll('.sb-item').forEach((el) => {
    const id = el.dataset.itemId;
    el.querySelector('[data-up]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      move(id, -1);
    });
    el.querySelector('[data-down]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      move(id, 1);
    });
    el.querySelector('[data-remove]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const items = getItems().filter((x) => x.id !== id);
      await persist(items);
      toast('Removed from board (piece still in vault)', 'ok');
      render();
    });

    // Don't start drag from form fields
    el.addEventListener('dragstart', (e) => {
      if (e.target.closest('input, textarea, button, a')) {
        e.preventDefault();
        return;
      }
      dragId = id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      dragId = null;
      lane.querySelectorAll('.sb-item').forEach((c) => c.classList.remove('drag-over'));
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const fromId = e.dataTransfer.getData('text/plain') || dragId;
      const toId = id;
      if (!fromId || fromId === toId) return;
      const items = getItems();
      const from = items.findIndex((x) => x.id === fromId);
      const to = items.findIndex((x) => x.id === toId);
      if (from < 0 || to < 0) return;
      const next = [...items];
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row);
      await persist(next);
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

// ── Offline split controls ─────────────────────────────────

function activeChunkSettings() {
  const base = state.settings || {};
  if (state.importChunk) return { ...base, ...state.importChunk };
  return base;
}

function readChunkFields(prefix) {
  const unit = $(`#${prefix}-unit`)?.value || 'hybrid';
  const sizePreset = $(`#${prefix}-size`)?.value || 'medium';
  const pageWords = Number($(`#${prefix}-page-words`)?.value) || 300;
  const minChars = Number($(`#${prefix}-min`)?.value) || 40;
  const maxChars = Number($(`#${prefix}-max`)?.value) || 1800;
  const respectPageBreaks = !!$(`#${prefix}-pages`)?.checked;
  const keepDialogueTogether = !!$(`#${prefix}-dialogue`)?.checked;
  // Keep legacy chunkMode in sync for older displays
  const chunkMode =
    sizePreset === 'fine' ? 'atomic' : sizePreset === 'coarse' ? 'conservative' : 'balanced';
  return {
    chunkUnit: unit,
    chunkSizePreset: sizePreset,
    chunkPageWords: pageWords,
    chunkMinChars: minChars,
    chunkMaxChars: maxChars,
    respectPageBreaks,
    keepDialogueTogether,
    chunkMode,
  };
}

function renderChunkControls(prefix, values, { showEstimate = false } = {}) {
  const v = resolveChunkOptions(values || {});
  const unitOpts = CHUNK_UNITS.map(
    (u) =>
      `<option value="${u.id}" ${v.unit === u.id ? 'selected' : ''} title="${esc(u.hint)}">${esc(
        u.label
      )}</option>`
  ).join('');
  const sizeOpts = CHUNK_SIZE_PRESETS.map(
    (p) =>
      `<option value="${p.id}" ${v.sizePreset === p.id ? 'selected' : ''} title="${esc(p.hint)}">${esc(
        p.label
      )}</option>`
  ).join('');
  const customHidden = v.sizePreset === 'custom' ? '' : 'hidden';
  const pageHidden = v.unit === 'page' || v.sizePreset === 'custom' ? '' : 'hidden';

  return `
    <div class="chunk-controls" data-chunk-prefix="${esc(prefix)}">
      <div class="field">
        <label>How to cut the writing (offline)</label>
        <select id="${prefix}-unit">${unitOpts}</select>
        <p class="dim chunk-hint" id="${prefix}-unit-hint" style="margin:0.35rem 0 0">${esc(
          CHUNK_UNITS.find((u) => u.id === v.unit)?.hint || ''
        )}</p>
      </div>
      <div class="field">
        <label>Piece size</label>
        <select id="${prefix}-size">${sizeOpts}</select>
        <p class="dim chunk-hint" id="${prefix}-size-hint" style="margin:0.35rem 0 0">${esc(
          CHUNK_SIZE_PRESETS.find((p) => p.id === v.sizePreset)?.hint || ''
        )}</p>
      </div>
      <div class="grid-2 chunk-custom" id="${prefix}-custom" ${customHidden ? 'hidden' : ''}>
        <div class="field">
          <label>Min characters (merge tinier scraps)</label>
          <input type="number" id="${prefix}-min" min="1" max="2000" value="${v.minChars}" />
        </div>
        <div class="field">
          <label>Max characters (split larger blocks)</label>
          <input type="number" id="${prefix}-max" min="40" max="20000" value="${v.maxChars}" />
        </div>
      </div>
      <div class="field chunk-page-words" id="${prefix}-page-wrap" ${
        v.unit === 'page' || v.sizePreset === 'custom' ? '' : 'hidden'
      }>
        <label>Words per page (page mode)</label>
        <input type="number" id="${prefix}-page-words" min="40" max="2000" value="${v.pageWords}" />
      </div>
      <label class="field check-row">
        <input type="checkbox" id="${prefix}-pages" ${v.respectPageBreaks ? 'checked' : ''} />
        Honor page breaks (form-feed / “Page N” markers)
      </label>
      <label class="field check-row">
        <input type="checkbox" id="${prefix}-dialogue" ${v.keepDialogueTogether ? 'checked' : ''} />
        Keep short dialogue lines together when possible
      </label>
      ${
        showEstimate
          ? `<p class="dim" id="${prefix}-estimate" style="margin:0.5rem 0 0">Live estimate updates when you change options.</p>`
          : `<p class="dim" id="${prefix}-summary" style="margin:0.5rem 0 0">Using: <strong>${esc(
              describeChunkOptions(v)
            )}</strong></p>`
      }
    </div>
  `;
}

function wireChunkControls(prefix, onChange) {
  const unitSel = $(`#${prefix}-unit`);
  const sizeSel = $(`#${prefix}-size`);
  const refreshUi = () => {
    const unit = unitSel?.value || 'hybrid';
    const size = sizeSel?.value || 'medium';
    const unitMeta = CHUNK_UNITS.find((u) => u.id === unit);
    const sizeMeta = CHUNK_SIZE_PRESETS.find((p) => p.id === size);
    const uh = $(`#${prefix}-unit-hint`);
    const sh = $(`#${prefix}-size-hint`);
    if (uh) uh.textContent = unitMeta?.hint || '';
    if (sh) sh.textContent = sizeMeta?.hint || '';
    const custom = $(`#${prefix}-custom`);
    if (custom) custom.hidden = size !== 'custom';
    const pageWrap = $(`#${prefix}-page-wrap`);
    if (pageWrap) pageWrap.hidden = !(unit === 'page' || size === 'custom');
    const summary = $(`#${prefix}-summary`);
    if (summary) {
      summary.innerHTML = `Using: <strong>${esc(describeChunkOptions(readChunkFields(prefix)))}</strong>`;
    }
    onChange?.(readChunkFields(prefix));
  };
  unitSel?.addEventListener('change', refreshUi);
  sizeSel?.addEventListener('change', refreshUi);
  [`${prefix}-min`, `${prefix}-max`, `${prefix}-page-words`, `${prefix}-pages`, `${prefix}-dialogue`].forEach(
    (id) => {
      $(`#${id}`)?.addEventListener('change', refreshUi);
      $(`#${id}`)?.addEventListener('input', refreshUi);
    }
  );
  refreshUi();
}

function renderImportSplitPanel() {
  const usingSession = !!state.importChunk;
  const values = activeChunkSettings();
  return `
    <div class="piece-card import-split-card">
      <h3 style="font-family:var(--serif);margin:0 0 0.35rem">How to split (this import)</h3>
      <p class="muted" style="margin:0 0 0.75rem">
        Offline by default — no AI required. Pick sentence / paragraph / page cuts and piece size.
        ${usingSession ? '<strong>Session override is on</strong> (won’t change Settings until you save it there).' : 'Defaults come from <strong>Settings</strong>.'}
      </p>
      ${renderChunkControls('imp', values)}
      <div class="piece-actions" style="margin-top:0.75rem">
        <button type="button" class="btn primary" id="imp-apply">Use for next imports</button>
        <button type="button" class="btn" id="imp-save-default">Save as my default</button>
        <button type="button" class="btn ghost" id="imp-reset" ${usingSession ? '' : 'disabled'}>Reset to Settings</button>
      </div>
    </div>
  `;
}

function bindImportSplitPanel() {
  if (!$('#imp-unit')) return;
  wireChunkControls('imp');
  $('#imp-apply')?.addEventListener('click', () => {
    state.importChunk = readChunkFields('imp');
    toast(`Split set for imports · ${describeChunkOptions(state.importChunk)}`, 'ok');
    render();
  });
  $('#imp-save-default')?.addEventListener('click', async () => {
    const fields = readChunkFields('imp');
    state.settings = await setSettings(fields);
    state.importChunk = null;
    toast('Saved as default split settings', 'ok');
    render();
  });
  $('#imp-reset')?.addEventListener('click', () => {
    state.importChunk = null;
    toast('Using Settings defaults again', 'ok');
    render();
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
              <button type="button" class="btn" data-resplit-doc="${d.id}">Re-split offline…</button>
              <button type="button" class="btn danger" data-del-doc="${d.id}">Remove source & pieces</button>
            </div>
          </article>`
          )
          .join('')}
      </div>
      <p class="muted" style="margin-top:1rem">
        <strong>Re-split offline</strong> replaces this source’s pieces using your current split settings
        (sentence / paragraph / page, etc.). Starred pieces from this source are kept only if you cancel — re-split starts clean.
      </p>`
    : `<div class="empty"><h3>No files imported yet</h3><p>Go to <strong>Start here</strong> and choose a draft.</p></div>`;
  root.querySelectorAll('[data-del-doc]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this source and all its pieces?')) return;
      await deleteDocument(btn.dataset.delDoc);
      await reload();
      render();
    };
  });
  root.querySelectorAll('[data-resplit-doc]').forEach((btn) => {
    btn.onclick = () => openResplitModal(btn.dataset.resplitDoc);
  });
}

async function openResplitModal(docId) {
  const doc = state.documents.find((d) => d.id === docId);
  if (!doc?.text) {
    toast('No stored text for this source — re-import the file', 'err');
    return;
  }
  const existing = await listPieces({ documentId: docId });
  const starred = existing.filter((p) => p.starred).length;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal piece-card" style="max-width:28rem">
      <h3 style="font-family:var(--serif);margin:0 0 0.5rem">Re-split “${esc(doc.name)}”</h3>
      <p class="muted">
        Offline only. Replaces <strong>${existing.length}</strong> piece(s)
        ${starred ? ` (including <strong>${starred}</strong> starred)` : ''}.
        Source text is kept; only the cut changes.
      </p>
      ${renderChunkControls('rs', activeChunkSettings())}
      <p class="dim" id="rs-est" style="margin:0.5rem 0 0"></p>
      <div class="piece-actions" style="margin-top:1rem">
        <button type="button" class="btn primary" id="rs-go">Re-split now</button>
        <button type="button" class="btn ghost" id="rs-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  $('#rs-cancel', backdrop).onclick = close;
  const updateEst = () => {
    const opts = { ...readChunkFields('rs'), sourceName: doc.name };
    const n = estimatePieceCount(doc.text, opts);
    const el = $('#rs-est', backdrop);
    if (el) el.textContent = `About ${n} piece(s) with ${describeChunkOptions(opts)}`;
  };
  wireChunkControls('rs', updateEst);
  updateEst();
  $('#rs-go', backdrop).onclick = async () => {
    if (
      !confirm(
        `Replace all pieces from “${doc.name}”?${starred ? ` This clears ${starred} starred piece(s) from this source.` : ''}`
      )
    ) {
      return;
    }
    try {
      const opts = { ...readChunkFields('rs'), sourceName: doc.name };
      // delete old pieces only (keep document)
      for (const p of existing) {
        await deletePiece(p.id);
      }
      let chunks = chunkDocument(doc.text, opts);
      if (!chunks.length) {
        chunks = [
          {
            text: doc.text.trim(),
            preview: doc.text.slice(0, 320),
            labels: [],
            tags: [`src:${doc.name.slice(0, 40)}`],
            isLarge: doc.text.length >= 1200,
          },
        ];
      }
      const records = chunks.map((c) => ({
        documentId: doc.id,
        sourceName: doc.name,
        text: c.text,
        preview: c.preview,
        labels: c.labels || [],
        tags: c.tags || [],
        isLarge: c.isLarge,
        status: 'active',
      }));
      await putPiecesBulk(records);
      await putDocument({ ...doc, pieceCount: records.length, text: doc.text });
      await reload();
      close();
      toast(`Re-split into ${records.length} piece(s)`, 'ok');
      render();
    } catch (err) {
      toast(err.message || String(err), 'err');
    }
  };
}

// ── Settings ───────────────────────────────────────────────

function renderSettings(root, actions) {
  actions.innerHTML = '';
  const s = state.settings;
  root.innerHTML = `
    <div class="piece-card" style="max-width:40rem">
      <h3 style="font-family:var(--serif);margin:0 0 0.35rem">Appearance</h3>
      <div class="field">
        <label>Theme</label>
        <select id="s-theme">
          <option value="dark" ${s.theme !== 'light' ? 'selected' : ''}>Dark</option>
          <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option>
        </select>
      </div>
    </div>
    <div class="piece-card" style="max-width:40rem;margin-top:1rem">
      <h3 style="font-family:var(--serif);margin:0 0 0.35rem">Offline split (LLM-free)</h3>
      <p class="muted" style="margin:0 0 0.85rem">
        These controls decide how drafts become pieces <strong>without AI</strong>.
        Sentence → page grain, size, page breaks, and dialogue packing.
        You can also override per import on <strong>Start here</strong>.
      </p>
      ${renderChunkControls('s', s)}
      <label class="field check-row" style="margin-top:0.75rem">
        <input type="checkbox" id="s-ai-chunk" ${s.useAiChunk ? 'checked' : ''} />
        Also try AI-assisted chunking on import (optional; needs LLM URL below; falls back offline)
      </label>
    </div>
    <div class="piece-card" style="max-width:40rem;margin-top:1rem">
      <h3 style="font-family:var(--serif);margin:0 0 0.75rem">Labels</h3>
      <div class="field">
        <label>One label per line (your taxonomy)</label>
        <textarea id="s-labels" rows="8">${esc((s.labels || DEFAULT_LABELS).join('\n'))}</textarea>
      </div>
    </div>
    <div class="piece-card" style="max-width:40rem;margin-top:1rem">
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
    <div class="piece-card" style="max-width:40rem;margin-top:1rem">
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

  wireChunkControls('s');

  $('#s-save').onclick = async () => {
    const labels = $('#s-labels')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const chunk = readChunkFields('s');
    state.settings = await setSettings({
      theme: $('#s-theme').value,
      ...chunk,
      useAiChunk: $('#s-ai-chunk').checked,
      llmBaseUrl: $('#s-llm-url').value.trim(),
      llmModel: $('#s-llm-model').value.trim(),
      llmApiKey: $('#s-llm-key').value.trim(),
      labels: labels.length ? labels : DEFAULT_LABELS,
      supportGithubSponsors: $('#s-gh').value.trim(),
      supportKofi: $('#s-kofi').value.trim(),
    });
    state.importChunk = null;
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
