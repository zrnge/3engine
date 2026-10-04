import { ACTIONS, EVENTS, CONDITIONS, withDefaults } from '../rules.js';
import { keyLabel } from '../controls.js';

/**
 * The Logic graph — a level's rules as a graph (the editor's Tools drawer).
 *
 * Each rule is a node: the object it's on, its WHEN, its IFs and its DOs.
 * What a rule sets off elsewhere is drawn as a link out of that DO line:
 *
 *   Send event "alarm"      → each rule that receives "alarm" (on the objects it goes to)
 *   Set state "chasing"     → each "I enter a state: chasing" rule of what it sets
 *   Set / change a variable → the variable → each rule watching it, or testing it in an IF
 *   Show a screen           → the screen → its "A button is pressed" rules
 *   Start a dialogue        → the dialogue → its "A dialogue ends" rules
 *   Spawn a prefab, Go to level → the prefab, the level
 *
 * and the Controls that do any of those come in from a Controls node. The
 * rules themselves are edited where they always are (the Inspector); the graph
 * shows how they hang together — and links rules with a drag (an event sent
 * from one, received by another). While playing it lights up what runs.
 *
 * This file is the model (no DOM): build, lay out, and the edits a drag makes.
 */

export const NODE_W = 250;
const LINE_H = 16;
const HEAD_H = 26;
const GAP_X = 70;
const GAP_Y = 18;
const COLUMN_H = 1100;

const cut = (s, n = 34) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const q = (s) => `“${cut(s, 22)}”`;
const lower = (s) => String(s ?? '').trim().toLowerCase();

/** A WHEN as one short line. */
export function describeEvent(when) {
  if (!when) return 'WHEN (nothing)';
  const def = EVENTS[when.type];
  const label = def?.label ?? when.type;
  switch (when.type) {
    case 'key': return `WHEN ${keyLabel(when.code)} ${when.mode || 'pressed'}`;
    case 'update': return Number(when.every) > 0 ? `WHEN every ${when.every} s` : 'WHEN every frame';
    case 'variable': return `WHEN ${when.name} ${when.op} ${cut(when.value, 12)}`;
    case 'event': return `WHEN I receive ${q(when.name)}`;
    case 'stateEnter': return `WHEN I enter ${q(when.state)}`;
    case 'uiButton': return `WHEN button ${when.button ? q(when.button) : '(any)'} on ${when.screen ? q(when.screen) : 'a screen'}`;
    case 'dialogueEnd': return `WHEN dialogue ${when.dialogue ? q(when.dialogue) : '(any)'} ends`;
    default: return `WHEN ${cut(label, 40)}`;
  }
}

/** An IF line. */
export function describeCondition(c) {
  if (!c) return '';
  const not = c.not ? 'not ' : '';
  const join = c.join === 'or' ? 'OR' : 'IF';
  if (c.type === 'variable') return `${join} ${not}${c.name} ${c.op} ${cut(c.value, 12)}`;
  if (c.type === 'expression') return `${join} ${not}${cut(c.expr, 30)}`;
  if (c.type === 'compareVariables') return `${join} ${not}${c.name} ${c.op} ${c.other}`;
  return `${join} ${not}${cut(CONDITIONS[c.type]?.label ?? c.type, 36)}`;
}

/** A DO line. */
export function describeAction(a) {
  if (!a) return '';
  const def = ACTIONS[a.type];
  switch (a.type) {
    case 'sendEvent': return `Send ${q(a.name)} → ${a.to && a.to !== 'any' ? cut(a.to, 14) : 'anyone'}${Number(a.after) > 0 ? ` in ${a.after} s` : ''}`;
    case 'setVariable': return `${a.name} = ${cut(a.value, 16)}`;
    case 'changeVariable': return `${a.name} += ${cut(a.by, 12)}`;
    case 'setState': return `Set state ${q(a.state)}${a.target && a.target !== 'self' ? ` of ${cut(a.target, 12)}` : ''}`;
    case 'showScreen': return `${a.how === 'hide' ? 'Hide' : a.how?.startsWith('show or') ? 'Toggle' : 'Show'} screen ${a.screen ? q(a.screen) : '(all)'}`;
    case 'startDialogue': return `Dialogue ${q(a.dialogue)}`;
    case 'spawn': return `Spawn ${q(a.prefab)}`;
    case 'goToLevel': return `Go to level ${q(a.level)}`;
    case 'wait': return `Wait ${a.seconds} s`;
    case 'showMessage': return `Message ${q(a.text)}`;
    case 'destroy': return `Destroy ${cut(a.target || 'self', 16)}`;
    case 'playSound': return `Sound ${q(a.name ?? a.sound)}`;
    default: return cut(def?.label ?? a.type, 40);
  }
}

/** Names a `=expression` or `{expression}` text reads. */
function namesRead(text) {
  const s = String(text ?? '');
  if (!s.startsWith('=') && !s.includes('{')) return [];
  return [...s.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
}

/** Every variable a rule reads: its WHEN watches one, its IFs test them, its actions' expressions use them. */
function variablesRead(rule) {
  const out = new Set();
  if (rule.when?.type === 'variable' && rule.when.name) out.add(rule.when.name);
  for (const n of namesRead(rule.when?.value)) out.add(n);
  const conds = (list) => {
    for (const c of list || []) {
      if ((c.type === 'variable' || c.type === 'compareVariables' || c.type === 'listContains') && c.name) out.add(c.name);
      if (c.type === 'compareVariables' && c.other) out.add(c.other);
      // an expression reads every name in it (those that are variables count)
      if (c.type === 'expression') [...String(c.expr ?? '').matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].forEach((m) => out.add(m[0]));
      for (const v of Object.values(c)) if (typeof v === 'string') namesRead(v).forEach((n) => out.add(n));
      if (Array.isArray(c.if)) conds(c.if);
    }
  };
  conds(rule.if);
  for (const a of [...(rule.do || []), ...(rule.else || [])]) {
    for (const [k, v] of Object.entries(a)) if (k !== 'type' && typeof v === 'string') namesRead(v).forEach((n) => out.add(n));
  }
  return out;
}

const nameOf = (entity) => entity?.object3D?.name || 'unnamed';
/** What a rule's key is in the editor — the same across Play and Stop (the level's own object number, then its place). */
export function ruleKey(entity, index) {
  return `${Number.isInteger(entity?.levelKey) ? `#${entity.levelKey}` : nameOf(entity)}:${index}`;
}

/**
 * The graph of the level's rules: { nodes, edges }.
 *   node  { id, kind: rule|var|screen|dialogue|prefab|level|controls, title, lines: [{ text, kind, port? }],
 *           entity?, index?, rule?, key?, x, y, w, h }
 *   edge  { id, from, fromLine, to, kind, label, rule?, entity?, list?, actionIndex?, dashed? }
 * `known` variables (the Game panel's) show even when no rule touches them... only those some rule uses do.
 */
export function buildLogicGraph(engine, { only = null, layout = null, columnHeight = COLUMN_H } = {}) {
  const gameplay = engine.gameplay;
  const recs = gameplay.rules.rules.filter((r) => r.entity?.object3D && (!only || only.includes(r.entity)));
  const nodes = [];
  const edges = [];
  const byId = new Map();
  const add = (node) => { nodes.push(node); byId.set(node.id, node); return node; };
  const dataNode = (kind, name, title) => {
    const id = `${kind}:${lower(name) || '(any)'}`;
    return byId.get(id) ?? add({ id, kind, title, name, lines: [] });
  };

  // a rule's place among its object's rules
  const indexOf = new Map();
  const counter = new Map();
  for (const r of gameplay.rules.rules) {
    const n = counter.get(r.entity) ?? 0;
    indexOf.set(r, n);
    counter.set(r.entity, n + 1);
  }

  for (const rec of recs) {
    const { entity, rule } = rec;
    const index = indexOf.get(rec);
    const key = ruleKey(entity, index);
    const lines = [{ text: describeEvent(rule.when), kind: 'when' }];
    for (const c of rule.if || []) lines.push({ text: describeCondition(c), kind: 'if' });
    const acts = [];
    for (const list of ['do', 'else']) {
      (rule[list] || []).forEach((a, ai) => {
        lines.push({ text: `${list === 'else' ? 'ELSE ' : ''}${describeAction(a)}`, kind: list, list, actionIndex: ai });
        acts.push({ a, line: lines.length - 1, list, ai });
      });
    }
    if (!(rule.do || []).length && !(rule.else || []).length) lines.push({ text: '(does nothing yet)', kind: 'none' });
    add({ id: `rule:${key}`, kind: 'rule', key, title: `${nameOf(entity)} · rule ${index + 1}`, entity, index, rule, rec, lines, acts });
  }

  // ---- links
  const rules = nodes.filter((n) => n.kind === 'rule');
  const link = (from, fromLine, to, kind, label, extra = {}) => {
    const id = `${from.id}>${fromLine}>${to.id}`;
    if (edges.some((e) => e.id === id)) return;
    edges.push({ id, from: from.id, fromLine, to: to.id, kind, label, ...extra });
    if (fromLine !== null && from.lines[fromLine]) from.lines[fromLine].port = true;
  };
  const receivers = (type, field, value) => rules.filter((r) => r.rule.when?.type === type && lower(r.rule.when[field]) === lower(value));
  const targetsOf = (to, entity) => {
    if (!to || to === 'any') return null; // anyone
    if (to === 'other') return 'other'; // whoever set the rule off: any of them
    try { return gameplay.resolveAll(to, entity, null); } catch { return []; }
  };
  const linkFromAction = (src, a, line, extra) => {
    switch (a.type) {
      case 'sendEvent': {
        const t = targetsOf(a.to, src.entity);
        for (const r of receivers('event', 'name', a.name)) {
          if (Array.isArray(t) && !t.includes(r.entity)) continue;
          link(src, line, r, 'event', a.name, { ...extra, dashed: t === 'other' });
        }
        break;
      }
      case 'setState': {
        const t = targetsOf(a.target || 'self', src.entity);
        for (const r of receivers('stateEnter', 'state', a.state)) {
          if (Array.isArray(t) && !t.includes(r.entity)) continue;
          link(src, line, r, 'state', a.state, { ...extra, dashed: t === 'other' });
        }
        break;
      }
      case 'setVariable': case 'changeVariable':
        if (a.name) link(src, line, dataNode('var', a.name, a.name), 'write', a.type === 'setVariable' ? '=' : '+=', extra);
        break;
      case 'showScreen':
        link(src, line, dataNode('screen', a.screen || '(all)', a.screen ? `Screen ${a.screen}` : 'Every screen'), 'screen', a.how, extra);
        break;
      case 'startDialogue':
        if (a.dialogue) link(src, line, dataNode('dialogue', a.dialogue, `Dialogue ${a.dialogue}`), 'dialogue', '', extra);
        break;
      case 'spawn':
        if (a.prefab) link(src, line, dataNode('prefab', a.prefab, `Prefab ${a.prefab}`), 'spawn', '', extra);
        break;
      case 'goToLevel':
        link(src, line, dataNode('level', a.level || 'next', `Level ${a.level || 'next'}`), 'level', '', extra);
        break;
      default:
    }
  };
  for (const r of rules) {
    for (const { a, line, list, ai } of r.acts) linkFromAction(r, a, line, { entity: r.entity, list, actionIndex: ai });
  }

  // the Controls: those of their actions that reach a rule, a variable, a screen
  const controls = gameplay.controls?.list ?? [];
  const reaching = new Set(['sendEvent', 'setState', 'setVariable', 'changeVariable', 'showScreen', 'startDialogue', 'spawn', 'goToLevel']);
  const ctlLines = [];
  controls.forEach((c, ci) => {
    const all = [c.action, ...(c.more || []), ...(c.yes || []), ...(c.no || [])].filter(Boolean);
    for (const a of all) if (reaching.has(a.type)) ctlLines.push({ c, ci, a });
  });
  if (ctlLines.length) {
    const ctl = add({ id: 'controls', kind: 'controls', title: 'Controls', lines: [] });
    for (const { c, a } of ctlLines) {
      const keys = (c.inputs || []).map((i) => (i.type === 'key' ? keyLabel(i.code) : i.type === 'mouse' ? `mouse ${i.button ?? ''}` : i.label || i.type)).join(' / ') || '(no input)';
      ctl.lines.push({ text: `${cut(keys, 12)}: ${describeAction(a)}`, kind: 'do' });
      linkFromAction({ ...ctl, entity: gameplay.engine?.playerEntity ?? null }, a, ctl.lines.length - 1, { control: true });
    }
  }

  // variables, screens, dialogues → the rules that read them, or are set off by them
  for (const n of nodes) {
    if (n.kind === 'var') {
      for (const r of rules) {
        if (!variablesRead(r.rule).has(n.name)) continue;
        // only by name: a variable no rule writes still shows what reads it (the Game panel's, a control's)
        link(n, null, r, 'read', r.rule.when?.type === 'variable' && r.rule.when.name === n.name ? 'when' : 'reads');
      }
    } else if (n.kind === 'screen') {
      const all = n.name === '(all)';
      for (const r of rules) {
        const w = r.rule.when;
        if (!w || !['uiButton', 'uiPick'].includes(w.type)) continue;
        if (all || !w.screen || lower(w.screen) === lower(n.name)) link(n, null, r, 'screen', w.button || '');
      }
    } else if (n.kind === 'dialogue') {
      for (const r of rules) {
        const w = r.rule.when;
        if (w?.type === 'dialogueEnd' && (!w.dialogue || lower(w.dialogue) === lower(n.name))) link(n, null, r, 'dialogue', 'ends');
      }
    }
  }
  // variables only read (a watch, an IF) — made too, so what reads them shows where they come from (the Game panel)
  for (const r of rules) {
    for (const v of variablesRead(r.rule)) {
      if (engine.variables?.has?.(v) || byId.has(`var:${lower(v)}`)) {
        const n = dataNode('var', v, v);
        link(n, null, r, 'read', r.rule.when?.type === 'variable' && r.rule.when.name === v ? 'when' : 'reads');
      }
    }
  }

  for (const n of nodes) {
    if (n.kind === 'var') n.lines = [{ text: `variable · now ${cut(JSON.stringify(engine.variables?.get?.(n.name, 0) ?? ''), 18)}`, kind: 'data' }];
    else if (n.kind !== 'rule' && n.kind !== 'controls' && !n.lines.length) n.lines = [{ text: n.kind, kind: 'data' }];
    n.w = NODE_W;
    n.h = HEAD_H + n.lines.length * LINE_H + 8;
  }
  layoutGraph(nodes, edges, layout, columnHeight);
  return { nodes, edges, byId };
}

/**
 * Where each node goes: where it was dragged to (a rule keeps its place in
 * `rule.at`, the others in `layout`), else in columns as tall as
 * `columnHeight` (the drawer's own height: wide and short, it reads at full
 * size) — the Controls first, then each object's rules together, then what
 * they reach.
 */
export function layoutGraph(nodes, edges, layout = null, columnHeight = COLUMN_H) {
  const place = (n) => {
    const at = n.kind === 'rule' ? n.rule.at : layout?.[n.id];
    return Array.isArray(at) && at.length === 2 && at.every(Number.isFinite) ? at : null;
  };
  let x = 0;
  let y = 0;
  let colW = 0;
  const flow = (list) => {
    for (const n of list) {
      const at = place(n);
      if (at) { [n.x, n.y] = at; continue; }
      if (y > 0 && y + n.h > columnHeight) { x += colW + GAP_X; y = 0; colW = 0; }
      n.x = x; n.y = y;
      y += n.h + GAP_Y;
      colW = Math.max(colW, n.w);
    }
  };
  const nextColumn = () => { if (y > 0) { x += colW + GAP_X; y = 0; colW = 0; } };
  flow(nodes.filter((n) => n.kind === 'controls'));
  nextColumn();
  // each object's rules together; a gap between objects
  let last = null;
  for (const n of nodes.filter((m) => m.kind === 'rule')) {
    if (last && n.entity !== last && !place(n)) y += GAP_Y;
    flow([n]);
    last = n.entity;
  }
  nextColumn();
  flow(nodes.filter((n) => !['rule', 'controls'].includes(n.kind)));
  return nodes;
}

/** Where a link leaves a node (its line's right side, or its middle-right) and comes in (its top-left). */
export function portOut(node, line) {
  if (line === null || line === undefined) return { x: node.x + node.w, y: node.y + HEAD_H / 2 };
  return { x: node.x + node.w, y: node.y + HEAD_H + line * LINE_H + LINE_H / 2 + 2 };
}
export function portIn(node) { return { x: node.x, y: node.y + HEAD_H / 2 }; }

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * A link drawn from `from`'s rule to an object: the rule sends `name` to it,
 * and the object has a rule receiving it (one is made if not). Returns the
 * new rule lists: [{ entity, next }] — the editor applies them (undoably).
 */
export function linkRules(engine, fromEntity, fromIndex, toEntity, name) {
  const rules = engine.gameplay.rules;
  const event = String(name ?? '').trim();
  if (!event) throw new Error('The event needs a name.');
  const from = clone(rules.listFor(fromEntity));
  const rule = from[fromIndex];
  if (!rule) throw new Error('There is no such rule.');
  const toName = toEntity?.object3D?.name;
  const to = toEntity === fromEntity ? 'self' : toName || 'any';
  rule.do = rule.do || [];
  if (!rule.do.some((a) => a.type === 'sendEvent' && lower(a.name) === lower(event) && a.to === to)) {
    rule.do.push(withDefaults(ACTIONS.sendEvent.props, { type: 'sendEvent', name: event, to, after: 0 }));
  }
  const changes = [{ entity: fromEntity, next: from }];
  const target = toEntity === fromEntity ? from : clone(rules.listFor(toEntity));
  if (!target.some((r) => r.when?.type === 'event' && lower(r.when.name) === lower(event))) {
    const at = rule.at ? [rule.at[0] + NODE_W + GAP_X, rule.at[1]] : undefined;
    target.push({ when: { type: 'event', name: event }, if: [], do: [], ...(at ? { at } : {}) });
    if (toEntity !== fromEntity) changes.push({ entity: toEntity, next: target });
  }
  return changes;
}

/** A link's DO taken away from its rule: [{ entity, next }], or [] if it isn't one a rule makes. */
export function unlink(engine, edge) {
  if (!edge?.entity || edge.control || edge.actionIndex === undefined) return [];
  const list = clone(engine.gameplay.rules.listFor(edge.entity));
  const fromNode = edge.from.startsWith('rule:') ? edge.from : null;
  if (!fromNode) return [];
  const index = Number(fromNode.split(':').pop());
  const rule = list[index];
  if (!rule?.[edge.list]?.[edge.actionIndex]) return [];
  rule[edge.list].splice(edge.actionIndex, 1);
  if (edge.list === 'else' && !rule.else.length) delete rule.else;
  return [{ entity: edge.entity, next: list }];
}

/** A new event name not yet used in the level: "event", "event 2"… */
export function freshEventName(engine, base = 'event') {
  const used = new Set();
  for (const r of engine.gameplay.rules.rules) {
    if (r.rule.when?.type === 'event') used.add(lower(r.rule.when.name));
    for (const a of [...(r.rule.do || []), ...(r.rule.else || [])]) if (a.type === 'sendEvent') used.add(lower(a.name));
  }
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
