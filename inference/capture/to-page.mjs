// Copies the measured numbers from the capture inventories into llama-cpp-forward.html.
//
//   node inference/capture/to-page.mjs [captures/<date>]
//
// The page carries them in <script id="measured" type="application/json">, so it stays a
// single self-contained file. Everything the page shows as a number comes from this block.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const capDir = path.resolve(root, 'inference', process.argv[2] || 'captures/2026-10-07');
const page = path.join(root, 'llama-cpp-forward.html');

const MODELS = [
  { id: 'q4_k_m', label: 'Q4_K_M' },
  { id: 'f16', label: 'F16' },
];

const r1 = x => Math.round(x * 10) / 10;
const kernelRow = k => ({ op: k.op, role: k.role, kernel: k.kernel, us: k.us, grid: k.grid.filter(Boolean).join('×') });
const node = n => ({ name: n.name, op: n.op, type: n.type, src0: n.src0, s0: n.src0_shape, src1: n.src1, s1: n.src1_shape, out: n.out_shape });

function model({ id, label }) {
  const inv = JSON.parse(fs.readFileSync(path.join(capDir, id, 'inventory.json'), 'utf8'));
  const t = inv.trace;
  const bench = Object.fromEntries(inv.bench.filter(b => b.test).map(b => [b.test.replace(/\d+$/, ''), b]));
  return {
    label,
    weightsBytes: inv.weights.gpu_bytes,
    embdMiB: inv.weights.token_embd_mb_on_cpu,
    typeMix: inv.weights.type_mix,
    bench: { pp: bench.pp.avg_ts, ppSd: bench.pp.stddev_ts, tg: bench.tg.avg_ts, tgSd: bench.tg.stddev_ts },
    server: inv.server_timings,
    nodes: inv.graph.prefill.n_nodes,
    nLayer: inv.graph.prefill.n_layer,
    graph: {
      prefill: inv.graph.prefill.layer0.map(node),
      decode: inv.graph.decode.layer0.map(node),
      pre: inv.graph.prefill.pre.map(node),
      post: inv.graph.prefill.post.map(node),
    },
    prefill: {
      kernels: t.prefill.kernels, busyUs: t.prefill.gpu_busy_us, wallUs: t.prefill.wall_us,
      byOp: t.prefill_by_op.ops, totalUs: t.prefill_by_op.total_us,
      layer0: t.prefill_layer0.map(kernelRow), last: t.prefill_last_layer.map(kernelRow), tail: t.prefill_tail.map(kernelRow),
    },
    decode: {
      steps: t.n_passes - 1, kernels: t.decode_median.kernels,
      busyMedianUs: t.decode_median.gpu_busy_us, busyMinUs: t.decode_median.gpu_busy_us_min, busyMaxUs: t.decode_median.gpu_busy_us_max,
      byOp: t.decode_by_op.ops, totalUs: t.decode_by_op.total_us,
      layer0: t.decode_layer0.map(kernelRow), tail: t.decode_tail.map(kernelRow),
      identical: t.decode_kernel_sequence_identical,
    },
    matmulBw: t.decode_matmul_bandwidth.map(m => ({ role: m.role, types: m.types, mib: m.weight_mb, us: m.us, gbps: r1(m.gb_per_s) })),
  };
}

const data = {
  commit: '2ca15f5404760548c39e7b92bd43116a09414a1a',
  capture: path.basename(capDir),
  gpu: 'NVIDIA GeForce RTX 4090',
  peakGBps: 1008, // 384-bit bus at 21 Gbps GDDR6X
  promptTokens: 41,
  genTokens: 64,
  models: Object.fromEntries(MODELS.map(m => [m.id, model(m)])),
};

const html = fs.readFileSync(page, 'utf8');
const re = /(<script id="measured" type="application\/json">)[\s\S]*?(<\/script>)/;
if (!re.test(html)) throw new Error('no <script id="measured"> block in ' + page);
const json = JSON.stringify(data).replace(/</g, '\\u003c');
fs.writeFileSync(page, html.replace(re, `$1${json}$2`));
console.log('wrote measured data', (json.length / 1024).toFixed(1) + ' KB', 'into', path.relative(root, page));
