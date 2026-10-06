// Shared stages, questions and feature catalogue. Text here is the only copy.
(function () {
  var C = {
    stages: [
      { id: 'arrive', number: 1, name: 'Arrive', subtitle: 'HTTP in, chat template, tokens' },
      { id: 'wait',   number: 2, name: 'Wait',   subtitle: 'Queued, then given a place in the batch' },
      { id: 'think',  number: 3, name: 'Think',  subtitle: 'KV cache, forward pass, sampling' },
      { id: 'speak',  number: 4, name: 'Speak',  subtitle: 'Text back out as server-sent events' }
    ],
    questions: [
      { id: 'q1', text: 'How far does vLLM pull ahead as more people chat?', stages: ['wait'], chart: 'throughput' },
      { id: 'q2', text: 'Who reuses your prompt better?', stages: ['think'], chart: 'reuse' },
      { id: 'q3', text: 'Where does your request cross a thread or process boundary?', stages: ['arrive', 'speak'], chart: 'boundaries' },
      { id: 'q4', text: 'What happens when the KV cache runs out of room?', stages: ['think'], chart: 'kvFull' }
    ],
    features: [
      { key: 'api_openai',           stage: 'arrive', label: 'API' },
      { key: 'chat_template_source', stage: 'arrive', label: 'Chat template' },
      { key: 'tokenize_where',       stage: 'arrive', label: 'Tokenizing' },
      { key: 'batching',             stage: 'wait',   label: 'Batching' },
      { key: 'step_shape',           stage: 'wait',   label: 'Each step' },
      { key: 'prefix_reuse',         stage: 'think',  label: 'Prompt reuse' },
      { key: 'kv_layout',            stage: 'think',  label: 'KV cache layout' },
      { key: 'kv_full',              stage: 'think',  label: 'KV cache full' },
      { key: 'cuda_graphs',          stage: 'think',  label: 'CUDA graphs' },
      { key: 'detokenize_where',     stage: 'speak',  label: 'Detokenizing' },
      { key: 'model_formats',        stage: null,     label: 'Model formats' },
      { key: 'hardware',             stage: null,     label: 'Hardware' },
      { key: 'structured_output',    stage: null,     label: 'Structured output' },
      { key: 'tool_calling',         stage: null,     label: 'Tool calling' }
    ]
  };
  window.RT = window.RT || {};
  window.RT.compare = C;
})();
