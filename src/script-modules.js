import * as THREE from 'three';

/**
 * Script modules — code shared by a game's scripts. A module is a named piece
 * of the game (the same in every level), written as an ordinary JavaScript
 * module:
 *
 *   // module "maths"
 *   export const TAU = Math.PI * 2;
 *   export function wobble(t, amount = 0.2) { return Math.sin(t * TAU) * amount; }
 *
 *   // module "enemies"
 *   import { wobble } from 'maths';
 *   export function bob(object, time) { object.position.y = 1 + wobble(time); }
 *
 * A Behavior script imports from them the same way, at its top:
 *
 *   import { bob } from 'enemies';
 *   bob(entity, time);
 *
 * (or `const { bob } = use('enemies')` anywhere). A module runs once, the first
 * time something imports it, and then every importer shares it — and its
 * `let` counters, its caches — until Play starts again. One module may import
 * another; two that import each other get each other's exports as far as they
 * have run, as in the browser.
 *
 * No build step: the import and export lines are turned into plain code here
 * (each line stays where it was, so a mistake's line number is still right).
 * They are read a line at a time — an `export` or `import` must start its line.
 * Besides `use`, a module has THREE, `engine` (the engine), `vars` (the game's
 * variables) and `log`.
 */

const ID = '[A-Za-z_$][\\w$]*';

/** "./maths.js", "maths.js", "Maths" → "maths": the one name a module goes by. */
export function moduleKey(name) {
  return String(name ?? '').trim().replace(/^\.\//, '').replace(/\.m?js$/i, '').toLowerCase();
}

/** `a, b as c` → [['a', 'a'], ['b', 'c']] (what it's called inside, what it's called outside). */
function namesIn(list) {
  return list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(new RegExp(`^(${ID}|default)(?:\\s+as\\s+(${ID}|default))?$`));
    if (!m) throw new SyntaxError(`can't read "${s}"`);
    return [m[1], m[2] || m[1]];
  });
}

/** An import's clause as the left side of `const … = use('x')` (or a list of such). */
function importBinding(clause, from) {
  const use = `use(${JSON.stringify(from)})`;
  const c = clause.trim();
  let m = c.match(new RegExp(`^\\*\\s+as\\s+(${ID})$`));
  if (m) return `const ${m[1]} = ${use};`;
  m = c.match(new RegExp(`^(${ID})\\s*(?:,\\s*(.+))?$`));
  if (m) {
    const rest = m[2] ? ` ${importBinding(m[2], from)}` : '';
    return `const ${m[1]} = ${use}.default;${rest}`;
  }
  m = c.match(/^\{([^}]*)\}$/);
  if (m) {
    const parts = namesIn(m[1]).map(([outside, inside]) => (outside === inside ? inside : `${outside}: ${inside}`));
    return `const { ${parts.join(', ')} } = ${use};`;
  }
  throw new SyntaxError(`can't read the import "${c}"`);
}

const IMPORT_FROM = /^(\s*)import\s+(.+?)\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/;
const IMPORT_BARE = /^(\s*)import\s+(['"])([^'"]+)\2\s*;?\s*$/;

/** One import line, as plain code — or null if it isn't one. */
function importLine(line) {
  let m = line.match(IMPORT_FROM);
  if (m) return m[1] + importBinding(m[2], m[4]);
  m = line.match(IMPORT_BARE);
  if (m) return `${m[1]}use(${JSON.stringify(m[3])});`;
  return null;
}

/**
 * A Behavior script's import lines, as `const … = use(…)` — each on its own
 * line, so the lines after it keep their numbers.
 */
export function scriptImports(code) {
  if (!/^\s*import\s/m.test(code)) return code;
  return code.split('\n').map((line) => importLine(line) ?? line).join('\n');
}

/**
 * A module's code as a function body: its imports `use` the others, and what
 * it exports is put on `exports` — as getters, so `export let count` read
 * later is its value then (live, as in the browser).
 */
export function transformModule(code) {
  return transform(code).body;
}

/**
 * What a module exports, and whether it can be read at all — without running
 * it (the Modules tab's Check): { names, error }.
 */
export function checkModule(code) {
  try {
    const { body, names } = transform(code);
    new Function('exports', 'use', 'THREE', 'engine', 'vars', 'log', `"use strict";\n${body}`); // read, not run
    return { names, error: null };
  } catch (err) {
    return { names: [], error: String(err?.message || err) };
  }
}

function transform(code) {
  const exported = []; // [inside, outside]
  const lines = String(code ?? '').split('\n').map((line, i) => {
    const imp = importLine(line);
    if (imp !== null) return imp;
    let m = line.match(/^(\s*)export\s+default\s+(.*)$/);
    if (m) return `${m[1]}exports.default = ${m[2]}`;
    m = line.match(new RegExp(`^(\\s*)export\\s+((?:async\\s+)?function\\s*\\*?\\s*(${ID})[\\s\\S]*)$`));
    if (m) { exported.push([m[3], m[3]]); return m[1] + m[2]; }
    m = line.match(new RegExp(`^(\\s*)export\\s+(class\\s+(${ID})[\\s\\S]*)$`));
    if (m) { exported.push([m[3], m[3]]); return m[1] + m[2]; }
    m = line.match(/^(\s*)export\s+((?:const|let|var)\s+([\s\S]*))$/);
    if (m) {
      const decl = m[3];
      const d = decl.match(/^\{([^}]*)\}\s*=/) || decl.match(/^\[([^\]]*)\]\s*=/);
      if (d) {
        for (const part of d[1].split(',')) {
          const name = part.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
          if (name) exported.push([name, name]);
        }
      } else {
        // a, b = 2, c = f(x, y): the names before each top-level comma's "="
        let depth = 0;
        let start = 0;
        const pieces = [];
        for (let k = 0; k < decl.length; k++) {
          const ch = decl[k];
          if ('([{'.includes(ch)) depth++;
          else if (')]}'.includes(ch)) depth--;
          else if (ch === ',' && depth === 0) { pieces.push(decl.slice(start, k)); start = k + 1; }
        }
        pieces.push(decl.slice(start));
        for (const p of pieces) {
          const n = p.trim().match(new RegExp(`^(${ID})`));
          if (n) exported.push([n[1], n[1]]);
        }
      }
      return m[1] + m[2];
    }
    m = line.match(/^(\s*)export\s*\{([^}]*)\}\s*(?:from\s+(['"])([^'"]+)\3)?\s*;?\s*$/);
    if (m) {
      const pairs = namesIn(m[2]);
      if (m[4]) {
        // export { a } from 'other': passed through
        const src = `use(${JSON.stringify(m[4])})`;
        return m[1] + pairs.map(([inside, outside]) => `Object.defineProperty(exports, ${JSON.stringify(outside)}, { enumerable: true, get: () => ${src}[${JSON.stringify(inside)}] });`).join(' ');
      }
      exported.push(...pairs);
      return '';
    }
    if (/^\s*export\s/.test(line)) throw new SyntaxError(`line ${i + 1}: can't read this export`);
    return line;
  });
  // the getters first, on line 1 itself: a module imported back by one it imports sees what's there so far
  const getters = exported.map(([inside, outside]) => `${JSON.stringify(outside)}: { enumerable: true, get: () => ${inside} }`);
  const head = getters.length ? `Object.defineProperties(exports, { ${getters.join(', ')} }); ` : '';
  const names = exported.map(([, outside]) => outside);
  for (const line of lines) {
    if (/^\s*exports\.default = /.test(line)) names.push('default');
    for (const m of line.matchAll(/Object\.defineProperty\(exports, "([^"]+)"/g)) names.push(m[1]);
  }
  return { body: head + lines.join('\n'), names };
}

/** The game's modules, and each one's exports once it has run. */
export class ScriptModules {
  constructor(engine = null) {
    this.engine = engine;
    this.list = []; // { name, code } — the game's, as saved
    this._loaded = new Map(); // key -> { exports, done }
    this.onError = null; // (name, err) — a module that can't run
  }

  names() { return this.list.map((m) => m.name); }

  get(name) {
    const key = moduleKey(name);
    return this.list.find((m) => moduleKey(m.name) === key) ?? null;
  }

  /** Add or change a module. Everything runs afresh after (the next import runs it again). */
  set(name, code) {
    const clean = String(name ?? '').trim();
    if (!clean) throw new Error('A module needs a name.');
    const had = this.get(clean);
    if (had) { had.code = String(code ?? ''); had.name = clean; } else this.list.push({ name: clean, code: String(code ?? '') });
    this.reset();
    return this.get(clean);
  }

  rename(from, to) {
    const m = this.get(from);
    const clean = String(to ?? '').trim();
    if (!m || !clean || (this.get(clean) && this.get(clean) !== m)) return false;
    m.name = clean;
    this.reset();
    return true;
  }

  remove(name) {
    const m = this.get(name);
    if (!m) return false;
    this.list.splice(this.list.indexOf(m), 1);
    this.reset();
    return true;
  }

  /** Forget what has run (Play starts again; a module changed). */
  reset() { this._loaded.clear(); }

  load(list) {
    this.list = (Array.isArray(list) ? list : [])
      .filter((m) => m && typeof m.name === 'string' && m.name.trim())
      .map((m) => ({ name: m.name.trim(), code: String(m.code ?? '') }));
    this.reset();
  }

  toJSON() { return this.list.map((m) => ({ name: m.name, code: m.code })); }

  /**
   * A module's exports, running it the first time. Throws, saying which module
   * and which line, if it has a mistake or there's no such module.
   */
  use(name) {
    const key = moduleKey(name);
    const had = this._loaded.get(key);
    if (had) return had.exports; // run (or running: one imported back by one it imports)
    const mod = this.get(key);
    if (!mod) {
      const known = this.names();
      throw new Error(`There is no script module "${name}".${known.length ? ` The game has: ${known.join(', ')}.` : ' Add one in Tools → Modules.'}`);
    }
    const exports = {};
    const rec = { exports, done: false };
    this._loaded.set(key, rec);
    let fn;
    try {
      fn = new Function('exports', 'use', 'THREE', 'engine', 'vars', 'log', `"use strict";\n${transformModule(mod.code)}`);
    } catch (err) {
      this._loaded.delete(key);
      throw this._wrap(mod.name, err);
    }
    const engine = this.engine;
    const log = (...a) => console.log(`[module ${mod.name}]`, ...a);
    try {
      fn(exports, (n) => this.use(n), THREE, engine, engine?.variables ?? null, log);
    } catch (err) {
      this._loaded.delete(key);
      throw this._wrap(mod.name, err);
    }
    rec.done = true;
    return exports;
  }

  _wrap(name, err) {
    if (err?.tiny3Module) return err; // said already, by the one it imported
    const line = moduleLineOf(err);
    const e = new Error(`Script module "${name}": ${err?.message || err}${line ? ` (line ${line})` : ''}`);
    e.tiny3Module = name;
    e.cause = err;
    this.onError?.(name, e);
    return e;
  }
}

/** The line in a module's code an error came from (its function has one line of its own first). */
function moduleLineOf(err) {
  const m = String(err?.stack || '').match(/(?:<anonymous>|Function|eval[^:]*):(\d+):\d+/);
  if (!m) return null;
  // new Function adds two lines of its own; ours ("use strict") one more
  const n = Number(m[1]) - 3;
  return n > 0 ? n : null;
}
