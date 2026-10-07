import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileHash, stampHtml, pages } from '../tools/stamp-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every local script tag matches its file (run npm run stamp after editing data/ or assets/)', () => {
  const stale = [];
  for (const page of pages(root)) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    if (stampHtml(html, root) !== html) stale.push(page);
  }
  assert.deepEqual(stale, []);
});

test('both comparison pages tag their scripts and the shared stylesheet', () => {
  const js = fileHash(path.join(root, 'assets/compare/page.js'));
  const css = fileHash(path.join(root, 'assets/compare/site.css'));
  for (const page of ['index.html', 'tracers.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.match(html, new RegExp('src="assets/compare/page\\.js\\?v=' + js + '"'), page);
    assert.match(html, new RegExp('<link rel="stylesheet" href="assets/compare/site\\.css\\?v=' + css + '">'), page);
  }
});

test('stamping sets the hash, replaces an old one and leaves remote scripts alone', () => {
  const v = fileHash(path.join(root, 'data/compare.js'));
  assert.equal(stampHtml('<script src="data/compare.js"></script>', root), `<script src="data/compare.js?v=${v}"></script>`);
  assert.equal(stampHtml('<script src="data/compare.js?v=old"></script>', root), `<script src="data/compare.js?v=${v}"></script>`);
  const remote = '<script src="https://cdn.example.invalid/x.js"></script>';
  assert.equal(stampHtml(remote, root), remote);
  const fonts = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo">';
  assert.equal(stampHtml(fonts, root), fonts);
  const css = fileHash(path.join(root, 'assets/compare/site.css'));
  assert.equal(stampHtml('<link rel="stylesheet" href="assets/compare/site.css">', root), `<link rel="stylesheet" href="assets/compare/site.css?v=${css}">`);
  const missing = '<script src="data/bench/none.js?v=abc" onerror="this.remove()"></script>';
  assert.equal(stampHtml(missing, root), '<script src="data/bench/none.js" onerror="this.remove()"></script>');
});
