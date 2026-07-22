/**
 * Hybrid chunking — structural first, light heuristic “semantic” second.
 * Optional AI pass can refine later via ai/client.js.
 */

/**
 * @typedef {'conservative'|'balanced'|'atomic'} ChunkMode
 */

/**
 * @param {string} text
 * @param {{ mode?: ChunkMode, sourceName?: string }} opts
 * @returns {{ text: string, isLarge: boolean, labels: string[], tags: string[], aiHint?: string }[]}
 */
export function chunkDocument(text, opts = {}) {
  const mode = opts.mode || 'balanced';
  const sourceName = opts.sourceName || '';
  const cleaned = normalizeSource(text);
  if (!cleaned.trim()) return [];

  let blocks = structuralSplit(cleaned);
  blocks = mergeTiny(blocks, mode);
  blocks = splitOversized(blocks, mode);
  blocks = blocks.map((b) => b.trim()).filter((b) => b.length >= 12);

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

function structuralSplit(text) {
  // Page-break markers often from converters
  text = text.replace(/\f/g, '\n\n---\n\n');
  text = text.replace(/\n{0,2}---+\n{0,2}/g, '\n\n§§§\n\n');

  const chunks = [];
  // Split on markdown/ATX headings, setext, blank-line groups, § markers
  const parts = text.split(/(?=\n#{1,6}\s)|(?=\n§§§\n)|(?:\n{2,})/);
  let buf = '';
  for (const part of parts) {
    const p = part.replace(/^§§§\n?/, '').trim();
    if (!p) continue;
    // Keep heading glued to following paragraph when small
    if (/^#{1,6}\s/.test(p) || /^[A-Z][^\n]{0,80}\n[=-]{3,}\s*$/m.test(p)) {
      if (buf) chunks.push(buf);
      buf = p;
      continue;
    }
    if (!buf) {
      buf = p;
    } else if (buf.length < 200 && p.length < 400) {
      buf = buf + '\n\n' + p;
    } else {
      chunks.push(buf);
      buf = p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [text];
}

function mergeTiny(blocks, mode) {
  const minKeep = mode === 'atomic' ? 20 : mode === 'conservative' ? 80 : 40;
  const out = [];
  let buf = '';
  for (const b of blocks) {
    if (b.length < minKeep && buf) {
      buf = buf + '\n\n' + b;
    } else if (b.length < minKeep) {
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

function splitOversized(blocks, mode) {
  const max =
    mode === 'atomic' ? 480 : mode === 'conservative' ? 4000 : 1800;
  const out = [];
  for (const b of blocks) {
    if (b.length <= max) {
      out.push(b);
      continue;
    }
    // Prefer paragraph splits, then sentences
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
      if (cur.length > max * 1.4 && mode !== 'conservative') {
        out.push(...splitSentences(cur, max));
      } else {
        out.push(cur.trim());
      }
    }
  }
  return out;
}

function splitSentences(text, max) {
  const sentences = text.match(/[^.!?]+[.!?]+["']?|\S+$/g) || [text];
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
  if (cur) out.push(cur.trim());
  return out;
}

/**
 * Lightweight “semantic” labels without network.
 */
export function heuristicLabels(text) {
  const t = text.trim();
  const labels = [];
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);

  if (/^["“«]/.test(t) || /["”]\s*$/.test(t) || /^(said|says|asked|replied)\b/im.test(t)) {
    if (lines.length <= 8 && t.length < 800) labels.push('Dialogue');
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
  if (
    /\b(he|she|they|character|protagonist|her eyes|his voice|named [A-Z])\b/i.test(t) &&
    t.length < 1500
  ) {
    labels.push('Character');
  }
  if (/\b(city|town|room|street|forest|house|river|place called)\b/i.test(t)) {
    labels.push('Location');
  }
  if (/\b(plot|then |suddenly|chapter|later that|the plan)\b/i.test(t)) {
    labels.push('Plot Seed');
  }
  if (t.length < 160 && !/[.!?]\s+[A-Z]/.test(t)) {
    labels.push('Phrase/Image');
  }
  if (/\b(TODO|TBD|xxx|\?\?\?|finish this|incomplete|rough)\b/i.test(t) || /…\s*$/.test(t)) {
    labels.push('Incomplete');
  }
  if (!labels.length) {
    if (t.length > 900) labels.push('Scene');
    else labels.push('Concept');
  }
  // unique
  return [...new Set(labels)];
}

/**
 * Optional AI-assisted re-chunk / re-label for a batch of pieces.
 * Returns same shape; caller sends to LLM.
 */
export function buildAiChunkPrompt(text, mode) {
  return `You are helping excavate a writer's draft into discrete usable pieces.
Chunking mode: ${mode}.
Split the source into JSON array of objects: { "text": "...", "labels": ["..."], "isLarge": boolean }.
Rules: preserve original wording; do not invent content; prefer natural idea boundaries; label from: Concept, Character, Location, Plot Seed, Philosophical Fragment, Dialogue, Poetry, Phrase/Image, Incomplete, Scene, Essay Seed.
Source:
---
${text.slice(0, 14000)}
---
Return JSON array only.`;
}
