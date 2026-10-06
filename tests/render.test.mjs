import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../tools/load-data.mjs';
import { vllmBench, vllmBenchFull, llamaBench } from './fixtures/bench.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = loadContext(root, [
  'assets/compare/util.js', 'assets/compare/stage-times.js', 'assets/compare/chart.js', 'assets/compare/render.js',
]);
const { RT, RTR } = c;
const llama = RT.engines['llama-cpp'];
const vllm = RT.engines.vllm;
const [q1, q2, q3, q4] = RT.compare.questions;

const pair = {
  ids: ['llama-cpp', 'vllm'],
  answers: { q2: 'Answer two.', q3: 'Answer three.' },
  stageSummaries: { wait: { 'llama-cpp': 'Slots decide.', vllm: 'The budget decides.' } },
  annotations: { q1: [{ x: 64, metric: 'tok_s', kind: 'ratio', text: '{v}× at 64 users' }] },
};
const ctx = {
  a: llama, b: vllm, pair, compare: RT.compare,
  bench: { 'llama-cpp': llamaBench, vllm: vllmBench },
};
const fullCtx = { ...ctx, bench: { 'llama-cpp': llamaBench, vllm: vllmBenchFull } };

// Removes code and tooltip text, which carry text copied verbatim from the tracers.
const prose = (html) => html.replace(/<code>[\s\S]*?<\/code>/g, '').replace(/<title>[\s\S]*?<\/title>/g, '');

test('evidence shows empty state when one engine has no bench', () =>
  assert.match(RTR.evidence(q1, { ...ctx, bench: { vllm: vllmBench } }), /Benchmark running, results soon/));

test('evidence shows empty state with no bench at all', () => {
  for (const q of [q1, q2, q4]) assert.match(RTR.evidence(q, { ...ctx, bench: {} }), /Benchmark running, results soon/);
});

test('throughput evidence draws both engines and the computed annotation', () => {
  const html = RTR.evidence(q1, ctx);
  assert.match(html, /<svg/);
  assert.match(html, />5\.5× at 64 users</);
  assert.match(html, /<title>vLLM, 64 users: 2,700 \(range 2,650–2,760\)<\/title>/);
  assert.match(html, /Test model/);
});

test('annotation is skipped, not blank, when the point is missing', () => {
  const noPoint = { ...ctx, pair: { ...pair, annotations: { q1: [{ x: 128, metric: 'tok_s', kind: 'ratio', text: '{v}×' }] } } };
  assert.doesNotMatch(RTR.evidence(q1, noPoint), /×/);
});

test('reuse evidence groups first message and repeat', () => {
  const html = RTR.evidence(q2, fullCtx);
  assert.match(html, />First message</);
  assert.match(html, />Repeat with the same system prompt</);
  assert.match(html, />1,200 ms</);
  assert.match(html, />40 ms</);
});

test('kvFull evidence charts throughput and lists failures and retries', () => {
  const html = RTR.evidence(q4, fullCtx);
  assert.match(html, /<svg/);
  assert.match(html, /Preemptions 12/);
  assert.match(html, /Decode retries 7/);
  assert.match(html, /Failed requests 2/);
});

test('boundary diagram is drawn from step data, both lanes', () => {
  const html = RTR.evidence(q3, ctx);
  for (const e of [llama, vllm]) for (const s of Object.values(e.steps).flat()) {
    if (s.hopText) assert.ok(html.includes(s.hopText), s.hopText);
  }
  assert.match(html, />llama\.cpp</);
  assert.match(html, />vLLM</);
  assert.match(html, /One process\./);
});

test('boundary diagram follows the data: an engine with no steps says so', () => {
  const bare = { id: 'bare', name: 'Bare', color: '#336699', repo: 'https://example.invalid/x', commit: 'c', tracer: 'bare.html', shape: 'Shape.', features: {}, steps: {} };
  const html = RTR.evidence(q3, { ...ctx, b: bare });
  assert.match(html, /Not covered yet/);
  assert.doesNotMatch(html, /Crosses into the EngineCore/);
});

test('hop on a hidden step renders before the next shown step', () => {
  const html = RTR.codeList(vllm, 'wait');
  const i = html.indexOf('Crosses into the EngineCore process over ZMQ');
  assert.ok(i > 0 && i < html.indexOf('Add to scheduler'));
});

test('codeList shows key steps, with every step behind a details element', () => {
  const html = RTR.codeList(vllm, 'wait');
  const key = vllm.steps.wait.filter(s => s.key);
  const all = vllm.steps.wait;
  assert.match(html, new RegExp('<summary>Show all ' + all.length + ' steps</summary>'));
  const head = html.slice(0, html.indexOf('<details'));
  assert.equal((head.match(/class="step"/g) || []).length, key.length);
  const inside = html.slice(html.indexOf('<details'));
  assert.equal((inside.match(/class="step"/g) || []).length, all.length);
});

test('codeList with all:true lists every step and no details', () => {
  const html = RTR.codeList(vllm, 'wait', { all: true });
  assert.equal((html.match(/class="step"/g) || []).length, vllm.steps.wait.length);
  assert.doesNotMatch(html, /<details/);
});

test('codeList links each step to the pinned commit and shortens the path', () => {
  const html = RTR.codeList(vllm, 'wait');
  assert.match(html, /href="https:\/\/github\.com\/vllm-project\/vllm\/blob\/138810056093301f4881050fcf2b1786939da387\/vllm\/v1\/engine\/core\.py#L526"/);
  assert.match(html, />core\.py:526</);
  assert.match(html, /<code>EngineCore\.add_request/);
});

test('codeList escapes data text', () => {
  const evil = { ...vllm, name: '<i>x</i>', steps: { wait: [{ title: '<script>1</script>', fn: 'a<b', file: 'f.c', line: 1, check: 'x', key: true }] } };
  const html = RTR.codeList(evil, 'wait');
  assert.doesNotMatch(html, /<script>|<i>x/);
  assert.match(html, /&lt;script&gt;/);
});

test('codeList says Not covered yet for a stage with no steps', () =>
  assert.match(RTR.codeList({ ...vllm, steps: {} }, 'wait'), /Not covered yet/));

test('featureRows shows both values with source links', () => {
  const html = RTR.featureRows('wait', ctx);
  assert.match(html, /Fixed number of slots/);
  assert.match(html, /One token budget per step/);
  assert.match(html, /href="https:\/\/github\.com\/ggml-org\/llama\.cpp\/blob\/2ca15f5404760548c39e7b92bd43116a09414a1a\/common\/arg\.cpp#L2544"/);
  assert.match(html, />arg\.cpp:2544</);
});

test('missing feature reads Not covered yet', () => {
  const { cuda_graphs, ...rest } = llama.features;
  const missing = { ...ctx, a: { ...llama, features: rest } };
  assert.match(RTR.featureRows('think', missing), /Not covered yet/);
  assert.doesNotMatch(RTR.featureRows('think', ctx), /Not covered yet/);
});

test('featureRows(null) renders the stage-less catalogue keys', () => {
  const html = RTR.featureRows(null, ctx);
  for (const label of ['Model formats', 'Hardware', 'Structured output', 'Tool calling']) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /Batching/);
  assert.equal(RTR.featureRows('nonexistent', ctx), '');
});

test('no pair file shows the no-write-up line', () =>
  assert.match(RTR.chapter(q1, 0, { ...ctx, pair: null }), /No write-up for this pair yet/));

test('chapter shows the answer, counter, tracer links and next question', () => {
  const html = RTR.chapter(q2, 1, ctx);
  assert.match(html, /id="q2"/);
  assert.match(html, />2 of 4</);
  assert.match(html, /Answer two\./);
  assert.match(html, />Open the llama\.cpp tracer</);
  assert.match(html, />Open the vLLM tracer</);
  assert.match(html, /href="llama-cpp\.html"/);
  assert.match(html, /<a href="#q3">Next question<\/a>/);
  assert.match(html, /<h2>Who reuses your prompt better\?<\/h2>/);
});

test('an unset answer in an existing pair renders no answer paragraph', () => {
  const html = RTR.chapter(q1, 0, ctx);
  assert.doesNotMatch(html, /class="ans"/);
  assert.doesNotMatch(html, /No write-up for this pair yet/);
});

test('last chapter has no Next question link', () =>
  assert.doesNotMatch(RTR.chapter(q4, 3, ctx), /Next question/));

test('chapter stage bar uses reported numbers and labels how each was measured', () => {
  const html = RTR.chapter(q1, 0, ctx);
  assert.match(html, /class="stagebar"/);
  assert.match(html, />4 ms</);
  assert.match(html, />22 ms</);
  assert.match(html, /queue \+ overhead/);
  assert.match(html, /at 32 users/);
});

test('stage bar falls back to the empty state without bench', () =>
  assert.match(RTR.chapter(q1, 0, { ...ctx, bench: {} }), /Benchmark running, results soon/));

test('chapter without a stage-time stage (q3) has no stage bar', () =>
  assert.doesNotMatch(RTR.chapter(q3, 2, ctx), /class="stagebar"/));

test('every stage lists all four stages and a General block', () => {
  const html = RTR.everyStage(ctx);
  for (const s of RT.compare.stages) assert.match(html, new RegExp('id="stage-' + s.id + '"'));
  assert.match(html, /id="stage-general"/);
  assert.match(html, /Tool calling/);
  assert.match(html, /Slots decide\./);
  assert.match(html, /The budget decides\./);
});

test('stageRow summary is omitted, not invented, when the pair lacks it', () => {
  const html = RTR.stageRow('speak', ctx);
  assert.match(html, /id="stage-speak"/);
  assert.doesNotMatch(html, /Slots decide\./);
});

test('track has one group per stage and no hard-coded engine data', () => {
  const svg = RTR.track(ctx, 'think');
  for (const s of RT.compare.stages) assert.equal((svg.match(new RegExp('data-stage="' + s.id + '"', 'g')) || []).length, 1);
  assert.match(svg, /data-stage="think"[^>]*data-active="true"/);
  assert.doesNotMatch(svg, /data-stage="wait"[^>]*data-active/);
  assert.match(svg, />llama\.cpp</);
  const bare = { id: 'bare', name: 'Zed', color: '#336699', repo: 'r', commit: 'c', tracer: 't.html', shape: 's', features: {}, steps: {} };
  const other = RTR.track({ ...ctx, a: bare }, 'wait');
  assert.match(other, />Zed</);
  assert.doesNotMatch(other, />llama\.cpp</);
});

test('track can be drawn as a horizontal strip', () =>
  assert.match(RTR.track(ctx, 'wait', { horizontal: true }), /<svg[^>]*viewBox="0 0 \d+ \d+"/));

test('output follows design rules', () => {
  const html = prose(RTR.everyStage(ctx) + RTR.chapter(q1, 0, ctx) + RTR.chapter(q3, 2, ctx) + RTR.chapter(q4, 3, fullCtx) + RTR.chapter(q2, 1, fullCtx) + RTR.track(ctx, 'wait'));
  assert.doesNotMatch(html, / · |→|↓|PLACEHOLDER|letter-spacing/);
});
