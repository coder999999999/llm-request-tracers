# Comparison Benchmark and Write-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure llama.cpp and vLLM on the RTX 4090 with a reproducible, engine-neutral harness. Turn the results into `data/bench/*.js`, then write the page's verdict and answers from them.

**Architecture:** Everything runs in Docker (WSL2 backend), one server on the GPU at a time.
- `bench/docker-compose.yml` defines four services:
  - `llama`: llama.cpp built from the pinned commit
  - `llama-tools`: the converter image
  - `vllm`: the CI image at the pinned commit
  - `client`: Python 3.12 with the load generator
- `run_all.py` (inside `client`) drives the servers through the Docker socket, runs closed-loop load levels, scrapes metrics, and writes raw JSONL plus per-run summaries.
- `to-site.mjs` aggregates summaries into the page's data format.

**Tech Stack:** Docker Compose, Python 3.12 (`httpx`, `pytest`, `docker` SDK), Node 24 for `to-site.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-06-engine-comparison-design.md` (§5 Benchmark, §6 accuracy, §8 phases).

**Companion plan:** `docs/superpowers/plans/2026-10-06-compare-page.md`. Its Task 5 defines the bench data shape this plan produces. Task 8 here needs that plan finished.

## Global Constraints

- Branch `compare`. No push to `main` until Task 8 is reviewed.
- GPU: RTX 4090 24 GB. Only one inference server runs at a time. The client stops the other before starting a run.
- llama.cpp:
  - commit `2ca15f5404760548c39e7b92bd43116a09414a1a`
  - Docker build context `https://github.com/ggml-org/llama.cpp.git#2ca15f5404760548c39e7b92bd43116a09414a1a`
  - dockerfile `.devops/cuda.Dockerfile`, targets `server` and `full`
  - build arg `CUDA_DOCKER_ARCH=89`
- vLLM image: `public.ecr.aws/q9t5s3a7/vllm-ci-postmerge-repo:138810056093301f4881050fcf2b1786939da387`.
- Model: `meta-llama/Llama-3.1-8B-Instruct`.
  - vLLM uses BF16 safetensors from `bench/models/hf/Llama-3.1-8B-Instruct`.
  - llama.cpp uses `bench/models/Llama-3.1-8B-Instruct-F16.gguf`, converted from the same files with `--outtype f16`.
  - Served name on both: `llama-3.1-8b`.
- `HF_TOKEN` comes only from `bench/.env`, which is git-ignored. `bench/.env.example` holds `HF_TOKEN=`. `bench/models/` is git-ignored.
- Server configs (exact flags):
  - **main**
    - llama.cpp: `-m /models/Llama-3.1-8B-Instruct-F16.gguf -ngl 999 -c 32768 -np 64 --alias llama-3.1-8b --metrics --host 0.0.0.0 --port 8080`
    - vLLM: `--model /models/hf/Llama-3.1-8B-Instruct --served-model-name llama-3.1-8b --dtype bfloat16 --num-gpu-blocks-override 2048 --max-model-len 512 --port 8000`
  - **reuse**: same as main, except llama.cpp `-np 8` (4,096 tokens per slot) and vLLM `--max-model-len 4096`
  - **kvfull**: same as main, except llama.cpp adds `--kv-unified` and vLLM `--max-model-len 2048`
- Workload:
  - prompts of 170–190 tokens after the chat template
  - `max_tokens 256`, `ignore_eos: true`, `temperature 0`, `stream: true`, `stream_options: {"include_usage": true}`
- Load:
  - closed loop
  - users 1, 2, 4, 8, 16, 32, 64
  - per level: 30 s warm-up, 60 s measured
  - 3 repeats, engine order alternating per repeat
- TTFT is measured to the first SSE chunk whose `choices[0].delta.content` is non-empty. A role-only first chunk doesn't count.
- A level with more than 1% failed requests is marked `valid: false` and left off the page.
- Never commit personal details. `env.json` must not contain host usernames or paths under `C:/Users`.

## Review Focus

1. **Role-only or empty first chunk** (`delta: {role: "assistant"}`). It must not stop the TTFT clock. Test in Task 3.
2. **A request still in flight when the measure window closes.** It's cancelled and left out of both latency and tokens/s. A request started during warm-up but finishing inside the window is also left out. Test in Task 3.
3. **Server not ready, or one returns HTTP 503 or drops the stream partway.** The request is recorded `ok: false` with the error, the run continues, and the level is invalid above 1%. Test in Task 3.
4. **A Prometheus counter resetting between scrapes** (server restarted). The delta is negative, so the result is `None` and flagged, never a negative mean. Test in Task 4.
5. **A level that exists for one engine but is invalid or missing for the other.** `to-site.mjs` keeps it for the engine that has it. The page plan already skips annotations and charts that lack a point. Test in Task 6.

---

### Task 1: Servers and model

**Files:**
- Create: `bench/docker-compose.yml`, `bench/client.Dockerfile`, `bench/.env.example`, `bench/prepare_model.sh`, `bench/README.md`
- Modify: `.gitignore` (add `bench/models/`, `bench/.env`)

**Interfaces:**
- Produces:
  - services `llama` (port 8080), `vllm` (port 8000), `llama-tools`, `client`
  - env vars `LLAMA_ARGS` and `VLLM_ARGS` are appended to each server's command, so `run_all.py` can switch configs
  - `client` mounts `/var/run/docker.sock`, `bench/` at `/bench`, and the repo `data/` at `/data`

- [ ] **Step 1: Write the compose file.**
  - `llama`: build from the pinned git context, target `server`, `gpus: all`, models volume at `/models`, `command` = main config plus `${LLAMA_ARGS}`.
  - `vllm`: the pinned image, `gpus: all`, `ipc: host`, models volume at `/models`, `command` = main config plus `${VLLM_ARGS}`.
  - `llama-tools`: same context, target `full`.
  - `client`: build `client.Dockerfile` (`python:3.12-slim`, `pip install httpx==0.27.* pytest docker huggingface_hub`).
  - Every service except `client` sits under `profiles` so nothing starts by default.
- [ ] **Step 2: Write `prepare_model.sh`.**
  - Download with `huggingface-cli download meta-llama/Llama-3.1-8B-Instruct --local-dir /models/hf/Llama-3.1-8B-Instruct` in `client`, with `HF_TOKEN` from `.env`.
  - Convert with `llama-tools` `--convert --outtype f16 --outfile /models/Llama-3.1-8B-Instruct-F16.gguf /models/hf/Llama-3.1-8B-Instruct`.
  - Skip each step if its output already exists.
- [ ] **Step 3: Build and prepare.** Run: `docker compose -f bench/docker-compose.yml build && bash bench/prepare_model.sh`. Expected: both model artefacts exist. The GGUF is about 16 GB.
- [ ] **Step 4: Smoke test each server alone.**
  - Start each with `docker compose --profile llama up -d llama` (and `vllm`) and wait for `GET /health` to return 200.
  - Send one streaming chat request with curl. Expected: SSE chunks with text and a final `usage`.
  - Stop the server.
- [ ] **Step 5: Write the `bench/README.md` skeleton.** Sections: Prerequisites (licence accepted, `.env`), Prepare, Run, Outputs. Fill the exact commands as later tasks add them.
- [ ] **Step 6: Commit.** `git commit -m "Add benchmark servers and model preparation"`

### Task 2: Prompt set

**Files:**
- Create: `bench/make_prompts.py`, `bench/prompts/main.jsonl`, `bench/prompts/reuse.json`, `bench/tests/test_prompts.py`

**Interfaces:**
- Produces:
  - `main.jsonl`: 512 lines of `{"id": int, "messages": [{"role":"user","content": str}]}`
  - `reuse.json`: `{"system": str, "turns": [str × 20]}`. `system` is 1,450–1,550 tokens after the template.
  - `templated_len(base_url, messages) -> int`: llama.cpp `POST /apply-template`, then `POST /tokenize`, then the length.

- [ ] **Step 1: Write the failing test.** `test_main_prompts_are_unique_and_seeded`:
  - Generating twice with `--seed 7` gives byte-identical files.
  - All 512 contents are distinct.
- [ ] **Step 2: Implement `make_prompts.py`.**
  - Build sentences from a fixed in-file vocabulary with `random.Random(seed)`.
  - With `--server`, add or remove words until `templated_len` is within range.
- [ ] **Step 3: Generate.** Run `pytest bench/tests/test_prompts.py`, then generate against a running `llama` server. Expected: PASS. The script prints min and max lengths inside 170–190 and 1,450–1,550.
- [ ] **Step 4: Commit.** `git commit -m "Add seeded benchmark prompt sets"`

### Task 3: Load generator

**Files:**
- Create: `bench/loadgen.py`, `bench/tests/test_loadgen.py`

**Interfaces:**
- Produces:
  - `parse_sse(lines: Iterable[str]) -> Iterator[dict]`
  - `async one_request(client, base_url, model, messages, max_tokens, t0) -> Record`
  - `Record` is a dataclass with: `user:int`, `start_s`, `ttft_ms|None`, `itl_ms:list[float]`, `e2e_ms|None`, `out_tokens|None`, `tokens_source:'usage'|'timings'|'chunks'`, `prompt_ms|None` (llama.cpp `timings.prompt_ms`), `cache_n|None`, `ok:bool`, `error|None`
  - `async run_level(base_url, model, prompts, users, warmup_s=30, measure_s=60, max_tokens=256) -> list[Record]`: closed loop; returns only records inside the window
  - `summarize(records, measure_s) -> dict` with keys `n_ok`, `n_err`, `err_rate`, `valid`, `ttft_ms`, `itl_ms`, `e2e_ms`, `prompt_ms` (each `{median,p90}` or None), and `tok_s`

- [ ] **Step 1: Write the failing tests.** They run against a fake ASGI SSE server (`httpx.MockTransport`).

```python
def test_ttft_ignores_role_only_first_chunk():      # chunks: role-only @10ms, "Hi" @50ms → ttft_ms ≈ 50
def test_tokens_prefer_usage_then_timings_then_chunks():
def test_records_outside_window_are_dropped():       # started in warm-up, or still running at window end
def test_http_503_and_broken_stream_are_errors():    # ok False, error set, run continues
def test_level_invalid_above_one_percent_errors():   # 2 errors / 100 → valid False
def test_tok_s_counts_only_ok_records_in_window():
```

- [ ] **Step 2: Run to see them fail.** Run: `docker compose -f bench/docker-compose.yml run --rm client pytest /bench/tests/test_loadgen.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement `loadgen.py`.**
  - One `httpx.AsyncClient` with `timeout=None` and `limits=max_connections=users`.
  - Each user loops over prompts starting at offset `user * 7`, so users don't send identical prompts at the same moment.
  - Use `time.perf_counter()` throughout. At window end, cancel outstanding tasks.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add engine-neutral streaming load generator"`

### Task 4: Server metrics

**Files:**
- Create: `bench/metrics.py`, `bench/tests/test_metrics.py`, `bench/tests/fixtures/vllm_metrics_before.txt`, `bench/tests/fixtures/vllm_metrics_after.txt`

**Interfaces:**
- Produces:
  - `parse_prom(text) -> dict[str, float]`: key is `name{sorted labels}`
  - `hist_mean_ms(before, after, name) -> float|None`: `Δ_sum / Δ_count × 1000`. None if `Δ_count <= 0`.
  - `counter_delta(before, after, name) -> float|None`
  - `vllm_stage_means(before, after) -> {queue_ms, prefill_ms, decode_ms, ttft_ms, preemptions}`, using:
    - `vllm:request_queue_time_seconds`
    - `vllm:request_prefill_time_seconds`
    - `vllm:request_decode_time_seconds`
    - `vllm:time_to_first_token_seconds`
    - `vllm:num_preemptions`
  - `count_kv_retries(log_text) -> int`: counts lines containing `failed to find free space in the KV cache, retrying with smaller batch size` (llama.cpp `server-context.cpp:3930`)

- [ ] **Step 1: Write the failing tests.**
  - The histogram mean from fixtures equals a hand-computed value.
  - A counter reset (after < before) gives `None`.
  - `count_kv_retries` counts 2 in a 5-line log sample.
- [ ] **Step 2: Run to see them fail, implement `metrics.py`, run again.** Expected: PASS.
- [ ] **Step 3: Verify the metric names against a live server.** Start `vllm`, `curl :8000/metrics | grep -E "request_queue_time|request_prefill_time|num_preemptions"`. Expected: all present. If a name differs at this commit, update the constants and fixtures.
- [ ] **Step 4: Commit.** `git commit -m "Add Prometheus and log metric readers"`

### Task 5: Run orchestration

**Files:**
- Create: `bench/run_all.py`, `bench/tests/test_run_all.py`

**Interfaces:**
- Consumes: `run_level`, `summarize`, `vllm_stage_means`, `count_kv_retries`.
- Produces: `bench/results/<YYYY-MM-DD>/` containing:
  - `env.json`: GPU name, driver, CUDA, clocks (from `nvidia-smi` in a CUDA container), image IDs and digests, exact server args per config, both commits, harness git commit
  - `<engine>/<config>/u<users>-r<repeat>.jsonl`: one Record per line
  - `<engine>/<config>/u<users>-r<repeat>.summary.json`: `summarize()` output plus `server`. For vLLM, `server` is the `vllm_stage_means`; for llama.cpp it is `{prompt_ms_median, kv_retries}`.
  - `reuse/<engine>.json`: cold TTFT, warm TTFT median, `cache_n` per turn (llama.cpp)
- CLI: `python run_all.py --configs main,reuse,kvfull --repeats 3 [--engines llama,vllm] [--levels 1,2,...]`

- [ ] **Step 1: Write the failing tests.**
  - `test_engine_order_alternates_per_repeat`: `plan_runs(repeats=3)` gives llama/vllm, vllm/llama, llama/vllm.
  - `test_kvfull_steps_max_tokens`: the kvfull plan uses users 64 and max_tokens 256, 512, 1024.
  - `test_env_json_has_no_user_paths`: the serialized `env.json` doesn't match `C:/Users|/home/|/Users/`.
- [ ] **Step 2: Implement.**
  - `plan_runs(...) -> list[Run]` is pure.
  - `execute(run)` uses the `docker` SDK through compose project labels:
    1. stop both servers
    2. start one with the config's `LLAMA_ARGS` / `VLLM_ARGS`
    3. poll `/health` up to 900 s
    4. scrape metrics, then `run_level`, then scrape again
    5. collect logs for llama.cpp
    6. write files
  - The reuse run is one user, `reuse.json`, sequential, on a freshly started server so turn 1 is cold.
- [ ] **Step 3: Run the tests.** Expected: PASS.
- [ ] **Step 4: Dry run.** `python run_all.py --configs main --repeats 1 --levels 1,8 --engines llama,vllm` with `--measure 20 --warmup 10`. Expected: four `.summary.json` files, all `valid: true`, non-null `ttft_ms`, and `server` populated.
- [ ] **Step 5: Commit.** `git commit -m "Add benchmark run orchestration"`

### Task 6: Results to site data

**Files:**
- Create: `bench/to-site.mjs`, `tests/to-site.test.mjs`, `tests/fixtures/results/` (small synthetic tree)

**Interfaces:**
- Consumes: a results tree from Task 5.
- Produces: `data/bench/llama-cpp.js` and `data/bench/vllm.js`, each `RT.registerBench({ id: 'llama-cpp' | 'vllm', run, levels, reuse, kvFull })` (`registerBench` rejects an object without `id`), shaped exactly as page plan Task 5:
  - `id`: the engine id, `'llama-cpp'` in `data/bench/llama-cpp.js` and `'vllm'` in `data/bench/vllm.js`
  - `run: {date, gpu, model, commit, config}`
  - `levels: [{users, ttft_ms:{median,min,max}, tok_s:{median,min,max}, itl_ms:{median,min,max}, e2e_ms:{median,min,max}, prefill_ms?:{median,min,max}, queue_ms?:{median,min,max}}]`
    - median across repeats of each repeat's median; min and max across repeats
    - `prefill_ms` comes from vLLM `server.prefill_ms` or llama.cpp `prompt_ms_median`
    - `queue_ms` is vLLM only
  - `reuse: {cold_ttft_ms, warm_ttft_ms}`
  - `kvFull: [{max_tokens, tok_s, ttft_ms, preemptions?, kv_retries?, failed}]`
- CLI: `node bench/to-site.mjs bench/results/<date>`

- [ ] **Step 1: Write the failing tests.**
  - The fixture tree gives the expected `levels[0]` medians.
  - A level with `valid: false` for one engine is absent from that engine's file and present in the other's.
  - The output files run in `loadSiteData` with `RT.errors` empty, and `RT.bench['llama-cpp']` and `RT.bench.vllm` both exist.
- [ ] **Step 2: Implement, then run** `npm test`. Expected: PASS.
- [ ] **Step 3: Commit.** `git commit -m "Add results-to-site data generator"`

### Task 7: Run the benchmark

**Files:**
- Create: `bench/results/<date>/…` (generated), `data/bench/llama-cpp.js`, `data/bench/vllm.js` (generated)

- [ ] **Step 1: Prepare the machine.**
  - Close GPU-heavy apps. Plug in, with the power plan on High performance.
  - Record `nvidia-smi` idle state in the run log.
- [ ] **Step 2: Run the full matrix.** Run: `docker compose -f bench/docker-compose.yml run --rm client python /bench/run_all.py --configs main,reuse,kvfull --repeats 3`. Expected: about 2 hours. Every main-config summary is `valid: true`; investigate and rerun any level that isn't.
- [ ] **Step 3: Sanity checks.**
  - At 1 user, vLLM `ttft_ms` should be within a factor of 2 of its own `vllm:time_to_first_token_seconds` mean.
  - llama.cpp `prompt_ms` should be under its client TTFT on every record.
  - Throughput should never fall by more than 10% from one level to the next without a matching error or preemption count.

  Write any anomalies into `bench/results/<date>/NOTES.md`.
- [ ] **Step 4: Generate site data.** Run: `node bench/to-site.mjs bench/results/<date> && npm test && npm run test:e2e`. Expected: PASS, and charts render with real lines.
- [ ] **Step 5: Check the size.** Run: `du -sh bench/results/<date>`. If it's over 20 MB, gzip the `.jsonl` files (`.jsonl.gz`); `to-site.mjs` only reads summaries.
- [ ] **Step 6: Commit.** `git commit -m "Add RTX 4090 benchmark results for llama.cpp and vLLM"`

### Task 8: Write-up from the results (phase 3)

**Files:**
- Modify: `data/pairs/llama-cpp--vllm.js`, `data/compare.js` (question wording only)

- [ ] **Step 1: Decide each question's fate from the data.**
  - Q1 stays if throughput diverges as concurrency rises.
  - Q4 stays only if the kvfull runs show a measurable difference: preemptions or retries or failures, plus a TTFT or throughput effect. Otherwise, replace it with a question the data does answer, and record why in `NOTES.md` (spec §5.3).
  - Reword questions so they match what was measured.
- [ ] **Step 2: Write the pair file content.**
  - `verdict.a` / `verdict.b`: three bullets each.
  - `answers.q1` and `answers.q4`: two or three sentences each, revisiting q2 and q3 if the data changes them.
  - `annotations`: one or two per chart, using `RTU.annotate` specs, for example `{x:64, metric:'tok_s', kind:'ratio', text:'{v}× at 64 users'}`. The reuse chart takes `{source:'reuse', metric:'warm_ttft_ms', ...}` and the KV chart `{source:'kvFull', x:1024, metric:'tok_s', ...}` (spec §4).

  Every sentence names something visible in a chart or a code list on the page. Follow spec §7.1 copy rules: no first person, plain and specific.
- [ ] **Step 3: Cross-check claims.** For each verdict bullet and answer, list the chart point or source line that backs it in `bench/results/<date>/NOTES.md` under "Claims". Delete any claim without a backing line.
- [ ] **Step 4: Full verification.**
  - Run: `npm test && npm run check && npm run test:e2e`. Expected: PASS.
  - Rerun check (spec §9): clone the `compare` branch into a scratch folder, follow `bench/README.md` word for word for one level (`--configs main --levels 8 --repeats 1`), and confirm `tok_s` is within 10% of the committed median. Fix the README if any step was missing.
  - Take screenshots at 1440 and 390 for review.
- [ ] **Step 5: Commit.** `git commit -m "Write comparison verdict and answers from benchmark results"`
- [ ] **Step 6: Hand off for review.** Push the `compare` branch only (`git push -u origin compare`), with the user's go-ahead. Do not merge to `main`; the user reviews first.
