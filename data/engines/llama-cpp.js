// llama.cpp engine facts. Steps come from llama-cpp.steps.js (generated).
// Every feature carries file, line and check, verified by tools/check-sources.mjs.
RT.registerEngine({
  id: 'llama-cpp',
  name: 'llama.cpp',
  lang: 'C++',
  color: '#d9662a',
  repo: 'https://github.com/ggml-org/llama.cpp',
  commit: '2ca15f5404760548c39e7b92bd43116a09414a1a',
  tracer: 'llama-cpp.html',
  shape: 'One process. HTTP threads hand work to a single inference thread.',
  features: {
    api_openai: {
      value: 'OpenAI-compatible /v1/chat/completions',
      file: 'tools/server/server.cpp', line: 267, check: '/v1/chat/completions'
    },
    chat_template_source: {
      value: 'Template read from the GGUF file',
      file: 'common/chat.cpp', line: 767, check: 'llama_model_chat_template'
    },
    tokenize_where: {
      value: 'Tokenizes on the HTTP thread',
      file: 'tools/server/server-context.cpp', line: 4518, check: 'tokenize_input_prompts'
    },
    batching: {
      value: 'Fixed number of slots (--parallel)',
      file: 'common/arg.cpp', line: 2544, check: '--parallel'
    },
    step_shape: {
      value: 'One batch per tick covers every active slot',
      file: 'tools/server/server-context.cpp', line: 3014, check: 'decode(n_batch'
    },
    prefix_reuse: {
      value: 'Idle slot with best prefix match over a threshold, else least recent',
      file: 'tools/server/server-context.cpp', line: 1657, check: 'slot_prompt_similarity'
    },
    kv_full: {
      value: 'Out of KV room: retries with a smaller batch',
      file: 'tools/server/server-context.cpp', line: 3927, check: 'n_batch /= 2'
    },
    detokenize_where: {
      value: 'Detokenizes on the inference thread',
      file: 'tools/server/server-context.cpp', line: 4084, check: 'common_token_to_piece'
    },
    kv_layout: {
      value: 'KV cells form a ring buffer searched for a free slot',
      file: 'src/llama-kv-cache.h', line: 301, check: 'ring buffer of KV cells'
    },
    cuda_graphs: {
      value: 'CUDA graphs are on by default in the CMake build',
      file: 'CMakeLists.txt', line: 170, check: 'GGML_CUDA_GRAPHS_DEFAULT'
    },
    model_formats: {
      value: 'Loads GGUF model files',
      file: 'src/llama-model-loader.cpp', line: 570, check: 'gguf_init_from_file'
    },
    hardware: {
      value: 'Backends enabled by build flags, e.g. CUDA and Metal',
      file: 'ggml/src/ggml-backend-reg.cpp', line: 120, check: 'GGML_USE_CUDA'
    },
    structured_output: {
      value: 'JSON schema is converted to a grammar that constrains sampling',
      file: 'common/arg.cpp', line: 2285, check: 'json_schema_to_grammar'
    },
    tool_calling: {
      value: 'Tool calling requires the Jinja chat template engine',
      file: 'common/chat.h', line: 256, check: 'use_jinja'
    }
  }
});
