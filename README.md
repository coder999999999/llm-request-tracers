# Request Tracers

Learning notes in interactive form. I wanted to understand what an LLM inference server does between receiving a chat request and streaming tokens back, so I followed one streaming `POST /v1/chat/completions` request through the source of two open-source servers and turned what I found into maps you can step through.

I'm learning this as I go. The maps simplify a lot, each one is pinned to a single commit, and some of it is probably wrong. Corrections are welcome as issues.

## What's here

| Page | What it shows | Pinned to |
| --- | --- | --- |
| [`index.html`](index.html) | Start page: links to the maps, plus a side-by-side of how the two servers differ | |
| [`llama-cpp.html`](llama-cpp.html) | **llama.cpp request tracer.** 53 steps through `llama-server`: HTTP thread, slot scheduler, libllama decode, ggml graph, sampling, SSE | [`ggml-org/llama.cpp@2ca15f5`](https://github.com/ggml-org/llama.cpp/tree/2ca15f5404760548c39e7b92bd43116a09414a1a) |
| [`vllm.html`](vllm.html) | **vLLM request tracer.** 59 steps through `vllm serve`: API process, ZMQ, EngineCore scheduler and paged KV cache, GPU forward pass, sampling, detokenize, SSE. Has a speed control. | [`vllm-project/vllm@1388100`](https://github.com/vllm-project/vllm/tree/138810056093301f4881050fcf2b1786939da387) |
| [`vllm-module-graph.html`](vllm-module-graph.html) | **vLLM module graph.** The import graph of vLLM's 164 Python modules, with an 18-step trace of the same request across them | `vllm-project/vllm@7867d6c` |
| [`video/llama-cpp-request-trace.mp4`](video/llama-cpp-request-trace.mp4) | **The 60-second version.** A narrated collage film of the llama.cpp trace, also embedded on the start page, with English captions (`.en.vtt`). Images from FLUX.1 [schnell], voice from Kokoro-82M, motion graphics and score made in code with Claude | [`ggml-org/llama.cpp@2ca15f5`](https://github.com/ggml-org/llama.cpp/tree/2ca15f5404760548c39e7b92bd43116a09414a1a) |

Each page is a single self-contained HTML file with no build step and no dependencies beyond Google Fonts.

## Viewing

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

They work best on a laptop or desktop screen. Press **Trace** (or use the arrow keys) to step through a request, and click any box for what it does, example data at that point, and links to the exact source lines.

## How they were made

I cloned each repository at a fixed commit and read along the request path with Claude as a reading partner. Every box links to the file and line it describes, and a small script re-checked those references against the pinned commit. Token ids, probabilities and KV block numbers in the examples are illustrative.

## Publishing with GitHub Pages (later)

The repo is laid out to work with Pages as-is (`.nojekyll` is included so files are served untouched):

1. Settings → Pages → Build and deployment → **Deploy from a branch**
2. Branch `main`, folder `/ (root)`

Pages on a private repository needs a paid GitHub plan; on a free plan, make the repository public first.

## Not affiliated

These are personal learning notes, not official documentation, and are not affiliated with the [llama.cpp](https://github.com/ggml-org/llama.cpp) or [vLLM](https://github.com/vllm-project/vllm) projects. Both codebases move quickly, so treat this as a snapshot from early October 2026.
