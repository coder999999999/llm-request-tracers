# Inference internals: captures

Ground truth for the planned inference pages: what llama.cpp actually computes and launches for the tracer's request, at the pinned commit `2ca15f5`. The tracer pages follow the request through the server; this folder follows the tensors through one forward pass.

- Request: the tracer's streaming `POST /v1/chat/completions`, "Why is the sky blue?", with `max_tokens: 64` and `seed: 42` added. The Llama 3.1 template adds a dated system header, so the prompt is 41 tokens, not the tracer's illustrative 16.
- Server: the tracer's example config, `-ngl 99 -c 16384 -np 4`, flash attention left at its default `auto` (the graph uses `FLASH_ATTN_EXT`, so it resolved to on).
- Models: Llama-3.1-8B-Instruct as Q4_K_M (quantized from the bench F16 GGUF with `llama-quantize`) and F16 (the bench model).
- Hardware: one RTX 4090 under Docker Desktop (WSL2), driver 616.92, with a display attached (WDDM), so clocks move between steps.

## Run

Needs the bench images and the `rt-models` volume (see `bench/README.md`). In Git Bash, prefix with `MSYS_NO_PATHCONV=1`.

```bash
docker build -t rtbench/llama-prof:2ca15f5 inference/capture
docker run --rm --gpus all -v rt-models:/models -v "$(pwd -W)/inference:/work" rtbench/llama-prof:2ca15f5 \
  bash /work/capture/capture.sh /models/Llama-3.1-8B-Instruct-Q4_K_M.gguf /work/captures/<date>/q4_k_m
docker run --rm -v "$(pwd -W)/inference:/work" rtbench/llama-prof:2ca15f5 \
  python3 /work/capture/analyze.py /work/captures/<date>/q4_k_m
```

`capture.sh` lists every file it writes. `analyze.py` turns a capture into `inventory.json` and a readable `inventory.md`.

## The page

Five pages at the site root render from these captures: `llama-cpp-forward.html`, the write-up with charts; `llama-cpp-inference.html`, the same pass as a tracer graph you can step through; `llama-cpp-weights.html`, the pass as a tape of every weight tensor in read order, with the real activation values the eval-callback logs recorded at each step; and `llama-cpp-attention.html`, the attention map of every head for the prompt, recomputed on the CPU by `capture/attention_maps.py` (numpy + gguf-py from the same GGUF; flash attention never writes the scores out) and checked against the eval-callback corners. A second run with `--reply` replays the streamed reply (64 tokens, re-tokenized from its text) in one 105-token pass, which gives every decode step's attention exactly, and writes them as a PNG mosaic in `captures/<date>/q4_k_m/attention/decode/`. The page's maps live in `data/attention/` (1.7 MB for the prompt, one byte per weight; a 1.1 MB PNG for the reply rows) and are loaded on demand. Each stays one self-contained file: the measured numbers sit in its `<script id="measured">` block, and the explanations and source references are written in the page. `llama-cpp-lens.html` is the logit lens of the same pass, from `capture/logit_lens.py`: the top tokens the output head would read from every layer and position, the final position's candidates through the layers, and direct logit attribution per head and feed-forward block.

```bash
node inference/capture/to-page.mjs              # copy the numbers from captures/2026-10-07 into the forward and inference pages
node inference/capture/to-weights.mjs           # build the weights page's block: tape from tensors.json, values from the ops logs (plus captures/2026-10-13-bare)
node inference/capture/to-attention.mjs         # copy the attention maps into data/attention and the page's block
node inference/capture/to-lens.mjs              # copy the logit-lens results into the lens page's block
node inference/capture/check-page-refs.mjs      # check every file:line reference on the five pages at the pinned commit
```

`check-page-refs.mjs` applies the same rule as `tools/check-sources.mjs`: the check text must appear within 3 lines of the cited line. It reads `bench/.src/llama.cpp` when that checkout is at the pinned commit, and fetches from GitHub otherwise. Run both after changing a capture or the page's references.

## How to read the numbers

- **Two views of the same graph.** `ops-*.log` comes from `llama-eval-callback`. The callback makes the scheduler stop after every node, so it shows the logical ggml graph with no CUDA fusion and no CUDA graphs. The nsys trace shows the real kernels, with fusion. Expect fewer kernels than nodes.
- **Passes.** The request's GPU work is cut into forward passes at each logits copy (Device-to-Host, 128,256 × 4 bytes). Pass 0 is the prefill and the rest are decode steps. Every decode step launches the same kernel sequence, so decode numbers are the median per kernel position across all steps.
- **Kernel durations are trustworthy; wall times under nsys are not.** Tracing every launch slows the CPU side, most visibly in the prefill, which is not a CUDA graph. Use `bench.json` (llama-bench, no profiler) for throughput.
- **GB/s** is the bytes of the weight tensor(s) a matmul must read divided by its kernel time. It ignores activations and the KV cache, which are small at this context length.
- **The decode-shaped op list** (`ops-decode.log`) is a 1-token batch at position 0, not a real decode step at position 41. The ops are the same; the attention span differs.

## Large files

Committed per capture: the inventories, `trace.nsys-rep`, the kernel and API summaries, `server.log`, `bench.json`, `tensors.json`, `prompt.txt` and `stream.txt`. Not committed, because they are large: `trace_cuda_gpu_trace.csv`, `sched-prefill.log` and the eval-callback `ops-*.log` files (about 6 MB; their parsed graph is in `inventory.json`). Re-running `analyze.py` needs the CSV and the op logs, so regenerate them with `capture.sh`, or rebuild the CSVs alone from `trace.nsys-rep` with:

```bash
nsys stats --force-export=true --force-overwrite=true --report cuda_gpu_trace,cuda_gpu_kern_sum,cuda_api_sum --format csv --output trace trace.nsys-rep
```
