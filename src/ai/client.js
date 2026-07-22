/**
 * Optional AI backend — OpenAI-compatible (Grok, Ollama, etc.)
 */

export async function chatCompletion({
  baseUrl,
  apiKey = '',
  model,
  messages,
  temperature = 0.35,
  timeoutMs = 120000,
}) {
  if (!baseUrl) throw new Error('Configure an LLM base URL in Settings (optional feature).');
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
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
    const content =
      data.choices?.[0]?.message?.content || data.message?.content || data.response || '';
    if (!content) throw new Error('Empty LLM response');
    return { content, model: data.model || model };
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('LLM request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkLlm(baseUrl, apiKey = '') {
  if (!baseUrl) return { ok: false, reason: 'No base URL' };
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return { ok: true, message: 'Reachable' };
    const o = await fetch(baseUrl.replace(/\/v1\/?$/, '') + '/api/tags');
    if (o.ok) return { ok: true, message: 'Ollama reachable' };
    return { ok: false, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err.message };
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
