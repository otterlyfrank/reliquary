import { openDb } from './storage/db.js';
import { mountApp } from './app.js';

async function boot() {
  const root = document.getElementById('app');
  try {
    await openDb();
    await mountApp(root);
  } catch (err) {
    console.error(err);
    root.innerHTML = `
      <div class="boot">
        <p class="boot-mark">Reliquary</p>
        <p class="muted">Failed to start: ${escapeHtml(err.message || String(err))}</p>
        <p class="dim">Needs a modern browser with IndexedDB. Serve over http:// not file://.</p>
      </div>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

boot();
