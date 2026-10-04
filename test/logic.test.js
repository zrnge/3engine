// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { Entity } from '../src/entity.js';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';
import { conditionsPass, CONDITIONS, normalizeConditions, ACTIONS, fieldShown, drivesFields, actsPerFrame, keepsRunning } from '../src/rules.js';
import { yawOf } from '../src/heading.js';
import { normalizeControl } from '../src/controls.js';
import { world } from './helpers/world.js';

const ctxOf = (engine, entity, extra = {}) => ({ vars: engine.variables, entity, other: null, engine, time: engine.time, ...extra });

describe('conditions: and, or, not, cooldown', () => {
  const yes = { type: 'chance', percent: 100 };
  const no = { type: 'chance', percent: 0 };
  it('all (and), any (or), not', () => {
    expect(conditionsPass([yes, yes], 'all')).toBe(true);
    expect(conditionsPass([yes, no], 'all')).toBe(false);
    expect(conditionsPass([yes, no], 'any')).toBe(true);
    expect(conditionsPass([no, no], 'any')).toBe(false);
    expect(conditionsPass([{ ...no, not: true }], 'all')).toBe(true);
    expect(conditionsPass([], 'all')).toBe(true); // none: always
    expect(conditionsPass([{ type: 'nonsense' }, yes])).toBe(true); // unknown ones are left out
  });

  it('a cooldown lets it through, then not again until its time is up — and just asking starts nothing', () => {
    const list = [{ type: 'cooldown', seconds: 1 }];
    expect(conditionsPass(list, 'all', { time: 0 }, { dry: true })).toBe(true);
    expect(conditionsPass(list, 'all', { time: 0 })).toBe(true);
    expect(conditionsPass(list, 'all', { time: 0.5 })).toBe(false);
    expect(conditionsPass(list, 'all', { time: 1.01 })).toBe(true);
    // held back by the others: the cooldown isn't started
    const gated = [{ type: 'cooldown', seconds: 5 }, no];
    expect(conditionsPass(gated, 'all', { time: 0 })).toBe(false);
    expect(conditionsPass([gated[0]], 'all', { time: 0.1 })).toBe(true);
  });

  it('an operator between each two: AND, OR, AND NOT, OR NOT — AND binds first', () => {
    const and = (c) => ({ ...c, join: 'and' });
    const or = (c) => ({ ...c, join: 'or' });
    const not = (c) => ({ ...c, not: true });
    // A and B or C  =  (A and B) or C
    expect(conditionsPass([no, and(no), or(yes)])).toBe(true);
    expect(conditionsPass([yes, and(no), or(no)])).toBe(false);
    expect(conditionsPass([yes, and(yes), or(no)])).toBe(true);
    // A or B and C  =  A or (B and C)
    expect(conditionsPass([yes, or(no), and(no)])).toBe(true);
    expect(conditionsPass([no, or(yes), and(no)])).toBe(false);
    expect(conditionsPass([no, or(yes), and(yes)])).toBe(true);
    // A and not B
    expect(conditionsPass([yes, not(and(no))])).toBe(true);
    expect(conditionsPass([yes, not(and(yes))])).toBe(false);
    // A or not B
    expect(conditionsPass([no, not(or(no))])).toBe(true);
    expect(conditionsPass([no, not(or(yes))])).toBe(false);
    // not A or not B and C  =  (not A) or ((not B) and C)
    expect(conditionsPass([not(yes), not(or(no)), and(yes)])).toBe(true);
    expect(conditionsPass([not(yes), not(or(no)), and(no)])).toBe(false);
    // the first one's join means nothing
    expect(conditionsPass([or(yes), and(yes)])).toBe(true);
    expect(conditionsPass([or(no), or(yes)])).toBe(true);
    // with no join written, the older all / any says: AND or OR
    expect(conditionsPass([yes, no], 'any')).toBe(true);
    expect(conditionsPass([yes, or(no)], 'all')).toBe(true); // a written join wins
    expect(conditionsPass([no, and(yes)], 'any')).toBe(false);
  });

  it('a cooldown holds back the whole list, whatever the ORs', () => {
    const list = [no, { type: 'cooldown', seconds: 1, join: 'or' }, { ...yes, join: 'or' }];
    expect(conditionsPass(list, 'all', { time: 0 })).toBe(true);
    expect(conditionsPass(list, 'all', { time: 0.5 })).toBe(false); // the cooldown, though C holds
    expect(conditionsPass(list, 'all', { time: 1.5 })).toBe(true);
    // a cooldown alone in front, then OR: still the two others decide
    const front = [{ type: 'cooldown', seconds: 1 }, no, { ...yes, join: 'or' }];
    expect(conditionsPass(front, 'all', { time: 10 })).toBe(true);
    expect(conditionsPass([{ type: 'cooldown', seconds: 1 }, no, { ...no, join: 'or' }], 'all', { time: 20 })).toBe(false);
  });

  it('saved with its fields filled in and its "not"', () => {
    expect(normalizeConditions([{ type: 'near', not: true }, { type: 'bogus' }])).toEqual([
      { type: 'near', who: 'self', of: 'player', distance: 3, not: true },
    ]);
  });

  it('saved with its operators; an older "Needs any" turns into ORs', () => {
    const list = [{ type: 'onGround', join: 'or' }, { type: 'driving', join: 'or', not: true }, { type: 'playTime', join: 'and' }];
    const out = normalizeConditions(list);
    expect(out.map((c) => [c.join, !!c.not])).toEqual([[undefined, false], ['or', true], ['and', false]]);
    expect(normalizeConditions([{ type: 'onGround' }, { type: 'driving' }], 'any').map((c) => c.join)).toEqual([undefined, 'or']);
    // no join written means AND: nothing to save
    expect(normalizeConditions([{ type: 'onGround' }, { type: 'driving' }], 'all').map((c) => c.join)).toEqual([undefined, undefined]);
    expect(normalizeConditions([{ type: 'onGround' }, { type: 'driving', join: 'nonsense' }]).map((c) => c.join)).toEqual([undefined, undefined]);
  });
});

describe('what the conditions can ask', () => {
  it('keys and mouse buttons held; variables against numbers and each other; play time; the camera', () => {
    const { engine, input } = world();
    const test = (c) => CONDITIONS[c.type].test({ ...ctxOf(engine, null), condition: c });
    expect(test({ type: 'keyHeld', code: 'ShiftLeft' })).toBe(false);
    input._down.add('ShiftLeft');
    expect(test({ type: 'keyHeld', code: 'ShiftLeft' })).toBe(true);
    input._mouse.add(2);
    expect(test({ type: 'mouseHeld', button: 'right' })).toBe(true);
    expect(test({ type: 'mouseHeld', button: 'left' })).toBe(false);
    engine.variables.set('health', 3);
    engine.variables.set('maxHealth', 10);
    expect(test({ type: 'compareVariables', name: 'health', op: '<', other: 'maxHealth' })).toBe(true);
    engine.gameplay.start();
    engine.time += 12;
    expect(test({ type: 'playTime', op: '>=', seconds: 10 })).toBe(true);
    expect(test({ type: 'camera', mode: 'orbit' })).toBe(true);
    expect(test({ type: 'camera', mode: 'first person' })).toBe(false);
  });

  it('on the ground, moving, near, touching, shown — for me, the player, a group', () => {
    const { engine, add, step } = world();
    add('Floor', { at: [0, -0.5, 0], size: [40, 1, 40], body: { type: 'static' } });
    const hero = add('Hero', { at: [0, 0.5, 0], body: { type: 'dynamic' } });
    const coin = add('Coin', { at: [2, 0.5, 0], groups: ['Coins'] });
    const far = add('Far coin', { at: [30, 0.5, 0], groups: ['Coins'] });
    engine.hero = hero;
    step(0.5);
    const test = (c, me = hero) => CONDITIONS[c.type].test({ ...ctxOf(engine, me), condition: c });
    expect(test({ type: 'onGround', who: 'self' })).toBe(true);
    expect(test({ type: 'onGround', who: 'player' }, coin)).toBe(true);
    expect(test({ type: 'moving', who: 'self', speed: 0.5 })).toBe(false);
    hero.rigidBody.velocity.set(4, 0, 0);
    expect(test({ type: 'moving', who: 'self', speed: 0.5 })).toBe(true);
    expect(test({ type: 'near', who: 'self', of: 'group:Coins', distance: 3 })).toBe(true); // any of them
    expect(test({ type: 'near', who: 'self', of: 'Far coin', distance: 3 })).toBe(false);
    expect(test({ type: 'touching', who: 'self', what: 'Floor' })).toBe(true);
    expect(test({ type: 'touching', who: 'self', what: 'Coin' })).toBe(false);
    expect(test({ type: 'shown', who: 'Coin' })).toBe(true);
    coin.object3D.visible = false;
    expect(test({ type: 'shown', who: 'Coin' })).toBe(false);
    void far;
  });

  it('how many are left, any left, a chance, the player driving', () => {
    const { engine, add } = world();
    const a = add('Slime 1', { groups: ['Enemies'] });
    add('Slime 2', { groups: ['Enemies'] });
    const test = (c) => CONDITIONS[c.type].test({ ...ctxOf(engine, a), condition: c });
    expect(test({ type: 'count', who: 'group:Enemies', op: '==', value: 2 })).toBe(true);
    expect(test({ type: 'exists', who: 'group:Enemies' })).toBe(true);
    for (const e of engine.entities) e.alive = false; // all gone
    expect(test({ type: 'exists', who: 'group:Enemies' })).toBe(false);
    expect(test({ type: 'count', who: 'group:Enemies', op: '<=', value: 0 })).toBe(true);
    expect(test({ type: 'chance', percent: 100 })).toBe(true);
    expect(test({ type: 'chance', percent: 0 })).toBe(false);
    expect(test({ type: 'driving' })).toBe(false);
    engine.hero = { vehicle: {} };
    expect(test({ type: 'driving' })).toBe(true);
  });
});

describe('rules: If … Do … Else, and more ways to set them off', () => {
  it('E at a door: open with the key, "Locked" without', () => {
    const { engine, add, step, input } = world();
    const door = add('Door');
    engine.gameplay.rules.add(door, {
      when: { type: 'key', code: 'KeyE', mode: 'pressed' },
      if: [{ type: 'variable', name: 'keys', op: '>=', value: 1 }],
      do: [{ type: 'setVariable', name: 'open', value: 1 }],
      else: [{ type: 'showMessage', text: 'Locked', seconds: 2, where: 'middle' }],
    });
    engine.gameplay.start();
    input.press('KeyE');
    step();
    expect(engine.variables.get('open')).toBe(0);
    expect(engine.onMessage).toHaveBeenCalledWith('Locked', expect.anything());
    engine.variables.set('keys', 1);
    input.press('KeyE');
    step();
    expect(engine.variables.get('open')).toBe(1);
  });

  it('a key let go; a mouse button pressed, held and let go', () => {
    const { engine, add, step, input } = world();
    const hud = add('HUD');
    const count = (name, when) => engine.gameplay.rules.add(hud, { when, if: [], do: [{ type: 'changeVariable', name, by: 1 }] });
    count('released', { type: 'key', code: 'Space', mode: 'released' });
    count('clicks', { type: 'mouse', button: 'left', mode: 'pressed' });
    count('held', { type: 'mouse', button: 'right', mode: 'held' });
    count('ups', { type: 'mouse', button: 'right', mode: 'released' });
    engine.gameplay.start();
    input.press('Space');
    step();
    expect(engine.variables.get('released')).toBe(0);
    input.release('Space');
    step();
    expect(engine.variables.get('released')).toBe(1);
    input._tapped.add(0);
    input._mouse.add(2);
    step(3 / 60);
    input._mouse.delete(2);
    input._mouseUp.add(2);
    step();
    expect(engine.variables.get('clicks')).toBe(1);
    expect(engine.variables.get('held')).toBe(3);
    expect(engine.variables.get('ups')).toBe(1);
  });

  it("I'm clicked: the object under the pointer — not one behind a wall", () => {
    const { engine, add, step, input } = world();
    const button = add('Button', { at: [0, 1, 0] });
    const behind = add('Behind', { at: [3, 1, -5] });
    add('Wall', { at: [3, 1, -2], size: [3, 3, 0.5] }); // in front of Behind, as the camera sees it
    for (const [e, name] of [[button, 'pressed'], [behind, 'behind']]) {
      engine.gameplay.rules.add(e, { when: { type: 'clicked', button: 'left' }, if: [], do: [{ type: 'changeVariable', name, by: 1 }] });
    }
    engine.gameplay.start();
    const aim = (x, y, z) => {
      const p = new THREE.Vector3(x, y, z).project(engine.camera);
      input.mouseNDC = { x: p.x, y: p.y };
    };
    aim(0, 1, 0);
    input._tapped.add(0);
    step();
    expect(engine.variables.get('pressed')).toBe(1);
    aim(3, 1, -5); // Behind is hidden by the Wall
    input._tapped.add(0);
    step();
    expect(engine.variables.get('behind')).toBe(0);
    aim(-4, 1, 0); // nothing there
    input._tapped.add(0);
    step();
    expect(engine.variables.get('pressed')).toBe(1);
  });
});

describe('rules that move things', () => {
  it('Move while a key is held — and it stops when the key is let go', () => {
    const { engine, add, step, input } = world();
    add('Floor', { at: [0, -0.5, 0], size: [100, 1, 100], body: { type: 'static' } });
    const hero = add('Hero', { at: [0, 0.5, 0], body: { type: 'dynamic', friction: 0.1 } });
    engine.hero = hero;
    engine.gameplay.rules.add(hero, {
      when: { type: 'key', code: 'KeyL', mode: 'held' }, if: [],
      do: [{ type: 'move', target: 'self', direction: 'right', relative: 'world', speed: 6 }],
    });
    engine.gameplay.start();
    input._down.add('KeyL');
    step(1);
    expect(hero.object3D.position.x).toBeGreaterThan(4); // world right: +x
    input._down.delete('KeyL');
    step(0.1);
    const x = hero.object3D.position.x;
    step(1);
    expect(hero.object3D.position.x - x).toBeLessThan(0.2); // stopped
  });

  it('Push up (a jump pad), Jump only from the ground, Turn, Face towards, Stop', () => {
    const { engine, add, step } = world();
    add('Floor', { at: [0, -0.5, 0], size: [100, 1, 100], body: { type: 'static' } });
    const hero = add('Hero', { at: [0, 0.5, 0], body: { type: 'dynamic' } });
    const flag = add('Flag', { at: [5, 0.5, 0] });
    engine.hero = hero;
    engine.gameplay.start();
    step(0.5);
    const run = (action, other = null) => engine.gameplay.rules.add(hero, { when: { type: 'start' }, if: [], do: [action] })
      && engine.gameplay.rules._run(engine.gameplay.rules.rules.at(-1), { api: engine.gameplay.api, time: engine.time, other });
    run({ type: 'push', target: 'self', direction: 'up', relative: 'world', strength: 15 });
    expect(hero.rigidBody.velocity.y).toBeCloseTo(15, 5);
    step(0.1);
    const vy = hero.rigidBody.velocity.y;
    run({ type: 'jump', target: 'self', strength: 30, ground: true }); // in the air: no
    expect(hero.rigidBody.velocity.y).toBeCloseTo(vy, 5);
    run({ type: 'stop', target: 'self' });
    expect(hero.rigidBody.velocity.length()).toBe(0);
    run({ type: 'face', target: 'self', at: 'Flag' });
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(hero.object3D.quaternion);
    expect(f.x).toBeCloseTo(1, 5); // facing the flag, along +x
    run({ type: 'turn', target: 'self', degrees: 90, how: 'by' });
    const g = new THREE.Vector3(0, 0, 1).applyQuaternion(hero.object3D.quaternion);
    expect(g.z).toBeCloseTo(-1, 5); // a quarter turn left from +x: -z
    void flag;
  });
});

describe('rules that rotate and scale', () => {
  const run = (engine, e, action, when = { type: 'start' }) => engine.gameplay.rules.add(e, { when, if: [], do: [action] });
  const round = (v) => Math.round(v * 1e6) / 1e6 + 0; // + 0: no -0
  const along = (e, x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(e.object3D.quaternion).toArray().map(round);
  const yaw = (e) => THREE.MathUtils.radToDeg(Math.atan2(...along(e, 0, 0, 1).filter((_, i) => i !== 1)));
  const rotate = (extra) => ({ type: 'rotate', how: 'by', x: 0, y: 0, z: 0, relative: 'self', seconds: 0, ...extra });
  const scale = (extra) => ({ type: 'scale', how: 'times', even: true, amount: 2, x: 1, y: 1, z: 1, seconds: 0, ...extra });

  it('Rotate by: about its own axes, as it is turned now, or the world\'s', () => {
    const { engine, add } = world();
    const [own, level] = [add('Own'), add('Level')];
    for (const e of [own, level]) e.object3D.rotation.x = Math.PI / 2; // both tipped over first
    run(engine, own, rotate({ y: 90 }));
    run(engine, level, rotate({ y: 90, relative: 'world' }));
    engine.gameplay.start();
    expect(along(own, 1, 0, 0)).toEqual([0, 1, 0]); // about its own (tipped) Y
    expect(along(level, 1, 0, 0)).toEqual([0, 0, -1]); // about the level's up
  });

  it('Rotate by, over time: a whole turn is a whole turn, and a door pressed twice swings twice as far', () => {
    const { engine, add, step, input } = world();
    const coin = add('Coin');
    const door = add('Door');
    run(engine, coin, rotate({ y: 360, seconds: 2 }));
    run(engine, door, rotate({ y: 90, seconds: 1 }), { type: 'key', code: 'KeyE', mode: 'pressed' });
    engine.gameplay.start();
    input.press('KeyE');
    step(0.2);
    input.press('KeyE');
    step(0.8);
    expect(along(coin, 0, 0, 1)[2]).toBeCloseTo(-1, 3); // half-way round: facing back
    step(1.3);
    expect(along(coin, 0, 0, 1)).toEqual([0, 0, 1]); // all the way round
    expect(along(door, 0, 0, 1)).toEqual([0, 0, -1]); // 90 + 90
    expect(engine.gameplay._turns).toHaveLength(0);
  });

  it('Rotate to: exactly its Rotation in the Inspector, eased there — and it wins over a turn under way', () => {
    const { engine, add, step } = world();
    const box = add('Box');
    run(engine, box, rotate({ y: 720, seconds: 5 }));
    run(engine, box, rotate({ how: 'to', x: 0, y: 60, z: 30, seconds: 1 }), { type: 'update', every: 0.5 });
    engine.gameplay.start();
    step(0.55); // the "to" starts, the long spin stops
    step(0.5);
    expect(box.object3D.rotation.y).toBeGreaterThan(0.1);
    step(0.6);
    // "every 0.5 s" has sent it there again since: still there
    expect(box.object3D.rotation.toArray().slice(0, 3).map(round)).toEqual([0, round(Math.PI / 3), round(Math.PI / 6)]);
  });

  it('Rotate per second: while the rule runs — "every 0.5 s" turns as far in a second as every frame does', () => {
    const { engine, add, step } = world();
    const [fast, slow] = [add('Fast'), add('Slow')];
    run(engine, fast, rotate({ how: 'per second', y: 90 }), { type: 'update', every: 0 });
    run(engine, slow, rotate({ how: 'per second', y: 90 }), { type: 'update', every: 0.5 });
    engine.gameplay.start();
    step(1);
    expect(yaw(fast)).toBeCloseTo(90, 3);
    step(0.1); // "every 0.5 s" has run twice: about a second's worth
    expect(Math.abs(yaw(slow) - 90)).toBeLessThan(5);
  });

  it('Scale: times, to, by — evenly or X, Y, Z apiece — never to nothing', () => {
    const { engine, add } = world();
    const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map((n) => add(n));
    run(engine, a, scale({ amount: 2 }));
    run(engine, b, scale({ how: 'to', even: false, x: 1, y: 3, z: 0.5 }));
    run(engine, c, scale({ how: 'by', amount: -0.25 }));
    run(engine, d, scale({ how: 'to', amount: 0 }));
    run(engine, e, scale({ even: false, x: 2, y: 1, z: -3 }));
    engine.gameplay.start();
    expect(a.object3D.scale.toArray()).toEqual([2, 2, 2]);
    expect(b.object3D.scale.toArray()).toEqual([1, 3, 0.5]);
    expect(c.object3D.scale.toArray()).toEqual([0.75, 0.75, 0.75]);
    expect(d.object3D.scale.toArray()).toEqual([0.001, 0.001, 0.001]);
    expect(e.object3D.scale.toArray()).toEqual([2, 1, 0.001]);
  });

  it('Scale over time: eased there; pressed twice, twice doubled; times per second while it runs', () => {
    const { engine, add, step, input } = world();
    const pop = add('Pop');
    const grow = add('Grow');
    run(engine, pop, scale({ amount: 2, seconds: 1 }), { type: 'key', code: 'KeyG', mode: 'pressed' });
    run(engine, grow, scale({ how: 'times per second', amount: 2 }), { type: 'key', code: 'KeyH', mode: 'held' });
    engine.gameplay.start();
    input.press('KeyG');
    step(0.5);
    expect(pop.object3D.scale.x).toBeGreaterThan(1.2);
    expect(pop.object3D.scale.x).toBeLessThan(1.8);
    input.press('KeyG');
    step(1.2);
    expect(pop.object3D.scale.toArray().map(round)).toEqual([4, 4, 4]);
    input._down.add('KeyH');
    step(1);
    input._down.delete('KeyH');
    step(0.5);
    expect(grow.object3D.scale.x).toBeCloseTo(2, 3); // held a second: doubled, then no more
  });

  it('what is turned or scaled is hit where it now is', () => {
    const { engine, add, step } = world();
    const block = add('Block', { body: { type: 'static' } });
    const plank = add('Plank', { at: [5, 0, 0], size: [4, 0.2, 1], body: { type: 'static' } });
    run(engine, block, scale({ how: 'to', even: false, x: 1, y: 4, z: 1 }));
    run(engine, plank, rotate({ z: 90 })); // stood on its end: 2 m up
    engine.gameplay.start();
    step();
    const down = new THREE.Vector3(0, -1, 0);
    expect(engine.physics.raycast(new THREE.Vector3(0, 10, 0), down, 100).distance).toBeCloseTo(8, 3);
    expect(engine.physics.raycast(new THREE.Vector3(5, 10, 0), down, 100).distance).toBeCloseTo(8, 3);
  });

  it('the Inspector shows the fields that matter for "How"', () => {
    const { rotate: r, scale: s } = ACTIONS;
    expect(fieldShown(r.props.seconds, { how: 'by' })).toBe(true);
    expect(fieldShown(r.props.seconds, { how: 'per second' })).toBe(false);
    expect(fieldShown(r.props.relative, { how: 'to' })).toBe(false);
    expect(fieldShown(s.props.amount, { even: true })).toBe(true);
    expect(fieldShown(s.props.x, { even: true })).toBe(false);
    expect(fieldShown(s.props.x, { even: false })).toBe(true);
    expect(fieldShown(s.props.seconds, { how: 'times per second' })).toBe(false);
    expect(fieldShown(r.props.y, {})).toBe(true); // no showIf: always
    expect(drivesFields(r.props, 'how')).toBe(true);
    expect(drivesFields(s.props, 'even')).toBe(true);
    expect(drivesFields(r.props, 'seconds')).toBe(false);
    expect(drivesFields(r.props, 'y')).toBe(true); // its axis, drawn in the view, turns
  });

  it('a control can Rotate and Scale too: per second while held, once a press', () => {
    const { engine, add, step, input } = world({
      controls: [
        { inputs: [{ type: 'key', code: 'KeyR' }], target: 'player', action: rotate({ how: 'per second', y: 180, relative: 'world' }) },
        { inputs: [{ type: 'key', code: 'KeyT' }], target: 'player', action: scale({ amount: 2 }) },
      ],
    });
    const hero = add('Hero');
    engine.hero = hero;
    engine.gameplay.start();
    input._down.add('KeyR');
    step(0.5);
    input._down.delete('KeyR');
    step(0.5);
    expect(yaw(hero)).toBeCloseTo(90, 3);
    input.press('KeyT');
    step();
    input.release('KeyT');
    step(0.2);
    expect(hero.object3D.scale.x).toBe(2); // once, though held a frame
  });
});

describe('Turn: always the way it says', () => {
  const run = (engine, e, action, when = { type: 'key', code: 'KeyT', mode: 'pressed' }) =>
    engine.gameplay.rules.add(e, { when, if: [], do: [action] });
  const turn = (extra) => ({ type: 'turn', target: 'self', degrees: 90, how: 'by', seconds: 0, ...extra });
  const deg = (r) => Math.round(THREE.MathUtils.radToDeg(r));

  it('turned right round, it still faces the way it walks — and walks its own forward the right way', () => {
    const walk = (relative) => ({
      inputs: [{ type: 'key', code: 'KeyW' }], target: 'player',
      action: { type: 'move', direction: 'forward', speed: 6, relative, face: true },
    });
    for (const relative of ['world', 'self']) {
      const { engine, add, step, input } = world({ controls: [walk(relative)] });
      add('Floor', { at: [0, -0.5, 0], size: [100, 1, 100], body: { type: 'static' } });
      const hero = add('Hero', { at: [0, 0.5, 0], body: { type: 'dynamic', friction: 0.1 } });
      engine.hero = hero;
      run(engine, hero, turn({ degrees: 180 }));
      engine.gameplay.start();
      input.press('KeyT');
      step();
      expect(Math.abs(deg(yawOf(hero.object3D)))).toBe(180);
      expect(hero.object3D.rotation.x).toBeCloseTo(0, 6); // written the readable way: X 0, Y 180, Z 0
      input._down.add('KeyW');
      step(0.5);
      const v = hero.rigidBody.velocity;
      // world forward is -Z; its own forward, turned round, is -Z too
      expect(v.z).toBeLessThan(-2);
      expect(Math.abs(deg(yawOf(hero.object3D)))).toBe(180); // it faces where it goes (was: mirrored, facing +Z)
    }
  });

  it('first person: turning the player turns the view with it', () => {
    const { engine, add, step, input } = world();
    engine.cameraRig = { mode: 'fps', yaw: 0, shake: vi.fn(), setFovBoost: vi.fn() };
    const hero = add('Hero');
    engine.hero = hero;
    run(engine, hero, turn({ degrees: 90 }));
    engine.gameplay.start();
    step();
    expect(Math.abs(deg(yawOf(hero.object3D)))).toBe(180); // it looks where the camera looks (-Z)
    input.press('KeyT');
    step();
    step();
    expect(deg(engine.cameraRig.yaw)).toBe(90); // the view turned left too
    expect(deg(yawOf(hero.object3D))).toBe(-90); // and it wasn't turned back
  });

  it('Turn over some seconds: eased round, not snapped', () => {
    const { engine, add, step, input } = world();
    const box = add('Box');
    run(engine, box, turn({ degrees: 90, seconds: 1 }));
    engine.gameplay.start();
    input.press('KeyT');
    step(0.5);
    expect(deg(yawOf(box.object3D))).toBe(45);
    step(0.6);
    expect(deg(yawOf(box.object3D))).toBe(90);
  });

  it('"per second" needs a rule that keeps running: which actions, which events', () => {
    expect(actsPerFrame({ type: 'turn', how: 'per second' })).toBe(true);
    expect(actsPerFrame({ type: 'turn', how: 'by' })).toBe(false);
    expect(actsPerFrame({ type: 'rotate', how: 'per second' })).toBe(true);
    expect(actsPerFrame({ type: 'scale', how: 'times per second' })).toBe(true);
    expect(actsPerFrame({ type: 'move' })).toBe(true);
    expect(actsPerFrame({ type: 'push' })).toBe(false);
    expect(keepsRunning({ type: 'update', every: 0 })).toBe(true);
    expect(keepsRunning({ type: 'key', mode: 'held' })).toBe(true);
    expect(keepsRunning({ type: 'mouse', mode: 'held' })).toBe(true);
    expect(keepsRunning({ type: 'key', mode: 'pressed' })).toBe(false);
    expect(keepsRunning({ type: 'clicked' })).toBe(false);
    expect(keepsRunning({ type: 'triggerEnter' })).toBe(false);
  });
});

describe('pivots: where it turns and grows from', () => {
  const run = (engine, e, action, when = { type: 'start' }) => engine.gameplay.rules.add(e, { when, if: [], do: [action] });
  const at = (v) => v.toArray().map((n) => Math.round(n * 1000) / 1000 + 0);
  const hinge = { pivot: 'a point on it', pivotX: 'left', pivotY: 'middle', pivotZ: 'middle' };
  const door = (add) => add('Door', { size: [2, 3, 0.2] }); // from x -1 to 1: its hinge side is x = -1
  const hingeOf = (d) => at(d.object3D.localToWorld(new THREE.Vector3(-1, 0, 0)));

  it('a door swings about its hinge side, not its middle — Rotate, Turn, over time, per second, to', () => {
    const cases = [
      { type: 'rotate', how: 'by', x: 0, y: 90, z: 0, relative: 'self', seconds: 0 },
      { type: 'rotate', how: 'by', x: 0, y: 90, z: 0, relative: 'world', seconds: 1 },
      { type: 'rotate', how: 'to', x: 0, y: 90, z: 0, seconds: 0.5 },
      { type: 'turn', degrees: 90, how: 'by', seconds: 0 },
      { type: 'turn', degrees: 90, how: 'by', seconds: 1 },
    ];
    for (const action of cases) {
      const { engine, add, step } = world();
      const d = door(add);
      run(engine, d, { target: 'self', ...action, ...hinge });
      engine.gameplay.start();
      step(0.5);
      expect(hingeOf(d)).toEqual([-1, 0, 0]); // on its way round: the hinge stays put
      step(0.7);
      expect(at(d.object3D.position)).toEqual([-1, 0, -1]); // swung open a quarter turn, left
      expect(hingeOf(d)).toEqual([-1, 0, 0]);
    }
    // per second: set off every frame
    const { engine, add, step } = world();
    const d = door(add);
    run(engine, d, { type: 'turn', target: 'self', degrees: 90, how: 'per second', ...hinge }, { type: 'update', every: 0 });
    engine.gameplay.start();
    step(1);
    expect(at(d.object3D.position).map((v) => Math.round(v * 100) / 100 + 0)).toEqual([-1, 0, -1]);
    expect(hingeOf(d).map((v) => Math.round(v * 100) / 100 + 0)).toEqual([-1, 0, 0]);
  });

  it('its sides are its own: swung twice, it turns about the same hinge', () => {
    const { engine, add, step, input } = world();
    const d = door(add);
    run(engine, d, { type: 'rotate', target: 'self', how: 'by', x: 0, y: 90, z: 0, relative: 'self', seconds: 0.5, ...hinge },
      { type: 'key', code: 'KeyE', mode: 'pressed' });
    engine.gameplay.start();
    input.press('KeyE');
    step(0.2);
    input.press('KeyE');
    step(1);
    expect(at(d.object3D.position)).toEqual([-2, 0, 0]); // right round: now on the far side of its hinge
    expect(hingeOf(d)).toEqual([-1, 0, 0]);
  });

  it('about another object: a moon round its planet (which may move)', () => {
    const { engine, add, step } = world();
    add('Planet');
    const moon = add('Moon', { at: [5, 0, 0], size: [0.5, 0.5, 0.5] });
    run(engine, moon, { type: 'rotate', target: 'self', how: 'per second', x: 0, y: 90, z: 0, relative: 'world', pivot: 'an object', pivotObject: 'Planet' },
      { type: 'update', every: 0 });
    engine.gameplay.start();
    step(1);
    expect(at(moon.object3D.position).map((v) => Math.round(v * 100) / 100 + 0)).toEqual([0, 0, -5]);
  });

  it('a pillar grows up from its bottom — at once, over time, per second — and stays on the ground', () => {
    const bottom = { pivot: 'a point on it', pivotX: 'middle', pivotY: 'bottom', pivotZ: 'middle' };
    const grows = [
      { how: 'to', even: false, x: 1, y: 3, z: 1, seconds: 0 },
      { how: 'times', even: false, x: 1, y: 3, z: 1, seconds: 1 },
    ];
    for (const g of grows) {
      const { engine, add, step } = world();
      const pillar = add('Pillar', { at: [0, 0.5, 0] }); // standing on y = 0
      run(engine, pillar, { type: 'scale', target: 'self', amount: 2, ...g, ...bottom });
      engine.gameplay.start();
      step(0.5);
      expect(Math.round(pillar.object3D.position.y * 1000) / 1000 - pillar.object3D.scale.y / 2).toBeCloseTo(0, 3);
      step(0.7);
      expect(at(pillar.object3D.scale)).toEqual([1, 3, 1]);
      expect(at(pillar.object3D.position)).toEqual([0, 1.5, 0]); // its bottom still at 0
    }
    const { engine, add, step } = world();
    const pillar = add('Pillar', { at: [0, 0.5, 0] });
    run(engine, pillar, { type: 'scale', target: 'self', how: 'times per second', even: true, amount: 2, ...bottom }, { type: 'update', every: 0 });
    engine.gameplay.start();
    step(1);
    expect(pillar.object3D.position.y - pillar.object3D.scale.y / 2).toBeCloseTo(0, 5);
    // by itself (its origin, its middle): it grows down into the ground as well
    const other = world();
    const p2 = other.add('P2', { at: [0, 0.5, 0] });
    run(other.engine, p2, { type: 'scale', target: 'self', how: 'to', even: false, x: 1, y: 3, z: 1, seconds: 0 });
    other.engine.gameplay.start();
    expect(at(p2.object3D.position)).toEqual([0, 0.5, 0]);
  });

  it('Move object: which point of it arrives — its bottom stands on the spot', () => {
    const { engine, add } = world();
    add('Spot', { at: [3, 1, 3], size: [0.1, 0.1, 0.1] });
    const a = add('A');
    const b = add('B');
    const c = add('C');
    const move = (extra) => ({ type: 'moveObject', target: 'self', how: 'to', x: 10, y: 0, z: 0, object: '', seconds: 0, ...extra });
    run(engine, a, move({ pivot: 'a point on it', pivotX: 'middle', pivotY: 'bottom', pivotZ: 'middle' }));
    run(engine, b, move({ how: 'to object', object: 'Spot', pivot: 'a point on it', pivotX: 'middle', pivotY: 'bottom', pivotZ: 'middle' }));
    run(engine, c, move({})); // by itself: its origin arrives, as before
    engine.gameplay.start();
    expect(at(a.object3D.position)).toEqual([10, 0.5, 0]);
    expect(at(b.object3D.position)).toEqual([3, 1.5, 3]);
    expect(at(c.object3D.position)).toEqual([10, 0, 0]);
  });

  it('the fields: shown for "a point on it" / "an object"; Move object\'s only for a move to', () => {
    const { rotate, scale, moveObject, turn } = ACTIONS;
    expect(rotate.props.pivot.default).toBe('its origin');
    expect(fieldShown(rotate.props.pivotX, { pivot: 'its origin' })).toBe(false);
    expect(fieldShown(rotate.props.pivotX, { pivot: 'a point on it' })).toBe(true);
    expect(fieldShown(rotate.props.pivotObject, { pivot: 'an object' })).toBe(true);
    expect(rotate.props.pivotX.default).toBe('left'); // a door's hinge
    expect(scale.props.pivotY.default).toBe('bottom'); // a pillar's foot
    expect(turn.props.pivot.options).toEqual(['its origin', 'a point on it', 'an object']);
    expect(moveObject.props.pivot.options).toEqual(['its origin', 'a point on it']);
    expect(fieldShown(moveObject.props.pivot, { how: 'by' })).toBe(false);
    expect(fieldShown(moveObject.props.pivotY, { how: 'to', pivot: 'a point on it' })).toBe(true);
    expect(drivesFields(rotate.props, 'pivot')).toBe(true);
    expect(drivesFields(rotate.props, 'pivotX')).toBe(true); // the marker in the view moves
  });
});

describe('controls: Only when', () => {
  const move = (extra = {}) => ({
    inputs: [{ type: 'key', code: 'KeyW' }], target: 'player',
    action: { type: 'move', direction: 'forward', speed: 6, relative: 'world', face: false }, ...extra,
  });

  it('W walks only while Shift is held (a key combination) — and brakes when it may not', () => {
    const { engine, add, step, input } = world({
      controls: [move({ if: [{ type: 'keyHeld', code: 'ShiftLeft' }] })],
    });
    add('Floor', { at: [0, -0.5, 0], size: [100, 1, 100], body: { type: 'static' } });
    const hero = add('Hero', { at: [0, 0.5, 0], body: { type: 'dynamic', friction: 0.1 } });
    engine.hero = hero;
    engine.gameplay.start();
    input._down.add('KeyW');
    step(1);
    expect(Math.abs(hero.object3D.position.z)).toBeLessThan(0.05); // W alone: nothing
    input._down.add('ShiftLeft');
    step(1);
    expect(hero.object3D.position.z).toBeLessThan(-3); // W + Shift: forward (-z)
    input._down.delete('ShiftLeft');
    step(0.5);
    const z = hero.object3D.position.z;
    step(0.5);
    expect(Math.abs(hero.object3D.position.z - z)).toBeLessThan(0.1); // stopped
  });

  it('fire: only with ammo left, and not more often than twice a second — "not": only when not stunned', () => {
    const shoot = {
      inputs: [{ type: 'key', code: 'KeyF' }], target: 'player',
      action: { type: 'changeVariable', name: 'shots', by: 1 },
      if: [
        { type: 'variable', name: 'ammo', op: '>', value: 0 },
        { type: 'variable', name: 'stunned', op: '>=', value: 1, not: true },
        { type: 'cooldown', seconds: 0.5 },
      ],
    };
    const { engine, add, step, input } = world({ controls: [shoot] });
    engine.hero = add('Hero');
    engine.gameplay.start();
    const press = () => { input.press('KeyF'); step(); input.release('KeyF'); step(); };
    press();
    expect(engine.variables.get('shots')).toBe(0); // no ammo
    engine.variables.set('ammo', 5);
    press();
    press();
    press();
    expect(engine.variables.get('shots')).toBe(1); // then the cooldown
    step(0.6);
    press();
    expect(engine.variables.get('shots')).toBe(2);
    engine.variables.set('stunned', 1);
    step(0.6);
    press();
    expect(engine.variables.get('shots')).toBe(2); // not while stunned
  });

  it('any (or): jump from the ground OR with a double-jump token', () => {
    const jump = {
      inputs: [{ type: 'key', code: 'Space' }], target: 'player',
      action: { type: 'changeVariable', name: 'tries', by: 1 },
      match: 'any',
      if: [{ type: 'onGround', who: 'self' }, { type: 'variable', name: 'tokens', op: '>=', value: 1 }],
    };
    const { engine, add, step, input } = world({ controls: [jump] });
    const hero = add('Hero', { at: [0, 5, 0], body: { type: 'dynamic', gravity: 0 } }); // floating: not on the ground
    engine.hero = hero;
    engine.gameplay.start();
    input.press('Space');
    step();
    expect(engine.variables.get('tries')).toBe(0);
    engine.variables.set('tokens', 1);
    input.press('Space');
    step();
    expect(engine.variables.get('tries')).toBe(1);
  });

  it('OR NOT: jump while on the ground, OR NOT while stunned AND with a token', () => {
    const jump = {
      inputs: [{ type: 'key', code: 'Space' }], target: 'player',
      action: { type: 'changeVariable', name: 'tries', by: 1 },
      if: [
        { type: 'onGround', who: 'self' },
        { type: 'variable', name: 'stunned', op: '>=', value: 1, join: 'or', not: true },
        { type: 'variable', name: 'tokens', op: '>=', value: 1, join: 'and' },
      ],
    };
    const { engine, add, step, input } = world({ controls: [jump] });
    engine.hero = add('Hero', { at: [0, 5, 0], body: { type: 'dynamic', gravity: 0 } }); // floating
    engine.gameplay.start();
    const press = () => { input.press('Space'); step(); input.release('Space'); step(); };
    press();
    expect(engine.variables.get('tries')).toBe(0); // in the air, no token
    engine.variables.set('tokens', 1);
    press();
    expect(engine.variables.get('tries')).toBe(1); // not stunned and a token
    engine.variables.set('stunned', 1);
    press();
    expect(engine.variables.get('tries')).toBe(1); // stunned: no
  });

  it('a rule: IF A OR B — its ELSE only when neither', () => {
    const { engine, add, step } = world();
    const box = add('Box');
    engine.gameplay.rules.add(box, {
      when: { type: 'update', every: 0 },
      if: [{ type: 'variable', name: 'a', op: '>=', value: 1 }, { type: 'variable', name: 'b', op: '>=', value: 1, join: 'or' }],
      do: [{ type: 'setVariable', name: 'out', value: 1 }],
      else: [{ type: 'setVariable', name: 'out', value: 2 }],
    });
    engine.gameplay.start();
    step();
    expect(engine.variables.get('out')).toBe(2);
    engine.variables.set('b', 1);
    step();
    expect(engine.variables.get('out')).toBe(1);
  });

  it('its conditions are saved with it — their and / or / not too; an older "any" becomes ORs', () => {
    const c = normalizeControl({ ...move(), if: [
      { type: 'keyHeld', code: 'ShiftLeft', not: true },
      { type: 'onGround', who: 'self', join: 'or' },
    ] });
    expect(c.if).toEqual([
      { type: 'keyHeld', code: 'ShiftLeft', not: true },
      { type: 'onGround', who: 'self', join: 'or' },
    ]);
    const old = normalizeControl({ ...move(), match: 'any', if: [{ type: 'onGround', who: 'self' }, { type: 'moving', who: 'self', speed: 1 }] });
    expect(old.if[1].join).toBe('or');
    expect(old.if[0].join).toBeUndefined(); // the first joins nothing
    expect(normalizeControl(move()).if).toBeUndefined(); // none: nothing saved
  });
});
