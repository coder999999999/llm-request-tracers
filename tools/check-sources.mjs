// Verifies every code reference (engine steps and features) against the
// engine's pinned git commit: the file must exist at that commit and the
// `check` token must appear within ±3 lines of the stated line.
//
//   node tools/check-sources.mjs      prints one line per miss, exits 1 on any
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteData } from './load-data.mjs';

const WINDOW = 3;

// https://github.com/<owner>/<repo> + commit + file -> raw.githubusercontent URL
export function rawURL(engine, file) {
  const m = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/*$/.exec(String(engine.repo).trim());
  if (!m) throw new Error('not a GitHub repo URL: ' + engine.repo);
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${engine.commit}/${file}`;
}

// ref = {engine, file, line, check}; getText(url) -> string | null (null = 404).
// Never throws: every failure becomes {ok:false, reason, url}.
export async function checkRef(ref, getText) {
  let url = ref.file;
  try {
    url = rawURL(ref.engine, ref.file);
    let text;
    try {
      text = await getText(url);
    } catch (e) {
      return { ok: false, reason: 'fetch failed: ' + (e && e.message || e), url };
    }
    if (text === null || text === undefined) return { ok: false, reason: '404 not found', url };
    const lines = String(text).split(/\r?\n/);
    const line = Number(ref.line);
    if (!Number.isInteger(line) || line < 1) return { ok: false, reason: `invalid line ${ref.line}`, url };
    const from = Math.max(1, line - WINDOW);
    const to = Math.min(lines.length, line + WINDOW);
    for (let i = from; i <= to; i++) {
      if (lines[i - 1].includes(ref.check)) return { ok: true, url };
    }
    return {
      ok: false,
      reason: `"${ref.check}" not within ${WINDOW} lines of line ${line}` +
        (line > lines.length ? ` (file has only ${lines.length} lines)` : ''),
      url,
    };
  } catch (e) {
    return { ok: false, reason: 'error: ' + (e && e.message || e), url };
  }
}

// Collects every step and feature reference from RT.
// Returns {refs, missing}: refs are {engineId, engine, where, file, line, check}
// ready for checkRef; missing lists "engine/where: missing X" messages for
// entries lacking file, line or check (these are never fetched).
export function refsFromRT(RT) {
  const refs = [];
  const missing = [];
  const add = (engineId, engine, where, entry) => {
    const absent = ['file', 'line', 'check'].filter(k => {
      const v = entry && entry[k];
      return v === undefined || v === null || v === '';
    });
    if (absent.length) {
      missing.push(`${engineId} ${where}: missing ${absent.join(', ')}`);
      return;
    }
    refs.push({ engineId, engine, where, file: entry.file, line: entry.line, check: entry.check });
  };
  for (const [engineId, engine] of Object.entries(RT.engines || {})) {
    for (const [stage, list] of Object.entries(engine.steps || {})) {
      (list || []).forEach((st, i) => add(engineId, engine, `steps.${stage}[${i}]${st && st.fn ? ' ' + st.fn : ''}`, st));
    }
    for (const [key, feat] of Object.entries(engine.features || {})) {
      add(engineId, engine, `features.${key}`, feat);
    }
  }
  return { refs, missing };
}

async function fetchText(url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const RT = loadSiteData(root);
  const { refs, missing } = refsFromRT(RT);
  let misses = missing.length;
  missing.forEach(m => console.log(m));

  const cache = new Map(); // url -> Promise<string|null> (one fetch per file)
  const cached = url => {
    if (!cache.has(url)) cache.set(url, fetchText(url));
    return cache.get(url);
  };
  const results = await Promise.all(refs.map(r =>
    checkRef({ engine: r.engine, file: r.file, line: r.line, check: r.check }, cached)));
  results.forEach((res, i) => {
    if (res.ok) return;
    misses++;
    const r = refs[i];
    console.log(`${r.engineId} ${r.where} ${r.file}:${r.line}: ${res.reason} (${res.url})`);
  });
  console.log(`${refs.length + missing.length} references checked, ${misses} miss${misses === 1 ? '' : 'es'}`);
  process.exitCode = misses ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
