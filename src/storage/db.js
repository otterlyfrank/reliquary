/**
 * Reliquary IndexedDB — all writing stays local.
 */

const DB_NAME = 'reliquary';
const DB_VERSION = 1;

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
  chunkMode: 'balanced', // conservative | balanced | atomic
  useAiChunk: false,
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: 'llama3.2',
  labels: DEFAULT_LABELS,
  supportGithubSponsors: 'https://github.com/sponsors',
  supportKofi: 'https://ko-fi.com',
  supportNote: 'Reliquary is free and open source. Support keeps the vault open.',
};

function openDb() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      dbInstance = req.result;
      resolve(dbInstance);
    };
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
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
    };
  });
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

// ── Settings ───────────────────────────────────────────────

export async function getSettings() {
  const t = await tx(['settings']);
  const rows = await reqP(t.objectStore('settings').getAll());
  const map = { ...DEFAULT_SETTINGS };
  for (const row of rows) map[row.key] = row.value;
  if (!Array.isArray(map.labels) || !map.labels.length) map.labels = [...DEFAULT_LABELS];
  return map;
}

export async function setSettings(partial) {
  for (const [key, value] of Object.entries(partial)) {
    const t = await tx(['settings'], 'readwrite');
    await reqP(t.objectStore('settings').put({ key, value }));
  }
  return getSettings();
}

export { openDb, uuid, DEFAULT_LABELS };
