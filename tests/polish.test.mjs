import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../tools/load-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const c = loadContext(root, [
  'assets/compare/util.js', 'assets/compare/stage-times.js', 'assets/compare/chart.js', 'assets/compare/render.js',
]);
const { RT, RTR, RTU } = c;

// ---- fn strings: code only when they look like code ---------------------

const step = (fn) => ({ title: 'T', fn, file: 'a.cpp', line: 1, check: 'x', key: true });
const engineWith = (fn) => ({ ...RT.engines['llama-cpp'], steps: { arrive: [step(fn)] } });
const html = (fn) => RTR.codeList(engineWith(fn), 'arrive');

test('identifier and call fn strings render inside <code>', () => {
  for (const fn of ['get_available_slot', 'server_queue::start_loop', 'Server.ChatHandler', 'update_slots()', 'std::vector<int>', 'a.b[0]']) {
    assert.match(html(fn), /<code>[^<]+<\/code>/, fn);
    assert.doesNotMatch(html(fn), /class="fn"/, fn);
  }
});

test('pipelines and comments render as plain text, not <code>', () => {
  for (const fn of ['rd.post_tasks → server_queue::post', 'NoSignalServer · asyncio event loop', 'safe_apply_chat_template (thread pool)',
    'for (il = 0; il < n_layer; ++il)', 'a | b', 'parse then send', 'x // comment']) {
    const out = html(fn);
    assert.doesNotMatch(out, /<code>/, fn);
    assert.match(out, /<span class="fn">/, fn);
  }
});

test('plain-text fn drops arrows and middle dots like other prose, and is escaped', () => {
  const out = html('a → b · <i>c</i>');
  assert.doesNotMatch(out, /[→·]/);
  assert.match(out, /a to b, &lt;i&gt;c&lt;\/i&gt;/);
});

test('real step data: every fn lands in exactly one branch', () => {
  for (const id of ['llama-cpp', 'vllm']) {
    for (const list of Object.values(RT.engines[id].steps)) {
      for (const s of list) {
        const out = RTR.codeList({ ...RT.engines[id], steps: { arrive: [s] } }, 'arrive');
        assert.strictEqual(/<code>/.test(out) !== /class="fn"/.test(out), true, s.fn);
      }
    }
  }
});

// ---- tracer step counts typed in index.html -----------------------------

// Total steps in a tracer page: the hot path plus the generation-loop steps.
function tracerTotal(file) {
  const h = read(file);
  const hot = JSON.parse(/const HOTSEQ = (\[[^\]]*\]);/.exec(h)[1]);
  const at = h.indexOf('TRACE.splice(TRACE.length,0,');
  const end = h.indexOf('\n);', at);
  const extra = vm.runInNewContext('[' + h.slice(at + 'TRACE.splice(TRACE.length,0,'.length, end) + ']');
  return hot.length + extra.length;
}
function moduleMapSteps() {
  return JSON.parse(/<script type="application\/json" id="trace">(.*?)<\/script>/s.exec(read('vllm-module-graph.html'))[1]).steps.length;
}
function cardText(index, href) {
  const m = new RegExp('<a class="tool" href="' + href + '">([\\s\\S]*?)</a>').exec(index);
  assert.ok(m, 'card for ' + href);
  return m[1];
}

test('tracer cards state the real step counts', () => {
  const index = read('index.html');
  assert.match(cardText(index, 'llama-cpp.html'), new RegExp('\\b' + tracerTotal('llama-cpp.html') + ' steps'));
  assert.match(cardText(index, 'vllm.html'), new RegExp('\\b' + tracerTotal('vllm.html') + ' steps'));
  assert.match(cardText(index, 'vllm-module-graph.html'), new RegExp('\\b' + moduleMapSteps() + ' steps'));
});

test('module map card states the real module count', () => {
  const data = JSON.parse(/<script type="application\/json" id="data">(.*?)<\/script>/s.exec(read('vllm-module-graph.html'))[1]);
  assert.match(cardText(read('index.html'), 'vllm-module-graph.html'), new RegExp('\\b' + data.nodes.length + ' modules'));
});

test('source-linked step data fits inside the tracer totals', () => {
  // data/engines/*.steps.js holds the steps that have a source line (40 and 44). The
  // tracers count every step, client and stream steps included, so the data is a subset.
  for (const [id, file] of [['llama-cpp', 'llama-cpp.html'], ['vllm', 'vllm.html']]) {
    const all = Object.values(RT.engines[id].steps).flat();
    assert.ok(all.length <= tracerTotal(file), id);
    assert.ok(all.every(s => s.n >= 1 && s.n <= tracerTotal(file)), id + ' step numbers within the tracer');
    assert.strictEqual(new Set(all.map(s => s.n)).size, all.length, id + ' step numbers are unique');
  }
});

// ---- a typed number in the pair file ------------------------------------

test('warm reuse annotation types the llama.cpp warm TTFT as the benchmark records it', () => {
  const spec = RT.pairs['llama-cpp--vllm'].annotations.q2.filter(a => a.metric === 'warm_ttft_ms')[0];
  const m = /^Warm: (.+?) ms against \{v\} ms$/.exec(spec.text);
  assert.ok(m, 'annotation text shape: ' + spec.text);
  const warm = RT.bench['llama-cpp'].reuse.warm_ttft_ms;
  const median = typeof warm === 'object' ? warm.median : warm;
  assert.strictEqual(m[1], RTU.fmtNum(median));
});
