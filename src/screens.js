/**
 * Screens and dialogue — the game's own interface, designed in the editor
 * (the Screens panel) and shown while it plays, in the editor and in an
 * exported game alike.
 *
 * A screen is a card of items: text (with {expressions} in it), buttons, a
 * list variable shown as tiles (an inventory), a bar. A rule or a key opens
 * it (Show screen); its buttons close it, open another, start a dialogue,
 * restart, send an event — or run the rules "A button is pressed". A screen
 * can pause the game while it is up: a menu, a map, an inventory.
 *
 * A dialogue is lines, each said by someone, with choices (shown only if
 * their condition holds; each may set a variable, send an event, and go to
 * another line or end it). A rule starts it (Start dialogue) — talking to
 * someone is an interact rule — and "A dialogue ends" rules run after.
 *
 * Everything here is data (ui.screens, ui.dialogues) and plain HTML; the
 * overlay (play-overlay.js) puts it on screen and passes clicks and keys back.
 */
import { formatText, varScope, valueOf, run as runExpr, truthy, asText } from './expr.js';
import { t as translate } from './i18n.js';

export const SCREEN_PLACES = ['middle', 'top', 'bottom', 'left', 'right', 'whole screen'];
export const ITEM_TYPES = ['text', 'button', 'list', 'bar'];
export const ITEM_LABELS = { text: 'Text', button: 'Button', list: 'List (inventory)', bar: 'Bar' };
export const BUTTON_DOES = [
  'run its rules', 'close this screen', 'open a screen', 'close a screen', 'start a dialogue', 'send an event', 'restart the game',
];
const ALIGN = ['left', 'center', 'right'];
const HEX = /^#[0-9a-f]{6}$/i;
const str = (v, d = '', max = 400) => (typeof v === 'string' ? v.slice(0, max) : d);
const num = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// ---------------------------------------------------------------- data

export const SCREEN_DEFAULTS = Object.freeze({
  name: 'Menu', place: 'middle', width: 360, pauses: true, dim: true, title: '', closeButton: true, color: '#4dd0a6', items: [],
});

/** One item as saved: only its own kind's fields. */
export function normalizeItem(raw = {}) {
  const r = raw || {};
  const type = ITEM_TYPES.includes(r.type) ? r.type : 'text';
  if (type === 'text') {
    return { type, text: str(r.text, 'Text'), size: num(r.size, 8, 96, 16), align: ALIGN.includes(r.align) ? r.align : 'center' };
  }
  if (type === 'button') {
    return {
      type, label: str(r.label, 'Button', 80), does: BUTTON_DOES.includes(r.does) ? r.does : 'run its rules',
      screen: str(r.screen, '', 80), dialogue: str(r.dialogue, '', 80), event: str(r.event, '', 80), key: str(r.key, '', 24),
    };
  }
  if (type === 'list') {
    return {
      type, variable: str(r.variable, 'inventory', 80), columns: Math.round(num(r.columns, 1, 8, 4)),
      empty: str(r.empty, 'Nothing yet', 120), group: r.group !== false, pick: str(r.pick, 'picked', 80),
    };
  }
  return { type, variable: str(r.variable, 'health', 80), max: num(r.max, 0.0001, 1e6, 10), label: str(r.label, '', 80) };
}

export function normalizeScreen(raw = {}) {
  const r = raw || {};
  return {
    name: str(r.name, SCREEN_DEFAULTS.name, 80).trim() || SCREEN_DEFAULTS.name,
    place: SCREEN_PLACES.includes(r.place) ? r.place : 'middle',
    width: Math.round(num(r.width, 160, 1200, 360)),
    pauses: r.pauses !== false,
    dim: r.dim !== false,
    title: str(r.title, ''),
    closeButton: r.closeButton !== false,
    color: HEX.test(r.color ?? '') ? r.color.toLowerCase() : SCREEN_DEFAULTS.color,
    items: (Array.isArray(r.items) ? r.items : []).slice(0, 60).map(normalizeItem),
  };
}

export function normalizeChoice(raw = {}) {
  const r = raw || {};
  return {
    text: str(r.text, 'OK', 200), goto: str(r.goto, '', 80), if: str(r.if, '', 200),
    setVar: str(r.setVar, '', 80), setTo: str(r.setTo, '', 200), event: str(r.event, '', 80),
  };
}

export function normalizeLine(raw = {}) {
  const r = raw || {};
  return {
    id: str(r.id, '', 80), who: str(r.who, '', 80), text: str(r.text, '…', 1000), next: str(r.next, '', 80),
    choices: (Array.isArray(r.choices) ? r.choices : []).slice(0, 9).map(normalizeChoice),
  };
}

export function normalizeDialogue(raw = {}) {
  const r = raw || {};
  const lines = (Array.isArray(r.lines) ? r.lines : []).slice(0, 300).map(normalizeLine);
  return {
    name: str(r.name, 'Talk', 80).trim() || 'Talk',
    pauses: r.pauses !== false,
    lines: lines.length ? lines : [normalizeLine({ text: 'Hello!' })],
  };
}

export const normalizeScreens = (list) => (Array.isArray(list) ? list : []).slice(0, 50).map(normalizeScreen);
export const normalizeDialogues = (list) => (Array.isArray(list) ? list : []).slice(0, 100).map(normalizeDialogue);

const byName = (list, name) => {
  const want = String(name ?? '').trim().toLowerCase();
  return want ? list.find((x) => x.name.toLowerCase() === want) ?? null : null;
};

/** The index of the line a goto means: '' the next one, 'end' none (-1), else the line with that id. */
export function lineAfter(dialogue, from, goto) {
  const g = String(goto ?? '').trim();
  if (g.toLowerCase() === 'end') return -1;
  if (!g) return from + 1 < dialogue.lines.length ? from + 1 : -1;
  const i = dialogue.lines.findIndex((l) => l.id.toLowerCase() === g.toLowerCase());
  return i;
}

// ---------------------------------------------------------------- what it looks like

const KEY_LABEL = (code) => String(code || '').replace(/^Key/, '').replace(/^Digit/, '');

/** A list's items as tiles: the same ones together ("potion ×2"), or each its own. */
export function listTiles(value, group = true) {
  const items = Array.isArray(value) ? value : value === undefined || value === '' ? [] : [value];
  if (!group) return items.map((v, i) => ({ value: v, count: 1, index: i }));
  const tiles = [];
  items.forEach((v, i) => {
    const key = JSON.stringify(v);
    const t = tiles.find((x) => x.key === key);
    if (t) t.count++;
    else tiles.push({ key, value: v, count: 1, index: i });
  });
  return tiles;
}

/**
 * A screen as HTML. `si` is its place in ui.screens (what clicks report).
 * `vars` gives the values its {expressions} and lists read; `t` translates.
 */
export function screenHtml(screen, si, { vars = null, t = (s) => s, esc = (s) => String(s) } = {}) {
  const scope = varScope(vars);
  const say = (text) => esc(formatText(t(text), scope));
  const items = screen.items.map((it, ii) => {
    if (it.type === 'text') {
      return `<div class="t3-ui-text" style="font-size:${it.size}px;text-align:${it.align}">${say(it.text)}</div>`;
    }
    if (it.type === 'button') {
      const key = it.key ? `<kbd>${esc(KEY_LABEL(it.key))}</kbd>` : '';
      return `<button type="button" class="t3-ui-btn" data-ui-btn="${si}:${ii}">${key}${say(it.label)}</button>`;
    }
    if (it.type === 'list') {
      const tiles = listTiles(vars?.has?.(it.variable) ? vars.get(it.variable) : [], it.group);
      if (!tiles.length) return `<div class="t3-ui-empty">${say(it.empty)}</div>`;
      return `<div class="t3-ui-list" style="grid-template-columns:repeat(${it.columns},1fr)">${tiles.map((tile, ti) =>
        `<button type="button" class="t3-ui-tile" data-ui-pick="${si}:${ii}:${ti}">${esc(t(asText(tile.value)))}${tile.count > 1 ? `<small>×${tile.count}</small>` : ''}</button>`).join('')}</div>`;
    }
    // a bar: a number of its maximum
    const v = Number(vars?.get?.(it.variable, 0)) || 0;
    const pct = Math.max(0, Math.min(100, (v / it.max) * 100));
    return `<div class="t3-ui-bar-row">${it.label ? `<span>${say(it.label)}</span>` : ''}<i class="t3-ui-bar"><i style="width:${pct.toFixed(1)}%"></i></i></div>`;
  }).join('');
  const place = screen.place.replace(' ', '-');
  return `<div class="t3-ui-screen at-${place}${screen.dim ? ' dim' : ''}" data-ui-screen="${si}" style="--t3-ui-accent:${screen.color}">
    <div class="t3-ui-card" style="${screen.place === 'whole screen' ? '' : `width:min(${screen.width}px, 92vw)`}">
      ${screen.closeButton ? `<button type="button" class="t3-ui-close" data-ui-close="${si}" title="${esc(t('Close'))}">×</button>` : ''}
      ${screen.title ? `<h2>${say(screen.title)}</h2>` : ''}
      ${items}
    </div></div>`;
}

/** The dialogue box: who says it, the line, its choices (or Continue). */
export function dialogueHtml(view, { t = (s) => s, esc = (s) => String(s) } = {}) {
  if (!view) return '';
  const choices = view.choices.length
    ? view.choices.map((c, i) => `<button type="button" class="t3-ui-choice" data-ui-choice="${i}"><kbd>${i + 1}</kbd>${esc(c.text)}</button>`).join('')
    : `<button type="button" class="t3-ui-next" data-ui-next="1">${esc(t('Continue'))} ▸</button>`;
  return `<div class="t3-ui-dialogue${view.pauses ? ' dim' : ''}"><div class="t3-ui-dbox">
    ${view.who ? `<div class="t3-ui-who">${esc(view.who)}</div>` : ''}
    <div class="t3-ui-line">${esc(view.text)}</div>
    <div class="t3-ui-choices">${choices}</div>
  </div></div>`;
}

export const SCREEN_STYLE = `
.t3-ui-layer { position: absolute; inset: 0; pointer-events: none; z-index: 30; }
.t3-ui-screen { position: absolute; inset: 0; display: flex; padding: 16px; pointer-events: none; }
.t3-ui-screen.dim { background: rgba(5,7,11,0.55); pointer-events: auto; }
.t3-ui-screen.at-middle { align-items: center; justify-content: center; }
.t3-ui-screen.at-top { align-items: flex-start; justify-content: center; }
.t3-ui-screen.at-bottom { align-items: flex-end; justify-content: center; }
.t3-ui-screen.at-left { align-items: center; justify-content: flex-start; }
.t3-ui-screen.at-right { align-items: center; justify-content: flex-end; }
.t3-ui-screen.at-whole-screen { align-items: stretch; justify-content: stretch; }
.t3-ui-screen.at-whole-screen .t3-ui-card { flex: 1; justify-content: center; align-items: center; }
.t3-ui-card {
  position: relative; pointer-events: auto; max-height: 100%; overflow-y: auto; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 10px; padding: 20px; border-radius: 14px; color: #e6edf3;
  background: rgba(13,17,23,0.94); border: 1px solid color-mix(in srgb, var(--t3-ui-accent) 55%, transparent);
  box-shadow: 0 18px 50px rgba(0,0,0,0.5); font-family: system-ui, sans-serif;
}
.t3-ui-card h2 { margin: 0 0 4px; font-size: 24px; text-align: center; }
.t3-ui-text { line-height: 1.45; white-space: pre-wrap; }
.t3-ui-btn, .t3-ui-tile, .t3-ui-choice, .t3-ui-next {
  appearance: none; cursor: pointer; font: 600 15px system-ui, sans-serif; color: #e6edf3;
  padding: 10px 14px; border-radius: 9px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.16);
}
.t3-ui-btn:hover, .t3-ui-btn:focus-visible, .t3-ui-tile:hover, .t3-ui-choice:hover, .t3-ui-choice:focus-visible, .t3-ui-next:hover {
  border-color: var(--t3-ui-accent, #4dd0a6); outline: none; background: color-mix(in srgb, var(--t3-ui-accent, #4dd0a6) 18%, transparent);
}
.t3-ui-card kbd, .t3-ui-dbox kbd {
  display: inline-block; min-width: 1.4em; margin-inline-end: 8px; padding: 0 4px; border-radius: 4px; font: 600 12px system-ui, sans-serif;
  background: rgba(255,255,255,0.12); color: var(--t3-ui-accent, #4dd0a6);
}
.t3-ui-list { display: grid; gap: 8px; }
.t3-ui-tile { position: relative; min-height: 54px; padding: 8px 6px; font-weight: 500; font-size: 13px; word-break: break-word; }
.t3-ui-tile small { position: absolute; right: 5px; bottom: 3px; font-size: 11px; color: var(--t3-ui-accent); }
.t3-ui-empty { text-align: center; color: #8b949e; font-size: 14px; padding: 8px; }
.t3-ui-close { position: absolute; top: 8px; right: 10px; appearance: none; background: none; border: 0; color: #8b949e; font-size: 22px; cursor: pointer; }
.t3-ui-close:hover { color: #e6edf3; }
.t3-ui-bar-row { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.t3-ui-bar { flex: 1; height: 10px; border-radius: 999px; background: rgba(255,255,255,0.12); overflow: hidden; display: block; }
.t3-ui-bar i { display: block; height: 100%; background: var(--t3-ui-accent); }
.t3-ui-dialogue { position: absolute; inset: 0; display: flex; align-items: flex-end; justify-content: center; padding: 16px 16px calc(var(--t3-touch-bottom, 24px) + 8px); pointer-events: auto; }
.t3-ui-dialogue.dim { background: linear-gradient(transparent 45%, rgba(5,7,11,0.6)); }
.t3-ui-dbox {
  width: min(720px, 100%); box-sizing: border-box; padding: 16px 20px; border-radius: 14px; color: #e6edf3; font-family: system-ui, sans-serif;
  background: rgba(13,17,23,0.95); border: 1px solid rgba(77,208,166,0.5); box-shadow: 0 18px 50px rgba(0,0,0,0.5);
}
.t3-ui-who { font-weight: 700; color: #4dd0a6; margin-bottom: 4px; font-size: 15px; }
.t3-ui-line { font-size: 17px; line-height: 1.5; white-space: pre-wrap; }
.t3-ui-choices { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.t3-ui-next { align-self: flex-end; }
.t3-ui-choice { text-align: start; font-weight: 500; }
`;

// ---------------------------------------------------------------- while it plays

/**
 * The screens open and the dialogue under way, while a game plays. Rules and
 * controls open and close them (Gameplay's api); the overlay draws them and
 * passes clicks and keys back to press / pick / choose / advance.
 */
export class ScreenRuntime {
  constructor(engine) {
    this.engine = engine;
    this.open = [];        // names of the screens up, in the order opened (the last on top)
    this.talk = null;      // { dialogue, at } — the dialogue under way
    this.onChange = null;  // the overlay redraws
  }

  get screens() { return this.engine.ui?.screens || []; }
  get dialogues() { return this.engine.ui?.dialogues || []; }
  screen(name) { return byName(this.screens, name); }
  dialogue(name) { return byName(this.dialogues, name); }
  isOpen(name) { return this.open.some((n) => n.toLowerCase() === String(name ?? '').trim().toLowerCase()); }
  /** Anything up that takes the player's clicks (a pointer captured for looking is given back). */
  get active() { return this.open.length > 0 || !!this.talk; }

  /** Does something up hold the game still? */
  get holds() {
    if (this.talk?.dialogue.pauses) return true;
    return this.open.some((n) => this.screen(n)?.pauses);
  }

  _changed() {
    this.engine.uiHold = this.holds;
    this.onChange?.();
  }

  show(name) {
    const s = this.screen(name);
    if (!s) { console.warn('[Tiny3 screens] no screen called', name); return false; }
    this.open = this.open.filter((n) => n.toLowerCase() !== s.name.toLowerCase());
    this.open.push(s.name);
    this._changed();
    return true;
  }

  /** Close one screen — or all of them (name "all" or empty). */
  hide(name = 'all') {
    const want = String(name ?? '').trim().toLowerCase();
    const before = this.open.length;
    this.open = !want || want === 'all' ? [] : this.open.filter((n) => n.toLowerCase() !== want);
    if (this.open.length !== before) this._changed();
  }

  toggle(name) {
    if (this.isOpen(name)) this.hide(name);
    else this.show(name);
  }

  /** Start a dialogue at its first line (one already under way gives way). */
  startDialogue(name) {
    const d = this.dialogue(name);
    if (!d) { console.warn('[Tiny3 screens] no dialogue called', name); return false; }
    this.talk = { dialogue: d, at: 0 };
    this._changed();
    return true;
  }

  get talking() { return !!this.talk; }

  /** The line on screen now: who, its text worked out, the choices that hold. */
  view() {
    if (!this.talk) return null;
    const { dialogue, at } = this.talk;
    const line = dialogue.lines[at];
    if (!line) return null;
    const t = translate;
    const scope = varScope(this.engine.variables);
    const choices = line.choices
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => {
        if (!c.if.trim()) return true;
        try { return truthy(runExpr(c.if, scope)); } catch { return false; }
      })
      .map(({ c, i }) => ({ text: formatText(t(c.text), scope), index: i }));
    return {
      dialogue: dialogue.name, pauses: dialogue.pauses,
      who: formatText(t(line.who), scope), text: formatText(t(line.text), scope), choices,
    };
  }

  /** Continue (a line without choices). */
  advance() {
    if (!this.talk) return;
    const { dialogue, at } = this.talk;
    if (this.view()?.choices.length) return; // it waits for a choice
    this._goTo(lineAfter(dialogue, at, dialogue.lines[at]?.next));
  }

  /** Pick the n-th choice shown (0-based). */
  choose(n) {
    const v = this.view();
    if (!v || !v.choices[n]) return;
    const { dialogue, at } = this.talk;
    const choice = dialogue.lines[at].choices[v.choices[n].index];
    const vars = this.engine.variables;
    if (choice.setVar.trim()) {
      try { vars.set(choice.setVar.trim(), valueOf(choice.setTo, varScope(vars))); } catch (err) { console.warn('[Tiny3 dialogue]', err.message); }
    }
    if (choice.event.trim()) this.engine.gameplay?.sendEvent(choice.event.trim(), 'any');
    if (this.talk?.dialogue !== dialogue) return; // the event started another
    this._goTo(lineAfter(dialogue, at, choice.goto));
  }

  _goTo(i) {
    const { dialogue } = this.talk;
    if (i < 0 || i >= dialogue.lines.length) { this.endDialogue(); return; }
    this.talk.at = i;
    this._changed();
  }

  endDialogue() {
    if (!this.talk) return;
    const name = this.talk.dialogue.name;
    this.talk = null;
    this._changed();
    this._rules('dialogueEnd', (w) => !w.dialogue || w.dialogue.toLowerCase() === name.toLowerCase());
  }

  /** A button on a screen was pressed (screen index, item index in ui.screens). */
  press(si, ii) {
    const screen = this.screens[si];
    const it = screen?.items[ii];
    if (!it || it.type !== 'button') return;
    const gp = this.engine.gameplay;
    switch (it.does) {
      case 'close this screen': this.hide(screen.name); break;
      case 'open a screen': this.show(it.screen); break;
      case 'close a screen': this.hide(it.screen || 'all'); break;
      case 'start a dialogue': this.startDialogue(it.dialogue); break;
      case 'send an event': if (it.event) gp?.sendEvent(it.event, 'any'); break;
      case 'restart the game': this.hide('all'); this.talk = null; this._changed(); gp?.restart(); break;
      default: break;
    }
    // "A button is pressed" rules run for every button, whatever else it does
    this._rules('uiButton', (w) => matchName(w.screen, screen.name) && matchName(w.button, it.label));
    this.onChange?.(); // what it changed shows at once, even with the game held still
  }

  /** A tile of a list was clicked: its value into the list's "Picked into" variable, and "An item is picked" rules. */
  pick(si, ii, ti) {
    const screen = this.screens[si];
    const it = screen?.items[ii];
    if (!it || it.type !== 'list') return;
    const vars = this.engine.variables;
    const tiles = listTiles(vars.has(it.variable) ? vars.get(it.variable) : [], it.group);
    const tile = tiles[ti];
    if (!tile) return;
    if (it.pick.trim()) vars.set(it.pick.trim(), tile.value);
    this._rules('uiPick', (w) => matchName(w.screen, screen.name) && matchName(w.list, it.variable));
    this.onChange?.();
  }

  /** Its button's hotkey pressed: as a click. True if one took it. */
  key(code) {
    if (this.talk) {
      const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
      if (m) { this.choose(Number(m[1]) - 1); return true; }
      if (['Space', 'Enter', 'NumpadEnter', 'KeyE'].includes(code)) { this.advance(); return true; }
      return false;
    }
    for (let k = this.open.length - 1; k >= 0; k--) {
      const si = this.screens.findIndex((s) => s.name === this.open[k]);
      const ii = this.screens[si]?.items.findIndex((it) => it.type === 'button' && it.key && it.key === code) ?? -1;
      if (ii >= 0) { this.press(si, ii); return true; }
    }
    return false;
  }

  _rules(type, accept) {
    const gp = this.engine.gameplay;
    gp?.rules?.fireAll(type, accept, gp.api, this.engine.time ?? 0);
  }

  /** Play starts (or stops): nothing up. */
  reset() {
    this.open = [];
    this.talk = null;
    this._changed();
  }
}

/** A rule's name field: empty or "any" matches anything; otherwise the same name, any case. */
function matchName(want, name) {
  const w = String(want ?? '').trim().toLowerCase();
  return !w || w === 'any' || w === String(name ?? '').trim().toLowerCase();
}
