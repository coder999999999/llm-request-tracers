import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../tools/load-data.mjs';
import { vllmBench, llamaBench } from './fixtures/bench.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = loadContext(root, ['assets/compare/util.js', 'assets/compare/stage-times.js']);
const RTU = c.RTU;
const ctx = { a: c.RT.engines['llama-cpp'], b: c.RT.engines.vllm, bench: { 'llama-cpp': llamaBench, vllm: vllmBench } };

test('extends RTU without replacing it', () => assert.equal(typeof RTU.esc, 'function'));

test('vLLM stage times use reported queue and prefill', () =>
  assert.deepEqual(RTU.stageTimes(vllmBench, 32),
    { think: { ms: 40, note: 'reported' }, wait: { ms: 4, note: 'reported' }, other: { ms: 11, note: 'derived' } }));

test('llama.cpp folds queue and overhead together', () =>
  assert.deepEqual(RTU.stageTimes(llamaBench, 32),
    { think: { ms: 38, note: 'reported' }, wait: { ms: 22, note: 'queue + overhead' }, other: null }));

test('stage times are null for a missing level or missing fields', () => {
  assert.equal(RTU.stageTimes(vllmBench, 7), null);
  assert.equal(RTU.stageTimes(vllmBench, 64), null);
  assert.equal(RTU.stageTimes(undefined, 32), null);
  assert.equal(RTU.stageTimes({}, 32), null);
});

test('annotation ratio is computed from bench, not typed', () =>
  assert.equal(RTU.annotate({ x: 64, metric: 'tok_s', kind: 'ratio', text: '{v}× at 64 users' }, ctx).text, '5.5× at 64 users'));

test('annotation is skipped when a point is missing', () => {
  assert.equal(RTU.annotate({ x: 128, metric: 'tok_s', kind: 'ratio', text: '{v}×' }, ctx), null);
  assert.equal(RTU.annotate({ x: 64, metric: 'tok_s', kind: 'ratio', text: '{v}×' }, { ...ctx, bench: { vllm: vllmBench } }), null);
  assert.equal(RTU.annotate({ x: 64, metric: 'nope', kind: 'value', text: '{v}' }, ctx), null);
});

test('annotation value reads the named engine median, with separators', () => {
  assert.equal(RTU.annotate({ x: 64, metric: 'tok_s', kind: 'value', engine: 'vllm', text: '{v} tokens/s' }, ctx).text, '2,700 tokens/s');
  assert.equal(RTU.annotate({ x: 64, metric: 'tok_s', kind: 'value', engine: 'b', text: '{v}' }, ctx).text, '2,700');
  assert.equal(RTU.annotate({ x: 64, metric: 'tok_s', kind: 'value', text: '{v}' }, ctx).text, '495');
});

test('annotation anchors between the two medians', () =>
  assert.equal(RTU.annotate({ x: 64, metric: 'tok_s', kind: 'ratio', text: '{v}' }, ctx).y, (2700 + 495) / 2));

test('fmtNum', () => {
  assert.equal(RTU.fmtNum(2700), '2,700');
  assert.equal(RTU.fmtNum(1234567), '1,234,567');
  assert.equal(RTU.fmtNum(55.34), '55.3');
  assert.equal(RTU.fmtNum(NaN), 'n/a');
});
