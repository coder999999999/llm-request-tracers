# Inference tracer: one forward pass as a tracer graph

Agreed in conversation on 2026-10-13. No new runs: the page uses the captures in `inference/captures/2026-10-07/` and source references already verified at llama.cpp `2ca15f5`.

## Goal

A tracer page, built the same way as `llama-cpp.html` (lanes, nodes, wires, packet, play/step bar, inspector with source links), that follows the tensors through one forward pass of Llama 3.1 8B Q4_K_M instead of following the HTTP request. It zooms into the "Transformer block", "Attention", "Feed-forward", "Output head" and "CUDA backend" boxes of the llama.cpp tracer.

## Granularity

One node per ggml op group, the same groups the forward page and `analyze.py` use (`ROLE_OP`): embedding lookup, input upload, attention norm, Q/K/V projections, RoPE, KV cache write, flash attention, output projection + residual, FFN norm, gate + up + SwiGLU, down + residual, last-layer row trim, output norm, output head, logits readout, sampling, next token. CUDA kernels are listed inside each node's inspector, not drawn as nodes.

## Lanes

Host (CPU) → Attention half of a layer → Feed-forward half → Output → Sampling (CPU). Two loop wires: "next layer, ×32" from down + residual back to the attention norm, and "next token" from sampling back to the token input. The last-layer row trim is an alternate (branch) node.

## Data

- Numbers: the measured block from `inference/capture/to-page.mjs` (Q4_K_M only), embedded in the page as `<script id="measured">`. `to-page.mjs` writes it into both pages.
- Phase switch: decode step (median of 63, CUDA graph replay) or prompt pass (41 tokens, eager launches). Node badges, the inspector's kernel table, tensor shapes and wire labels follow the phase.
- CPU nodes (tokens, sampling) carry no GPU time; the inspector says so and gives the server's per-token time from the same run.
- Source references use the forward page format `{ file, line, check, what }` and are verified by `inference/capture/check-page-refs.mjs`, which now checks both pages.

## Testing

- `tests/inference-tracer.test.mjs` evaluates the page's data block: ids unique, every edge endpoint and trace step exists, consecutive hot-path nodes are wired, every op group and graph node a node names exists in both phases of the measured data, every reference is complete.
- `node inference/capture/check-page-refs.mjs`: all references ok.
- Headless render at 1440, 1024 and 390 px with no console errors; trace plays end to end.

## Out of scope

New captures, other models, F16, vLLM.
