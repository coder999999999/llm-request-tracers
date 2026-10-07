import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteData } from '../tools/load-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RT = loadSiteData(root);

// The design rules ban arrows and middle dots in prose. Function names (fn) are
// code, copied verbatim from the tracers, and are not linted.
const BAD = /→|↓| · /;

function prose() {
  const out = [];
  for (const e of Object.values(RT.engines)) {
    for (const [stage, list] of Object.entries(e.steps)) {
      list.forEach((s, i) => {
        out.push([`${e.id} ${stage}[${i}] title`, s.title]);
        if (s.hopText) out.push([`${e.id} ${stage}[${i}] hopText`, s.hopText]);
      });
    }
    for (const [k, f] of Object.entries(e.features)) out.push([`${e.id} feature ${k}`, f.value]);
  }
  for (const [key, p] of Object.entries(RT.pairs)) {
    for (const [stage, per] of Object.entries(p.stageSummaries || {})) {
      for (const [id, text] of Object.entries(per)) out.push([`${key} stageSummaries.${stage}.${id}`, text]);
    }
    for (const [q, text] of Object.entries(p.answers || {})) out.push([`${key} answers.${q}`, text]);
    if (p.headline) out.push([`${key} headline`, p.headline]);
    for (const [q, t] of Object.entries(p.teasers || {})) {
      out.push([`${key} teasers.${q}`, t.text]);
      if (t.unit) out.push([`${key} teasers.${q} unit`, t.unit]);
    }
    if (p.verdict) {
      const v = [].concat(p.verdict.a || [], p.verdict.b || []);
      v.forEach((t, i) => out.push([`${key} verdict[${i}]`, t]));
    }
    for (const [q, list] of Object.entries(p.annotations || {})) {
      (list || []).forEach((a, i) => out.push([`${key} annotations.${q}[${i}]`, a.text]));
    }
  }
  return out;
}

test('prose in data files has no arrows or middle dots', () => {
  const found = prose();
  assert.ok(found.length > 100, 'expected to lint steps, features and pair text');
  const bad = found.filter(([, text]) => BAD.test(String(text))).map(([where, text]) => `${where}: ${text}`);
  assert.deepEqual(bad, []);
});

test('the lint reads pair prose', () => {
  const where = prose().map(([w]) => w);
  assert.ok(where.some(w => w.includes('answers.q3')));
  assert.ok(where.some(w => w.includes('stageSummaries.wait.vllm')));
});
