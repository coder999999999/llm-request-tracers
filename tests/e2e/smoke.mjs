// End-to-end smoke test: serves the repo over HTTP, drives the installed Chrome
// (puppeteer-core) and checks the start page at three widths, over http:// and
// file://. Run with: npm run test:e2e
//
// A fake third engine is added without touching production code: a request
// interceptor appends registration calls to the response body of data/compare.js,
// which loads after data/registry.js and before the engine files.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WIDTHS = [1440, 1024, 390];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4', '.vtt': 'text/vtt', '.json': 'application/json',
};

// Static server. A missing data/bench/*.js (benchmark results land in a later
// phase) answers 204, which a script tag accepts without logging an error.
function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const file = path.join(root, rel);
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) {
          if (/^\/data\/bench\/[^/]+\.js$/.test(rel)) { res.writeHead(204, { 'content-type': MIME['.js'] }).end(); return; }
          res.writeHead(404).end('not found'); return;
        }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const FAKE_ENGINE = `
;RT.registerEngine({
  id: 'ollama', name: 'Ollama', lang: 'Go', color: '#2f7d4f',
  repo: 'https://github.com/ollama/ollama', commit: '0000000000000000000000000000000000000000',
  tracer: 'ollama.html', shape: 'One process. A Go server runs the model through llama.cpp.'
});
RT.addSteps('ollama', {
  arrive: [{ title: 'Chat route', fn: 'Server.ChatHandler', file: 'server/routes.go', line: 1, check: 'ChatHandler', key: true }],
  wait: [{ title: 'Schedule a runner', fn: 'Scheduler.GetRunner', file: 'server/sched.go', line: 1, check: 'GetRunner', key: true }]
});
`;

// Synthetic bench results and pair annotations, injected the same way as the fake
// engine, so the charts can be checked before real results exist. Not measurements.
const FAKE_BENCH = {
  'llama-cpp': `RT.registerBench({ id: 'llama-cpp', run: { model: 'Test model', gpu: 'Test GPU' },
  levels: [1, 2, 4, 8, 16, 32, 64].map(function (u, i) { return { users: u, tok_s: { median: 40 + i * 70, min: 38 + i * 70, max: 44 + i * 70 }, ttft_ms: { median: 60 }, prefill_ms: { median: 38 } }; }),
  reuse: { cold_ttft_ms: { median: 1200 }, warm_ttft_ms: { median: 90 } },
  kvFull: [{ max_tokens: 256, tok_s: { median: 480 }, failed: 0 }, { max_tokens: 1024, tok_s: { median: 300 }, kv_retries: 7, failed: 2 }] });`,
  vllm: `RT.registerBench({ id: 'vllm', run: { model: 'Test model', gpu: 'Test GPU' },
  levels: [1, 2, 4, 8, 16, 32, 64].map(function (u, i) { return { users: u, tok_s: { median: 42 + i * 380, min: 40 + i * 380, max: 46 + i * 380 }, ttft_ms: { median: 55 }, queue_ms: { median: 4 }, prefill_ms: { median: 40 } }; }),
  reuse: { cold_ttft_ms: { median: 1100 }, warm_ttft_ms: { median: 40 } },
  kvFull: [{ max_tokens: 256, tok_s: { median: 2500 } }, { max_tokens: 1024, tok_s: { median: 2100 }, preemptions: 12 }] });`
};
const FAKE_PAIR = `
(function () {
  var p = RT.pairs['llama-cpp--vllm'];
  p.verdict = { a: ['Run it on one laptop'], b: ['Serve many people at once'] };
  p.annotations = {
    q1: [{ x: 64, metric: 'tok_s', kind: 'ratio', text: '{v}× at 64 users' }],
    q2: [{ source: 'reuse', metric: 'warm_ttft_ms', kind: 'ratio', text: 'Repeat takes {v}× the llama.cpp time' }],
    q4: [{ source: 'kvFull', x: 1024, metric: 'tok_s', kind: 'ratio', text: '{v}× at 1,024 tokens' }]
  };
})();
`;

const failures = [];
const fail = (where, msg) => failures.push(`${where}: ${msg}`);
let checks = 0;
function ok(cond, where, msg) { checks++; if (!cond) fail(where, msg); }

async function openPage(browser, { width, url, fake, bench }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = m.location().url || '';
    // file:// has no way to answer 204: the optional bench scripts log a failed load there.
    if (url.startsWith('file:') && /\/data\/bench\/[^/]+\.js$/.test(loc)) return;
    problems.push('console.error: ' + m.text() + ' ' + loc);
  });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)) {
      // Keep the run offline-safe and deterministic: system fonts only.
      req.respond({ status: 200, contentType: 'text/css', body: '' });
    } else if (bench && /\/data\/bench\/(llama-cpp|vllm)\.js(\?|$)/.test(u)) {
      req.respond({ status: 200, contentType: MIME['.js'], body: FAKE_BENCH[/\/bench\/([^./]+)\.js/.exec(u)[1]] });
    } else if (bench && /\/data\/pairs\/llama-cpp--vllm\.js(\?|$)/.test(u)) {
      const body = fs.readFileSync(path.join(root, 'data', 'pairs', 'llama-cpp--vllm.js'), 'utf8') + FAKE_PAIR;
      req.respond({ status: 200, contentType: MIME['.js'], body });
    } else if (fake && /\/data\/compare\.js(\?|$)/.test(u)) {
      const body = fs.readFileSync(path.join(root, 'data', 'compare.js'), 'utf8') + FAKE_ENGINE;
      req.respond({ status: 200, contentType: MIME['.js'], body });
    } else req.continue();
  });
  await page.goto(url, { waitUntil: 'load' });
  return { page, problems };
}

async function layoutChecks(browser, base, mode) {
  const texts = {};
  for (const width of WIDTHS) {
    const where = `${mode} ${width}`;
    const url = mode === 'http' ? base + '/index.html' : pathToFileURL(path.join(root, 'index.html')).href;
    const { page, problems } = await openPage(browser, { width, url });
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: window.innerWidth,
      chapters: document.querySelectorAll('.chapter').length,
      ids: ['chapters', 'every-stage', 'deep-dives', 'films', 'method'].filter(id => !document.getElementById(id)),
      rows: document.querySelectorAll('.stage-row').length,
      links: [...document.querySelectorAll('.qs a')].map(a => a.getAttribute('href')),
      picker: document.querySelectorAll('#picker select').length,
      text: document.body.innerText,
      h1: document.querySelector('.hero h1').textContent.trim(),
      staticQs: [...document.querySelectorAll('.qs b')].map(b => b.textContent),
      dataQs: window.RT.compare.questions.map(q => q.text),
    }));
    ok(JSON.stringify(m.staticQs) === JSON.stringify(m.dataQs), where, 'hero question list differs from data/compare.js');
    ok(m.sw <= m.iw && m.bw <= m.iw, where, `horizontal overflow (scrollWidth ${m.sw}, body ${m.bw}, window ${m.iw})`);
    ok(m.chapters === 4, where, `expected 4 .chapter, found ${m.chapters}`);
    ok(m.ids.length === 0, where, `missing containers: ${m.ids.join(', ')}`);
    ok(m.rows >= 5, where, `expected 4 stage rows and a General row, found ${m.rows}`);
    ok(JSON.stringify(m.links) === JSON.stringify(['#q1', '#q2', '#q3', '#q4']), where, `question links: ${m.links}`);
    ok(m.picker === 0, where, 'picker should not appear with two engines');
    ok(m.h1.endsWith('vLLM?'), where, 'H1 should end with a question mark, got "' + m.h1 + '"');
    for (const p of problems) fail(where, p);

    // Text inside the chapter graphics must render at 11px or more. On a phone the
    // charts and the boundary diagram are redrawn 380 wide so this holds at 390.
    const tiny = await page.evaluate(() => [...document.querySelectorAll('.chapter svg text')]
      .filter(t => t.getClientRects().length > 0)
      .map(t => ({ text: t.textContent.trim().slice(0, 40), px: parseFloat(getComputedStyle(t).fontSize) * t.getScreenCTM().a }))
      .filter(x => x.px < 11));
    ok(tiny.length === 0, where, 'svg text under 11px: ' + tiny.slice(0, 4).map(x => x.text + ' ' + x.px.toFixed(1)).join('; '));
    const vb = await page.evaluate(() => document.querySelector('#q3 figure svg').getAttribute('viewBox'));
    ok(vb === (width < 600 ? '0 0 380 ' : '0 0 760 ') + vb.split(' ')[3], where, 'boundary diagram viewBox is ' + vb);

    // The pinned track is vertical at 1100px and up, a strip per chapter below.
    const vis = await page.evaluate(() => {
      const shown = el => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
      return {
        aside: shown(document.querySelector('#q1 aside.track svg')),
        strip: shown(document.querySelector('#q1 .track-strip svg')),
        strips: document.querySelectorAll('.chapter .track-strip').length,
      };
    });
    ok(vis.strips === 4, where, `expected a strip in each chapter, found ${vis.strips}`);
    ok(vis.aside === (width >= 1100), where, `vertical track visible=${vis.aside} at ${width}`);
    ok(vis.strip === (width < 1100), where, `horizontal strip visible=${vis.strip} at ${width}`);

    texts[width] = m.text;
    if (width === 1440 && mode === 'http') await interactionChecks(page, where);
    await page.close();
  }
  return texts;
}

const activeStage = (page, q) => page.evaluate(id => {
  const g = document.querySelector('#' + id + ' aside.track [data-active="true"]');
  return g && g.getAttribute('data-stage');
}, q);

async function interactionChecks(page, where) {
  // Scrolling a chapter into view highlights its stage in that chapter's track.
  await page.evaluate(() => document.getElementById('q2').scrollIntoView({ behavior: 'instant' }));
  await page.waitForFunction(() => {
    const g = document.querySelector('#q2 aside.track [data-active="true"]');
    return g && g.getAttribute('data-stage') === 'think';
  }, { timeout: 3000 }).catch(() => {});
  ok(await activeStage(page, 'q2') === 'think', where, `q2 track active stage is ${await activeStage(page, 'q2')}, expected think`);
  await page.evaluate(() => document.getElementById('q1').scrollIntoView({ behavior: 'instant' }));
  await page.waitForFunction(() => {
    const g = document.querySelector('#q1 aside.track [data-active="true"]');
    return g && g.getAttribute('data-stage') === 'wait';
  }, { timeout: 3000 }).catch(() => {});
  ok(await activeStage(page, 'q1') === 'wait', where, `q1 track active stage is ${await activeStage(page, 'q1')}, expected wait`);

  // Q3 spans two stages: scrolling to the second one moves the highlight.
  const second = await page.evaluate(() => {
    const h = document.querySelectorAll('#q3 .stage-h');
    if (h.length < 2) return false;
    window.scrollTo({ top: h[1].getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.4, behavior: 'instant' });
    return true;
  });
  ok(second, where, 'q3 should have two stage headings');
  await page.waitForFunction(() => {
    const g = document.querySelector('#q3 aside.track [data-active="true"]');
    return g && g.getAttribute('data-stage') === 'speak';
  }, { timeout: 3000 }).catch(() => {});
  ok(await activeStage(page, 'q3') === 'speak', where, `q3 track active stage is ${await activeStage(page, 'q3')}, expected speak`);

  // Clicking a stage in the track opens that stage in Every stage.
  await page.evaluate(() => document.getElementById('q1').scrollIntoView({ behavior: 'instant' }));
  await page.evaluate(() => document.querySelector('#q1 aside.track [data-stage="think"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForFunction(() => { const t = document.getElementById('stage-think').getBoundingClientRect().top; return t >= -4 && t < window.innerHeight / 2; }, { timeout: 4000 }).catch(() => {});
  const clicked = await page.evaluate(() => {
    const row = document.getElementById('stage-think');
    const r = row.getBoundingClientRect();
    return { open: row.querySelector('details').open, top: r.top, h: window.innerHeight };
  });
  ok(clicked.open, where, 'track click should open the stage details');
  ok(clicked.top >= -4 && clicked.top < clicked.h / 2, where, `stage row not scrolled into view (top ${clicked.top})`);

  // The Episode 1 player opens from the hero link.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.evaluate(() => document.querySelector('[data-play]').click());
  ok(await page.evaluate(() => document.getElementById('player').open), where, 'player dialog did not open');
  await page.evaluate(() => document.getElementById('player').close());
}

// With bench results and pair annotations present, every chart draws and its text
// stays at 11px or more on a phone. Both URL orders show the same verdict.
async function chartChecks(browser, base) {
  for (const width of [390, 1440]) {
    const where = 'http charts ' + width;
    const { page, problems } = await openPage(browser, { width, url: base + '/index.html', bench: true });
    const m = await page.evaluate(() => ({
      figures: [...document.querySelectorAll('#chapters figure svg')].map(s => s.getAttribute('viewBox')),
      empty: document.querySelectorAll('#chapters figure .empty').length,
      text: document.getElementById('chapters').innerText,
      verdict: document.getElementById('verdict').innerText,
      sw: document.documentElement.scrollWidth, iw: window.innerWidth,
      wide: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && e.getClientRects().length).slice(0, 4)
        .map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)),
      tiny: [...document.querySelectorAll('.chapter svg text')].filter(t => t.getClientRects().length > 0)
        .map(t => ({ text: t.textContent.trim().slice(0, 40), px: parseFloat(getComputedStyle(t).fontSize) * t.getScreenCTM().a }))
        .filter(x => x.px < 11),
    }));
    ok(m.figures.length === 4 && m.empty === 0, where, 'expected four drawn figures, got ' + m.figures.length + ' (empty ' + m.empty + ')');
    ok(m.figures.every(v => v.startsWith(width < 600 ? '0 0 380 ' : '0 0 760 ')), where, 'viewBoxes ' + m.figures.join(' | '));
    ok(m.text.includes('× at 64 users'), where, 'throughput annotation missing');
    ok(m.text.includes('Repeat takes') && m.text.includes('× at 1,024 tokens'), where, 'reuse or kvFull annotation missing');
    ok(m.verdict.includes('Reach for llama.cpp if'), where, 'verdict missing');
    ok(m.tiny.length === 0, where, 'svg text under 11px: ' + m.tiny.slice(0, 4).map(x => x.text + ' ' + x.px.toFixed(1)).join('; '));
    ok(m.sw <= m.iw, where, 'horizontal overflow (' + m.sw + ' > ' + m.iw + '): ' + m.wide.join('; '));
    for (const p of problems) fail(where, p);
    await page.close();
  }
  const where = 'http reversed pair with verdict';
  const grab = async (query) => {
    const { page } = await openPage(browser, { width: 1440, url: base + '/index.html' + query, bench: true });
    const out = await page.evaluate(() => document.getElementById('verdict').innerHTML + document.getElementById('chapters').innerHTML);
    await page.close();
    return out;
  };
  ok(await grab('?a=llama-cpp&b=vllm') === await grab('?a=vllm&b=llama-cpp'), where, 'verdict or annotations flip when the URL pair is reversed');
}

// The URL picks the pair; the pair file fixes the order, so naming it the other way
// round must render exactly the same page.
async function reversedPairChecks(browser, base) {
  const where = 'http reversed pair';
  const grab = async (query) => {
    const { page, problems } = await openPage(browser, { width: 1440, url: base + '/index.html' + query });
    const out = await page.evaluate(() => ({
      h1: document.querySelector('.hero h1').textContent,
      verdict: document.getElementById('verdict').innerHTML,
      chapters: document.getElementById('chapters').innerHTML,
      rows: document.getElementById('every-stage-rows').innerHTML,
    }));
    for (const p of problems) fail(where, p);
    await page.close();
    return out;
  };
  const normal = await grab('?a=llama-cpp&b=vllm');
  const reversed = await grab('?a=vllm&b=llama-cpp');
  for (const key of Object.keys(normal)) ok(normal[key] === reversed[key], where, key + ' differs when the URL names the pair the other way round');
  ok(reversed.h1.indexOf('llama.cpp') >= 0 && reversed.h1.indexOf('llama.cpp') < reversed.h1.indexOf('vLLM'), where, 'H1 should keep the pair file order, got ' + reversed.h1);
}

// Crossing the 600px line redraws the boundary diagram at the other width, and
// keeps a code path the reader had opened.
async function resizeChecks(browser, base) {
  const where = 'http resize';
  const { page, problems } = await openPage(browser, { width: 1440, url: base + '/index.html' });
  const vb = () => page.evaluate(() => document.querySelector('#q3 figure svg').getAttribute('viewBox').split(' ')[2]);
  ok(await vb() === '760', where, 'wide viewBox should be 760');
  await page.evaluate(() => { document.querySelector('#q3 .path details').open = true; });
  await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 1 });
  await page.waitForFunction(() => document.querySelector('#q3 figure svg').getAttribute('viewBox').split(' ')[2] === '380', { timeout: 3000 }).catch(() => {});
  ok(await vb() === '380', where, 'narrow viewBox should be 380 after resizing to 390');
  ok(await page.evaluate(() => document.querySelector('#q3 .path details').open), where, 'an opened code path should stay open');
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.waitForFunction(() => document.querySelector('#q3 figure svg').getAttribute('viewBox').split(' ')[2] === '760', { timeout: 3000 }).catch(() => {});
  ok(await vb() === '760', where, 'wide viewBox should return to 760');
  for (const p of problems) fail(where, p);
  await page.close();
}

async function fakeEngineChecks(browser, base) {
  const where = 'http fake engine';
  const { page, problems } = await openPage(browser, { width: 1440, url: base + '/index.html?a=ollama&b=vllm', fake: true });
  const m = await page.evaluate(() => ({
    selects: [...document.querySelectorAll('#picker select')].map(s => s.options.length),
    text: document.body.innerText,
    sw: document.documentElement.scrollWidth, iw: window.innerWidth,
    chapters: document.querySelectorAll('.chapter').length,
    h1: document.querySelector('h1').textContent,
  }));
  ok(m.selects.length === 2 && m.selects.every(n => n === 3), where, `picker should have two selects of 3 options, got ${JSON.stringify(m.selects)}`);
  ok(/No write-up for this pair yet/.test(m.text), where, 'missing "No write-up for this pair yet"');
  ok(/Not covered yet/.test(m.text), where, 'missing "Not covered yet"');
  ok(/ollama/i.test(m.h1), where, `H1 should name the picked engine, got "${m.h1}"`);
  ok(m.chapters === 4 && m.sw <= m.iw, where, 'layout broke with a third engine');

  // Changing a select re-renders and updates the URL.
  await page.select('#picker select:first-of-type', 'llama-cpp');
  await new Promise(r => setTimeout(r, 200));
  const after = await page.evaluate(() => ({ search: location.search, text: document.body.innerText }));
  ok(/a=llama-cpp/.test(after.search) && /b=vllm/.test(after.search), where, `URL after change: ${after.search}`);
  ok(!/No write-up for this pair yet/.test(after.text), where, 'write-up should return for the llama.cpp and vLLM pair');
  for (const p of problems) fail(where, p);
  await page.close();
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const http_ = await layoutChecks(browser, base, 'http');
  const file_ = await layoutChecks(browser, base, 'file');
  for (const w of WIDTHS) ok(http_[w] === file_[w], `width ${w}`, 'body text differs between http and file://');
  await fakeEngineChecks(browser, base);
  await reversedPairChecks(browser, base);
  await chartChecks(browser, base);
  await resizeChecks(browser, base);
} catch (e) {
  fail('run', e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`FAIL: ${failures.length} problem(s) in ${checks} checks`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log(`PASS: ${checks} checks`);
