// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { EVENTS, HIT_FROM, HIT_WITH, ACTIONS } from '../src/rules.js';
import { CONTROL_ACTIONS } from '../src/controls.js';
import { world } from './helpers/world.js';

// "Something hits me": it moves into me — not me into it — how hard, and from which side of me.

/** A target with a "Something hits me" rule counting hits (and keeping the speed), and a ball to throw at it. */
function range(when = {}) {
  const w = world();
  const { engine, add } = w;
  add('Floor', { at: [0, -0.5, 0], size: [60, 1, 60], body: { type: 'static' } });
  const target = add('Target', { at: [0, 1, 0], size: [1, 2, 1], body: { type: 'static' } });
  engine.gameplay.rules.add(target, {
    when: { type: 'hitBy', who: 'any', harder: 1, from: 'anywhere', speedTo: 'speed', ...when }, if: [],
    do: [{ type: 'changeVariable', name: 'hits', by: 1 }],
  });
  engine.gameplay.start();
  return { ...w, target };
}

const throwBall = ({ add, engine }, at, velocity, name = 'Ball') => {
  const ball = add(name, { at, size: [0.5, 0.5, 0.5], body: { type: 'dynamic', shape: 'sphere', gravity: 0, friction: 0 } });
  ball.rigidBody.velocity.set(...velocity);
  return ball;
};

describe('Something hits me', () => {
  it('is a rule event: what, how hard, from which side, its speed into a variable, at which part', () => {
    const e = EVENTS.hitBy;
    expect(e.label).toBe('Something hits me');
    expect(Object.keys(e.props)).toEqual(['with', 'who', 'by', 'harder', 'from', 'speedTo', 'part']);
    expect(HIT_FROM).toEqual(['anywhere', 'above', 'below', 'the front', 'behind', 'a side']);
    expect(HIT_WITH).toEqual(['anything', 'a shot', 'something thrown', 'a vehicle', 'an attack', 'a moving object']);
  });

  it('a thrown ball hits it: the rule runs once, with how fast it came', () => {
    const w = range();
    throwBall(w, [0, 1, -3], [0, 0, 10]);
    w.step(0.6);
    expect(w.engine.variables.get('hits')).toBe(1);
    expect(w.engine.variables.get('speed')).toBeGreaterThan(8);
    expect(w.engine.variables.get('speed')).toBeLessThan(11);
  });

  it('too slow is not a hit (Harder than)', () => {
    const w = range({ harder: 5 });
    throwBall(w, [0, 1, -2], [0, 0, 2]);
    w.step(1.5);
    expect(w.engine.variables.get('hits')).toBe(0);
  });

  it('only what it is told: a ball named Rock, not one named Ball', () => {
    const w = range({ who: 'Rock' });
    throwBall(w, [0, 1, -3], [0, 0, 10], 'Ball');
    throwBall(w, [0, 1, 3], [0, 0, -10], 'Rock');
    w.step(0.6);
    expect(w.engine.variables.get('hits')).toBe(1);
  });

  it('from which side, as it faces: the front, behind, a side, above', () => {
    const sides = {};
    for (const [from, at, v] of [
      ['the front', [0, 1, 3], [0, 0, -10]], // it faces +Z: coming down -Z at it, from its front
      ['behind', [0, 1, -3], [0, 0, 10]],
      ['a side', [3, 1, 0], [-10, 0, 0]],
      ['above', [0, 4, 0], [0, -10, 0]],
    ]) {
      for (const want of ['the front', 'behind', 'a side', 'above']) {
        const w = range({ from: want });
        throwBall(w, at, v);
        w.step(0.6);
        if (w.engine.variables.get('hits') === 1) (sides[from] ??= []).push(want);
      }
    }
    expect(sides).toEqual({ 'the front': ['the front'], behind: ['behind'], 'a side': ['a side'], above: ['above'] });
  });

  it('turned round, its front is the other way', () => {
    const w = range({ from: 'the front' });
    w.target.object3D.rotation.y = Math.PI;
    w.target.object3D.updateMatrixWorld(true);
    throwBall(w, [0, 1, -3], [0, 0, 10]); // from -Z: now its front
    w.step(0.6);
    expect(w.engine.variables.get('hits')).toBe(1);
  });

  it('walking into a wall: the wall is hit by the player — the player is not hit by the wall', () => {
    const w = world();
    const { engine, add, step } = w;
    add('Floor', { at: [0, -0.5, 0], size: [60, 1, 60], body: { type: 'static' } });
    const wall = add('Wall', { at: [0, 1.5, -3], size: [6, 3, 0.5], body: { type: 'static' } });
    const hero = add('Hero', { at: [0, 0.9, 0], size: [0.6, 1.6, 0.6], body: { type: 'dynamic', shape: 'capsule', friction: 0.1 } });
    engine.hero = hero;
    engine.gameplay.rules.add(wall, { when: { type: 'hitBy', who: 'player', harder: 1 }, if: [], do: [{ type: 'changeVariable', name: 'wallHit', by: 1 }] });
    engine.gameplay.rules.add(hero, { when: { type: 'hitBy', who: 'any', harder: 0 }, if: [], do: [{ type: 'changeVariable', name: 'heroHit', by: 1 }] });
    // and "I bump into something" still hears both sides
    engine.gameplay.rules.add(hero, { when: { type: 'collision', who: 'Wall' }, if: [], do: [{ type: 'changeVariable', name: 'bumped', by: 1 }] });
    engine.gameplay.start();
    step(0.3);
    for (let t = 0; t < 1.2; t += 1 / 60) {
      hero.rigidBody.velocity.z = -5;
      step();
    }
    expect(engine.variables.get('wallHit')).toBe(1);
    expect(engine.variables.get('heroHit')).toBe(0);
    expect(engine.variables.get('bumped')).toBe(1);
  });

  it('a moving door (no physics of its own moving it, just a rule) hits the player standing in its way', () => {
    const w = world();
    const { engine, add, step } = w;
    add('Floor', { at: [0, -0.5, 0], size: [60, 1, 60], body: { type: 'static' } });
    const hero = add('Hero', { at: [0, 0.9, 0], size: [0.6, 1.6, 0.6], body: { type: 'dynamic', shape: 'capsule', friction: 0.1 } });
    engine.hero = hero;
    const door = add('Door', { at: [0, 1, -3], size: [2, 2, 0.3], body: { type: 'kinematic' } });
    engine.gameplay.rules.add(hero, { when: { type: 'hitBy', who: 'Door', harder: 1, speedTo: 'doorSpeed' }, if: [], do: [{ type: 'changeVariable', name: 'heroHit', by: 1 }] });
    engine.gameplay.start();
    step(0.3);
    for (let t = 0; t < 1; t += 1 / 60) {
      door.object3D.position.z += 4 / 60; // 4 m/s at the player
      step();
    }
    expect(engine.variables.get('heroHit')).toBe(1);
    expect(engine.variables.get('doorSpeed')).toBeCloseTo(4, 0);
  });

  describe('with what, done by whom', () => {
    /** A target listening for each kind of hit; and the player, facing it 2 m away. */
    function arena(controls = []) {
      const w = world({ controls });
      const { engine, add } = w;
      add('Floor', { at: [0, -0.5, 0], size: [60, 1, 60], body: { type: 'static' } });
      const target = add('Target', { at: [0, 1, 0], size: [1, 2, 1], body: { type: 'dynamic', friction: 0.5 } });
      const hero = add('Hero', { at: [0, 0.9, -2], size: [0.6, 1.6, 0.6], body: { type: 'dynamic', shape: 'capsule', friction: 0.1 } });
      engine.hero = hero; // faces +Z: the target
      for (const kind of HIT_WITH.slice(1)) {
        engine.gameplay.rules.add(target, { when: { type: 'hitBy', with: kind, harder: 1 }, if: [],
          do: [{ type: 'changeVariable', name: kind, by: 1 }] });
      }
      engine.gameplay.start();
      w.step(0.2);
      const counts = () => Object.fromEntries(HIT_WITH.slice(1).map((k) => [k, engine.variables.get(k, 0)]).filter(([, n]) => n));
      return { ...w, target, hero, counts };
    }

    it('a punch on a key: hits what is in front, within reach — an attack, by the player, damaged and knocked back', () => {
      const w = arena([{ inputs: [{ type: 'key', code: 'KeyF' }], target: 'player',
        action: { type: 'attack', aim: 'in front', reach: 2, arc: 90, hits: 'any', damage: 2, push: 4 } }]);
      w.engine.gameplay.components.add(w.target, 'health', { max: 10 });
      w.engine.gameplay.rules.add(w.target, { when: { type: 'hitBy', with: 'an attack', by: 'player' }, if: [],
        do: [{ type: 'changeVariable', name: 'byPlayer', by: 1 }] });
      w.engine.gameplay.rules.add(w.target, { when: { type: 'hitBy', with: 'an attack', by: 'Nobody' }, if: [],
        do: [{ type: 'changeVariable', name: 'byNobody', by: 1 }] });
      w.input.press('KeyF');
      w.step();
      expect(w.counts()).toEqual({ 'an attack': 1 });
      expect(w.engine.variables.get('byPlayer')).toBe(1);
      expect(w.engine.variables.get('byNobody', 0)).toBe(0);
      expect(w.engine.gameplay.components.listFor(w.target).find((c) => c.type === 'health').state.current).toBe(8);
      expect(w.target.rigidBody.velocity.z).toBeGreaterThan(2); // knocked away from the player
    });

    it('...not what is behind it, nor out of reach', () => {
      const w = arena([{ inputs: [{ type: 'key', code: 'KeyF' }], target: 'player', action: { type: 'attack', reach: 2, arc: 90 } }]);
      w.hero.object3D.rotation.y = Math.PI; // turned away
      w.input.press('KeyF');
      w.step();
      expect(w.counts()).toEqual({});
      w.hero.object3D.rotation.y = 0;
      w.hero.object3D.position.z = -5; // too far
      w.input.press('KeyF');
      w.step();
      expect(w.counts()).toEqual({});
    });

    it('a sweep hits every one in reach; else just the nearest', () => {
      for (const [all, want] of [[false, 1], [true, 2]]) {
        const w = arena();
        w.add('Other', { at: [1, 1, 0], size: [1, 2, 1], body: { type: 'static' } });
        const struck = w.engine.gameplay.attack(w.hero, { reach: 3, arc: 120, all });
        expect(struck.length).toBe(want);
      }
    });

    it('a gun (instant hit): a shot, by the shooter, from the side it came', () => {
      const w = arena([{ inputs: [{ type: 'key', code: 'KeyG' }], target: 'player',
        action: { type: 'hitscan', aim: 'facing', range: 50, hits: 'any', damage: 0, push: 0 } }]);
      w.engine.gameplay.rules.add(w.target, { when: { type: 'hitBy', with: 'a shot', by: 'Hero', from: 'behind' }, if: [],
        do: [{ type: 'changeVariable', name: 'shotInTheBack', by: 1 }] });
      w.input.press('KeyG');
      w.step();
      expect(w.counts()).toEqual({ 'a shot': 1 });
      expect(w.engine.variables.get('shotInTheBack')).toBe(1); // it faces +Z; the shot came from -Z
    });

    it('a fired prefab is a shot; one thrown is something thrown — both by the shooter', () => {
      for (const kind of ['a shot', 'something thrown']) {
        const w = arena();
        const ball = w.add('Ball', { at: [0, 1, -1.2], size: [0.4, 0.4, 0.4], body: { type: 'dynamic', shape: 'sphere', gravity: 0, friction: 0 } });
        ball.launchedBy = { by: w.hero, kind, until: Infinity }; // as Shoot prefab leaves it (Counts as)
        ball.rigidBody.velocity.set(0, 0, 12);
        w.step(0.3);
        expect(w.counts()).toEqual({ [kind]: 1 });
      }
      expect(CONTROL_ACTIONS.shoot.props.counts.options).toEqual(['a shot', 'something thrown']);
    });

    it('Push / launch sends something flying: thrown, by whoever pushed it — for a while', () => {
      const w = arena();
      const ball = w.add('Ball', { at: [0, 0.5, -1.2], size: [0.4, 0.4, 0.4], body: { type: 'dynamic', shape: 'sphere', friction: 0 } });
      w.engine.gameplay.rules.add(w.target, { when: { type: 'hitBy', with: 'something thrown', by: 'Hero', speedTo: 'thrown' }, if: [],
        do: [{ type: 'changeVariable', name: 'byHero', by: 1 }] });
      ACTIONS.push.run({ action: { target: 'Ball', direction: 'towards other', relative: 'world', strength: 10 }, entity: w.hero, other: w.target,
        api: w.engine.gameplay.api, engine: w.engine });
      expect(ball.launchedBy.by).toBe(w.hero);
      w.step(0.4);
      expect(w.counts()).toEqual({ 'something thrown': 1 });
      expect(w.engine.variables.get('byHero')).toBe(1);
      expect(w.engine.variables.get('thrown')).toBeGreaterThan(5);
    });

    it('a car driven into it is a vehicle; anything else moving into it, a moving object', () => {
      for (const [isCar, kind] of [[true, 'a vehicle'], [false, 'a moving object']]) {
        const w = arena();
        const thing = w.add('Thing', { at: [0, 1, -1.4], size: [0.6, 0.6, 0.6], body: { type: 'dynamic', gravity: 0, friction: 0 } });
        if (isCar) thing.vehicle = {}; // as a Vehicle component makes it
        thing.rigidBody.velocity.set(0, 0, 8);
        w.step(0.3);
        expect(w.counts()).toEqual({ [kind]: 1 });
      }
    });

    it('the attack action is a rule action and a control action (a key, a click, a screen button)', () => {
      expect(ACTIONS.attack.label).toBe('Hit / attack (melee)');
      expect(Object.keys(ACTIONS.attack.props)).toEqual(['aim', 'reach', 'arc', 'all', 'hits', 'damage', 'push', 'sound']);
      expect(CONTROL_ACTIONS.attack.group).toBe('Aim & shoot');
    });
  });
});
