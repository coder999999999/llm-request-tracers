// Verifies every source reference in llama-cpp-forward.html against llama.cpp at the pinned commit,
// with the same rule as tools/check-sources.mjs: the `check` text must appear within 3 lines of `line`.
//
//   node inference/capture/check-page-refs.mjs
//
// Reads the local checkout from bench/fetch_llama_src.sh when it is at the pinned commit,
// otherwise fetches each file from raw.githubusercontent.com. Exits 1 on any miss.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRef } from '../../tools/check-sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'llama-cpp-forward.html'), 'utf8');
const commit = /"commit":"([0-9a-f]{40})"/.exec(html)?.[1];
if (!commit) throw new Error('no commit in the measured data block; run to-page.mjs first');
const engine = { repo: 'https://github.com/ggml-org/llama.cpp', commit };

// { file: '...', line: N, check: '...' } with single-quoted JS strings (\' escapes allowed)
const STR = String.raw`'((?:[^'\\]|\\.)*)'`;
const RE = new RegExp(String.raw`\{\s*file:\s*${STR},\s*line:\s*(\d+),\s*check:\s*${STR}`, 'g');
const unq = s => s.replace(/\\(.)/g, '$1');
const refs = [...html.matchAll(RE)].map(m => ({ engine, file: unq(m[1]), line: +m[2], check: unq(m[3]) }));

const local = path.join(root, 'bench', '.src', 'llama.cpp');
let useLocal = false;
try { useLocal = execFileSync('git', ['-C', local, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === commit; } catch {}
const cache = new Map();
async function getText(url) {
  if (cache.has(url)) return cache.get(url);
  let text = null;
  if (useLocal) {
    const file = url.split(`/${commit}/`)[1];
    const p = path.join(local, file);
    text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  } else {
    const r = await fetch(url);
    text = r.status === 404 ? null : await r.text();
  }
  cache.set(url, text);
  return text;
}

let bad = 0;
for (const r of refs) {
  const res = await checkRef(r, getText);
  if (!res.ok) { bad++; console.log(`MISS ${r.file}:${r.line} "${r.check}": ${res.reason}`); }
}
console.log(`${refs.length - bad}/${refs.length} references ok (${useLocal ? 'local checkout' : 'GitHub'} at ${commit.slice(0, 7)})`);
process.exit(bad ? 1 : 0);
