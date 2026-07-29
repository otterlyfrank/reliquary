/**
 * Reliquary IndexedDB — all writing stays local.
 */

const DB_NAME = 'reliquary';
const DB_VERSION = 2;

/** @typedef {'brainstorm' | 'outline' | 'draft'} StoryboardMode */

export const STORYBOARD_MODES = [
  { id: 'brainstorm', label: 'Brainstorm', hint: 'Loose shelf — dump gold, sort later' },
  { id: 'outline', label: 'Outline', hint: 'Ordered beats, headings, structure' },
  { id: 'draft', label: 'Working draft', hint: 'Toward a continuous read' },
];

/** @type {IDBDatabase | null} */
let dbInstance = null;

const DEFAULT_LABELS = [
  'Concept',
  'Character',
  'Location',
  'Plot Seed',
  'Philosophical Fragment',
  'Dialogue',
  'Poetry',
  'Phrase/Image',
  'Incomplete',
  'Scene',
  'Essay Seed',
];

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  // Legacy size knob (kept for older vaults; engine maps to size presets)
  chunkMode: 'balanced', // conservative | balanced | atomic
  // Offline fine-tuning (LLM-free path)
  chunkUnit: 'hybrid', // sentence | paragraph | section | page | hybrid
  chunkSizePreset: 'medium', // fine | medium | coarse | custom
  chunkMinChars: 40,
  chunkMaxChars: 1800,
  chunkPageWords: 300,
  respectPageBreaks: true,
  keepDialogueTogether: true,
  useAiChunk: false,
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: 'llama3.2',
  labels: DEFAULT_LABELS,
  /** Leave empty to hide GitHub Sponsors */
  supportGithubSponsors: '',
  supportKofi: 'https://ko-fi.com/otterlyfrank',
  supportNote: 'Reliquary is free and open source. Support keeps the vault open.',
};

export const VAULT_SCHEMA_VERSION = 1;

function ensureStores(db) {
  if (!db.objectStoreNames.contains('documents')) {
    const d = db.createObjectStore('documents', { keyPath: 'id' });
    d.createIndex('importedAt', 'importedAt', { unique: false });
  }
  if (!db.objectStoreNames.contains('pieces')) {
    const p = db.createObjectStore('pieces', { keyPath: 'id' });
    p.createIndex('documentId', 'documentId', { unique: false });
    p.createIndex('status', 'status', { unique: false });
    p.createIndex('starred', 'starred', { unique: false });
    p.createIndex('updatedAt', 'updatedAt', { unique: false });
  }
  if (!db.objectStoreNames.contains('collections')) {
    db.createObjectStore('collections', { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains('settings')) {
    db.createObjectStore('settings', { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains('storyboards')) {
    const s = db.createObjectStore('storyboards', { keyPath: 'id' });
    s.createIndex('updatedAt', 'updatedAt', { unique: false });
    s.createIndex('mode', 'mode', { unique: false });
  }
}

/**
 * Open IndexedDB with upgrade + blocked handling.
 * Stuck “Opening vault” is usually another Reliquary tab holding the old DB.
 */
export function openDb() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err || 'IndexedDB open failed')));
    };
    const ok = (db) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dbInstance = db;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        dbInstance = null;
      };
      resolve(db);
    };

    const timer = setTimeout(() => {
      fail(
        new Error(
          'Vault is taking too long to open. Close other Reliquary tabs, then hard-refresh (Cmd+Shift+R).'
        )
      );
    }, 8000);

    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      fail(err);
      return;
    }

    req.onerror = () => fail(req.error || new Error('IndexedDB error'));
    req.onblocked = () => {
      // keep waiting — timeout will surface a clear message
      console.warn('[Reliquary] IndexedDB upgrade blocked — close other tabs.');
    };
    req.onupgradeneeded = (e) => {
      try {
        ensureStores(e.target.result);
      } catch (err) {
        fail(err);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Self-heal: if a partial DB is missing storyboards, bump via delete+reopen is too harsh;
      // ensureStores only runs on upgrade. If somehow missing, recreate connection at higher version.
      if (!db.objectStoreNames.contains('storyboards')) {
        db.close();
        dbInstance = null;
        const bump = indexedDB.open(DB_NAME, DB_VERSION + 1);
        bump.onupgradeneeded = (e) => {
          try {
            ensureStores(e.target.result);
          } catch (err) {
            fail(err);
          }
        };
        bump.onerror = () => fail(bump.error || new Error('IndexedDB upgrade failed'));
        bump.onblocked = () => {
          console.warn('[Reliquary] IndexedDB bump blocked — close other tabs.');
        };
        bump.onsuccess = () => ok(bump.result);
        return;
      }
      ok(db);
    };
  });
}

/** Close and forget cached connection (for recovery / tests). */
export function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      /* ignore */
    }
  }
  dbInstance = null;
}

function tx(names, mode = 'readonly') {
  return openDb().then((db) => db.transaction(names, mode));
}

function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function uuid() {
  return crypto.randomUUID();
}

// ── Documents ──────────────────────────────────────────────

export async function putDocument(doc) {
  const now = Date.now();
  const record = {
    id: doc.id || uuid(),
    name: doc.name || 'Untitled',
    kind: doc.kind || 'text',
    text: doc.text || '',
    charCount: (doc.text || '').length,
    pieceCount: doc.pieceCount || 0,
    importedAt: doc.importedAt || now,
    updatedAt: now,
  };
  const t = await tx(['documents'], 'readwrite');
  await reqP(t.objectStore('documents').put(record));
  return record;
}

export async function listDocuments() {
  const t = await tx(['documents']);
  const all = await reqP(t.objectStore('documents').getAll());
  return all.sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));
}

export async function getDocument(id) {
  const t = await tx(['documents']);
  return reqP(t.objectStore('documents').get(id));
}

export async function deleteDocument(id) {
  const pieces = await listPieces({ documentId: id });
  const t = await tx(['documents', 'pieces'], 'readwrite');
  await reqP(t.objectStore('documents').delete(id));
  for (const p of pieces) {
    await reqP(t.objectStore('pieces').delete(p.id));
  }
}

// ── Pieces (cards) ─────────────────────────────────────────

/**
 * status: active | develop | archive | trash
 */
export async function putPiece(piece) {
  const now = Date.now();
  const text = piece.text || '';
  const record = {
    id: piece.id || uuid(),
    documentId: piece.documentId || null,
    sourceName: piece.sourceName || '',
    text,
    preview: piece.preview || text.slice(0, 280),
    labels: piece.labels || [],
    tags: piece.tags || [],
    starred: !!piece.starred,
    pinned: !!piece.pinned,
    energy: piece.energy ?? 0, // 0–3 user stars
    status: piece.status || 'active',
    isLarge: !!piece.isLarge || text.length >= 1200,
    collectionIds: piece.collectionIds || [],
    aiHint: piece.aiHint || '',
    createdAt: piece.createdAt || now,
    updatedAt: now,
  };
  const t = await tx(['pieces'], 'readwrite');
  await reqP(t.objectStore('pieces').put(record));
  return record;
}

export async function getPiece(id) {
  const t = await tx(['pieces']);
  return reqP(t.objectStore('pieces').get(id));
}

export async function listPieces(filter = {}) {
  const t = await tx(['pieces']);
  let all = await reqP(t.objectStore('pieces').getAll());
  if (filter.documentId) all = all.filter((p) => p.documentId === filter.documentId);
  if (filter.status) all = all.filter((p) => p.status === filter.status);
  if (filter.starred) all = all.filter((p) => p.starred);
  if (filter.develop) all = all.filter((p) => p.status === 'develop');
  if (filter.label) all = all.filter((p) => (p.labels || []).includes(filter.label));
  if (filter.collectionId) {
    all = all.filter((p) => (p.collectionIds || []).includes(filter.collectionId));
  }
  if (filter.q) {
    const q = filter.q.toLowerCase();
    all = all.filter(
      (p) =>
        (p.text || '').toLowerCase().includes(q) ||
        (p.tags || []).some((t) => t.toLowerCase().includes(q)) ||
        (p.labels || []).some((l) => l.toLowerCase().includes(q))
    );
  }
  return all.sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    if (!!b.starred !== !!a.starred) return b.starred ? 1 : -1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

export async function updatePiece(id, patch) {
  const existing = await getPiece(id);
  if (!existing) throw new Error('Piece not found');
  return putPiece({ ...existing, ...patch, id });
}

export async function deletePiece(id) {
  const t = await tx(['pieces'], 'readwrite');
  await reqP(t.objectStore('pieces').delete(id));
}

export async function putPiecesBulk(pieces) {
  const t = await tx(['pieces'], 'readwrite');
  const store = t.objectStore('pieces');
  const out = [];
  for (const piece of pieces) {
    const now = Date.now();
    const text = piece.text || '';
    const record = {
      id: piece.id || uuid(),
      documentId: piece.documentId || null,
      sourceName: piece.sourceName || '',
      text,
      preview: piece.preview || text.slice(0, 280),
      labels: piece.labels || [],
      tags: piece.tags || [],
      starred: !!piece.starred,
      pinned: !!piece.pinned,
      energy: piece.energy ?? 0,
      status: piece.status || 'active',
      isLarge: !!piece.isLarge || text.length >= 1200,
      collectionIds: piece.collectionIds || [],
      aiHint: piece.aiHint || '',
      createdAt: piece.createdAt || now,
      updatedAt: now,
    };
    await reqP(store.put(record));
    out.push(record);
  }
  return out;
}

// ── Collections ────────────────────────────────────────────

export async function putCollection(col) {
  const now = Date.now();
  const record = {
    id: col.id || uuid(),
    name: col.name || 'Untitled collection',
    description: col.description || '',
    notes: col.notes || '',
    /** Optional explicit membership (also inferred from piece.collectionIds / tags) */
    pieceIds: Array.isArray(col.pieceIds) ? col.pieceIds : [],
    createdAt: col.createdAt || now,
    updatedAt: now,
  };
  const t = await tx(['collections'], 'readwrite');
  await reqP(t.objectStore('collections').put(record));
  return record;
}

export async function listCollections() {
  const t = await tx(['collections']);
  const all = await reqP(t.objectStore('collections').getAll());
  return all.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function deleteCollection(id) {
  const pieces = await listPieces({});
  for (const p of pieces) {
    if ((p.collectionIds || []).includes(id)) {
      await updatePiece(p.id, {
        collectionIds: (p.collectionIds || []).filter((c) => c !== id),
      });
    }
  }
  const t = await tx(['collections'], 'readwrite');
  await reqP(t.objectStore('collections').delete(id));
}

// ── Storyboards (working drafts / outlines / brainstorms) ──

/**
 * Ordered workspace: pieces (snapshots) + headings + free notes.
 * kind on items: 'piece' | 'heading' | 'note'
 * mode on board: brainstorm | outline | draft
 */
export async function putStoryboard(board) {
  const now = Date.now();
  const mode = ['brainstorm', 'outline', 'draft'].includes(board.mode) ? board.mode : 'brainstorm';
  const record = {
    id: board.id || uuid(),
    name: (board.name || 'Untitled storyboard').trim() || 'Untitled storyboard',
    mode,
    notes: board.notes || '',
    items: Array.isArray(board.items) ? board.items : [],
    createdAt: board.createdAt || now,
    updatedAt: now,
  };
  const t = await tx(['storyboards'], 'readwrite');
  await reqP(t.objectStore('storyboards').put(record));
  return record;
}

export async function getStoryboard(id) {
  const t = await tx(['storyboards']);
  return reqP(t.objectStore('storyboards').get(id));
}

export async function listStoryboards() {
  try {
    const t = await tx(['storyboards']);
    const all = await reqP(t.objectStore('storyboards').getAll());
    return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch (err) {
    console.warn('[Reliquary] listStoryboards', err);
    return [];
  }
}

export async function deleteStoryboard(id) {
  const t = await tx(['storyboards'], 'readwrite');
  await reqP(t.objectStore('storyboards').delete(id));
}

/** Snapshot a piece onto a board (keeps board stable if source piece later changes). */
export function pieceToBoardItem(piece) {
  return {
    id: uuid(),
    kind: 'piece',
    pieceId: piece.id,
    text: piece.text || '',
    sourceName: piece.sourceName || '',
    labels: piece.labels || [],
    tags: piece.tags || [],
    energy: piece.energy || 0,
  };
}

export function makeHeadingItem(title = 'Section') {
  return { id: uuid(), kind: 'heading', text: title };
}

export function makeNoteItem(text = '') {
  return { id: uuid(), kind: 'note', text };
}

export async function addPiecesToStoryboard(boardId, pieces) {
  const board = await getStoryboard(boardId);
  if (!board) throw new Error('Storyboard not found');
  const existingIds = new Set(
    (board.items || []).filter((i) => i.kind === 'piece' && i.pieceId).map((i) => i.pieceId)
  );
  const toAdd = [];
  for (const p of pieces) {
    if (!p?.id) continue;
    if (existingIds.has(p.id)) continue;
    toAdd.push(pieceToBoardItem(p));
    existingIds.add(p.id);
  }
  if (!toAdd.length) return board;
  return putStoryboard({
    ...board,
    items: [...(board.items || []), ...toAdd],
  });
}

export async function updateStoryboardItems(boardId, items) {
  const board = await getStoryboard(boardId);
  if (!board) throw new Error('Storyboard not found');
  return putStoryboard({ ...board, items });
}

// ── Settings ───────────────────────────────────────────────

export async function getSettings() {
  const t = await tx(['settings']);
  const rows = await reqP(t.objectStore('settings').getAll());
  const map = { ...DEFAULT_SETTINGS };
  for (const row of rows) map[row.key] = row.value;
  if (!Array.isArray(map.labels) || !map.labels.length) map.labels = [...DEFAULT_LABELS];
  // Normalize legacy generic sponsor placeholders
  const gh = String(map.supportGithubSponsors || '').trim();
  if (!gh || /^https?:\/\/github\.com\/sponsors\/?$/i.test(gh)) {
    map.supportGithubSponsors = '';
  }
  const kofi = String(map.supportKofi || '').trim();
  if (!kofi || kofi === 'https://ko-fi.com' || kofi === 'https://ko-fi.com/') {
    map.supportKofi = DEFAULT_SETTINGS.supportKofi;
  }
  return map;
}

export async function setSettings(partial) {
  for (const [key, value] of Object.entries(partial)) {
    const t = await tx(['settings'], 'readwrite');
    await reqP(t.objectStore('settings').put({ key, value }));
  }
  return getSettings();
}

async function clearStore(name) {
  const t = await tx([name], 'readwrite');
  await reqP(t.objectStore(name).clear());
}

/**
 * Full vault snapshot for backup / restore.
 * API keys are redacted unless includeSecrets is true.
 */
export async function exportVault({ includeSecrets = false } = {}) {
  const settings = await getSettings();
  const safeSettings = { ...settings };
  if (!includeSecrets && safeSettings.llmApiKey) {
    safeSettings.llmApiKey = '[redacted]';
  }
  const [documents, pieces, collections, storyboards] = await Promise.all([
    listDocuments(),
    listPieces({}),
    listCollections(),
    listStoryboards(),
  ]);
  return {
    app: 'reliquary',
    schemaVersion: VAULT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: safeSettings,
    documents,
    pieces,
    collections,
    storyboards,
  };
}

/**
 * Restore a Reliquary vault export. Replaces documents/pieces/collections/storyboards.
 * Keeps current API key when export has redacted key.
 */
export async function importVault(payload, { keepApiKey = true } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid vault file');
  }
  if (payload.app && payload.app !== 'reliquary') {
    throw new Error(`Not a Reliquary vault (app: ${payload.app})`);
  }
  const current = await getSettings();

  if (payload.settings && typeof payload.settings === 'object') {
    const next = { ...payload.settings };
    const key = next.llmApiKey;
    if (!key || key === '[redacted]' || key === '***') {
      next.llmApiKey = keepApiKey ? current.llmApiKey || '' : '';
    }
    await setSettings(next);
  }

  await clearStore('documents');
  await clearStore('pieces');
  await clearStore('collections');
  await clearStore('storyboards');

  let docs = 0;
  let pieces = 0;
  let boards = 0;
  let cols = 0;

  for (const d of payload.documents || []) {
    if (!d || typeof d !== 'object') continue;
    await putDocument({ ...d, id: d.id || uuid() });
    docs++;
  }
  for (const p of payload.pieces || []) {
    if (!p || typeof p !== 'object') continue;
    await putPiece({ ...p, id: p.id || uuid() });
    pieces++;
  }
  for (const c of payload.collections || []) {
    if (!c || typeof c !== 'object') continue;
    await putCollection({ ...c, id: c.id || uuid() });
    cols++;
  }
  for (const b of payload.storyboards || []) {
    if (!b || typeof b !== 'object') continue;
    await putStoryboard({ ...b, id: b.id || uuid() });
    boards++;
  }

  return { documents: docs, pieces, collections: cols, storyboards: boards };
}

/**
 * Convert a collection into a new storyboard (migration helper).
 * Membership: explicit pieceIds, then piece.collectionIds, then tag matching the collection name.
 */
export async function collectionToStoryboard(collectionId) {
  const cols = await listCollections();
  const col = cols.find((c) => c.id === collectionId);
  if (!col) throw new Error('Collection not found');
  const allPieces = await listPieces({});
  const byId = new Map(allPieces.map((p) => [p.id, p]));
  const seen = new Set();
  const items = [];

  for (const pid of col.pieceIds || []) {
    const p = byId.get(pid);
    if (p && !seen.has(p.id)) {
      items.push(pieceToBoardItem(p));
      seen.add(p.id);
    }
  }
  for (const p of allPieces) {
    if (seen.has(p.id)) continue;
    const inCol = (p.collectionIds || []).includes(collectionId);
    const tagged = col.name && (p.tags || []).includes(col.name);
    if (inCol || tagged) {
      items.push(pieceToBoardItem(p));
      seen.add(p.id);
    }
  }

  const noteBits = [];
  if (col.notes?.trim()) noteBits.push(col.notes.trim());
  if (col.description?.trim()) noteBits.push(col.description.trim());
  noteBits.push('Migrated from Collections');

  return putStoryboard({
    name: col.name || 'From collection',
    mode: 'brainstorm',
    notes: noteBits.join('\n\n'),
    items,
  });
}

export { uuid, DEFAULT_LABELS };
