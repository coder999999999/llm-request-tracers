import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../tools/load-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = loadContext(root, ['assets/compare/util.js']);
const RTU = ctx.RTU;
const RT = ctx.RT;

const eng = (id) => ({
  id, name: id, color: '#000000', repo: 'https://example.invalid/' + id,
  commit: 'c', tracer: id + '.html', shape: 's', features: {},
});
RT.registerEngine(eng('llama-cpp'));
RT.registerEngine(eng('vllm'));
RT.registerEngine(eng('other'));
const rtWithTwo = RT;

test('srcURL builds a blob link at the pinned commit', () =>
  assert.equal(
    RTU.srcURL({ repo: 'https://github.com/vllm-project/vllm', commit: '1388' }, 'vllm/v1/engine/core.py', 526),
    'https://github.com/vllm-project/vllm/blob/1388/vllm/v1/engine/core.py#L526'));

test('shortPath keeps the basename', () =>
  assert.equal(RTU.shortPath('tools/server/server-queue.cpp'), 'server-queue.cpp'));

test('esc escapes HTML', () =>
  assert.equal(RTU.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;'));

test('pickPair falls back to the first engines when no pair is registered', () =>
  assert.deepEqual(RTU.pickPair('?a=ollama&b=vllm', rtWithTwo), ['llama-cpp', 'vllm']));

test('pickPair honours two registered, different engines', () => {
  assert.deepEqual(RTU.pickPair('?a=vllm&b=other', rtWithTwo), ['vllm', 'other']);
  assert.deepEqual(RTU.pickPair('?a=vllm&b=vllm', rtWithTwo), ['llama-cpp', 'vllm']);
});

test('pickPair falls back to the first registered pair', () => {
  const c = loadContext(root, ['assets/compare/util.js']);
  c.RT.pairs = {};  // the site's own pair file is loaded too; this test needs the first one registered here
  for (const id of ['a', 'b', 'c']) c.RT.registerEngine(eng(id));
  c.RT.registerPair({ ids: ['b', 'c'], verdict: { a: [], b: [] }, answers: {}, stageSummaries: {} });
  assert.deepEqual(c.RTU.pickPair('', c.RT), ['b', 'c']);
  assert.deepEqual(c.RTU.pickPair('?a=zzz&b=c', c.RT), ['b', 'c']);
  assert.deepEqual(c.RTU.pickPair('?a=c&b=a', c.RT), ['c', 'a']);
});

test('fmtMs', () => {
  assert.equal(RTU.fmtMs(9), '9 ms');
  assert.equal(RTU.fmtMs(1234), '1.2 s');
  assert.equal(RTU.fmtMs(1000), '1.0 s');
});
