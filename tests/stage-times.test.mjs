import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../tools/load-data.mjs';
import { vllmBench, vllmBenchFull, llamaBench } from './fixtures/bench.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = loadContext(root, ['assets/compare/util.js', 'assets/compare/stage-times.js']);
const RTU = c.RTU;
const ctx = { a: c.RT.engines['llama-cpp'], b: c.RT.engines.vllm, bench: { 'llama-cpp': llamaBench, vllm: vllmBench } };

test('extends RTU without replacing it', () => assert.equal(typeof RTU.esc, 'function'));

// Both engines are split the same way: prefill (reported) and everything before
// it (TTFT minus prefill, derived). vLLM's reported queue time rides along.
test('vLLM stage times: prefill reported, before-prefill derived, queue shown as part of it', () =>
  assert.deepEqual(RTU.stageTimes(vllmBench, 32),
    { think: { ms: 40, note: 'reported' }, wait: { ms: 15, note: 'derived', queue: 4 } }));

test('llama.cpp stage times use the same definition and have no queue figure', () =>
  assert.deepEqual(RTU.stageTimes(llamaBench, 32),
    { think: { ms: 38, note: 'reported' }, wait: { ms: 22, note: 'derived', queue: null } }));

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

const fullCtx = { ...ctx, bench: { 'llama-cpp': llamaBench, vllm: vllmBenchFull } };

test('reuse annotation reads cold and warm TTFT, ratio b over a', () => {
  const cold = RTU.annotate({ source: 'reuse', metric: 'cold_ttft_ms', kind: 'ratio', text: '{v}× cold' }, fullCtx);
  assert.equal(cold.text, '0.9× cold');
  assert.equal(cold.y, (1200 + 1100) / 2);
  const warm = RTU.annotate({ source: 'reuse', x: 999, metric: 'warm_ttft_ms', kind: 'ratio', text: '{v}× warm' }, fullCtx);
  assert.equal(warm.text, '0.4× warm');
});

test('reuse annotation value names an engine and ignores x', () =>
  assert.equal(RTU.annotate({ source: 'reuse', metric: 'warm_ttft_ms', kind: 'value', engine: 'vllm', text: '{v} ms' }, fullCtx).text, '40 ms'));

test('reuse annotation is skipped when a reuse run is missing', () => {
  assert.equal(RTU.annotate({ source: 'reuse', metric: 'cold_ttft_ms', kind: 'ratio', text: '{v}' }, ctx), null);
  assert.equal(RTU.annotate({ source: 'reuse', metric: 'nope', kind: 'ratio', text: '{v}' }, fullCtx), null);
  assert.equal(RTU.annotate({ source: 'reuse', metric: 'cold_ttft_ms', kind: 'ratio', text: '{v}' }, { ...fullCtx, bench: {} }), null);
});

test('kvFull annotation reads the row at max_tokens', () => {
  assert.equal(RTU.annotate({ source: 'kvFull', x: 1024, metric: 'tok_s', kind: 'ratio', text: '{v}× at 1024' }, fullCtx).text, '7× at 1024');
  assert.equal(RTU.annotate({ source: 'kvFull', x: 1024, metric: 'tok_s', kind: 'ratio', text: '{v}' }, fullCtx).y, (300 + 2100) / 2);
  assert.equal(RTU.annotate({ source: 'kvFull', x: 256, metric: 'tok_s', kind: 'value', engine: 'vllm', text: '{v} tokens/s' }, fullCtx).text, '2,500 tokens/s');
});

test('kvFull annotation is skipped when the row or run is missing, and reads {median} objects', () => {
  assert.equal(RTU.annotate({ source: 'kvFull', x: 4096, metric: 'tok_s', kind: 'ratio', text: '{v}' }, fullCtx), null);
  assert.equal(RTU.annotate({ source: 'kvFull', x: 1024, metric: 'tok_s', kind: 'ratio', text: '{v}' }, ctx), null);
  const med = { ...fullCtx, bench: { 'llama-cpp': { ...llamaBench, kvFull: [{ max_tokens: 1024, tok_s: { median: 300, min: 290, max: 310 } }] }, vllm: vllmBenchFull } };
  assert.equal(RTU.annotate({ source: 'kvFull', x: 1024, metric: 'tok_s', kind: 'ratio', text: '{v}' }, med).text, '7');
});

test('annotation without a source still means levels', () =>
  assert.equal(RTU.annotate({ source: 'levels', x: 64, metric: 'tok_s', kind: 'ratio', text: '{v}' }, ctx).text, '5.5'));

test('ratio follows the engine order of ctx (b over a)', () => {
  const swapped = { ...ctx, a: ctx.b, b: ctx.a };
  assert.equal(RTU.annotate({ x: 64, metric: 'tok_s', kind: 'ratio', text: '{v}' }, swapped).text, '0.2');
});

test('fmtNum', () => {
  assert.equal(RTU.fmtNum(2700), '2,700');
  assert.equal(RTU.fmtNum(1234567), '1,234,567');
  assert.equal(RTU.fmtNum(55.34), '55.3');
  assert.equal(RTU.fmtNum(NaN), 'n/a');
});
