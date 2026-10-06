// vLLM engine facts. Steps come from vllm.steps.js (generated).
// Every feature carries file, line and check, verified by tools/check-sources.mjs.
RT.registerEngine({
  id: 'vllm',
  name: 'vLLM',
  lang: 'Python',
  color: '#2b54d0',
  repo: 'https://github.com/vllm-project/vllm',
  commit: '138810056093301f4881050fcf2b1786939da387',
  tracer: 'vllm.html',
  shape: 'Two processes. An API process and an EngineCore that owns the GPU, talking over ZMQ.',
  features: {
    api_openai: {
      value: 'OpenAI-compatible /v1/chat/completions',
      file: 'vllm/entrypoints/openai/chat_completion/api_router.py', line: 42, check: '/v1/chat/completions'
    },
    chat_template_source: {
      value: 'Template from the HF tokenizer config',
      file: 'vllm/renderers/hf.py', line: 295, check: 'get_chat_template'
    },
    tokenize_where: {
      value: 'Tokenizes in the API process (asyncio)',
      file: 'vllm/renderers/base.py', line: 727, check: '_tokenize_prompt_async'
    },
    batching: {
      value: 'One token budget per step, shared by all requests',
      file: 'vllm/v1/core/sched/scheduler.py', line: 591, check: 'token_budget'
    },
    step_shape: {
      value: 'Prefill and decode share one flat batch',
      file: 'vllm/v1/core/sched/scheduler.py', line: 574, check: 'decoding phase'
    },
    prefix_reuse: {
      value: 'Reuses any matching cache block, across requests',
      file: 'vllm/v1/core/kv_cache_manager.py', line: 264, check: 'get_computed_blocks'
    },
    kv_full: {
      value: 'Out of KV room: preempts a request, recomputes later',
      file: 'vllm/v1/core/sched/scheduler.py', line: 773, check: 'Preempt the lowest-priority'
    },
    detokenize_where: {
      value: 'Detokenizes in the API process',
      file: 'vllm/v1/engine/output_processor.py', line: 745, check: 'detokenizer.update'
    }
  }
});
