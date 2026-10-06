// Synthetic bench data for renderer tests. Not real measurements.
const m = (median, min = median, max = median) => ({ median, min, max });
const run = { date: '2026-01-01', gpu: 'Test GPU', model: 'Test model', commit: 'test', config: 'main' };

export const vllmBench = {
  id: 'vllm',
  run,
  levels: [
    { users: 32, ttft_ms: m(55), queue_ms: m(4), prefill_ms: m(40), tok_s: m(1800, 1750, 1850), itl_ms: m(12), e2e_ms: m(3000) },
    { users: 64, ttft_ms: m(90), tok_s: m(2700, 2650, 2760), itl_ms: m(20), e2e_ms: m(5000) },
  ],
};

export const llamaBench = {
  id: 'llama-cpp',
  run,
  levels: [
    { users: 32, ttft_ms: m(60), prefill_ms: m(38), tok_s: m(480, 470, 490), itl_ms: m(60), e2e_ms: m(16000) },
    { users: 64, ttft_ms: m(400), tok_s: m(495, 490, 500), itl_ms: m(120), e2e_ms: m(30000) },
  ],
  reuse: { cold_ttft_ms: 1200, warm_ttft_ms: 90 },
  kvFull: [
    { max_tokens: 256, tok_s: 480, ttft_ms: 200, failed: 0 },
    { max_tokens: 1024, tok_s: 300, ttft_ms: 900, kv_retries: 7, failed: 2 },
  ],
};

// Same as vllmBench plus the reuse and kvFull runs, for the q2 and q4 evidence tests.
export const vllmBenchFull = {
  ...vllmBench,
  reuse: { cold_ttft_ms: 1100, warm_ttft_ms: 40 },
  kvFull: [
    { max_tokens: 256, tok_s: 2500, ttft_ms: 60, preemptions: 0, failed: 0 },
    { max_tokens: 1024, tok_s: 2100, ttft_ms: 300, preemptions: 12, failed: 0 },
  ],
};
