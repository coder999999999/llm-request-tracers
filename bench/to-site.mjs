// Turns a results folder written by bench/run_all.py into the site's bench data files:
//   node bench/to-site.mjs bench/results/<date> [--out <dir>]     (default out: data/bench)
// Writes llama-cpp.js and vllm.js, each a single RT.registerBench({...}) call.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// run_all.py engine dir -> site id, display file, pinned-commit key in env.json
const ENGINES = [
  { dir: 'llama', id: 'llama-cpp', commitKey: 'llama.cpp' },
  { dir: 'vllm', id: 'vllm', commitKey: 'vllm' },
];
const MODEL_NAME = 'Llama 3.1 8B Instruct';

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const nums = (xs) => xs.filter(isNum);

export function median(xs) {
  const s = nums(xs).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// {median, min, max} across repeats, or null when no repeat has the value.
function spread(xs) {
  const v = nums(xs);
  if (!v.length) return null;
  return { median: median(v), min: Math.min(...v), max: Math.max(...v) };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listSummaries(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.summary.json')).sort()
    .map((f) => readJson(path.join(dir, f)));
}

const serverField = (s, key) => (s.server && !s.server.error && isNum(s.server[key]) ? s.server[key] : null);

function buildLevels(engine, resultsDir) {
  const byUsers = new Map();
  for (const s of listSummaries(path.join(resultsDir, engine.dir, 'main'))) {
    if (s.valid !== true) continue;
    if (!byUsers.has(s.users)) byUsers.set(s.users, []);
    byUsers.get(s.users).push(s);
  }
  const prefillKey = engine.id === 'vllm' ? 'prefill_ms' : 'prompt_ms_median';
  const levels = [];
  for (const users of [...byUsers.keys()].sort((a, b) => a - b)) {
    const reps = byUsers.get(users);
    const level = { users };
    const core = {
      ttft_ms: spread(reps.map((s) => s.ttft_ms && s.ttft_ms.median)),
      tok_s: spread(reps.map((s) => s.tok_s)),
      itl_ms: spread(reps.map((s) => s.itl_ms && s.itl_ms.median)),
      e2e_ms: spread(reps.map((s) => s.e2e_ms && s.e2e_ms.median)),
    };
    if (Object.values(core).some((v) => !v)) continue; // not renderable without the core metrics
    Object.assign(level, core);
    const prefill = spread(reps.map((s) => serverField(s, prefillKey)));
    if (prefill) level.prefill_ms = prefill;
    if (engine.id === 'vllm') {
      const queue = spread(reps.map((s) => serverField(s, 'queue_ms')));
      if (queue) level.queue_ms = queue;
    }
    levels.push(level);
  }
  return levels;
}

function buildReuse(engine, resultsDir) {
  const dir = path.join(resultsDir, 'reuse');
  const aggFile = path.join(dir, `${engine.dir}.json`);
  const agg = fs.existsSync(aggFile) ? readJson(aggFile) : null;
  const re = new RegExp(String.raw`^${engine.dir}-r\d+\.json$`);
  const reps = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => readJson(path.join(dir, f)))
      .filter((r) => r.valid !== false)
    : [];
  // the aggregate holds medians across repeats; when it is marked invalid, rebuild from the valid repeats
  const useAgg = agg && agg.valid !== false;
  const cold = useAgg ? agg.cold_ttft_ms : median(reps.map((r) => r.cold_ttft_ms));
  const warm = useAgg ? agg.warm_ttft_ms : median(reps.map((r) => r.warm_ttft_ms));
  const out = {};
  if (isNum(cold)) out.cold_ttft_ms = cold;
  if (isNum(warm)) out.warm_ttft_ms = warm;
  if (engine.id === 'llama-cpp') {
    // median across valid repeats of each repeat's median warm-turn (turn 2 on) cache_n
    const cacheN = median(reps.map((r) => median((r.turns || []).slice(1).map((t) => t.cache_n))));
    if (cacheN !== null) out.warm_cache_n_median = cacheN;
  }
  return Object.keys(out).length ? out : null;
}

function buildKvFull(engine, resultsDir) {
  const byTokens = new Map();
  for (const s of listSummaries(path.join(resultsDir, engine.dir, 'kvfull'))) {
    if (!byTokens.has(s.max_tokens)) byTokens.set(s.max_tokens, []);
    byTokens.get(s.max_tokens).push(s); // failing runs are the point here, so valid:false stays in
  }
  const extraKey = engine.id === 'vllm' ? 'preemptions' : 'kv_retries';
  const rows = [];
  for (const mt of [...byTokens.keys()].sort((a, b) => a - b)) {
    const reps = byTokens.get(mt);
    const row = { max_tokens: mt };
    const tokS = median(reps.map((s) => s.tok_s));
    const ttft = median(reps.map((s) => s.ttft_ms && s.ttft_ms.median));
    if (tokS !== null) row.tok_s = tokS;
    if (ttft !== null) row.ttft_ms = ttft;
    const extra = median(reps.map((s) => serverField(s, extraKey)));
    if (extra !== null) row[extraKey] = extra;
    const failed = median(reps.map((s) => s.n_err));
    if (failed !== null) row.failed = failed;
    rows.push(row);
  }
  return rows;
}

export function buildBench(resultsDir) {
  const env = readJson(path.join(resultsDir, 'env.json'));
  const out = {};
  for (const engine of ENGINES) {
    const levels = buildLevels(engine, resultsDir);
    if (!levels.length) continue;
    const bench = {
      id: engine.id,
      run: {
        date: env.date,
        gpu: env.gpu && env.gpu.name,
        model: MODEL_NAME,
        commit: env.commits && env.commits[engine.commitKey],
        config: 'main',
      },
      levels,
    };
    const reuse = buildReuse(engine, resultsDir);
    if (reuse) bench.reuse = reuse;
    const kvFull = buildKvFull(engine, resultsDir);
    if (kvFull.length) bench.kvFull = kvFull;
    out[engine.id] = bench;
  }
  return { env, bench: out };
}

export function render(bench, resultsName) {
  return `// Generated by bench/to-site.mjs from bench/results/${resultsName}. Do not edit.\n`
    + `RT.registerBench(${JSON.stringify(bench, null, 2)});\n`;
}

export function generate(resultsDir, outDir) {
  const { bench } = buildBench(resultsDir);
  if (!Object.keys(bench).length) {
    throw new Error(`no valid main-config summaries found under ${resultsDir}`);
  }
  const name = path.basename(path.resolve(resultsDir));
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [id, b] of Object.entries(bench)) {
    const file = path.join(outDir, `${id}.js`);
    fs.writeFileSync(file, render(b, name));
    written.push(file);
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bench');
  const i = args.indexOf('--out');
  if (i >= 0) { out = path.resolve(args[i + 1] || ''); args.splice(i, 2); }
  if (args.length !== 1) {
    console.error('usage: node bench/to-site.mjs <results-dir> [--out <dir>]');
    process.exit(2);
  }
  try {
    for (const f of generate(args[0], out)) console.log(`wrote ${f}`);
  } catch (e) {
    console.error(`to-site: ${e.message}`);
    process.exit(1);
  }
}
