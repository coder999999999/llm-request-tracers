import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const PAGE = 'llama-cpp-lens.html';

function loadPage() {
  const html = read(PAGE);
  const measured = JSON.parse(/<script id="measured" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const block = /\/\* DATA START \*\/([\s\S]*?)\/\* DATA END \*\//.exec(html);
  assert.ok(block, 'data block markers');
  const ctx = { MEASURED: measured };
  vm.createContext(ctx);
  vm.runInContext(block[1] + '\n;Object.assign(globalThis,{SHA,REFS,NOTES});', ctx);
  return { html, measured, ...ctx };
}

test('the lens covers every layer and position, with probabilities that are probabilities', () => {
  const { measured: m } = loadPage();
  assert.strictEqual(m.lens.length, m.layers + 1);
  for (const layer of m.lens) {
    assert.strictEqual(layer.length, m.pieces.length);
    for (const cell of layer) {
      assert.strictEqual(cell.length, m.topk);
      let prev = 1;
      for (const [id, piece, p] of cell) { assert.ok(Number.isInteger(id) && typeof piece === 'string'); assert.ok(p >= 0 && p <= prev + 1e-9, 'sorted'); prev = p; }
    }
  }
  // the last layer at the last position agrees with the profiled run's first reply token
  assert.strictEqual(m.lens[m.layers][m.pieces.length - 1][0][1], 'The');
});

test('the trajectory tracks the final candidates through every layer and ends at the lens', () => {
  const { measured: m } = loadPage();
  assert.strictEqual(m.trajectory.length, m.layers + 1);
  assert.strictEqual(m.candidates[0][1], 'The');
  for (const row of m.trajectory) { assert.strictEqual(row.length, m.candidates.length); for (const p of row) assert.ok(p >= 0 && p <= 1); }
  const last = m.lens[m.layers][m.pieces.length - 1];
  assert.ok(Math.abs(m.trajectory[m.layers][0] - last[0][2]) < 1e-3);
});

test('direct logit attribution has one entry per head, layer and the embedding, and sums to the direct logit', () => {
  const { measured: m } = loadPage();
  const C = m.candidates.length;
  assert.strictEqual(m.dla.embed.length, C);
  assert.strictEqual(m.dla.heads.length, m.layers);
  for (const l of m.dla.heads) { assert.strictEqual(l.length, m.heads); for (const h of l) assert.strictEqual(h.length, C); }
  assert.strictEqual(m.dla.mlp.length, m.layers);
  // centred on the candidates' mean: the attributions of one component sum to about zero over the candidates
  const sumC = m.dla.heads[10][27].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sumC) < 0.05, `centred: ${sumC}`);
});

test('references and notes are complete and the page is linked', () => {
  const { REFS, NOTES, SHA, measured } = loadPage();
  assert.strictEqual(SHA, measured.commit);
  for (const r of REFS) assert.ok(r.file && Number.isInteger(r.line) && r.check && r.what, JSON.stringify(r));
  assert.ok(NOTES.length >= 3);
  assert.match(read('tracers.html'), /href="llama-cpp-lens\.html"/);
  assert.match(read('llama-cpp-attention.html'), /href="llama-cpp-lens\.html"/);
});
