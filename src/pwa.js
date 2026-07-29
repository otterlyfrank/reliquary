/**
 * PWA install helpers — service worker + install prompt + standalone detection.
 */

/** @type {any} */
let deferredPrompt = null;
let swRegistered = false;

const PWA_EVENT = 'reliquary-pwa-change';

export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    // @ts-expect-error iOS Safari
    Boolean(navigator.standalone)
  );
}

export function canPromptInstall() {
  return Boolean(deferredPrompt);
}

export function initPwa() {
  if (location.protocol === 'file:') return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.dispatchEvent(new CustomEvent(PWA_EVENT));
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    window.dispatchEvent(new CustomEvent(PWA_EVENT));
  });

  if ('serviceWorker' in navigator && !swRegistered) {
    swRegistered = true;
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[Reliquary] service worker registration failed', err);
    });
  }
}

export async function promptInstall() {
  if (!deferredPrompt) {
    return { ok: false, reason: 'no-prompt' };
  }
  const evt = deferredPrompt;
  deferredPrompt = null;
  evt.prompt();
  const choice = await evt.userChoice;
  window.dispatchEvent(new CustomEvent(PWA_EVENT));
  return { ok: choice.outcome === 'accepted', reason: choice.outcome };
}

/**
 * @param {'compact' | 'full'} mode
 */
export function installUiHtml(mode = 'compact') {
  if (isStandalone()) {
    if (mode === 'full') {
      return `
        <div class="piece-card pwa-card" style="max-width:40rem;margin-top:1rem">
          <h3 style="font-family:var(--serif);margin:0 0 0.35rem">Installed app</h3>
          <p class="muted">Reliquary is running as a standalone window. Your vault stays in this browser profile’s IndexedDB.</p>
        </div>`;
    }
    return `<p class="pwa-status dim">Installed · standalone</p>`;
  }

  const can = canPromptInstall();
  if (mode === 'full') {
    return `
      <div class="piece-card pwa-card" style="max-width:40rem;margin-top:1rem" id="pwa-install-card">
        <h3 style="font-family:var(--serif);margin:0 0 0.35rem">Install Reliquary</h3>
        <p class="muted">Install as an app for your Applications folder / Start menu and pin to the Dock or taskbar — no native binary required.</p>
        ${
          can
            ? `<button type="button" class="btn primary" id="pwa-install-btn">Install app</button>`
            : `<p class="dim">Use your browser’s install control when it appears, or:</p>
               <ul class="pwa-howto">
                 <li><b>Chrome / Edge (desktop)</b> — menu (⋮) → <i>Install Reliquary…</i> / <i>Install page as app</i></li>
                 <li><b>Safari (Mac)</b> — File → <i>Add to Dock…</i></li>
                 <li><b>iPhone / iPad</b> — Share → <i>Add to Home Screen</i></li>
               </ul>
               <button type="button" class="btn" id="pwa-install-btn" hidden>Install app</button>`
        }
        <p class="dim" style="margin-top:0.75rem">Nothing is uploaded. After you host a public HTTPS URL, the same Install flow works for anyone who opens the site.</p>
      </div>`;
  }

  if (can) {
    return `<button type="button" class="btn primary pwa-install-side" id="pwa-install-btn">Install app</button>`;
  }
  return `<p class="pwa-status dim"><a href="#pwa-install-card" data-nav="settings">Install as app…</a></p>`;
}

export function wireInstallButtons(root = document) {
  root.querySelectorAll('#pwa-install-btn').forEach((btn) => {
    btn.onclick = async () => {
      const r = await promptInstall();
      if (r.ok) return;
      if (r.reason === 'no-prompt') {
        document.getElementById('pwa-install-card')?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      }
    };
  });
}
