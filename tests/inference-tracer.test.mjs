import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const PAGE = 'llama-cpp-inference.html';

// The page keeps its graph in a DOM-free block between two markers so it can be checked here.
function loadPage() {
  const html = read(PAGE);
  const block = /\/\* DATA START \*\/([\s\S]*?)\/\* DATA END \*\//.exec(html);
  assert.ok(block, 'data block markers');
  const measured = JSON.parse(/<script id="measured" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const ctx = { MEASURED: measured };
  vm.createContext(ctx);
  vm.runInContext(block[1] + '\n;Object.assign(globalThis,{SHA,LANES,REFS,N,E,HOTSEQ,TRACE,PHASES,graphPick});', ctx);
  return { html, measured, ...ctx };
}

test('nodes have unique ids and sit in a lane', () => {
  const { N, LANES } = loadPage();
  const ids = N.map(n => n.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const n of N) assert.ok(n.col >= 0 && n.col < LANES.length, n.id);
});

test('every wire and trace step points at a real node, and the hot path is wired end to end', () => {
  const { N, E, HOTSEQ, TRACE } = loadPage();
  const ids = new Set(N.map(n => n.id));
  for (const [a, b] of E) { assert.ok(ids.has(a), a); assert.ok(ids.has(b), b); }
  const keys = new Set(E.map(([a, b]) => a + '>' + b));
  for (let i = 0; i < HOTSEQ.length - 1; i++) assert.ok(keys.has(HOTSEQ[i] + '>' + HOTSEQ[i + 1]), HOTSEQ[i] + '>' + HOTSEQ[i + 1]);
  for (const s of TRACE) assert.ok(ids.has(Array.isArray(s) ? s[0] : s), String(s));
  assert.ok(keys.has('ffn_down>attn_norm'), 'next-layer loop');
  assert.ok(keys.has('detok>tok'), 'next-token loop');
});

test('measured op groups and graph nodes named by the page exist in both phases', () => {
  const { N, PHASES, MEASURED, graphPick } = loadPage();
  const m = MEASURED.models.q4_k_m;
  for (const ph of PHASES) {
    for (const n of N) {
      for (const op of n.ops || []) assert.ok(m[ph].byOp[op], `${n.id}: ${ph} op ${op}`);
      for (const g of n.g || []) assert.ok(graphPick(m, ph, g), `${n.id}: ${ph} graph node ${g.join(' ')}`);
    }
  }
  const gpu = N.filter(n => n.ops && n.ops.length).map(n => n.id);
  assert.ok(gpu.length >= 11, 'GPU nodes carry measured op groups');
});

test('every source reference is complete and pinned to the measured commit', () => {
  const { N, REFS, SHA, measured } = loadPage();
  assert.strictEqual(SHA, measured.commit);
  for (const n of N) {
    for (const key of n.refs || []) assert.ok(REFS[key], `${n.id}: REFS.${key}`);
  }
  for (const [key, list] of Object.entries(REFS)) {
    for (const r of list) {
      assert.ok(r.file && Number.isInteger(r.line) && r.line > 0 && r.check && r.what, `${key}: ${JSON.stringify(r)}`);
    }
  }
});

test('the forward page and the tracers page link to the inference tracer', () => {
  assert.match(read('llama-cpp-forward.html'), /href="llama-cpp-inference\.html"/);
  assert.match(read('tracers.html'), /href="llama-cpp-inference\.html"/);
});
