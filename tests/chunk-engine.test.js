/**
 * Offline chunk engine unit tests (Node 17+ compatible).
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  chunkDocument,
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

test('resolveChunkOptions defaults to hybrid medium', () => {
  const o = resolveChunkOptions({});
  assert.equal(o.unit, 'hybrid');
  assert.equal(o.sizePreset, 'medium');
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
