/**
 * File ingestion — extract plain text from writer formats.
 * Supports: .txt .md .markdown .docx .odt .doc .rtf (best-effort for legacy)
 */

export const SUPPORTED_EXTENSIONS = [
  '.txt',
  '.md',
  '.markdown',
  '.text',
  '.docx',
  '.odt',
  '.doc',
  '.rtf',
];

const EXT_KIND = {
  txt: 'text',
  text: 'text',
  md: 'markdown',
  markdown: 'markdown',
  docx: 'docx',
  odt: 'odt',
  doc: 'doc',
  rtf: 'rtf',
};

/**
 * @param {File} file
 * @returns {Promise<{ name: string, kind: string, text: string, warnings: string[] }>}
 */
export async function parseFile(file) {
  const name = file.name || 'untitled';
  const ext = extOf(name);
  const warnings = [];
  const buf = await file.arrayBuffer();

  if (!buf.byteLength) {
    throw new Error(`“${name}” is empty.`);
  }

  // Sniff Office zip even if extension is wrong
  const kind = sniffKind(ext, buf) || EXT_KIND[ext] || 'unknown';

  let text = '';
  try {
    if (kind === 'markdown' || kind === 'text') {
      text = decodeText(buf);
    } else if (kind === 'docx') {
      text = await parseDocx(buf);
    } else if (kind === 'odt') {
      text = await parseOdt(buf);
    } else if (kind === 'doc') {
      text = parseLegacyDoc(buf);
      warnings.push('Legacy .doc is best-effort. Re-save as .docx for cleaner text.');
    } else if (kind === 'rtf') {
      text = parseRtf(decodeText(buf));
      warnings.push('RTF import is simplified. Prefer .docx or .md when you can.');
    } else {
      text = decodeText(buf);
      if (looksBinary(text)) {
        throw new Error(
          `“${name}” doesn’t look like a text or Word file. Try .docx, .md, or .txt.`
        );
      }
      warnings.push('Unknown type — treated as plain text.');
    }
  } catch (err) {
    const msg = err?.message || String(err);
    throw new Error(friendlyParseError(name, kind, msg));
  }

  text = normalizeExtracted(text);
  if (text.trim().length < 12) {
    throw new Error(
      `“${name}” had almost no readable text. If it’s Word, re-save as .docx. Scanned PDFs aren’t supported yet.`
    );
  }

  return { name, kind, text, warnings };
}

function extOf(name) {
  const base = (name || '').split(/[/\\]/).pop() || '';
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i + 1).toLowerCase() : '';
}

function sniffKind(ext, buf) {
  if (EXT_KIND[ext]) {
    // .doc vs .docx: docx is a zip (PK)
    if (ext === 'doc' && isZip(buf)) return 'docx';
    if (ext === 'docx' && !isZip(buf)) return 'doc';
    return EXT_KIND[ext];
  }
  if (isZip(buf)) {
    // Could be docx or odt — decide later in parse by paths; default docx attempt
    return null; // resolved below
  }
  const head = decodeText(buf.slice(0, Math.min(buf.byteLength, 256)));
  if (head.trimStart().startsWith('{\\rtf')) return 'rtf';
  return null;
}

function isZip(buf) {
  if (buf.byteLength < 4) return false;
  const b = new Uint8Array(buf);
  return b[0] === 0x50 && b[1] === 0x4b; // PK
}

function friendlyParseError(name, kind, msg) {
  if (/DecompressionStream/i.test(msg)) {
    return `Can’t unzip Office files in this browser. Use Chrome, Edge, Firefox, or Brave — or export as .txt / .md.`;
  }
  if (/Not a valid ZIP|Invalid \.docx|Invalid \.odt/i.test(msg)) {
    return `“${name}” isn’t a valid ${kind === 'odt' ? 'OpenDocument' : 'Word'} file. Try “Save As → .docx” or export .txt.`;
  }
  return `Couldn’t read “${name}”: ${msg}`;
}

function normalizeExtracted(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function looksBinary(text) {
  if (!text || text.length < 40) return false;
  let bad = 0;
  const sample = text.slice(0, 2000);
  for (const ch of sample) {
    const c = ch.charCodeAt(0);
    if (c === 0 || (c < 9 && c !== 10 && c !== 13)) bad++;
  }
  return bad / sample.length > 0.08;
}

function decodeText(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // UTF-8 BOM
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(3));
  }
  // UTF-16 LE BOM
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: false }).decode(bytes.subarray(2));
  }
  // UTF-16 BE BOM
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be', { fatal: false }).decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('latin-1').decode(bytes);
  }
}

/**
 * Minimal ZIP reader (store + deflate via DecompressionStream).
 */
async function readZip(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const files = {};
  let eocd = -1;
  const start = Math.max(0, bytes.length - 0x10000);
  for (let i = bytes.length - 22; i >= start; i--) {
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
    if (ptr + 46 > bytes.length) break;
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeader = view.getUint32(ptr + 42, true);
    const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
    const filename = new TextDecoder('utf-8', { fatal: false }).decode(nameBytes);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (localHeader + 30 > bytes.length) continue;
    const localNameLen = view.getUint16(localHeader + 26, true);
    const localExtra = view.getUint16(localHeader + 28, true);
    // Prefer local header sizes when available (data descriptor cases still use central size)
    let csize = compSize;
    const localMethod = view.getUint16(localHeader + 8, true);
    const flags = view.getUint16(localHeader + 6, true);
    if (!(flags & 0x8)) {
      csize = view.getUint32(localHeader + 18, true) || compSize;
    }
    const dataStart = localHeader + 30 + localNameLen + localExtra;
    if (dataStart + csize > bytes.length) continue;
    const compressed = bytes.subarray(dataStart, dataStart + csize);
    const m = method || localMethod;
    let data;
    try {
      if (m === 0) data = compressed;
      else if (m === 8) data = await inflateRaw(compressed);
      else continue;
    } catch {
      continue;
    }
    files[filename] = data;
  }
  return files;
}

async function inflateRaw(compressed) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress Office files (need DecompressionStream).');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([compressed]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

async function parseDocx(buf) {
  if (!isZip(buf)) {
    // Misnamed legacy binary
    return parseLegacyDoc(buf);
  }
  const files = await readZip(buf);
  // Standard path, or rare alternate
  const xmlBytes =
    files['word/document.xml'] ||
    files['Word/document.xml'] ||
    Object.entries(files).find(([k]) => /word\/document\.xml$/i.test(k))?.[1];
  if (!xmlBytes) throw new Error('Invalid .docx — missing word/document.xml');
  const xml = new TextDecoder('utf-8', { fatal: false }).decode(xmlBytes);
  const text = docxXmlToText(xml);
  if (text.trim().length < 12) {
    // try headers/footers for weird templates
    const extras = [];
    for (const [path, data] of Object.entries(files)) {
      if (/word\/(header|footer)\d*\.xml$/i.test(path)) {
        extras.push(docxXmlToText(new TextDecoder('utf-8', { fatal: false }).decode(data)));
      }
    }
    const combined = [text, ...extras].join('\n\n').trim();
    if (combined.length >= 12) return combined;
  }
  return text;
}

function docxXmlToText(xml) {
  // Drop revision deletions if present
  let cleaned = xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '');
  cleaned = cleaned.replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '');

  const parts = [];
  const paras = cleaned.split(/<w:p[\s>]/).slice(1);
  if (paras.length <= 1) {
    const texts = [...cleaned.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) =>
      decodeXml(m[1])
    );
    return texts.join('').replace(/[ \t]+/g, ' ').trim();
  }
  for (const p of paras) {
    // Soft line breaks inside paragraph
    let segment = p
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\b[^/]*\/>/g, '\n')
      .replace(/<w:cr\/>/g, '\n');
    const texts = [...segment.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) =>
      decodeXml(m[1])
    );
    const line = texts.join('').replace(/[ \t]+\n/g, '\n').trimEnd();
    if (line.trim()) parts.push(line);
    else parts.push(''); // preserve blank paras lightly
  }
  return parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function parseOdt(buf) {
  if (!isZip(buf)) throw new Error('Invalid .odt');
  const files = await readZip(buf);
  const xmlBytes = files['content.xml'] || files['Content.xml'];
  if (!xmlBytes) throw new Error('Invalid .odt — missing content.xml');
  const xml = new TextDecoder('utf-8', { fatal: false }).decode(xmlBytes);
  return odtXmlToText(xml);
}

function odtXmlToText(xml) {
  let body = xml;
  body = body.replace(/<text:line-break\/>/g, '\n');
  body = body.replace(/<text:tab\/>/g, '\t');
  body = body.replace(/<text:s\b[^/]*\/>/g, ' ');
  body = body.replace(/<text:s\b[^>]*\/>/g, ' ');
  const blocks = [];
  const re = /<text:(?:h|p)\b[^>]*>([\s\S]*?)<\/text:(?:h|p)>/g;
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
  const bytes = new Uint8Array(buf);
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
    .filter((l) => l.length > 2 && /[A-Za-z\u00C0-\u024F]/.test(l))
    .join('\n\n');
  if (cleaned.length > 200) {
    return (
      cleaned +
      '\n\n---\n[Note: Legacy .doc text was extracted best-effort. Prefer .docx or .md for accuracy.]'
    );
  }
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
  return a2 + '\n\n---\n[Note: Legacy .doc extraction is limited. Prefer .docx or .md.]';
}

/** Very small RTF → text (enough for Notes exports and rough drafts). */
function parseRtf(rtf) {
  let s = String(rtf || '');
  if (!s.includes('\\rtf')) return s;
  s = s.replace(/\\par[d]?\b/g, '\n');
  s = s.replace(/\\line\b/g, '\n');
  s = s.replace(/\\tab\b/g, '\t');
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\u(-?\d+)\??/g, (_, n) => {
    let code = parseInt(n, 10);
    if (code < 0) code += 65536;
    try {
      return String.fromCharCode(code);
    } catch {
      return '';
    }
  });
  // strip groups and control words
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, '');
  s = s.replace(/[{}]/g, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function isSupportedFile(file) {
  const n = (file.name || '').toLowerCase();
  if (SUPPORTED_EXTENSIONS.some((ext) => n.endsWith(ext))) return true;
  const t = (file.type || '').toLowerCase();
  return (
    t === 'text/plain' ||
    t === 'text/markdown' ||
    t === 'text/rtf' ||
    t === 'application/rtf' ||
    t === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    t === 'application/msword' ||
    t === 'application/vnd.oasis.opendocument.text'
  );
}

/** Human-facing format list for UI. */
export function formatHelpLine() {
  return 'Word (.docx), text, Markdown, OpenDocument (.odt), RTF · old .doc is best-effort';
}
