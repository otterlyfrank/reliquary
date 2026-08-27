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
  deletePiecesByDocument,
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
  exportVault,
  importVault,
  collectionToStoryboard,
  STORYBOARD_MODES,
  DEFAULT_LABELS,
} from './storage/db.js';
import {
  parseFile,
  isSupportedFile,
  skipReason,
  SUPPORTED_EXTENSIONS,
  formatHelpLine,
} from './ingest/parse.js';
import {
  chunkDocument,
  isJunkPiece,
  buildAiChunkPrompt,
  resolveChunkOptions,
  describeChunkOptions,
  estimatePieceCount,
  CHUNK_UNITS,
  CHUNK_SIZE_PRESETS,
} from './chunk/engine.js';
import {
  chatFromSettings,
  checkLlm,
  developPrompt,
  parseJsonArray,
  llmEnabled,
  inferProvider,
  listLlmModels,
  getProxyStatus,
  ollamaSizeWarning,
  pickOllamaDefault,
  LLM_PROVIDERS,
  XAI_MODELS,
  XAI_DEFAULT_MODEL,
  OLLAMA_DEFAULT_HOST,
} from './ai/client.js';
import {
  downloadText,
  downloadJson,
  pieceToMarkdown,
  collectionToMarkdown,
  storyboardToMarkdown,
  formatDate,
} from './lib/export.js';
import { installUiHtml, wireInstallButtons, paintAppVersion } from './pwa.js';
import { yieldToMain } from './lib/yield.js';

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
  /** Piece list page (0-based) */
  piecePage: 0,
  /** Last import summary for excavation ribbon */
  lastExcavation: null,
  /** Mobile / drawer sidebar open */
  sidebarOpen: false,
};

const PIECES_PER_PAGE = 48;
const SESSION_KEY = 'reliquary:session';

let rootEl = null;
let shellBuilt = false;

function persistSession() {
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        view: state.view,
        filter: state.filter,
        q: state.q,
        label: state.label,
        cardDensity: state.cardDensity,
        sbDense: state.sbDense,
      })
    );
  } catch {
    /* private mode */
  }
}

function restoreSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!s || typeof s !== 'object') return;
    if (s.view) state.view = s.view;
    if (s.filter) state.filter = s.filter;
    if (typeof s.q === 'string') state.q = s.q;
    if (typeof s.label === 'string') state.label = s.label;
    if (s.cardDensity) state.cardDensity = s.cardDensity;
    if (typeof s.sbDense === 'boolean') state.sbDense = s.sbDense;
  } catch {
    /* ignore */
  }
}

export async function mountApp(root) {
  rootEl = root;
  try {
    restoreSession();
    state.settings = await getSettings();
    applyTheme(state.settings.theme);
    await reload();
    render();
    wireGlobalKeys();
    window.addEventListener('reliquary-pwa-change', () => {
      if (rootEl) render();
    });
  } catch (err) {
    console.error('[Reliquary] mount failed', err);
    throw err;
  }
}

function openHelp() {
  if ($('#reliquary-help')) return;
  const host = document.createElement('div');
  host.id = 'reliquary-help';
  host.className = 'modal-backdrop';
  host.innerHTML = `
    <div class="modal" role="dialog" aria-labelledby="rq-help-title">
      <h2 id="rq-help-title">Shortcuts</h2>
      <p class="muted">The vault stays on this computer. Nothing is uploaded unless you turn AI on.</p>
      <table class="help-table">
        <tr><td><kbd>⌘</kbd><kbd>K</kbd></td><td>Command palette</td></tr>
        <tr><td><kbd>/</kbd></td><td>Search pieces</td></tr>
        <tr><td><kbd>?</kbd></td><td>This help</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Close drawers and dialogs</td></tr>
        <tr><td>⌥↑ / ⌥↓</td><td>Reorder a storyboard item</td></tr>
      </table>
      <div class="modal-actions"><button type="button" class="btn primary" id="rq-help-close">Close</button></div>
    </div>`;
  document.body.appendChild(host);
  const close = () => host.remove();
  host.addEventListener('click', (e) => {
    if (e.target === host) close();
  });
  $('#rq-help-close', host).onclick = close;
}

function wireGlobalKeys() {
  if (wireGlobalKeys._bound) return;
  wireGlobalKeys._bound = true;
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
    if (e.key === '/' && !inField) {
      e.preventDefault();
      const search = $('#q');
      if (search) {
        search.focus();
        search.select?.();
      } else {
        state.view = 'pieces';
        persistSession();
        render();
        requestAnimationFrame(() => $('#q')?.focus());
      }
      return;
    }
    if (e.key === '?' && !inField) {
      e.preventDefault();
      if ($('#reliquary-help')) $('#reliquary-help').remove();
      else openHelp();
      return;
    }
    if (e.key === 'Escape' && $('#reliquary-help')) {
      $('#reliquary-help').remove();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    // Storyboard keyboard reorder: Alt+↑ / Alt+↓ when focus is on an item
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (e.altKey || e.metaKey)) {
      const item = e.target?.closest?.('.sb-item');
      if (item && state.view === 'storyboards' && state.activeStoryboardId) {
        e.preventDefault();
        const btn = item.querySelector(e.key === 'ArrowUp' ? '[data-up]' : '[data-down]');
        btn?.click();
      }
    }
  });
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
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-relevant', 'additions');
    document.body.appendChild(host);
  }
  host.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.textContent = msg;
  host.appendChild(el);
  const reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => {
    if (!reduced) {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
    }
    setTimeout(() => el.remove(), reduced ? 0 : 300);
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

function navBtn(view, label, filter = null) {
  let active = false;
  if (view === 'pieces' && filter) {
    active = state.view === 'pieces' && state.filter === filter;
  } else if (view === 'pieces') {
    active = state.view === 'pieces' && ['active', 'all'].includes(state.filter);
  } else {
    active = state.view === view;
  }
  const f = filter ? ` data-filter="${filter}"` : '';
  const cur = active ? ' aria-current="page"' : '';
  return `<button type="button" class="nav-btn ${active ? 'active' : ''}" data-nav="${view}"${f}${cur}>${label}</button>`;
}

function buildShell() {
  rootEl.innerHTML = `
    <a class="skip-link" href="#view-root">Skip to content</a>
    <div class="sidebar-backdrop" id="sidebar-backdrop" hidden></div>
    <aside class="sidebar ${state.sidebarOpen ? 'open' : ''}" id="sidebar" aria-label="Sidebar">
      <div class="brand">
        <img class="brand-mark" src="./public/reliquary-mark.png" alt="Reliquary — otter vault" width="48" height="48" />
        <div>
          <h1>Reliquary</h1>
          <p>Your draft vault</p>
        </div>
      </div>
      ${navBtn('excavate', state.documents?.length ? 'Import' : 'Start here')}
      ${navBtn('pieces', 'My pieces', 'active')}
      ${navBtn('storyboards', 'Storyboards')}
      ${navBtn('sources', 'Imported files')}
      <details class="nav-more ${['collections', 'settings'].includes(state.view) || ['starred', 'develop', 'archive'].includes(state.filter) ? 'open' : ''}">
        <summary class="nav-more-sum">More</summary>
        ${navBtn('pieces', 'Starred', 'starred')}
        ${navBtn('pieces', 'Work on later', 'develop')}
        ${navBtn('pieces', 'Archive', 'archive')}
        ${navBtn('collections', 'Collections')}
        ${navBtn('settings', 'Settings')}
      </details>
      <div class="sidebar-foot">
        <p>Stays on your computer · free</p>
        <p class="dim" data-app-version style="margin:0.2rem 0 0;font-size:0.78rem"></p>
        <div class="pwa-side-slot">${installUiHtml('compact')}</div>
        <p><a href="#support" data-nav="settings">Support Reliquary</a></p>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button type="button" class="btn ghost menu-toggle" id="menu-toggle" aria-label="Open menu" aria-controls="sidebar" aria-expanded="false">☰</button>
        <h2 id="view-title">${esc(viewTitle())}</h2>
        <div class="topbar-actions" id="top-actions"></div>
      </header>
      <div class="content" id="view-root" tabindex="-1"></div>
    </div>
    <nav class="mobile-nav" aria-label="Primary">
      <button type="button" class="mobile-nav-btn ${state.view === 'excavate' ? 'active' : ''}" data-nav="excavate" ${state.view === 'excavate' ? 'aria-current="page"' : ''}><span aria-hidden="true">⌂</span>Start</button>
      <button type="button" class="mobile-nav-btn ${state.view === 'pieces' ? 'active' : ''}" data-nav="pieces" data-filter="active" ${state.view === 'pieces' ? 'aria-current="page"' : ''}><span aria-hidden="true">▤</span>Pieces</button>
      <button type="button" class="mobile-nav-btn ${state.view === 'storyboards' ? 'active' : ''}" data-nav="storyboards" ${state.view === 'storyboards' ? 'aria-current="page"' : ''}><span aria-hidden="true">◎</span>Boards</button>
      <button type="button" class="mobile-nav-btn ${state.view === 'settings' ? 'active' : ''}" data-nav="settings" ${state.view === 'settings' ? 'aria-current="page"' : ''}><span aria-hidden="true">⚙</span>More</button>
    </nav>
  `;
  shellBuilt = true;
  bindNav();
  wireShellChrome();
}

function wireShellChrome() {
  const setSidebar = (open) => {
    state.sidebarOpen = open;
    const sb = $('#sidebar');
    const bd = $('#sidebar-backdrop');
    const toggleBtn = $('#menu-toggle');
    sb?.classList.toggle('open', open);
    if (bd) bd.hidden = !open;
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  };
  $('#menu-toggle')?.addEventListener('click', () => setSidebar(!state.sidebarOpen));
  $('#sidebar-backdrop')?.addEventListener('click', () => setSidebar(false));
  // Escape closes mobile drawer (once per session — shell rebuild reuses same listener)
  if (!wireShellChrome._escBound) {
    wireShellChrome._escBound = true;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.sidebarOpen) {
        state.sidebarOpen = false;
        $('#sidebar')?.classList.remove('open');
        const bd = $('#sidebar-backdrop');
        if (bd) bd.hidden = true;
        const toggleBtn = $('#menu-toggle');
        if (toggleBtn) {
          toggleBtn.setAttribute('aria-label', 'Open menu');
          toggleBtn.setAttribute('aria-expanded', 'false');
        }
      }
    });
  }
}

function updateShellChrome() {
  const title = $('#view-title');
  if (title) title.textContent = viewTitle();
  rootEl.querySelectorAll('[data-nav]').forEach((btn) => {
    const view = btn.dataset.nav;
    const filter = btn.dataset.filter;
    let active = false;
    if (view === 'pieces' && filter) {
      active = state.view === 'pieces' && state.filter === filter;
    } else if (view === 'pieces') {
      active = state.view === 'pieces' && !['starred', 'develop', 'archive'].includes(state.filter);
    } else {
      active = state.view === view;
    }
    // mobile "More" highlights settings OR collections
    if (btn.classList.contains('mobile-nav-btn') && view === 'settings') {
      active = ['settings', 'collections', 'sources'].includes(state.view);
    }
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  const sb = $('#sidebar');
  sb?.classList.toggle('open', state.sidebarOpen);
  const bd = $('#sidebar-backdrop');
  if (bd) bd.hidden = !state.sidebarOpen;
  const pwa = $('.pwa-side-slot');
  if (pwa) pwa.innerHTML = installUiHtml('compact');
  paintAppVersion();
}

function render(opts = {}) {
  if (!rootEl) return;
  if (!shellBuilt || opts.forceShell) {
    buildShell();
  } else {
    updateShellChrome();
  }
  const viewRoot = $('#view-root');
  const actions = $('#top-actions');
  if (!viewRoot || !actions) {
    buildShell();
    return render({ forceShell: true });
  }
  actions.innerHTML = '';
  viewRoot.innerHTML = '';
  if (state.view === 'excavate') renderExcavate(viewRoot, actions);
  else if (state.view === 'pieces') renderPieces(viewRoot, actions);
  else if (state.view === 'storyboards') renderStoryboards(viewRoot, actions);
  else if (state.view === 'collections') renderCollections(viewRoot, actions);
  else if (state.view === 'sources') renderSources(viewRoot, actions);
  else renderSettings(viewRoot, actions);
  wireInstallButtons(rootEl);
}

function viewTitle() {
  if (state.view === 'excavate') return state.documents?.length ? 'Import' : 'Start here';
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
      state.sidebarOpen = false;
      state.piecePage = 0;
      persistSession();
      await reload();
      render();
    });
  });
}

function excavationRibbonHtml() {
  const r = state.lastExcavation;
  if (!r) return '';
  return `<div class="excavate-ribbon" role="status">
    <div>
      <strong>Unearthed ${r.pieces} piece${r.pieces === 1 ? '' : 's'}</strong>
      <span class="dim"> · ${r.files} file${r.files === 1 ? '' : 's'}${
        r.skipped ? ` · ${r.skipped} skipped` : ''
      }${r.note ? ` · ${r.note}` : ''}</span>
    </div>
    <button type="button" class="btn ghost" id="ribbon-dismiss" aria-label="Dismiss">Dismiss</button>
  </div>`;
}

// ── Excavate (import) ──────────────────────────────────────

function renderExcavate(root, actions) {
  const isFirstRun = !state.documents.length;
  actions.innerHTML = `
    <button type="button" class="btn primary" id="btn-folder">Whole folder</button>
    <button type="button" class="btn" id="btn-files">Choose files</button>
    ${isFirstRun ? `<button type="button" class="btn" id="btn-sample">Try a sample</button>` : ''}
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
                <li><strong>Open your drafts folder</strong> — one click, or drop the folder on the box</li>
                <li>We split them into small <strong>pieces</strong> you can actually read</li>
                <li>Star the gold · stack keepers on a <strong>Storyboard</strong></li>
              </ol>
              <p class="dim" style="margin:0.75rem 0 0">Nervous? Hit <strong>Try a sample</strong> first — no real drafts required.</p>
            </div>
          </div>`
        : ''
    }
    <div class="drop-zone" id="drop">
      <h3>${isFirstRun ? 'Drop your drafts folder here' : 'Bring more drafts in'}</h3>
      <p class="muted">Drop the whole folder (nested Word docs are fine), or use <strong>Whole folder</strong>. Everything stays on this computer.</p>
      <p class="dim" style="margin-top:0.75rem">${esc(formatHelpLine())}</p>
      <div style="margin-top:1rem; display:flex; gap:0.5rem; justify-content:center; flex-wrap:wrap">
        <button type="button" class="btn primary" id="btn-folder-2">Whole folder</button>
        <button type="button" class="btn" id="btn-files-2">Choose files</button>
        ${isFirstRun ? `<button type="button" class="btn" id="btn-sample-2">Try a sample</button>` : ''}
      </div>
    </div>
    <div class="import-tips">
      <h4>Quick tips</h4>
      <ul>
        <li><strong>Whole folder:</strong> pick the folder where all the drafts live. Subfolders are included (up to a few levels).</li>
        <li><strong>Word:</strong> .docx is best. Old .doc works roughly — “Save As → .docx” if text looks weird.</li>
        <li><strong>PDF:</strong> text PDFs import. Photo-scans of pages still need a Word/text export.</li>
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
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    try {
      const files = await filesFromDataTransfer(e.dataTransfer);
      if (!files.length) {
        toast('No Word / text / Markdown / HTML / PDF-text drafts in that drop. Try Whole folder.', 'err');
        return;
      }
      await ingestFiles(files, { skippedBag: files.skippedBag });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      toast(err.message || 'Could not read that folder', 'err');
    }
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

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '__macosx',
  '.trash',
  '.ds_store',
  'library',
]);

const FOLDER_MAX_DEPTH = 8;

function tagReliquaryPath(file, relPath) {
  const path = String(relPath || file.webkitRelativePath || file.name || '').replace(/\\/g, '/');
  try {
    Object.defineProperty(file, 'reliquaryPath', { value: path, enumerable: true });
  } catch {
    file.reliquaryPath = path;
  }
  return file;
}

function emptySkipBag() {
  return { pdf: 0, pages: 0, image: 0, junk: 0, archive: 0, other: 0 };
}

function noteSkip(bag, why) {
  if (!bag) return;
  const key = bag[why] != null ? why : 'other';
  bag[key] += 1;
}

function skipBagNote(bag) {
  if (!bag) return '';
  const bits = [];
  if (bag.pdf) bits.push(`${bag.pdf} PDF scan/other`);
  if (bag.pages) bits.push(`${bag.pages} Pages`);
  if (bag.image) bits.push(`${bag.image} image`);
  if (bag.archive) bits.push(`${bag.archive} archive`);
  if (bag.junk) bits.push(`${bag.junk} junk`);
  if (bag.other) bits.push(`${bag.other} other`);
  return bits.join(', ');
}

function considerWalkedFile(file, rel, files, bag) {
  const tagged = tagReliquaryPath(file, rel);
  const why = skipReason(tagged);
  if (why) {
    noteSkip(bag, why);
    return;
  }
  if (isSupportedFile(tagged)) files.push(tagged);
  else noteSkip(bag, 'other');
}

function shouldSkipDir(name) {
  const n = String(name || '').toLowerCase();
  return !n || n.startsWith('.') || SKIP_DIR_NAMES.has(n);
}

async function confirmLargeImport(files) {
  if (files.length < 200) return true;
  return window.confirm(
    `Found ${files.length} drafts in that folder. Import all of them? Everything stays on this computer.`
  );
}

async function importFolder() {
  try {
    if (window.showDirectoryPicker) {
      const dir = await window.showDirectoryPicker();
      toast('Looking through the folder…');
      const bag = emptySkipBag();
      const files = await filesFromDirHandle(dir, '', 0, bag);
      if (!files.length) {
        toast(
          bag && skipBagNote(bag)
            ? `No importable drafts. Skipped: ${skipBagNote(bag)}.`
            : 'No Word / text / Markdown / HTML / PDF-text drafts in that folder',
          'err'
        );
        return;
      }
      if (!(await confirmLargeImport(files))) return;
      await ingestFiles(files, { skippedBag: bag });
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.warn(err);
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.webkitdirectory = true;
  input.onchange = async () => {
    const bag = emptySkipBag();
    const files = [];
    for (const f of input.files) {
      if (String(f.webkitRelativePath || '').split('/').some(shouldSkipDir)) continue;
      considerWalkedFile(f, f.webkitRelativePath || f.name, files, bag);
    }
    if (!files.length) {
      toast('No importable drafts in that folder', 'err');
      return;
    }
    if (!(await confirmLargeImport(files))) return;
    ingestFiles(files, { skippedBag: bag });
  };
  input.click();
}

async function filesFromDirHandle(dirHandle, prefix = '', depth = 0, bag = null) {
  const files = [];
  for await (const [name, entry] of dirHandle.entries()) {
    if (shouldSkipDir(name) && entry.kind === 'directory') continue;
    if (name.startsWith('.')) continue;
    try {
      if (entry.kind === 'file') {
        const f = await entry.getFile();
        const rel = prefix ? `${prefix}/${name}` : name;
        considerWalkedFile(f, rel, files, bag);
      } else if (entry.kind === 'directory' && depth < FOLDER_MAX_DEPTH) {
        const next = prefix ? `${prefix}/${name}` : name;
        files.push(...(await filesFromDirHandle(entry, next, depth + 1, bag)));
      }
    } catch {
      /* locked / permission */
    }
  }
  return files;
}

function readAllDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const pump = () => {
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        pump();
      }, reject);
    };
    pump();
  });
}

async function collectDroppedEntry(entry, out, prefix, depth, bag) {
  if (!entry || depth > FOLDER_MAX_DEPTH) return;
  const name = entry.name || '';
  if (name.startsWith('.')) return;
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    const rel = prefix ? `${prefix}/${file.name}` : file.name;
    considerWalkedFile(file, rel, out, bag);
    return;
  }
  if (entry.isDirectory) {
    if (shouldSkipDir(name)) return;
    const next = prefix ? `${prefix}/${name}` : name;
    const children = await readAllDirectoryEntries(entry.createReader());
    for (const child of children) {
      await collectDroppedEntry(child, out, next, depth + 1, bag);
    }
  }
}

async function filesFromDataTransfer(dt) {
  const bag = emptySkipBag();
  const items = [...(dt.items || [])];
  const walked = [];
  let usedEntries = false;
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (!entry) continue;
    usedEntries = true;
    await collectDroppedEntry(entry, walked, '', 0, bag);
  }
  if (usedEntries) {
    walked.skippedBag = bag;
    return walked;
  }
  const files = [...(dt.files || [])].filter((f) => {
    const why = skipReason(tagReliquaryPath(f, f.webkitRelativePath || f.name));
    if (why) {
      noteSkip(bag, why);
      return false;
    }
    return isSupportedFile(f);
  }).map((f) => tagReliquaryPath(f, f.webkitRelativePath || f.name));
  files.skippedBag = bag;
  return files;
}

async function splitTextToChunks(text, sourceName, onWindow) {
  const chunkOpts = {
    ...activeChunkSettings(),
    sourceName,
  };
  let chunks = chunkDocument(text, chunkOpts);
  if (state.settings.useAiChunk && llmEnabled(state.settings)) {
    try {
      const windows = windowTextForAi(text, 8000);
      const gathered = [];
      const provider = inferProvider(state.settings);
      for (let w = 0; w < windows.length; w++) {
        onWindow?.(w, windows.length, provider);
        const { content } = await chatFromSettings(state.settings, {
          temperature: 0.15,
          messages: [
            {
              role: 'system',
              content:
                'You only split. Never classify a whole document as one card. JSON array of fragments only. Rip dialogue out of narration. Separate unrelated ideas.',
            },
            {
              role: 'user',
              content: buildAiChunkPrompt(windows[w], chunkOpts),
            },
          ],
        });
        const arr = parseJsonArray(content);
        for (const c of arr) {
          const piece = String(c.text || '').trim();
          if (piece.length < 8) continue;
          gathered.push({
            text: piece,
            labels: Array.isArray(c.labels) ? c.labels.map(String) : [],
            isLarge: piece.length >= 1200,
            tags: [`src:${String(sourceName).slice(0, 40)}`],
            preview: piece.slice(0, 320),
          });
        }
      }
      if (gathered.length >= 2) chunks = gathered;
    } catch (e) {
      console.warn('AI chunk failed, using structural', e);
    }
  }
  if (!chunks.length) {
    chunks = [
      {
        text: String(text || '').trim(),
        preview: String(text || '').slice(0, 320),
        labels: [],
        tags: [`src:${String(sourceName).slice(0, 40)}`],
        isLarge: String(text || '').length >= 1200,
      },
    ];
  }
  const usable = chunks.filter((c) => c.text && !isJunkPiece(c.text));
  return usable.length ? usable : chunks;
}

function windowTextForAi(text, maxChars) {
  const t = String(text || '');
  if (t.length <= maxChars) return [t];
  const paras = t.split(/\n{2,}/);
  const windows = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxChars) {
      windows.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) windows.push(cur);
  return windows.length ? windows : [t.slice(0, maxChars)];
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

async function ingestFiles(files, meta = {}) {
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
  let duplicates = 0;
  const problems = [];
  const warnings = [];
  const existing = await listDocuments();
  const seen = new Set(existing.map((d) => `${d.name}|${d.charCount}`));
  toast(`Importing ${files.length} file(s)…`);
  setImportProgress(`Starting… 0 / ${files.length}`, 0);
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const label = file.reliquaryPath || file.name;
      setImportProgress(`Reading “${label}”… (${i + 1} / ${files.length})`, ((i + 0.3) / files.length) * 100);
      try {
        const parsed = await parseFile(file);
        if (parsed.warnings?.length) warnings.push(...parsed.warnings.map((w) => `${label}: ${w}`));
        if (!parsed.text || parsed.text.trim().length < 12) {
          problems.push(`${label}: almost no text found`);
          continue;
        }
        const dupKey = `${parsed.name}|${parsed.text.length}`;
        if (seen.has(dupKey)) {
          duplicates += 1;
          continue;
        }
        seen.add(dupKey);
        setImportProgress(`Splitting “${label}”…`, ((i + 0.6) / files.length) * 100);
        const doc = await putDocument({
          name: parsed.name,
          kind: parsed.kind,
          text: parsed.text,
        });
        const chunks = await splitTextToChunks(parsed.text, parsed.name, (w, n, provider) => {
          const where = provider === 'xai' ? 'xAI' : provider === 'ollama' ? 'Ollama' : 'LLM';
          setImportProgress(
            `${where} splitting “${label}” (${w + 1}/${n})…`,
            ((i + 0.6) / files.length) * 100
          );
        });

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
      // Keep the shell responsive during multi-file digs
      await yieldToMain();
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

    const skipNote = skipBagNote(meta.skippedBag);
    const extraSkip = (problems.length || 0) + duplicates;
    state.lastExcavation = {
      pieces: totalPieces,
      files: okFiles,
      skipped: extraSkip + Object.values(meta.skippedBag || {}).reduce((a, n) => a + (Number(n) || 0), 0),
      note: [
        duplicates ? `${duplicates} already in vault` : '',
        problems.length ? `${problems.length} failed` : '',
        skipNote,
      ]
        .filter(Boolean)
        .join(' · '),
      at: Date.now(),
    };
    toast(
      `Imported ${okFiles} file(s) → ${totalPieces} piece(s)${
        state.lastExcavation.note ? ` · ${state.lastExcavation.note}` : ''
      }`,
      'ok'
    );
    state.view = 'pieces';
    state.filter = 'active';
    state.piecePage = 0;
    persistSession();
    await reload();
    render();
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
  const total = state.pieces.length;
  const pages = Math.max(1, Math.ceil(total / PIECES_PER_PAGE));
  if (state.piecePage >= pages) state.piecePage = Math.max(0, pages - 1);
  const pagePieces = state.pieces.slice(
    state.piecePage * PIECES_PER_PAGE,
    state.piecePage * PIECES_PER_PAGE + PIECES_PER_PAGE
  );
  const shelf = (id, label) =>
    `<button type="button" class="chip ${state.filter === id ? 'active' : ''}" data-shelf="${id}">${label}</button>`;

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
    persistSession();
    render();
  };
  $('#btn-select-all').onclick = () => {
    if (state.selected.size === pagePieces.length) state.selected = new Set();
    else state.selected = new Set(pagePieces.map((p) => p.id));
    render();
  };

  root.innerHTML = `
    ${excavationRibbonHtml()}
    <div class="chip-row shelf-row">
      ${shelf('active', 'Active')}
      ${shelf('starred', 'Starred')}
      ${shelf('develop', 'Work on later')}
      ${shelf('archive', 'Archive')}
      ${shelf('all', 'All')}
    </div>
    <div class="filter-row">
      <input class="search" id="q" placeholder="Search pieces…" value="${esc(state.q)}" aria-label="Search pieces" />
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
      <span>${total} shown${total > PIECES_PER_PAGE ? ` · page ${state.piecePage + 1}/${pages}` : ''}</span>
      <span>${state.selected.size} selected</span>
      <span class="dim">${dense ? 'compact' : 'comfortable'}</span>
    </div>
    ${
      pagePieces.length
        ? `<div class="card-grid ${dense ? 'compact' : ''}" id="grid">
            ${pagePieces.map((p) => renderCard(p, dense)).join('')}
          </div>
          ${
            pages > 1
              ? `<div class="pager">
                  <button type="button" class="btn" id="piece-prev" ${state.piecePage <= 0 ? 'disabled' : ''}>Previous</button>
                  <span class="dim">Page ${state.piecePage + 1} of ${pages}</span>
                  <button type="button" class="btn" id="piece-next" ${state.piecePage >= pages - 1 ? 'disabled' : ''}>Next</button>
                </div>`
              : ''
          }`
        : `<div class="empty">
            <img class="empty-art" src="./public/reliquary-mark.png" alt="" />
            <h3>${state.q || state.label ? 'No pieces match' : 'Nothing on this shelf'}</h3>
            <p>${
              state.q || state.label
                ? 'Clear search or labels, or import another draft.'
                : 'Bring in a whole drafts folder — we’ll split the files into pieces you can actually read.'
            }</p>
            <p><button type="button" class="btn primary" id="empty-import">Import drafts</button>
            ${state.q || state.label ? '<button type="button" class="btn" id="empty-clear">Clear filters</button>' : ''}</p>
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

  $('#ribbon-dismiss')?.addEventListener('click', () => {
    state.lastExcavation = null;
    render();
  });
  $('#empty-import')?.addEventListener('click', () => {
    state.view = 'excavate';
    persistSession();
    render();
    requestAnimationFrame(() => importFolder());
  });
  $('#empty-clear')?.addEventListener('click', async () => {
    state.q = '';
    state.label = '';
    persistSession();
    await reload();
    render();
  });
  root.querySelectorAll('[data-shelf]').forEach((btn) => {
    btn.onclick = async () => {
      state.filter = btn.dataset.shelf;
      state.piecePage = 0;
      state.selected = new Set();
      persistSession();
      await reload();
      render();
    };
  });
  $('#piece-prev')?.addEventListener('click', () => {
    state.piecePage = Math.max(0, state.piecePage - 1);
    render();
  });
  $('#piece-next')?.addEventListener('click', () => {
    state.piecePage = state.piecePage + 1;
    render();
  });
  $('#q').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      state.q = e.target.value.trim();
      state.piecePage = 0;
      persistSession();
      await reload();
      render();
    }
  });
  root.querySelectorAll('[data-label]').forEach((btn) => {
    btn.onclick = async () => {
      state.label = btn.dataset.label || '';
      persistSession();
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
        <button type="button" class="icon-btn ${p.starred ? 'on' : ''}" data-star title="Star" aria-label="Star">★</button>
        <button type="button" class="icon-btn ${p.pinned ? 'on' : ''}" data-pin title="Pin" aria-label="Pin">📌</button>
        <button type="button" class="icon-btn" data-energy title="Energy" aria-label="Energy ${energy}">${energy}</button>
        <button type="button" class="icon-btn" data-open title="Read" aria-label="Read piece">Read</button>
        <button type="button" class="icon-btn" data-board title="Add to storyboard" aria-label="Add to storyboard">Board</button>
        <button type="button" class="icon-btn" data-develop title="Work on later" aria-label="Work on later">✎</button>
        <button type="button" class="icon-btn" data-archive title="Archive" aria-label="Archive">Archive</button>
        <button type="button" class="icon-btn" data-export title="Export" aria-label="Export Markdown">↓</button>
        <button type="button" class="icon-btn danger" data-del title="Delete" aria-label="Delete">✕</button>
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
    if (!bindReading._esc) {
      bindReading._esc = true;
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && backdrop.isConnected) close();
      });
    }
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
  if (!llmEnabled(state.settings)) {
    toast('Turn on Ollama or xAI in Settings first', 'err');
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
      <p class="muted">${pieces.length} piece(s) · preserves your wording; suggests structure only${
        inferProvider(state.settings) === 'xai'
          ? ' · <strong>these fragments will be sent to xAI</strong>'
          : inferProvider(state.settings) === 'ollama'
            ? ' · Ollama on this machine'
            : ''
      }</p>
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
      const { content } = await chatFromSettings(state.settings, {
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
      <button type="button" class="icon-btn" data-up title="Move up (Alt+↑)" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="icon-btn" data-down title="Move down (Alt+↓)" aria-label="Move down" ${idx >= total - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="icon-btn danger" data-remove title="Remove" aria-label="Remove from board">✕</button>
    </div>`;
  if (item.kind === 'heading') {
    return `
      <div class="sb-item sb-heading ${dense ? 'dense' : ''}" draggable="true" data-item-id="${item.id}" data-kind="heading" tabindex="0">
        ${rail}
        <div class="sb-item-body">
          <span class="sb-kind-pill">Section</span>
          <input class="sb-heading-input" data-item-text value="${esc(item.text || '')}" />
        </div>
      </div>`;
  }
  if (item.kind === 'note') {
    return `
      <div class="sb-item sb-note ${dense ? 'dense' : ''}" draggable="true" data-item-id="${item.id}" data-kind="note" tabindex="0">
        ${rail}
        <div class="sb-item-body">
          <span class="sb-kind-pill">Note</span>
          <textarea data-item-text rows="${dense ? 1 : 2}">${esc(item.text || '')}</textarea>
        </div>
      </div>`;
  }
  return `
    <div class="sb-item sb-piece ${dense ? 'dense' : ''}" draggable="true" data-item-id="${item.id}" data-kind="piece" tabindex="0">
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
  const memberCount = (c) => {
    const explicit = new Set(c.pieceIds || []);
    for (const p of state.pieces) {
      if ((p.collectionIds || []).includes(c.id) || (p.tags || []).includes(c.name)) {
        explicit.add(p.id);
      }
    }
    // Also count pieces not in current filter - use full list when available
    return explicit.size;
  };
  root.innerHTML = state.collections.length
    ? `<div class="card-grid">
        ${state.collections
          .map(
            (c) => `
          <article class="piece-card">
            <h3 style="font-family:var(--serif);margin:0">${esc(c.name)}</h3>
            <p class="muted" style="margin:0">${esc(c.description || '—')} · ${memberCount(c)} linked in current view</p>
            <div class="piece-actions">
              <button type="button" class="btn primary" data-to-board="${c.id}" title="Copy pieces into a new storyboard">→ Storyboard</button>
              <button type="button" class="btn" data-export-col="${c.id}">Export MD</button>
              <button type="button" class="btn danger" data-del-col="${c.id}">Delete</button>
            </div>
          </article>`
          )
          .join('')}
      </div>
      <p class="muted" style="margin-top:1rem">
        Collections are legacy shelves. Prefer <strong>Storyboards</strong> for outlining and drafting.
        Use <strong>→ Storyboard</strong> to migrate a collection’s pieces into a board (collection stays until you delete it).
      </p>`
    : `<div class="empty">
        <h3>No collections</h3>
        <p class="muted">Storyboards are the main way to stack keepers. Collections remain for older vaults — create one only if you need a simple named shelf.</p>
        <p style="margin-top:1rem"><button type="button" class="btn" id="go-boards">Open Storyboards</button></p>
      </div>`;

  $('#go-boards')?.addEventListener('click', () => {
    state.view = 'storyboards';
    render();
  });

  root.querySelectorAll('[data-to-board]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        const board = await collectionToStoryboard(btn.dataset.toBoard);
        await reload();
        state.view = 'storyboards';
        state.activeStoryboardId = board.id;
        const n = (board.items || []).filter((i) => i.kind === 'piece').length;
        toast(
          n
            ? `Migrated ${n} piece(s) → “${board.name}”`
            : `Created empty board “${board.name}” (no linked pieces found)`,
          n ? 'ok' : ''
        );
        render();
      } catch (err) {
        toast(err.message || String(err), 'err');
      }
    };
  });
  root.querySelectorAll('[data-export-col]').forEach((btn) => {
    btn.onclick = async () => {
      const col = state.collections.find((c) => c.id === btn.dataset.exportCol);
      const pieces = await listPieces({ collectionId: col.id });
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
  const sizePreset = $(`#${prefix}-size`)?.value || 'fine';
  const pageWords = Number($(`#${prefix}-page-words`)?.value) || 120;
  const minChars = Number($(`#${prefix}-min`)?.value) || 12;
  const maxChars = Number($(`#${prefix}-max`)?.value) || 420;
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
        Keep dialogue glued to surrounding narration (off = rip speech onto its own cards)
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
        Reliquary cuts each file into <strong>fragments you can reorder</strong> — not one card per document.
        Dialogue is ripped out; idea-dumps are separated. Offline by default.
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
  actions.innerHTML = state.documents.length
    ? `<button type="button" class="btn primary" id="resplit-all">Re-split all sources…</button>`
    : '';
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
        <strong>Re-split</strong> recuts stored text with current fragment settings (fine hybrid, dialogue ripped out).
        Use this on files you already imported as one blob. Re-split starts clean (starred cards from that source go too).
      </p>`
    : `<div class="empty">
        <h3>No files imported yet</h3>
        <p>Bring in a draft — Word, text, or Markdown.</p>
        <p><button type="button" class="btn primary" id="src-import">Import drafts</button></p>
      </div>`;
  $('#src-import')?.addEventListener('click', () => {
    state.view = 'excavate';
    persistSession();
    render();
  });
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
  $('#resplit-all')?.addEventListener('click', () => resplitAllSources());
}

async function resplitAllSources() {
  if (state.busy) {
    toast('Already working…', 'err');
    return;
  }
  const docs = (state.documents || []).filter((d) => d.text && String(d.text).trim().length >= 12);
  const skipped = (state.documents || []).length - docs.length;
  if (!docs.length) {
    toast('No stored source text — re-import files to re-split', 'err');
    return;
  }
  const aiOn = !!(state.settings.useAiChunk && llmEnabled(state.settings));
  const ok = confirm(
    `Re-split ${docs.length} source(s) into fragments with current settings?\n\nExisting cards (including starred) from those sources will be replaced.${
      skipped ? ` ${skipped} source(s) have no stored text and will be skipped.` : ''
    }${aiOn ? '\n\nAI assist is on — each source will be sent to your configured LLM.' : ''}`
  );
  if (!ok) return;
  state.busy = true;
  let total = 0;
  let failed = 0;
  try {
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      toast(`Re-splitting “${doc.name}” (${i + 1}/${docs.length})…`);
      try {
        await deletePiecesByDocument(doc.id);
        const chunks = await splitTextToChunks(doc.text, doc.name);
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
        total += records.length;
      } catch (err) {
        console.error(doc.name, err);
        failed += 1;
      }
      await yieldToMain();
    }
    await reload();
    toast(
      failed
        ? `Re-split into ${total} fragment(s); ${failed} source(s) failed`
        : `Re-split ${docs.length} source(s) into ${total} fragment(s)`,
      failed ? 'err' : 'ok'
    );
    render();
  } finally {
    state.busy = false;
  }
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
        Replaces <strong>${existing.length}</strong> piece(s)
        ${starred ? ` (including <strong>${starred}</strong> starred)` : ''}.
        Source text is kept; only the cut changes.
        ${
          state.settings.useAiChunk && llmEnabled(state.settings)
            ? inferProvider(state.settings) === 'xai'
              ? ' <strong>AI assist is on (xAI)</strong> — this source will leave the machine.'
              : ' <strong>AI assist is on</strong> — Ollama on this machine, or your custom URL.'
            : ' Offline only.'
        }
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
      const prevImport = state.importChunk;
      state.importChunk = opts;
      await deletePiecesByDocument(doc.id);
      let chunks;
      try {
        chunks = await splitTextToChunks(doc.text, doc.name);
      } finally {
        state.importChunk = prevImport;
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

function renderLlmSettingsCard(s) {
  const provider = inferProvider(s);
  const providerOpts = LLM_PROVIDERS.map(
    (p) =>
      `<option value="${p.id}" ${provider === p.id ? 'selected' : ''}>${esc(p.label)}</option>`
  ).join('');
  const xaiOpts = XAI_MODELS.map(
    (m) =>
      `<option value="${esc(m.id)}" ${
        (s.llmModel || XAI_DEFAULT_MODEL) === m.id ? 'selected' : ''
      }>${esc(m.label)}</option>`
  ).join('');
  return `
    <div class="piece-card" style="max-width:40rem;margin-top:1rem" id="llm-settings">
      <h3 style="font-family:var(--serif);margin:0 0 0.5rem">Optional AI</h3>
      <p class="muted" style="margin-top:0">
        You do <strong>not</strong> need an API key. Offline split already rips dialogue and idea-dumps.
        Turn this on only if you want the model to help cut messy drafts into fragments.
      </p>
      <p class="dim" id="s-llm-proxy" style="margin:0.35rem 0 0.75rem"></p>
      <div class="field">
        <label>Provider</label>
        <select id="s-llm-provider">${providerOpts}</select>
        <p class="dim chunk-hint" id="s-llm-provider-hint" style="margin:0.35rem 0 0"></p>
      </div>

      <div id="s-ollama-wrap" hidden>
        <div class="howto">
          <p class="howto-title">How to use Ollama (stays on this computer)</p>
          <ol class="howto-ol">
            <li>Install <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a> and leave it running (menu-bar icon on a Mac).</li>
            <li>In Terminal, pull a model that is 8B or larger:
              <br><code>ollama pull llama3.1</code>
              <br>or <code>ollama pull qwen2.5:14b</code>.
              Do not use <code>llama3.2</code> — that one is 3B and too small.</li>
            <li>Pick the model below and click <strong>Test connection</strong>.</li>
          </ol>
        </div>
        <div class="field">
          <label>Ollama model</label>
          <select id="s-ollama-model"></select>
        </div>
        <p class="dim" id="s-ollama-warn"></p>
      </div>

      <div id="s-xai-wrap" hidden>
        <div class="howto">
          <p class="howto-title">How to connect the xAI Grok API</p>
          <ol class="howto-ol">
            <li>Open <a href="https://console.x.ai" target="_blank" rel="noopener">console.x.ai</a> → <strong>API keys</strong> → create a key. Copy it (it starts with <code>xai-</code>).</li>
            <li>In the Reliquary folder, copy the file <code>.env.example</code> and rename the copy to <code>.env</code>.</li>
            <li>Open <code>.env</code> in any text editor. Put the key on this line, with no quotes and no spaces around the equals sign:
              <br><code>XAI_API_KEY=xai-your-key-here</code></li>
            <li>Stop Reliquary (click the Terminal window, press Control+C) and start it again with <code>./start.sh</code> (Mac) or <code>start.bat</code> (Windows). The key is read only when the server starts.</li>
            <li>Tick the privacy box below, pick a Grok model, click <strong>Save settings</strong>, then <strong>Test connection</strong>.</li>
          </ol>
          <p class="dim" style="margin:0.65rem 0 0">Do not want a <code>.env</code> file? Paste the key in the field below instead. That stores it in this browser’s vault. The file is safer and never uploaded.</p>
        </div>
        <p class="muted">
          When Grok is on, the text you send <strong>leaves this computer</strong> and is processed by xAI.
          They do <strong>not train</strong> on API inputs/outputs unless you opt in at the Console.
          Default logs are kept about 30 days for abuse review, then deleted.
          <a href="https://docs.x.ai/developers/faq/security" target="_blank" rel="noopener">Zero Data Retention</a>
          is a team toggle in the Console — it stops disk retention; it is not a local model.
        </p>
        <label class="field check-row">
          <input type="checkbox" id="s-xai-ack" ${s.llmPrivacyAck ? 'checked' : ''} />
          I understand drafts are sent to xAI, and I want this anyway.
        </label>
        <div class="field">
          <label>Grok model</label>
          <select id="s-xai-model">${xaiOpts}</select>
        </div>
        <p class="dim" id="s-xai-key-status"></p>
        <div class="field" id="s-xai-key-wrap">
          <label>API key (paste here only if you are not using Reliquary/.env)</label>
          <input id="s-llm-key" type="password" value="${esc(s.llmApiKey || '')}" autocomplete="off" placeholder="xai-…" />
        </div>
      </div>

      <div id="s-custom-wrap" hidden>
        <div class="howto">
          <p class="howto-title">Custom OpenAI-compatible endpoint</p>
          <ol class="howto-ol">
            <li>Base URL should look like <code>http://127.0.0.1:8000/v1</code> (include <code>/v1</code>, no trailing slash needed).</li>
            <li>Paste a model id your server expects, and an API key if it requires one.</li>
            <li>This talks <em>from the browser</em>. Reliquary will not proxy custom URLs (that would be an open proxy).</li>
          </ol>
        </div>
        <div class="field">
          <label>Base URL</label>
          <input id="s-llm-url" value="${esc(s.llmBaseUrl || '')}" placeholder="http://127.0.0.1:8000/v1" />
        </div>
        <div class="field">
          <label>Model</label>
          <input id="s-llm-model" value="${esc(s.llmModel || '')}" placeholder="model-id" />
        </div>
        <div class="field">
          <label>API key (if needed)</label>
          <input id="s-llm-key-custom" type="password" value="${esc(s.llmApiKey || '')}" autocomplete="off" />
        </div>
      </div>

      <div class="piece-actions" style="margin-top:0.75rem">
        <button type="button" class="btn" id="s-test">Test connection</button>
        <button type="button" class="btn ghost" id="s-llm-refresh">Refresh models</button>
      </div>
      <p id="s-llm-status" class="dim"></p>
    </div>
  `;
}

async function readLlmFields() {
  const provider = $('#s-llm-provider')?.value || 'off';
  const ack = !!$('#s-xai-ack')?.checked;
  if (provider === 'xai' && !ack) {
    throw new Error('xAI requires the privacy acknowledgement.');
  }
  const proxy = await getProxyStatus();
  let llmModel = '';
  let llmBaseUrl = '';
  let llmApiKey = '';
  if (provider === 'ollama') {
    llmModel = $('#s-ollama-model')?.value || 'llama3.1';
    llmBaseUrl = `${OLLAMA_DEFAULT_HOST}/v1`;
  } else if (provider === 'xai') {
    llmModel = $('#s-xai-model')?.value || XAI_DEFAULT_MODEL;
    llmBaseUrl = 'https://api.x.ai/v1';
    llmApiKey = proxy.xai?.keyConfigured ? '' : ($('#s-llm-key')?.value || '').trim();
  } else if (provider === 'custom') {
    llmBaseUrl = ($('#s-llm-url')?.value || '').trim();
    llmModel = ($('#s-llm-model')?.value || '').trim();
    llmApiKey = ($('#s-llm-key-custom')?.value || '').trim();
    if (!llmBaseUrl) throw new Error('Custom provider needs a base URL.');
  }
  const useAi = !!$('#s-ai-chunk')?.checked && provider !== 'off';
  return {
    llmProvider: provider,
    llmModel,
    llmBaseUrl,
    llmApiKey,
    llmPrivacyAck: ack,
    useAiChunk: useAi,
  };
}

function wireLlmSettings() {
  const providerSel = $('#s-llm-provider');
  if (!providerSel) return;

  const applyHint = () => {
    const meta = LLM_PROVIDERS.find((p) => p.id === providerSel.value);
    const hint = $('#s-llm-provider-hint');
    if (hint) hint.textContent = meta?.hint || '';
    const ollama = $('#s-ollama-wrap');
    const xai = $('#s-xai-wrap');
    const custom = $('#s-custom-wrap');
    if (ollama) ollama.hidden = providerSel.value !== 'ollama';
    if (xai) xai.hidden = providerSel.value !== 'xai';
    if (custom) custom.hidden = providerSel.value !== 'custom';
  };

  const fillOllama = async () => {
    const sel = $('#s-ollama-model');
    const warn = $('#s-ollama-warn');
    if (!sel) return;
    sel.innerHTML = `<option value="">Looking for Ollama…</option>`;
    const listed = await listLlmModels('ollama', state.settings);
    if (!listed.ok || !listed.models?.length) {
      sel.innerHTML = `<option value="llama3.1">llama3.1 (pull this)</option>`;
      if (warn) warn.textContent = listed.error || 'Ollama is not reachable.';
      return;
    }
    const current = state.settings.llmModel;
    const preferred = listed.models.some((m) => m.id === current) ? current : pickOllamaDefault(listed.models);
    sel.innerHTML = listed.models
      .map((m) => {
        const tag = m.parameterSize ? ` (${m.parameterSize})` : '';
        return `<option value="${esc(m.id)}" ${m.id === preferred ? 'selected' : ''}>${esc(m.id)}${esc(tag)}</option>`;
      })
      .join('');
    const chosen = listed.models.find((m) => m.id === sel.value);
    if (warn) warn.textContent = ollamaSizeWarning(sel.value, chosen || {});
    sel.onchange = () => {
      const m = listed.models.find((x) => x.id === sel.value);
      if (warn) warn.textContent = ollamaSizeWarning(sel.value, m || {});
    };
  };

  const fillXai = async () => {
    const proxy = await getProxyStatus();
    const status = $('#s-xai-key-status');
    const wrap = $('#s-xai-key-wrap');
    const banner = $('#s-llm-proxy');
    if (banner) {
      if (proxy.proxy) {
        banner.textContent = proxy.xai?.keyConfigured
          ? 'Server is up. API key loaded from .env on this computer (not stored in the vault).'
          : 'Server is up. No API key loaded yet — finish the numbered steps below, then restart Reliquary.';
      } else {
        banner.textContent =
          'Reliquary’s server is not running, so it cannot hold your API key. From the Reliquary folder run ./start.sh (Mac) or start.bat (Windows), then refresh this page.';
      }
    }
    if (status) {
      status.textContent = proxy.xai?.keyConfigured
        ? 'API key: loaded from .env on this machine. You can skip the paste field.'
        : 'API key: not in .env yet. Follow the steps above, or paste a key in the field.';
    }
    if (wrap) wrap.hidden = !!proxy.xai?.keyConfigured;
    const sel = $('#s-xai-model');
    if (!sel) return;
    try {
      const listed = await listLlmModels('xai', state.settings);
      const ids = new Set(XAI_MODELS.map((m) => m.id));
      for (const m of listed.models || []) {
        if (m.id && !ids.has(m.id)) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.label || m.id;
          if (m.id === state.settings.llmModel) opt.selected = true;
          sel.appendChild(opt);
        }
      }
    } catch {
      /* static list is enough */
    }
  };

  applyHint();
  getProxyStatus().then((proxy) => {
    const banner = $('#s-llm-proxy');
    if (!banner) return;
    if (providerSel.value === 'xai') return; // fillXai owns the banner
    if (proxy.proxy) {
      banner.textContent = proxy.ollama?.ok
        ? 'Server is up. Ollama is reachable on this machine.'
        : 'Server is up. Ollama is not running — install it from ollama.com if you want local AI.';
    } else {
      banner.textContent =
        'Reliquary’s server is not running. From this folder run ./start.sh (Mac) or start.bat (Windows). Ollama can still work if the browser can reach it.';
    }
  });

  providerSel.addEventListener('change', () => {
    applyHint();
    if (providerSel.value === 'ollama') fillOllama();
    if (providerSel.value === 'xai') fillXai();
  });
  if (providerSel.value === 'ollama') fillOllama();
  if (providerSel.value === 'xai') fillXai();

  $('#s-llm-refresh')?.addEventListener('click', async () => {
    if (providerSel.value === 'ollama') await fillOllama();
    if (providerSel.value === 'xai') await fillXai();
    toast('Refreshed', 'ok');
  });

  $('#s-test')?.addEventListener('click', async () => {
    const el = $('#s-llm-status');
    try {
      const llm = await readLlmFields();
      if (el) el.textContent = 'Testing…';
      const r = await checkLlm({ ...state.settings, ...llm });
      if (el) el.textContent = r.ok ? r.message : r.reason;
      toast(r.ok ? 'LLM OK' : r.reason, r.ok ? 'ok' : 'err');
    } catch (err) {
      if (el) el.textContent = err.message || String(err);
      toast(err.message || String(err), 'err');
    }
  });
}

function renderSettings(root, actions) {
  actions.innerHTML = `<button type="button" class="btn" id="btn-cmd" title="⌘K">Commands</button>`;
  $('#btn-cmd').onclick = () => openCommandPalette();
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
    <div class="piece-card" style="max-width:40rem;margin-top:1rem" id="vault-backup">
      <h3 style="font-family:var(--serif);margin:0 0 0.35rem">Vault backup</h3>
      <p class="muted" style="margin:0 0 0.75rem">
        Full local snapshot: documents, pieces, storyboards, collections, and settings.
        API keys are <strong>redacted</strong> in the export unless you choose otherwise.
        Restore replaces vault content (settings keys stay if the file has a redacted key).
      </p>
      <div class="piece-actions">
        <button type="button" class="btn primary" id="vault-export">Export vault…</button>
        <button type="button" class="btn" id="vault-import">Import vault…</button>
      </div>
      <label class="field check-row" style="margin-top:0.75rem">
        <input type="checkbox" id="vault-include-secrets" />
        Include API key in export (keep the file private)
      </label>
      <input type="file" id="vault-file" accept="application/json,.json" hidden />
      <p class="dim" id="vault-status" style="margin:0.5rem 0 0"></p>
    </div>
    <div class="piece-card" style="max-width:40rem;margin-top:1rem">
      <h3 style="font-family:var(--serif);margin:0 0 0.35rem">Offline split (LLM-free)</h3>
      <p class="muted" style="margin:0 0 0.85rem">
        Reliquary is a <strong>fragment desk</strong>, not a filing cabinet. Each file is cut into cards you reorder.
        Leave “keep dialogue glued” unchecked to rip speech out of a story. Idea-dumps (filename containing “ideas”, bullets, “another thought…”) become many cards, not one.
      </p>
      ${renderChunkControls('s', s)}
      <label class="field check-row" style="margin-top:0.75rem">
        <input type="checkbox" id="s-ai-chunk" ${s.useAiChunk ? 'checked' : ''} />
        Also try AI-assisted fragmenting on import / re-split (falls back offline). Needs a provider below.
      </label>
    </div>
    <div class="piece-card" style="max-width:40rem;margin-top:1rem">
      <h3 style="font-family:var(--serif);margin:0 0 0.75rem">Labels</h3>
      <div class="field">
        <label>One label per line (your taxonomy)</label>
        <textarea id="s-labels" rows="8">${esc((s.labels || DEFAULT_LABELS).join('\n'))}</textarea>
      </div>
    </div>
    ${renderLlmSettingsCard(s)}
    <div class="piece-card" style="max-width:40rem;margin-top:1rem">
      <h3 style="font-family:var(--serif);margin:0 0 0.75rem">Support links (shown in app)</h3>
      <p class="dim" style="margin:0 0 0.65rem">Leave GitHub Sponsors empty to hide it. Ko-fi defaults to the project page.</p>
      <div class="field">
        <label>GitHub Sponsors URL (optional)</label>
        <input id="s-gh" value="${esc(s.supportGithubSponsors || '')}" placeholder="https://github.com/sponsors/…" />
      </div>
      <div class="field">
        <label>Ko-fi URL</label>
        <input id="s-kofi" value="${esc(s.supportKofi || '')}" placeholder="https://ko-fi.com/otterlyfrank" />
      </div>
    </div>
    ${installUiHtml('full')}
    <div class="piece-actions" style="margin-top:1rem">
      <button type="button" class="btn primary" id="s-save">Save settings</button>
    </div>
    <div id="support">${supportBlock()}</div>
  `;

  wireChunkControls('s');
  wireInstallButtons(root);
  wireVaultBackup(root);
  wireLlmSettings();

  $('#s-save').onclick = async () => {
    const labels = $('#s-labels')
      .value.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const chunk = readChunkFields('s');
    let llm;
    try {
      llm = await readLlmFields();
    } catch (err) {
      toast(err.message || String(err), 'err');
      return;
    }
    state.settings = await setSettings({
      theme: $('#s-theme').value,
      ...chunk,
      ...llm,
      labels: labels.length ? labels : DEFAULT_LABELS,
      supportGithubSponsors: $('#s-gh').value.trim(),
      supportKofi: $('#s-kofi').value.trim(),
    });
    state.importChunk = null;
    applyTheme(state.settings.theme);
    toast('Settings saved', 'ok');
    render();
  };
}

function wireVaultBackup(root) {
  const status = $('#vault-status', root);
  $('#vault-export', root)?.addEventListener('click', async () => {
    try {
      const includeSecrets = !!$('#vault-include-secrets', root)?.checked;
      const vault = await exportVault({ includeSecrets });
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(`reliquary-vault-${stamp}`, vault);
      if (status) {
        status.textContent = `Exported ${vault.pieces?.length || 0} pieces · ${vault.documents?.length || 0} files · ${
          vault.storyboards?.length || 0
        } boards${includeSecrets ? ' · includes API key' : ' · key redacted'}`;
      }
      toast('Vault exported', 'ok');
    } catch (err) {
      toast(err.message || String(err), 'err');
    }
  });
  $('#vault-import', root)?.addEventListener('click', () => {
    $('#vault-file', root)?.click();
  });
  $('#vault-file', root)?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (
      !confirm(
        'Import replaces documents, pieces, collections, and storyboards in this browser. Continue?'
      )
    ) {
      return;
    }
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const r = await importVault(payload, { keepApiKey: true });
      state.settings = await getSettings();
      applyTheme(state.settings.theme);
      await reload();
      if (status) {
        status.textContent = `Restored ${r.pieces} pieces · ${r.documents} files · ${r.storyboards} boards · ${r.collections} collections`;
      }
      toast(`Vault restored · ${r.pieces} pieces`, 'ok');
      render();
    } catch (err) {
      toast(err.message || 'Invalid vault file', 'err');
    }
  });
}

function supportBlock() {
  const s = state.settings || {};
  const gh = String(s.supportGithubSponsors || '').trim();
  const kofi = String(s.supportKofi || '').trim() || 'https://ko-fi.com/otterlyfrank';
  const ghOk = gh && !/^https?:\/\/github\.com\/sponsors\/?$/i.test(gh);
  return `
    <div class="support-card">
      <h3>Support Reliquary</h3>
      <p>${esc(s.supportNote || 'Reliquary is free and open source. If it helps you excavate your work, consider supporting development.')}</p>
      <div class="support-links">
        ${ghOk ? `<a class="btn" href="${esc(gh)}" target="_blank" rel="noopener">GitHub Sponsors</a>` : ''}
        <a class="btn primary" href="${esc(kofi)}" target="_blank" rel="noopener">Ko-fi</a>
      </div>
    </div>`;
}

// ── Command palette (⌘K / Ctrl+K) ──────────────────────────

function openCommandPalette() {
  if (document.getElementById('cmd-backdrop')) return;
  const go = async (view, filter) => {
    state.view = view;
    if (filter) state.filter = filter;
    if (view === 'pieces' && !filter) state.filter = 'active';
    if (view === 'storyboards') state.activeStoryboardId = null;
    state.sidebarOpen = false;
    state.piecePage = 0;
    state.selected = new Set();
    await reload();
    render();
  };
  const commands = [
    { id: 'start', label: 'Go to Import', run: () => go('excavate') },
    { id: 'import-folder', label: 'Import a whole folder…', run: () => go('excavate').then(() => importFolder()) },
    { id: 'pieces', label: 'Go to My pieces', run: () => go('pieces', 'active') },
    { id: 'starred', label: 'Go to Starred', run: () => go('pieces', 'starred') },
    { id: 'develop', label: 'Go to Work on later', run: () => go('pieces', 'develop') },
    { id: 'archive', label: 'Go to Archive', run: () => go('pieces', 'archive') },
    { id: 'boards', label: 'Go to Storyboards', run: () => go('storyboards') },
    { id: 'sources', label: 'Go to Imported files', run: () => go('sources') },
    { id: 'collections', label: 'Go to Collections', run: () => go('collections') },
    { id: 'settings', label: 'Go to Settings', run: () => go('settings') },
    {
      id: 'export-vault',
      label: 'Export vault backup…',
      run: async () => {
        await go('settings');
        requestAnimationFrame(() => {
          document.getElementById('vault-backup')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          document.getElementById('vault-export')?.focus();
        });
      },
    },
    {
      id: 'import-more',
      label: 'Import more drafts',
      run: () => go('excavate'),
    },
    {
      id: 'theme',
      label: 'Toggle light / dark theme',
      run: async () => {
        const next = state.settings?.theme === 'light' ? 'dark' : 'light';
        state.settings = await setSettings({ theme: next });
        applyTheme(next);
        toast(`Theme: ${next}`, 'ok');
        render();
      },
    },
  ];
  let filter = '';
  let active = 0;
  const backdrop = document.createElement('div');
  backdrop.id = 'cmd-backdrop';
  backdrop.className = 'cmd-backdrop';
  const close = () => backdrop.remove();
  const filtered = () => {
    const q = filter.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.id.includes(q));
  };
  const paint = () => {
    const list = filtered();
    if (active >= list.length) active = Math.max(0, list.length - 1);
    backdrop.innerHTML = `
      <div class="cmd-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input type="search" id="cmd-input" class="cmd-input" placeholder="Jump to… pieces, boards, vault…" value="${esc(
          filter
        )}" autocomplete="off" />
        <div class="cmd-list" role="listbox">
          ${
            list
              .map(
                (c, i) =>
                  `<button type="button" class="cmd-item ${i === active ? 'active' : ''}" data-cmd="${esc(
                    c.id
                  )}" role="option" aria-selected="${i === active}">${esc(c.label)}</button>`
              )
              .join('') || `<p class="dim cmd-empty">No matches</p>`
          }
        </div>
        <p class="dim cmd-foot">↑↓ · Enter · Esc · ⌘K</p>
      </div>`;
    const input = backdrop.querySelector('#cmd-input');
    input?.focus();
    input?.select();
    input?.addEventListener('input', (ev) => {
      filter = ev.target.value;
      active = 0;
      paint();
    });
    input?.addEventListener('keydown', (ev) => {
      const list2 = filtered();
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        active = Math.min(list2.length - 1, active + 1);
        paint();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        active = Math.max(0, active - 1);
        paint();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        const cmd = list2[active];
        if (cmd) {
          close();
          cmd.run();
        }
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
      }
    });
    backdrop.querySelectorAll('[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = commands.find((c) => c.id === btn.dataset.cmd);
        close();
        cmd?.run();
      });
    });
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) close();
    });
  };
  document.body.appendChild(backdrop);
  paint();
}
