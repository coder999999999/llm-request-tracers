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
  vm.runInContext(block[1] + '\n;Object.assign(globalThis,{SHA,PICKS,REFS,SEQ_KINDS});', ctx);
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

test('the transport can walk the layers and the tour', () => {
  const { html, SEQ_KINDS, PICKS } = loadPage();
  assert.deepStrictEqual([...SEQ_KINDS], ['layers', 'tour', 'decode']);
  for (const id of ['tFirst', 'tPrev', 'tPlay', 'tNext', 'tStep', 'tName', 'tProg', 'narr']) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const k of SEQ_KINDS) assert.match(html, new RegExp(`data-seq="${k}"`), k);
  assert.ok(PICKS.length >= 4, 'the tour has steps');
  for (const p of PICKS) assert.ok(p.label && p.why && p.why.length > 40, p.label);
});

test('the decode rows cover every reply token for every head, and the stats agree with the file', () => {
  const { measured } = loadPage();
  const d = measured.decode;
  assert.ok(d, 'decode data present');
  const [L, H, n] = measured.shape;
  assert.strictEqual(d.promptTokens, n);
  assert.strictEqual(d.tokens, n + d.tileRows);
  assert.strictEqual(d.replyPieces.length, d.tileRows);
  assert.strictEqual(d.pieces.length, d.tokens);
  assert.deepStrictEqual(d.pieces.slice(0, n), measured.pieces);
  assert.strictEqual(d.topChoice.length, d.tileRows);
  for (const key of ['sink', 'prev', 'promptShare']) { assert.strictEqual(d[key].length, L, key); for (const row of d[key]) assert.strictEqual(row.length, H, key); }
  const png = fs.readFileSync(path.join(root, d.file));
  assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  assert.strictEqual(w, H * d.tileCols); assert.strictEqual(h, L * d.tileRows);
  assert.ok(png.length < 4 * 1024 * 1024, 'the decode png stays small');
});
