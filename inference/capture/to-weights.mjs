// Builds the data block of llama-cpp-weights.html from a capture:
//   - the weight tape, every GPU tensor in the order a decode step reads them, from tensors.json
//   - the real activation values of the eval-callback passes (ops-prefill.log, ops-decode.log):
//     the corner values and sum that common_debug_cb_eval prints for each node
//   - the per-role kernel timings from inventory.json
//
//   node inference/capture/to-weights.mjs [captures/<date>] [captures/<date>-bare]
//
// The ops logs are git-ignored (they are 1 to 2 MB each); the extracted values are committed
// inside the page, so the site needs nothing from this folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VALUE_KEYS = {
  embd: ['embd', 'GET_ROWS', 0],
  attn_norm: ['attn_norm-0', 'MUL', 0],
  q: ['Qcur-0', 'MUL_MAT', 0],
  k: ['Kcur-0', 'MUL_MAT', 0],
  v: ['Vcur-0', 'MUL_MAT', 0],
  q_rope: ['Qcur-0', 'ROPE', 0],
  k_rope: ['Kcur-0', 'ROPE', 0],
  cache_k: ['cache_k_l0 (view)', 'SET_ROWS', 0],
  cache_v: ['cache_v_l0 (view)', 'SET_ROWS', 0],
  attention: ['node_21', 'FLASH_ATTN_EXT', 0],
  attn_out: ['attn_out-0', 'MUL_MAT', 0],
  ffn_inp: ['ffn_inp-0', 'ADD', 0],
  ffn_norm: ['ffn_norm-0', 'MUL', 0],
  gate: ['ffn_gate-0', 'MUL_MAT', 0],
  up: ['ffn_up-0', 'MUL_MAT', 0],
  swiglu: ['ffn_swiglu-0', 'SWIGLU', 0],
  down: ['ffn_out-0', 'MUL_MAT', 0],
  l_out: ['l_out-0', 'ADD', 0],
  l_out_31: ['l_out-31', 'ADD', 0],
  output_norm: ['result_norm', 'MUL', 0],
  logits: ['result_output', 'MUL_MAT', 0],
};

// The order a decode step reads a layer's matrices in the trace (q, v, k is the kernel order).
const LAYER_ORDER = ['attn_norm', 'attn_q', 'attn_v', 'attn_k', 'attn_output', 'ffn_norm', 'ffn_gate', 'ffn_up', 'ffn_down'];

const HEADER = /^common_debug_cb_eval:\s+(.+?) = \((\w+)\)\s+(\w+)\(.*\) = \{([\d, ]+)\}\s*$/;
const NUM = /-?\d+\.\d+/g;

// wanted: { key: [name, op, nth] }. Returns { key: { shape, sum, data } } where data is the
// printed corner structure: nested arrays, a leaf row = [headValues, tailValues], null = "...".
export function parseValues(text, wanted) {
  const lines = text.split(/\r?\n/);
  const seen = {};
  const out = {};
  const want = new Map();
  for (const [key, [name, op, nth]] of Object.entries(wanted)) want.set(`${name}|${op}|${nth || 0}`, key);
  for (let i = 0; i < lines.length; i++) {
    const h = HEADER.exec(lines[i]);
    if (!h) continue;
    const [, name, , op, shapeStr] = h;
    const id = `${name}|${op}`;
    const nth = seen[id] = (seen[id] ?? -1) + 1;
    const key = want.get(`${id}|${nth}`);
    if (!key) continue;
    const shape = shapeStr.split(',').map(s => +s.trim());
    const stack = [[]];
    let sum = null;
    for (i++; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l.startsWith('sum =')) { sum = +l.slice(5).trim(); break; }
      if (l === '[') { const g = []; stack[stack.length - 1].push(g); stack.push(g); continue; }
      if (l === '],' || l === ']') { stack.pop(); continue; }
      if (l.startsWith('...')) { stack[stack.length - 1].push(null); continue; }
      if (l.startsWith('[')) {
        const [head, tail] = l.includes('...') ? l.split('...') : [l, ''];
        const nums = s => (s.match(NUM) || []).map(Number);
        stack[stack.length - 1].push([nums(head), nums(tail)]);
      }
    }
    if (sum === null) throw new Error(`no sum for ${name} ${op} #${nth}`);
    // the printer wraps everything in one bracket per dimension 4..2; drop the single-element wrappers
    let data = stack[0];
    while (Array.isArray(data) && data.length === 1 && Array.isArray(data[0]) && !isRow(data[0])) data = data[0];
    out[key] = { shape, sum, data: isRow(data) ? [data] : data };
  }
  const missing = Object.keys(wanted).filter(k => !out[k]);
  if (missing.length) throw new Error('nodes not found in the log: ' + missing.map(k => wanted[k].join(' ')).join(', '));
  return out;
}
const isRow = x => Array.isArray(x) && x.length === 2 && Array.isArray(x[0]) && (x[0].length === 0 || typeof x[0][0] === 'number') && Array.isArray(x[1]);

// tensors: [{name, type, shape, bytes}] from tensors.json.
export function buildTape(tensors) {
  const by = Object.fromEntries(tensors.map(t => [t.name, t]));
  const layers = [];
  const shapes = {};
  for (const t of tensors) {
    const m = /^blk\.(\d+)\.(\w+)\.weight$/.exec(t.name);
    if (!m) continue;
    const il = +m[1], k = m[2];
    if (!LAYER_ORDER.includes(k)) throw new Error('unexpected layer tensor ' + t.name);
    (layers[il] ??= {})[k] = { t: t.type, b: t.bytes };
    shapes[k] ??= t.shape;
  }
  const ordered = layers.map(l => Object.fromEntries(LAYER_ORDER.filter(k => l[k]).map(k => [k, l[k]])));
  const out = ['output_norm', 'output'].map(k => ({ k, t: by[k + '.weight'].type, b: by[k + '.weight'].bytes, shape: by[k + '.weight'].shape }));
  const e = by['token_embd.weight'];
  // rope_freqs (256 bytes) lives on the GPU too, read by every RoPE; too small to draw, counted here
  const misc = ['rope_freqs'].filter(k => by[k + '.weight']).map(k => ({ k, t: by[k + '.weight'].type, b: by[k + '.weight'].bytes, shape: by[k + '.weight'].shape }));
  const gpuBytes = ordered.flatMap(l => Object.values(l)).reduce((a, x) => a + x.b, 0) + [...out, ...misc].reduce((a, x) => a + x.b, 0);
  return { order: LAYER_ORDER, layers: ordered, shapes, out, misc, cpu: { t: e.type, b: e.bytes, shape: e.shape }, gpuBytes };
}

function byRole(section) {
  return Object.fromEntries(section.roles.map(r => [r.role, { us: r.us, share: r.share, kernels: r.kernels, mb: r.weight_mb, gbps: r.gb_per_s }]));
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const capDir = path.resolve(root, 'inference', process.argv[2] || 'captures/2026-10-07');
  const dir = path.join(capDir, 'q4_k_m');
  const bareDir = path.resolve(root, 'inference', process.argv[3] || 'captures/2026-10-13-bare');
  const page = path.join(root, 'llama-cpp-weights.html');
  const inv = JSON.parse(fs.readFileSync(path.join(dir, 'inventory.json'), 'utf8'));
  const tensors = JSON.parse(fs.readFileSync(path.join(dir, 'tensors.json'), 'utf8'));
  const t = inv.trace;
  const stream = fs.readFileSync(path.join(dir, 'stream.txt'), 'utf8');
  const reply = [...stream.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse('"' + m[1] + '"')).filter(Boolean);
  const bench = Object.fromEntries(inv.bench.filter(b => b.test).map(b => [b.test.replace(/\d+$/, ''), b]));
  const kernelRow = k => ({ op: k.op, role: k.role, kernel: k.kernel, us: k.us, grid: k.grid.filter(Boolean).join('×') });

  const data = {
    commit: inv.commit,
    capture: path.basename(capDir),
    gpu: 'NVIDIA GeForce RTX 4090',
    peakGBps: 1008,
    promptTokens: inv.prompt_tokens,
    genTokens: 64,
    prompt: {
      text: fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8'),
      // tokens.json: llama-tokenize at the same commit on prompt.txt (BOS added), one {id, piece} per token
      tokens: JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')),
      reply: reply.slice(0, 8),
    },
    // vocab-sample.json: pieces for the logit ids the page prints, read from the GGUF by gguf-vocab.mjs
    vocab: JSON.parse(fs.readFileSync(path.join(dir, 'vocab-sample.json'), 'utf8')).pieces,
    // ops-decode.log is a one-token pass over the BOS token, not a step of the reply
    decodeValuesNote: 'one-token pass over <|begin_of_text|>',
    // captures/2026-10-13-bare: the same model on the bare text, 7 tokens, run on the CPU, not profiled
    bare: { tokens: JSON.parse(fs.readFileSync(path.join(bareDir, 'tokens.json'), 'utf8')), text: 'Why is the sky blue?' },
    models: {
      q4_k_m: {
        weightsBytes: inv.weights.gpu_bytes,
        embdMiB: inv.weights.token_embd_mb_on_cpu,
        bench: { pp: bench.pp.avg_ts, tg: bench.tg.avg_ts },
        server: inv.server_timings,
        prefill: { kernels: t.prefill.kernels, busyUs: t.prefill.gpu_busy_us, byRole: byRole(t.prefill_by_role), byOp: t.prefill_by_op.ops, totalUs: t.prefill_by_op.total_us, layer0: t.prefill_layer0.map(kernelRow), tail: t.prefill_tail.map(kernelRow) },
        decode: { steps: t.n_passes - 1, kernels: t.decode_median.kernels, busyMedianUs: t.decode_median.gpu_busy_us, byRole: byRole(t.decode_by_role), byOp: t.decode_by_op.ops, totalUs: t.decode_by_op.total_us, layer0: t.decode_layer0.map(kernelRow), tail: t.decode_tail.map(kernelRow) },
      },
    },
    tape: buildTape(tensors),
    values: {
      prefill: parseValues(fs.readFileSync(path.join(dir, 'ops-prefill.log'), 'utf8'), VALUE_KEYS),
      bare: parseValues(fs.readFileSync(path.join(bareDir, 'ops-bare.log'), 'utf8'), VALUE_KEYS),
      decode: parseValues(fs.readFileSync(path.join(dir, 'ops-decode.log'), 'utf8'), VALUE_KEYS),
    },
  };
  const html = fs.readFileSync(page, 'utf8');
  const re = /(<script id="measured" type="application\/json">)[\s\S]*?(<\/script>)/;
  if (!re.test(html)) throw new Error('no <script id="measured"> block in ' + page);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  fs.writeFileSync(page, html.replace(re, `$1${json}$2`));
  console.log('wrote measured data', (json.length / 1024).toFixed(1) + ' KB', 'into', path.relative(root, page));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
