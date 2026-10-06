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

test('pickPair keeps the order the pair file fixes, whichever way the URL names it', () => {
  const c = loadContext(root, ['assets/compare/util.js']);
  c.RT.pairs = {};
  for (const id of ['a', 'b', 'c']) c.RT.registerEngine(eng(id));
  c.RT.registerPair({ ids: ['a', 'b'], verdict: { a: [], b: [] }, answers: {}, stageSummaries: {} });
  assert.deepEqual(c.RTU.pickPair('?a=b&b=a', c.RT), ['a', 'b']);
  assert.deepEqual(c.RTU.pickPair('?a=a&b=b', c.RT), ['a', 'b']);
  assert.deepEqual(c.RTU.pickPair('?a=c&b=a', c.RT), ['c', 'a']);
});

test('pickPair ignores a pair file naming an engine that is not registered', () => {
  const c = loadContext(root, ['assets/compare/util.js']);
  c.RT.pairs = {};
  c.RT.engines = {};
  for (const id of ['a', 'b', 'c']) c.RT.registerEngine(eng(id));
  c.RT.registerPair({ ids: ['b', 'ghost'], verdict: { a: [], b: [] }, answers: {}, stageSummaries: {} });
  assert.deepEqual(c.RTU.pickPair('', c.RT), ['a', 'b']);
  assert.deepEqual(c.RTU.pickPair('?a=zzz&b=c', c.RT), ['a', 'b']);
});

test('contrast is the WCAG ratio', () => {
  assert.equal(Math.round(RTU.contrast('#000000', '#ffffff')), 21);
  assert.equal(RTU.contrast('#777777', '#777777'), 1);
});

test('textColor darkens an engine colour until small text reads at 4.5 to 1', () => {
  const darker = RTU.textColor('#d9662a');
  assert.notEqual(darker, '#d9662a');
  assert.match(darker, /^#[0-9a-f]{6}$/);
  assert.ok(RTU.contrast(darker, '#f7f6f2') >= 4.5, darker);
  // still orange: red stays the strongest channel
  const [r, g, b] = [1, 3, 5].map(i => parseInt(darker.slice(i, i + 2), 16));
  assert.ok(r > g && g > b, darker);
});

test('textColor leaves a colour that already reads well untouched', () => {
  assert.equal(RTU.textColor('#2b54d0'), '#2b54d0');
  assert.equal(RTU.textColor('#121212'), '#121212');
});

test('textColor accepts short hex and falls back to ink for junk', () => {
  assert.ok(RTU.contrast(RTU.textColor('#f80'), '#f7f6f2') >= 4.5);
  assert.equal(RTU.textColor('red; background:url(x)'), '#121212');
});
