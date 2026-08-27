/**
 * Offline chunk engine unit tests (Node 17+ compatible).
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  chunkDocument,
  isJunkPiece,
  resolveChunkOptions,
  describeChunkOptions,
  estimatePieceCount,
} from '../src/chunk/engine.js';

const SAMPLE = `# Chapter One

Once upon a time there was a vault of unfinished drafts.

She found a sentence that still glowed.

## Later

Dialogue sparkled:
"Keep this," he said.
"Alright," she answered.

A longer paragraph that holds several ideas about memory, archaeology, and the quiet work of saving fragments before they vanish into the hard drive dust. It should survive coarse splits when max chars are high enough.

# Epilogue

The end of the sample.`;

/** @type {{ name: string, fn: () => void | Promise<void> }[]} */
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('resolveChunkOptions defaults to hybrid fine and rips dialogue', () => {
  const o = resolveChunkOptions({});
  assert.equal(o.unit, 'hybrid');
  assert.equal(o.sizePreset, 'fine');
  assert.equal(o.keepDialogueTogether, false);
  assert.ok(o.minChars > 0);
  assert.ok(o.maxChars > o.minChars);
});

test('legacy atomic maps to fine size', () => {
  const o = resolveChunkOptions({ chunkMode: 'atomic' });
  assert.equal(o.sizePreset, 'fine');
  assert.equal(o.unit, 'hybrid');
});

test('chunkDocument paragraph unit yields multiple blocks', () => {
  const chunks = chunkDocument(SAMPLE, { chunkUnit: 'paragraph', chunkSizePreset: 'medium' });
  assert.ok(chunks.length >= 3, `expected ≥3 paragraphs, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.text && c.text.trim().length >= 1);
    assert.ok(typeof c.preview === 'string');
  }
});

test('chunkDocument sentence unit makes smaller pieces', () => {
  const sentences = chunkDocument(SAMPLE, { chunkUnit: 'sentence', chunkSizePreset: 'fine' });
  const paras = chunkDocument(SAMPLE, { chunkUnit: 'paragraph', chunkSizePreset: 'medium' });
  assert.ok(sentences.length >= paras.length, 'sentences should be ≥ paragraphs');
});

test('chunkDocument section respects headings', () => {
  const chunks = chunkDocument(SAMPLE, { chunkUnit: 'section', chunkSizePreset: 'coarse' });
  assert.ok(chunks.length >= 2);
});

test('estimatePieceCount is at least 1 for non-empty text', () => {
  assert.equal(estimatePieceCount(''), 0);
  assert.ok(estimatePieceCount(SAMPLE, { chunkUnit: 'hybrid' }) >= 1);
});

test('describeChunkOptions is human-readable', () => {
  const s = describeChunkOptions({ chunkUnit: 'page', chunkSizePreset: 'medium' });
  assert.match(s, /page/i);
});

test('empty text yields no chunks', () => {
  assert.deepEqual(chunkDocument('   \n  '), []);
});

test('custom min/max clamps apply', () => {
  const o = resolveChunkOptions({
    chunkUnit: 'hybrid',
    chunkSizePreset: 'custom',
    chunkMinChars: 10,
    chunkMaxChars: 200,
  });
  assert.equal(o.minChars, 10);
  assert.equal(o.maxChars, 200);
  const chunks = chunkDocument(SAMPLE, o);
  assert.ok(chunks.length >= 1);
});

test('isJunkPiece drops page numbers and leader dots', () => {
  assert.equal(isJunkPiece('Page 12'), true);
  assert.equal(isJunkPiece('....••••'), true);
  assert.equal(isJunkPiece('She found a sentence that still glowed in the vault.'), false);
});

test('isJunkPiece keeps short dialogue', () => {
  assert.equal(isJunkPiece('"Someone has to."'), false);
  assert.equal(isJunkPiece('“Alright,” she answered.'), false);
});

test('hybrid fine rips dialogue out of a short story', () => {
  const story = `The lamp hummed over the kitchen table. Maria wiped a circle in the condensation.

"Did you lock the back door?" she asked.

He didn't look up from the paper. "I thought you did."

"I asked you to," she said. "Every night this week."

Rain started on the porch screen. Nobody moved.`;
  const chunks = chunkDocument(story, {
    chunkUnit: 'hybrid',
    chunkSizePreset: 'fine',
    keepDialogueTogether: false,
    sourceName: 'bad-story.txt',
  });
  assert.ok(
    chunks.length >= 4,
    `expected several fragments, got ${chunks.length}: ${chunks.map((c) => c.text).join(' || ')}`
  );
  const texts = chunks.map((c) => c.text);
  assert.ok(texts.some((t) => /Did you lock the back door/.test(t)));
  assert.ok(texts.some((t) => /Rain started/.test(t) && !/Did you lock/.test(t)));
  assert.ok(texts.some((t) => /I thought you did/.test(t) && !/didn't look up from the paper/.test(t)));
  assert.ok(texts.filter((t) => /["“]/.test(t)).length >= 2);
});

test('ideas dump becomes many cards, not one category', () => {
  const ideas = `Ideas for later
the market scene with copper air
another: otter logo for Reliquary
also call mom about Sunday dinner
what if the map boy returns in act 2
plot: Lina never closes doors
random thought: archives as interruption
TODO: finish the river paragraph`;
  const chunks = chunkDocument(ideas, {
    chunkUnit: 'hybrid',
    chunkSizePreset: 'fine',
    sourceName: 'Ideas.txt',
  });
  assert.ok(chunks.length >= 6, `got ${chunks.length}: ${chunks.map((c) => c.text).join(' || ')}`);
  assert.ok(chunks.some((c) => /otter logo/i.test(c.text)));
  assert.ok(chunks.some((c) => /call mom/i.test(c.text)));
  assert.ok(!chunks.some((c) => /otter logo/i.test(c.text) && /call mom/i.test(c.text)));
});

test('a mixed draft is many fragments, not one labeled document', () => {
  const chunks = chunkDocument(SAMPLE, { chunkUnit: 'hybrid', chunkSizePreset: 'fine' });
  assert.ok(chunks.length >= 5, `got ${chunks.length}`);
});

test('inline dialogue does not swallow the next sentence as attribution', () => {
  const chunks = chunkDocument(
    `She said, "We don't bury names here." I asked why. She only pointed at the water.`,
    { chunkUnit: 'hybrid', chunkSizePreset: 'fine', keepDialogueTogether: false }
  );
  const texts = chunks.map((c) => c.text);
  assert.ok(texts.some((t) => /We don't bury names here/.test(t)));
  assert.ok(texts.some((t) => /I asked why/.test(t)));
  assert.ok(
    !texts.some((t) => /We don't bury names here/.test(t) && /I asked why/.test(t)),
    `dialogue stayed glued to the next sentence: ${texts.join(' || ')}`
  );
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${t.name}`);
    console.error(err);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
