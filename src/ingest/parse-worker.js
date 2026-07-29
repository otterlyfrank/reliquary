/**
 * Worker: extract plain text from ArrayBuffer for simple kinds.
 * Office formats stay on the main thread (ZIP + inflate).
 */
self.onmessage = (ev) => {
  const { id, name, kind, buffer } = ev.data || {};
  try {
    const text = decodeBuffer(buffer);
    const normalized = normalize(text);
    if (normalized.trim().length < 12) {
      self.postMessage({ id, error: `“${name}” had almost no readable text.` });
      return;
    }
    self.postMessage({
      id,
      ok: true,
      result: { name, kind: kind || 'text', text: normalized, warnings: [] },
    });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};

function decodeBuffer(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: false }).decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function normalize(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}
