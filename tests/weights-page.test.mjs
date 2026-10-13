import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseValues, buildTape, VALUE_KEYS } from '../inference/capture/to-weights.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const PAGE = 'llama-cpp-weights.html';

// ---- the eval-callback log parser -------------------------------------------

const LOG = `
common_debug_cb_eval:                     embd = (f32)   GET_ROWS(token_embd.weight{4096, 128256, 1, 1}, inp_tokens{2, 1, 1, 1}}) = {4096, 2, 1, 1}
    [
        [
            [      0.0000,       0.0000,       0.0000,    ...,       0.0040,      -0.0000,       0.0012  ],
            [     -0.0002,      -0.0002,       0.0002,    ...,      -0.0002,       0.0004,       0.0008  ],
        ],
    ]
    sum = 5.741908
common_debug_cb_eval:                   norm-0 = (f32)   RMS_NORM(CUDA0#embd#0{4096, 2, 1, 1}, }) = {4096, 2, 1, 1}
    [
        [
            [      1.0000,       2.0000,       3.0000,    ...,       4.0000,       5.0000,       6.0000  ],
            [      1.0000,       2.0000,       3.0000,    ...,       4.0000,       5.0000,       6.0000  ],
        ],
    ]
    sum = 1.5
common_debug_cb_eval:                   Qcur-0 = (f32)       ROPE(Qcur-0{128, 32, 2, 1}, CUDA0#inp_pos#0{2, 1, 1, 1}}) = {128, 32, 2, 1}
    [
        [
            [     -0.1109,      -0.1615,       0.2323,    ...,       0.8482,       0.4271,       0.2888  ],
            ...,
            [     -0.5451,       0.3743,       0.2137,    ...,       0.4501,      -0.3540,       0.2229  ],
        ],
        [
            [      0.0182,       0.0134,       0.1143,    ...,       0.1212,       0.0619,       0.0500  ],
            ...,
            [      0.1915,       0.0873,       0.2035,    ...,       0.1435,       0.1661,       0.1668  ],
        ],
    ]
    sum = -12.25
common_debug_cb_eval:                   norm-0 = (f32)   RMS_NORM(ffn_inp-0{4096, 2, 1, 1}, }) = {4096, 2, 1, 1}
    [
        [
            [      7.0000,       8.0000,       9.0000,    ...,       1.0000,       1.0000,       1.0000  ],
            [      7.0000,       8.0000,       9.0000,    ...,       1.0000,       1.0000,       1.0000  ],
        ],
    ]
    sum = 2.5
common_debug_cb_eval:            result_output = (f32)    MUL_MAT(output.weight{4096, 128256, 1, 1}, result_norm{4096, 1, 1, 1}}) = {128256, 1, 1, 1}
    [
        [
            [      4.1837,      10.5195,       7.8032,    ...,       0.0029,       0.0029,       0.0029  ],
        ],
    ]
    sum = 112102.882812
`;

test('parseValues keeps the printed corners, the gap markers and the sum of each wanted node', () => {
  const v = parseValues(LOG, { embd: ['embd', 'GET_ROWS', 0], q_rope: ['Qcur-0', 'ROPE', 0], logits: ['result_output', 'MUL_MAT', 0] });
  assert.deepStrictEqual(v.embd.shape, [4096, 2, 1, 1]);
  assert.strictEqual(v.embd.sum, 5.741908);
  // 2-d: a list of rows (one per token), each row = head values, tail values
  assert.deepStrictEqual(v.embd.data, [[[0, 0, 0], [0.004, -0, 0.0012]], [[-0.0002, -0.0002, 0.0002], [-0.0002, 0.0004, 0.0008]]]);
  // 3-d: two token blocks of (row, gap, row)
  assert.strictEqual(v.q_rope.data.length, 2);
  assert.strictEqual(v.q_rope.data[0][1], null);
  assert.deepStrictEqual(v.q_rope.data[1][2], [[0.1915, 0.0873, 0.2035], [0.1435, 0.1661, 0.1668]]);
  assert.strictEqual(v.logits.sum, 112102.882812);
  assert.deepStrictEqual(v.logits.data[0][0], [4.1837, 10.5195, 7.8032]);
});

test('parseValues picks the nth node with the same name and op', () => {
  const v = parseValues(LOG, { a: ['norm-0', 'RMS_NORM', 0], b: ['norm-0', 'RMS_NORM', 1] });
  assert.strictEqual(v.a.sum, 1.5);
  assert.strictEqual(v.b.sum, 2.5);
});

test('parseValues throws when a wanted node is missing', () => {
  assert.throws(() => parseValues(LOG, { x: ['nope', 'ADD', 0] }), /nope/);
});

// ---- the weight tape ------------------------------------------------------------

const T = [
  { name: 'token_embd.weight', type: 'Q4_K', shape: [4096, 128256], bytes: 295501824 },
  { name: 'output_norm.weight', type: 'F32', shape: [4096], bytes: 16384 },
  { name: 'output.weight', type: 'Q6_K', shape: [4096, 128256], bytes: 430940160 },
  { name: 'rope_freqs.weight', type: 'F32', shape: [64], bytes: 256 },
  { name: 'blk.1.attn_q.weight', type: 'Q4_K', shape: [4096, 4096], bytes: 9437184 },
  { name: 'blk.0.attn_norm.weight', type: 'F32', shape: [4096], bytes: 16384 },
  { name: 'blk.0.attn_q.weight', type: 'Q4_K', shape: [4096, 4096], bytes: 9437184 },
  { name: 'blk.0.attn_k.weight', type: 'Q4_K', shape: [4096, 1024], bytes: 2359296 },
  { name: 'blk.0.attn_v.weight', type: 'Q6_K', shape: [4096, 1024], bytes: 3440640 },
  { name: 'blk.0.attn_output.weight', type: 'Q4_K', shape: [4096, 4096], bytes: 9437184 },
  { name: 'blk.0.ffn_norm.weight', type: 'F32', shape: [4096], bytes: 16384 },
  { name: 'blk.0.ffn_gate.weight', type: 'Q4_K', shape: [4096, 14336], bytes: 33030144 },
  { name: 'blk.0.ffn_up.weight', type: 'Q4_K', shape: [4096, 14336], bytes: 33030144 },
  { name: 'blk.0.ffn_down.weight', type: 'Q6_K', shape: [14336, 4096], bytes: 48234496 },
];

test('buildTape lays the GPU weights out in read order, per layer, with the embedding kept apart on the CPU', () => {
  const tape = buildTape(T);
  assert.deepStrictEqual(tape.order, ['attn_norm', 'attn_q', 'attn_v', 'attn_k', 'attn_output', 'ffn_norm', 'ffn_gate', 'ffn_up', 'ffn_down']);
  assert.strictEqual(tape.layers.length, 2);
  assert.deepStrictEqual(tape.layers[0].attn_v, { t: 'Q6_K', b: 3440640 });
  assert.deepStrictEqual(tape.layers[1].attn_q, { t: 'Q4_K', b: 9437184 });
  assert.strictEqual(tape.layers[1].attn_k, undefined);
  assert.deepStrictEqual(tape.shapes.ffn_down, [14336, 4096]);
  assert.deepStrictEqual(tape.cpu, { t: 'Q4_K', b: 295501824, shape: [4096, 128256] });
  assert.deepStrictEqual(tape.out.map(x => x.k), ['output_norm', 'output']);
  const gpu = tape.layers.flatMap(l => Object.values(l)).reduce((a, x) => a + x.b, 0) + tape.out.reduce((a, x) => a + x.b, 0);
  assert.deepStrictEqual(tape.misc, [{ k: 'rope_freqs', t: 'F32', b: 256, shape: [64] }]);
  assert.strictEqual(gpu + 256, tape.gpuBytes);
  assert.strictEqual(tape.gpuBytes + tape.cpu.b, T.reduce((a, x) => a + x.bytes, 0));
});

// ---- the page's data block ------------------------------------------------------------

function loadPage() {
  const html = read(PAGE);
  const block = /\/\* DATA START \*\/([\s\S]*?)\/\* DATA END \*\//.exec(html);
  assert.ok(block, 'data block markers');
  const measured = JSON.parse(/<script id="measured" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const ctx = { MEASURED: measured };
  vm.createContext(ctx);
  vm.runInContext(block[1] + '\n;Object.assign(globalThis,{SHA,STEPS,PHASES,DEFAULT_PHASE});', ctx);
  return { html, measured, ...ctx };
}

test('every step names a tape tensor, a measured role or neither, and its values exist in both phases', () => {
  const { STEPS, PHASES, measured } = loadPage();
  const m = measured.models.q4_k_m;
  const ids = STEPS.map(s => s.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  const tapeKeys = new Set([...measured.tape.order, 'token_embd', ...measured.tape.out.map(x => x.k)]);
  for (const s of STEPS) {
    for (const k of s.tensors || []) assert.ok(tapeKeys.has(k), `${s.id}: tape ${k}`);
    for (const ph of PHASES) {
      // roles are one list, or one list per phase where the kernels differ (gate+up fuse in decode)
      const roles = Array.isArray(s.roles) ? s.roles : (s.roles || {})[ph] || [];
      for (const r of roles) assert.ok(m[ph].byRole[r], `${s.id}: ${ph} role ${r}`);
      for (const v of s.values || []) assert.ok(measured.values[ph][v], `${s.id}: ${ph} values ${v}`);
    }
    assert.ok(s.ref && s.ref.file && Number.isInteger(s.ref.line) && s.ref.check, `${s.id}: ref`);
  }
  assert.ok(STEPS.filter(s => s.values && s.values.length).length >= 12);
  assert.ok(Object.keys(measured.values.prefill).every(k => VALUE_KEYS[k]));
});

test('the tape covers every GPU byte the forward page counts, and the embedding stays on the CPU', () => {
  const { measured } = loadPage();
  const m = measured.models.q4_k_m;
  assert.strictEqual(measured.tape.gpuBytes, m.weightsBytes);
  assert.strictEqual(measured.tape.layers.length, 32);
  assert.strictEqual(Math.round(measured.tape.cpu.b / 1048576 * 10) / 10, m.embdMiB);
});

test('the prompt pass values come from the real prompt, whose 41 tokens are carried with their text', () => {
  const { measured } = loadPage();
  assert.strictEqual(measured.values.prefill.embd.shape[1], measured.promptTokens);
  assert.strictEqual(measured.values.decode.embd.shape[1], 1);
  const toks = measured.prompt.tokens;
  assert.strictEqual(toks.length, measured.promptTokens);
  assert.deepStrictEqual(toks.slice(0, 3).map(t => t.piece), ['<|begin_of_text|>', '<|start_header_id|>', 'system']);
  assert.deepStrictEqual(toks.slice(-3).map(t => t.piece), ['assistant', '<|end_header_id|>', '\n\n']);
  assert.deepStrictEqual(toks.slice(30, 36).map(t => t.piece), ['Why', ' is', ' the', ' sky', ' blue', '?']);
  assert.strictEqual(toks[30].id, 10445);
  assert.strictEqual(measured.prompt.reply[0], 'The');
  assert.strictEqual(measured.values.prefill.logits.shape[0], 128256);
  // the pieces of the logit ids the table prints, and of the token the scores became
  assert.strictEqual(measured.vocab['0'], '!');
  assert.strictEqual(measured.vocab['128255'], '<|reserved_special_token_247|>');
  assert.strictEqual(measured.vocab['791'], 'The');
});

test('the page opens on the real prompt pass', () => {
  const { DEFAULT_PHASE } = loadPage();
  assert.strictEqual(DEFAULT_PHASE, 'prefill');
});

test('the weights page is linked from the tracers page and the inference tracer', () => {
  assert.match(read('tracers.html'), /href="llama-cpp-weights\.html"/);
  assert.match(read('llama-cpp-inference.html'), /href="llama-cpp-weights\.html"/);
});
