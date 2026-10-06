# Benchmark notes, 2026-10-06

## Run

- Window: 15:55 to 18:06 local time on 2026-10-06 (invocation stamped 2026-10-06T19:55:07Z), about 2 h 11 min. One invocation, `--configs main,reuse,kvfull --repeats 3 --check-tokens`, exit code 0.
- Output: 60 per-run summaries, no `.failed.json` files. All 42 main-config levels (2 engines x 7 user counts x 3 repeats) are valid with zero failed requests.
- Harness commit f3d0d5f; llama.cpp commit 2ca15f5; vLLM CI image built from commit 1388100 (image digests in `env.json`).

## Hardware and software

- GPU: NVIDIA GeForce RTX 4090, 24,564 MiB, power limit 450 W, maximum clocks 3,135 MHz SM and 10,501 MHz memory. Driver 616.92, CUDA 13.4. Clocks logged in `env.json` (420 MHz SM, 405 MHz memory) were sampled at idle before the run; clocks under load were not recorded, so no statement about sustained boost clocks is made.
- Model: Llama 3.1 8B Instruct, served as `llama-3.1-8b`. llama.cpp serves an F16 GGUF, vLLM serves the BF16 safetensors converted from the same weights.
- Server flags per config are listed in `env.json` under `server_args`. Note that the recorded reuse and kvfull strings append the override flags to the main string (for example `-np 64 ... -np 8`); the later flag is the one in effect.
- Prompt token counts agree between engines on all 325 shared prompt ids (tolerance 1 token), see `prompt_tokens_check.json`.

## Sanity checks

1. vLLM client TTFT at 1 user against its own `time_to_first_token_seconds` mean: client medians 33.8, 34.4 and 33.9 ms against server means 31.3, 31.5 and 31.4 ms for repeats 0 to 2, a ratio of 1.08 to 1.09. Within the 2x limit.
2. llama.cpp `prompt_ms` below client TTFT: checked on all 2,174 OK records in the main and kvfull configs; zero violations, no record lacks `prompt_ms`.
3. Throughput between consecutive main levels: tok/s rises at every step for both engines, so no drop above 10% occurs. Medians over three repeats, llama.cpp 50.4, 97.0, 182.7, 327.3, 525.9, 724.3, 892.5 and vLLM 49.4, 97.4, 192.7, 379.5, 716.5, 1,272.5, 2,209.4 for 1, 2, 4, 8, 16, 32, 64 users. Main-config vLLM preemptions are 0 at every level and llama.cpp KV retries are 0.
4. Warm-up adequacy: median TTFT of the first 10 s of the measured window against the rest. At 1 user: llama.cpp 61.8 ms against 63.8 ms (ratio 0.97), vLLM 33.6 ms against 33.9 ms (ratio 0.99). Across all levels the ratio stays between 0.97 and 1.43. vLLM stays within 0.99 to 1.08. llama.cpp reaches 1.24 at 8 users, 1.22 at 16, 1.43 at 32 and 1.10 at 64; the early requests at those concurrencies queue slightly longer while all slots fill, which the 30 s warm-up does not fully remove for llama.cpp at 32 users. The effect is a few tens of ms on a TTFT of several hundred ms and does not change any ranking.

## KV-full findings (kvfull config, 64 users)

llama.cpp runs `--kv-unified` with a 32,768-token context shared by all slots; vLLM has 2,048 blocks of cache and `--max-model-len 2048`.

| max_tokens | llama.cpp | vLLM |
|---|---|---|
| 256 | valid, 402 / 484 / 421 tok/s (repeats 0 to 2), in-window TTFT medians of 2.9 to 7.4 s are not comparable (see below), only 7 to 18 requests in the window | valid, about 2,150 tok/s, TTFT about 500 ms, 0 preemptions |
| 512 | invalid: 128 of 128 requests failed with HTTP 500 "Context size has been exceeded", 100 / 125 / 111 KV-retry log lines | valid, about 2,070 tok/s, TTFT about 820 ms, 65 / 72 / 68 preemptions |
| 1024 | invalid: 128 of 128 failed, same error, 91 / 91 / 105 KV-retry lines | valid, 1,440 to 1,574 tok/s, TTFT 4.7 to 6.7 s, 255 / 278 / 264 preemptions |

This is genuine engine behaviour, not a harness fault and not rerun. With 64 concurrent sequences growing toward 512 or 1,024 generated tokens, the shared 32,768-token budget cannot hold them all; llama.cpp fails the requests once it runs out of room even after retrying, whereas vLLM preempts and recomputes sequences and keeps serving at lower throughput and higher TTFT. At 256 tokens llama.cpp survives but is far slower than its main-config run at the same 64 users (892 tok/s, TTFT 754 ms). The cause is not established. It coincides with the `--kv-unified` configuration, but decode speed is unchanged (inter-token latency about 55 to 60 ms, against 58.8 ms in main at 64 users) and no KV retries occurred at 256 tokens. The slowdown shows up in TTFT, which ranges from about 1.5 to 9.4 s across all records (for example 1,457 to 9,441 ms over 71 OK records in repeat 1). Requests proceed in lockstep cohorts of roughly 11, so the in-window sample is a single cohort per repeat (in repeat 1, 7 records from one burst starting near t = 38 s). The median TTFT for this level should not be compared directly with other levels; the 421 tok/s figure, counted by token arrival, is less affected. The six invalid levels are excluded from the site by `to-site.mjs`.

## Reuse (prefix caching) check

- llama.cpp: cold TTFT 202.4 ms, warm 28.7 ms. On the 57 warm turns across three repeats, `cache_n` has median 1,492 (range 1,491 to 1,492) against a system prompt of roughly 1,490 tokens and a median prompt of 1,517 tokens. Warm turns therefore hit the cache for the whole shared prefix; only the new turn text is evaluated.
- vLLM: cold TTFT 380.1 ms, warm 33.2 ms. The vLLM API does not report a per-request cached-token count, so `cache_n` is null; the 11x drop in TTFT is the evidence of prefix-cache hits.
- Both reuse levels are valid.

## Anomalies and caveats

- The closed loop with `ignore_eos` and fixed `max_tokens` makes users finish and resubmit in cohorts, so TTFT steps between levels partly reflect cohort prefill.
- llama.cpp `-np 64` at `-c 32768` gives each slot 512 tokens in the main config; prompts are 170 to 190 tokens plus 256 output tokens, so slots are sufficient and no KV retries occur.
- llama.cpp kvfull at 256 tokens completes very few requests in the 60 s window (7 to 18), so its medians rest on a small sample.
- Sustained GPU clocks and temperatures during load were not logged.

## Claims

Every sentence of benchmark-derived text on the comparison page, with the chart point or file that backs it. Text lives in `data/pairs/llama-cpp--vllm.js`; numbers are from `data/bench/*.js` (generated from the summaries in this folder). Ratios are vLLM divided by llama.cpp.

### Questions

- Q1 reworded from "Why does vLLM pull ahead once many people are chatting?" to "How far does vLLM pull ahead as more people chat?". Throughput diverges with concurrency (the gap grows from 1.0x at 1 user to 2.5x at 64), so the question stays. The measurements show the gap, not its cause, so the question no longer asks "why".
- Q2 and Q3 unchanged in wording. Q2 gained measured numbers.
- Q4 unchanged in wording. It stays because the kvfull runs show a measurable difference: 128 of 128 llama.cpp requests failed at 512 and 1,024 tokens, against 68 and 264 vLLM preemptions with no failures and a 1,506 to 2,072 tok/s throughput. The llama.cpp 256-token median TTFT is not cited anywhere (single cohort, see KV-full findings).

### Verdict, llama.cpp ("Reach for llama.cpp if")

| Bullet | Backing |
|---|---|
| Matched vLLM at 1 user, 50.4 against 49.4 tok/s | throughput chart, 1 user; `levels[0].tok_s.median` 50.4 and 49.37 |
| At most 1.2x behind up to 8 users | throughput chart: 2 users 97.05 / 97.40, 4 users 182.7 / 192.7, 8 users 327.3 / 379.5 (ratio 1.16) |
| First token after 202 ms against 380 ms with a ~1,490-token system prompt | prompt reuse chart, "First message" bars; `reuse.cold_ttft_ms` 202.4 and 380.1. System prompt size: reuse section above (about 1,490 tokens) |
| Model is a GGUF file, loader reads it | Model formats feature row, `src/llama-model-loader.cpp:570` |
| Hardware row lists build-time backends such as CUDA and Metal | Hardware feature row, `ggml/src/ggml-backend-reg.cpp:120` |
| Only CUDA on one RTX 4090 was measured | `env.json` gpu; Method section |

### Verdict, vLLM ("Reach for vLLM if")

| Bullet | Backing |
|---|---|
| 2,209 against 892 tok/s at 64 users, 2.5x | throughput chart, 64 users; medians 2,209.4 and 892.45, ratio 2.476 |
| Kept serving at 512 and 1,024 tokens, 2,072 and 1,506 tok/s, by preempting; every llama.cpp request failed | KV cache chart (vLLM tok_s 2,072.3 and 1,506.5) and its table (preemptions 68 and 264; llama.cpp failed requests 128 at both); KV-full findings above; KV-full feature row (preempts a request, recomputes later) |
| At 32 users the time before prefill was 115 ms against 420 ms | "Before prefill, at 32 users" row under the question 1 chart: TTFT minus prefill, 411.3 - 296.4 = 114.9 ms and 786.4 - 366.3 = 420.1 ms (derived as TTFT minus the prefill time each server reports: llama.cpp `prompt_ms`, the vLLM prefill histogram; the two prefill figures are not measured identically) |

Caveat on the KV-cache bullet: the kvfull config differs by engine (llama.cpp `--kv-unified` with a 32,768-token shared context; vLLM `--max-model-len 2048` with 2,048 blocks). Both have the same 32,768-token budget (see `env.json` `server_args.kvfull`).

### Answers

| Sentence | Backing |
|---|---|
| q1: 50.4 and 49.4 tok/s at 1 user | throughput chart, 1 user |
| q1: 2,209 against 892 tok/s at 64 users | throughput chart, 64 users |
| q1: 115 ms against 420 ms before prefill at 32 users | stage-time row, as above |
| q1: code paths differ (fixed slots against one shared token budget per step); the data does not isolate the cause | Batching feature row for both engines (`common/arg.cpp:2544`, `vllm/v1/core/sched/scheduler.py:591`) |
| q2: about 1,490-token system prompt; 202 to 29 ms (llama.cpp), 380 to 33 ms (vLLM); roughly 7 and 11 times | prompt reuse chart; `reuse` cold/warm 202.4 / 28.7 (ratio 7.05) and 380.1 / 33.2 (ratio 11.5); Reuse section above |
| q2: llama.cpp slot choice with similarity threshold, vLLM whole prefix blocks across requests | Prompt reuse feature row (`server-context.cpp:1657`, `kv_cache_manager.py:264`); unchanged from the earlier text |
| q2: on the cold first message llama.cpp was faster | prompt reuse chart, "First message" bars |
| q3: unchanged | code paths, hops and Detokenizing and Tokenizing feature rows |
| q4: 64 users, 32,768-token KV budget | `env.json` `server_args.kvfull`; Fairness rules in the spec (§5.2) |
| q4: at 256 tokens both engines finished every request | table: failed requests 0 on both. The llama.cpp 421 tok/s at 256 tokens is not cited on the page: no established cause for its gap to the main-config 892 (see KV-full findings) |
| q4: every llama.cpp request failed at 512 and 1,024 with a context size error, after 111 and 91 retries | table rows "Replies up to 512 / 1,024 tokens" (failed 128, decode retries 111 and 91); KV-full findings (HTTP 500 "Context size has been exceeded"); KV-full feature row (retries with a smaller batch) |
| q4: vLLM preempted 68 and 264 requests and served at 2,072 and 1,506 tok/s | table (preemptions 68 and 264), chart |

### Chart annotations

| Annotation | Backing |
|---|---|
| Throughput: "vLLM 2.5x at 64 users" | ratio of `levels` tok_s medians at 64 users |
| Reuse: "Cold: vLLM takes 1.9x as long" | 380.1 / 202.4 |
| Reuse: "Warm: 28.7 ms against 33.2 ms" | `reuse.warm_ttft_ms`: 28.7 (llama.cpp, typed text) and 33.2 (vLLM, filled from data) |
| KV: "vLLM: 2,185 tokens per second" (at 256) | vLLM kvFull tok_s at 256 |
| KV: "llama.cpp: all 128 failed" (at 1,024) | llama.cpp kvFull failed at 1,024; drawn at that value on the tokens-per-second axis, so its height means nothing |

### Feature wording audited

- vLLM `cuda_graphs`: the default comes from the optimisation level (O2 is the default, `vllm/config/vllm.py:316` maps it to FULL_AND_PIECEWISE), and `vllm/config/vllm.py` downgrades it to PIECEWISE or NONE in several cases (for example around lines 1934 to 1989). Row now reads "Default level O2: full graphs for decode, may fall back to piecewise".
- vLLM `chat_template_source`: `vllm/renderers/hf.py` tries an explicit template, then the processor template (when no tools), then the tokenizer's, then a fallback file. Row now reads "Usually the HF tokenizer config; --chat-template overrides".
- llama.cpp `cuda_graphs`: the top-level `CMakeLists.txt` sets `GGML_CUDA_GRAPHS_DEFAULT ON`, which only matters in CUDA builds. Row now reads "CUDA builds use graphs by default (CMake option)".

## Files

Per-request records are stored as `*.jsonl.gz` (gzip of the harness's JSONL output); summaries, reuse results, `env.json` and this file are plain text. The site data in `data/bench/` is generated from the summaries only.
