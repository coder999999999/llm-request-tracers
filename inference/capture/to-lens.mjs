// Puts the logit-lens results from logit_lens.py into llama-cpp-lens.html's <script id="measured"> block.
//
//   node inference/capture/to-lens.mjs [captures/<date>/q4_k_m/lens]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.resolve(root, 'inference', process.argv[2] || 'captures/2026-10-07/q4_k_m/lens');
const page = path.join(root, 'llama-cpp-lens.html');

const t = JSON.parse(fs.readFileSync(path.join(dir, 'lens.json'), 'utf8'));
const n = t.prompt_tokens;
if (t.lens.length !== t.layers + 1 || t.lens.some(l => l.length !== n)) throw new Error('lens shape');
if (t.trajectory.length !== t.layers + 1 || t.dla.heads.length !== t.layers) throw new Error('trajectory or dla shape');

const data = {
  commit: '2ca15f5404760548c39e7b92bd43116a09414a1a',
  capture: path.basename(path.resolve(dir, '../..')),
  model: t.model,
  layers: t.layers, heads: t.heads, topk: t.topk,
  ids: t.ids, pieces: t.pieces,
  lens: t.lens, candidates: t.candidates, trajectory: t.trajectory, dla: t.dla,
  method: t.method,
};
const html = fs.readFileSync(page, 'utf8');
const re = /(<script id="measured" type="application\/json">)[\s\S]*?(<\/script>)/;
if (!re.test(html)) throw new Error('no <script id="measured"> block in ' + page);
const json = JSON.stringify(data).replace(/</g, '\\u003c');
fs.writeFileSync(page, html.replace(re, `$1${json}$2`));
console.log('wrote', (json.length / 1024).toFixed(1) + ' KB of lens data into', path.relative(root, page));
