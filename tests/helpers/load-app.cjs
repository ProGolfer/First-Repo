'use strict';
// Loads REAL functions out of netlify/index.html (no copies) into a vm sandbox.
// Uses acorn to find top-level declarations in the app's main inline <script>,
// so tests exercise the exact code that ships.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');

const APP_HTML = path.join(__dirname, '../../netlify/index.html');

function mainScript(html) {
  // The big inline app script is the one that defines SUPABASE_URL.
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) if (m[1].includes('const SUPABASE_URL')) return m[1];
  throw new Error('Main app script not found in netlify/index.html');
}

let cache = null;
function index() {
  if (cache) return cache;
  const html = fs.readFileSync(APP_HTML, 'utf8');
  const src = mainScript(html);
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
  const decls = new Map();
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration') decls.set(node.id.name, src.slice(node.start, node.end));
    else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) if (d.id.type === 'Identifier') decls.set(d.id.name, src.slice(node.start, node.end));
    }
  }
  cache = { src, decls, html };
  return cache;
}

// Build a sandbox with the named real declarations plus caller-provided stubs.
function loadApp(names, globals = {}) {
  const { decls } = index();
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; }
  };
  const ctx = vm.createContext({ console, localStorage, Date, Math, Number, String, Map, Set, JSON, Intl, ...globals });
  for (const n of names) {
    if (!decls.has(n)) throw new Error(`Declaration not found in app: ${n}`);
    vm.runInContext(decls.get(n), ctx, { filename: `index.html:${n}` });
  }
  return { ctx, run: code => vm.runInContext(code, ctx), localStorage };
}

module.exports = { loadApp, index, mainScript, APP_HTML };
