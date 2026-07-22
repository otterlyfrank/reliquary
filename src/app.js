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
  DEFAULT_LABELS,
} from './storage/db.js';
import { parseFile, isSupportedFile, SUPPORTED_EXTENSIONS } from './ingest/parse.js';
import { chunkDocument, buildAiChunkPrompt } from './chunk/engine.js';
import { chatCompletion, checkLlm, developPrompt, parseJsonArray } from './ai/client.js';
import {
  downloadText,
  pieceToMarkdown,
  collectionToMarkdown,
  formatDate,
} from './lib/export.js';

/** @type {any} */
let state = {
  view: 'excavate',
  settings: null,
  pieces: [],
  documents: [],
  collections: [],
  filter: 'active',
  label: '',
  q: '',
  selected: new Set(),
  busy: false,
};

let rootEl = null;

export async function mountApp(root) {
  rootEl = root;
  state.settings = await getSettings();
  applyTheme(state.settings.theme);
  await reload();
  render();
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
        <h1>Reliquary</h1>
        <p>Writing archaeology</p>
      </div>
      <button type="button" class="nav-btn ${state.view === 'excavate' ? 'active' : ''}" data-nav="excavate">Excavate</button>
      <button type="button" class="nav-btn ${state.view === 'pieces' && state.filter === 'active' ? 'active' : ''}" data-nav="pieces" data-filter="active">All pieces</button>
      <button type="button" class="nav-btn ${state.filter === 'starred' ? 'active' : ''}" data-nav="pieces" data-filter="starred">Starred</button>
      <button type="button" class="nav-btn ${state.filter === 'develop' ? 'active' : ''}" data-nav="pieces" data-filter="develop">Develop further</button>
      <button type="button" class="nav-btn ${state.filter === 'archive' ? 'active' : ''}" data-nav="pieces" data-filter="archive">Archive</button>
      <button type="button" class="nav-btn ${state.view === 'collections' ? 'active' : ''}" data-nav="collections">Collections</button>
      <button type="button" class="nav-btn ${state.view === 'sources' ? 'active' : ''}" data-nav="sources">Sources</button>
      <button type="button" class="nav-btn ${state.view === 'settings' ? 'active' : ''}" data-nav="settings">Settings</button>
      <div class="sidebar-foot">
        <p>Local-first · MIT</p>
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
  else if (state.view === 'collections') renderCollections(viewRoot, actions);
  else if (state.view === 'sources') renderSources(viewRoot, actions);
  else renderSettings(viewRoot, actions);
}

function viewTitle() {
  if (state.view === 'excavate') return 'Excavate';
  if (state.view === 'collections') return 'Collections';
  if (state.view === 'sources') return 'Sources';
  if (state.view === 'settings') return 'Settings';
  if (state.filter === 'starred') return 'Starred';
  if (state.filter === 'develop') return 'Develop further';
  if (state.filter === 'archive') return 'Archive';
  return 'Pieces';
}

function bindNav() {
  rootEl.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.view = btn.dataset.nav;
      if (btn.dataset.filter) state.filter = btn.dataset.filter;
      if (state.view === 'pieces' && !btn.dataset.filter) state.filter = 'active';
      state.selected = new Set();
      await reload();
      render();
    });
  });
}

// ── Excavate (import) ──────────────────────────────────────

function renderExcavate(root, actions) {
  actions.innerHTML = `
    <button type="button" class="btn" id="btn-folder">Import folder</button>
    <button type="button" class="btn primary" id="btn-files">Add files</button>
  `;
  root.innerHTML = `
    <div class="drop-zone" id="drop">
      <h3>Bring old drafts into the light</h3>
      <p class="muted">Drop .docx, .odt, .doc, .md, or .txt — or import a whole folder of unfinished work.</p>
      <p class="dim" style="margin-top:0.75rem">Supported: ${SUPPORTED_EXTENSIONS.join(' ')}</p>
      <div style="margin-top:1rem">
        <button type="button" class="btn primary" id="btn-files-2">Choose files</button>
      </div>
    </div>
    <div class="stats">
      <span>${state.documents.length} sources</span>
      <span id="piece-count">… pieces</span>
      <span>Chunk mode: <strong>${esc(state.settings.chunkMode)}</strong></span>
    </div>
    <p class="muted">After import, pieces land in <strong>All pieces</strong>. Star gold, send promising fragments to <strong>Develop further</strong>, file the rest.</p>
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
    input.accept = SUPPORTED_EXTENSIONS.join(',');
    input.onchange = () => ingestFiles([...input.files]);
    input.click();
  };
  $('#btn-files').onclick = pick;
  $('#btn-files-2').onclick = pick;
  $('#btn-folder').onclick = importFolder;

  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    const files = [...e.dataTransfer.files].filter(isSupportedFile);
    ingestFiles(files);
  });
}

async function importFolder() {
  try {
    if (window.showDirectoryPicker) {
      const dir = await window.showDirectoryPicker();
      const files = [];
      for await (const entry of walkDir(dir)) {
        if (entry.kind === 'file') {
          const f = await entry.getFile();
          if (isSupportedFile(f)) files.push(f);
        }
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
    ingestFiles(files);
  };
  input.click();
}

async function* walkDir(dirHandle) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') yield entry;
    else if (entry.kind === 'directory') {
      // shallow-ish: one level of nesting is enough for drafts folders
      try {
        for await (const sub of entry.values()) {
          if (sub.kind === 'file') yield sub;
        }
      } catch {
        /* ignore */
      }
    }
  }
}

async function ingestFiles(files) {
  if (!files?.length) {
    toast('No supported files found', 'err');
    return;
  }
  state.busy = true;
  let totalPieces = 0;
  let errors = 0;
  toast(`Importing ${files.length} file(s)…`);
  try {
    for (const file of files) {
      try {
        const parsed = await parseFile(file);
        if (!parsed.text || parsed.text.trim().length < 20) {
          errors++;
          continue;
        }
        const doc = await putDocument({
          name: parsed.name,
          kind: parsed.kind,
          text: parsed.text,
        });
        let chunks = chunkDocument(parsed.text, {
          mode: state.settings.chunkMode || 'balanced',
          sourceName: parsed.name,
        });

        // Optional AI chunk (only if enabled and LLM configured — expensive)
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
      } catch (err) {
        console.error(file.name, err);
        errors++;
        toast(`${file.name}: ${err.message}`, 'err');
      }
    }
    toast(
      `Excavated ${totalPieces} piece(s) from ${files.length} file(s)${errors ? ` · ${errors} issue(s)` : ''}`,
      'ok'
    );
    state.view = 'pieces';
    state.filter = 'active';
    await reload();
    render();
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
        : `<div class="empty"><h3>No pieces here</h3><p>Import drafts from Excavate to begin.</p></div>`
    }
    ${
      state.selected.size
        ? `<div class="multi-bar">
            <span>${state.selected.size} selected</span>
            <button type="button" class="btn" id="ms-star">Star</button>
            <button type="button" class="btn" id="ms-develop">Develop further</button>
            <button type="button" class="btn" id="ms-archive">Archive</button>
            <button type="button" class="btn primary" id="ms-ai">AI structure…</button>
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
        <button type="button" class="icon-btn" data-develop title="Develop">✎</button>
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
    : `<div class="empty"><h3>No sources imported</h3><p>Go to Excavate to dig.</p></div>`;
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
