# What one forward pass does: findings, 2026-10-07

The tracer's request, profiled on one RTX 4090 at llama.cpp `2ca15f5` with Llama-3.1-8B-Instruct as Q4_K_M and F16. The data is in `q4_k_m/` and `f16/`. Each folder has an `inventory.md` (readable) and an `inventory.json` (for the pages). Method and caveats are in `../../README.md`. Source references are file:line at `2ca15f5`.

## The numbers

| | Q4_K_M | F16 |
|---|---:|---:|
| Weights read per token (GPU) | 4,403 MiB | 14,315 MiB |
| ggml nodes per forward pass | 998 | 998 |
| CUDA kernels, prefill (41 tokens) | 1,022 | 1,114 |
| CUDA kernels, one decode step | 646 | 453 |
| Decode step, GPU busy (median of 63) | 6.25 ms | 18.0 ms |
| Weight bytes ÷ decode GPU time | 739 GB/s | 834 GB/s |
| Best single matmul (LM head) | 947 GB/s | 954 GB/s |
| llama-bench tg64, no profiler | 154.2 tok/s | 54.4 tok/s |
| llama-bench pp41, no profiler | 4,006 tok/s (±632) | 1,892 tok/s (±130) |

The 4090's memory bandwidth is about 1,008 GB/s, so for Q4_K_M the ceiling is about 1,008 / 4.62 GB ≈ 218 tok/s. The run reaches 154 tok/s, about 71% of that.

## Findings

1. **Decode is a memory-bandwidth problem.** Each decode step reads every weight once to produce one token. The large matmuls run at 890–950 GB/s, close to the card's peak. The small ones (K and V projections, 2–3 MiB each) reach only 470–660 GB/s because they are too small to fill the GPU. F16 reads 3.25× the bytes and takes 2.9× as long per step.
2. **The feed-forward block is most of the work.** In a Q4_K_M decode step, gate+up (39.5%) and down (25.0%) take 64.5% of GPU time. The LM head is one 455 µs kernel over a 411 MiB Q6_K matrix, 7.8% on its own and the single longest kernel. Attention is 2.6% at this context length (41–105 tokens).
3. **The embedding lookup runs on the CPU.** `token_embd` (282 MiB for Q4_K_M) is always kept in host memory: "there is very little benefit to offloading the input layer" (`src/llama-model.cpp:1606`). The scheduler makes split #0 a single CPU `GET_ROWS`. Split #1 is the rest of the model on CUDA0, with 6 inputs (embeddings, positions, K and V cache slot indices, mask, output ids). Those are the 6 host-to-device copies that start every pass in the trace.
4. **Activations are quantized too.** Before every quantized matmul a small kernel converts the activations to Q8_1 (`quantize_q8_1` for decode, `quantize_mmq_q8_1` for prefill). The matmul then works on two quantized operands.
5. **One graph, different kernels per phase.** `ggml_cuda_mul_mat` (`ggml/src/ggml-cuda/ggml-cuda.cu:1875`) picks a kernel by batch size and type:
   - Quantized weights with batch ≤ 8 (`MMVQ_MAX_BATCH_SIZE`, `mmvq.cuh:3`) use `mul_mat_vec_q`, a matrix-vector product with one block per output row (grid = 4096, 1024, 14336 or 128,256).
   - Quantized weights with larger batches use `mul_mat_q` with stream-k: grid 128, one block per SM on the 4090, plus a `stream_k_fixup` kernel.
   - F16 uses `mul_mat_vec_f` for decode and cuBLAS (cutlass / `ampere_h16816gemm`) for prefill, with `convert_unary` kernels around each GEMM to cast activations to half and back.
6. **Flash attention, two kernels.** `ggml_cuda_get_best_fattn_kernel` (`fattn.cu:541`) picks the vector kernel for a 1-token batch on Ada with an F16 KV cache (`fattn.cu:647`): `flash_attn_ext_vec` plus `flash_attn_combine_results`. Otherwise it picks the tensor-core MMA kernel (`fattn.cu:664`): `flash_attn_ext_f16` plus a stream-k fixup. GQA is visible in the shapes: Q has 32 heads of 128, K and V have 8, so each KV head serves 4 query heads.
7. **Fusion applies to decode, not prefill.** Each layer has 31 logical ggml nodes (some are free views):
   - **Q4_K_M decode** runs those 31 nodes as 20 kernels. The residual `ADD` folds into the o_proj and down matmuls (`ggml-cuda.cu:4164`, "mul_mat + add"). Gate, up and SwiGLU become one kernel (`ggml-cuda.cu:4027`). `RMS_NORM` + `MUL` becomes one kernel (`ggml-cuda.cu:4240`).
   - **Q4_K_M prefill** fuses only the norm. Matmul fusion requires a 1-column output (`ggml-cuda.cu:1814`), so prefill keeps separate add and SwiGLU kernels: 32 kernels per layer.
   - **F16** runs 14 kernels per decode layer (no activation quantize) and 35 per prefill layer (casts around cuBLAS).
8. **The last layer trims to one row.** After attention in the last layer, `GET_ROWS` keeps only the row whose logits are needed (`src/models/llama.cpp:174`). So even in the prefill, the final FFN and the LM head run on one token. That is why the prefill's last FFN uses the matrix-vector kernel, and why the LM head kernel takes the same 455 µs in both phases.
9. **Decode is a CUDA graph replay; the prefill is not.** Decode steps replay one captured graph of the same 646-kernel sequence ("graphs reused = 63" in `server.log`; 63 `cudaGraphLaunch` calls over the run). The prefill launches its 1,022 kernels one at a time. This isn't a batch-size rule: this commit has none. A CUDA graph is captured only after two consecutive identical calls (`ggml-cuda.cu:4536`), and a 41-token pass happens once. llama.cpp keeps decode graphs identical by padding the attended span to a multiple of 256 cells (`src/llama-kv-cache.cpp:1265`). Without the profiler the prefill takes about 10 ms (llama-bench pp41). Under nsys, which traces every launch, it took 24 ms of wall time for 9.3 ms of GPU work.
10. **Q4_K_M is a mix.** Q4_K for most matrices; Q6_K for `attn_v` and `ffn_down` in 16 of 32 layers each and for `output.weight`. 4.89 bits per weight overall (4,685 MiB including `token_embd`).

## Open questions

- **Explained from source, not yet confirmed by a rerun:** the RoPE + VIEW + SET_ROWS fusion (`ggml-cuda.cu:3634`) didn't fire. The server runs with `-np 4` and `kv_unified = false`, so the KV cache has 4 streams. `cpy_k` then reshapes the cache to one table (`src/llama-kv-cache.cpp:1356`). `ggml_set_rows` keeps its destination as `src[2]` (`ggml/src/ggml.c:4032`), so that RESHAPE node lands between the VIEW and the SET_ROWS, and the fusion matcher needs three consecutive nodes (`ggml/src/ggml-impl.h:750`). The single-sequence eval-callback graph has no such RESHAPE, which is why it looked fusable. To confirm, rerun the server with `-kvu`: expect `rope_norm<1, 1, float, __half>` and half as many `k_set_rows` launches.
- The eval-callback graphs (`ops-*.log`, `sched-prefill.log`) come from a single-sequence context (`n_seq_max = 1`, 16,384 cells). The server has 4 streams of 4,096 cells, which adds one RESHAPE per cache write and otherwise builds the same graph.
- Decode GPU time varies 5.8–7.9 ms between steps with an identical kernel sequence. That fits clock changes on a WDDM GPU driving a display, but it isn't confirmed. Locking clocks or a headless GPU would settle it.
- **Resolved from source:** `mul_mat_q` on Ada uses int8 tensor cores. `ggml_cuda_should_use_mmq` returns true on Turing and newer (`ggml/src/ggml-cuda/mmq.cu:371`). Q4_K tiles go through `mma.sync.aligned.m16n8k32.row.col.s32.s8.s8.s32` (`ggml/src/ggml-cuda/mma.cuh:1084`) and Q6_K through the m16n8k16 s8 variant (`:1062`). `dp4a` is used only by the decode path (`mul_mat_vec_q`).

## For the pages

- Every number on a page should come from `inventory.json`, not from this note.
- Kernel names and template arguments are as nsys reports them. Type ids are decoded (12 = Q4_K, 14 = Q6_K, 1 = F16).
- Per-step decode durations are medians across 63 steps. Show the spread where a single number would mislead.
