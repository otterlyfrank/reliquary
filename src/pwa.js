/**
 * PWA install helpers — service worker + install prompt + standalone detection.
 */

/** @type {any} */
let deferredPrompt = null;
let swRegistered = false;

const PWA_EVENT = 'reliquary-pwa-change';

const INSTALL_ICON = `<svg class="pwa-install-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 3v10.2l3.6-3.6L17 11l-5 5-5-5 1.4-1.4L11 13.2V3h1zm-7 14h14v2H5v-2z"/></svg>`;

let versionLabel = '';
let versionFetch = null;

function registerFreshServiceWorker(url) {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker
    .register(url, { updateViaCache: 'none' })
    .then((reg) => {
      const ping = () => reg.update().catch(() => {});
      // Don't fight first paint — check after the vault is on screen.
      setTimeout(ping, 2500);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') ping();
      });
      window.addEventListener('focus', ping);
    })
    .catch((err) => {
      console.warn('[Reliquary] service worker registration failed', err);
    });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    try {
      if (sessionStorage.getItem('reliquary-sw-reload') === '1') return;
      sessionStorage.setItem('reliquary-sw-reload', '1');
    } catch {
      /* private mode */
    }
    reloading = true;
    location.reload();
  });
}

export function paintAppVersion() {
  const apply = () => {
    if (!versionLabel) return;
    document.querySelectorAll('[data-app-version]').forEach((el) => {
      el.textContent = versionLabel;
    });
  };
  apply();
  if (versionLabel || versionFetch) return;
  const take = (d) => {
    const v = d && d.version;
    versionLabel = [v && `v${String(v).replace(/^v/i, '')}`, d && d.git].filter(Boolean).join(' · ');
    apply();
  };
  versionFetch = fetch('/api/version', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then(take)
    .catch(() =>
      fetch('/health', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then(take)
    )
    .catch(() => {
      versionFetch = null;
    });
}

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
    registerFreshServiceWorker('./sw.js');
  }
  paintAppVersion();
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
        <div class="piece-card pwa-card" style="max-width:40rem;margin-top:1rem" id="pwa-install-card">
          <h3 style="font-family:var(--serif);margin:0 0 0.35rem">Installed app</h3>
          <p class="muted">Reliquary is running as a standalone window. Your vault stays in this browser profile’s IndexedDB.</p>
          <p class="dim" data-app-version style="margin:0.5rem 0 0"></p>
        </div>`;
    }
    return `<p class="pwa-status dim">Installed · standalone · <span data-app-version></span></p>`;
  }

  const can = canPromptInstall();
  if (mode === 'full') {
    return `
      <div class="piece-card pwa-card" style="max-width:40rem;margin-top:1rem" id="pwa-install-card">
        <h3 style="font-family:var(--serif);margin:0 0 0.35rem">Install Reliquary</h3>
        <p class="muted">Install as an app for your Applications folder / Start menu and pin to the Dock or taskbar — no native binary required.</p>
        <button type="button" class="btn primary pwa-install-cta" id="pwa-install-btn">
          ${INSTALL_ICON}
          <span>${can ? 'Install app now' : 'How to install'}</span>
        </button>
        <div class="pwa-howto-wrap" id="pwa-howto" ${can ? 'hidden' : ''}>
          <ul class="pwa-howto">
            <li><b>Chrome / Edge (desktop)</b> — menu (⋮) → <i>Install Reliquary…</i> / <i>Install page as app</i></li>
            <li><b>Safari (Mac)</b> — File → <i>Add to Dock…</i></li>
            <li><b>iPhone / iPad</b> — Share → <i>Add to Home Screen</i></li>
          </ul>
          <p class="dim" style="margin-top:0.5rem">If the one-click prompt is missing, hard-refresh after <code>./start.sh</code>.</p>
        </div>
        ${can ? `<p class="dim pwa-ready-hint">Install prompt ready — one click uses Chrome/Edge’s native installer.</p>` : ''}
        <p class="dim" style="margin-top:0.75rem">Nothing is uploaded. After you host a public HTTPS URL, the same Install flow works for anyone who opens the site.</p>
      </div>`;
  }

  return `
    <button type="button" class="btn primary pwa-install-side" id="pwa-install-btn" title="${
      can ? 'Install Reliquary as an app' : 'Install Reliquary — opens how-to'
    }">
      ${INSTALL_ICON}
      <span>${can ? 'Install app' : 'Install as app'}</span>
    </button>`;
}

export function openInstallHelp() {
  const card = document.getElementById('pwa-install-card');
  if (card) {
    const howto = document.getElementById('pwa-howto');
    if (howto) howto.hidden = false;
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  document.querySelector('[data-nav="settings"]')?.click();
  setTimeout(() => {
    const howto = document.getElementById('pwa-howto');
    if (howto) howto.hidden = false;
    document.getElementById('pwa-install-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);
}

export function wireInstallButtons(root = document) {
  root.querySelectorAll('#pwa-install-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.preventDefault();
      const r = await promptInstall();
      if (r.ok) return;
      if (document.getElementById('pwa-install-card')) {
        const howto = document.getElementById('pwa-howto');
        if (howto) howto.hidden = false;
        document.getElementById('pwa-install-card')?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      } else {
        openInstallHelp();
      }
    };
  });
  paintAppVersion();
}
