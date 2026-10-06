import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteData } from '../tools/load-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const minimal = (over = {}) => ({
  id: 'x', name: 'X', color: '#000000',
  repo: 'https://example.invalid/x', commit: 'abc123',
  tracer: 'x.html', shape: 'One process.', features: {},
  ...over,
});
const goodStep = (over = {}) => ({
  title: 'Do it', fn: 'do_it', file: 'src/a.c', line: 1, check: 'do_it(', ...over,
});

test('valid engine registers with no errors', () => {
  const RT = loadSiteData(root);
  RT.registerEngine(minimal());
  assert.deepEqual(RT.errors, []);
  assert.equal(RT.engines.x.name, 'X');
  assert.deepEqual(RT.validateEngine(minimal()), []);
});

test('unknown stage id in steps is reported', () => {
  const RT = loadSiteData(root);
  RT.addSteps('x', { nap: [goodStep()] });
  assert.ok(RT.errors.some(e => e.includes('unknown stage "nap"')), RT.errors.join('\n'));
});

test('feature key not in catalogue is reported', () => {
  const RT = loadSiteData(root);
  RT.registerEngine(minimal({ features: { flux: { value: 'v', file: 'a', line: 1 } } }));
  assert.ok(RT.errors.some(e => e.includes('unknown feature "flux"')), RT.errors.join('\n'));
});

test('step without check token is reported', () => {
  const RT = loadSiteData(root);
  const { check, ...noCheck } = goodStep();
  RT.registerEngine(minimal({ steps: { wait: [noCheck] } }));
  assert.ok(RT.errors.some(e => e.includes('missing check')), RT.errors.join('\n'));
});

test('invalid registrations never throw', () => {
  const RT = loadSiteData(root);
  assert.doesNotThrow(() => RT.registerEngine(null));
  assert.doesNotThrow(() => RT.registerEngine({}));
  assert.doesNotThrow(() => RT.registerPair({}));
  assert.doesNotThrow(() => RT.registerBench(undefined));
  assert.doesNotThrow(() => RT.addSteps('x', null));
  assert.ok(RT.errors.length >= 5);
});

test('addSteps before registerEngine merges into the engine', () => {
  const RT = loadSiteData(root);
  RT.addSteps('x', { wait: [goodStep()] });
  RT.registerEngine(minimal());
  assert.deepEqual(RT.errors, []);
  assert.equal(RT.engines.x.steps.wait.length, 1);
});

test('addSteps after registerEngine merges into the engine', () => {
  const RT = loadSiteData(root);
  RT.registerEngine(minimal({ steps: { arrive: [goodStep({ title: 'In' })] } }));
  RT.addSteps('x', { wait: [goodStep()] });
  assert.deepEqual(RT.errors, []);
  assert.equal(RT.engines.x.steps.arrive.length, 1);
  assert.equal(RT.engines.x.steps.wait.length, 1);
});

test('pairs and bench register by key', () => {
  const RT = loadSiteData(root);
  RT.registerPair({ ids: ['a', 'b'], verdict: { a: [], b: [] }, answers: {}, stageSummaries: {} });
  RT.registerBench({ id: 'a' });
  assert.deepEqual(RT.errors, []);
  assert.ok(RT.pairs['a--b']);
  assert.ok(RT.bench.a);
});

test('compare.js defines 4 stages and 4 questions', () => {
  const RT = loadSiteData(root);
  assert.deepEqual(RT.compare.stages.map(s => s.id), ['arrive', 'wait', 'think', 'speak']);
  assert.equal(RT.compare.questions.length, 4);
  assert.deepEqual(RT.compare.questions.map(q => q.chart), ['throughput', 'reuse', 'boundaries', 'kvFull']);
  assert.equal(RT.compare.features.length, 14);
});

test('loadSiteData tolerates missing data directories', () => {
  assert.doesNotThrow(() => loadSiteData(root));
});
