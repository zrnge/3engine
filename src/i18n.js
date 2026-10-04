/**
 * Languages — one game, played in several.
 *
 * A game is written in one language (the first of its list). For each other
 * language, each text a player sees can have a translation:
 *   - messages, and the win and lose messages;
 *   - the title screen;
 *   - HUD labels, prompts ("Open"), touch buttons and level names;
 *   - the engine's own words: Paused, Resume, You win!…
 *
 * Texts are keyed by how they're written, so there are no ids to keep in step.
 * A text with no translation is shown as written.
 *
 * Which language: the one the player picked (pause menu), else their
 * browser's, else the game's own. Arabic, Persian, Hebrew and Urdu read right
 * to left, and so do the on-screen texts in them.
 *
 *   ui.languages = { list: [{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' }],
 *                    strings: { 'Open the door': { es: 'Abre la puerta' } } }
 */

/** Languages to add from a list (any other code works too). */
export const KNOWN_LANGUAGES = Object.freeze([
  ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'], ['it', 'Italiano'],
  ['nl', 'Nederlands'], ['pl', 'Polski'], ['tr', 'Türkçe'], ['ru', 'Русский'], ['uk', 'Українська'], ['ar', 'العربية'],
  ['fa', 'فارسی'], ['he', 'עברית'], ['ur', 'اردو'], ['hi', 'हिन्दी'], ['bn', 'বাংলা'], ['id', 'Bahasa Indonesia'],
  ['vi', 'Tiếng Việt'], ['th', 'ไทย'], ['zh', '中文'], ['ja', '日本語'], ['ko', '한국어'], ['sv', 'Svenska'],
].map(([code, name]) => Object.freeze({ code, name })));

const RIGHT_TO_LEFT = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'ku', 'yi', 'dv']);

/** The engine's own words a player can meet. */
export const ENGINE_TEXTS = Object.freeze([
  'Paused', 'Resume', 'Restart level', 'Restart game', 'Restart from the beginning?', 'Install game',
  'Sound effects', 'Music', 'Mute everything', 'Esc to resume', 'Language',
  'You win!', 'Game over', 'You finished the game!', 'Press R to play again',
  'Click to look around', 'Esc gives the mouse back', 'Click to focus', 'Esc pause', 'Loading…',
  'Interact', 'Press any key to start', 'Brake', 'Jump', 'Continue', 'Close',
]);

const code = (c) => String(c || '').trim().toLowerCase().slice(0, 12);

/** Clean languages: a list (the first is the game's own), and translations by text, then by language. */
export function normalizeLanguages(raw = {}) {
  const r = raw || {};
  const list = [];
  for (const l of Array.isArray(r.list) ? r.list : []) {
    const c = code(l?.code);
    if (!c || list.some((x) => x.code === c)) continue;
    list.push({ code: c, name: String(l.name || c).trim().slice(0, 40) || c });
  }
  const strings = {};
  for (const [text, by] of Object.entries(r.strings || {})) {
    if (!text || !by || typeof by !== 'object') continue;
    const clean = {};
    for (const [c, value] of Object.entries(by)) {
      if (list.some((l) => l.code === code(c)) && typeof value === 'string' && value.trim()) clean[code(c)] = value.slice(0, 2000);
    }
    if (Object.keys(clean).length) strings[text] = clean;
  }
  return { list, strings };
}

/** Does this language read right to left? */
export const rightToLeft = (lang) => RIGHT_TO_LEFT.has(code(lang).split('-')[0]);

export class Translator {
  constructor() {
    this.data = normalizeLanguages();
    this.language = '';
    this._listeners = new Set();
  }

  /** The game's languages (ui.languages); its language picked again. */
  load(data, { game = '' } = {}) {
    this.data = normalizeLanguages(data);
    this.game = game;
    this.setLanguage(this.pick());
  }

  /** The game's own language: the first of its list. */
  get original() { return this.data.list[0]?.code ?? ''; }

  /** Which to play in: the player's pick (kept), else their browser's, else the game's own. */
  pick(preferred = null) {
    const has = (c) => this.data.list.some((l) => l.code === c);
    let kept = null;
    try { kept = globalThis.localStorage?.getItem(this._key()); } catch { /* storage blocked */ }
    if (kept && has(kept)) return kept;
    const wanted = preferred ?? (globalThis.navigator?.languages || [globalThis.navigator?.language]).filter(Boolean);
    for (const w of wanted) {
      const c = code(w);
      if (has(c)) return c;
      if (has(c.split('-')[0])) return c.split('-')[0];
    }
    return this.original;
  }

  _key() { return `tiny3.lang:${this.game || 'Tiny3 Game'}`; }

  /** Play in `lang` (a player's pick is kept for next time, with `remember`). */
  setLanguage(lang, { remember = false } = {}) {
    const c = code(lang);
    this.language = this.data.list.some((l) => l.code === c) ? c : this.original;
    if (remember) {
      try { globalThis.localStorage?.setItem(this._key(), this.language); } catch { /* storage blocked */ }
    }
    for (const fn of this._listeners) fn(this.language);
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** A text as the player reads it: its translation, or as written. */
  t(text) {
    if (text === null || text === undefined || text === '') return text;
    const s = String(text);
    if (!this.language || this.language === this.original) return s;
    return this.data.strings[s]?.[this.language] ?? s;
  }

  get rtl() { return rightToLeft(this.language); }
}

/** The translator the game's screens use. */
export const i18n = new Translator();
export const t = (text) => i18n.t(text);

/**
 * Every text a player can see in a game, for the translation table: each
 * level's name, its rules' messages and prompts, the prefabs' too, the title
 * screen, the HUD, touch buttons and the engine's own words.
 */
export function collectTexts(project, ui = {}) {
  const out = new Set();
  // only words: ▲ ▼ ◀ ▶ and the like read the same in every language
  const add = (s) => { if (typeof s === 'string' && s.trim() && /\p{L}/u.test(s)) out.add(s); };
  const fromRules = (rules) => {
    for (const rule of rules || []) {
      if (rule?.when?.type === 'interact') add(rule.when.prompt || 'Interact');
      for (const a of [...(rule?.do || []), ...(rule?.else || [])]) {
        if (a?.type === 'showMessage') add(a.text);
        if (a?.type === 'win' || a?.type === 'lose') add(a.message);
      }
    }
  };
  const levels = project?.levels || [];
  for (const level of levels) {
    if (levels.length > 1) add(level.name);
    for (const e of level.scene?.entities || []) fromRules(e.rules);
    for (const p of Object.values(level.scene?.prefabs || {})) fromRules(p?.rules);
  }
  const shared = project?.shared || {};
  for (const p of Object.values(shared.prefabs || {})) fromRules(p?.rules);
  for (const c of shared.controls || []) for (const input of c?.inputs || []) if (input?.type === 'screen') add(input.label);
  const title = ui.title || {};
  if (title.enabled) { add(title.text); add(title.subtitle); add(title.prompt); }
  for (const [name, h] of Object.entries(ui.hud || {})) add(h?.label || name);
  // the game's own screens and dialogues (screens.js): {expressions} stay as they are, worked out after translating
  for (const s of ui.screens || []) {
    add(s.title);
    for (const it of s.items || []) { add(it.text); add(it.label); add(it.empty); }
  }
  for (const d of ui.dialogues || []) {
    for (const l of d.lines || []) { add(l.who); add(l.text); for (const c of l.choices || []) add(c.text); }
  }
  const game = [...out];
  return { game, engine: ENGINE_TEXTS.filter((s) => !out.has(s)) };
}
