# Bare-prompt eval-callback pass, 2026-10-13

A second `llama-eval-callback` pass over the same model at the same commit, on the bare text "Why is the sky blue?" with no chat template. Its purpose is the weights page: `common_debug_cb_eval` prints only the first three and last three rows of each tensor, and in the 41-token templated prompt those rows are all template tokens. With 7 tokens the printed rows are `<|begin_of_text|>`, `Why`, ` is` and ` sky`, ` blue`, `?`, so the words themselves are visible.

## How it was run

- Image `rtbench/eval-callback:2ca15f5`, built from `bench/.src/llama.cpp` at `2ca15f5` with a small Dockerfile (CPU only, `GGML_NATIVE=ON`, targets `llama-eval-callback` and `llama-tokenize`). The stock `.devops/cpu.Dockerfile` builds every CPU variant and the compiler crashed on the AVX-512 `cooperlake` one inside the Docker VM.
- `llama-eval-callback -m Llama-3.1-8B-Instruct-Q4_K_M.gguf -p "Why is the sky blue?" -c 16384 -fa on -n 1 --temp 0`, on the CPU. `-fa on` keeps the graph identical to the profiled run (one `FLASH_ATTN_EXT` node per layer); `-c 16384` keeps the cache shapes.
- `ops-bare.log` (the 998-node dump, git-ignored) and `tokens.json` (from `llama-tokenize`, 7 ids) are in this folder. `inference/capture/to-weights.mjs` reads the log into the page's data block, so the site needs nothing from here.

## Caveats

- Not profiled: there is no timing for this pass. The page shows the prompt pass's kernels and timings next to it and says so.
- CPU kernels, not CUDA: the values differ from a GPU run in the last digits (different accumulation order), not in meaning.
- A different prompt from the profiled request, so the values are not the ones that produced the reply "The sky appears blue".
