// Loads the site's classic data scripts into a Node vm context, the way a
// browser would, so tests and tools can read window.RT without a browser.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function jsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => path.join(dir, f));
}

// Returns the vm context (globalThis of the loaded scripts: RT, RTU, ...).
export function loadContext(root, extraFiles = []) {
  const ctx = vm.createContext({ console, URLSearchParams });
  vm.runInContext('globalThis.window = globalThis;', ctx);
  const files = [
    path.join(root, 'data', 'registry.js'),
    path.join(root, 'data', 'compare.js'),
    ...jsFiles(path.join(root, 'data', 'engines')),
    ...jsFiles(path.join(root, 'data', 'pairs')),
    ...jsFiles(path.join(root, 'data', 'bench')),
    ...extraFiles.map(f => path.resolve(root, f)),
  ];
  for (const file of files) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }
  return ctx;
}

export function loadSiteData(root, extraFiles = []) {
  return loadContext(root, extraFiles).RT;
}
