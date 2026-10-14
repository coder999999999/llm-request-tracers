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

// The decode steps: a second run with --reply writes decode.png (one row per reply token, over all keys)
// and its own stats into <dir>/decode/tokens.json. Optional until that run exists.
const ddir = path.join(dir, 'decode');
if (fs.existsSync(path.join(ddir, 'tokens.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(ddir, 'tokens.json'), 'utf8'));
  if (d.pieces.slice(0, L && t.pieces.length).join('\u0000') !== t.pieces.join('\u0000')) throw new Error('decode run: prompt tokens differ from the prompt run');
  const png = fs.readFileSync(path.join(ddir, d.decode_png.file));
  fs.writeFileSync(path.join(root, 'data', 'attention', NAME + '-decode.png'), png);
  data.decode = {
    file: `data/attention/${NAME}-decode.png`,
    tokens: d.tokens, promptTokens: d.prompt_tokens, pieces: d.pieces, replyPieces: d.reply_pieces,
    tileRows: d.decode_png.tile_rows, tileCols: d.decode_png.tile_cols,
    topChoice: d.top_choice,
    sink: d.decode_sink, prev: d.decode_prev, promptShare: d.decode_prompt_share,
    note: d.reply_note,
  };
  console.log('decode:', d.tokens - d.prompt_tokens, 'reply tokens,', (png.length / 1024).toFixed(0) + ' KB png');
}
const html = fs.readFileSync(page, 'utf8');
const re = /(<script id="measured" type="application\/json">)[\s\S]*?(<\/script>)/;
if (!re.test(html)) throw new Error('no <script id="measured"> block in ' + page);
const json = JSON.stringify(data).replace(/</g, '\\u003c');
fs.writeFileSync(page, html.replace(re, `$1${json}$2`));
console.log('wrote', (u8.length / 1024).toFixed(0) + ' KB of maps and', (json.length / 1024).toFixed(1) + ' KB of data into', path.relative(root, page));
