/**
 * LLM helper unit tests (no network).
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  inferProvider,
  llmEnabled,
  ollamaModelTooSmall,
  ollamaSizeWarning,
  pickOllamaDefault,
  parseJsonArray,
} from '../src/ai/client.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('inferProvider reads explicit setting', () => {
  assert.equal(inferProvider({ llmProvider: 'xai' }), 'xai');
  assert.equal(inferProvider({ llmProvider: 'off' }), 'off');
});

test('inferProvider from URL when unset', () => {
  assert.equal(inferProvider({}), 'off');
  assert.equal(inferProvider({ llmBaseUrl: 'https://api.x.ai/v1' }), 'xai');
  assert.equal(inferProvider({ llmBaseUrl: 'http://localhost:11434/v1' }), 'ollama');
  assert.equal(inferProvider({ llmBaseUrl: 'http://127.0.0.1:8000/v1' }), 'custom');
});

test('llmEnabled requires privacy ack for xAI', () => {
  assert.equal(llmEnabled({ llmProvider: 'off' }), false);
  assert.equal(llmEnabled({ llmProvider: 'ollama' }), true);
  assert.equal(llmEnabled({ llmProvider: 'xai' }), false);
  assert.equal(llmEnabled({ llmProvider: 'xai', llmPrivacyAck: true }), true);
});

test('ollamaModelTooSmall flags 3B-class names', () => {
  assert.equal(ollamaModelTooSmall('llama3.2'), true);
  assert.equal(ollamaModelTooSmall('llama3.2:latest'), true);
  assert.equal(ollamaModelTooSmall('llama3.2:3b'), true);
  assert.equal(ollamaModelTooSmall('llama3.1'), false);
  assert.equal(ollamaModelTooSmall('llama3.1:8b'), false);
  assert.equal(ollamaModelTooSmall('qwen2.5:14b'), false);
});

test('ollamaSizeWarning uses parameter_size', () => {
  const w = ollamaSizeWarning('llama3.2:latest', { parameterSize: '3.2B' });
  assert.match(w, /3\.2B|8B/);
  assert.equal(ollamaSizeWarning('llama3.1:8b', { parameterSize: '8.0B' }), '');
});

test('pickOllamaDefault prefers a non-tiny model', () => {
  const id = pickOllamaDefault([
    { id: 'llama3.2:latest', parameterSize: '3.2B' },
    { id: 'llama3.1:latest', parameterSize: '8.0B' },
  ]);
  assert.equal(id, 'llama3.1:latest');
});

test('parseJsonArray accepts fenced arrays', () => {
  const arr = parseJsonArray('```json\n[{"text":"hi"}]\n```');
  assert.equal(arr[0].text, 'hi');
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
