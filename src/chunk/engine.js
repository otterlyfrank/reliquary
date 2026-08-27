/**
 * Offline chunking — structural units + size fine-tuning.
 * LLM-free by default; optional AI path can still refine via ai/client.js.
 */

/** @typedef {'sentence'|'paragraph'|'section'|'page'|'hybrid'} ChunkUnit */
/** @typedef {'fine'|'medium'|'coarse'|'custom'} ChunkSizePreset */
/** @typedef {'conservative'|'balanced'|'atomic'} LegacyChunkMode */

export const CHUNK_UNITS = [
  {
    id: 'sentence',
    label: 'Sentence by sentence',
    hint: 'Smallest pieces — one sentence (or short run) at a time',
  },
  {
    id: 'paragraph',
    label: 'Paragraph by paragraph',
    hint: 'Natural blocks — blank-line separated paragraphs',
  },
  {
    id: 'section',
    label: 'By section / heading',
    hint: 'Keep chapters and # headings together longer',
  },
  {
    id: 'page',
    label: 'Page by page',
    hint: 'Like print pages — form-feeds, page breaks, or ~N words',
  },
  {
    id: 'hybrid',
    label: 'Smart hybrid',
    hint: 'Cut into reorderable cards — dialogue, idea dumps, headings, size limits',
  },
];

export const CHUNK_SIZE_PRESETS = [
  {
    id: 'fine',
    label: 'Fine — short pieces',
    hint: 'Default — short fragments you can shuffle',
    minChars: 12,
    maxChars: 420,
    pageWords: 120,
  },
  {
    id: 'medium',
    label: 'Medium — balanced',
    hint: 'Typical reading chunks',
    minChars: 40,
    maxChars: 1800,
    pageWords: 300,
  },
  {
    id: 'coarse',
    label: 'Coarse — longer pieces',
    hint: 'Fewer cards; more context per piece',
    minChars: 80,
    maxChars: 4200,
    pageWords: 500,
  },
  {
    id: 'custom',
    label: 'Custom limits',
    hint: 'You set min / max characters (and page length)',
    minChars: 40,
    maxChars: 1800,
    pageWords: 300,
  },
];

/**
 * Resolve effective offline chunk options from settings + optional per-import overrides.
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} [overrides]
 */
export function resolveChunkOptions(settings = {}, overrides = {}) {
  const merged = { ...settings, ...overrides };

  // Migrate legacy chunkMode → unit + size if new fields missing
  let unit = merged.chunkUnit;
  let sizePreset = merged.chunkSizePreset;
  if (!unit || !CHUNK_UNITS.some((u) => u.id === unit)) {
    unit = legacyModeToUnit(merged.chunkMode);
  }
  if (!sizePreset || !CHUNK_SIZE_PRESETS.some((p) => p.id === sizePreset)) {
    sizePreset = merged.chunkMode ? legacyModeToSize(merged.chunkMode) : 'fine';
  }

  const preset =
    CHUNK_SIZE_PRESETS.find((p) => p.id === sizePreset) || CHUNK_SIZE_PRESETS[1];

  let minChars = Number(merged.chunkMinChars);
  let maxChars = Number(merged.chunkMaxChars);
  let pageWords = Number(merged.chunkPageWords);

  if (sizePreset !== 'custom' || !Number.isFinite(minChars) || minChars < 1) {
    minChars = preset.minChars;
  }
  if (sizePreset !== 'custom' || !Number.isFinite(maxChars) || maxChars < 40) {
    maxChars = preset.maxChars;
  }
  if (sizePreset !== 'custom' || !Number.isFinite(pageWords) || pageWords < 40) {
    pageWords = preset.pageWords;
  }

  // Safety clamps
  minChars = Math.max(1, Math.min(2000, Math.floor(minChars)));
  maxChars = Math.max(minChars + 20, Math.min(20000, Math.floor(maxChars)));
  pageWords = Math.max(40, Math.min(2000, Math.floor(pageWords)));

  const respectPageBreaks = merged.respectPageBreaks !== false;
  // Default: rip dialogue onto its own cards (fragment desk, not scenes)
  const keepDialogueTogether = merged.keepDialogueTogether === true;

  return {
    unit,
    sizePreset,
    minChars,
    maxChars,
    pageWords,
    respectPageBreaks,
    keepDialogueTogether,
    // legacy mirror for display / AI prompt
    mode: sizePresetToLegacy(sizePreset),
    sourceName: merged.sourceName || '',
  };
}

function legacyModeToUnit(mode) {
  // All legacy modes used hybrid structural split; size differed
  return 'hybrid';
}

function legacyModeToSize(mode) {
  if (mode === 'atomic') return 'fine';
  if (mode === 'conservative') return 'coarse';
  return 'medium';
}

function sizePresetToLegacy(sizePreset) {
  if (sizePreset === 'fine') return 'atomic';
  if (sizePreset === 'coarse') return 'conservative';
  return 'balanced';
}

/**
 * Human-readable one-liner for dig UI / stats.
 */
export function describeChunkOptions(opts) {
  const o = typeof opts.unit === 'string' && opts.maxChars ? opts : resolveChunkOptions(opts);
  const unit = CHUNK_UNITS.find((u) => u.id === o.unit)?.label || o.unit;
  const size = CHUNK_SIZE_PRESETS.find((p) => p.id === o.sizePreset)?.label || o.sizePreset;
  if (o.unit === 'page') {
    return `${unit} · ~${o.pageWords} words/page`;
  }
  if (o.sizePreset === 'custom') {
    return `${unit} · ${o.minChars}–${o.maxChars} chars`;
  }
  return `${unit} · ${size}`;
}

/**
 * Rough estimate of how many pieces a text would yield (offline, cheap).
 */
export function estimatePieceCount(text, settingsOrOpts = {}) {
  const opts = resolveChunkOptions(settingsOrOpts);
  const cleaned = normalizeSource(text);
  if (!cleaned.trim()) return 0;
  const n = cleaned.length;
  if (opts.unit === 'sentence') {
    const s = (cleaned.match(/[.!?]+/g) || []).length || Math.ceil(n / 80);
    return Math.max(1, Math.round(s * 0.9));
  }
  if (opts.unit === 'paragraph') {
    const p = cleaned.split(/\n{2,}/).filter((x) => x.trim()).length;
    return Math.max(1, p);
  }
  if (opts.unit === 'page') {
    const words = cleaned.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.ceil(words / opts.pageWords));
  }
  if (opts.unit === 'section') {
    const heads = (cleaned.match(/\n#{1,6}\s/g) || []).length + 1;
    return Math.max(1, heads);
  }
  // hybrid: ballpark from maxChars
  return Math.max(1, Math.round(n / Math.max(200, opts.maxChars * 0.55)));
}

/**
 * @param {string} text
 * @param {Record<string, any>} optsOrSettings — resolveChunkOptions input or full settings
 * @returns {{ text: string, preview: string, isLarge: boolean, labels: string[], tags: string[], aiHint?: string }[]}
 */
export function chunkDocument(text, optsOrSettings = {}) {
  const opts = resolveChunkOptions(optsOrSettings, {
    sourceName: optsOrSettings.sourceName,
  });
  // Allow direct pass of already-resolved options
  if (optsOrSettings.unit && optsOrSettings.maxChars && !optsOrSettings.chunkMode) {
    Object.assign(opts, {
      unit: optsOrSettings.unit,
      minChars: optsOrSettings.minChars ?? opts.minChars,
      maxChars: optsOrSettings.maxChars ?? opts.maxChars,
      pageWords: optsOrSettings.pageWords ?? opts.pageWords,
      respectPageBreaks: optsOrSettings.respectPageBreaks !== false,
      keepDialogueTogether: optsOrSettings.keepDialogueTogether === true,
      sourceName: optsOrSettings.sourceName || opts.sourceName,
    });
  }

  const sourceName = opts.sourceName || optsOrSettings.sourceName || '';
  const cleaned = normalizeSource(text);
  if (!cleaned.trim()) return [];

  let blocks;
  switch (opts.unit) {
    case 'sentence':
      blocks = splitAllSentences(cleaned, opts);
      blocks = packSmallRuns(blocks, opts);
      break;
    case 'paragraph':
      blocks = splitParagraphs(cleaned, opts);
      blocks = applyFragmentCuts(blocks, opts, cleaned);
      blocks = mergeTiny(blocks, opts.minChars, opts);
      blocks = splitOversized(blocks, opts);
      break;
    case 'section':
      blocks = splitSections(cleaned, opts);
      blocks = mergeTiny(blocks, opts.minChars);
      blocks = splitOversized(blocks, opts);
      break;
    case 'page':
      blocks = splitPages(cleaned, opts);
      blocks = mergeTiny(blocks, Math.min(opts.minChars, 60));
      break;
    case 'hybrid':
    default:
      blocks = structuralSplit(cleaned, opts);
      blocks = applyFragmentCuts(blocks, opts, cleaned);
      blocks = mergeTiny(blocks, opts.minChars, opts);
      blocks = splitOversized(blocks, opts);
      break;
  }

  blocks = blocks.map((b) => b.trim()).filter((b) => b.length >= 8 && !isJunkPiece(b));

  return blocks.map((block) => {
    const labels = heuristicLabels(block);
    const isLarge = block.length >= 1200 || block.split(/\n/).length >= 24;
    return {
      text: block,
      preview: block.slice(0, 320).replace(/\s+/g, ' ').trim(),
      isLarge,
      labels,
      tags: sourceName ? [`src:${sourceName.slice(0, 40)}`] : [],
      aiHint: '',
    };
  });
}

function normalizeSource(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\t/g, '  ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function markPageBreaks(text, respect) {
  if (!respect) return text;
  return text
    .replace(/\f/g, '\n\n<<<PAGE>>>\n\n')
    .replace(/\n{0,2}[-=_*]{3,}\s*(?:page\s*)?\d+\s*[-=_*]{3,}\n{0,2}/gi, '\n\n<<<PAGE>>>\n\n')
    .replace(/\n{0,2}(?:page\s+)\d+\s*\n/gi, '\n\n<<<PAGE>>>\n\n')
    .replace(/\n{0,2}---+\n{0,2}/g, '\n\n<<<PAGE>>>\n\n');
}

/** Sentence unit */
function splitAllSentences(text, opts) {
  text = markPageBreaks(text, opts.respectPageBreaks);
  const parts = text.split(/\n*<<<PAGE>>>\n*/);
  const out = [];
  for (const part of parts) {
    const sents = tokenizeSentences(part);
    if (!sents.length && part.trim()) out.push(part.trim());
    else out.push(...sents);
  }
  return out;
}

function tokenizeSentences(text) {
  const t = text.trim();
  if (!t) return [];
  // Keep abbreviations from over-splitting lightly; still simple offline
  const raw =
    t.match(/[^.!?]+[.!?]+(?:["'”’)\]]+)?(?:\s+|$)|[^.!?]+$/g) || [t];
  return raw.map((s) => s.trim()).filter((s) => s.length >= 2);
}

/** Pack short consecutive sentences up to minChars / dialogue runs */
function packSmallRuns(blocks, opts) {
  const out = [];
  let buf = '';
  for (const b of blocks) {
    const isDlg = looksLikeDialogue(b);
    const bufDlg = buf && looksLikeDialogue(buf);
    const canPackDialogue = opts.keepDialogueTogether && isDlg && (bufDlg || !buf);
    const room = !buf || (buf + ' ' + b).length <= Math.max(opts.minChars * 2, Math.min(opts.maxChars, 320));

    if (!buf) {
      buf = b;
      continue;
    }
    if ((buf.length < opts.minChars || canPackDialogue) && room && (buf + ' ' + b).length <= opts.maxChars) {
      buf = buf + (canPackDialogue || isDlg ? '\n' : ' ') + b;
    } else {
      out.push(buf);
      buf = b;
    }
  }
  if (buf) out.push(buf);
  // Still split anything over max
  const final = [];
  for (const b of out) {
    if (b.length <= opts.maxChars) final.push(b);
    else final.push(...splitSentencesToMax(b, opts.maxChars));
  }
  return final;
}

function looksLikeDialogue(t) {
  const s = t.trim();
  return /^["“«]/.test(s) || /["”»]\s*$/.test(s) || /^(["“].+["”]|—\s)/.test(s);
}

/** Paragraph unit */
function splitParagraphs(text, opts) {
  text = markPageBreaks(text, opts.respectPageBreaks);
  const chunks = [];
  for (const page of text.split(/\n*<<<PAGE>>>\n*/)) {
    const paras = page.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    chunks.push(...paras);
  }
  return chunks.length ? chunks : [text];
}

/** Section unit — split primarily on headings */
function splitSections(text, opts) {
  text = markPageBreaks(text, opts.respectPageBreaks);
  // Normalize heading-like lines
  const lines = text.split('\n');
  const blocks = [];
  let buf = [];
  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) blocks.push(t);
    buf = [];
  };
  for (const line of lines) {
    if (line.includes('<<<PAGE>>>')) {
      flush();
      continue;
    }
    const isHead =
      /^#{1,6}\s+\S/.test(line) ||
      /^(chapter|part|book|section|act)\s+[\divxlc0-9]/i.test(line.trim()) ||
      (/^[A-Z][A-Za-z0-9 ,.'’:\-]{2,72}$/.test(line.trim()) &&
        line.trim().length < 74 &&
        !/[.!?]$/.test(line.trim()) &&
        buf.length > 3);
    if (isHead && buf.length) {
      flush();
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();
  return blocks.length ? blocks : [text];
}

/** Page unit — explicit breaks first, then pack by word count */
function splitPages(text, opts) {
  text = markPageBreaks(text, true); // page mode always honors breaks
  const hard = text.split(/\n*<<<PAGE>>>\n*/).map((p) => p.trim()).filter(Boolean);
  const targetWords = opts.pageWords;
  const out = [];
  for (const segment of hard.length ? hard : [text]) {
    const words = segment.split(/\s+/).filter(Boolean);
    if (words.length <= targetWords * 1.15) {
      out.push(segment.trim());
      continue;
    }
    // Pack by paragraphs when possible
    const paras = segment.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let cur = [];
    let count = 0;
    const flush = () => {
      if (cur.length) {
        out.push(cur.join('\n\n'));
        cur = [];
        count = 0;
      }
    };
    for (const para of paras) {
      const wc = para.split(/\s+/).filter(Boolean).length;
      if (count && count + wc > targetWords * 1.25) {
        flush();
      }
      cur.push(para);
      count += wc;
      if (count >= targetWords) flush();
    }
    flush();
  }
  return out.length ? out : [text];
}

/** Hybrid structural (previous default, improved) */
function structuralSplit(text, opts) {
  text = markPageBreaks(text, opts.respectPageBreaks);
  text = text.replace(/<<<PAGE>>>/g, '§§§');

  const chunks = [];
  const parts = text.split(/(?=\n#{1,6}\s)|(?=\n§§§\n)|(?:\n{2,})/);
  let buf = '';
  for (const part of parts) {
    const p = part.replace(/^§§§\n?/, '').trim();
    if (!p) continue;
    const isHead = /^#{1,6}\s/.test(p) || /^[A-Z][^\n]{0,80}\n[=-]{3,}\s*$/m.test(p);
    if (isHead) {
      if (buf) chunks.push(buf);
      buf = p;
      continue;
    }
    if (!buf) {
      buf = p;
    } else if (isHeadingBlock(buf) && buf.length < 90 && !isHardFragment(p)) {
      // Keep a heading with the first paragraph under it
      buf = buf + '\n\n' + p;
    } else {
      // Blank-line paragraphs stay separate — this is a fragment desk
      chunks.push(buf);
      buf = p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [text];
}

function isHeadingBlock(t) {
  const s = String(t || '').trim();
  return /^#{1,6}\s+\S/.test(s) || /^[A-Z][^\n]{0,80}\n[=-]{3,}\s*$/m.test(s);
}

function applyFragmentCuts(blocks, opts, fullText = '') {
  let out = blocks.flatMap((b) => splitListAndIdeaLines(b));
  if (!opts.keepDialogueTogether) {
    out = out.flatMap((b) => splitDialogueRuns(b));
    out = out.flatMap((b) => splitInlineDialogue(b));
  }
  const dump = isIdeaDump(fullText || out.join('\n\n'), opts.sourceName);
  out = out.flatMap((b) => (dump || looksLikeLooseNotes(b) ? explodeIdeaDump(b) : [b]));
  return out;
}

const SAID_VERBS =
  'said|says|asked|replied|whispered|muttered|answered|called|shouted|cried|added|went on';

/** Peel quoted speech (and its he-said) out of a mixed narration paragraph. */
function splitInlineDialogue(text) {
  const t = String(text || '');
  if (!/["“«]/.test(t)) return [t];
  const re = /["“«][^"”»\n]{0,1200}["”»]/g;
  const spans = [];
  let m;
  while ((m = re.exec(t))) {
    let start = m.index;
    let end = m.index + m[0].length;
    const before = t.slice(0, start);
    const lead = before.match(
      new RegExp(
        `((?:[A-Z][a-zA-Z]+|He|She|They|I)\\s+(?:${SAID_VERBS})[,:]?\\s*)$`
      )
    );
    if (lead) start -= lead[1] ? lead[1].length : lead[0].length;
    const after = t.slice(end);
    // Only glue classic beat tags (" she asked.") — not the next sentence (" I asked why.")
    const attr = after.match(
      new RegExp(
        `^(,\\s*|\\s+)(?:he|she|they)\\s+(?:${SAID_VERBS})\\b[^.!?\\n]{0,50}[.!?]?`
      )
    );
    if (attr) end += attr[0].length;
    const slice = t.slice(start, end).trim();
    if (slice.length >= 3) spans.push({ start, end, text: slice });
  }
  if (!spans.length) return [t];
  if (spans.length === 1 && spans[0].start <= 2 && t.slice(spans[0].end).trim().length < 8) {
    return [t.trim()];
  }
  const out = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    const prior = t.slice(cursor, s.start).trim();
    if (prior.length >= 8) out.push(prior);
    out.push(s.text);
    cursor = s.end;
  }
  const tail = t.slice(cursor).trim();
  if (tail.length >= 8) out.push(tail);
  return out.length ? out : [t];
}

function looksLikeListItem(t) {
  return /^\s*(?:[-*•]|\d+[.)]|[a-z][.)])\s+\S/.test(String(t).trim());
}

function looksLikeIdeaCue(t) {
  return /^(?:ideas?|another(?:\s+one|\s+idea)?|also|note(?:\s+to\s+self)?|todo|tbd|fragment|random|unrelated|plot:|what if)\b/i.test(
    String(t).trim()
  );
}

function isHardFragment(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  return looksLikeListItem(s) || looksLikeIdeaCue(s) || looksLikeDialogue(s);
}

function isIdeaDump(text, sourceName = '') {
  if (/\bideas?\b/i.test(sourceName)) return true;
  const raw = String(text || '');
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length >= 6) {
    const listy = lines.filter((l) => looksLikeListItem(l) || looksLikeIdeaCue(l)).length;
    if (listy / lines.length >= 0.35) return true;
  }
  const sents = tokenizeSentences(raw);
  const cues = (
    raw.match(
      /\b(another|also|what if|idea:|todo|tbd|note to self|random thought|unrelated|plot:)\b/gi
    ) || []
  ).length;
  if (sents.length >= 5 && cues >= 2) return true;
  const paras = raw
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length >= 6) {
    const short = paras.filter((p) => p.length < 160).length;
    if (short / paras.length >= 0.7 && cues >= 1) return true;
  }
  return false;
}

function looksLikeLooseNotes(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (looksLikeIdeaCue(t) || looksLikeListItem(t)) return true;
  const sents = tokenizeSentences(t);
  const cues = (
    t.match(
      /\b(another|also|what if|idea:|todo|tbd|note to self|random thought|unrelated|plot:|fragment:)\b/gi
    ) || []
  ).length;
  if (sents.length >= 2 && cues >= 2) return true;
  if (sents.length >= 4) {
    const short = sents.filter((s) => s.length < 100).length;
    const narrative = (t.match(/\b(he|she|they|I)\s+[a-z]+ed\b/gi) || []).length;
    if (short / sents.length >= 0.75 && narrative < 2) return true;
  }
  return false;
}

function splitListAndIdeaLines(text) {
  const lines = String(text).split('\n');
  const blocks = [];
  let buf = [];
  const flush = () => {
    const b = buf.join('\n').trim();
    if (b) blocks.push(b);
    buf = [];
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    if (looksLikeListItem(t) || looksLikeIdeaCue(t)) {
      flush();
      blocks.push(t);
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks.length ? blocks : [text];
}

function splitDialogueRuns(text) {
  const lines = String(text).split('\n');
  const out = [];
  let buf = [];
  let mode = null;
  const flush = () => {
    const b = buf.join('\n').trim();
    if (b) out.push(b);
    buf = [];
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      flush();
      mode = null;
      continue;
    }
    const m = looksLikeDialogue(t) ? 'dlg' : 'prose';
    if (mode && m !== mode) flush();
    mode = m;
    buf.push(line);
  }
  flush();
  return out.length ? out : [text];
}

function explodeIdeaDump(block) {
  const lines = String(block)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length >= 3 && lines.filter((l) => l.length < 180).length / lines.length >= 0.8) {
    return lines.filter((l) => l.length >= 8);
  }
  const sents = tokenizeSentences(block);
  if (sents.length < 2) return [block];
  return sents.map((s) => s.trim()).filter((s) => s.length >= 8);
}

function mergeTiny(blocks, minKeep, opts = {}) {
  const out = [];
  let buf = '';
  for (const b of blocks) {
    const hard = isHardFragment(b) || isHardFragment(buf);
    if (b.length < minKeep && buf && !hard) {
      buf = buf + '\n\n' + b;
    } else if (b.length < minKeep && !buf && !hard) {
      buf = b;
    } else {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      out.push(b);
    }
  }
  if (buf) out.push(buf);
  return out;
}

function splitOversized(blocks, opts) {
  const max = opts.maxChars;
  const out = [];
  for (const b of blocks) {
    if (b.length <= max) {
      out.push(b);
      continue;
    }
    const paras = b.split(/\n{2,}/);
    let cur = '';
    for (const para of paras) {
      if ((cur + '\n\n' + para).length > max && cur) {
        out.push(cur.trim());
        cur = para;
      } else {
        cur = cur ? cur + '\n\n' + para : para;
      }
    }
    if (cur) {
      if (cur.length > max * 1.15) {
        out.push(...splitSentencesToMax(cur, max));
      } else {
        out.push(cur.trim());
      }
    }
  }
  return out;
}

function splitSentencesToMax(text, max) {
  const sentences = tokenizeSentences(text);
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).trim().length > max && cur) {
      out.push(cur.trim());
      cur = s;
    } else {
      cur = (cur + ' ' + s).trim();
    }
  }
  if (cur) {
    if (cur.length > max * 1.5) {
      // hard wrap very long run-ons
      for (let i = 0; i < cur.length; i += max) {
        out.push(cur.slice(i, i + max).trim());
      }
    } else {
      out.push(cur.trim());
    }
  }
  return out.filter(Boolean);
}

/** Drop page numbers, leader dots, and binary leftovers — not writing. */
export function isJunkPiece(text) {
  const t = String(text || '').trim();
  if (t.length < 8) return true;
  const letters = (t.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  if (letters < 6 && !looksLikeDialogue(t)) return true;
  if (letters / t.length < 0.28) return true;
  if (/^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(t)) return true;
  if (/^[\d\s.\-–—•·*_/=]+$/.test(t)) return true;
  if (/^\.{5,}/.test(t) || /_{8,}/.test(t)) return true;
  return false;
}

/**
 * Lightweight “semantic” labels without network.
 */
export function heuristicLabels(text) {
  const t = text.trim();
  const labels = [];
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);

  // Stickers only when the signal is loud. Empty is fine — the writer files the cards.
  if (
    looksLikeDialogue(t) ||
    ((t.includes('"') || t.includes('“')) && t.length < 800 && lines.length <= 8)
  ) {
    labels.push('Dialogue');
  }
  if (lines.length >= 3 && lines.every((l) => l.length < 90) && t.length < 900) {
    const short = lines.filter((l) => l.length < 60).length;
    if (short / lines.length > 0.6) labels.push('Poetry');
  }
  if (
    /\b(I think|the idea|concept of|means that|in other words|philosophy|ontology|therefore)\b/i.test(
      t
    )
  ) {
    labels.push('Philosophical Fragment');
  }
  if (/\b(TODO|TBD|xxx|\?\?\?|finish this|incomplete|rough)\b/i.test(t) || /…\s*$/.test(t)) {
    labels.push('Incomplete');
  }
  if (t.length < 70 && !/[.!?]\s/.test(t) && /[,/—–]/.test(t)) {
    labels.push('Phrase/Image');
  }
  return [...new Set(labels)];
}

/**
 * Optional AI-assisted re-chunk / re-label for a batch of pieces.
 */
export function buildAiChunkPrompt(text, modeOrOpts) {
  const desc =
    typeof modeOrOpts === 'string'
      ? modeOrOpts
      : describeChunkOptions(modeOrOpts || {});
  return `You split a writer's draft into FRAGMENTS for a card desk they will reorder.
This is not classification of the whole file. Never return one object for the entire source.
Preference: ${desc}.

Rules:
- Each unrelated idea = its own card (ideas dumps, bullets, "another thought…").
- Quoted dialogue = its own card(s), separate from narration. Rip it out of a story if it stands alone.
- Preserve original wording. Do not rewrite, summarize, or invent.
- Prefer many small cards over one large card. Typical card: 1–8 sentences.
- labels optional from: Concept, Character, Location, Plot Seed, Philosophical Fragment, Dialogue, Poetry, Phrase/Image, Incomplete, Scene, Essay Seed.

Return JSON array only: [{ "text": "...", "labels": ["..."] }, ...]
Source:
---
${text.slice(0, 12000)}
---`;
}
