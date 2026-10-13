// Reads token pieces for a few ids straight from a GGUF file's header (tokenizer.ggml.tokens),
// so the weights page can show the text of the logits it prints. No model loading.
//
//   node inference/capture/gguf-vocab.mjs <model.gguf> <out.json> <id> [<id>...]
import fs from 'node:fs';
const [model, out, ...ids] = process.argv.slice(2);
const want = new Set(ids.map(Number));
const fd = fs.openSync(model, 'r');
let buf = Buffer.alloc(0), off = 0, pos = 0;
function need(n) { while (off + n > buf.length) { const chunk = Buffer.alloc(1 << 20); const r = fs.readSync(fd, chunk, 0, chunk.length, pos); if (!r) throw new Error('eof'); pos += r; buf = Buffer.concat([buf.subarray(off), chunk.subarray(0, r)]); off = 0; } }
const u32 = () => { need(4); const v = buf.readUInt32LE(off); off += 4; return v; };
const u64 = () => { need(8); const v = Number(buf.readBigUInt64LE(off)); off += 8; return v; };
const str = () => { const n = u64(); need(n); const s = buf.toString('utf8', off, off + n); off += n; return s; };
const SIZES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const skip = t => { if (t === 8) str(); else if (t === 9) { const et = u32(), n = u64(); for (let i = 0; i < n; i++) skip(et); } else { need(SIZES[t]); off += SIZES[t]; } };
if (u32() !== 0x46554747) throw new Error('not a GGUF file');
const version = u32(); u64(); const nkv = u64();
const found = {};
for (let i = 0; i < nkv; i++) {
  const key = str(), t = u32();
  if (key === 'tokenizer.ggml.tokens' && t === 9) {
    const et = u32(), n = u64(); if (et !== 8) throw new Error('tokens are not strings');
    for (let id = 0; id < n; id++) { const s = str(); if (want.has(id)) found[id] = s; }
    break;
  }
  skip(t);
}
const missing = [...want].filter(id => !(id in found));
if (missing.length) throw new Error('ids not found: ' + missing.join(', '));
fs.writeFileSync(out, JSON.stringify({ model: model.split(/[\/]/).pop(), gguf_version: version, pieces: found }, null, 1) + '\n');
console.log('wrote', out, JSON.stringify(found));
