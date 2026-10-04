// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { world } from './helpers/world.js';
import { normalizeUI } from '../src/game-ui.js';
import { screenHtml, dialogueHtml, listTiles, normalizeScreen, lineAfter, normalizeDialogue } from '../src/screens.js';

// The game's own screens (menus, an inventory) and dialogues: data, what they look like,
// and while it plays — opened by rules and keys, their buttons and choices running rules.

const rule = (engine, e, r) => engine.gameplay.rules.add(e, { if: [], do: [], ...r });

function game({ screens = [], dialogues = [], vars = {} } = {}) {
  const w = world();
  w.engine.ui = normalizeUI({ screens, dialogues });
  for (const [k, v] of Object.entries(vars)) w.engine.variables.define(k, v);
  w.hub = w.add('Hub');
  w.engine.gameplay.start();
  return w;
}

const INVENTORY = {
  name: 'Inventory', title: 'Your bag ({len(bag)})', pauses: true,
  items: [
    { type: 'text', text: 'Coins: {coins}' },
    { type: 'list', variable: 'bag', columns: 3, pick: 'picked' },
    { type: 'button', label: 'Use', does: 'run its rules', key: 'KeyU' },
    { type: 'button', label: 'Map', does: 'open a screen', screen: 'Map' },
    { type: 'button', label: 'Close', does: 'close this screen' },
  ],
};
const MAP = { name: 'Map', pauses: false, dim: false, items: [{ type: 'text', text: 'You are here' }] };
const TALK = {
  name: 'Smith',
  lines: [
    { who: 'Smith', text: 'Need a sword, {name}?', choices: [
      { text: 'Yes (5 coins)', if: 'coins >= 5', setVar: 'coins', setTo: '=coins - 5', event: 'bought', goto: 'thanks' },
      { text: 'Tell me about the guards', goto: 'guards' },
      { text: 'No', goto: 'end' },
    ] },
    { id: 'guards', who: 'Smith', text: 'Three of them. They hate the bell.', next: 'end' },
    { id: 'thanks', who: 'Smith', text: 'Mind the edge.' },
  ],
};

describe('data', () => {
  it('screens and dialogues come through normalizeUI, odd values made sensible', () => {
    const ui = normalizeUI({ screens: [{ name: '  ', place: 'nowhere', width: 99999, items: [{ type: 'nonsense' }, { type: 'button', does: 'fly' }] }], dialogues: [{}] });
    expect(ui.screens[0]).toMatchObject({ name: 'Menu', place: 'middle', width: 1200, pauses: true });
    expect(ui.screens[0].items.map((i) => i.type)).toEqual(['text', 'button']);
    expect(ui.screens[0].items[1].does).toBe('run its rules');
    expect(ui.dialogues[0].lines.length).toBe(1); // never a dialogue of nothing
  });

  it('where a line goes: the next one, the end, a named one', () => {
    const d = normalizeDialogue(TALK);
    expect(lineAfter(d, 0, '')).toBe(1);
    expect(lineAfter(d, 2, '')).toBe(-1); // past the last: the end
    expect(lineAfter(d, 0, 'END')).toBe(-1);
    expect(lineAfter(d, 0, 'thanks')).toBe(2);
  });

  it('a screen\'s HTML: text worked out, a list as tiles (the same ones together), buttons with their keys', () => {
    const { engine } = game({ vars: { coins: 7, bag: ['potion', 'key', 'potion'] } });
    const html = screenHtml(normalizeScreen(INVENTORY), 0, { vars: engine.variables });
    expect(html).toContain('Your bag (3)');
    expect(html).toContain('Coins: 7');
    expect(html).toContain('potion<small>×2</small>');
    expect(html).toContain('<kbd>U</kbd>Use');
    expect(listTiles(['a', 'a', 'b'], false).length).toBe(3);
    engine.variables.set('bag', []);
    expect(screenHtml(normalizeScreen(INVENTORY), 0, { vars: engine.variables })).toContain('Nothing yet');
  });
});

describe('screens while it plays', () => {
  it('a rule shows, hides and toggles a screen; one that pauses holds the game still', () => {
    const { engine, hub, step, input } = game({ screens: [INVENTORY, MAP], vars: { bag: [] } });
    rule(engine, hub, { when: { type: 'key', code: 'KeyI', mode: 'pressed' }, do: [{ type: 'showScreen', screen: 'Inventory', how: 'show or hide (toggle)' }] });
    rule(engine, hub, { when: { type: 'key', code: 'KeyM', mode: 'pressed' }, do: [{ type: 'showScreen', screen: 'Map', how: 'show' }] });
    const ui = engine.gameplay.screens;
    input.press('KeyM'); step();
    expect(ui.isOpen('map')).toBe(true);
    expect(engine.uiHold).toBe(false); // a map that doesn't pause
    input.press('KeyI'); step();
    expect(ui.open).toEqual(['Map', 'Inventory']);
    expect(engine.uiHold).toBe(true);
    ui.toggle('Inventory');
    expect(ui.isOpen('Inventory')).toBe(false);
    expect(engine.uiHold).toBe(false);
    ui.hide('all');
    expect(ui.open).toEqual([]);
    expect(ui.show('Nope')).toBe(false); // no such screen: nothing, a warning
  });

  it('buttons: close this, open another, and every button runs "A button is pressed" rules', () => {
    const { engine, hub } = game({ screens: [INVENTORY, MAP], vars: { bag: [] } });
    rule(engine, hub, { when: { type: 'uiButton', screen: 'Inventory', button: 'Use' }, do: [{ type: 'changeVariable', name: 'used', by: '1' }] });
    rule(engine, hub, { when: { type: 'uiButton', screen: '', button: '' }, do: [{ type: 'changeVariable', name: 'any', by: '1' }] });
    const ui = engine.gameplay.screens;
    ui.show('Inventory');
    ui.press(0, 2); // Use
    expect(engine.variables.get('used')).toBe(1);
    ui.press(0, 3); // Map
    expect(ui.isOpen('Map')).toBe(true);
    ui.press(0, 4); // Close
    expect(ui.isOpen('Inventory')).toBe(false);
    expect(engine.variables.get('any')).toBe(3);
    // its key presses it too, while the screen is up
    ui.show('Inventory');
    expect(ui.key('KeyU')).toBe(true);
    expect(engine.variables.get('used')).toBe(2);
    expect(ui.key('KeyZ')).toBe(false);
  });

  it('an inventory: picking an item puts it in a variable and runs "An item is picked" — using it up', () => {
    const { engine, hub } = game({ screens: [INVENTORY], vars: { bag: ['potion', 'key', 'potion'], health: 1 } });
    rule(engine, hub, { when: { type: 'uiPick', screen: 'Inventory', list: 'bag' }, if: [{ type: 'expression', expr: 'picked == "potion"' }], do: [
      { type: 'changeVariable', name: 'health', by: '2' },
      { type: 'listRemove', name: 'bag', which: 'this value', value: 'potion' },
    ] });
    const ui = engine.gameplay.screens;
    ui.show('Inventory');
    ui.pick(0, 1, 0); // the potions' tile
    expect(engine.variables.get('picked')).toBe('potion');
    expect(engine.variables.get('health')).toBe(3);
    expect(engine.variables.get('bag')).toEqual(['key', 'potion']);
    ui.pick(0, 1, 0); // now the key's tile
    expect(engine.variables.get('picked')).toBe('key');
    expect(engine.variables.get('health')).toBe(3);
  });

  it('a condition asks whether a screen is up; play starting closes everything', () => {
    const { engine, hub, step } = game({ screens: [MAP] });
    rule(engine, hub, { when: { type: 'update', every: 0 }, if: [{ type: 'screenOpen', screen: 'Map' }], do: [{ type: 'setVariable', name: 'up', value: 'true' }],
      else: [{ type: 'setVariable', name: 'up', value: 'false' }] });
    step();
    expect(engine.variables.get('up')).toBe(false);
    engine.gameplay.screens.show('Map');
    step();
    expect(engine.variables.get('up')).toBe(true);
    engine.gameplay.start();
    expect(engine.gameplay.screens.open).toEqual([]);
  });
});

describe('dialogue while it plays', () => {
  it('lines, choices only if they hold, a choice that sets a variable and sends an event, then where it goes', () => {
    const { engine, hub, input, step } = game({ dialogues: [TALK], vars: { coins: 3, name: 'Ada' } });
    rule(engine, hub, { when: { type: 'interact', who: 'any' }, do: [] });
    rule(engine, hub, { when: { type: 'key', code: 'KeyT', mode: 'pressed' }, do: [{ type: 'startDialogue', dialogue: 'Smith' }] });
    rule(engine, hub, { when: { type: 'event', name: 'bought' }, do: [{ type: 'listAdd', name: 'bag', value: 'sword' }] });
    rule(engine, hub, { when: { type: 'dialogueEnd', dialogue: 'Smith' }, do: [{ type: 'changeVariable', name: 'talks', by: '1' }] });
    const ui = engine.gameplay.screens;
    input.press('KeyT'); step();
    let v = ui.view();
    expect(v.who).toBe('Smith');
    expect(v.text).toBe('Need a sword, Ada?');
    expect(v.choices.map((c) => c.text)).toEqual(['Tell me about the guards', 'No']); // 3 coins: can't buy
    expect(engine.uiHold).toBe(true);
    ui.choose(0); // about the guards
    expect(ui.view().text).toMatch(/hate the bell/);
    ui.advance(); // its next: the end
    expect(ui.talking).toBe(false);
    expect(engine.variables.get('talks')).toBe(1);
    expect(engine.uiHold).toBe(false);
    // with the coins: buy it
    engine.variables.set('coins', 8);
    ui.startDialogue('Smith');
    v = ui.view();
    expect(v.choices[0].text).toBe('Yes (5 coins)');
    expect(ui.key('Digit1')).toBe(true); // 1 picks the first choice
    expect(engine.variables.get('coins')).toBe(3);
    expect(engine.variables.get('bag')).toEqual(['sword']);
    expect(ui.view().text).toBe('Mind the edge.');
    expect(ui.key('Space')).toBe(true); // Space goes on: the last line, the end
    expect(ui.talking).toBe(false);
    expect(engine.variables.get('talks')).toBe(2);
  });

  it('the dialogue box\'s HTML: who, the line, numbered choices (or Continue)', () => {
    const html = dialogueHtml({ who: 'Gran', text: 'Hush.', pauses: true, choices: [{ text: 'OK', index: 0 }] });
    expect(html).toContain('Gran');
    expect(html).toContain('<kbd>1</kbd>OK');
    expect(dialogueHtml({ who: '', text: 'Hm.', pauses: false, choices: [] })).toContain('Continue');
  });

  it('a control can open a screen with a key (the rule actions are control actions too)', () => {
    const w = world({ controls: [{ inputs: [{ type: 'key', code: 'Tab' }], target: 'player', action: { type: 'showScreen', screen: 'Map', how: 'show or hide (toggle)' } }] });
    w.engine.ui = normalizeUI({ screens: [MAP] });
    w.engine.hero = w.add('Hero');
    w.engine.gameplay.start();
    w.input.press('Tab'); w.step();
    expect(w.engine.gameplay.screens.isOpen('Map')).toBe(true);
    w.input.press('Tab'); w.step();
    expect(w.engine.gameplay.screens.isOpen('Map')).toBe(false);
  });
});
