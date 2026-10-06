// Exports the step lists of the two interactive tracer pages into
// data/engines/<id>.steps.js (RT.addSteps calls). Rerunnable and deterministic.
//
//   node tools/export-steps.mjs
//
// Drives the installed Chrome (override with CHROME_PATH) over file://, clicks
// #tNext once per step, and reads each step's title and function from #tName and
// its file and line from the inspector's source link (a GitHub blob URL at the
// pinned commit). Client steps have no link and fall outside the stage ranges.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// Tracer step numbers per stage, the key steps, and the boundary hops.
const ENGINES = {
  'llama-cpp': {
    page: 'llama-cpp.html',
    stages: { arrive: [2, 9], wait: [10, 15], think: [16, 36], speak: [37, 41] },
    key: [2, 4, 6, 8, 10, 11, 13, 15, 16, 21, 23, 29, 33, 37, 38, 40],
    hops: {
      11: ['thread', 'Hands off to the inference thread'],
      38: ['thread', 'Back to the HTTP thread'],
    },
  },
  vllm: {
    page: 'vllm.html',
    stages: { arrive: [2, 10], wait: [11, 19], think: [20, 37], speak: [38, 45] },
    key: [2, 4, 6, 7, 11, 14, 16, 18, 19, 20, 21, 28, 33, 36, 40, 42, 45],
    hops: {
      15: ['process', 'Crosses into the EngineCore process over ZMQ'],
      41: ['process', 'Back to the API process over ZMQ'],
    },
  },
};

// 'engine:n' -> token. Used where the last identifier of fn is not a token that
// sits within 3 lines of the step's line at the pinned commit. Most tracer lines
// point at a function definition or call whose name differs from the last
// identifier of fn (a callee further down, a descriptive phrase, a dotted path),
// and a few default tokens ("n", "loop") are too weak to prove anything.
const CHECK_OVERRIDES = {
  // llama.cpp
  'llama-cpp:2': 'httplib::Server',
  'llama-cpp:24': 'n_layer',
  'llama-cpp:37': 'queue_results.send',
  'llama-cpp:38': 'server_response_reader::next',
  'llama-cpp:8': 'tokenize_input_prompts',                // line is the definition; llama_tokenize is called deeper
  'llama-cpp:17': 'add prompt tokens',                    // comment above the batch-fill loop
  'llama-cpp:21': 'init_batch',                           // line is the definition; find_slot is called inside
  'llama-cpp:25': 'build_attn',                           // line is the overload definition; build_attn_mha is called inside
  'llama-cpp:39': 'server_task_result_cmpl_partial::update', // line is the update() definition
  // vLLM
  'vllm:34': 'down_proj',
  'vllm:42': 'detokenizer.update',
  'vllm:2': 'uvicorn.Config',                             // creates the uvicorn server config
  'vllm:5': 'render_chat',                                // definition; parse_chat_messages_async is called inside
  'vllm:6': '_render_with_timeout',                       // awaited call that applies the template off the event loop
  'vllm:11': 'generate',                                  // AsyncLLM.generate definition
  'vllm:12': 'process_inputs',                            // definition
  'vllm:15': 'process_input_sockets',                     // definition of the input socket thread
  'vllm:19': 'WAITING',                                   // comment that opens the waiting-queue loop
  'vllm:22': 'SchedulerOutput(',                          // constructor call
  'vllm:23': 'execute_model',                             // definition
  'vllm:26': 'prepare_inputs',                            // call
  'vllm:27': 'prepare_attn',                              // call
  'vllm:28': 'set_forward_context',                       // context manager around the model call
  'vllm:30': 'forward',                                   // decoder layer forward definition
  'vllm:31': 'forward',                                   // Attention.forward definition
  'vllm:33': 'flash_attn_varlen_func',                    // call
  'vllm:36': '__call__',                                  // Sampler.__call__ definition
  'vllm:37': 'AsyncOutput',                               // constructor call
  'vllm:39': 'update_from_output',                        // definition
  'vllm:40': 'process_output_sockets',                    // definition of the output socket thread
  'vllm:43': 'queue.put',                                 // hands the output to generate()
  'vllm:45': 'yield f',                                   // the SSE data line
};

function defaultCheck(fn) {
  const ids = String(fn).split(/→|::|\.|\s+/).join(' ').match(/[A-Za-z_][A-Za-z0-9_]*/g);
  return ids ? ids[ids.length - 1] : String(fn);
}

async function readSteps(browser, id, spec) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(root, spec.page)).href);
  await page.waitForSelector('#tNext');
  const steps = [];
  for (let i = 0; i < 200; i++) {
    await page.evaluate(() => document.querySelector('#tNext').click());
    // Wait for the step counter to advance (some steps animate before updating).
    await page.waitForFunction(k => {
      const m = /STEP\s+(\d+)/.exec(document.querySelector("#tStep").textContent);
      return m && Number(m[1]) === k;
    }, { timeout: 10000 }, i + 1).catch(() => {});
    await new Promise(r => setTimeout(r, 60));
    const st = await page.evaluate(() => {
      const src = document.querySelector('.insp .src');
      return {
        step: document.querySelector('#tStep').textContent.trim(),
        name: document.querySelector('#tName').textContent.trim(),
        href: src ? src.getAttribute('href') : null,
      };
    });
    const m = /STEP\s+(\d+)\s*\/\s*(\d+)/.exec(st.step);
    if (!m) throw new Error(`${id}: unexpected #tStep "${st.step}"`);
    const n = Number(m[1]), total = Number(m[2]);
    if (n !== i + 1) throw new Error(`${id}: expected step ${i + 1}, saw ${n}`);
    steps[n] = { n, ...st };
    if (n === total) break;
  }
  await page.close();
  return steps;
}

function parseStep(id, s) {
  const sep = s.name.indexOf(' — ');
  if (sep < 0) throw new Error(`${id}:${s.n}: no " — " in "${s.name}"`);
  const title = s.name.slice(0, sep).trim();
  const fn = s.name.slice(sep + 3).trim();
  const m = /\/blob\/[0-9a-f]{40}\/(.+)#L(\d+)$/.exec(s.href || '');
  if (!m) throw new Error(`${id}:${s.n}: no source link in "${s.href}"`);
  return { title, fn, file: m[1], line: Number(m[2]) };
}

function render(id, spec, byStage) {
  const q = s => JSON.stringify(s);
  const out = [
    `// Generated by tools/export-steps.mjs from ${spec.page}. Do not edit by hand.`,
    `RT.addSteps(${q(id)}, {`,
  ];
  const stages = Object.keys(spec.stages);
  stages.forEach((stage, si) => {
    out.push(`  ${stage}: [`);
    byStage[stage].forEach((st, i) => {
      const parts = [
        `n: ${st.n}`, `title: ${q(st.title)}`, `fn: ${q(st.fn)}`,
        `file: ${q(st.file)}`, `line: ${st.line}`, `check: ${q(st.check)}`,
      ];
      if (st.key) parts.push('key: true');
      if (st.hop) parts.push(`hop: ${q(st.hop)}`, `hopText: ${q(st.hopText)}`);
      out.push(`    { ${parts.join(', ')} }${i < byStage[stage].length - 1 ? ',' : ''}`);
    });
    out.push(`  ]${si < stages.length - 1 ? ',' : ''}`);
  });
  out.push('});', '');
  return out.join('\n');
}

async function main() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    for (const [id, spec] of Object.entries(ENGINES)) {
      const steps = await readSteps(browser, id, spec);
      const byStage = {};
      for (const [stage, [from, to]] of Object.entries(spec.stages)) {
        byStage[stage] = [];
        for (let n = from; n <= to; n++) {
          const p = parseStep(id, steps[n]);
          const entry = { n, ...p, check: CHECK_OVERRIDES[`${id}:${n}`] || defaultCheck(p.fn) };
          if (spec.key.includes(n)) entry.key = true;
          if (spec.hops[n]) { entry.hop = spec.hops[n][0]; entry.hopText = spec.hops[n][1]; }
          byStage[stage].push(entry);
        }
      }
      const file = path.join(root, 'data', 'engines', `${id}.steps.js`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, render(id, spec, byStage));
      console.log(`${id}: ` + Object.entries(byStage).map(([s, l]) => `${s} ${l.length}`).join(', '));
    }
  } finally {
    await browser.close();
  }
}

await main();
