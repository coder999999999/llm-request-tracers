# Comparison Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the start page with the question-led llama.cpp vs vLLM comparison, rendered from per-engine data files, with every code reference checked against its pinned commit.

**Architecture:** This is still a static site with no build step. Data and renderer are classic `<script>` files: no ES modules, so the page works from `file://`.
- Data files register onto one global, `window.RT`.
- Pure helpers (`RTU`, `RTC`, `RTR`) return HTML/SVG strings, so Node tests can load them in a `vm` context with no browser.
- `page.js` is the only file that touches the DOM.
- Benchmark data (`data/bench/*.js`) comes from the companion benchmark plan. This page must render correctly without it.

**Tech Stack:** HTML/CSS/vanilla JS, Node 24 (`node --test`, built-in `fetch`, `vm`), `puppeteer-core` (dev only) driving the installed Chrome for end-to-end checks.

**Spec:** `docs/superpowers/specs/2026-10-06-engine-comparison-design.md`. Visual reference: `../mockups/v4-polished.html` (outside the repo).

**Companion plan:** `docs/superpowers/plans/2026-10-06-compare-benchmark.md` (can run in parallel).

## Global Constraints

- Branch `compare`. Nothing is pushed to `main` until phase 3 is reviewed.
- Pinned commits:
  - llama.cpp `2ca15f5404760548c39e7b92bd43116a09414a1a`, repo `https://github.com/ggml-org/llama.cpp`
  - vLLM `138810056093301f4881050fcf2b1786939da387`, repo `https://github.com/vllm-project/vllm`
- Colours: page `#f7f6f2`, ink `#121212`, secondary `#4b4b48` and `#86847d`, rules `#e2dfd6`, llama.cpp `#d9662a`, vLLM `#2b54d0`.
- Fonts: Archivo Narrow 700 (H1 and chapter H2 only, uppercase), Archivo (everything else), IBM Plex Mono (function names and file:line only).
- Spacing values: 4, 8, 12, 16, 24, 32, 48, 64, 96 px only.
- Design rules (spec §7.1). **No:**
  - uppercase letter-spaced labels
  - `·` metadata strings
  - monospace outside code
  - stamps, pills or "coming soon" chips
  - titled boxed cards
  - chart legend boxes
  - arrows in running text
- No first person. No performance number or verdict text typed into HTML; all of it comes from data files.
- Every `steps` and `features` entry carries `file`, `line` and `check`, and passes `tools/check-sources.mjs`.
- Must work from `file://` and over HTTP identically. No horizontal page scroll at 390px.
- Never commit personal details (CLAUDE.md).

## Review Focus

1. **Bench data present for one engine but not the other.** Every chart shows the empty state ("Benchmark running, results soon"), never a one-engine chart. Test in Task 5.
2. **URL names an engine that isn't registered** (`?a=ollama&b=vllm`). The page falls back to the default pair and doesn't crash. Test in Task 1.
3. **A cited file that 404s at the pinned commit** (moved or renamed). `check-sources` reports it as a miss with the URL, and doesn't throw. Test in Task 2.
4. **A hop marked on a step that isn't shown** in the curated list. The hop sentence still renders, before the next shown step. Test in Task 5.
5. **A feature key missing for one engine.** That cell reads "Not covered yet" and the row still renders. Test in Task 5.

---

### Task 1: Registry, shared data and helpers

**Files:**
- Create: `package.json`, `data/registry.js`, `data/compare.js`, `assets/compare/util.js`, `tools/load-data.mjs`, `tests/registry.test.mjs`, `tests/util.test.mjs`
- Modify: `.gitignore` (add `node_modules/` is already present; no change if so)

**Interfaces:**
- Produces:
  - `window.RT = { compare, engines:{}, pairs:{}, bench:{}, errors:[], registerEngine(e), addSteps(id, steps), registerPair(p), registerBench(b) }`. Registering a structurally invalid object pushes a message onto `RT.errors` and does not throw.
  - `RT.validateEngine(e) -> string[]`. Empty means valid.
  - `RTU.esc(s) -> string`
  - `RTU.shortPath(file) -> string`: basename.
  - `RTU.srcURL(engine, file, line) -> string`: `${repo}/blob/${commit}/${file}#L${line}`.
  - `RTU.pickPair(search, RT) -> [aId, bId]`
  - `RTU.fmtMs(n) -> string`: `"9 ms"`, `"1.2 s"` from 1000 up.
  - `loadSiteData(root, extraFiles?) -> RT` in `tools/load-data.mjs`. Runs `data/registry.js`, `data/compare.js`, every `data/engines/*.js`, `data/pairs/*.js` and `data/bench/*.js` in a `vm` context with `window = globalThis`.

- [ ] **Step 1: Write `package.json`.** `"private": true`, `"type": "module"`, devDependency `puppeteer-core@^23`, and scripts `"test": "node --test tests/"`, `"test:e2e": "node tests/e2e/smoke.mjs"`, `"check": "node tools/check-sources.mjs"`. Run `npm install`. Expected: `node_modules/` created and ignored by git.

- [ ] **Step 2: Write the failing tests**

```js
// tests/registry.test.mjs
test('valid engine registers with no errors', ...)        // minimal engine: id,name,color,repo,commit,tracer,shape,features:{}
test('unknown stage id in steps is reported', () => {      // RT.addSteps('x', {nap:[...]}) → errors include 'unknown stage "nap"'
test('feature key not in catalogue is reported', ...)      // features:{flux:{...}} → 'unknown feature "flux"'
test('step without check token is reported', ...)          // {title,fn,file,line} → 'missing check'
test('compare.js defines 4 stages and 4 questions', () => {
  assert.deepEqual(RT.compare.stages.map(s => s.id), ['arrive','wait','think','speak']);
  assert.equal(RT.compare.questions.length, 4);
});
// tests/util.test.mjs
test('srcURL builds a blob link at the pinned commit', () =>
  assert.equal(RTU.srcURL({repo:'https://github.com/vllm-project/vllm',commit:'1388'},'vllm/v1/engine/core.py',526),
               'https://github.com/vllm-project/vllm/blob/1388/vllm/v1/engine/core.py#L526'));
test('shortPath keeps the basename', () => assert.equal(RTU.shortPath('tools/server/server-queue.cpp'), 'server-queue.cpp'));
test('pickPair falls back to default for unknown engine', () =>
  assert.deepEqual(RTU.pickPair('?a=ollama&b=vllm', rtWithTwo), ['llama-cpp','vllm']));
test('fmtMs', () => { assert.equal(RTU.fmtMs(9),'9 ms'); assert.equal(RTU.fmtMs(1234),'1.2 s'); });
```

- [ ] **Step 3: Run to see them fail.** Run: `npm test`. Expected: FAIL, module/global not defined.

- [ ] **Step 4: Implement `data/registry.js`, `data/compare.js`, `assets/compare/util.js` and `tools/load-data.mjs`.**
  - `compare.js` stages: `arrive` "Arrive" / "HTTP in, chat template, tokens"; `wait` "Wait" / "Queued, then given a place in the batch"; `think` "Think" / "KV cache, forward pass, sampling"; `speak` "Speak" / "Text back out as server-sent events".
  - Questions `q1`–`q4`, exact text from spec §3.3, with `stages`:
    - q1 `["wait"]`, chart `"throughput"`
    - q2 `["think"]`, chart `"reuse"`
    - q3 `["arrive","speak"]`, chart `"boundaries"`
    - q4 `["think"]`, chart `"kvFull"`
  - Feature catalogue: `{key, stage, label}`. Keys and stages:
    - `api_openai` arrive "API"
    - `chat_template_source` arrive "Chat template"
    - `tokenize_where` arrive "Tokenizing"
    - `batching` wait "Batching"
    - `step_shape` wait "Each step"
    - `prefix_reuse` think "Prompt reuse"
    - `kv_layout` think "KV cache layout"
    - `kv_full` think "KV cache full"
    - `cuda_graphs` think "CUDA graphs"
    - `detokenize_where` speak "Detokenizing"
    - `model_formats` null "Model formats"
    - `hardware` null "Hardware"
    - `structured_output` null "Structured output"
    - `tool_calling` null "Tool calling"
  - `pickPair`: read `a`/`b` from `URLSearchParams`. If both are registered and differ, use them. Otherwise use the `ids` of the first registered pair. If there are no pairs, use the first two engines in registration order.

- [ ] **Step 5: Run the tests.** Run: `npm test`. Expected: all PASS.

- [ ] **Step 6: Commit.** `git add package.json package-lock.json data assets/compare tools/load-data.mjs tests && git commit -m "Add comparison data registry and helpers"`

### Task 2: Source checker

**Files:**
- Create: `tools/check-sources.mjs`, `tests/check-sources.test.mjs`

**Interfaces:**
- Consumes: `loadSiteData` (Task 1).
- Produces:
  - `rawURL(engine, file) -> string`: `https://raw.githubusercontent.com/<owner>/<repo>/<commit>/<file>`.
  - `checkRef(ref, getText) -> Promise<{ok:boolean, reason?:string, url:string}>`, where `ref = {engine, file, line, check}` and `getText(url) -> Promise<string|null>` (null means 404).
  - CLI: `node tools/check-sources.mjs` checks every step and feature, caches each file once, prints one line per miss and exits 1 if any miss.

- [ ] **Step 1: Write the failing tests**

```js
const file = ['a','b','  ctx_http.post("/v1/chat/completions"','d','e','f','g'].join('\n');
test('passes when check token is within ±3 lines', async () =>
  assert.equal((await checkRef({engine:E,file:'x.cpp',line:5,check:'/v1/chat/completions'}, async()=>file)).ok, true));
test('fails when token is 4+ lines away', async () =>
  assert.equal((await checkRef({engine:E,file:'x.cpp',line:7,check:'ctx_http'}, async()=>file)).ok, false));
test('a 404 is a miss with the URL, not a throw', async () => {
  const r = await checkRef({engine:E,file:'gone.cpp',line:1,check:'x'}, async()=>null);
  assert.equal(r.ok, false); assert.match(r.reason, /404/); assert.match(r.url, /gone\.cpp$/);
});
```

- [ ] **Step 2: Run to see them fail.** Run: `node --test tests/check-sources.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `rawURL`, `checkRef` and the CLI. The CLI fetches with built-in `fetch`, treats `404` as `null`, and retries other failures once.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add source checker for pinned-commit references"`

### Task 3: Engine data from the tracers

**Files:**
- Create: `tools/export-steps.mjs`, `data/engines/llama-cpp.steps.js`, `data/engines/vllm.steps.js` (both generated), `data/engines/llama-cpp.js`, `data/engines/vllm.js`

**Interfaces:**
- Consumes: `RT.addSteps`, `RT.registerEngine`, `check-sources` CLI.
- Produces: per engine, `steps[stage] = [{n, title, fn, file, line, check, key?, hop?, hopText?}]`.
  - `n` is the tracer's step number.
  - `hop` is `"thread"` or `"process"` and sits on the first step after the boundary.

- [ ] **Step 1: Implement `tools/export-steps.mjs`.**
  - Use puppeteer-core with `C:/Program Files/Google/Chrome/Application/chrome.exe`, overridable by `CHROME_PATH`.
  - Open each tracer over `file://` and click `#tNext` through the first-token steps.
  - For each step, read the title and fn from `#tName` (split on ` — `), and file and line from the `.insp .src` link's `href` (`/blob/<commit>/<path>#L<n>`).
  - Write `RT.addSteps('<id>', {...})` files.
  - `check` defaults to the last identifier in `fn`, after splitting on `→`, `::`, `.` and spaces.
  - Stage ranges, by tracer step number:
    - llama.cpp:
      - arrive 2–9, wait 10–15, think 16–36, speak 37–41
      - `key` steps: 2,4,6,8 / 10,11,13,15 / 16,21,23,29,33 / 37,38,40
      - hops: 11 `thread` "Hands off to the inference thread"; 38 `thread` "Back to the HTTP thread"
    - vLLM:
      - arrive 2–10, wait 11–19, think 20–37, speak 38–45
      - `key` steps: 2,4,6,7 / 11,14,16,18,19 / 20,21,28,33,36 / 40,42,45
      - hops: 15 `process` "Crosses into the EngineCore process over ZMQ"; 41 `process` "Back to the API process over ZMQ"
- [ ] **Step 2: Run the export.** Run: `node tools/export-steps.mjs`.
  - Expected for llama.cpp: 8 + 6 + 21 + 5 steps.
  - Expected for vLLM: 9 + 9 + 18 + 8 steps.
- [ ] **Step 3: Write the two engine files.** Use the colours, `lang`, `repo`, `commit`, `tracer`, and the `shape` sentences from `../mockups/data.js`. Add features for the keys whose facts are already sourced in the tracers, each with `{value, file, line, check}`:
  - `api_openai`, `chat_template_source`, `tokenize_where`
  - `batching`, `step_shape`
  - `prefix_reuse`, `kv_full`
  - `detokenize_where`

  Values use the wording of the mockup `features` lists.
- [ ] **Step 4: Run the checker.** Run: `npm run check`. Fix each miss by setting an explicit `check` token in the generated file through an override map in `export-steps.mjs` (`CHECK_OVERRIDES = {'llama-cpp:13': 'get_available_slot', ...}`), then re-export. Expected: exit 0.
- [ ] **Step 5: Run the unit tests.** Run: `npm test`. Expected: PASS, with `RT.errors` empty after `loadSiteData`. Add that assertion to `tests/registry.test.mjs`.
- [ ] **Step 6: Commit.** `git commit -m "Add llama.cpp and vLLM engine data exported from the tracers"`

### Task 4: Remaining features research

**Files:**
- Modify: `data/engines/llama-cpp.js`, `data/engines/vllm.js`

- [ ] **Step 1: Research and add the missing keys for both engines.**
  - Keys: `kv_layout`, `cuda_graphs`, `model_formats`, `hardware`, `structured_output`, `tool_calling`.
  - Each value is one plain sentence of at most 70 characters, with `file`, `line` and `check` at the pinned commit. Prefer argument-parser or loader code over docs.
  - If a fact can't be tied to a line, leave the key out, so the page shows "Not covered yet".
- [ ] **Step 2: Run the checker.** Run: `npm run check && npm test`. Expected: exit 0, PASS.
- [ ] **Step 3: Commit.** `git commit -m "Add sourced feature rows for both engines"`

### Task 5: Charts, stage times and section renderers

**Files:**
- Create: `assets/compare/chart.js`, `assets/compare/stage-times.js`, `assets/compare/render.js`, `tests/chart.test.mjs`, `tests/stage-times.test.mjs`, `tests/render.test.mjs`

**Interfaces:**
- Consumes: `RT`, `RTU` (Task 1). Bench shape from the benchmark plan, Task 6:
  - `RT.bench[id] = { run:{date,gpu,model,commit,config}, levels:[{users, ttft_ms, tok_s, itl_ms, e2e_ms, prefill_ms?, queue_ms?}], reuse?:{cold_ttft_ms, warm_ttft_ms}, kvFull?:[{max_tokens, tok_s, ttft_ms, preemptions?, kv_retries?, failed}] }`
  - Every metric inside `levels` is `{median,min,max}`. `kvFull` values are plain numbers.
- Produces:
  - `RTC.lineChart({series:[{label,color,points:[[x,y,min?,max?]]}], xTicks, xLabel, yLabel, annotations:[{x, y, text}], ariaLabel, width, height}) -> string`. SVG with:
    - at most 4 horizontal gridlines
    - labels placed directly at line ends
    - each point a focusable `<circle tabindex="0">` whose `<title>` reads `"<label>, <x> users: <y> (range <min>–<max>)"` (spec §7)
    - a visually hidden `<table>` of the points after it
  - `RTC.barPairs({groups:[{label, values:[{label, color, v}]}], unit, ariaLabel, width}) -> string`: grouped horizontal bars for Q2 (groups "First message" and "Repeat with the same system prompt"), value printed at each bar end, same hidden table.
  - `RTU.annotate(spec, ctx) -> {x, y, text} | null`, with `spec = {x, metric:'tok_s'|'ttft_ms', kind:'ratio'|'value', engine?, text}`. `text` holds `{v}`. `ratio` is b ÷ a at `x`, rounded to 1 decimal; `value` is that engine's median. Returns null when either engine lacks the point, so the annotation is skipped, never shown with a blank number. Pair files store `annotations: { q1:[spec…], … }`.
  - `RTU.stageTimes(bench, users) -> null | { think:{ms, note:'reported'}, wait:{ms, note:'reported'|'queue + overhead'}, other:{ms, note:'derived'}|null }`. Follows spec §5.5:
    - vLLM: queue and prefill as reported; other = TTFT − queue − prefill.
    - llama.cpp: `wait.ms` = TTFT − `prefill_ms` with note `'queue + overhead'`, and `other` = null.
  - `RTR.codeList(engine, stageId, {all:false}) -> string`
  - `RTR.featureRows(stageId|null, ctx) -> string`
  - `RTR.evidence(question, ctx) -> string`
  - `RTR.stageRow(stageId, ctx) -> string`
  - `RTR.chapter(question, index, ctx) -> string`
  - `RTR.everyStage(ctx) -> string`
  - `RTR.track(ctx, activeStageId) -> string`
  - `ctx = {a, b, pair, compare, bench}`

- [ ] **Step 1: Write the failing tests**

```js
test('chart has direct end labels and ≤4 gridlines', () => {
  const svg = RTC.lineChart(twoSeries); assert.match(svg, />vLLM</); assert.match(svg, />llama\.cpp</);
  assert.ok((svg.match(/class="grid"/g)||[]).length <= 4); assert.match(svg, /<table class="sr-only"/); });
test('points are focusable and show the repeat range', () =>
  assert.match(RTC.lineChart(twoSeries), /<circle[^>]*tabindex="0"[^>]*><title>vLLM, 64 users: 2,700 (range 2,650–2,760)</title>/));
test('vLLM stage times use reported queue and prefill', () =>
  assert.deepEqual(RTU.stageTimes(vllmBench, 32), {think:{ms:40,note:'reported'}, wait:{ms:4,note:'reported'}, other:{ms:11,note:'derived'}}));
test('llama.cpp folds queue and overhead together', () =>
  assert.deepEqual(RTU.stageTimes(llamaBench, 32), {think:{ms:38,note:'reported'}, wait:{ms:22,note:'queue + overhead'}, other:null}));
test('annotation ratio is computed from bench, not typed', () =>
  assert.equal(RTU.annotate({x:64,metric:'tok_s',kind:'ratio',text:'{v}× at 64 users'}, ctx).text, '5.5× at 64 users'));
test('annotation is skipped when a point is missing', () =>
  assert.equal(RTU.annotate({x:128,metric:'tok_s',kind:'ratio',text:'{v}×'}, ctx), null));
test('evidence shows empty state when one engine has no bench', () =>
  assert.match(RTR.evidence(q1, {...ctx, bench:{vllm: vllmBench}}), /Benchmark running, results soon/));
test('hop on a hidden step renders before the next shown step', () => {
  const html = RTR.codeList(vllm, 'wait'); const i = html.indexOf('Crosses into the EngineCore process over ZMQ');
  assert.ok(i > 0 && i < html.indexOf('Add to scheduler')); });
test('missing feature reads Not covered yet', () =>
  assert.match(RTR.featureRows('think', ctxMissingCudaGraphsForLlama), /Not covered yet/));
test('no pair file shows the no-write-up line', () =>
  assert.match(RTR.chapter(q1, 0, {...ctx, pair:null}), /No write-up for this pair yet/));
test('output follows design rules', () => {
  const html = RTR.everyStage(ctx) + RTR.chapter(q1,0,ctx);
  assert.doesNotMatch(html, / · |→|↓|PLACEHOLDER|letter-spacing/); });
```

Fixtures go in `tests/fixtures/bench.mjs`:
- vLLM at 32 users: `ttft 55, queue 4, prefill 40`; at 64 users: `tok_s 2700`
- llama.cpp at 32 users: `ttft 60, prefill 38`; at 64 users: `tok_s 495`

- [ ] **Step 2: Run to see them fail.** Run: `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement the three files** (`annotate` goes in `stage-times.js`, alongside the other bench maths). Markup and class names follow `../mockups/v4-polished.html`:
  - `.chapter`, `.num`, `.ans`, `.fig-h`, `.stagebar`, `.paths`, `.step`, `.cross`, `.facts`, `.links`
  - Chapter counter text: `"1 of 4"`
  - Link text: `"Open the llama.cpp tracer"`, `"Open the vLLM tracer"`, `"Next question"`
  - `codeList` shows `key` steps plus a `<details><summary>Show all N steps</summary>…</details>` holding every step.
  - The q3 evidence is the boundary diagram: two lanes, with the hop sentences of both engines placed where they happen. Draw it from step data, not hand-placed coordinates.
- [ ] **Step 4: Run the tests.** Run: `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add chart, stage-time and section renderers"`

### Task 6: The page

**Files:**
- Modify: `index.html` (full rewrite)
- Create: `assets/compare/page.js`, `data/pairs/llama-cpp--vllm.js`, `tests/e2e/smoke.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: the live page. Container ids:
  - `#chapters`, `#every-stage`, `#deep-dives`, `#films`, `#method`
  - `#q1`…`#q4` for chapter anchors
  - `#stage-arrive`…`#stage-speak` for the rows in "Every stage"

- [ ] **Step 1: Write the pair file** with `ids:['llama-cpp','vllm']` and `stageSummaries` (one line per engine per stage, from the mockup `shape` and `why` texts).
  - Write `answers.q2` and `answers.q3` from the code facts already in the data.
  - Leave `answers.q1`, `answers.q4`, `verdict` and `annotations` unset. They come in phase 3 (benchmark plan, Task 8).
- [ ] **Step 2: Write the e2e smoke test (it fails at first).**
  - `tests/e2e/smoke.mjs` serves the repo with Node's `http` on a free port.
  - For widths 1440, 1024 and 390, over both HTTP and `file://`, assert:
    - `scrollWidth <= innerWidth`
    - zero `pageerror` / `console.error`
    - four `.chapter` elements
    - `document.body.innerText` is identical for HTTP and `file://`
  - At 1440: scroll `#q2` into view and assert the track's active stage is `think`.
  - Then inject `RT.registerEngine(fakeOllama)` with `evaluateOnNewDocument` and assert:
    - the picker appears with 3 options
    - with `?a=ollama&b=vllm`, the text "No write-up for this pair yet" and "Not covered yet" are present
- [ ] **Step 3: Run it to see it fail.** Run: `npm run test:e2e`. Expected: FAIL (old page has no `.chapter`).
- [ ] **Step 4: Rewrite `index.html`.**
  - Static HTML: top bar (wordmark, plus links Comparison / Tracers / Films / Method), hero (H1 "llama.cpp *or* vLLM" split as in v4, the dek, "Watch Episode 1 (1:44)" opening the existing `<dialog>` player), the question list linking to `#q1`…`#q4`, and empty containers.
  - Then the sections:
    - `#deep-dives`: the three current tracer cards, restyled to v4 type and colours, keeping the `assets/close-*.webp` images
    - `#films`: the current episode list and the Decision models line
    - `#method`: hardware, model, versions, links to `bench/README.md`, and one line saying more engines will be added
    - the footer
  - Inline CSS uses the Global Constraints tokens.
  - Script tags in this order: registry, compare, engines (`*.steps.js` before `*.js`), pairs, bench (`<script src="data/bench/llama-cpp.js" onerror="this.remove()">`, same for vllm), util, stage-times, chart, render, page.
- [ ] **Step 5: Implement `assets/compare/page.js`.**
  - Build `ctx` from `RT` and `RTU.pickPair(location.search, RT)`, then render the sections.
  - Track: sticky at ≥1100px; a horizontal strip per chapter below that, drawn by `RTR.track`.
  - IntersectionObserver sets `data-active` on the track. Clicking a track stage scrolls to `#stage-<id>` and opens its `<details>`.
  - Picker only when `Object.keys(RT.engines).length >= 3`: two `<select>`s that set `?a=&b=` and re-render.
  - Honour `prefers-reduced-motion` (no smooth scroll).
  - Keep the existing modal player code.
- [ ] **Step 6: Run the tests.** Run: `npm test && npm run test:e2e`. Expected: PASS.
- [ ] **Step 7: Visual check.** Take full-page screenshots at 1440 and 390 into the scratchpad. Compare against `../mockups/v4-polished.png` for type, spacing and rules. Check the design rules by eye: no labels, dots or arrows creeping in.
- [ ] **Step 8: Commit.** `git commit -m "Rebuild start page as the llama.cpp vs vLLM comparison"`

### Task 7: Docs and wrap-up

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Update `README.md`.**
  - Pages table: `index.html` becomes "Comparison of llama.cpp and vLLM: questions, code paths, features, benchmarks".
  - Add a "Data files" section listing `data/` and how to add an engine: an engine file, generated steps, a pair file, bench files.
  - Add a "Checks" section: `npm install`, `npm test`, `npm run check`, `npm run test:e2e`.
- [ ] **Step 2: Add one line to `CLAUDE.md`:** "Run `npm run check` before committing changes under `data/engines/`; read `docs/superpowers/specs/2026-10-06-engine-comparison-design.md` §7.1 before changing page styling."
- [ ] **Step 3: Full verification.** Run: `npm test && npm run check && npm run test:e2e`. Expected: all pass.
- [ ] **Step 4: Commit.** `git commit -m "Document comparison data files and checks"`
