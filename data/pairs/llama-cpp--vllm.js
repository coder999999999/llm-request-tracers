// Write-up for the llama.cpp vs vLLM pair. Every sentence restates something
// already in the engine files (steps, hops, features); nothing here is measured.
// answers.q1, answers.q4, verdict and annotations stay unset until the
// benchmark results exist.
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
      vllm: 'The scheduler looks up cached prefix blocks and allocates KV blocks. Prefill and decode share one flat batch, and decode runs with full CUDA graphs by default.'
    },
    speak: {
      'llama-cpp': 'The inference thread detokenizes each token and posts a partial result. The HTTP thread reads it and frames it as a server-sent event.',
      vllm: 'The EngineCore sends outputs back to the API process over ZMQ. The API process detokenizes them and frames each chunk as a server-sent event.'
    }
  },
  answers: {
    q2: 'Both skip work they have already done, in different ways. llama.cpp picks the slot whose cache shares the longest prefix with the new prompt. vLLM reuses whole cached prefix blocks, and those blocks can come from other requests.',
    q3: 'llama.cpp stays in one process and crosses a thread boundary twice: the HTTP thread hands the request to the inference thread, and results come back the same way. vLLM crosses a process boundary twice, with ZMQ carrying the request into the EngineCore and the outputs back to the API process. llama.cpp detokenizes on the inference thread, while vLLM does it in the API process.'
  }
});
