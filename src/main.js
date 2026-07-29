import { openDb } from './storage/db.js';
import { mountApp } from './app.js';
import { initPwa } from './pwa.js';

function showBootError(root, err) {
  const msg = err?.message || String(err);
  console.error('[Reliquary] boot failed', err);
  root.innerHTML = `
    <div class="boot">
      <p class="boot-mark">Reliquary</p>
      <p class="muted">Couldn’t open the vault</p>
      <p class="dim" style="max-width:28rem;margin:0.75rem auto;line-height:1.5">${escapeHtml(msg)}</p>
      <div style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;margin-top:1rem">
        <button type="button" class="btn primary" id="boot-retry">Try again</button>
        <button type="button" class="btn" id="boot-refresh">Hard refresh</button>
      </div>
      <p class="dim" style="max-width:28rem;margin:1.25rem auto 0;font-size:0.85rem;line-height:1.5">
        Use <strong>http://127.0.0.1:8780</strong> (not a file:// page). Close other Reliquary tabs.
        Server: double-click <code>start.bat</code> (Windows) or run <code>./start.sh</code> (Mac).
      </p>
    </div>`;
  root.querySelector('#boot-retry')?.addEventListener('click', () => {
    root.innerHTML = `
      <div class="boot">
        <p class="boot-mark">Reliquary</p>
        <p class="muted">Opening your vault…</p>
      </div>`;
    boot();
  });
  root.querySelector('#boot-refresh')?.addEventListener('click', () => {
    const u = new URL(location.href);
    u.searchParams.set('r', String(Date.now()));
    location.href = u.toString();
  });
}

async function boot() {
  const root = document.getElementById('app');
  if (!root) return;

  if (!window.indexedDB) {
    showBootError(root, new Error('This browser has no IndexedDB. Try Chrome, Brave, Edge, Firefox, or Safari.'));
    return;
  }

  // file:// almost always breaks ES modules + IndexedDB quirks
  if (location.protocol === 'file:') {
    showBootError(
      root,
      new Error('Opened as a file. Start the app with start.sh / start.bat, then visit http://127.0.0.1:8780')
    );
    return;
  }

  try {
    initPwa();
    await openDb();
    await mountApp(root);
  } catch (err) {
    showBootError(root, err);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

boot();
