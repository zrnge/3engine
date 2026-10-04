/**
 * The Screens panel — the game's own interface, designed: screens (menus, an
 * inventory, a map, a shop) made of text, buttons, lists and bars, each with a
 * preview drawn as the game draws it; and dialogues, lines and choices, tried
 * out in place by clicking through them.
 *
 * What it edits is engine.ui.screens and engine.ui.dialogues (screens.js),
 * saved with the game. Rules and controls open them: Show / hide a screen,
 * Start a dialogue; and answer them: A button is pressed, An item is picked,
 * A dialogue ends.
 */
import { escapeHtml } from '../editor.js';
import { injectStyle as injectOverlayStyle } from '../play-overlay.js';
import {
  normalizeScreen, normalizeItem, normalizeDialogue, normalizeLine, normalizeChoice,
  screenHtml, dialogueHtml, lineAfter, SCREEN_PLACES, ITEM_TYPES, ITEM_LABELS, BUTTON_DOES,
} from '../screens.js';
import { formatText, varScope, problemIn } from '../expr.js';

const esc = escapeHtml;

export function wireScreensPanel(app) {
  const { engine, history } = app;
  const body = document.getElementById('screens-body');
  if (!body) return;
  let tab = 'screens';
  let si = 0;      // the screen shown
  let di = 0;      // the dialogue shown
  let tryLine = 0; // the dialogue's line in its preview

  const ui = () => engine.ui;
  const screens = () => ui().screens;
  const dialogues = () => ui().dialogues;

  /** A change, undoable: the screens and dialogues before and after it. */
  function commit(label, mutate, { redraw = true } = {}) {
    const snap = () => JSON.stringify({ s: screens(), d: dialogues() });
    const before = snap();
    mutate();
    const after = snap();
    if (before === after) return;
    const put = (json) => {
      const { s, d } = JSON.parse(json);
      engine.ui.screens = s.map(normalizeScreen);
      engine.ui.dialogues = d.map(normalizeDialogue);
      render();
      app.markDirty();
    };
    history.push({ label, undo: () => put(before), redo: () => put(after) });
    app.refreshHistoryButtons?.();
    app.markDirty();
    if (redraw) render();
    else drawPreview();
  }

  const uniqueName = (list, base) => {
    let name = base;
    for (let n = 2; list.some((x) => x.name.toLowerCase() === name.toLowerCase()); n++) name = `${base} ${n}`;
    return name;
  };

  // ---------------------------------------------------------------- fields

  const opts = (values, v, labels = {}) => values.map((o) =>
    `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(labels[o] ?? o)}</option>`).join('');
  const text = (path, v, label, extra = '') => `<div class="prop-row"><label>${esc(label)}</label>
    <input type="text" data-p="${path}" value="${esc(v)}" spellcheck="false" ${extra} /></div>`;
  const number = (path, v, label, min, max, step = 1) => `<div class="prop-row"><label>${esc(label)}</label>
    <input type="number" data-p="${path}" value="${esc(v)}" min="${min}" max="${max}" step="${step}" /></div>`;
  const select = (path, values, v, label, labels) => `<div class="prop-row"><label>${esc(label)}</label>
    <select data-p="${path}">${opts(values, v, labels)}</select></div>`;
  const check = (path, v, label, title = '') => `<label class="check-row" title="${esc(title)}"><input type="checkbox" data-p="${path}" ${v ? 'checked' : ''} /> ${esc(label)}</label>`;
  const nameList = (list, v, none) => `<option value="" ${v ? '' : 'selected'}>${esc(none)}</option>${list.map((x) =>
    `<option value="${esc(x.name)}" ${x.name === v ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}`;

  // ---------------------------------------------------------------- screens

  function itemFields(it, ii) {
    const p = (k) => `i:${ii}:${k}`;
    if (it.type === 'text') {
      return `<div class="prop-row"><label title="{score}, {len(inventory)}: worked out as it plays">Text</label>
        <textarea data-p="${p('text')}" rows="2" spellcheck="false">${esc(it.text)}</textarea></div>
        ${number(p('size'), it.size, 'Size', 8, 96)}
        ${select(p('align'), ['left', 'center', 'right'], it.align, 'Align')}`;
    }
    if (it.type === 'button') {
      const does = it.does;
      return `${text(p('label'), it.label, 'Label')}
        ${select(p('does'), BUTTON_DOES, does, 'Does')}
        ${does === 'open a screen' || does === 'close a screen' ? `<div class="prop-row"><label>Screen</label>
          <select data-p="${p('screen')}">${nameList(screens(), it.screen, does === 'close a screen' ? 'all of them' : '— choose —')}</select></div>` : ''}
        ${does === 'start a dialogue' ? `<div class="prop-row"><label>Dialogue</label>
          <select data-p="${p('dialogue')}">${nameList(dialogues(), it.dialogue, '— choose —')}</select></div>` : ''}
        ${does === 'send an event' ? text(p('event'), it.event, 'Event', 'title="To every object with an &quot;I receive an event&quot; rule for it"') : ''}
        <div class="prop-row"><label title="A key that presses it too (while the screen is up)">Key</label>
          <input type="text" data-p="${p('key')}" value="${esc(it.key)}" placeholder="Digit1, KeyY, Enter…" spellcheck="false" /></div>
        <div class="gp-hint">Every button also runs the rules <b>A button is pressed</b> for “${esc(screens()[si]?.name)}” · “${esc(it.label)}”.</div>`;
    }
    if (it.type === 'list') {
      return `${text(p('variable'), it.variable, 'Shows the list', 'title="A variable holding a list: an inventory"')}
        ${number(p('columns'), it.columns, 'Columns', 1, 8)}
        ${text(p('empty'), it.empty, 'When empty')}
        ${check(p('group'), it.group, 'The same ones together (potion ×2)')}
        ${text(p('pick'), it.pick, 'Picked into', 'title="Clicking a tile puts it in this variable, then runs the rules An item is picked"')}`;
    }
    return `${text(p('variable'), it.variable, 'Variable')}${number(p('max'), it.max, 'Full at', 0.0001, 1e6, 'any')}${text(p('label'), it.label, 'Label')}`;
  }

  function screensTab() {
    const list = screens();
    si = Math.min(si, Math.max(0, list.length - 1));
    const s = list[si];
    const head = `<div class="scr-pick">
      <select data-act="pick-screen" ${list.length ? '' : 'disabled'}>${list.length ? list.map((x, i) =>
        `<option value="${i}" ${i === si ? 'selected' : ''}>${esc(x.name)}</option>`).join('') : '<option>No screens yet</option>'}</select>
      <button class="tbtn" data-act="add-screen" title="A new screen">+ Screen</button>
      ${s ? '<button class="gp-x" data-act="del-screen" title="Delete this screen">×</button>' : ''}
    </div>`;
    if (!s) {
      return `${head}<div class="gp-legend">A screen is a card the game shows: a pause menu, an inventory, a map, a shop, a
        "You found the key" note. Add one, put text, buttons and lists on it, then open it with a rule
        (<b>Show / hide a screen</b>) or a key in Controls.</div>`;
    }
    return `${head}
      ${text('s:name', s.name, 'Name')}
      ${text('s:title', s.title, 'Title')}
      ${select('s:place', SCREEN_PLACES, s.place, 'Place')}
      ${s.place === 'whole screen' ? '' : number('s:width', s.width, 'Width (px)', 160, 1200, 10)}
      <div class="prop-row"><label>Colour</label><input type="color" data-p="s:color" value="${esc(s.color)}" /></div>
      ${check('s:pauses', s.pauses, 'Pauses the game while it is up')}
      ${check('s:dim', s.dim, 'Dims the game behind it', 'Off: the game shows through, and can still be clicked')}
      ${check('s:closeButton', s.closeButton, 'A × to close it')}
      <div class="hud-preview scr-preview" title="How it looks in the game (half size), with the variables' starting values"><div class="hud-preview-screen"><div class="t3-ui-layer"></div></div></div>
      <h4 class="insp-h">On it</h4>
      ${s.items.map((it, ii) => `<div class="gp-card" data-item="${ii}">
        <div class="gp-head"><span class="gp-title">${esc(ITEM_LABELS[it.type])}</span>
          <button class="gp-x" data-act="item-up" data-i="${ii}" title="Up" ${ii ? '' : 'disabled'}>↑</button>
          <button class="gp-x" data-act="item-down" data-i="${ii}" title="Down" ${ii < s.items.length - 1 ? '' : 'disabled'}>↓</button>
          <button class="gp-x" data-act="item-del" data-i="${ii}" title="Remove">×</button></div>
        ${itemFields(it, ii)}</div>`).join('') || '<div class="empty">Nothing on it yet.</div>'}
      <div class="prop-row" style="margin-top:6px"><label>Add</label>
        <select data-act="add-item"><option value="">choose…</option>${ITEM_TYPES.map((t) => `<option value="${t}">${esc(ITEM_LABELS[t])}</option>`).join('')}</select></div>
      <div class="gp-legend">Open it: a rule's <b>Show / hide a screen</b>, or a key in Controls (I for an inventory). Its buttons
        run <b>A button is pressed</b> rules; a list's tiles, <b>An item is picked</b>.</div>`;
  }

  // ---------------------------------------------------------------- dialogues

  function lineCard(d, line, li) {
    const p = (k) => `l:${li}:${k}`;
    const goTargets = (v, follow) => `<option value="" ${v ? '' : 'selected'}>${esc(follow)}</option>
      <option value="end" ${v === 'end' ? 'selected' : ''}>the end</option>
      ${d.lines.map((l, j) => (l.id ? `<option value="${esc(l.id)}" ${l.id === v ? 'selected' : ''}>${esc(l.id)}</option>` : '')).join('')}
      ${v && v !== 'end' && !d.lines.some((l) => l.id === v) ? `<option value="${esc(v)}" selected>${esc(v)} (no such line)</option>` : ''}`;
    const choices = line.choices.map((c, ci) => {
      const q = (k) => `c:${li}:${ci}:${k}`;
      const bad = c.if.trim() ? problemIn(c.if) : null;
      return `<div class="dlg-choice">
        <div class="dlg-choice-head"><span>Choice ${ci + 1}</span>
          <button class="gp-x" data-act="choice-del" data-l="${li}" data-c="${ci}" title="Remove this choice">×</button></div>
        <div class="prop-row"><label>Says</label><input type="text" data-p="${q('text')}" value="${esc(c.text)}" spellcheck="false" /></div>
        <div class="prop-row"><label>Goes to</label><select data-p="${q('goto')}">${goTargets(c.goto, 'the next line')}</select></div>
        <div class="prop-row"><label title="An expression: shown only when it is true — coins >= 5, contains(bag, &quot;key&quot;)">Only if</label>
          <input type="text" data-p="${q('if')}" value="${esc(c.if)}" placeholder="always" spellcheck="false" ${bad ? `class="bad" title="${esc(bad)}"` : ''} /></div>
        <div class="prop-row"><label title="Chosen: this variable is set (a value, or =an expression)">Sets</label>
          <div class="dlg-pair"><input type="text" data-p="${q('setVar')}" value="${esc(c.setVar)}" placeholder="variable" spellcheck="false" />
          <input type="text" data-p="${q('setTo')}" value="${esc(c.setTo)}" placeholder="to" spellcheck="false" /></div></div>
        <div class="prop-row"><label title="Chosen: this event goes to every object with an I receive an event rule for it">Sends</label>
          <input type="text" data-p="${q('event')}" value="${esc(c.event)}" placeholder="an event (optional)" spellcheck="false" /></div>
      </div>`;
    }).join('');
    return `<div class="gp-card dlg-line${li === tryLine ? ' on' : ''}" data-line="${li}">
      <div class="gp-head"><span class="gp-title" data-act="try-line" data-l="${li}" title="Show it in the preview">Line ${li + 1}${line.id ? ` · ${esc(line.id)}` : ''}</span>
        <button class="gp-x" data-act="line-up" data-l="${li}" title="Up" ${li ? '' : 'disabled'}>↑</button>
        <button class="gp-x" data-act="line-down" data-l="${li}" title="Down" ${li < d.lines.length - 1 ? '' : 'disabled'}>↓</button>
        <button class="gp-x" data-act="line-del" data-l="${li}" title="Remove" ${d.lines.length > 1 ? '' : 'disabled'}>×</button></div>
      <div class="prop-row"><label title="Its name, for choices to go to (optional)">Name</label>
        <input type="text" data-p="${p('id')}" value="${esc(line.id)}" placeholder="(none)" spellcheck="false" /></div>
      ${text(p('who'), line.who, 'Who says it')}
      <div class="prop-row"><label title="{name}, {coins}: worked out as it plays">Says</label>
        <textarea data-p="${p('text')}" rows="2" spellcheck="false">${esc(line.text)}</textarea></div>
      ${choices}
      ${line.choices.length ? '' : `<div class="prop-row"><label>Then</label><select data-p="${p('next')}">${goTargets(line.next, 'the next line')}</select></div>`}
      <button class="tbtn" data-act="choice-add" data-l="${li}">+ Choice</button>
    </div>`;
  }

  function dialoguesTab() {
    const list = dialogues();
    di = Math.min(di, Math.max(0, list.length - 1));
    const d = list[di];
    const head = `<div class="scr-pick">
      <select data-act="pick-dialogue" ${list.length ? '' : 'disabled'}>${list.length ? list.map((x, i) =>
        `<option value="${i}" ${i === di ? 'selected' : ''}>${esc(x.name)}</option>`).join('') : '<option>No dialogues yet</option>'}</select>
      <button class="tbtn" data-act="add-dialogue" title="A new dialogue">+ Dialogue</button>
      ${d ? '<button class="gp-x" data-act="del-dialogue" title="Delete this dialogue">×</button>' : ''}
    </div>`;
    if (!d) {
      return `${head}<div class="gp-legend">A dialogue is what someone says, line by line, and the choices the player
        answers with. A choice can be shown only if something is true, set a variable, send an event, and go to another
        line. Start it with a rule — <b>Start a dialogue</b> on an "I'm interacted with" rule — and answer it with
        <b>A dialogue ends</b>.</div>`;
    }
    tryLine = Math.min(tryLine, d.lines.length - 1);
    return `${head}
      ${text('d:name', d.name, 'Name')}
      ${check('d:pauses', d.pauses, 'Pauses the game while it is on')}
      <div class="hud-preview scr-preview dlg-preview" title="Try it: click a choice or Continue"><div class="hud-preview-screen"><div class="t3-ui-layer"></div></div></div>
      <div class="gp-hint">Try it in the preview: choices take you where they go (nothing is set or sent here). Choices with an <i>Only if</i> are all shown.</div>
      ${d.lines.map((line, li) => lineCard(d, line, li)).join('')}
      <button class="tbtn" data-act="line-add">+ Line</button>`;
  }

  // ---------------------------------------------------------------- drawing

  function drawPreview() {
    const el = body.querySelector('.scr-preview .t3-ui-layer');
    if (!el) return;
    const vars = engine.variables;
    if (tab === 'screens') {
      const s = screens()[si];
      el.innerHTML = s ? screenHtml(s, si, { vars, esc }) : '';
      return;
    }
    const d = dialogues()[di];
    const line = d?.lines[tryLine];
    if (!line) { el.innerHTML = ''; return; }
    const scope = varScope(vars);
    el.innerHTML = dialogueHtml({
      who: formatText(line.who, scope), text: formatText(line.text, scope), pauses: d.pauses,
      choices: line.choices.map((c, i) => ({ text: formatText(c.text, scope) + (c.if.trim() ? `  (if ${c.if})` : ''), index: i })),
    }, { esc });
  }

  function render() {
    injectOverlayStyle(); // previews drawn as the game draws them
    body.innerHTML = `<div class="scr-tabs">
      <button class="tbtn${tab === 'screens' ? ' active' : ''}" data-act="tab" data-tab="screens">Screens</button>
      <button class="tbtn${tab === 'dialogues' ? ' active' : ''}" data-act="tab" data-tab="dialogues">Dialogues</button>
    </div>${tab === 'screens' ? screensTab() : dialoguesTab()}`;
    drawPreview();
  }

  // ---------------------------------------------------------------- editing

  /** Write a field (data-p) into the screen / dialogue it belongs to. */
  function apply(path, el) {
    const [kind, a, b, c] = path.split(':');
    const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    const s = screens()[si];
    const d = dialogues()[di];
    // a change that shows or hides other fields, or names something listed elsewhere, draws the panel again
    const redraw = ['place', 'does', 'name', 'id'].includes(kind === 'i' || kind === 'l' ? b : a) || kind === 'c' && c === 'goto';
    commit(`edit ${kind === 's' || kind === 'i' ? 'screen' : 'dialogue'}`, () => {
      if (kind === 's') {
        if (a === 'name') {
          const was = s.name;
          const now = String(value).trim() || was;
          s.name = uniqueName(screens().filter((x) => x !== s), now);
          // buttons that open it follow its new name
          for (const x of screens()) for (const it of x.items) if (it.screen === was) it.screen = s.name;
        } else s[a] = value;
        screens()[si] = normalizeScreen(s);
      } else if (kind === 'i') {
        s.items[Number(a)] = normalizeItem({ ...s.items[Number(a)], [b]: value });
      } else if (kind === 'd') {
        if (a === 'name') {
          const was = d.name;
          d.name = uniqueName(dialogues().filter((x) => x !== d), String(value).trim() || was);
          for (const x of screens()) for (const it of x.items) if (it.dialogue === was) it.dialogue = d.name;
        } else d[a] = value;
        dialogues()[di] = normalizeDialogue(d);
      } else if (kind === 'l') {
        const line = d.lines[Number(a)];
        if (b === 'id') {
          const was = line.id;
          line.id = String(value).trim();
          // choices and lines that went to it follow its new name
          for (const l of d.lines) {
            if (was && l.next === was) l.next = line.id;
            for (const ch of l.choices) if (was && ch.goto === was) ch.goto = line.id;
          }
        } else line[b] = value;
        d.lines[Number(a)] = normalizeLine(line);
      } else if (kind === 'c') {
        const line = d.lines[Number(a)];
        line.choices[Number(b)] = normalizeChoice({ ...line.choices[Number(b)], [c]: value });
      }
    }, { redraw });
  }

  const move = (list, i, by) => {
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  };

  body.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.p) { apply(el.dataset.p, el); return; }
    const act = el.dataset.act;
    if (act === 'pick-screen') { si = Number(el.value); render(); }
    else if (act === 'pick-dialogue') { di = Number(el.value); tryLine = 0; render(); }
    else if (act === 'add-item' && el.value) {
      const type = el.value;
      commit('add to screen', () => {
        const base = type === 'button' ? { label: screens()[si].items.some((it) => it.type === 'button') ? 'Button' : 'Close', does: screens()[si].items.some((it) => it.type === 'button') ? 'run its rules' : 'close this screen' } : {};
        screens()[si].items.push(normalizeItem({ type, ...base }));
      });
    }
  });

  body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act],[data-ui-choice],[data-ui-next]');
    if (!el || el.tagName === 'SELECT') return;
    // the dialogue's preview: try it
    if (el.dataset.uiChoice !== undefined || el.dataset.uiNext !== undefined) {
      const d = dialogues()[di];
      const line = d?.lines[tryLine];
      if (!line) return;
      const goto = el.dataset.uiChoice !== undefined ? line.choices[Number(el.dataset.uiChoice)]?.goto : line.next;
      const next = lineAfter(d, tryLine, goto);
      tryLine = next < 0 ? 0 : next; // the end: back to the start
      render();
      body.querySelector(`.dlg-line[data-line="${tryLine}"]`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const act = el.dataset.act;
    const i = Number(el.dataset.i);
    const li = Number(el.dataset.l);
    if (act === 'tab') { tab = el.dataset.tab; render(); return; }
    if (act === 'try-line') { tryLine = li; render(); return; }
    if (act === 'add-screen') {
      commit('add screen', () => {
        screens().push(normalizeScreen({
          name: uniqueName(screens(), screens().length ? 'Screen' : 'Inventory'),
          title: screens().length ? '' : 'Inventory',
          items: screens().length ? [] : [{ type: 'list', variable: 'inventory' }, { type: 'button', label: 'Close', does: 'close this screen' }],
        }));
        si = screens().length - 1;
      });
    } else if (act === 'del-screen') {
      commit('delete screen', () => { screens().splice(si, 1); si = Math.max(0, si - 1); });
    } else if (act === 'item-up' || act === 'item-down') {
      commit('move on screen', () => move(screens()[si].items, i, act === 'item-up' ? -1 : 1));
    } else if (act === 'item-del') {
      commit('remove from screen', () => screens()[si].items.splice(i, 1));
    } else if (act === 'add-dialogue') {
      commit('add dialogue', () => {
        dialogues().push(normalizeDialogue({
          name: uniqueName(dialogues(), 'Talk'),
          lines: [
            { who: 'Stranger', text: 'Hello there. Can I help you?', choices: [{ text: 'Who are you?', goto: 'who' }, { text: 'Goodbye.', goto: 'end' }] },
            { id: 'who', who: 'Stranger', text: 'Just someone passing through.' },
          ],
        }));
        di = dialogues().length - 1;
        tryLine = 0;
      });
    } else if (act === 'del-dialogue') {
      commit('delete dialogue', () => { dialogues().splice(di, 1); di = Math.max(0, di - 1); tryLine = 0; });
    } else if (act === 'line-add') {
      commit('add line', () => {
        const d = dialogues()[di];
        d.lines.push(normalizeLine({ who: d.lines[d.lines.length - 1]?.who || '', text: '…' }));
        tryLine = d.lines.length - 1;
      });
    } else if (act === 'line-del') {
      commit('remove line', () => { dialogues()[di].lines.splice(li, 1); tryLine = Math.max(0, Math.min(tryLine, dialogues()[di].lines.length - 1)); });
    } else if (act === 'line-up' || act === 'line-down') {
      commit('move line', () => move(dialogues()[di].lines, li, act === 'line-up' ? -1 : 1));
    } else if (act === 'choice-add') {
      commit('add choice', () => {
        const line = dialogues()[di].lines[li];
        if (line.choices.length < 9) line.choices.push(normalizeChoice({ text: line.choices.length ? 'Something else' : 'OK' }));
        tryLine = li;
      });
    } else if (act === 'choice-del') {
      commit('remove choice', () => dialogues()[di].lines[li].choices.splice(Number(el.dataset.c), 1));
    }
  });

  render();
  // a loaded game, a new one, an undo elsewhere: its own screens
  Object.assign(app, { renderScreensPanel: render });
}
