// Tags every local <script src> in the site's HTML pages with ?v=<hash of the file>,
// so a browser holding an old copy fetches the new one as soon as the file changes.
// GitHub Pages lets browsers reuse files for 10 minutes; without the tag a returning
// visitor can get a new page with old scripts.
//
//   node tools/stamp-assets.mjs      rewrites the tags in place, prints what changed
//
// The hash ignores line endings, so a Windows checkout (CRLF) and the published
// files (LF) give the same tag. tests/stamp.test.mjs fails when a tag is stale.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_SRC = /(<script\b[^>]*\bsrc=")([^"?#]+)(?:\?v=[^"#]*)?(")/g;

export function fileHash(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}

function isLocal(src) { return !/^([a-z]+:)?\/\//i.test(src); }

// Returns the page with each local script's tag set to its current hash. A script
// whose file is missing (benchmark results before a run) keeps its src untagged.
export function stampHtml(html, root) {
  return html.replace(SCRIPT_SRC, (all, head, src, tail) => {
    if (!isLocal(src)) return all;
    const file = path.join(root, src);
    if (!fs.existsSync(file)) return head + src + tail;
    return head + src + '?v=' + fileHash(file) + tail;
  });
}

export function pages(root) {
  return fs.readdirSync(root).filter(f => f.endsWith('.html')).sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const page of pages(root)) {
    const file = path.join(root, page);
    const html = fs.readFileSync(file, 'utf8');
    const out = stampHtml(html, root);
    if (out !== html) { fs.writeFileSync(file, out); console.log('stamped', page); }
  }
}
