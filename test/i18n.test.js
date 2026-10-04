// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  Translator, normalizeLanguages, collectTexts, rightToLeft, ENGINE_TEXTS, i18n,
} from '../src/i18n.js';
import { normalizeUI } from '../src/game-ui.js';
import { PlayOverlay } from '../src/play-overlay.js';
import { VariableStore } from '../src/variables.js';

const LANGS = {
  list: [{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' }, { code: 'fa', name: 'فارسی' }],
  strings: {
    'Open the door': { es: 'Abre la puerta', fa: 'در را باز کن' },
    Paused: { es: 'En pausa' },
    Coins: { es: 'Monedas' },
  },
};

describe('a game in several languages', () => {
  beforeEach(() => localStorage.clear());

  it('kept clean: codes in lower case, no repeats, translations only for its languages', () => {
    const l = normalizeLanguages({
      list: [{ code: 'EN', name: 'English' }, { code: 'en' }, { code: '', name: 'x' }, { code: 'es', name: 'Español' }],
      strings: { Hi: { es: 'Hola', de: 'Hallo', en: '' }, Bye: 'nope' },
    });
    expect(l.list.map((x) => x.code)).toEqual(['en', 'es']);
    expect(l.strings).toEqual({ Hi: { es: 'Hola' } });
    expect(normalizeUI({ languages: LANGS }).languages.list.length).toBe(3); // saved with the game's UI
    expect(normalizeUI({}).languages).toEqual({ list: [], strings: {} });
  });

  it('a text as the player reads it: translated, or as written', () => {
    const tr = new Translator();
    tr.load(LANGS);
    tr.setLanguage('es');
    expect(tr.t('Open the door')).toBe('Abre la puerta');
    expect(tr.t('Not translated')).toBe('Not translated');
    tr.setLanguage('en');
    expect(tr.t('Open the door')).toBe('Open the door'); // the game's own language
    tr.setLanguage('xx');
    expect(tr.language).toBe('en'); // not one of its languages: its own
  });

  it('which language: the player\'s pick, kept — else their browser\'s — else the game\'s own', () => {
    const tr = new Translator();
    tr.load(LANGS, { game: 'Door Game' });
    expect(tr.pick(['es-MX', 'en'])).toBe('es'); // Mexican Spanish: Spanish
    expect(tr.pick(['de-DE'])).toBe('en');
    tr.setLanguage('fa', { remember: true });
    expect(tr.pick(['es'])).toBe('fa');
    const other = new Translator();
    other.load(LANGS, { game: 'Another Game' });
    expect(other.pick(['es'])).toBe('es'); // each game its own pick
  });

  it('right to left for Arabic, Persian, Hebrew, Urdu', () => {
    expect(['ar', 'fa', 'he', 'ur', 'fa-IR'].every(rightToLeft)).toBe(true);
    expect(['en', 'es', 'zh'].some(rightToLeft)).toBe(false);
  });

  it('every text a player can see, gathered for the translation table', () => {
    const project = {
      shared: {
        controls: [{ inputs: [{ type: 'screen', label: 'Fire' }, { type: 'key', code: 'KeyE' }] }],
        prefabs: { Chest: { rules: [{ when: { type: 'interact', prompt: 'Open the chest' }, do: [] }] } },
      },
      levels: [
        { name: 'The Cave', scene: { entities: [{ rules: [
          { when: { type: 'start' }, do: [{ type: 'showMessage', text: 'Find the key' }], else: [{ type: 'showMessage', text: 'Too dark' }] },
          { when: { type: 'interact' }, do: [{ type: 'win', message: 'Out at last!' }] },
        ] }] } },
        { name: 'The Sea', scene: { entities: [] } },
      ],
    };
    const ui = normalizeUI({ title: { enabled: true, text: 'Deep Down', subtitle: 'A cave game' }, hud: { coins: { show: 'number', label: 'Coins' }, lives: { show: 'hearts' } } });
    const { game, engine } = collectTexts(project, ui);
    for (const s of ['The Cave', 'The Sea', 'Find the key', 'Too dark', 'Interact', 'Out at last!', 'Open the chest', 'Fire', 'Deep Down', 'A cave game', 'Coins', 'lives']) {
      expect(game, s).toContain(s);
    }
    expect(engine).toContain('Paused');
    expect(engine.length).toBeLessThanOrEqual(ENGINE_TEXTS.length);
  });

  it('on screen: messages, the HUD, prompts and the pause menu in the player\'s language — Persian right to left', () => {
    const engine = {
      variables: new VariableStore(), ui: normalizeUI({ hud: { coins: { show: 'number', label: 'Coins' } } }),
      gameplay: { controls: { prompt: { key: 'E', text: 'Open the door' }, list: [] } }, input: null, audio: null,
    };
    engine.variables.define('coins', 3);
    i18n.load(LANGS, { game: 'Screen Test' });
    i18n.setLanguage('es');
    const overlay = new PlayOverlay(engine, { hud: true });
    overlay.show();
    overlay.update();
    expect(document.querySelector('.t3-hud').textContent).toBe('Monedas3');
    expect(document.querySelector('.t3-prompt').textContent).toBe('EAbre la puerta');
    overlay.message('Open the door');
    expect(document.querySelector('.t3-message').textContent).toBe('Abre la puerta');
    overlay.pauseMenu({});
    expect(document.querySelector('.t3-pause h2').textContent).toBe('En pausa');
    const pick = document.querySelector('.t3-pause [data-lang]');
    expect([...pick.options].map((o) => o.value)).toEqual(['en', 'es', 'fa']);
    // the player picks Persian in the pause menu: kept, and everything turns round
    pick.value = 'fa';
    pick.dispatchEvent(new Event('change', { bubbles: true }));
    expect(i18n.language).toBe('fa');
    overlay.update();
    expect(document.querySelector('.t3-prompt').textContent).toBe('Eدر را باز کن');
    expect(overlay.root.dir).toBe('rtl');
    expect(document.querySelector('.t3-pause').dir).toBe('rtl');
    expect(localStorage.getItem('tiny3.lang:Screen Test')).toBe('fa');
    overlay._closePause?.();
    document.querySelector('.t3-pause')?.remove();
    overlay.hide();
    i18n.load({}); // back to one language for the other tests
  });
});
