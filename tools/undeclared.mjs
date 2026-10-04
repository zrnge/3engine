// Names a module uses but never declares or imports: what would be a ReferenceError at the
// moment that code runs — or, worse, silently the browser's own (window.history, window.name…).
//   node tools/undeclared.mjs                 every .js under src/
//   node tools/undeclared.mjs src/game.js     just these
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAst } from 'rollup/parseAst';
import { walk } from 'estree-walker';

// the browser's own names a module may use; window properties that are easy to mistake for
// one's own (history, name, status, parent, top, self, event, open, close…) are left out on purpose
const BROWSER = new Set(`window document navigator localStorage sessionStorage indexedDB console setTimeout clearTimeout
setInterval clearInterval requestAnimationFrame cancelAnimationFrame performance queueMicrotask structuredClone
URL URLSearchParams Blob File FileReader FormData Response Request Headers fetch atob btoa TextEncoder TextDecoder
CompressionStream DecompressionStream crypto Image HTMLElement HTMLInputElement HTMLCanvasElement Element Node NodeList
Event CustomEvent KeyboardEvent MouseEvent PointerEvent WheelEvent DragEvent ResizeObserver MutationObserver
IntersectionObserver CSS getComputedStyle matchMedia alert confirm prompt location devicePixelRatio innerWidth
innerHeight screen AudioContext OfflineAudioContext DOMParser XMLSerializer AbortController Promise Map Set WeakMap WeakSet
WeakRef Symbol Object Array Number String Boolean Math JSON Date RegExp Error TypeError RangeError SyntaxError Reflect
Proxy Intl BigInt Float32Array Float64Array Int8Array Int16Array Int32Array Uint8Array Uint16Array Uint32Array
Uint8ClampedArray ArrayBuffer DataView isNaN isFinite parseInt parseFloat encodeURIComponent decodeURIComponent
encodeURI decodeURI undefined NaN Infinity globalThis eval Function arguments Worker MessageChannel BroadcastChannel
Notification ClipboardItem showOpenFilePicker showSaveFilePicker showDirectoryPicker createImageBitmap OffscreenCanvas ImageData`.split(/\s+/));

function check(path) {
  const src = readFileSync(path, 'utf8');
  const ast = parseAst(src);
  const scopes = []; // [{ names: Set }]
  const missing = new Map(); // name -> first position
  const declarePattern = (p, into) => {
    if (!p) return;
    if (p.type === 'Identifier') into.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach((q) => declarePattern(q.type === 'RestElement' ? q.argument : q.value, into));
    else if (p.type === 'ArrayPattern') p.elements.forEach((q) => declarePattern(q, into));
    else if (p.type === 'RestElement') declarePattern(p.argument, into);
    else if (p.type === 'AssignmentPattern') declarePattern(p.left, into);
  };
  // every name a block (or function, or the module) declares directly — hoisted as a whole for this check
  const declared = (node) => {
    const names = new Set();
    const body = node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock' ? node.body
      : node.type === 'SwitchCase' ? node.consequent : [];
    for (const st of body) {
      const s = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration ?? st : st;
      if (!s) continue;
      if (s.type === 'VariableDeclaration') s.declarations.forEach((d) => declarePattern(d.id, names));
      else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) names.add(s.id.name);
      else if (s.type === 'ImportDeclaration') s.specifiers.forEach((sp) => names.add(sp.local.name));
    }
    // var anywhere in a function body, hoisted
    if (node.type === 'Program' || node.isFunctionBody) {
      walk(node, {
        enter(n, parent) {
          if (n !== node && /Function/.test(n.type)) return this.skip();
          if (n.type === 'VariableDeclaration' && n.kind === 'var') n.declarations.forEach((d) => declarePattern(d.id, names));
        },
      });
    }
    return names;
  };
  const known = (name) => BROWSER.has(name) || scopes.some((s) => s.has(name));
  walk(ast, {
    enter(node, parent, key) {
      if (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock' || node.type === 'SwitchCase') {
        if (node.type === 'BlockStatement' && parent && /Function/.test(parent.type)) node.isFunctionBody = true;
        scopes.push(declared(node));
        return;
      }
      if (/Function/.test(node.type)) {
        const names = new Set();
        node.params.forEach((p) => declarePattern(p, names));
        if (node.type === 'FunctionExpression' && node.id) names.add(node.id.name);
        scopes.push(names);
        return;
      }
      if (node.type === 'ClassExpression' && node.id) { scopes.push(new Set([node.id.name])); return; }
      if (node.type === 'CatchClause') { const n = new Set(); declarePattern(node.param, n); scopes.push(n); return; }
      if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
        const n = new Set();
        const init = node.init ?? node.left;
        if (init?.type === 'VariableDeclaration') init.declarations.forEach((d) => declarePattern(d.id, n));
        scopes.push(n);
        return;
      }
      if (node.type !== 'Identifier') return;
      // not a reference: a property name, a key, a label, a declaration's own name
      if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
      if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') && key === 'key' && !parent.computed) {
        if (!(parent.type === 'Property' && parent.shorthand)) return;
      }
      if (parent?.type === 'LabeledStatement' || parent?.type === 'BreakStatement' || parent?.type === 'ContinueStatement') return;
      if (/Specifier$/.test(parent?.type ?? '')) return;
      if (parent?.type === 'MetaProperty') return;
      if (!known(node.name) && !missing.has(node.name)) {
        const line = src.slice(0, node.start).split('\n').length;
        missing.set(node.name, line);
      }
    },
    leave(node) {
      if (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock' || node.type === 'SwitchCase'
        || /Function/.test(node.type) || (node.type === 'ClassExpression' && node.id) || node.type === 'CatchClause'
        || node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') scopes.pop();
    },
  });
  return missing;
}

const under = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? under(join(dir, d.name)) : d.name.endsWith('.js') ? [join(dir, d.name)] : []));
let bad = 0;
for (const path of process.argv.length > 2 ? process.argv.slice(2) : under('src')) {
  const missing = check(path);
  for (const [name, line] of missing) {
    bad++;
    console.log(`${path}:${line}  ${name}`);
  }
}
console.log(bad ? `${bad} undeclared` : 'none undeclared');
process.exit(bad ? 1 : 0);
