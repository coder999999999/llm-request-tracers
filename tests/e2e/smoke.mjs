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

const failures = [];
const fail = (where, msg) => failures.push(`${where}: ${msg}`);
let checks = 0;
function ok(cond, where, msg) { checks++; if (!cond) fail(where, msg); }

async function openPage(browser, { width, url, fake }) {
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
    for (const p of problems) fail(where, p);

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
