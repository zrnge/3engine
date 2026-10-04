import {
  CONTROL_ACTIONS, ACTION_GROUPS, INPUT_TYPES, MOUSE_BUTTONS,
  blankControl, blankInput, keyLabel, isPadCode,
} from './controls.js';
import { captureNextInput } from './input.js';
import { propRow, readField, refreshClipNames, conditionsHtml, wireConditions } from './inspector-gameplay.js';
import { CONDITIONS, ACTIONS as RULE_ACTIONS, withDefaults, drivesFields } from './rules.js';
import { clipNames } from './animation.js';
import { escapeHtml } from './ui.js';

/**
 * The Controls panel: one card per control.
 *
 *   INPUT  ⌨ W ×   ⌨ ↑ ×   ▣ ▲ ×        (+ Key  + Mouse  + Screen button)
 *   DO     [Move ▾]
 *   Who    [Player ▾]
 *   ...the action's own fields
 *   ONLY IF    its conditions (rules.js): all / any, each maybe "not" —
 *              pressed while they don't hold, it is as if it weren't
 *
 * Every edit goes through `commit`, which snapshots the whole list, so undo and
 * redo are exact.
 */
export function wireControlsPanel({ engine, editor, history, listEl, addBtn, onChange = () => {} }) {
  const runtime = engine.gameplay.controls;
  let stopListening = null;

  function commit(label, mutate, { rerender = true } = {}) {
    const before = runtime.toJSON();
    const next = runtime.toJSON();
    mutate(next);
    runtime.load(next);
    const after = runtime.toJSON();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      history?.push({
        label,
        undo: () => { runtime.load(before); render(); onChange(); },
        redo: () => { runtime.load(after); render(); onChange(); },
      });
      onChange();
    }
    if (rerender) render();
  }

  // ---------------------------------------------------------------- html

  function targetOptions(selected) {
    const names = [];
    for (const e of editor.selectables) {
      const n = e.object3D?.name;
      if (n && !e.object3D.isLight && !names.includes(n)) names.push(n);
    }
    // a renamed or deleted target stays visible instead of silently changing
    if (selected !== 'player' && !names.includes(selected)) names.unshift(selected);
    const playerName = engine.player?.target?.object3D?.name;
    return [
      `<option value="player" ${selected === 'player' ? 'selected' : ''}>Player${playerName ? ` (${escapeHtml(playerName)})` : ''}</option>`,
      ...names.map((n) => `<option value="${escapeHtml(n)}" ${n === selected ? 'selected' : ''}>${escapeHtml(n)}</option>`),
    ].join('');
  }

  /** The clips of the model a control acts on — what its clip field lists. */
  function clipsFor(control) {
    const a = control.action;
    const who = a.target && a.target !== 'self' ? a.target : control.target;
    const e = who === 'player' ? engine.playerEntity : editor.selectables.find((x) => x.object3D?.name === who);
    return e ? clipNames(e.object3D) : [];
  }

  function actionOptions(selected) {
    return ACTION_GROUPS.map((group) => {
      const items = Object.entries(CONTROL_ACTIONS)
        .filter(([, def]) => def.group === group)
        .map(([type, def]) => `<option value="${type}" ${type === selected ? 'selected' : ''}>${escapeHtml(def.label)}</option>`)
        .join('');
      return `<optgroup label="${group}">${items}</optgroup>`;
    }).join('');
  }

  function chipHtml(input, ci, ii) {
    const where = `${ci}:${ii}`;
    const icon = `<span class="ctl-ico">${INPUT_TYPES[input.type].icon}</span>`;
    const del = `<button class="gp-x" data-input-del="${where}" title="Remove this input">×</button>`;
    if (input.type === 'mouse') {
      const opts = MOUSE_BUTTONS.map((b) => `<option value="${b}" ${b === input.button ? 'selected' : ''}>${b}</option>`).join('');
      return `<span class="ctl-chip" title="Mouse button">${icon}<select data-mouse="${where}">${opts}</select>${del}</span>`;
    }
    if (input.type === 'screen') {
      return `<span class="ctl-chip" title="On-screen button: its label">${icon}<input type="text" data-screen="${where}"
        value="${escapeHtml(input.label)}" maxlength="10" spellcheck="false" />${del}</span>`;
    }
    const pad = isPadCode(input.code);
    return `<span class="ctl-chip" title="${pad ? 'Gamepad' : 'Keyboard key'} — click, then press a key or a pad button">${
      pad ? '<span class="ctl-ico">🎮</span>' : icon}<button class="bind-btn"
      data-key-bind="${where}">${escapeHtml(keyLabel(input.code))}</button>${del}</span>`;
  }

  function cardHtml(control, ci) {
    const type = control.action.type;
    const def = CONTROL_ACTIONS[type];
    const chips = control.inputs.map((input, ii) => chipHtml(input, ci, ii)).join('');
    const all = withDefaults(def.props, control.action);
    const props = Object.entries(def.props || {})
      .map(([name, schema]) => propRow(`ctl-${ci}-${name}`, name, schema, control.action[name], all, { clips: clipsFor(control) }))
      .join('');
    const adds = Object.entries(INPUT_TYPES)
      .map(([t, d]) => `<button class="tbtn" data-input-add="${ci}:${t}">+ ${escapeHtml(d.label)}</button>`)
      .join('');

    return `
      <div class="gp-card ctl-card" data-ctl="${ci}">
        <div class="gp-head">
          <span class="gp-when">INPUT</span>
          <span class="ctl-num">#${ci + 1}</span>
          <button class="gp-x" data-ctl-del="${ci}" title="Delete this control">×</button>
        </div>
        <div class="ctl-chips">${chips || '<span class="empty">No input yet — add one:</span>'}</div>
        <div class="ctl-add-input">${adds}</div>
        <div class="gp-head ctl-do">
          <span class="gp-do">DO</span>
          <select id="ctl-${ci}-type" title="What this control does">${actionOptions(type)}</select>
          ${def.hint ? `<span class="ctl-info" title="${escapeHtml(def.hint)}">ⓘ</span>` : ''}
        </div>
        <div class="prop-row">
          <label title="Which object it acts on">Who</label>
          <select id="ctl-${ci}-who">${targetOptions(control.target)}</select>
        </div>
        ${props}
        <div class="ctl-only">
          ${conditionsHtml(`ctl-${ci}-if`, control.if || [], control.match, { tag: 'ONLY IF' })}
          <button class="tbtn" data-only-add="${ci}" title="Only if… — on the ground, a variable, a key held, near something, a cooldown… (and / or / not)">+ Only if…</button>
          ${branchesHtml(control, `ctl-${ci}`, `${ci}`)}
        </div>
        ${stepsHtml(control, ci)}
      </div>`;
  }

  /**
   * An Only if's own Do's (BRANCHES): "if yes, do" — when its conditions hold —
   * and "if not, do" — when they don't. Its buttons show once it has a condition.
   * `base` prefixes the ids; `path` is "ci" (the control) or "ci:mi" (a further Do).
   */
  function branchesHtml(owner, base, path) {
    const rows = (kind, tag, title) => (owner[kind] || []).map((sub, k) => {
      const def = RULE_ACTIONS[sub.action.type];
      const all = withDefaults(def.props, sub.action);
      const id = (name) => `${base}-${kind[0]}${k}-${name}`;
      const props = Object.entries(def.props || {})
        .map(([name, schema]) => propRow(id(name), name, schema, sub.action[name], all, {}))
        .join('');
      return `
        <div class="gp-sub ctl-branch ctl-branch-${kind}">
          <div class="gp-head">
            <span class="gp-do" title="${title}">${tag}</span>
            <select id="${id('type')}" title="What it does: any action a rule can do">${stepOptions(sub.action.type)}</select>
            <button class="gp-x" data-branch-del="${path}|${kind}|${k}" title="Remove this Do">×</button>
          </div>
          <div class="prop-row"><label title="How long after (0: at once)">After (s)</label>
            <input type="number" id="${id('after')}" min="0" max="600" step="0.1" value="${sub.after ?? 0}" /></div>
          ${props}
        </div>`;
    }).join('');
    const yes = rows('yes', 'IF YES, DO', 'When its Only if holds');
    const no = rows('no', 'IF NOT, DO', 'When its Only if does not hold');
    const buttons = (owner.if || []).length ? `<div class="ctl-branch-add">
      <button class="tbtn" data-branch-add="${path}|yes" title="Something more to do when this Only if holds">+ If yes, do</button>
      <button class="tbtn" data-branch-add="${path}|no" title="Something to do when it does not hold instead — say why, play a click…">+ If not, do</button></div>` : '';
    return yes + no + buttons;
  }

  /** Any rule action, for a further Do. */
  function stepOptions(selected) {
    return Object.entries(RULE_ACTIONS)
      .map(([type, def]) => `<option value="${type}" ${type === selected ? 'selected' : ''}>${escapeHtml(def.label)}</option>`)
      .join('');
  }

  /**
   * A control's further Do's (+ Do), each joined to the ones before it:
   * AND at the same moment, THEN after a wait, OR otherwise — each with its own Only if.
   */
  function stepsHtml(control, ci) {
    const rows = (control.more || []).map((st, mi) => {
      const def = RULE_ACTIONS[st.action.type];
      const all = withDefaults(def.props, st.action);
      const id = (name) => `ctl-${ci}-m${mi}-${name}`;
      const props = Object.entries(def.props || {})
        .map(([name, schema]) => propRow(id(name), name, schema, st.action[name], all, { clips: clipsFor(control) }))
        .join('');
      const opt = (v, label, title) => `<option value="${v}" ${st.join === v ? 'selected' : ''} title="${title}">${label}</option>`;
      return `
        <div class="gp-sub ctl-step${st.join === 'or' ? ' gp-or-group' : ''}">
          <div class="gp-head">
            <select class="gp-op" id="${id('join')}" title="How it follows the Do before it">
              ${opt('and', 'AND', 'Also, at the same moment')}${opt('then', 'THEN', 'Also, after a wait')}${opt('or', 'OR', 'Otherwise: only if nothing before it happened (its Only if did not hold)')}
            </select>
            <span class="gp-do">DO</span>
            <select id="${id('type')}" title="What it does: any action a rule can do">${stepOptions(st.action.type)}</select>
            <button class="gp-x" data-step-del="${ci}:${mi}" title="Remove this Do">×</button>
          </div>
          ${st.join === 'then' ? `<div class="prop-row"><label title="How long after the Do before it (THENs add up)">After (s)</label>
            <input type="number" id="${id('after')}" min="0" max="600" step="0.1" value="${st.after ?? 0.5}" /></div>` : ''}
          ${props}
          <div class="ctl-only">
            ${conditionsHtml(`ctl-${ci}-m${mi}-if`, st.if || [], null, { tag: 'ONLY IF' })}
            <button class="tbtn" data-step-if-add="${ci}:${mi}" title="This Do only if… (and / or / not)">+ Only if…</button>
            ${branchesHtml(st, `ctl-${ci}-m${mi}`, `${ci}:${mi}`)}
          </div>
        </div>`;
    }).join('');
    return `<div class="ctl-steps">${rows}
      <button class="tbtn" data-step-add="${ci}" title="Do more: AND at the same moment, THEN after a wait, OR otherwise (when nothing before it happened)">+ Do</button></div>`;
  }

  // ---------------------------------------------------------------- wiring

  const at = (s) => s.split(':').map(Number);

  /** Click a key chip, then press any key — or a gamepad button, or push a stick. Esc cancels. */
  function listen(btn) {
    stopListening?.();
    const [ci, ii] = at(btn.dataset.keyBind);
    btn.classList.add('listening');
    btn.textContent = 'press a key or pad button…';
    const done = () => {
      btn.classList.remove('listening');
      stopListening = null;
    };
    const stop = captureNextInput((code) => {
      done();
      if (!code) { render(); return; }
      commit('bind key', (list) => { list[ci].inputs[ii].code = code; });
    });
    stopListening = () => { stop(); done(); };
  }

  function wire() {
    const all = (sel) => listEl.querySelectorAll(sel);

    all('[data-ctl-del]').forEach((b) => b.addEventListener('click', () => {
      const ci = Number(b.dataset.ctlDel);
      commit('delete control', (list) => list.splice(ci, 1));
    }));
    all('[data-input-add]').forEach((b) => b.addEventListener('click', () => {
      const [ci, type] = b.dataset.inputAdd.split(':');
      const index = Number(ci);
      const ii = runtime.list[index].inputs.length;
      commit(`add ${type} input`, (list) => list[index].inputs.push(blankInput(type)));
      // a new key chip starts out listening, so it is one click, not two
      if (type === 'key') {
        const chip = listEl.querySelector(`[data-key-bind="${index}:${ii}"]`);
        if (chip) listen(chip);
      }
    }));
    all('[data-input-del]').forEach((b) => b.addEventListener('click', () => {
      const [ci, ii] = at(b.dataset.inputDel);
      commit('remove input', (list) => list[ci].inputs.splice(ii, 1));
    }));
    all('[data-key-bind]').forEach((b) => b.addEventListener('click', () => listen(b)));
    all('[data-mouse]').forEach((s) => s.addEventListener('change', () => {
      const [ci, ii] = at(s.dataset.mouse);
      commit('change mouse button', (list) => { list[ci].inputs[ii].button = s.value; }, { rerender: false });
    }));
    all('[data-screen]').forEach((inp) => inp.addEventListener('change', () => {
      const [ci, ii] = at(inp.dataset.screen);
      commit('rename screen button', (list) => {
        list[ci].inputs[ii].label = inp.value.trim() || 'A';
      }, { rerender: false });
    }));

    all('[data-only-add]').forEach((b) => b.addEventListener('click', () => {
      const ci = Number(b.dataset.onlyAdd);
      commit('add condition', (list) => {
        list[ci].if = list[ci].if || [];
        const join = list[ci].if.length ? { join: 'and' } : {};
        list[ci].if.push({ ...withDefaults(CONDITIONS.variable.props, { type: 'variable' }), ...join });
      });
    }));

    // further Do's (+ Do)
    all('[data-step-add]').forEach((b) => b.addEventListener('click', () => {
      const ci = Number(b.dataset.stepAdd);
      commit('add a Do', (list) => {
        (list[ci].more ||= []).push({ join: 'and', action: withDefaults(RULE_ACTIONS.showMessage.props, { type: 'showMessage' }) });
      });
    }));
    all('[data-step-del]').forEach((b) => b.addEventListener('click', () => {
      const [ci, mi] = at(b.dataset.stepDel);
      commit('remove a Do', (list) => { list[ci].more.splice(mi, 1); });
    }));
    all('[data-step-if-add]').forEach((b) => b.addEventListener('click', () => {
      const [ci, mi] = at(b.dataset.stepIfAdd);
      commit('add condition', (list) => {
        const st = list[ci].more[mi];
        st.if = st.if || [];
        const join = st.if.length ? { join: 'and' } : {};
        st.if.push({ ...withDefaults(CONDITIONS.variable.props, { type: 'variable' }), ...join });
      });
    }));

    // an Only if's own Do's: "ci" is the control's, "ci:mi" a further Do's
    const ownerOf = (list, path) => {
      const [ci, mi] = path.split(':').map(Number);
      return Number.isInteger(mi) ? list[ci].more[mi] : list[ci];
    };
    all('[data-branch-add]').forEach((b) => b.addEventListener('click', () => {
      const [path, kind] = b.dataset.branchAdd.split('|');
      commit(kind === 'yes' ? 'add an if-yes Do' : 'add an if-not Do', (list) => {
        (ownerOf(list, path)[kind] ||= []).push({ action: withDefaults(RULE_ACTIONS.showMessage.props, { type: 'showMessage' }) });
      });
    }));
    all('[data-branch-del]').forEach((b) => b.addEventListener('click', () => {
      const [path, kind, k] = b.dataset.branchDel.split('|');
      commit('remove a Do', (list) => {
        const owner = ownerOf(list, path);
        owner[kind].splice(Number(k), 1);
        if (!owner[kind].length) delete owner[kind];
      });
    }));
    const wireBranches = (owner, base, path) => {
      for (const kind of ['yes', 'no']) {
        (owner[kind] || []).forEach((sub, k) => {
          const id = (name) => `${base}-${kind[0]}${k}-${name}`;
          const el = (name) => listEl.querySelector(`#${CSS.escape(id(name))}`);
          const edit = (label, fn, opts) => commit(label, (list) => fn(ownerOf(list, path)[kind][k]), opts);
          el('type')?.addEventListener('change', (e) => edit('change a Do', (d) => { d.action = { type: e.target.value }; }));
          el('after')?.addEventListener('change', (e) => edit('wait', (d) => { d.after = Number(e.target.value) || 0; }, { rerender: false }));
          const props = RULE_ACTIONS[sub.action.type]?.props || {};
          for (const [name, schema] of Object.entries(props)) {
            el(name)?.addEventListener('change', () => edit(`edit ${name}`, (d) => { d.action[name] = readField(listEl, id(name), schema); },
              { rerender: drivesFields(props, name) }));
          }
        });
      }
    };

    runtime.list.forEach((control, ci) => {
      wireBranches(control, `ctl-${ci}`, `${ci}`);
      (control.more || []).forEach((st, mi) => {
        wireBranches(st, `ctl-${ci}-m${mi}`, `${ci}:${mi}`);
        const id = (name) => `ctl-${ci}-m${mi}-${name}`;
        const el = (name) => listEl.querySelector(`#${CSS.escape(id(name))}`);
        el('join')?.addEventListener('change', (e) => {
          commit('and / then / or', (list) => {
            const s = list[ci].more[mi];
            s.join = e.target.value;
            if (s.join === 'then' && s.after === undefined) s.after = 0.5;
          });
        });
        el('type')?.addEventListener('change', (e) => {
          commit('change a Do', (list) => { list[ci].more[mi].action = { type: e.target.value }; });
        });
        el('after')?.addEventListener('change', (e) => {
          commit('wait', (list) => { list[ci].more[mi].after = Number(e.target.value) || 0; }, { rerender: false });
        });
        const props = RULE_ACTIONS[st.action.type]?.props || {};
        for (const [name, schema] of Object.entries(props)) {
          el(name)?.addEventListener('change', () => {
            commit(`edit ${name}`, (list) => { list[ci].more[mi].action[name] = readField(listEl, id(name), schema); },
              { rerender: drivesFields(props, name) });
          });
        }
        wireConditions(listEl, `ctl-${ci}-m${mi}-if`, st.if, (label, fn, opts) => commit(label, (list) => {
          const s = list[ci].more[mi];
          s.if = s.if || [];
          fn(s);
        }, opts));
      });
      wireConditions(listEl, `ctl-${ci}-if`, control.if, (label, fn, opts) => commit(label, (list) => {
        list[ci].if = list[ci].if || [];
        fn(list[ci]);
      }, opts));
      listEl.querySelector(`#ctl-${ci}-type`)?.addEventListener('change', (e) => {
        const type = e.target.value; // the loader fills in that action's defaults
        commit('change control action', (list) => { list[ci].action = { type }; });
      });
      listEl.querySelector(`#ctl-${ci}-who`)?.addEventListener('change', (e) => {
        // re-drawn: a clip field lists the new target's clips
        commit('change control target', (list) => { list[ci].target = e.target.value; });
      });
      for (const [name, schema] of Object.entries(CONTROL_ACTIONS[control.action.type].props || {})) {
        const id = `ctl-${ci}-${name}`;
        const el = listEl.querySelector(`#${CSS.escape(id)}`);
        el?.addEventListener('change', () => {
          commit(`edit ${name}`, (list) => {
            list[ci].action[name] = readField(listEl, id, schema);
          }, { rerender: name === 'target' || drivesFields(CONTROL_ACTIONS[control.action.type].props, name) });
        });
      }
    });
  }

  function render() {
    stopListening?.();
    refreshClipNames(engine);
    const list = runtime.list;
    listEl.innerHTML = list.length
      ? list.map(cardHtml).join('')
      : '<div class="empty">No controls — nothing responds to input yet.</div>';
    wire();
  }

  addBtn?.addEventListener('click', () => {
    commit('add control', (list) => list.push(blankControl()));
    listEl.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
  });

  render();
  return { render };
}
