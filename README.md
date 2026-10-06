# Request Tracers

Step-through maps of one streaming `POST /v1/chat/completions` request through the source of two LLM inference servers. Simplified, pinned to one commit each, and probably wrong in places. Corrections welcome as issues.

## Pages

| Page | What it shows | Pinned to |
| --- | --- | --- |
| [`index.html`](index.html) | Comparison of llama.cpp and vLLM: questions, code paths, features, benchmarks | |
| [`llama-cpp.html`](llama-cpp.html) | **llama.cpp tracer.** 53 steps through `llama-server`: HTTP, slot scheduler, decode, ggml graph, sampling, SSE | [`ggml-org/llama.cpp@2ca15f5`](https://github.com/ggml-org/llama.cpp/tree/2ca15f5404760548c39e7b92bd43116a09414a1a) |
| [`vllm.html`](vllm.html) | **vLLM tracer.** 59 steps through `vllm serve`: API process, ZMQ, scheduler and paged KV cache, forward pass, sampling, detokenize, SSE | [`vllm-project/vllm@1388100`](https://github.com/vllm-project/vllm/tree/138810056093301f4881050fcf2b1786939da387) |
| [`vllm-module-graph.html`](vllm-module-graph.html) | **vLLM module graph.** Import graph of 164 modules with an 18-step trace | `vllm-project/vllm@7867d6c` |
| [`video/llama-cpp-request-trace.mp4`](video/llama-cpp-request-trace.mp4) | **Episode 1 video** (1:44) of the llama.cpp trace, with English captions. Also on the start page. Series plan: [`docs/video-series.md`](docs/video-series.md) | [`ggml-org/llama.cpp@2ca15f5`](https://github.com/ggml-org/llama.cpp/tree/2ca15f5404760548c39e7b92bd43116a09414a1a) |

Each page is a single self-contained HTML file. No build step.

## Viewing

Open `index.html` in a browser. Press **Trace** or use the arrow keys to step; click a box for details and source links. Best on a desktop screen.

## Data files

The site renders from `data/`:

- `registry.js`: Global registry (window.RT) for engines, pairs, benchmarks, and validation.
- `compare.js`: Comparison metadata: stages (request flow phases), questions (side-by-side comparisons), and features (yes/no traits).
- `engines/`: LLM inference engine definitions.
  - `<id>.js`: Hand-written engine metadata (name, color, repo URL, commit hash, tracer HTML file, shape, and feature values).
  - `<id>.steps.js`: Generated step traces from the tracer page (produced by `node tools/export-steps.mjs`).
- `pairs/<a>--<b>.js`: Comparison data between two engines (differences, insights, etc.).
- `bench/`: Benchmark results (generated later by `bench/to-site.mjs`; not present yet).

To add an engine: create an engine file, generate steps from its tracer page, add pair files for each existing engine, and run the checks.

## Checks

- `npm install`: Install dependencies.
- `npm test`: Run unit tests.
- `npm run check`: Verify all code references (engine steps and features) against pinned git commits; fetch and validate that the `check` token appears near the stated line.
- `npm run test:e2e`: Run end-to-end smoke tests.

## How they were made

Each repo was read at a fixed commit with Claude. Every box links to its source line, checked by script against that commit. Example token ids, probabilities and block numbers are illustrative.

## GitHub Pages

Works as-is (`.nojekyll` included): Settings → Pages → Deploy from a branch → `main`, `/ (root)`. Private repos need a paid plan.

## Not affiliated

Learning notes, not affiliated with [llama.cpp](https://github.com/ggml-org/llama.cpp) or [vLLM](https://github.com/vllm-project/vllm). Snapshot from October 2026.
