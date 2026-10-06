import test from 'node:test';
import assert from 'node:assert/strict';
import { rawURL, checkRef, refsFromRT } from '../tools/check-sources.mjs';

const E = { repo: 'https://github.com/ggml-org/llama.cpp', commit: 'abc123' };
const file = ['a', 'b', '  ctx_http.post("/v1/chat/completions"', 'd', 'e', 'f', 'g'].join('\n');

test('rawURL maps a GitHub repo URL to raw.githubusercontent.com at the commit', () =>
  assert.equal(rawURL(E, 'tools/server/server.cpp'),
    'https://raw.githubusercontent.com/ggml-org/llama.cpp/abc123/tools/server/server.cpp'));

test('rawURL tolerates a trailing slash and .git suffix', () =>
  assert.equal(rawURL({ repo: 'https://github.com/vllm-project/vllm.git/', commit: 'c1' }, 'a/b.py'),
    'https://raw.githubusercontent.com/vllm-project/vllm/c1/a/b.py'));

test('passes when check token is within ±3 lines', async () =>
  assert.equal((await checkRef({ engine: E, file: 'x.cpp', line: 5, check: '/v1/chat/completions' }, async () => file)).ok, true));

test('fails when token is 4+ lines away', async () =>
  assert.equal((await checkRef({ engine: E, file: 'x.cpp', line: 7, check: 'ctx_http' }, async () => file)).ok, false));

test('a 404 is a miss with the URL, not a throw', async () => {
  const r = await checkRef({ engine: E, file: 'gone.cpp', line: 1, check: 'x' }, async () => null);
  assert.equal(r.ok, false); assert.match(r.reason, /404/); assert.match(r.url, /gone\.cpp$/);
});

test('a fetch error is a miss, not a throw', async () => {
  const r = await checkRef({ engine: E, file: 'x.cpp', line: 1, check: 'x' }, async () => { throw new Error('boom'); });
  assert.equal(r.ok, false); assert.match(r.reason, /fetch failed: boom/); assert.match(r.url, /x\.cpp$/);
});

test('refsFromRT collects steps and features, and reports features missing file/line/check', () => {
  const RT = { engines: { llamacpp: {
    ...E,
    steps: { route: [{ n: 1, title: 't', fn: 'f', file: 'a.cpp', line: 3, check: 'f' }] },
    features: {
      good: { value: 'yes', file: 'b.cpp', line: 9, check: 'g' },
      noLine: { value: 'yes', file: 'b.cpp', check: 'g' },
      noCheck: { value: 'no', file: 'b.cpp', line: 2 },
    },
  } } };
  const { refs, missing } = refsFromRT(RT);
  assert.deepEqual(refs.map(r => r.file), ['a.cpp', 'b.cpp']);
  assert.equal(refs[0].engineId, 'llamacpp');
  assert.equal(missing.length, 2);
  assert.match(missing[0], /llamacpp/); assert.match(missing[0], /noLine/);
  assert.match(missing[1], /noCheck/);
});
