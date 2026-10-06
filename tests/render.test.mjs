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

// Removes code, which carries function names copied verbatim from the tracers.
const prose = (html) => html.replace(/<code>[\s\S]*?<\/code>/g, '');

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
  // long sentences wrap onto several lines, so compare the text with the markup removed
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const e of [llama, vllm]) for (const s of Object.values(e.steps).flat()) {
    if (s.hopText) assert.ok(text.includes(s.hopText), s.hopText);
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
  assert.match(html, /<code>Scheduler\.schedule<\/code>/);
  assert.match(html, /<span class="fn">EngineCore\.add_request to Scheduler\.add_request<\/span>/);
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

test('chapter stage bar compares like with like and labels how each was measured', () => {
  const html = RTR.chapter(q1, 0, ctx);
  assert.match(html, /class="stagebar"/);
  assert.match(html, />15 ms</);
  assert.match(html, />22 ms</);
  assert.doesNotMatch(html, />4 ms</);
  assert.match(html, /Before prefill/);
  assert.match(html, /queue and overhead, derived/);
  assert.match(html, /at 32 users/);
});

test('vLLM bar carries its reported queue time as a note, llama.cpp has none', () => {
  const html = RTR.stageRow('wait', ctx);
  assert.equal((html.match(/of which queue: 4 ms \(reported\)/g) || []).length, 1);
  const bar = html.slice(html.indexOf('class="stagebar"'));
  assert.ok(bar.indexOf('of which queue') > bar.indexOf('>vLLM<'));
  assert.doesNotMatch(bar.slice(0, bar.indexOf('>vLLM<')), /of which queue/);
});

test('think row is labelled prefill and reported on both', () => {
  const html = RTR.stageRow('think', ctx);
  assert.match(html, /Think \(prefill\)/);
  assert.match(html, />40 ms</);
  assert.match(html, />38 ms</);
  assert.doesNotMatch(html, /of which queue/);
});

test('stage row prints the gap per row, between like-for-like values only', () => {
  const wait = RTR.stageRow('wait', ctx);
  assert.match(wait, /<span class="gap">vLLM 7 ms faster<\/span>/);
  assert.doesNotMatch(wait, /18 ms/);
  const think = RTR.stageRow('think', ctx);
  assert.match(think, /<span class="gap">About even<\/span>/);
});

test('about even means under 10% of the larger value', () => {
  const lvl = (prefill) => ({ id: 'x', levels: [{ users: 32, ttft_ms: prefill + 10, prefill_ms: prefill }] });
  const gap = (a, b) => {
    const html = RTR.stageRow('think', { ...ctx, bench: { 'llama-cpp': lvl(a), vllm: lvl(b) } });
    return /<span class="gap">([^<]*)<\/span>/.exec(html)[1];
  };
  assert.equal(gap(100, 91), 'About even');
  assert.equal(gap(100, 90), 'vLLM 10 ms faster');
  assert.equal(gap(90, 100), 'llama.cpp 10 ms faster');
});

test('gap names the faster engine, whichever side it is on', () => {
  const swapped = { ...ctx, a: vllm, b: llama };
  assert.match(RTR.stageRow('wait', swapped), /vLLM 7 ms faster/);
  assert.doesNotMatch(RTR.stageRow('wait', swapped), /llama\.cpp [\d.,]+ (ms|s) faster/);
});

test('stage row without bench shows the empty state and no gap', () => {
  const html = RTR.stageRow('wait', { ...ctx, bench: {} });
  assert.match(html, /Benchmark running, results soon/);
  assert.doesNotMatch(html, /class="gap"|faster|About even/);
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

// ---- verdict and URL order -------------------------------------------------

const verdictPair = {
  ...pair,
  verdict: { a: ['Run it on a laptop'], b: ['Serve many people at once'] },
  annotations: {
    q1: [{ x: 64, metric: 'tok_s', kind: 'ratio', text: '{v}× at 64 users' }],
    q2: [{ source: 'reuse', metric: 'warm_ttft_ms', kind: 'ratio', text: 'Repeat: {v}× the llama.cpp time' }],
    q4: [{ source: 'kvFull', x: 1024, metric: 'tok_s', kind: 'ratio', text: '{v}× at 1024 tokens' }],
  },
};

test('verdict lists each engine under its own heading, in the text colour', () => {
  const html = RTR.verdict({ ...ctx, pair: verdictPair });
  assert.match(html, />Reach for llama\.cpp if</);
  assert.match(html, />Reach for vLLM if</);
  assert.match(html, /Run it on a laptop/);
  assert.doesNotMatch(html, /color:#d9662a/);
  assert.equal(RTR.verdict({ ...ctx, pair: { ...pair } }), '');
  assert.equal(RTR.verdict({ ...ctx, pair: null }), '');
});

test('a reversed URL shows the same verdict and annotations as the default order', () => {
  const loaded = loadContext(root, ['assets/compare/util.js', 'assets/compare/stage-times.js', 'assets/compare/chart.js', 'assets/compare/render.js']);
  const L = loaded.RT;
  L.registerPair(verdictPair);  // replaces the site pair under the same key
  const build = (search) => {
    const ids = loaded.RTU.pickPair(search, L);
    return { a: L.engines[ids[0]], b: L.engines[ids[1]], pair: L.pairs[ids.join('--')] || L.pairs[ids.slice().reverse().join('--')],
      compare: L.compare, bench: { 'llama-cpp': llamaBench, vllm: vllmBenchFull } };
  };
  const normal = build('?a=llama-cpp&b=vllm');
  const reversed = build('?a=vllm&b=llama-cpp');
  assert.equal(reversed.a.id, 'llama-cpp');
  const render = (c) => [loaded.RTR.verdict(c), ...L.compare.questions.map(q => loaded.RTR.evidence(q, c))].join('\n');
  assert.equal(render(reversed), render(normal));
  assert.match(render(normal), /Reach for llama\.cpp if/);
  assert.match(render(normal), />5\.5× at 64 users</);
});

// ---- annotations on the reuse and kvFull charts ----------------------------

test('reuse chart draws its annotation, and skips it when a run is missing', () => {
  const html = RTR.evidence(q2, { ...fullCtx, pair: verdictPair });
  assert.match(html, />Repeat: 0\.4× the llama\.cpp time</);
  const noWarm = { ...fullCtx, pair: verdictPair, bench: { 'llama-cpp': llamaBench, vllm: { ...vllmBenchFull, reuse: { cold_ttft_ms: 1100 } } } };
  assert.doesNotMatch(RTR.evidence(q2, noWarm), /Repeat: /);
});

test('kvFull chart draws its annotation, and skips it when the row is missing', () => {
  const html = RTR.evidence(q4, { ...fullCtx, pair: verdictPair });
  assert.match(html, />7× at 1024 tokens</);
  const other = { ...verdictPair, annotations: { q4: [{ source: 'kvFull', x: 4096, metric: 'tok_s', kind: 'ratio', text: '{v}× at 4096' }] } };
  assert.doesNotMatch(RTR.evidence(q4, { ...fullCtx, pair: other }), /at 4096/);
});

test('an annotation only draws on the chart whose source it names', () => {
  const wrong = { ...verdictPair, annotations: { q4: [{ source: 'reuse', metric: 'cold_ttft_ms', kind: 'ratio', text: 'WRONG {v}' }] } };
  assert.doesNotMatch(RTR.evidence(q4, { ...fullCtx, pair: wrong }), /WRONG/);
});

test('kvFull accepts {median} objects like the levels do', () => {
  const m = (median) => ({ median, min: median, max: median });
  const med = { ...fullCtx, bench: {
    'llama-cpp': { ...llamaBench, kvFull: [{ max_tokens: 256, tok_s: m(480), failed: m(0) }, { max_tokens: 1024, tok_s: m(300), kv_retries: m(7), failed: m(2) }] },
    vllm: { ...vllmBenchFull, kvFull: [{ max_tokens: 256, tok_s: m(2500) }, { max_tokens: 1024, tok_s: m(2100), preemptions: m(12) }] },
  } };
  const html = RTR.evidence(q4, med);
  assert.match(html, /<title>vLLM, 1,024 max tokens: 2,100<\/title>/);
  assert.match(html, /Preemptions 12/);
  assert.match(html, /Decode retries 7/);
  assert.match(html, /Failed requests 2/);
});

// ---- phone width -----------------------------------------------------------

const sizes = (svg) => [...svg.matchAll(/font-size="(\d+(?:\.\d+)?)"/g)].map(m => Number(m[1]));
const flat = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const narrowCtx = { ...fullCtx, pair: verdictPair, narrow: true };

test('narrow charts and the boundary diagram use a 380 wide viewBox with text of 12 or more', () => {
  for (const q of [q1, q2, q3, q4]) {
    const svg = RTR.evidence(q, narrowCtx).match(/<svg[\s\S]*?<\/svg>/)[0];
    assert.match(svg, /<svg viewBox="0 0 380 /, q.id);
    assert.ok(Math.min(...sizes(svg)) >= 12, q.id + ' ' + sizes(svg).join());
  }
  for (const q of [q1, q2, q3, q4]) assert.match(RTR.evidence(q, { ...fullCtx, pair: verdictPair }), /<svg viewBox="0 0 760 /, q.id);
});

test('narrow boundary diagram keeps every hop sentence, wrapped, and stays inside the viewBox', () => {
  const html = RTR.evidence(q3, narrowCtx);
  const text = flat(html);
  for (const e of [llama, vllm]) for (const s of Object.values(e.steps).flat()) {
    if (s.hopText) assert.ok(text.includes(s.hopText), s.hopText);
  }
  const h = Number(/viewBox="0 0 380 (\d+)"/.exec(html)[1]);
  for (const m of html.matchAll(/<text [^>]*x="(-?[\d.]+)"[^>]*y="([\d.]+)"/g)) {
    assert.ok(Number(m[1]) >= 0 && Number(m[1]) <= 380, 'x ' + m[1]);
    assert.ok(Number(m[2]) <= h, 'y ' + m[2] + ' of ' + h);
  }
});

test('narrow track strip is sized for a phone column', () => {
  const svg = RTR.track(ctx, 'wait', { horizontal: true });
  const w = Number(/viewBox="0 0 (\d+) /.exec(svg)[1]);
  assert.ok(w <= 380, 'viewBox width ' + w);
  assert.ok(Math.min(...sizes(svg)) >= 13, sizes(svg).join());
});

test('engine colours on small text use the darker text colour', () => {
  const text = (html) => html.replace(/<svg[\s\S]*?<\/svg>/g, '');
  const sections = RTR.stageRow('wait', ctx) + RTR.codeList(llama, 'wait');
  assert.doesNotMatch(sections, /<h4 style="color:#d9662a"/);
  assert.match(sections, /<h4 style="color:#[0-9a-f]{6}"/);
  assert.match(RTR.stageRow('wait', ctx), /<span class="lbl" style="color:#2b54d0">vLLM/);
  assert.doesNotMatch(RTR.stageRow('wait', ctx), /<span class="lbl" style="color:#d9662a"/);
  const track = RTR.track(ctx, 'wait');
  assert.doesNotMatch(track, /<text[^>]*fill="#d9662a"/);
  assert.match(track, /<circle[^>]*stroke="#d9662a"/);
  assert.doesNotMatch(RTR.evidence(q3, ctx), /<text[^>]*fill="#d9662a"/);
  assert.doesNotMatch(RTR.evidence(q3, ctx), /<b style="color:#d9662a"/);
  assert.ok(text(sections).length > 0);
});
