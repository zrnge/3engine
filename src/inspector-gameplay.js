import { COMPONENTS, coerceProp, defaultProps } from './components.js';
import { EVENTS, ACTIONS, CONDITIONS, blankRule, withDefaults, joinOf, fieldShown, drivesFields, actsPerFrame, keepsRunning } from './rules.js';
import { partRoles } from './physics-parts.js';
import { escapeHtml } from './ui.js';
import { clipNames } from './animation.js';
import { allGroups, GROUP_PREFIX, whoLabel } from './groups.js';
import { keyLabel } from './controls.js';
import { captureNextInput } from './input.js';

/**
 * The Components and Rules sections of the inspector — the "no code required"
 * half of the editor.
 *
 * Components, events, actions and conditions all describe their fields with the
 * same little schema ({ type, default, min, max, options, label }), so one field
 * renderer covers every one of them. Add a prop to a component definition and its
 * control appears here with no UI work.
 *
 * Kept out of editor.js, which is already long enough.
 */

// ---------------------------------------------------------------- fields

/**
 * Every animation clip name in the scene, as suggestions for a clip field
 * whose model isn't known (a rule acting on "other", a control aimed at a name).
 */
export function refreshClipNames(engine) {
  refreshWhoChoices(engine);
  if (typeof document === 'undefined') return;
  let list = document.getElementById('t3-clip-names');
  if (!list) {
    list = document.createElement('datalist');
    list.id = 't3-clip-names';
    document.body.appendChild(list);
  }
  const names = new Set();
  for (const e of engine.entities || []) {
    for (const c of e.object3D?.userData?.animations || []) if (c.name) names.add(c.name);
  }
  list.innerHTML = [...names].map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
}

/** What a "who" field offers: the scene's groups and object names (see groups.js). */
let whoChoices = { groups: [], names: [], counts: new Map(), prefabs: [], screens: [], dialogues: [] };

export function refreshWhoChoices(engine) {
  const names = [];
  const counts = new Map(); // how many objects share each name: a target then means all of them
  for (const e of engine.entities || []) {
    const n = e.object3D?.name;
    if (!n || e.object3D.isLight || e === engine.player) continue;
    if (!names.includes(n)) names.push(n);
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const prefabNames = engine.prefabs?.names?.() ?? [];
  const prefabs = prefabNames.map((n) => engine.prefabs.get(n));
  whoChoices = {
    groups: allGroups(engine.entities || [], prefabs),
    names: names.sort((a, b) => a.localeCompare(b)),
    counts,
    // what's spawned in play is named after its prefab: a rule can mean those copies
    prefabs: prefabNames.filter((n) => !names.includes(n)).sort((a, b) => a.localeCompare(b)),
    // the game's screens and dialogues (the Screens panel)
    screens: (engine.ui?.screens || []).map((s) => s.name),
    dialogues: (engine.ui?.dialogues || []).map((d) => d.name),
  };
}

/** A who-field: anything, the player, a group, or one object — picked, not typed. */
function whoField(id, v, schema = {}) {
  const opt = (value, label) => `<option value="${escapeHtml(value)}" ${value === v ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  const known = ['any', 'player', ...(schema.withSelf ? ['self', 'other'] : []), ...whoChoices.groups.map((g) => GROUP_PREFIX + g), ...whoChoices.names];
  const groups = whoChoices.groups.map((g) => opt(GROUP_PREFIX + g, g)).join('');
  const names = whoChoices.names.map((n) => opt(n, n)).join('');
  return `<select id="${id}" title="Groups are set on each object in the Inspector (Groups)">
    ${opt('any', 'Anything')}${opt('player', 'The player')}
    ${schema.withSelf ? `${opt('self', 'Me (a timer of my own)')}${opt('other', 'What set this rule off')}` : ''}
    ${groups ? `<optgroup label="Groups">${groups}</optgroup>` : ''}
    ${names ? `<optgroup label="Objects">${names}</optgroup>` : ''}
    ${v && !known.includes(v) ? opt(v, `${whoLabel(v)} (not in this level)`) : ''}
  </select>`;
}

/**
 * Clips for states: a row each — a state's name, the clip it plays, how. Its
 * own + and × change the rows and say so (a change event), like any field.
 */
function stateClipsField(id, value, ctx) {
  const clips = ctx.clips || [];
  const plays = ['loops', 'once, then holds', 'once, then moves'];
  const row = (r = { state: '', clip: '', play: 'loops' }) => `<div class="sc-row">
    <input class="sc-state" value="${escapeHtml(r.state)}" placeholder="state (chasing)" spellcheck="false" list="t3-state-names" />
    <select class="sc-clip"><option value="">— clip —</option>${clips.map((c) => `<option value="${escapeHtml(c)}" ${c === r.clip ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}${
      r.clip && !clips.includes(r.clip) ? `<option value="${escapeHtml(r.clip)}" selected>${escapeHtml(r.clip)}</option>` : ''}</select>
    <select class="sc-play">${plays.map((p) => `<option value="${p}" ${p === r.play ? 'selected' : ''}>${p}</option>`).join('')}</select>
    <button class="gp-x sc-del" type="button" title="Remove">×</button></div>`;
  return `<div id="${id}" class="state-clips">${(Array.isArray(value) ? value : []).map(row).join('')}
    <template>${row()}</template>
    <button class="tbtn sc-add" type="button">+ State</button>
    <datalist id="t3-state-names">${['patrolling', 'guarding', 'chasing', 'attacking', 'searching', 'taking cover', 'stunned', 'asleep', 'dead']
      .map((s) => `<option value="${s}"></option>`).join('')}</datalist></div>`;
}

// its + and ×, wherever it is: rows added or removed, then a change as a typed field would make
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const box = e.target.closest?.('.state-clips');
    if (!box) return;
    if (e.target.closest('.sc-add')) {
      box.querySelector('template').insertAdjacentHTML('beforebegin', box.querySelector('template').innerHTML);
    } else if (e.target.closest('.sc-del')) {
      e.target.closest('.sc-row').remove();
    } else return;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** A screen or a dialogue of the game, by name (made in the Screens panel). */
function uiNameField(id, v, schema) {
  const names = schema.type === 'screen' ? whoChoices.screens : whoChoices.dialogues;
  const opt = (value, label) => `<option value="${escapeHtml(value)}" ${value === (v ?? '') ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  const none = schema.type === 'screen' ? (schema.withAll ? 'any / all of them' : '— choose —') : '— choose —';
  const known = !v || v === 'all' || names.includes(v);
  return `<select id="${id}" title="Made in the Screens panel">
    ${opt('', none)}${names.map((n) => opt(n, n)).join('')}
    ${known ? '' : opt(v, `${v} (not in this game)`)}
  </select>`;
}

/**
 * Who a field means, picked: me (the object the rule or control is on), the
 * player, what set the rule off, a group, or an object — never typed.
 *   subject: who a condition is about (any of a group)
 *   target:  what an action acts on — every one of a group, or of the objects sharing a name
 *   object:  one object — of a group or a shared name, the nearest
 * Several objects sharing a name say so, so it is never a surprise which.
 */
function subjectField(id, v, mode = 'subject') {
  const opt = (value, label) => `<option value="${escapeHtml(value)}" ${value === v ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  const known = ['', 'self', 'player', 'other', ...whoChoices.groups.map((g) => GROUP_PREFIX + g), ...whoChoices.names, ...whoChoices.prefabs];
  const group = { subject: (g) => `any ${g}`, target: (g) => `every ${g}`, object: (g) => `the nearest ${g}` }[mode];
  const many = (n) => {
    const k = whoChoices.counts.get(n) || 0;
    if (k < 2) return n;
    return mode === 'object' ? `${n} (nearest of ${k})` : mode === 'target' ? `${n} (all ${k})` : `${n} (any of ${k})`;
  };
  const groups = whoChoices.groups.map((g) => opt(GROUP_PREFIX + g, group(g))).join('');
  const names = whoChoices.names.map((n) => opt(n, many(n))).join('');
  const prefabs = whoChoices.prefabs.map((n) => opt(n, mode === 'object' ? `a ${n} (the nearest)` : `${n} copies`)).join('');
  return `<select id="${id}" title="Groups are set on each object in the Inspector (Groups)">
    ${mode === 'object' && !v ? opt('', '— choose —') : ''}
    ${opt('self', 'Me (this object)')}${opt('player', 'The player')}${opt('other', 'What set it off')}
    ${groups ? `<optgroup label="Groups">${groups}</optgroup>` : ''}
    ${names ? `<optgroup label="Objects">${names}</optgroup>` : ''}
    ${prefabs ? `<optgroup label="Spawned (prefabs)">${prefabs}</optgroup>` : ''}
    ${v && !known.includes(v) ? opt(v, `${whoLabel(v)} (not in this level)`) : ''}
  </select>`;
}

/**
 * One field for a schema. `ctx.clips` — the clip names of the model a clip
 * field is about — turns a clip field into a pick-list of exactly those.
 */
export function fieldHtml(id, schema, value, ctx = {}) {
  const v = value === undefined ? schema.default : value;
  switch (schema.type) {
    case 'part': {
      // anywhere, or one of the object's parts with a box or zone of its own (physics-parts.js)
      const parts = ctx.parts || [];
      const known = !v || parts.some((p) => p.key === v);
      return `<select id="${id}" title="Which of its parts: give a model's parts an own box or a trigger zone in its Physics">
        <option value="" ${v ? '' : 'selected'}>anywhere on it</option>
        ${parts.map((p) => `<option value="${escapeHtml(p.key)}" ${p.key === v ? 'selected' : ''}>${escapeHtml(p.name)} (${p.role === 'trigger' ? 'zone' : 'box'})</option>`).join('')}
        ${known ? '' : `<option value="${escapeHtml(v)}" selected>${escapeHtml(v)} (not on it now)</option>`}
      </select>`;
    }
    case 'who':
      return whoField(id, v, schema);
    case 'stateClips':
      return stateClipsField(id, v, ctx);
    case 'screen':
    case 'dialogue':
      return uiNameField(id, v, schema);
    case 'subject':
    case 'target':
    case 'object':
      return subjectField(id, v, schema.type);
    case 'clip': {
      if (!ctx.clips?.length) {
        return `<input type="text" id="${id}" value="${escapeHtml(v)}" list="t3-clip-names"
          placeholder="an animation's name" spellcheck="false" />`;
      }
      const known = ctx.clips.includes(v);
      return `<select id="${id}"><option value="" ${v ? '' : 'selected'}>— none —</option>${
        ctx.clips.map((c) => `<option value="${escapeHtml(c)}" ${c === v ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')
      }${v && !known ? `<option value="${escapeHtml(v)}" selected>${escapeHtml(v)} (not on this model)</option>` : ''}</select>`;
    }
    case 'number':
      return `<input type="number" id="${id}" value="${escapeHtml(v)}"
        step="${schema.step ?? 1}"
        ${schema.min !== undefined ? `min="${schema.min}"` : ''}
        ${schema.max !== undefined ? `max="${schema.max}"` : ''} />`;
    case 'boolean':
      return `<input type="checkbox" id="${id}" ${v ? 'checked' : ''} />`;
    case 'select':
      return `<select id="${id}">${schema.options
        .map((o) => `<option value="${escapeHtml(o)}" ${o === v ? 'selected' : ''}>${escapeHtml(o)}</option>`)
        .join('')}</select>`;
    case 'level': // next / this / a level's name, with the project's levels as suggestions
      return `<input type="text" id="${id}" value="${escapeHtml(v)}" list="t3-level-names"
        placeholder="next, or a level's name" spellcheck="false" />`;
    case 'sound': // a sound's name, with the scene's sounds as suggestions
      return `<input type="text" id="${id}" value="${escapeHtml(v)}" list="t3-sound-names"
        placeholder="a sound's name" spellcheck="false" />`;
    case 'key':
      return `<button class="bind-btn" id="${id}" data-key="${escapeHtml(v)}"
        title="Click, then press a key or a gamepad button">${escapeHtml(prettyKey(v))}</button>`;
    default:
      return `<input type="text" id="${id}" value="${escapeHtml(v)}" spellcheck="false" />`;
  }
}

/** The name a key or pad button shows as — the Controls panel's names (↓ was shown as "↑ Down"). */
const prettyKey = keyLabel;

/** Read a field's current value back out of the DOM, typed per its schema. */
export function readField(root, id, schema) {
  const el = root.querySelector(`#${CSS.escape(id)}`);
  if (!el) return schema.default;
  if (schema.type === 'boolean') return el.checked;
  if (schema.type === 'stateClips') {
    return coerceProp(schema, [...el.querySelectorAll('.sc-row')].map((row) => ({
      state: row.querySelector('.sc-state').value, clip: row.querySelector('.sc-clip').value, play: row.querySelector('.sc-play').value,
    })).filter((r) => r.state.trim() || r.clip));
  }
  if (schema.type === 'key') return el.dataset.key;
  return coerceProp(schema, el.value);
}

function propsRows(idPrefix, schemaProps, values, ctx = {}) {
  const all = withDefaults(schemaProps, values || {}); // what decides which fields matter
  return Object.entries(schemaProps || {}).map(([name, schema]) => propRow(`${idPrefix}-${name}`, name, schema, values?.[name], all, ctx))
    .join('');
}

/**
 * One field and its label (its hint, if it has one, on hover). A field that
 * doesn't matter for the others' values — "Over (s)" for a turn per second — is
 * there, but hidden.
 */
export function propRow(id, name, schema, value, all, ctx = {}) {
  const label = schema.label || name;
  const shown = fieldShown(schema, all);
  return `
    <div class="prop-row"${shown ? '' : ' style="display:none"'}>
      <label title="${escapeHtml(schema.hint || label)}">${escapeHtml(label)}</label>
      ${fieldHtml(id, schema, value, ctx)}
    </div>`;
}

// ---------------------------------------------------------------- conditions

/**
 * A list of conditions, as the IF of a rule and the ONLY IF of a control show
 * it: in front of each, how it joins the one before — AND, OR, AND NOT, OR NOT
 * (the first: IF or IF NOT) — then its type and fields. AND binds first, so
 * each OR starts a new group, drawn with a line above it: (A and B) or C.
 * `prefix` names its fields; `match` is a list's all / any from before joins.
 */
export function conditionsHtml(prefix, list = [], match = 'all', { tag = 'IF' } = {}) {
  const options = (selected) => Object.entries(CONDITIONS)
    .map(([type, def]) => `<option value="${type}" ${type === selected ? 'selected' : ''}>${escapeHtml(def.label)}</option>`)
    .join('');
  const opt = (value, label, current, title = '') =>
    `<option value="${value}" ${value === current ? 'selected' : ''} ${title ? `title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</option>`;
  const rows = (list || []).map((c, ci) => {
    const def = CONDITIONS[c.type] || CONDITIONS.variable;
    const join = joinOf(c, match);
    const op = ci === 0 ? (c.not ? 'not' : 'yes') : `${join}${c.not ? ' not' : ''}`;
    let choose;
    if (def.cooldown && ci > 0) {
      // a cooldown always holds the whole of it back: its join doesn't matter
      choose = `<span class="gp-if" title="A cooldown holds everything back until its time is up, however it is joined">AND</span>`;
    } else if (ci === 0) {
      choose = `<select class="gp-op" id="${prefix}-${ci}-join" title="IF NOT: true when it isn't">
        ${opt('yes', tag, op)}${opt('not', `${tag} NOT`, op)}</select>`;
    } else {
      choose = `<select class="gp-op" id="${prefix}-${ci}-join" title="How it joins the ones before: AND binds first — (A and B) or C">
        ${opt('and', 'AND', op, 'this one as well')}${opt('or', 'OR', op, 'or else this one (a new group)')}
        ${opt('and not', 'AND NOT', op, 'and this one is not so')}${opt('or not', 'OR NOT', op, 'or else this one is not so (a new group)')}</select>`;
    }
    const group = ci > 0 && join === 'or' && !def.cooldown;
    return `
      <div class="gp-sub${group ? ' gp-or-group' : ''}">
        <div class="gp-head">
          ${choose}
          <select id="${prefix}-${ci}-type">${options(c.type)}</select>
          <button class="gp-x" data-cond-del="${prefix}:${ci}" title="Remove">×</button>
        </div>
        ${propsRows(`${prefix}-${ci}`, def.props, c)}
      </div>`;
  }).join('');
  return rows;
}

/**
 * Wire what conditionsHtml drew. `commit(label, fn, opts)` makes the change:
 * `fn(holder)` edits the rule or control whose `if` these are.
 */
export function wireConditions(root, prefix, list, commit) {
  const $ = (id) => root.querySelector(`#${CSS.escape(id)}`);
  // a list saved as all / any: its joins written out, the first time one is chosen
  const ownJoins = (h) => {
    h.if.forEach((c, i) => { if (i > 0 && !c.join) c.join = joinOf(c, h.match); });
    delete h.match;
  };
  (list || []).forEach((c, ci) => {
    root.querySelector(`[data-cond-del="${CSS.escape(`${prefix}:${ci}`)}"]`)?.addEventListener('click', () => {
      commit('delete condition', (h) => {
        ownJoins(h);
        h.if.splice(ci, 1);
        if (h.if[0]) delete h.if[0].join; // the first joins nothing
      });
    });
    $(`${prefix}-${ci}-type`)?.addEventListener('change', (e) => {
      const type = e.target.value;
      commit('change condition', (h) => {
        const { join, not } = h.if[ci];
        h.if[ci] = { ...withDefaults(CONDITIONS[type].props, { type }), ...(join ? { join } : {}), ...(not ? { not: true } : {}) };
      });
    });
    // its own id: "-op" is a variable condition's compare (>=, <…), and the two were mixed up
    $(`${prefix}-${ci}-join`)?.addEventListener('change', (e) => {
      const value = e.target.value; // yes / not (the first); and / or / and not / or not
      commit('change and / or / not', (h) => {
        ownJoins(h);
        const cond = h.if[ci];
        if (value.endsWith('not')) cond.not = true;
        else delete cond.not;
        if (ci > 0) cond.join = value.startsWith('or') ? 'or' : 'and';
      });
    });
    for (const [name, schema] of Object.entries(CONDITIONS[c.type]?.props || {})) {
      const id = `${prefix}-${ci}-${name}`;
      const el = $(id);
      if (!el) continue;
      if (schema.type === 'key') {
        el.addEventListener('click', () => {
          el.classList.add('listening');
          el.textContent = 'press a key or pad button…';
          captureNextInput((code) => {
            el.classList.remove('listening');
            if (!code) { el.textContent = prettyKey(el.dataset.key); return; }
            commit('bind key', (h) => { h.if[ci][name] = code; });
          });
        });
        continue;
      }
      el.addEventListener('change', () => {
        commit(`edit ${name}`, (h) => { h.if[ci][name] = readField(root, id, schema); },
          { rerender: drivesFields(CONDITIONS[c.type]?.props, name) });
      });
    }
  });
}

// ---------------------------------------------------------------- undo

function snapshot(editor, entity) {
  const g = editor.engine.gameplay;
  return {
    components: g.components.serializeFor(entity) ?? [],
    rules: g.rules.serializeFor(entity) ?? [],
  };
}

function restore(editor, entity, snap) {
  const g = editor.engine.gameplay;
  g.components.clearEntity(entity);
  g.rules.clearEntity(entity);
  for (const c of snap.components) g.components.add(entity, c.type, c.props);
  g.rules.setFor(entity, JSON.parse(JSON.stringify(snap.rules)));
  editor._renderInspector();
}

/**
 * Apply a change and make it undoable. Everything here edits the same two lists,
 * so snapshotting them wholesale is both simpler and more reliable than trying to
 * record each field individually.
 */
function edit(editor, entity, label, mutate, { rerender = true } = {}) {
  const before = snapshot(editor, entity);
  mutate();
  const after = snapshot(editor, entity);
  editor.history?.push({
    label,
    undo: () => restore(editor, entity, before),
    redo: () => restore(editor, entity, after),
  });
  if (rerender) editor._renderInspector();
}

// ---------------------------------------------------------------- components

export function componentsSection(editor, entity) {
  const list = editor.engine.gameplay.components.listFor(entity);
  const clips = clipNames(entity.object3D); // clip fields list this model's own clips
  refreshClipNames(editor.engine);
  const options = Object.entries(COMPONENTS)
    .map(([type, def]) => `<option value="${type}">${escapeHtml(def.label)}</option>`)
    .join('');

  const cards = list.map((c, i) => `
    <div class="gp-card" data-comp="${i}">
      <div class="gp-head">
        <span class="gp-title">${escapeHtml(c.def.label)}</span>
        <button class="gp-x" data-comp-del="${i}" title="Remove">×</button>
      </div>
      ${c.def.hint ? `<div class="gp-hint">${escapeHtml(c.def.hint)}</div>` : ''}
      ${propsRows(`cmp-${i}`, c.def.props, c.props, { clips })}
    </div>`).join('');

  return `
    <h4 class="insp-h">Components</h4>
    ${cards || '<div class="empty">No components yet.</div>'}
    <div class="prop-row" style="margin-top:6px">
      <label>Add</label>
      <select id="cmp-add"><option value="">choose…</option>${options}</select>
    </div>`;
}

export function wireComponentsSection(editor, entity) {
  const root = editor.inspectorEl;
  const runtime = editor.engine.gameplay.components;

  root.querySelector('#cmp-add')?.addEventListener('change', (e) => {
    const type = e.target.value;
    if (!type) return;
    edit(editor, entity, `add ${type}`, () => runtime.add(entity, type, defaultProps(type)));
  });

  runtime.listFor(entity).forEach((c, i) => {
    root.querySelector(`[data-comp-del="${i}"]`)?.addEventListener('click', () => {
      edit(editor, entity, `remove ${c.type}`, () => runtime.remove(c));
    });

    for (const [name, schema] of Object.entries(c.def.props)) {
      const id = `cmp-${i}-${name}`;
      const el = root.querySelector(`#${CSS.escape(id)}`);
      if (!el) continue;
      // a pick from a list or a tick redraws the Inspector, so everything that
      // shows it agrees (the Animator's standing clip is also "Plays on its own");
      // typed fields don't, so the cursor stays where it was
      // (and a field drawn in the view — how far it sees — redraws it)
      const redraw = ['select', 'clip', 'boolean'].includes(schema.type) || drivesFields(c.def.props, name);
      wireField(editor, entity, el, schema, root, id, `${c.type}.${name}`, (value) => {
        c.props[name] = value;
      }, redraw);
    }
  });
}

// ---------------------------------------------------------------- rules

export function rulesSection(editor, entity) {
  const rules = editor.engine.gameplay.rules.listFor(entity);

  const eventOptions = (selected) => Object.entries(EVENTS)
    .map(([type, def]) => `<option value="${type}" ${type === selected ? 'selected' : ''}>${escapeHtml(def.label)}</option>`)
    .join('');
  const actionOptions = (selected) => Object.entries(ACTIONS)
    .map(([type, def]) => `<option value="${type}" ${type === selected ? 'selected' : ''}>${escapeHtml(def.label)}</option>`)
    .join('');
  const cards = rules.map((rule, r) => {
    const eventDef = EVENTS[rule.when?.type] || EVENTS.start;
    const conditions = conditionsHtml(`rule-${r}-if`, rule.if, rule.match);
    const actionRows = (list, key, tag) => (list || []).map((a, ai) => {
      const def = ACTIONS[a.type] || ACTIONS.log;
      return `
        <div class="gp-sub${key === 'else' ? ' gp-else' : ''}">
          <div class="gp-head">
            <span class="gp-do">${tag}</span>
            <select id="rule-${r}-${key}-${ai}-type">${actionOptions(a.type)}</select>
            <button class="gp-x" data-act-del="${r}:${key}:${ai}" title="Remove">×</button>
          </div>
          ${propsRows(`rule-${r}-${key}-${ai}`, def.props, a, { clips: !a.target || a.target === 'self' ? clipNames(entity.object3D) : null })}
          ${onceWarning(rule, a, r)}
        </div>`;
    }).join('');
    const actions = actionRows(rule.do, 'do', 'DO') + actionRows(rule.else, 'else', 'ELSE');

    return `
      <div class="gp-card gp-rule">
        <div class="gp-head">
          <span class="gp-when">WHEN</span>
          <select id="rule-${r}-when-type">${eventOptions(rule.when?.type)}</select>
          <button class="gp-x" data-rule-del="${r}" title="Delete rule">×</button>
        </div>
        ${propsRows(`rule-${r}-when`, eventDef.props, rule.when, { parts: partRoles(entity).filter((p) => p.role !== 'none') })}
        ${conditions}
        ${actions}
        <div class="insp-row" style="margin-top:6px">
          <button class="tbtn" data-cond-add="${r}" title="Only do it if… (and / or / not)">+ Condition</button>
          <button class="tbtn" data-act-add="${r}">+ Action</button>
          <button class="tbtn" data-else-add="${r}" title="What to do when the conditions don't hold">+ Else</button>
        </div>
      </div>`;
  }).join('');

  return `
    <h4 class="insp-h">Rules</h4>
    <div class="gp-legend">When something happens — if its conditions hold — do something; else, something else.</div>
    ${cards || '<div class="empty">No rules yet.</div>'}
    <div class="insp-row" style="margin-top:6px">
      <button class="tbtn" id="rule-add">+ Rule</button>
    </div>`;
}

/**
 * A Move, or a turn / scale "per second", does a frame's worth each time its
 * rule runs: set off once (a key pressed, a click, something entering), it
 * barely moves. Say so — and, for a key or button, offer to run it while held.
 */
function onceWarning(rule, action, r) {
  if (!actsPerFrame(action) || keepsRunning(rule.when)) return '';
  const what = action.type === 'move' ? 'Move keeps moving it'
    : action.type === 'scale' ? 'Times per second keeps scaling it' : 'Per second keeps turning it';
  const input = rule.when?.type === 'key' || rule.when?.type === 'mouse';
  const instead = action.type === 'move' ? 'Move object' : action.type === 'scale' ? 'How: times, with Over (s)' : 'How: by, with Over (s)';
  return `
    <div class="gp-warn" id="rule-${r}-warn">⚠ ${what} only while the rule keeps running — set off once, it barely does.
      ${input ? `<button class="tbtn" data-held-fix="${r}" title="WHEN: while the key or button is held">Do it while held</button>`
    : 'Set it off with <b>Every 0 seconds</b> or a key held,'} or use <b>${instead}</b>.</div>`;
}

export function wireRulesSection(editor, entity) {
  const root = editor.inspectorEl;
  const runtime = editor.engine.gameplay.rules;
  const rules = () => runtime.listFor(entity);
  const commit = (label, mutate, opts) =>
    edit(editor, entity, label, () => {
      const next = JSON.parse(JSON.stringify(rules()));
      mutate(next);
      runtime.setFor(entity, next);
    }, opts);

  root.querySelector('#rule-add')?.addEventListener('click', () => {
    commit('add rule', (list) => list.push(blankRule()));
  });

  rules().forEach((rule, r) => {
    root.querySelector(`[data-rule-del="${r}"]`)?.addEventListener('click', () => {
      commit('delete rule', (list) => list.splice(r, 1));
    });
    root.querySelector(`[data-cond-add="${r}"]`)?.addEventListener('click', () => {
      commit('add condition', (list) => {
        list[r].if = list[r].if || [];
        // a new one joins with AND — or, in a list saved as "any", with OR
        const join = list[r].if.length ? { join: list[r].match === 'any' ? 'or' : 'and' } : {};
        list[r].if.push({ ...withDefaults(CONDITIONS.variable.props, { type: 'variable' }), ...join });
      });
    });
    root.querySelector(`[data-act-add="${r}"]`)?.addEventListener('click', () => {
      commit('add action', (list) => {
        list[r].do = list[r].do || [];
        list[r].do.push(withDefaults(ACTIONS.log.props, { type: 'log' }));
      });
    });
    root.querySelector(`[data-else-add="${r}"]`)?.addEventListener('click', () => {
      commit('add else action', (list) => {
        list[r].else = list[r].else || [];
        list[r].else.push(withDefaults(ACTIONS.showMessage.props, { type: 'showMessage' }));
      });
    });

    root.querySelector(`[data-held-fix="${r}"]`)?.addEventListener('click', () => {
      commit('run while held', (list) => { list[r].when.mode = 'held'; });
    });

    // changing an event/action/condition type swaps in that type's default props
    root.querySelector(`#rule-${r}-when-type`)?.addEventListener('change', (e) => {
      const type = e.target.value;
      commit('change event', (list) => {
        list[r].when = withDefaults(EVENTS[type].props, { type });
      });
    });

    wireConditions(root, `rule-${r}-if`, rule.if, (label, fn, opts) => commit(label, (list) => {
      list[r].if = list[r].if || [];
      fn(list[r]);
    }, opts));

    for (const key of ['do', 'else']) {
      (rule[key] || []).forEach((action, ai) => {
        root.querySelector(`[data-act-del="${r}:${key}:${ai}"]`)?.addEventListener('click', () => {
          commit('delete action', (list) => {
            list[r][key].splice(ai, 1);
            if (key === 'else' && !list[r].else.length) delete list[r].else;
          });
        });
        root.querySelector(`#rule-${r}-${key}-${ai}-type`)?.addEventListener('change', (e) => {
          const type = e.target.value;
          commit('change action', (list) => {
            list[r][key][ai] = withDefaults(ACTIONS[type].props, { type });
          });
        });
        wireProps(editor, entity, root, `rule-${r}-${key}-${ai}`, ACTIONS[action.type]?.props, (name, v) => {
          // "How" drawn again: the fields that matter for it
          commit('edit action', (list) => { list[r][key][ai][name] = v; }, { rerender: drivesFields(ACTIONS[action.type]?.props, name) });
        });
      });
    }

    wireProps(editor, entity, root, `rule-${r}-when`, EVENTS[rule.when?.type]?.props, (name, v) => {
      // drawn again for its fields — and for a Move's or a turn per second's warning (pressed or held)
      commit('edit event', (list) => { list[r].when[name] = v; },
        { rerender: name === 'mode' || drivesFields(EVENTS[rule.when?.type]?.props, name) });
    });
  });
}

function wireProps(editor, entity, root, prefix, schemaProps, onChange) {
  for (const [name, schema] of Object.entries(schemaProps || {})) {
    const id = `${prefix}-${name}`;
    const el = root.querySelector(`#${CSS.escape(id)}`);
    if (!el) continue;
    wireField(editor, entity, el, schema, root, id, name, (value) => onChange(name, value));
  }
}

/** Attach the right listener for a field type, including click-to-bind keys. */
function wireField(editor, entity, el, schema, root, id, label, apply, rerender = false) {
  if (schema.type === 'key') {
    el.addEventListener('click', () => {
      el.classList.add('listening');
      el.textContent = 'press a key or pad button…';
      captureNextInput((code) => {
        el.classList.remove('listening');
        if (!code) { el.textContent = prettyKey(el.dataset.key); return; } // Esc: as it was
        el.dataset.key = code;
        el.textContent = prettyKey(code);
        edit(editor, entity, `bind ${label}`, () => apply(code), { rerender: false });
      });
    });
    return;
  }

  const event = schema.type === 'boolean' || schema.type === 'select' ? 'change' : 'change';
  el.addEventListener(event, () => {
    edit(editor, entity, `edit ${label}`, () => apply(readField(root, id, schema)), { rerender });
  });
}
