import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const PAGE = 'llama-cpp-attention.html';

function loadPage() {
  const html = read(PAGE);
  const measured = JSON.parse(/<script id="measured" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const block = /\/\* DATA START \*\/([\s\S]*?)\/\* DATA END \*\//.exec(html);
  assert.ok(block, 'data block markers');
  const ctx = { MEASURED: measured };
  vm.createContext(ctx);
  vm.runInContext(block[1] + '\n;Object.assign(globalThis,{SHA,PICKS,REFS});', ctx);
  return { html, measured, ...ctx };
}

test('the maps file matches the shape the page declares, one byte per attention weight', () => {
  const { measured } = loadPage();
  const [L, H, n, n2] = measured.shape;
  assert.deepStrictEqual([L, H, n, n2], [32, 32, 41, 41]);
  const u8 = fs.readFileSync(path.join(root, measured.file));
  assert.strictEqual(u8.length, L * H * n * n);
  // every row of every map is a softmax: it sums to about 1 (255 in bytes, allowing for rounding)
  for (const [l, h, q] of [[0, 0, 0], [0, 2, 40], [10, 27, 40], [31, 31, 20], [2, 21, 5]]) {
    let s = 0; for (let k = 0; k < n; k++) s += u8[((l * H + h) * n + q) * n + k];
    assert.ok(Math.abs(s - 255) <= 25, `row L${l}H${h}q${q} sums to ${s}`);
    for (let k = q + 1; k < n; k++) assert.strictEqual(u8[((l * H + h) * n + q) * n + k], 0, 'causal: nothing after the query');
  }
});

test('tokens and per-head stats cover the whole prompt and every head', () => {
  const { measured } = loadPage();
  const [L, H, n] = measured.shape;
  assert.strictEqual(measured.pieces.length, n);
  assert.strictEqual(measured.ids.length, n);
  assert.strictEqual(measured.pieces[0], '<|begin_of_text|>');
  assert.ok(measured.pieces.includes(' sky') && measured.pieces.includes(' blue'));
  for (const key of ['sink', 'prev', 'entropy']) {
    assert.strictEqual(measured[key].length, L, key);
    for (const row of measured[key]) assert.strictEqual(row.length, H, key);
  }
  assert.strictEqual(measured.topTokens[0][1], 'The');
});

test('every quick pick names a real head and every reference is complete', () => {
  const { measured, PICKS, REFS, SHA } = loadPage();
  const [L, H] = measured.shape;
  assert.strictEqual(SHA, measured.commit);
  for (const p of PICKS) {
    if (p.layer === 'avg') continue;
    assert.ok(Number.isInteger(p.layer) && p.layer >= 0 && p.layer < L, p.label);
    assert.ok(Number.isInteger(p.head) && p.head >= 0 && p.head < H, p.label);
  }
  for (const r of REFS) assert.ok(r.file && Number.isInteger(r.line) && r.check && r.what, JSON.stringify(r));
});

test('the attention page is linked from the tracers page and the weights page', () => {
  assert.match(read('tracers.html'), /href="llama-cpp-attention\.html"/);
  assert.match(read('llama-cpp-weights.html'), /href="llama-cpp-attention\.html"/);
});
