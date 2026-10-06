# Engine comparison site: design

Date: 2026-10-06. Status: draft for review.

## 1. Goal

Turn the start page into a comparison of two inference servers, **llama.cpp vs vLLM**, covering features, code paths and measured performance. It follows the same single streaming chat request the tracers and films already use.

- **For:** developers choosing a server to run or self-host. It is also a portfolio piece.
- **Success:**
  - A reader can answer "which one, and why" from the first screen.
  - Every claim on the page is one click from its evidence: a source line at a pinned commit, or a benchmark result with the script that produced it.
  - Adding a third engine later (Ollama is the likely first) means adding data files and its own tracer page, with no layout change.

**Not in scope:**
- A third engine now.
- Multi-GPU and speculative decoding.
- Quantized-model benchmarks. A possible later track: GGUF Q4 vs AWQ.
- Changing the existing tracer pages, apart from links.
- Making new films. Episode 5, "Two Engines", will later embed here.

## 2. Decisions already made

| Decision | Choice |
|---|---|
| Engines | llama.cpp vs vLLM, built so more engines can be added as data |
| Structure | Approach A: one comparison page organised around the four stages, Arrive / Wait / Think / Speak, with headline questions on top |
| Layout | Mockup V3's structure: each headline question is a chapter, and a two-track diagram is pinned beside it |
| Look | Mockup V3's look, polished as mockup **v4**: off-white page, bold condensed uppercase headlines, ruled lists for code, and the design rules in §7.1. This departs from the films' cream-paper style on purpose; the Episode 1 poster still appears as an image |
| From V2 | Only the stage-time row ("time per stage + gap"), shown once per chapter under the chart |
| Performance | Measured by us on the RTX 4090, with the script and raw results committed |

The reference mockups live outside the repo, in `../mockups/` (`v1-paper`, `v2-workbench`, `v3-editorial`, `v4-polished`; **v4 is the visual reference**). Their performance numbers are placeholders.

## 3. Page structure (`index.html`)

From top to bottom:

1. **Top bar.** The "One Request, Traced" wordmark on the left, section links on the right (Comparison, Tracers, Films, Method). The compare picker appears in the bar only once a third engine is registered; until then the engine names in the H1 do that job. The plan to add engines is mentioned in one line in the Method section.
2. **Hero** (static HTML, works without JS).
   - H1 "llama.cpp or vLLM?" with each name in its engine colour.
   - One sentence of setup: same request, same prompt, same RTX 4090.
   - A link: "Watch Episode 1 (1:44)" opens the existing modal player.
   - Right column: the verdict, "Reach for llama.cpp if…" and "Reach for vLLM if…", three bullets each. **The verdict text is written after the benchmark (phase 3).** It comes from the pair file (see §4), never hard-coded in the renderer.
3. **Question list** (static HTML). Four numbered questions, each linking to its chapter:
   1. Why does vLLM pull ahead once many people are chatting? (Wait)
   2. Who reuses your prompt better? (Think)
   3. Where does your request cross a thread or process boundary? (Arrive and Speak)
   4. What happens when the KV cache runs out of room? (Think)

   The wording of questions 1 and 4 is provisional until the benchmark confirms the behaviour they describe.
4. **Chapters**, one per question. Two-column grid: main column, plus a 340px sticky track column at ≥1100px. Main column, top to bottom:
   - a small counter, "1 of 4", in plain sans
   - the question as an H2
   - the answer: 2–3 sentences from the pair file
   - **evidence chart**, chosen per question:
     - Q1: throughput vs concurrent users
     - Q2: TTFT for a repeated prompt (cold vs warm)
     - Q3: no chart; a boundary diagram instead
     - Q4: preemptions or failed requests vs concurrency at a fixed KV budget
   - **stage-time row** (the part taken from V2): for the chapter's stage, each engine's time and the gap between them, at 1 user and at 32 users. Built only from server-reported numbers (see §5.5).
   - **code paths**: two ruled lists side by side, each headed by its engine name in its colour. Each lists that engine's steps for the stage: title, function, file:line linked to the pinned commit, and, where the request crosses a boundary, a short dashed rule with a plain sentence such as "Crosses into the EngineCore process over ZMQ".
   - **feature rows** for the stage: label, engine A value, engine B value, each with a source link
   - links: "Open the llama.cpp tracer" and "Open the vLLM tracer", plus "Next question"

   **Pinned track** (side column): two vertical lanes, one per engine colour. They are split into the four stages, with step counts and hop markers, and the current chapter's stage is highlighted using IntersectionObserver. Clicking a stage scrolls to its row in "Every stage". Below 1100px the track becomes a horizontal four-stage strip at the top of each chapter, not sticky.
5. **Every stage.** A compact reference table, four rows (one per stage). Each row: a one-line summary per engine, step count, time per stage, and an expander showing that stage's code-path lists and feature rows. This guarantees full coverage, including Speak, which no question owns.
6. **Deep dives.** The three tracer cards as they are on today's start page: close-up image, one line, link.
7. **The films.** Today's series row: Episode 1 playable, Episodes 2–5 listed, the Decision models line.
8. **How this was measured.** Hardware, versions, model, method summary, links to `bench/README.md` and raw results.
9. **Footer.** Pinned commits, the not-affiliated line, credits.

No first person anywhere. All performance numbers and verdict text come from data files, never typed into the HTML.

## 4. Data model

Everything is plain `<script>` files, so the site works from `file://` with no build step. Each file registers itself on a global:

```
data/
  compare.js                    stages, questions, feature catalogue
  engines/llama-cpp.js          registerEngine({...})
  engines/vllm.js
  pairs/llama-cpp--vllm.js      registerPair({...})   prose for this pair
  bench/llama-cpp.js            registerBench({...})  generated from bench/results
  bench/vllm.js
```

**`compare.js`**
- `stages`: id, number, name, subtitle.
- `questions`: id, text, stage ids, chart type.
- `features`: the catalogue, `{ key, stage, label }`, so rows line up across engines. Initial keys:
  - `api_openai`
  - `chat_template_source`
  - `tokenize_where`
  - `batching`
  - `prefix_reuse`
  - `kv_layout`
  - `kv_full`
  - `cuda_graphs`
  - `detokenize_where`
  - `model_formats`
  - `hardware`
  - `structured_output`
  - `tool_calling`

**Engine file**
```js
registerEngine({
  id: "vllm", name: "vLLM", lang: "Python", color: "#3f63d8",
  repo: "https://github.com/vllm-project/vllm", commit: "138810056093301f4881050fcf2b1786939da387",
  tracer: "vllm.html",
  shape: "Two processes. An API process and an EngineCore that owns the GPU, talking over ZMQ.",
  steps: {                         // keyed by stage id, in order
    wait: [{ title: "Add to scheduler", fn: "EngineCore.add_request",
             file: "vllm/v1/engine/core.py", line: 526, hop: "process", hopLabel: "ZMQ" }, ...],
    ...
  },
  features: { batching: { value: "Token budget per step (max_num_batched_tokens)",
                          file: "...", line: 0 }, ... },
});
```
- `file` is the full repo-relative path. The display shortens it to the basename.
- `hop` goes on the first step that runs on the other side of the boundary.
- A feature key missing from an engine renders as "Not covered yet", never as a guess.

**Pair file**
- `ids: ["llama-cpp", "vllm"]`
- `verdict: { a: [...], b: [...] }`
- `answers: { q1: "...", ... }`
- `stageSummaries`: one line per engine per stage, for "Every stage".

If no pair file exists for the chosen engines, the page still renders code paths, features and charts, and shows "No write-up for this pair yet" where the answers would go.

**Pair selection.** The pair is read from `?a=&b=` URL parameters, defaulting to the first registered pair. With two engines this has no visible effect.

**Bench files** are generated by `bench/to-site.mjs` from the raw results, never edited by hand.

Initial content: steps come from the existing tracers' hot paths (exported once), grouped into stages the same way as the film:
- Arrive: HTTP, template, tokenize.
- Wait: queue to slot or schedule.
- Think: prefix reuse, KV, forward pass, sample.
- Speak: hand-back, detokenize, SSE.

## 5. Benchmark

### 5.1 Setup
- **Hardware:** RTX 4090 24 GB, Windows 11 host. Both servers run in Docker (WSL2 backend) with GPU access, so they share the same OS layer.
- **Versions:** each engine is built from its pinned tracer commit, so the code shown matches the code timed: llama.cpp `2ca15f5` CUDA server build, vLLM `1388100`. If building vLLM at that commit is impractical, use the nearest release image that contains it and record both.
- **Model:** Llama 3.1 8B Instruct, 16-bit on both: BF16 safetensors for vLLM, F16 GGUF converted from the same weights for llama.cpp. *Prerequisite:* you accept the Meta licence on Hugging Face and provide an `HF_TOKEN` in a local `.env`, which is git-ignored and never committed.

### 5.2 Fairness rules
- **Same KV budget, 32,768 tokens.**
  - llama.cpp: `-c 32768 -np 64`, which gives 512 tokens per slot. `--kv-unified` is left at its default; the default is recorded.
  - vLLM: `--num-gpu-blocks-override 2048` (16-token blocks), `--max-model-len 512`.
- **Same workload.** prompts of ~180 tokens *after* the chat template, from a fixed seeded set, `max_tokens 256`, `ignore_eos: true` (both servers accept it), temperature 0, streaming on.
- KV cache precision is 16-bit on both: llama.cpp defaults to F16, vLLM `auto` follows the model's BF16.
- Prefix caching stays at each engine's default for Q1. Q2 measures it on purpose.
- All server flags are recorded in the results.

### 5.3 Runs
- **Load model:** closed loop. N virtual users each send their next request when the previous one finishes.
- **Concurrency levels:** N = 1, 2, 4, 8, 16, 32, 64.
- **Per level:** 30 s warm-up, then 60 s measured, repeated 3 times. Reported value is the median, with min and max kept.
- **Q2 (prompt reuse):** the same 1,500-token system prompt plus different user turns, run cold then warm, recording TTFT and llama.cpp `cache_n`. This needs `-c` and `--max-model-len` raised for that run only, recorded separately.
- **Q4 (KV full):** same 32,768-token budget, 64 users, with `max_tokens` stepped up (256 → 512 → 1,024) until total demand exceeds the budget.
  - llama.cpp runs with `--kv-unified`, so both engines share one pool instead of llama.cpp's fixed per-slot split.
  - Record vLLM `vllm:request_num_preemptions`, llama.cpp decode retries (from its logs) and failed requests, plus TTFT and throughput.
  - If llama.cpp's behaviour at the pinned commit can't be measured this way, Q4 is replaced in phase 3, not shown with weaker evidence.

### 5.4 Metrics
- **Client side, both engines:** TTFT, inter-token latency, end-to-end latency, aggregate output tokens/s.
- **Load generator:** `bench/loadgen.py`, our own small asyncio/httpx client using the OpenAI chat API. It is engine-neutral, so neither project's own benchmark tool is used against the other.

### 5.5 Stage-time row: what the servers actually report
Checked at the pinned commits:
- **llama.cpp** returns per-request `timings`, including `prompt_ms`, `predicted_ms` and `cache_n` (`tools/server/server-common.cpp:86–94`). It reports no queue time.
- **vLLM** exposes Prometheus histograms (`vllm/v1/metrics/loggers.py`):
  - `vllm:request_queue_time_seconds` (911)
  - `vllm:request_prefill_time_seconds` (931)
  - `vllm:request_decode_time_seconds` (941)
  - `vllm:time_to_first_token_seconds` (871)

  Per-run means come from differences in `_sum` and `_count`.

So the row shows TTFT split three ways:
- **Think (prefill):** server-reported on both.
- **Wait (queue):** server-reported on vLLM. On llama.cpp it is shown as "queue + overhead" = TTFT − `prompt_ms`.
- **Arrive + Speak (everything else):** vLLM TTFT − queue − prefill. On llama.cpp it is folded into the "queue + overhead" bar above.

Labels say exactly which parts are reported and which are derived. No made-up split.

### 5.6 Output
`bench/` contains:
- `README.md`: how to rerun.
- `docker-compose.yml`: both servers, pinned builds.
- `loadgen.py`
- `scrape_metrics.py`
- `results/<run-date>/`: raw JSONL per request, and `env.json` with driver, CUDA, image digests, flags and GPU clocks.
- `to-site.mjs`: writes `data/bench/*.js`.

## 6. Accuracy checks

- **`tools/check-sources.mjs`** (Node, no dependencies). It fetches each referenced file at the pinned commit from raw.githubusercontent.com, and checks that the cited line, ±3 lines, contains the step's function token. It covers every `steps` and `features` entry and fails loudly on any miss. Run it before every commit that touches `data/engines/`.
- Numbers on the page are only ever read from `data/bench/*.js`.
- Verdict, answers and takeaways (phase 3) must each match a chart on the page. Any claim the data doesn't support gets cut.

## 7. Visual and interaction notes

- **Tokens** (from mockup v4):
  - colours: page `#f7f6f2`, ink `#121212`, secondary ink `#4b4b48` and `#86847d`, rules `#e2dfd6`
  - engine colours come from engine files: llama.cpp `#d9662a`, vLLM `#2b54d0`
  - fonts: Archivo Narrow 700 for the H1 and chapter H2s only (uppercase), Archivo for everything else, IBM Plex Mono only for function names and file:line
  - spacing uses only 4, 8, 12, 16, 24, 32, 48, 64 and 96 px
  - a 2px ink rule tops each major block (top bar, hero question list, each chapter, the feature table)

### 7.1 Design rules: what to avoid, and polish

The page must not read as generated. **Do not use:**
- tiny uppercase letter-spaced labels ("eyebrows", kickers such as `QUESTION 01 · STAGE 02`)
- middle-dot (`·`) metadata strings
- monospace for anything that isn't code or a file reference
- "PLACEHOLDER"-style stamps, badges or pills; dashed "coming soon" chips
- boxed cards with a title label, such as "WHERE WE ARE"
- legend boxes on charts
- decorative arrows in running text (→, ↓)
- generic copy flourishes ("from the source and the stopwatch")
- more than one accent colour per engine

**Polish rules:**
- One type scale. Each element gets one style; no one-off sizes.
- Numbers use tabular figures and line up right-aligned in columns.
- Every chart labels its lines directly at their ends, uses at most four gridlines, and carries one or two annotations that state the finding ("5.5× at 64 users"). Annotation text comes from the pair file, and its numbers are read from bench data.
- Hover and focus states on every link and question. Visible focus rings.
- Line length stays at or under 32em for prose.
- Copy is plain and specific: say what was measured or what the code does.
- The deep-dive cards and film row are restyled to match; the tracer pages themselves stay dark.
- **Charts:** inline SVG drawn by a small local function, no chart library. Lines are 4px and labelled directly at their ends in the engine colour (no legend box). Hovering or focusing a point shows its value plus the min–max from the 3 repeats.
- **Responsive:** 16px gutter on phones. Code panels stack. Charts keep their aspect ratio and the axis labels thin out. No sideways page scroll.
- **Motion:** only the track highlight and smooth scrolling, both off under `prefers-reduced-motion`.
- **Accessibility:**
  - Engine colour is never the only cue; names are always printed.
  - Charts carry an `aria-label` summary and a visually hidden data table.
- Nothing measured is shown until real data exists. Before that, chart areas show "Benchmark running, results soon" and no fake curves.

## 8. Phases

1. **Page and data.** Engine and pair files, renderer, all sections, `check-sources.mjs`. Performance areas show the empty state.
2. **Benchmark.** `bench/` harness and runs on the 4090, then `to-site.mjs` generates the bench data.
3. **Write-up.** Verdict, answers and takeaways written from the results, the question wording finalised, then publish.

Phases 1 and 2 can run in parallel. Nothing is pushed to `main` (and so to GitHub Pages) until phase 3 is reviewed, because the live site would otherwise show empty performance sections. Work happens on a `compare` branch.

## 9. Testing

- `check-sources.mjs` passes.
- Headless renders at 1440, 1024 and 390 px: no horizontal overflow, no console errors, and the pinned track highlights the right stage while scrolling.
- Opening `index.html` from `file://` renders the same as over HTTP.
- A fake third engine file, used only in a test and never committed, appears in the picker, and the page still renders with "Not covered yet" and "No write-up for this pair yet".
- The benchmark is rerun once end to end from `bench/README.md` on a clean checkout before publishing.

## 10. Open questions for review

1. Is waiting until phase 3 before going live, working on a `compare` branch, acceptable? The alternative is shipping phase 1 with empty performance sections.
2. Llama 3.1 8B needs the Meta licence accepted on Hugging Face. Is that OK, or should it be an ungated model? If the model changes, the tracers' "32 layers" example would no longer match the benchmark.
