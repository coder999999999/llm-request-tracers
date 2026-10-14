// Puts the attention maps from attention_maps.py into the site:
//   - data/attention/<name>.u8: the uint8 maps, fetched by llama-cpp-attention.html
//   - the page's <script id="measured"> block: tokens, per-head stats, shape, method
//
//   node inference/capture/to-attention.mjs [captures/<date>/q4_k_m/attention]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.resolve(root, 'inference', process.argv[2] || 'captures/2026-10-07/q4_k_m/attention');
const page = path.join(root, 'llama-cpp-attention.html');
const NAME = 'llama-3.1-8b-q4_k_m-prompt';

const t = JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8'));
const u8 = fs.readFileSync(path.join(dir, 'maps.u8'));
const [L, H, n, n2] = t.shape;
if (n !== n2 || u8.length !== L * H * n * n) throw new Error(`maps.u8 is ${u8.length} bytes, expected ${L * H * n * n}`);
fs.mkdirSync(path.join(root, 'data', 'attention'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'attention', NAME + '.u8'), u8);

const data = {
  commit: '2ca15f5404760548c39e7b92bd43116a09414a1a',
  capture: path.basename(path.resolve(dir, '../..')),
  model: t.model,
  file: `data/attention/${NAME}.u8`,
  shape: t.shape,
  ids: t.ids, pieces: t.pieces,
  topTokens: t.top_tokens,
  sink: t.sink, prev: t.prev, entropy: t.entropy_bits,
  method: t.method,
};
const html = fs.readFileSync(page, 'utf8');
const re = /(<script id="measured" type="application\/json">)[\s\S]*?(<\/script>)/;
if (!re.test(html)) throw new Error('no <script id="measured"> block in ' + page);
const json = JSON.stringify(data).replace(/</g, '\\u003c');
fs.writeFileSync(page, html.replace(re, `$1${json}$2`));
console.log('wrote', (u8.length / 1024).toFixed(0) + ' KB of maps and', (json.length / 1024).toFixed(1) + ' KB of data into', path.relative(root, page));
