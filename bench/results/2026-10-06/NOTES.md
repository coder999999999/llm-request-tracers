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
| 256 | valid, 402 / 484 / 421 tok/s (repeats 0 to 2), TTFT median 2.9 to 7.4 s, only 7 to 18 requests finished in the window | valid, about 2,150 tok/s, TTFT about 500 ms, 0 preemptions |
| 512 | invalid: 128 of 128 requests failed with HTTP 500 "Context size has been exceeded", 100 / 125 / 111 KV-retry log lines | valid, about 2,070 tok/s, TTFT about 820 ms, 65 / 72 / 68 preemptions |
| 1024 | invalid: 128 of 128 failed, same error, 91 / 91 / 105 KV-retry lines | valid, 1,440 to 1,574 tok/s, TTFT 4.7 to 6.7 s, 255 / 278 / 264 preemptions |

This is genuine engine behaviour, not a harness fault and not rerun. With 64 concurrent sequences growing toward 512 or 1,024 generated tokens, the shared 32,768-token budget cannot hold them all; llama.cpp fails the requests once it runs out of room even after retrying, whereas vLLM preempts and recomputes sequences and keeps serving at lower throughput and higher TTFT. At 256 tokens llama.cpp survives but is far slower than its main-config run at the same 64 users (892 tok/s, TTFT 754 ms); the unified-cache configuration and its retries cost a large share of throughput even when nothing fails. The six invalid levels are excluded from the site by `to-site.mjs`.

## Reuse (prefix caching) check

- llama.cpp: cold TTFT 202.4 ms, warm 28.7 ms . On the 57 warm turns across three repeats, `cache_n` has median 1,492 (range 1,491 to 1,492) against a system prompt of roughly 1,490 tokens and a median prompt of 1,517 tokens. Warm turns therefore hit the cache for the whole shared prefix; only the new turn text is evaluated.
- vLLM: cold TTFT 380.1 ms, warm 33.2 ms. The vLLM API does not report a per-request cached-token count, so `cache_n` is null; the 11x drop in TTFT is the evidence of prefix-cache hits.
- Both reuse levels are valid.

## Anomalies and caveats

- llama.cpp `-np 64` at `-c 32768` gives each slot 512 tokens in the main config; prompts are 170 to 190 tokens plus 256 output tokens, so slots are sufficient and no KV retries occur.
- llama.cpp kvfull at 256 tokens completes very few requests in the 60 s window (7 to 18), so its medians rest on a small sample.
- Sustained GPU clocks and temperatures during load were not logged.

## Files

Per-request records are stored as `*.jsonl.gz` (gzip of the harness's JSONL output); summaries, reuse results, `env.json` and this file are plain text. The site data in `data/bench/` is generated from the summaries only.
