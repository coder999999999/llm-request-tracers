// End-to-end smoke test: serves the repo over HTTP, drives the installed Chrome
// (puppeteer-core) and checks the comparison page (index.html) and the tracers page
// (tracers.html) at three widths, over http:// and file://. Run with: npm run test:e2e
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

async function openPage(browser, { width, url, fake, bench, realFonts }) {
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
    if (!realFonts && /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)) {
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
      ids: ['chapters', 'method'].filter(id => !document.getElementById(id)),
      moved: document.querySelectorAll('#every-stage, #deep-dives, .chapter .paths, .chapter > div > .facts, .chapter aside').length,
      codeLinks: [...document.querySelectorAll('.chapter .links a[href^="tracers.html"]')].map(a => a.getAttribute('href')),
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
    ok(m.moved === 0, where, 'code paths, feature tables or the stage track are still on the comparison page');
    ok(JSON.stringify(m.codeLinks) === JSON.stringify(['tracers.html#stage-wait', 'tracers.html#stage-think', 'tracers.html#stage-arrive', 'tracers.html#stage-speak', 'tracers.html#stage-think']),
      where, 'chapter code links: ' + m.codeLinks.join(' '));
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

    texts[width] = m.text;
    await page.close();
  }
  return texts;
}

// tracers.html: the tracer cards, the stage track and every stage, at each width.
async function tracersLayoutChecks(browser, base, mode) {
  const texts = {};
  for (const width of WIDTHS) {
    const where = `${mode} tracers ${width}`;
    const url = mode === 'http' ? base + '/tracers.html' : pathToFileURL(path.join(root, 'tracers.html')).href;
    const { page, problems } = await openPage(browser, { width, url });
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, iw: window.innerWidth,
      ids: ['deep-dives', 'every-stage', 'stage-track', 'every-stage-rows'].filter(id => !document.getElementById(id)),
      rows: document.querySelectorAll('.stage-row').length,
      cards: document.querySelectorAll('.tool').length,
      track: !!document.querySelector('#stage-track svg [data-stage="think"]'),
      current: (document.querySelector('.top nav a[aria-current="page"]') || {}).textContent,
      tiny: [...document.querySelectorAll('#stage-track svg text')].filter(t => t.getClientRects().length > 0)
        .map(t => ({ text: t.textContent.trim().slice(0, 40), px: parseFloat(getComputedStyle(t).fontSize) * t.getScreenCTM().a }))
        .filter(x => x.px < 11),
      text: document.body.innerText,
    }));
    ok(m.sw <= m.iw, where, `horizontal overflow (scrollWidth ${m.sw}, window ${m.iw})`);
    ok(m.ids.length === 0, where, `missing containers: ${m.ids.join(', ')}`);
    ok(m.rows >= 5, where, `expected 4 stage rows and a General row, found ${m.rows}`);
    ok(m.cards === 3, where, `expected 3 tracer cards, found ${m.cards}`);
    ok(m.track, where, 'stage track not drawn');
    ok(m.current === 'Tracers and code', where, 'nav should mark Tracers and code as the current page, got ' + m.current);
    ok(m.tiny.length === 0, where, 'stage track text under 11px: ' + m.tiny.slice(0, 4).map(x => x.text + ' ' + x.px.toFixed(1)).join('; '));
    for (const p of problems) fail(where, p);
    texts[width] = m.text;
    if (width === 1440 && mode === 'http') await tracersInteractionChecks(page, base, where);
    await page.close();
  }
  return texts;
}

const stageInView = (page, id) => page.evaluate(sid => {
  const row = document.getElementById('stage-' + sid);
  const r = row.getBoundingClientRect();
  return { open: row.querySelector('details').open, top: r.top, h: window.innerHeight };
}, id);

async function tracersInteractionChecks(page, base, where) {
  // Clicking a stage in the track opens that stage's code path and scrolls to it.
  await page.evaluate(() => document.querySelector('#stage-track [data-stage="think"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForFunction(() => { const t = document.getElementById('stage-think').getBoundingClientRect().top; return t >= -4 && t < window.innerHeight / 2; }, { timeout: 4000 }).catch(() => {});
  const clicked = await stageInView(page, 'think');
  ok(clicked.open, where, 'track click should open the stage details');
  ok(clicked.top >= -4 && clicked.top < clicked.h / 2, where, `stage row not scrolled into view (top ${clicked.top})`);
  await srcTipChecks(page, where);

  // A chapter's code link (tracers.html#stage-wait) lands on that stage, opened.
  await page.goto(base + '/tracers.html#stage-wait', { waitUntil: 'load' });
  await page.waitForFunction(() => { const t = document.getElementById('stage-wait').getBoundingClientRect().top; return t >= -4 && t < window.innerHeight / 2; }, { timeout: 4000 }).catch(() => {});
  const linked = await stageInView(page, 'wait');
  ok(linked.open, where, '#stage-wait should open the Wait code path');
  ok(linked.top >= -4 && linked.top < linked.h / 2, where, `#stage-wait not scrolled into view (top ${linked.top})`);
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
    await tooltipChecks(page, where);
    await page.close();
  }
  const where = 'http reversed pair with verdict';
  const grab = async (query) => {
    const { page } = await openPage(browser, { width: 1440, url: base + '/index.html' + query, bench: true });
    // Links to tracers.html carry the URL's pair, so the query is left out of the comparison.
    const out = await page.evaluate(() => (document.getElementById('verdict').innerHTML + document.getElementById('chapters').innerHTML).replace(/\?a=[^"#]*/g, ''));
    await page.close();
    return out;
  };
  ok(await grab('?a=llama-cpp&b=vllm') === await grab('?a=vllm&b=llama-cpp'), where, 'verdict or annotations flip when the URL pair is reversed');
}

// Tooltips: a chart point (index.html) and a source link (tracers.html) each show
// their detail on keyboard focus (a keyboard Tab, so :focus-visible applies), the
// chart point also on mouse hover, and the native title is dropped so only one shows.
const tipText = page => page.evaluate(() => { const t = document.getElementById('tip'); return t && !t.hidden && t.getClientRects().length ? t.textContent : ''; });

async function srcTipChecks(page, where) {
  const tip = () => tipText(page);
  const src = await page.evaluate(() => { const d = document.querySelector('#every-stage details'); d.open = true; const a = d.querySelector('.src'); a.scrollIntoView({ behavior: 'instant', block: 'center' }); const prev = [...document.querySelectorAll('a[href], summary')]; const i = prev.indexOf(a); prev[i - 1].focus(); return a.getAttribute('data-tip'); });
  await page.keyboard.press('Tab');
  ok(await tip() === src && src, where, 'source link tooltip not shown on keyboard focus: "' + await tip() + '" vs "' + src + '"');
  await page.evaluate(() => document.activeElement.blur());
}

async function tooltipChecks(page, where) {
  const tip = () => tipText(page);
  await page.evaluate(() => { document.getElementById('q1').scrollIntoView({ behavior: 'instant' }); });
  // Focus the control just before the first chart point, then Tab onto the point.
  await page.evaluate(() => { const c = document.querySelector('#q1 figure circle[data-tip]'); c.focus(); c.blur(); });
  await page.keyboard.press('Tab');
  const onPoint = await page.evaluate(() => document.activeElement && document.activeElement.matches('circle[data-tip]') ? document.activeElement.getAttribute('data-tip') : null);
  ok(onPoint !== null, where, 'Tab did not land on a chart point');
  ok(onPoint !== null && await tip() === onPoint, where, 'chart point tooltip not shown on keyboard focus: "' + await tip() + '"');
  await page.keyboard.press('Escape');
  ok(await tip() === '', where, 'Escape should hide the tooltip');
  await page.evaluate(() => document.activeElement.blur());
  ok(await tip() === '', where, 'tooltip should hide when focus leaves');

  // Mouse hover on a chart point shows the same text, and the title is gone.
  const pt = await page.evaluate(() => { const c = document.querySelector('#q1 figure circle[data-tip]'); c.scrollIntoView({ behavior: 'instant', block: 'center' }); const r = c.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const top = document.elementFromPoint(x, y); return { x: x, y: y, tip: top && top.getAttribute('data-tip') }; });
  await page.mouse.move(pt.x, pt.y);
  ok(await tip() === pt.tip, where, 'chart point tooltip not shown on hover');
  ok(await page.evaluate((x, y) => { const c = document.elementFromPoint(x, y); return !!c && c.matches('circle[data-tip]') && !c.querySelector('title'); }, pt.x, pt.y), where, 'the hovered circle should have no <title> child');
  await page.mouse.move(2, 2);
}

// Fonts: the other runs block Google Fonts. This one lets them load at 390px, when
// the network can reach them, and checks that real glyph widths cause no overflow.
async function canReachFonts() {
  try {
    const res = await fetch('https://fonts.googleapis.com/css2?family=Archivo:wght@400', { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch { return false; }
}

async function realFontChecks(browser, base) {
  if (!await canReachFonts()) { console.log('NOTE: Google Fonts is not reachable; skipping the real-font 390px check.'); return; }
  for (const [file, rootsSel] of [['index.html', '.hero, .chapter, .which, #method'], ['tracers.html', '#deep-dives, #every-stage']]) {
    await realFontPage(browser, base, file, rootsSel);
  }
}

async function realFontPage(browser, base, file, rootsSel) {
  const where = 'http 390 real fonts ' + file;
  const { page, problems } = await openPage(browser, { width: 390, url: base + '/' + file, realFonts: true });
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() => [...document.fonts].some(f => f.family.replace(/"/g, '') === 'Archivo' && f.status === 'loaded'));
  if (!loaded) { console.log('NOTE: the Archivo web font did not load (no FontFace with status loaded); skipping the real-font 390px check.'); await page.close(); return; }
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
  const m = await page.evaluate(sel => {
    const out = [];
    const roots = [...document.querySelectorAll(sel)];
    roots.forEach(root => root.querySelectorAll('*').forEach(el => {
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') return;
      if (el.closest('.sr-only') || !el.getClientRects().length) return;
      const parent = el.parentElement;
      if (!parent) return;
      const r = el.getBoundingClientRect(), p = parent.getBoundingClientRect();
      if (r.right > p.right + 1 || r.left < p.left - 1) out.push(el.tagName.toLowerCase() + '.' + (el.getAttribute('class') || '') + ' in ' + parent.tagName.toLowerCase() + '.' + (parent.getAttribute('class') || '') + ' (' + Math.round(r.right) + ' > ' + Math.round(p.right) + ')');
    }));
    return { sw: document.documentElement.scrollWidth, out: out.slice(0, 6), n: out.length };
  }, rootsSel);
  ok(m.sw <= 390, where, 'horizontal overflow with real fonts: scrollWidth ' + m.sw);
  ok(m.n === 0, where, m.n + ' element(s) overflow their container: ' + m.out.join('; '));
  for (const p of problems) fail(where, p);
  await page.close();
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
      chapters: document.getElementById('chapters').innerHTML.replace(/\?a=[^"#]*/g, ''),
    }));
    for (const p of problems) fail(where, p);
    await page.close();
    const second = await openPage(browser, { width: 1440, url: base + '/tracers.html' + query });
    out.rows = await second.page.evaluate(() => document.getElementById('every-stage-rows').innerHTML);
    out.track = await second.page.evaluate(() => document.getElementById('stage-track').innerHTML);
    for (const p of second.problems) fail(where, p);
    await second.page.close();
    return out;
  };
  const normal = await grab('?a=llama-cpp&b=vllm');
  const reversed = await grab('?a=vllm&b=llama-cpp');
  for (const key of Object.keys(normal)) ok(normal[key] === reversed[key], where, key + ' differs when the URL names the pair the other way round');
  ok(reversed.h1.indexOf('llama.cpp') >= 0 && reversed.h1.indexOf('llama.cpp') < reversed.h1.indexOf('vLLM'), where, 'H1 should keep the pair file order, got ' + reversed.h1);
}

// Crossing the 600px line redraws the boundary diagram and the hero chart at the other width.
async function resizeChecks(browser, base) {
  const where = 'http resize';
  const { page, problems } = await openPage(browser, { width: 1440, url: base + '/index.html' });
  const vb = () => page.evaluate(() => document.querySelector('#q3 figure svg').getAttribute('viewBox').split(' ')[2]);
  ok(await vb() === '760', where, 'wide viewBox should be 760');
  await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 1 });
  await page.waitForFunction(() => document.querySelector('#q3 figure svg').getAttribute('viewBox').split(' ')[2] === '380', { timeout: 3000 }).catch(() => {});
  ok(await vb() === '380', where, 'narrow viewBox should be 380 after resizing to 390');
  ok(await page.evaluate(() => document.querySelector('#hero-chart svg').getAttribute('viewBox').split(' ')[2]) === '380', where, 'hero chart should redraw at 380');
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
  ok(/ollama/i.test(m.h1), where, `H1 should name the picked engine, got "${m.h1}"`);
  ok(m.chapters === 4 && m.sw <= m.iw, where, 'layout broke with a third engine');
  ok(await page.evaluate(() => document.querySelector('.chapter .links a[href^="tracers.html"]').getAttribute('href').startsWith('tracers.html?a=ollama&b=vllm#')),
    where, 'links to the tracers page should keep the picked pair');

  // The tracers page shows the same pair, with the gaps marked.
  const second = await openPage(browser, { width: 1440, url: base + '/tracers.html?a=ollama&b=vllm', fake: true });
  const t = await second.page.evaluate(() => ({ text: document.body.innerText, selects: document.querySelectorAll('#picker select').length, sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  ok(/Not covered yet/.test(t.text), where + ' tracers', 'missing "Not covered yet"');
  ok(/Ollama/.test(t.text) && t.selects === 2 && t.sw <= t.iw, where + ' tracers', 'tracers page should show the picked engine and the picker without overflow');
  for (const p of second.problems) fail(where + ' tracers', p);
  await second.page.close();

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
  const httpT = await tracersLayoutChecks(browser, base, 'http');
  const fileT = await tracersLayoutChecks(browser, base, 'file');
  for (const w of WIDTHS) ok(httpT[w] === fileT[w], `tracers width ${w}`, 'body text differs between http and file://');
  await fakeEngineChecks(browser, base);
  await reversedPairChecks(browser, base);
  await chartChecks(browser, base);
  await resizeChecks(browser, base);
  await realFontChecks(browser, base);
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
