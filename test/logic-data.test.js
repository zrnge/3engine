// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { world } from './helpers/world.js';

// Data and logic: text, lists and records in variables; Waits (sequences),
// events between objects (and timers), states, expressions.

const rule = (engine, e, r) => engine.gameplay.rules.add(e, { if: [], do: [], ...r });
const pressed = (code) => ({ type: 'key', code, mode: 'pressed' });

describe('data: text, lists, records', () => {
  it('an inventory: add, no doubles, remove, contains — and a message reads it', () => {
    const { engine, add, step, input } = world();
    engine.variables.define('inventory', []);
    const chest = add('chest');
    rule(engine, chest, { when: pressed('KeyE'), do: [
      { type: 'listAdd', name: 'inventory', value: 'key', unique: true },
      { type: 'listAdd', name: 'inventory', value: 'map', where: 'at the start' },
      { type: 'showMessage', text: 'You carry {len(inventory)}: {inventory}', seconds: 2 },
    ] });
    const door = add('door');
    rule(engine, door, { when: pressed('KeyF'), if: [{ type: 'listContains', name: 'inventory', value: 'key' }],
      do: [{ type: 'listRemove', name: 'inventory', which: 'this value', value: 'key' }, { type: 'setVariable', name: 'opened', value: 'true' }] });
    engine.gameplay.start();

    input.press('KeyE'); step();
    input.press('KeyE'); step();
    expect(engine.variables.get('inventory')).toEqual(['map', 'map', 'key']); // the key once only
    expect(engine.onMessage).toHaveBeenLastCalledWith('You carry 3: map, map, key', expect.anything());

    input.press('KeyF'); step();
    expect(engine.variables.get('inventory')).toEqual(['map', 'map']);
    expect(engine.variables.get('opened')).toBe(true);
    // no key now: the door rule does nothing
    engine.variables.set('opened', false);
    input.press('KeyF'); step();
    expect(engine.variables.get('opened')).toBe(false);
  });

  it('list removal: every one, the first, the last, everything', () => {
    const { engine, add, step, input } = world();
    engine.variables.define('l', ['a', 'b', 'a', 'c']);
    const e = add('e');
    const keys = { KeyA: 'every one of this value', KeyB: 'the first', KeyC: 'the last', KeyD: 'everything' };
    for (const [key, which] of Object.entries(keys)) rule(engine, e, { when: pressed(key), do: [{ type: 'listRemove', name: 'l', which, value: 'a' }] });
    engine.gameplay.start();
    input.press('KeyA'); step(); expect(engine.variables.get('l')).toEqual(['b', 'c']);
    input.press('KeyB'); step(); expect(engine.variables.get('l')).toEqual(['c']);
    engine.variables.set('l', [1, 2, 3]);
    input.press('KeyC'); step(); expect(engine.variables.get('l')).toEqual([1, 2]);
    input.press('KeyD'); step(); expect(engine.variables.get('l')).toEqual([]);
  });

  it('a quest record: fields set and compared; text and numbers worked out from others', () => {
    const { engine, add, step, input } = world();
    engine.variables.define('quest', { stage: 0, giver: 'Gran' });
    engine.variables.define('coins', 4);
    engine.variables.define('name', 'Ada');
    const e = add('npc');
    rule(engine, e, { when: pressed('KeyT'), do: [
      { type: 'setField', name: 'quest', field: 'stage', value: '=quest.stage + 1' },
      { type: 'changeVariable', name: 'coins', by: '=quest.stage * 10' },
      { type: 'changeVariable', name: 'name', by: ' the brave' },
      { type: 'setVariable', name: 'line', value: '{quest.giver}: well done, {name}!' },
    ] });
    rule(engine, e, { when: pressed('KeyY'), if: [{ type: 'expression', expr: 'quest.stage >= 1 and coins > 10' }],
      do: [{ type: 'setVariable', name: 'rich', value: 'yes!' }] });
    engine.gameplay.start();
    input.press('KeyT'); step();
    expect(engine.variables.get('quest')).toEqual({ stage: 1, giver: 'Gran' });
    expect(engine.variables.get('coins')).toBe(14);
    expect(engine.variables.get('name')).toBe('Ada the brave');
    expect(engine.variables.get('line')).toBe('Gran: well done, Ada the brave!');
    input.press('KeyY'); step();
    expect(engine.variables.get('rich')).toBe('yes!');
    // restarting puts back the starting values, not the played ones
    engine.gameplay.start();
    engine.variables.reset?.();
    expect(engine.variables.get('quest')).toEqual({ stage: 0, giver: 'Gran' });
  });

  it('"Variable becomes" compares any kind of value', () => {
    const { engine, add, step } = world();
    engine.variables.define('mood', 'calm');
    const e = add('e');
    rule(engine, e, { when: { type: 'variable', name: 'mood', op: '==', value: 'angry' }, do: [{ type: 'changeVariable', name: 'fights', by: '1' }] });
    engine.gameplay.start();
    step();
    expect(engine.variables.get('fights', 0)).toBe(0);
    engine.variables.set('mood', 'angry'); step(0.1);
    expect(engine.variables.get('fights')).toBe(1);
  });
});

describe('logic: sequences, events, timers, states', () => {
  it('Wait: the actions after it happen later, and Waits add up', () => {
    const { engine, add, step, input } = world();
    const e = add('e');
    rule(engine, e, { when: pressed('Space'), do: [
      { type: 'setVariable', name: 'step', value: '1' },
      { type: 'wait', seconds: 0.5 },
      { type: 'setVariable', name: 'step', value: '2' },
      { type: 'wait', seconds: 0.5 },
      { type: 'setVariable', name: 'step', value: '3' },
    ] });
    engine.gameplay.start();
    input.press('Space'); step();
    expect(engine.variables.get('step')).toBe(1);
    step(0.4); expect(engine.variables.get('step')).toBe(1);
    step(0.2); expect(engine.variables.get('step')).toBe(2);
    step(0.5); expect(engine.variables.get('step')).toBe(3);
  });

  it('what is waiting is dropped when its object is gone', () => {
    const { engine, add, step, input } = world();
    const e = add('bomb');
    rule(engine, e, { when: pressed('Space'), do: [{ type: 'wait', seconds: 1 }, { type: 'setVariable', name: 'boom', value: 'true' }] });
    engine.gameplay.start();
    input.press('Space'); step();
    e.alive = false; engine.remove(e);
    step(1.5);
    expect(engine.variables.get('boom', false)).toBe(false);
  });

  it('events: sent to a group, to anything listening, and heard by the right ones only', () => {
    const { engine, add, step, input } = world();
    const alarm = add('alarm');
    const g1 = add('guard1', { groups: ['guards'] });
    const g2 = add('guard2', { groups: ['guards'] });
    const cat = add('cat');
    for (const g of [g1, g2]) rule(engine, g, { when: { type: 'event', name: 'alarm' }, do: [{ type: 'changeVariable', name: 'alerted', by: '1' }] });
    rule(engine, cat, { when: { type: 'event', name: 'alarm' }, do: [{ type: 'changeVariable', name: 'cats', by: '1' }] });
    rule(engine, cat, { when: { type: 'event', name: 'dinner' }, do: [{ type: 'changeVariable', name: 'fed', by: '1' }] });
    rule(engine, alarm, { when: pressed('KeyG'), do: [{ type: 'sendEvent', name: 'Alarm', to: 'group:guards' }] });
    rule(engine, alarm, { when: pressed('KeyA'), do: [{ type: 'sendEvent', name: 'alarm', to: 'any' }] });
    engine.gameplay.start();
    input.press('KeyG'); step();
    expect(engine.variables.get('alerted')).toBe(2);
    expect(engine.variables.get('cats', 0)).toBe(0);
    input.press('KeyA'); step();
    expect(engine.variables.get('alerted')).toBe(4);
    expect(engine.variables.get('cats')).toBe(1);
    expect(engine.variables.get('fed', 0)).toBe(0);
  });

  it('the one who sent an event is "other" to who hears it', () => {
    const { engine, add, step, input } = world();
    const caller = add('caller');
    const helper = add('helper');
    rule(engine, helper, { when: { type: 'event', name: 'help' }, do: [{ type: 'sendEvent', name: 'coming', to: 'other' }] });
    rule(engine, caller, { when: { type: 'event', name: 'coming' }, do: [{ type: 'setVariable', name: 'answered', value: 'true' }] });
    rule(engine, caller, { when: pressed('KeyH'), do: [{ type: 'sendEvent', name: 'help', to: 'helper' }] });
    engine.gameplay.start();
    input.press('KeyH'); step();
    expect(engine.variables.get('answered')).toBe(true);
  });

  it('a timer: an event sent to itself later, again and again', () => {
    const { engine, add, step } = world();
    const clock = add('clock');
    rule(engine, clock, { when: { type: 'start' }, do: [{ type: 'sendEvent', name: 'tick', to: 'self', after: 1 }] });
    rule(engine, clock, { when: { type: 'event', name: 'tick' }, do: [
      { type: 'changeVariable', name: 'ticks', by: '1' },
      { type: 'sendEvent', name: 'tick', to: 'self', after: 1 },
    ] });
    engine.gameplay.start();
    step(0.9); expect(engine.variables.get('ticks', 0)).toBe(0);
    step(0.2); expect(engine.variables.get('ticks')).toBe(1);
    step(2); expect(engine.variables.get('ticks')).toBe(3);
  });

  it('states: set, entered once, asked by conditions and expressions, cleared on restart', () => {
    const { engine, add, step, input } = world();
    const guard = add('guard');
    rule(engine, guard, { when: pressed('KeyC'), do: [{ type: 'setState', target: 'self', state: 'chasing' }] });
    rule(engine, guard, { when: { type: 'stateEnter', state: 'chasing' }, do: [{ type: 'changeVariable', name: 'chases', by: '1' }] });
    rule(engine, guard, { when: pressed('KeyQ'), if: [{ type: 'state', who: 'self', state: 'chasing' }], do: [{ type: 'setVariable', name: 'q', value: 'true' }] });
    rule(engine, guard, { when: pressed('KeyX'), if: [{ type: 'expression', expr: 'state == "chasing"' }], do: [{ type: 'setVariable', name: 'x', value: 'true' }] });
    engine.gameplay.start();
    input.press('KeyQ'); step();
    expect(engine.variables.get('q', false)).toBe(false);
    input.press('KeyC'); step();
    input.press('KeyC'); step(); // already chasing: not entered again
    expect(guard.state).toBe('chasing');
    expect(engine.variables.get('chases')).toBe(1);
    input.press('KeyQ'); input.press('KeyX'); step();
    expect(engine.variables.get('q')).toBe(true);
    expect(engine.variables.get('x')).toBe(true);
    engine.gameplay.start();
    expect(guard.state ?? '').toBe('');
  });

  it('a rule whose expression is broken stops itself and says why — the others carry on', () => {
    const { engine, add, step, input } = world();
    const e = add('e');
    rule(engine, e, { when: pressed('KeyB'), do: [{ type: 'setVariable', name: 'v', value: '=explode(1)' }] });
    rule(engine, e, { when: pressed('KeyB'), do: [{ type: 'setVariable', name: 'ok', value: 'true' }] });
    const err = console.error;
    console.error = () => {};
    try {
      engine.gameplay.start();
      input.press('KeyB'); step();
    } finally { console.error = err; }
    expect(engine.variables.get('ok')).toBe(true);
    expect(engine.variables.get('v', 'unset')).toBe('unset');
  });
});
