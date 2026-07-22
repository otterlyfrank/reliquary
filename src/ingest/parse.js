/**
 * File ingestion — extract plain text from writer formats.
 * Supports: .txt .md .docx .odt .doc (best-effort for legacy .doc)
 */

/**
 * @param {File} file
 * @returns {Promise<{ name: string, kind: string, text: string }>}
 */
export async function parseFile(file) {
  const name = file.name || 'untitled';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const buf = await file.arrayBuffer();

  if (ext === 'txt' || ext === 'md' || ext === 'markdown' || ext === 'text') {
    return { name, kind: ext === 'md' || ext === 'markdown' ? 'markdown' : 'text', text: decodeText(buf) };
  }
  if (ext === 'docx') {
    return { name, kind: 'docx', text: await parseDocx(buf) };
  }
  if (ext === 'odt') {
    return { name, kind: 'odt', text: await parseOdt(buf) };
  }
  if (ext === 'doc') {
    return { name, kind: 'doc', text: parseLegacyDoc(buf) };
  }
  // Fallback: treat as text
  return { name, kind: 'unknown', text: decodeText(buf) };
}

function decodeText(buf) {
  const bytes = new Uint8Array(buf);
  // strip UTF-8 BOM
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start));
  } catch {
    return new TextDecoder('latin-1').decode(bytes);
  }
}

async function inflateZip(buf) {
  // Prefer browser DecompressionStream is not enough for zip — use JSZip-like manual or dynamic import
  // Lightweight: use fflate-free approach via native if available, else simple ZIP reader
  return readZip(buf);
}

/**
 * Minimal ZIP reader (store + deflate via DecompressionStream when available).
 */
async function readZip(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const files = {};
  // Find end of central directory
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP (docx/odt)');
  const centralOffset = view.getUint32(eocd + 16, true);
  const entries = view.getUint16(eocd + 10, true);
  let ptr = centralOffset;
  for (let e = 0; e < entries; e++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeader = view.getUint32(ptr + 42, true);
    const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
    const filename = new TextDecoder().decode(nameBytes);
    ptr += 46 + nameLen + extraLen + commentLen;

    const localNameLen = view.getUint16(localHeader + 26, true);
    const localExtra = view.getUint16(localHeader + 28, true);
    const dataStart = localHeader + 30 + localNameLen + localExtra;
    const compressed = bytes.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = await inflateRaw(compressed);
    } else {
      continue;
    }
    files[filename] = data;
  }
  return files;
}

async function inflateRaw(compressed) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress Office files (need DecompressionStream). Use .txt or .md, or a modern Chrome/Edge/Firefox.');
  }
  // raw deflate in zip — use deflate-raw
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([compressed]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

async function parseDocx(buf) {
  const files = await inflateZip(buf);
  const xmlBytes = files['word/document.xml'];
  if (!xmlBytes) throw new Error('Invalid .docx — missing word/document.xml');
  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  return docxXmlToText(xml);
}

function docxXmlToText(xml) {
  // Paragraphs: w:p, text: w:t, breaks w:br
  const parts = [];
  const paras = xml.split(/<w:p[\s>]/).slice(1);
  if (paras.length <= 1) {
    // fallback: all w:t
    const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => decodeXml(m[1]));
    return texts.join('').replace(/\s+/g, ' ').trim();
  }
  for (const p of paras) {
    const texts = [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => decodeXml(m[1]));
    const line = texts.join('');
    if (/<w:br\b/.test(p) || /w:type="page"/.test(p)) {
      parts.push(line);
      parts.push('\n\n');
    } else {
      parts.push(line);
      parts.push('\n\n');
    }
  }
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

async function parseOdt(buf) {
  const files = await inflateZip(buf);
  const xmlBytes = files['content.xml'];
  if (!xmlBytes) throw new Error('Invalid .odt — missing content.xml');
  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  return odtXmlToText(xml);
}

function odtXmlToText(xml) {
  // text:p, text:h, text:s, text:line-break
  let body = xml;
  body = body.replace(/<text:line-break\/>/g, '\n');
  body = body.replace(/<text:tab\/>/g, '\t');
  body = body.replace(/<text:s[^/]*\/>/g, ' ');
  const blocks = [];
  const re = /<text:(?:h|p)[^>]*>([\s\S]*?)<\/text:(?:h|p)>/g;
  let m;
  while ((m = re.exec(body))) {
    const inner = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    blocks.push(inner.trim());
  }
  if (!blocks.length) {
    return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return blocks.filter(Boolean).join('\n\n');
}

function parseLegacyDoc(buf) {
  // Crude extraction of printable UTF-16LE / ASCII runs from OLE .doc
  const bytes = new Uint8Array(buf);
  // Try UTF-16LE strings
  let u16 = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8);
    if (c === 0) {
      u16 += '\n';
      continue;
    }
    if (c >= 32 && c < 0xfffe) u16 += String.fromCharCode(c);
    else u16 += '\n';
  }
  u16 = u16.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  const cleaned = u16
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 2 && /[A-Za-z]/.test(l))
    .join('\n\n');
  if (cleaned.length > 200) {
    return (
      cleaned +
      '\n\n---\n[Note: Legacy .doc text was extracted best-effort. Prefer .docx or .md for accuracy.]'
    );
  }
  // ASCII fallback
  let ascii = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 10 || c === 13) ascii += '\n';
    else if (c >= 32 && c < 127) ascii += String.fromCharCode(c);
    else ascii += ' ';
  }
  const a2 = ascii.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (a2.length < 80) {
    throw new Error(
      'Could not extract useful text from this .doc. Please re-save as .docx, .odt, .md, or .txt.'
    );
  }
  return (
    a2 +
    '\n\n---\n[Note: Legacy .doc extraction is limited. Prefer .docx or .md.]'
  );
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx', '.odt', '.doc'];

export function isSupportedFile(file) {
  const n = (file.name || '').toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => n.endsWith(ext));
}
