#!/usr/bin/env bash
# Capture the op and kernel inventory for one model, inside rtbench/llama-prof:2ca15f5.
#   capture.sh <model.gguf> <out dir>
# Writes to <out dir>:
#   prompt.txt                 the chat-templated prompt the server builds for the tracer's request
#   ops-prefill.log            llama-eval-callback over that prompt (every ggml node: name, op, type, shapes)
#   ops-decode.log             llama-eval-callback over a 1-token batch (the decode-shaped graph)
#   sched-prefill.log          GGML_SCHED_DEBUG=2 split and backend assignment for the prefill graph
#   server.log                 llama-server log of the profiled run
#   stream.txt                 the SSE response
#   trace.nsys-rep             Nsight Systems trace of the request only (not start-up)
#   trace_*.csv                nsys stats reports (kernel trace, kernel summary, API summary)
#   bench.json                 llama-bench, no profiler attached (pp41, tg64, 5 repeats)
#   tensors.json               every weight tensor in the GGUF with its quant type and size
set -euo pipefail
MODEL="$1"
OUT="$2"
mkdir -p "$OUT"
cd /app

# The tracer's example server config (llama-cpp.html, "s_main").
SERVER_ARGS=(-m "$MODEL" -ngl 99 -c 16384 -np 4 --host 127.0.0.1 --port 8080)
REQUEST='{"messages":[{"role":"user","content":"Why is the sky blue?"}],"stream":true,"max_tokens":64,"seed":42}'

wait_health() {
  for _ in $(seq 1 180); do
    curl -sf http://127.0.0.1:8080/health >/dev/null && return 0
    sleep 1
  done
  echo "server did not become healthy" >&2; return 1
}

# 1. The exact prompt text the server renders for this request.
./llama-server "${SERVER_ARGS[@]}" >"$OUT/server-template.log" 2>&1 &
PID=$!
wait_health
curl -sf http://127.0.0.1:8080/apply-template -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Why is the sky blue?"}]}' \
  | python3 -c 'import json,sys; p=json.load(sys.stdin)["prompt"]; sys.stdout.write(p.removeprefix("<|begin_of_text|>"))' \
  >"$OUT/prompt.txt"
kill $PID; wait $PID 2>/dev/null || true

# 2. Logical op list. The eval callback makes the scheduler stop after every node,
#    so this shows ggml ops before CUDA fusion and without CUDA graphs.
#    The prompt ends in "\n\n" (its own token). "$(cat ...)" would strip it and -f drops one
#    trailing newline, so pass -f a copy with one extra newline.
PROMPT_FILE=/tmp/prompt-for-f.txt
{ cat "$OUT/prompt.txt"; printf '\n'; } >"$PROMPT_FILE"
./llama-eval-callback -m "$MODEL" -ngl 99 -c 16384 -f "$PROMPT_FILE" >"$OUT/ops-prefill.log" 2>&1
# Empty prompt + BOS = a 1-token batch, the same graph shape as one decode step.
./llama-eval-callback -m "$MODEL" -ngl 99 -c 16384 -p "" >"$OUT/ops-decode.log" 2>&1

# 3. Scheduler splits (which backend runs each node).
GGML_SCHED_DEBUG=2 ./llama-eval-callback -v -m "$MODEL" -ngl 99 -c 16384 -f "$PROMPT_FILE" \
  >"$OUT/sched-prefill.log" 2>&1 || true

# 4. Kernel trace of one real streaming request. The whole server lifetime is profiled
#    (CUPTI buffers only flush reliably at exit), with an idle gap of 3 s after start-up,
#    so the request is the last burst of GPU work in the trace (see analyze.py).
nsys profile --trace=cuda,nvtx --cuda-graph-trace=node --sample=none --cpuctxsw=none \
  --output="$OUT/trace" --force-overwrite=true \
  ./llama-server "${SERVER_ARGS[@]}" >"$OUT/server.log" 2>&1 &
PID=$!
wait_health
sleep 3
curl -sN http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' -d "$REQUEST" >"$OUT/stream.txt"
sleep 1
pkill -INT -f 'llama-server -m' || true
wait $PID 2>/dev/null || true

# 5. Uninstrumented timings for the same shapes (41-token prompt, 64 generated tokens).
./llama-bench -m "$MODEL" -ngl 99 -p 41 -n 64 -r 5 -o json >"$OUT/bench.json" 2>"$OUT/bench.log"

# 6. Weight tensors: name, quant type, shape, bytes.
python3 - "$MODEL" >"$OUT/tensors.json" <<'PY'
import json, sys
sys.path.insert(0, "/app/gguf-py")
from gguf import GGUFReader
r = GGUFReader(sys.argv[1])
print(json.dumps([{"name": t.name, "type": t.tensor_type.name, "shape": [int(x) for x in t.shape],
                   "bytes": int(t.n_bytes)} for t in r.tensors], indent=0))
PY

nsys stats --force-export=true --force-overwrite=true --report cuda_gpu_trace,cuda_gpu_kern_sum,cuda_api_sum \
  --format csv --output "$OUT/trace" "$OUT/trace.nsys-rep" >/dev/null
rm -f "$OUT/trace.sqlite"
ls -la "$OUT"
