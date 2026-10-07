// Write-up for the llama.cpp vs vLLM pair. Stage summaries and q3 restate the engine
// files (steps, hops, features). The headline, teasers, verdict, q1, q2 and q4 answers and the annotations
// restate the 2026-10-06 benchmark; each is listed with its source in
// bench/results/2026-10-06/NOTES.md under "Claims".
RT.registerPair({
  ids: ['llama-cpp', 'vllm'],
  stageSummaries: {
    arrive: {
      'llama-cpp': 'An HTTP thread parses the OpenAI-style request, renders the chat template read from the GGUF file and tokenizes the prompt.',
      vllm: 'The API process runs FastAPI on an asyncio event loop. The chat template comes from the Hugging Face tokenizer config, and tokenizing happens in the same process.'
    },
    wait: {
      'llama-cpp': 'The request is posted to a queue and picked up by the single inference thread, which gives it one of a fixed number of slots.',
      vllm: 'The request crosses into the EngineCore process over ZMQ and is added to the scheduler, which admits WAITING requests on each step. Every step spends one token budget shared by all requests.'
    },
    think: {
      'llama-cpp': 'The slot reuses the cached prefix it shares with the new prompt. One batch per tick then covers every active slot.',
      vllm: 'The scheduler looks up cached prefix blocks and allocates KV blocks. Prefill and decode share one flat batch, and decode runs with full CUDA graphs when supported.'
    },
    speak: {
      'llama-cpp': 'The inference thread detokenizes each token and posts a partial result. The HTTP thread reads it and frames it as a server-sent event.',
      vllm: 'The EngineCore sends outputs back to the API process over ZMQ. The API process detokenizes them and frames each chunk as a server-sent event.'
    }
  },
  answers: {
    q1: 'At 1 user the two engines produce the same output rate, 50.4 and 49.4 tokens per second. At 64 users vLLM produces 2,209 tokens per second and llama.cpp 892, and at 32 users a request spent 115 ms before prefill on vLLM against 420 ms on llama.cpp (derived, in the Before prefill row under the chart). The code paths differ, with a fixed number of slots on one side and one shared token budget per step on the other, but the measurements show the gap without isolating which difference causes it.',
    q2: 'Both skip work they have already done, in different ways, and both answer repeat messages much faster than the first one. With a system prompt of about 1,490 tokens, llama.cpp went from 166 to 29 ms to first token and vLLM from 175 to 34 ms, roughly 6 and 5 times faster. llama.cpp gives the request the idle slot whose cache shares the most of the prompt, as long as the match clears a similarity threshold, and otherwise takes the least recently used idle slot. vLLM reuses whole cached prefix blocks, and those blocks can come from other requests. On the cold first message the two were within 6% of each other, 166 against 175 ms.',
    q4: 'Both servers were given 64 users and a 32,768-token KV budget. With replies capped at 256 tokens both engines finished every request. At 512 and 1,024 tokens every llama.cpp request failed with a context size error, after it had retried with smaller batches (111 and 91 retries). vLLM preempted requests, 68 and 264 of them, and kept serving at 2,072 and 1,506 tokens per second.',
    q3: 'llama.cpp stays in one process and crosses a thread boundary twice: the HTTP thread hands the request to the inference thread, and results come back the same way. vLLM crosses a process boundary twice, with ZMQ carrying the request into the EngineCore, where an input socket thread receives it, and the outputs back to the API process after an output socket thread sends them. It also renders the chat template on a thread pool. llama.cpp detokenizes on the inference thread, while vLLM does it in the API process.'
  },
  // One sentence for the top of the page, and a one-line answer per question for the
  // question list. A teaser's stat is the one number to remember, unit says what it
  // counts, and engine colours it.
  headline: 'With one person chatting, the two are even. With 64 people chatting at once, vLLM puts out 2.5 times as much text.',
  teasers: {
    q1: { stat: '2.5×', unit: 'vLLM output at 64 users', engine: 'vllm', text: 'Even at 1 user. At 64 users vLLM puts out 2.5 times as much text.' },
    q2: { stat: 'Even', unit: 'on prompt reuse', text: 'Both answer a repeat message 5 to 6 times faster than the first one.' },
    q3: { stat: '1 vs 2', unit: 'processes', text: 'llama.cpp hands your request between threads in one process. vLLM hands it between two processes.' },
    q4: { stat: '128 of 128', unit: 'llama.cpp requests failed', engine: 'llama-cpp', text: 'Once long replies filled the cache, every llama.cpp request failed. vLLM paused some requests and kept serving.' }
  },
  verdict: {
    a: [
      'only a few people chat at once. Up to 8 users it stays within 1.2 times of vLLM.',
      'your model is a GGUF file, the format llama.cpp loads.'
    ],
    b: [
      'many people chat at once. At 64 users it puts out 2.5 times as much text.',
      'replies run long. When the cache filled it kept serving, where every llama.cpp request failed.',
      'requests must start fast under load. At 32 users they waited about 115 ms before work began, against 420 ms.'
    ]
  },
  annotations: {
    q1: [
      { source: 'levels', x: 64, metric: 'tok_s', kind: 'ratio', text: 'vLLM {v}× at 64 users' }
    ],
    q2: [
      { source: 'reuse', metric: 'cold_ttft_ms', kind: 'ratio', text: 'Cold: vLLM {v}× the llama.cpp time' },
      { source: 'reuse', metric: 'warm_ttft_ms', kind: 'value', engine: 'vllm', text: 'Warm: 29.1 ms against {v} ms' }
    ],
    q4: [
      { source: 'kvFull', x: 1024, metric: 'failed', kind: 'value', engine: 'llama-cpp', text: 'llama.cpp: all {v} failed' },
      { source: 'kvFull', x: 256, metric: 'tok_s', kind: 'value', engine: 'vllm', text: 'vLLM: {v} tokens per second' }
    ]
  }
});
