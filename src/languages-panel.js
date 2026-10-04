import { KNOWN_LANGUAGES, normalizeLanguages, collectTexts, rightToLeft } from './i18n.js';
import { escapeHtml } from './ui.js';

/**
 * The Game panel's Languages: which language the game is written in, which
 * others it can be played in, and the table where each text a player sees is
 * translated. Every change is one undo step, saved with the game (ui.languages).
 *
 * `get()` gives the languages as they are; `set(next, label)` changes them
 * (undoable); `texts()` lists the game's texts now (i18n.js collectTexts).
 */
export function wireLanguagesPanel({ get, set, texts }) {
  const byId = (id) => document.getElementById(id);
  const list = byId('lang-list');
  const addSel = byId('lang-add');
  const addLabel = byId('lang-add-label');
  const preview = byId('lang-preview');
  const dialog = byId('lang-dialog');
  const table = byId('lang-table');
  let previewing = '';

  const nameOf = (code) => KNOWN_LANGUAGES.find((l) => l.code === code)?.name ?? code;

  function render() {
    const langs = get();
    if (list) {
      list.innerHTML = langs.list.length
        ? langs.list.map((l, i) => `<span class="pass-chip" title="${i === 0 ? 'The game is written in it' : 'Played in it too'}">
            ${escapeHtml(l.name)}${i === 0 ? ' <em style="color:var(--dim);font-style:normal">(written in)</em>' : ''}
            ${i > 0 || langs.list.length === 1 ? `<button class="gp-x" data-lang-del="${escapeHtml(l.code)}" title="Remove">×</button>` : ''}</span>`).join('')
        : '<span class="pass-none">One language: pick the one the game is written in, then those it can be played in too.</span>';
    }
    if (addLabel) addLabel.textContent = langs.list.length ? 'Add' : 'Written in';
    if (addSel) {
      const taken = new Set(langs.list.map((l) => l.code));
      addSel.innerHTML = `<option value="">${langs.list.length ? '+ a language…' : 'choose…'}</option>`
        + KNOWN_LANGUAGES.filter((l) => !taken.has(l.code)).map((l) => `<option value="${l.code}">${escapeHtml(l.name)}</option>`).join('')
        + '<option value="__other">Another…</option>';
    }
    const translate = byId('lang-translate');
    if (translate) translate.disabled = langs.list.length < 2;
    if (preview) {
      preview.innerHTML = '<option value="">as the player\'s browser says</option>'
        + langs.list.map((l) => `<option value="${escapeHtml(l.code)}" ${l.code === previewing ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('');
      preview.disabled = langs.list.length < 2;
    }
    const missing = byId('lang-missing');
    if (missing) {
      const others = langs.list.slice(1);
      const all = others.length ? [...texts().game] : []; // gathered only when there is something to translate into
      missing.textContent = others.length
        ? others.map((l) => `${l.name}: ${all.filter((s) => !langs.strings[s]?.[l.code]).length} of ${all.length} to translate`).join(' · ')
        : '';
    }
  }

  addSel?.addEventListener('change', () => {
    let code = addSel.value;
    let name = nameOf(code);
    if (!code) return;
    if (code === '__other') {
      const typed = window.prompt('The language\'s code (like "sw" or "pt-BR") and its name, e.g.  sw Kiswahili');
      if (!typed) { render(); return; }
      const [c, ...rest] = typed.trim().split(/\s+/);
      code = c.toLowerCase();
      name = rest.join(' ') || c;
    }
    const langs = get();
    set(normalizeLanguages({ ...langs, list: [...langs.list, { code, name }] }), `add language ${name}`);
  });

  list?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang-del]');
    if (!b) return;
    const langs = get();
    const code = b.dataset.langDel;
    set(normalizeLanguages({ ...langs, list: langs.list.filter((l) => l.code !== code) }), 'remove language');
  });

  preview?.addEventListener('change', () => { previewing = preview.value; });

  // ---- the translation table
  function renderTable() {
    const langs = get();
    const others = langs.list.slice(1);
    const { game, engine } = texts();
    const cell = (text, l) => {
      const v = langs.strings[text]?.[l.code] ?? '';
      return `<td><input type="text" dir="${rightToLeft(l.code) ? 'rtl' : 'ltr'}" data-text="${escapeHtml(text)}" data-code="${escapeHtml(l.code)}"
        value="${escapeHtml(v)}" placeholder="${escapeHtml(text)}" spellcheck="false" class="${v ? '' : 'lang-todo'}" /></td>`;
    };
    const rows = (items) => items.map((text) => `<tr><th title="${escapeHtml(text)}">${escapeHtml(text)}</th>${others.map((l) => cell(text, l)).join('')}</tr>`).join('');
    table.innerHTML = `<thead><tr><th>${escapeHtml(langs.list[0]?.name ?? '')}</th>${others.map((l) => `<th>${escapeHtml(l.name)}</th>`).join('')}</tr></thead>
      <tbody>${rows(game) || `<tr><td colspan="${others.length + 1}" class="pass-none">No texts yet: messages, the title screen and the HUD appear here.</td></tr>`}</tbody>
      <tbody class="lang-engine"><tr><th colspan="${others.length + 1}">The engine's own words (pause menu, win and lose…)</th></tr>${rows(engine)}</tbody>`;
  }

  table?.addEventListener('change', (e) => {
    const input = e.target.closest('input[data-text]');
    if (!input) return;
    const langs = get();
    const strings = JSON.parse(JSON.stringify(langs.strings));
    const text = input.dataset.text;
    const value = input.value.trim();
    if (value) (strings[text] ??= {})[input.dataset.code] = value;
    else if (strings[text]) delete strings[text][input.dataset.code];
    set(normalizeLanguages({ ...langs, strings }), 'translation', { keepTable: true });
    input.classList.toggle('lang-todo', !value);
  });

  byId('lang-translate')?.addEventListener('click', () => {
    renderTable();
    dialog.hidden = false;
    table.querySelector('input.lang-todo, input')?.focus();
  });
  byId('lang-close')?.addEventListener('click', () => { dialog.hidden = true; render(); });
  dialog?.addEventListener('keydown', (e) => { if (e.key === 'Escape') { dialog.hidden = true; render(); } });

  render();
  return {
    render,
    /** Refresh the table if it's open (an undo). */
    refresh() { render(); if (dialog && !dialog.hidden) renderTable(); },
    /** The language the editor's Play shows ('' = as a player's browser would pick). */
    get preview() { return previewing; },
  };
}
