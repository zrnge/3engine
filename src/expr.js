/**
 * Expressions — a little language for values in rules, messages and conditions,
 * safe to run (no eval: it is read and worked out here, and can only reach the
 * game's variables and the functions below).
 *
 *   score * 2 + 1            arithmetic: + - * / % and ( )
 *   "Hi " + name             text: + joins
 *   coins >= 10 and not dead comparisons == != < <= > >=, and / or / not (or && || !)
 *   hp > 50 ? "fine" : "hurt"
 *   inventory[0]  len(inventory)  quest.stage  ["sword", "shield"]  {stage: 1}
 *   min(a, b)  max  abs  round  floor  ceil  sqrt  pow  clamp(x, lo, hi)
 *   random(a, b)  randint(a, b)  len(x)  contains(list or text, x)  indexOf
 *   join(list, ", ")  upper  lower  text(x)  number(x)  first  last  keys  has(record, key)
 *
 * A name is a variable (0 if there is none). In a field, a value is read as
 * it looks — 5, true, Hello — and starts with = to be worked out (valueOf);
 * in a text, {an expression} is replaced by its value (formatText).
 */

export class ExprError extends Error {}

// ---------------------------------------------------------------- reading it

const KEYWORDS = { and: '&&', or: '||', not: '!', true: true, false: false };

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(src.slice(i));
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2; continue; }
        s += src[j++];
      }
      if (j >= src.length) throw new ExprError('a text has no closing quote');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
      const w = m[0];
      if (Object.hasOwn(KEYWORDS, w)) { // its own words only — never Object's (constructor, toString…)
        const k = KEYWORDS[w];
        out.push(typeof k === 'boolean' ? { t: 'bool', v: k } : { t: 'op', v: k });
      } else out.push({ t: 'id', v: w });
      i += w.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%<>!?:,.()[]{}'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === '=') { out.push({ t: 'op', v: '==' }); i++; continue; } // a lone = reads as "is"
    throw new ExprError(`"${c}" is not understood here`);
  }
  return out;
}

const BINARY = {
  '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
};

function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => peek()?.t === 'op' && peek().v === v;
  const expect = (v) => {
    if (!isOp(v)) throw new ExprError(`expected "${v}"${peek() ? '' : ' at the end'}`);
    p++;
  };

  function expression() {
    const cond = binary(1);
    if (isOp('?')) {
      p++;
      const yes = expression();
      expect(':');
      const no = expression();
      return { k: 'if', cond, yes, no };
    }
    return cond;
  }
  function binary(min) {
    let left = unary();
    for (;;) {
      const t = peek();
      const prec = t?.t === 'op' ? BINARY[t.v] : undefined;
      if (prec === undefined || prec < min) return left;
      p++;
      left = { k: 'bin', op: t.v, a: left, b: binary(prec + 1) };
    }
  }
  function unary() {
    if (isOp('!')) { p++; return { k: 'not', a: unary() }; }
    if (isOp('-')) { p++; return { k: 'neg', a: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return postfix(primary());
  }
  function postfix(node) {
    for (;;) {
      if (isOp('.')) {
        p++;
        const t = peek();
        if (t?.t !== 'id') throw new ExprError('expected a name after "."');
        p++;
        node = { k: 'get', of: node, key: { k: 'lit', v: t.v } };
      } else if (isOp('[')) {
        p++;
        const key = expression();
        expect(']');
        node = { k: 'get', of: node, key };
      } else return node;
    }
  }
  function primary() {
    const t = peek();
    if (!t) throw new ExprError('something is missing at the end');
    if (t.t === 'num' || t.t === 'str' || t.t === 'bool') { p++; return { k: 'lit', v: t.v }; }
    if (t.t === 'id') {
      p++;
      if (isOp('(')) {
        p++;
        const args = [];
        if (!isOp(')')) {
          do { args.push(expression()); } while (isOp(',') && ++p);
        }
        expect(')');
        return { k: 'call', fn: t.v, args };
      }
      return { k: 'var', name: t.v };
    }
    if (isOp('(')) { p++; const e = expression(); expect(')'); return e; }
    if (isOp('[')) {
      p++;
      const items = [];
      if (!isOp(']')) {
        do { items.push(expression()); } while (isOp(',') && ++p);
      }
      expect(']');
      return { k: 'list', items };
    }
    if (isOp('{')) {
      p++;
      const fields = [];
      if (!isOp('}')) {
        do {
          const key = peek();
          if (key?.t !== 'id' && key?.t !== 'str') throw new ExprError('a record\'s field needs a name');
          p++;
          expect(':');
          fields.push([key.v, expression()]);
        } while (isOp(',') && ++p);
      }
      expect('}');
      return { k: 'record', fields };
    }
    throw new ExprError(`"${t.v}" is not expected here`);
  }

  const tree = expression();
  if (p < toks.length) throw new ExprError(`"${toks[p].v}" is not expected here`);
  return tree;
}

// ---------------------------------------------------------------- working it out

const num = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const isText = (v) => typeof v === 'string';
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const same = (a, b) => (typeof a === 'number' || typeof b === 'number') && Number.isFinite(Number(a)) && Number.isFinite(Number(b))
  && !(isText(a) && a.trim() === '') && !(isText(b) && b.trim() === '')
  ? Number(a) === Number(b)
  : JSON.stringify(a) === JSON.stringify(b);

/** A value as text, for messages and the HUD: a list joined, a record as its fields. */
export function asText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(4));
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.map(asText).join(', ');
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${asText(x)}`).join(', ');
  return String(v);
}

export const FUNCTIONS = {
  min: (...a) => Math.min(...a.map(num)),
  max: (...a) => Math.max(...a.map(num)),
  abs: (a) => Math.abs(num(a)),
  round: (a, d = 0) => { const k = 10 ** num(d); return Math.round(num(a) * k) / k; },
  floor: (a) => Math.floor(num(a)),
  ceil: (a) => Math.ceil(num(a)),
  sqrt: (a) => Math.sqrt(num(a)),
  pow: (a, b) => num(a) ** num(b),
  clamp: (x, lo, hi) => Math.min(num(hi), Math.max(num(lo), num(x))),
  random: (a = 0, b = 1) => num(a) + Math.random() * (num(b) - num(a)),
  randint: (a, b) => Math.floor(num(a) + Math.random() * (num(b) - num(a) + 1)),
  len: (x) => (Array.isArray(x) || isText(x) ? x.length : x && typeof x === 'object' ? Object.keys(x).length : 0),
  contains: (x, v) => (isText(x) ? x.toLowerCase().includes(asText(v).toLowerCase()) : list(x).some((y) => same(y, v))),
  indexOf: (x, v) => (isText(x) ? x.indexOf(asText(v)) : list(x).findIndex((y) => same(y, v))),
  count: (x, v) => list(x).filter((y) => same(y, v)).length,
  join: (x, sep = ', ') => list(x).map(asText).join(asText(sep)),
  upper: (s) => asText(s).toUpperCase(),
  lower: (s) => asText(s).toLowerCase(),
  text: (v) => asText(v),
  number: (v) => num(v),
  first: (x) => list(x)[0],
  last: (x) => { const l = list(x); return l[l.length - 1]; },
  keys: (r) => (r && typeof r === 'object' && !Array.isArray(r) ? Object.keys(r) : []),
  has: (r, k) => !!r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, asText(k)),
};

function evaluate(node, scope) {
  switch (node.k) {
    case 'lit': return node.v;
    case 'var': return scope.get(node.name);
    case 'list': return node.items.map((n) => evaluate(n, scope));
    case 'record': return Object.fromEntries(node.fields.map(([k, n]) => [k, evaluate(n, scope)]));
    case 'not': return !truthy(evaluate(node.a, scope));
    case 'neg': return -num(evaluate(node.a, scope));
    case 'if': return truthy(evaluate(node.cond, scope)) ? evaluate(node.yes, scope) : evaluate(node.no, scope);
    case 'get': {
      const of = evaluate(node.of, scope);
      const key = evaluate(node.key, scope);
      const index = typeof key === 'number' || (isText(key) && /^-?\d+$/.test(key)) ? Number(key) : null;
      if (Array.isArray(of)) return index === null ? undefined : of[index < 0 ? of.length + index : index];
      if (isText(of)) return index === null ? undefined : of[index];
      if (of && typeof of === 'object') return Object.prototype.hasOwnProperty.call(of, key) ? of[key] : undefined;
      return undefined;
    }
    case 'call': {
      const fn = scope.fn?.(node.fn) ?? (Object.prototype.hasOwnProperty.call(FUNCTIONS, node.fn) ? FUNCTIONS[node.fn] : null);
      if (!fn) throw new ExprError(`there is no "${node.fn}()"`);
      return fn(...node.args.map((n) => evaluate(n, scope)));
    }
    case 'bin': {
      if (node.op === '&&') { const a = evaluate(node.a, scope); return truthy(a) ? evaluate(node.b, scope) : a; }
      if (node.op === '||') { const a = evaluate(node.a, scope); return truthy(a) ? a : evaluate(node.b, scope); }
      const a = evaluate(node.a, scope);
      const b = evaluate(node.b, scope);
      switch (node.op) {
        case '+':
          if (Array.isArray(a)) return [...a, ...list(b)];
          return isText(a) || isText(b) ? asText(a) + asText(b) : num(a) + num(b);
        case '-': return num(a) - num(b);
        case '*': return num(a) * num(b);
        case '/': return num(b) === 0 ? 0 : num(a) / num(b);
        case '%': return num(b) === 0 ? 0 : num(a) % num(b);
        case '==': return same(a, b);
        case '!=': return !same(a, b);
        case '<': return isText(a) && isText(b) ? a < b : num(a) < num(b);
        case '<=': return isText(a) && isText(b) ? a <= b : num(a) <= num(b);
        case '>': return isText(a) && isText(b) ? a > b : num(a) > num(b);
        case '>=': return isText(a) && isText(b) ? a >= b : num(a) >= num(b);
        default: throw new ExprError(`"${node.op}" is not understood`);
      }
    }
    default: throw new ExprError('not understood');
  }
}

/** True as a condition: not 0, not empty, not no. */
export function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return !!v && v !== '0';
}

const _cache = new Map();
/** Read an expression once (kept for next time): its tree — or an ExprError saying what is wrong. */
export function compile(src) {
  const key = String(src);
  if (!_cache.has(key)) {
    if (_cache.size > 2000) _cache.clear();
    try {
      _cache.set(key, parse(key));
    } catch (err) {
      _cache.set(key, err instanceof ExprError ? err : new ExprError(String(err?.message ?? err)));
    }
  }
  const tree = _cache.get(key);
  if (tree instanceof ExprError) throw tree;
  return tree;
}

/**
 * Work out an expression. `scope.get(name)` gives a name's value (a variable);
 * `scope.fn(name)` may offer functions of the game's own. Throws ExprError.
 */
export function run(src, scope) {
  return evaluate(compile(src), scope);
}

/** Is this expression well formed? null if so, else what is wrong. */
export function problemIn(src) {
  try { compile(src); return null; } catch (err) { return err.message; }
}

/** The scope of a game's variables (missing ones are 0). */
export const varScope = (vars, extra = null) => ({
  get: (name) => (extra && Object.prototype.hasOwnProperty.call(extra, name) ? extra[name] : (vars?.has?.(name) ? vars.get(name) : 0)),
  fn: () => null,
});

/**
 * A value typed into a field, as it reads: a number, true / false, a list
 * written [a, b], text — or, starting with =, an expression worked out now.
 * Numbers saved before (not text) are themselves.
 */
export function valueOf(input, scope) {
  if (typeof input !== 'string') return input;
  const s = input.trim();
  if (s.startsWith('=')) return run(s.slice(1), scope);
  if (s === '') return '';
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
    try { return run(s, scope); } catch { return input; }
  }
  return formatText(input, scope);
}

/** A text with {expressions} in it, each replaced by its value. A broken one is left as it was. */
export function formatText(text, scope) {
  const s = String(text ?? '');
  if (!s.includes('{')) return s;
  return s.replace(/\{([^{}]+)\}/g, (whole, inner) => {
    try { return asText(run(inner, scope)); } catch { return whole; }
  });
}
