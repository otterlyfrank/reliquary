/* Reliquary service worker — shell cache for installability + offline reopen */
const CACHE = 'reliquary-shell-v7';

const PRECACHE = [
  './',
  './index.html',
  './src/styles.css',
  './src/main.js',
  './src/app.js',
  './src/pwa.js',
  './src/storage/db.js',
  './src/ai/client.js',
  './src/chunk/engine.js',
  './src/ingest/parse.js',
  './src/ingest/parse-worker.js',
  './src/lib/export.js',
  './src/lib/yield.js',
  './public/reliquary-otter-lego.jpg',
  './public/reliquary-mark.svg',
  './public/reliquary-mark.png',
  './public/reliquary-icon-hero.jpg',
  './public/icon-192.png',
  './public/icon-512.png',
  './public/apple-touch-icon.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.warn('[Reliquary SW] precache partial', err);
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/**
 * Network-first for same-origin GETs (fresh while developing).
 * Cache fallback so the installed app still opens offline.
 * Cross-origin (fonts, LLM APIs) is left to the network.
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw new Error('Offline and not cached');
  }
}
