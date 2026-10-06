import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../tools/load-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = loadContext(root, ['assets/compare/util.js', 'assets/compare/stage-times.js', 'assets/compare/chart.js']);
const RTC = ctx.RTC;

const twoSeries = {
  series: [
    { label: 'llama.cpp', color: '#d9662a', points: [[1, 40, 38, 42], [32, 480, 470, 490], [64, 495, 490, 500]] },
    { label: 'vLLM', color: '#2b54d0', points: [[1, 42, 40, 44], [32, 1800, 1750, 1850], [64, 2700, 2650, 2760]] },
  ],
  xTicks: [1, 32, 64],
  xLabel: 'concurrent users',
  yLabel: 'tokens per second',
  annotations: [{ x: 64, y: 1600, text: '5.5× at 64 users' }],
  ariaLabel: 'Throughput by concurrent users',
};

test('chart has direct end labels and ≤4 gridlines', () => {
  const svg = RTC.lineChart(twoSeries);
  assert.match(svg, />vLLM</);
  assert.match(svg, />llama\.cpp</);
  assert.ok((svg.match(/class="grid"/g) || []).length <= 4);
  assert.match(svg, /<table class="sr-only"/);
});

// The brief's regex left the parentheses unescaped, which would be a group, not
// literal text. They are escaped here so the exact title text is checked.
test('points are focusable and show the repeat range', () =>
  assert.match(RTC.lineChart(twoSeries),
    /<circle[^>]*tabindex="0"[^>]*><title>vLLM, 64 users: 2,700 \(range 2,650–2,760\)<\/title>/));

test('hidden table follows the svg and lists every point', () => {
  const out = RTC.lineChart(twoSeries);
  assert.ok(out.indexOf('</svg>') < out.indexOf('<table class="sr-only"'));
  const body = out.match(/<tbody>[\s\S]*<\/tbody>/)[0];
  assert.equal((body.match(/<tr>/g) || []).length, 6);
});

test('annotation text is drawn and escaped', () => {
  const svg = RTC.lineChart({ ...twoSeries, annotations: [{ x: 64, y: 1600, text: 'a <b> & c' }] });
  assert.match(svg, /a &lt;b&gt; &amp; c/);
  assert.doesNotMatch(svg, /<b>/);
});

test('few gridlines even for large values, and flat data still draws', () => {
  const big = RTC.lineChart({ ...twoSeries, series: [{ label: 'x', color: '#000', points: [[1, 0], [2, 123456]] }] });
  assert.ok((big.match(/class="grid"/g) || []).length <= 4);
  const flat = RTC.lineChart({ ...twoSeries, series: [{ label: 'x', color: '#000', points: [[1, 0], [2, 0]] }] });
  assert.match(flat, /<svg/);
});

test('empty series list does not throw', () =>
  assert.match(RTC.lineChart({ series: [], ariaLabel: 'none' }), /<svg/));

test('point without a range has a title with no range', () => {
  const svg = RTC.lineChart({ ...twoSeries, series: [{ label: 'x', color: '#000', points: [[1, 5], [2, 8]] }] });
  assert.match(svg, /<title>x, 2 users: 8<\/title>/);
});

test('barPairs prints values at bar ends and has a hidden table', () => {
  const out = RTC.barPairs({
    groups: [
      { label: 'First message', values: [{ label: 'llama.cpp', color: '#d9662a', v: 1200 }, { label: 'vLLM', color: '#2b54d0', v: 1100 }] },
      { label: 'Repeat with the same system prompt', values: [{ label: 'llama.cpp', color: '#d9662a', v: 90 }, { label: 'vLLM', color: '#2b54d0', v: 40 }] },
    ],
    unit: 'ms', ariaLabel: 'Time to first token',
  });
  assert.match(out, />1,200 ms</);
  assert.match(out, />40 ms</);
  assert.match(out, />First message</);
  assert.match(out, /<table class="sr-only"/);
});
