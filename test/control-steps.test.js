// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { normalizeControl, normalizeStep } from '../src/controls.js';
import { world } from './helpers/world.js';

// A control that does more than one thing: its own Do, then more — each joined
// by AND (at the same moment), THEN (after a wait) or OR (otherwise).

const add = (name, by = 1) => ({ type: 'changeVariable', name, by });
const has = (name, value = 1) => ({ type: 'variable', name, op: '>=', value });
const control = (action, more = [], extra = {}) => ({ inputs: [{ type: 'key', code: 'KeyE' }], target: 'player', action, more, ...extra });

function play(controls) {
  const w = world({ controls });
  w.engine.hero = w.add('Hero');
  w.engine.gameplay.start();
  const press = () => { w.input.press('KeyE'); w.step(); w.input.release('KeyE'); w.step(); };
  const v = (name) => w.engine.variables.get(name);
  return { ...w, press, v };
}

describe('a control\'s further Do\'s: AND, THEN, OR', () => {
  it('AND: at the same moment', () => {
    const { press, v } = play([control(add('a'), [{ join: 'and', action: add('b') }, { join: 'and', action: add('c', 5) }])]);
    press();
    expect([v('a'), v('b'), v('c')]).toEqual([1, 1, 5]);
  });

  it('THEN: after a wait — THENs add up', () => {
    const { press, step, v } = play([control(add('a'), [
      { join: 'then', after: 0.5, action: add('b') },
      { join: 'then', after: 0.5, action: add('c') },
      { join: 'and', action: add('d') }, // with the THEN before it: at 1 s
    ])]);
    press();
    expect([v('a'), v('b'), v('c'), v('d')]).toEqual([1, 0, 0, 0]);
    step(0.5);
    expect([v('b'), v('c')]).toEqual([1, 0]);
    step(0.55);
    expect([v('c'), v('d')]).toEqual([1, 1]);
  });

  it('OR: otherwise — shoot if there is ammo, or else say "Reload!"', () => {
    const { press, engine, v } = play([control(add('shots'), [{ join: 'or', action: add('clicks') }], { if: [has('ammo')] })]);
    press();
    expect([v('shots'), v('clicks')]).toEqual([0, 1]); // no ammo: the OR
    engine.variables.set('ammo', 3);
    press();
    expect([v('shots'), v('clicks')]).toEqual([1, 1]); // ammo: the control's own Do, not the OR
  });

  it('OR … OR: the first that can (else if), and the ANDs go with their group', () => {
    const { press, engine, v } = play([control(add('opened'), [
      { join: 'and', action: add('creaks') },                      // with "opened"
      { join: 'or', if: [has('lockpick')], action: add('picked') }, // else if a lockpick
      { join: 'and', action: add('pickSounds') },                  // with "picked"
      { join: 'or', action: add('locked') },                        // else
    ], { if: [has('key')] })]);
    press();
    expect([v('opened'), v('creaks'), v('picked'), v('pickSounds'), v('locked')]).toEqual([0, 0, 0, 0, 1]);
    engine.variables.set('lockpick', 1);
    press();
    expect([v('picked'), v('pickSounds'), v('locked')]).toEqual([1, 1, 1]);
    engine.variables.set('key', 1);
    press();
    expect([v('opened'), v('creaks'), v('picked'), v('locked')]).toEqual([1, 1, 1, 1]); // the key wins: nothing else
  });

  it('a Do\'s own Only if: an AND that only happens sometimes', () => {
    const { press, engine, v } = play([control(add('jumps'), [{ join: 'and', if: [has('double')], action: add('flips') }])]);
    press();
    engine.variables.set('double', 1);
    press();
    expect([v('jumps'), v('flips')]).toEqual([2, 1]);
  });

  it('a Do that acts every frame (turn per second) acts while held — not only on the press', () => {
    const { engine, input, step } = play([control(add('pressed'), [{ join: 'and', action: { type: 'turn', degrees: 90, how: 'per second' } }])]);
    input.press('KeyE');
    step(1);
    input.release('KeyE');
    step(0.5);
    const yaw = new THREE.Vector3(0, 0, 1).applyQuaternion(engine.hero.object3D.quaternion);
    expect(Math.round(THREE.MathUtils.radToDeg(Math.atan2(yaw.x, yaw.z)))).toBe(90);
    expect(engine.variables.get('pressed')).toBe(1);
  });

  it('a cooldown on the control holds its further Do\'s back too', () => {
    const { press, step, v } = play([control(add('a'), [{ join: 'and', action: add('b') }, { join: 'or', action: add('tooSoon') }],
      { if: [{ type: 'cooldown', seconds: 1 }] })]);
    press();
    press(); // within the second
    expect([v('a'), v('b'), v('tooSoon')]).toEqual([1, 1, 1]);
    step(1);
    press();
    expect([v('a'), v('b')]).toEqual([2, 2]);
  });

  it('saved clean: joins, waits, their own conditions; not a rule action — left out', () => {
    const c = normalizeControl(control(add('a'), [
      { join: 'then', action: add('b') },
      { join: 'nonsense', after: 9, action: { type: 'showMessage', text: 'Hi' } },
      { join: 'or', action: { type: 'sprint' } },
      { join: 'or', if: [has('x')], action: add('c') },
    ]));
    expect(c.more.map((s) => [s.join, s.after])).toEqual([['then', 0.5], ['and', undefined], ['or', undefined]]);
    expect(c.more[1].action).toMatchObject({ type: 'showMessage', text: 'Hi', seconds: 3 });
    expect(c.more[2].if).toEqual([{ type: 'variable', name: 'x', op: '>=', value: 1 }]);
    expect(normalizeControl(control(add('a'))).more).toBeUndefined(); // none: nothing saved
    expect(normalizeStep({ join: 'then', after: -3, action: add('z') }).after).toBe(0);
  });
});

describe('an Only if\'s own Do\'s: if yes, do — if not, do', () => {
  it('on the control: shoot with ammo (and count it); without, say so — one control', () => {
    const { press, engine, v } = play([control(add('shots'), [], {
      if: [has('ammo')],
      yes: [{ action: add('ammo', -1) }, { action: add('flash') }],
      no: [{ action: add('clicks') }, { action: add('hint'), after: 0.5 }],
    })]);
    engine.variables.set('ammo', 2);
    press();
    expect([v('shots'), v('ammo'), v('flash'), v('clicks')]).toEqual([1, 1, 1, 0]);
    press();
    press(); // empty now
    expect([v('shots'), v('ammo'), v('clicks'), v('hint')]).toEqual([2, 0, 1, 0]);
  });

  it('...an if-not Do with a wait happens after it', () => {
    const { press, step, v } = play([control(add('shots'), [], { if: [has('ammo')], no: [{ action: add('hint'), after: 0.5 }] })]);
    press();
    expect(v('hint')).toBe(0);
    step(0.6);
    expect(v('hint')).toBe(1);
  });

  it('on a further Do: its own Only if picks its yes or its no', () => {
    const { press, engine, v } = play([control(add('a'), [
      { join: 'and', action: add('b'), if: [has('key')], yes: [{ action: add('opened') }], no: [{ action: add('locked') }] },
    ])]);
    press();
    expect([v('a'), v('b'), v('opened'), v('locked')]).toEqual([1, 0, 0, 1]);
    engine.variables.set('key', 1);
    press();
    expect([v('a'), v('b'), v('opened'), v('locked')]).toEqual([2, 1, 1, 1]);
  });

  it('not pressed: neither', () => {
    const { step, v } = play([control(add('a'), [], { if: [has('x')], yes: [{ action: add('y') }], no: [{ action: add('n') }] })]);
    step(0.5);
    expect([v('y'), v('n')]).toEqual([0, 0]);
  });

  it('kept clean when saved: an action of a rule\'s, a wait only if one', () => {
    const c = normalizeControl(control(add('a'), [], {
      if: [has('x')], yes: [{ action: add('y'), after: 0 }, { action: { type: 'nonsense' } }], no: [{ action: add('n'), after: 2 }],
    }));
    expect(c.yes).toEqual([{ action: add('y') }]);
    expect(c.no).toEqual([{ action: add('n'), after: 2 }]);
    const s = normalizeStep({ join: 'and', action: add('b'), if: [has('k')], no: [{ action: add('z') }] });
    expect(s.no).toEqual([{ action: add('z') }]);
  });
});

describe('the order: decided at the press, done after the control\'s own Do', () => {
  it('the last round: "shoot if ammo > 0" AND "ammo − 1" — the shot still goes', () => {
    const { press, engine, v } = play([control(add('shots'), [{ join: 'and', action: add('ammo', -1) }], { if: [has('ammo')] })]);
    engine.variables.set('ammo', 1);
    press();
    expect([v('shots'), v('ammo')]).toEqual([1, 0]);
    press();
    expect([v('shots'), v('ammo')]).toEqual([1, 0]); // empty: neither
  });

  it('...and with "if yes, do: ammo − 1"', () => {
    const { press, engine, v } = play([control(add('shots'), [], { if: [has('ammo')], yes: [{ action: add('ammo', -1) }] })]);
    engine.variables.set('ammo', 1);
    press();
    expect([v('shots'), v('ammo')]).toEqual([1, 0]);
  });
});
