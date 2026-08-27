/**
 * Optional AI — Ollama (local) or xAI Grok via the Reliquary proxy.
 * Offline split never needs this.
 */

export const LLM_PROVIDERS = [
  {
    id: 'off',
    label: 'Off — offline only',
    hint: 'Drafts never leave this browser. The cutter still rips dialogue and idea-dumps.',
  },
  {
    id: 'ollama',
    label: 'Ollama (this machine)',
    hint: 'No leakage. Pull an 8B+ instruct model (llama3.1, qwen2.5:7b / 14b). llama3.2 3B is too small.',
  },
  {
    id: 'xai',
    label: 'xAI Grok API',
    hint: 'Drafts go to xAI. Follow the numbered API steps below. They do not train on API traffic unless you opt in.',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    hint: 'Advanced — your URL. The Reliquary proxy will not forward this (no open proxy).',
  },
];

export const XAI_MODELS = [
  { id: 'grok-4.6', label: 'grok-4.6 (flagship)' },
  { id: 'grok-4.5', label: 'grok-4.5' },
  { id: 'grok-4.3', label: 'grok-4.3 (cheaper)' },
];

export const OLLAMA_DEFAULT_HOST = 'http://127.0.0.1:11434';
export const XAI_DEFAULT_BASE = 'https://api.x.ai/v1';
export const XAI_DEFAULT_MODEL = 'grok-4.6';

/** @param {Record<string, any>} settings */
export function inferProvider(settings = {}) {
  const set = String(settings.llmProvider || '').trim();
  if (LLM_PROVIDERS.some((p) => p.id === set)) return set;
  const url = String(settings.llmBaseUrl || '').toLowerCase();
  if (!url) return 'off';
  if (url.includes('api.x.ai')) return 'xai';
  if (url.includes('11434') || url.includes('ollama')) return 'ollama';
  return 'custom';
}

/** True when Reliquary is allowed to call an LLM. */
export function llmEnabled(settings = {}) {
  const provider = inferProvider(settings);
  if (provider === 'off') return false;
  if (provider === 'xai' && !settings.llmPrivacyAck) return false;
  if (provider === 'ollama') return true;
  if (provider === 'xai') return true;
  return Boolean(String(settings.llmBaseUrl || '').trim());
}

export function ollamaModelTooSmall(model) {
  const s = String(model || '').toLowerCase();
  if (!s) return false;
  if (/:([1-3](?:\.\d+)?)b\b/.test(s)) return true;
  if (/\b(tinyllama|phi-?2|gemma:?2b|qwen.*:1\.5b|qwen.*:3b)\b/.test(s)) return true;
  // llama3.2 default tag is 3B (including :latest)
  if (/llama3\.2/.test(s) && !/:(7|8|11|13|14|20|27|32|70)/.test(s)) return true;
  return false;
}

export function ollamaSizeWarning(model, details = {}) {
  const ps = String(details.parameterSize || details.parameter_size || '');
  const n = parseFloat(ps);
  if (Number.isFinite(n) && n > 0 && n < 7) {
    return `${model} is ${ps} — use 8B+ for fragmenting. llama3.2 3B is too small.`;
  }
  if (ollamaModelTooSmall(model)) {
    return `${model} looks smaller than 8B. Pull llama3.1 or qwen2.5:7b / 14b.`;
  }
  return '';
}

export function pickOllamaDefault(models = []) {
  const list = Array.isArray(models) ? models : [];
  const scored = list.map((m) => {
    const id = m.id || m.name || '';
    const n = parseFloat(m.parameterSize || m.parameter_size || '') || 0;
    return { id, n, small: ollamaModelTooSmall(id) || (n > 0 && n < 7) };
  });
  const ok = scored.filter((m) => m.id && !m.small).sort((a, b) => b.n - a.n);
  if (ok.length) return ok[0].id;
  return scored.find((m) => m.id)?.id || 'llama3.1';
}

let proxyCache = { t: 0, data: null };

export async function getProxyStatus() {
  if (proxyCache.data && Date.now() - proxyCache.t < 4000) return proxyCache.data;
  try {
    const res = await fetch('/api/llm/status', { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error('no proxy');
    const data = await res.json();
    const out = { ...data, proxy: !!data.proxy, ok: !!data.ok };
    proxyCache = { t: Date.now(), data: out };
    return out;
  } catch {
    const out = { ok: false, proxy: false };
    proxyCache = { t: Date.now(), data: out };
    return out;
  }
}

export function invalidateProxyStatus() {
  proxyCache = { t: 0, data: null };
}

export async function listLlmModels(provider, settings = {}) {
  if (provider === 'xai') {
    const proxy = await getProxyStatus();
    if (proxy.proxy) {
      try {
        const res = await fetch('/api/llm/models?provider=xai', { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        if (Array.isArray(data.models) && data.models.length) return data;
      } catch {
        /* fall through */
      }
    }
    return { ok: true, provider: 'xai', models: XAI_MODELS };
  }
  if (provider === 'ollama') {
    const proxy = await getProxyStatus();
    if (proxy.proxy) {
      try {
        const res = await fetch('/api/llm/models?provider=ollama', { signal: AbortSignal.timeout(5000) });
        return await res.json();
      } catch (err) {
        return { ok: false, provider: 'ollama', models: [], error: err.message };
      }
    }
    const host = String(settings.llmBaseUrl || OLLAMA_DEFAULT_HOST)
      .replace(/\/v1\/?$/, '')
      .replace(/\/$/, '');
    try {
      const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      const data = await res.json();
      const models = (data.models || []).map((m) => ({
        id: m.name || m.model,
        label: m.name || m.model,
        parameterSize: m.details?.parameter_size || '',
        family: m.details?.family || '',
        size: m.size || 0,
      }));
      return { ok: true, provider: 'ollama', models };
    } catch (err) {
      return { ok: false, provider: 'ollama', models: [], error: err.message };
    }
  }
  return { ok: true, provider, models: [] };
}

function readContent(data) {
  return data?.choices?.[0]?.message?.content || data.message?.content || data.response || '';
}

/**
 * Chat completion. Uses the local Reliquary proxy for Ollama/xAI when start.sh is running.
 */
export async function chatCompletion({
  provider,
  baseUrl,
  apiKey = '',
  model,
  messages,
  temperature = 0.35,
  timeoutMs = 180000,
  reasoningEffort,
}) {
  const prov = provider || inferProvider({ llmBaseUrl: baseUrl, llmProvider: provider });
  if (prov === 'off') throw new Error('AI is off. Pick Ollama or xAI in Settings.');
  if (!model) throw new Error('Pick a model in Settings.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const proxy = await getProxyStatus();
    if (proxy.proxy && (prov === 'ollama' || prov === 'xai')) {
      const headers = { 'Content-Type': 'application/json' };
      if (prov === 'xai' && apiKey && !proxy.xai?.keyConfigured) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      const payload = { provider: prov, model, messages, temperature };
      if (prov === 'xai') payload.reasoning_effort = reasoningEffort || 'low';
      const res = await fetch('/api/llm/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const zdr = res.headers.get('X-Reliquary-ZDR') === '1';
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        let msg = t.slice(0, 400);
        try {
          const j = JSON.parse(t);
          msg = j.error || j.message || msg;
        } catch {
          /* raw */
        }
        throw new Error(msg || `LLM error ${res.status}`);
      }
      const data = await res.json();
      if (data && data.ok === false && data.error) throw new Error(data.error);
      const content = readContent(data);
      if (!content) throw new Error('Empty LLM response');
      return { content, model: data.model || model, provider: prov, zdr };
    }

    if (!baseUrl) {
      throw new Error(
        prov === 'xai'
          ? 'Start Reliquary with ./start.sh so it can hold your xAI key, or set a base URL.'
          : 'Configure an LLM in Settings.'
      );
    }
    const url = `${String(baseUrl).replace(/\/$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, temperature, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`LLM error ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = readContent(data);
    if (!content) throw new Error('Empty LLM response');
    return { content, model: data.model || model, provider: prov, zdr: false };
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('LLM request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function chatFromSettings(settings, opts) {
  const provider = inferProvider(settings);
  return chatCompletion({
    provider,
    baseUrl: settings.llmBaseUrl,
    apiKey: settings.llmApiKey,
    model: settings.llmModel,
    messages: opts.messages,
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs,
    reasoningEffort: opts.reasoningEffort,
  });
}

export async function checkLlm(settingsOrUrl, apiKey = '') {
  const settings =
    typeof settingsOrUrl === 'string'
      ? {
          llmBaseUrl: settingsOrUrl,
          llmApiKey: apiKey,
          llmProvider: inferProvider({ llmBaseUrl: settingsOrUrl }),
        }
      : settingsOrUrl || {};
  const provider = inferProvider(settings);
  if (provider === 'off') return { ok: false, reason: 'AI is off' };
  if (provider === 'xai' && !settings.llmPrivacyAck) {
    return { ok: false, reason: 'Acknowledge the xAI privacy note first' };
  }
  invalidateProxyStatus();
  const proxy = await getProxyStatus();
  try {
    if (provider === 'ollama') {
      const listed = await listLlmModels('ollama', settings);
      if (!listed.ok || !listed.models?.length) {
        return {
          ok: false,
          reason: listed.error || 'Ollama is not reachable. Is it running?',
          proxy: !!proxy.proxy,
        };
      }
      const warn = ollamaSizeWarning(settings.llmModel || '', {
        parameterSize: listed.models.find((m) => m.id === settings.llmModel)?.parameterSize,
      });
      return {
        ok: true,
        message: `Ollama · ${listed.models.length} model(s)${warn ? ` · ${warn}` : ''}`,
        warning: warn,
        models: listed.models,
        proxy: !!proxy.proxy,
      };
    }
    if (provider === 'xai') {
      if (!settings.llmApiKey && !proxy.xai?.keyConfigured) {
        return {
          ok: false,
          reason:
            'No xAI API key yet. Follow “How to connect the xAI Grok API” in Settings: create a key at console.x.ai, put XAI_API_KEY in Reliquary/.env, restart, then Test — or paste the key in the field.',
        };
      }
      const { content, zdr } = await chatFromSettings(settings, {
        messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
        temperature: 0,
        timeoutMs: 45000,
      });
      const ping = /pong/i.test(content);
      return {
        ok: true,
        message: `xAI ${settings.llmModel || XAI_DEFAULT_MODEL} reachable${
          zdr ? ' · Zero Data Retention is on for this team' : ' · default ~30-day API logs (no training)'
        }${ping ? '' : ' (unexpected ping reply)'}`,
        zdr,
        proxy: !!proxy.proxy,
        keyOnMachine: !!proxy.xai?.keyConfigured,
      };
    }
    if (!settings.llmBaseUrl) return { ok: false, reason: 'No base URL' };
    const headers = {};
    if (settings.llmApiKey) headers.Authorization = `Bearer ${settings.llmApiKey}`;
    const res = await fetch(`${String(settings.llmBaseUrl).replace(/\/$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return { ok: true, message: 'Reachable' };
    return { ok: false, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err.message || String(err), proxy: !!proxy.proxy };
  }
}

export function developPrompt(pieces, intent = 'structure') {
  const body = pieces
    .map((p, i) => `### Piece ${i + 1}${p.labels?.length ? ` [${p.labels.join(', ')}]` : ''}\n${p.text}`)
    .join('\n\n');
  return `You are a careful literary development assistant. Preserve the writer's voice. Do not rewrite everything — propose structure and light moves.

Intent: ${intent}

Source pieces:
${body}

Respond in Markdown with:
## Structural suggestion
## How the pieces relate
## Optional light rewrites (only if helpful; keep voice)
## Questions for the writer
`;
}

export function parseJsonArray(text) {
  let s = (text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  const data = JSON.parse(s);
  if (!Array.isArray(data)) throw new Error('Expected JSON array');
  return data;
}
