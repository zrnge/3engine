// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { world } from './helpers/world.js';
import { canSee } from '../src/ai.js';

// AI: seeing (a cone, not through walls), hearing (noises, footsteps), and an
// Enemy AI acting on them — patrol / guard, chase, attack, search, alert, cover.

const rule = (engine, e, r) => engine.gameplay.rules.add(e, { if: [], do: [], ...r });
const count = (name) => ({ type: 'changeVariable', name, by: '1' });

/** A level: the player at `at`, with Health; walls as [x, z, width, depth]. */
function level({ player = [0, 0, 6], walls = [] } = {}) {
  const w = world();
  const { engine, add } = w;
  const hero = add('Hero', { at: player });
  engine.hero = hero;
  engine.gameplay.components.add(hero, 'health', { max: 100 });
  for (const [x, z, sx, sz] of walls) add('Wall', { at: [x, 0, z], size: [sx, 3, sz], body: { type: 'static' } });
  return { ...w, hero };
}

describe('seeing', () => {
  it('in its field of view and as far as it sees; right beside it any way; never through a wall', () => {
    const { engine, add, hero } = level({ player: [0, 0, 5] });
    const guard = add('Guard'); // faces +Z
    const opts = { sight: 15, fov: 120, feel: 1 };
    expect(canSee(engine, guard, hero, opts)).toBe(true);
    hero.object3D.position.set(0, 0, -5); // behind it
    expect(canSee(engine, guard, hero, opts)).toBe(false);
    hero.object3D.position.set(0, 0, -0.9); // behind, but touching close
    expect(canSee(engine, guard, hero, opts)).toBe(true);
    hero.object3D.position.set(4, 0, 4); // 45° to its side: in a 120° view
    expect(canSee(engine, guard, hero, opts)).toBe(true);
    expect(canSee(engine, guard, hero, { ...opts, fov: 60 })).toBe(false);
    hero.object3D.position.set(0, 0, 20); // too far
    expect(canSee(engine, guard, hero, opts)).toBe(false);
    hero.object3D.position.set(0, 0, 6);
    add('Wall', { at: [0, 0, 3], size: [4, 3, 0.3], body: { type: 'static' } });
    engine.physics.step(1 / 60);
    expect(canSee(engine, guard, hero, opts)).toBe(false);
    hero.object3D.position.set(5, 0, 6); // round the end of the wall
    expect(canSee(engine, guard, hero, opts)).toBe(true);
  });

  it('Senses: "I see someone", "I lose sight of someone", and the condition "I can see"', () => {
    const { engine, add, step, hero } = level({ player: [0, 0, 5] });
    const guard = add('Guard');
    engine.gameplay.components.add(guard, 'senses', { sight: 10 });
    rule(engine, guard, { when: { type: 'sees', who: 'player' }, do: [count('seen')] });
    rule(engine, guard, { when: { type: 'losesSight', who: 'player' }, do: [count('lost')] });
    rule(engine, guard, { when: { type: 'update', every: 0 }, if: [{ type: 'canSee', who: 'player' }], do: [{ type: 'setVariable', name: 'now', value: 'true' }],
      else: [{ type: 'setVariable', name: 'now', value: 'false' }] });
    engine.gameplay.start();
    step(0.3);
    expect(engine.variables.get('seen')).toBe(1);
    expect(engine.variables.get('now')).toBe(true);
    step(0.5);
    expect(engine.variables.get('seen')).toBe(1); // once, not every look
    hero.object3D.position.set(0, 0, -6);
    step(0.3);
    expect(engine.variables.get('lost')).toBe(1);
    expect(engine.variables.get('now')).toBe(false);
  });
});

describe('hearing', () => {
  it('a noise within as far as it is loud — what kind, and who made it', () => {
    const { engine, add, step, hero } = level({ player: [0, 0, -10] }); // behind it, out of sight
    const guard = add('Guard');
    engine.gameplay.components.add(guard, 'senses', {});
    rule(engine, guard, { when: { type: 'hears', kind: 'a shot' }, do: [count('shots')] });
    rule(engine, guard, { when: { type: 'hears', kind: 'anything' }, do: [count('any')] });
    engine.gameplay.start();
    step(0.2);
    engine.gameplay.makeNoise({ x: 0, y: 0, z: -10 }, { loud: 30, kind: 'a shot', by: hero });
    step(0.2);
    expect(engine.variables.get('shots')).toBe(1);
    expect(guard.senses.heard.kind).toBe('a shot');
    engine.gameplay.makeNoise({ x: 0, y: 0, z: -10 }, { loud: 5, kind: 'a noise' }); // too quiet that far
    step(0.2);
    expect(engine.variables.get('any')).toBe(1);
    engine.gameplay.makeNoise({ x: 0, y: 0, z: -3 }, { loud: 5, kind: 'a noise' });
    step(0.2);
    expect(engine.variables.get('any')).toBe(2);
    expect(engine.variables.get('shots')).toBe(1);
  });

  it('footsteps: a runner near it is heard, a walker is not', () => {
    const { engine, add, step, hero } = level({ player: [0, 0, -5] });
    const guard = add('Guard');
    engine.gameplay.components.add(guard, 'senses', { footsteps: 'when running', stepsWithin: 8 });
    rule(engine, guard, { when: { type: 'hears', kind: 'footsteps' }, do: [count('steps')] });
    engine.gameplay.start();
    const walk = (speed, seconds) => {
      for (let t = 0; t < seconds; t += 1 / 60) { hero.object3D.position.x += speed / 60; step(); }
    };
    walk(1.5, 1);
    expect(engine.variables.get('steps', 0)).toBe(0);
    walk(6, 0.5);
    expect(engine.variables.get('steps')).toBe(1);
  });

  it('a shot fired by a control is heard (and a silenced one is not)', () => {
    const { engine, add, step, input } = level({ player: [0, 0, -12] });
    engine.gameplay.controls.load([
      { inputs: [{ type: 'key', code: 'KeyF' }], target: 'player', action: { type: 'hitscan', aim: 'facing', range: 5, damage: 0 } },
      { inputs: [{ type: 'key', code: 'KeyG' }], target: 'player', action: { type: 'hitscan', aim: 'facing', range: 5, damage: 0, loud: 0 } },
    ]);
    const guard = add('Guard');
    engine.gameplay.components.add(guard, 'senses', {});
    rule(engine, guard, { when: { type: 'hears', kind: 'a shot' }, do: [count('heard')] });
    engine.gameplay.start();
    input.press('KeyG'); step(0.3);
    expect(engine.variables.get('heard', 0)).toBe(0);
    input.press('KeyF'); step(0.3);
    expect(engine.variables.get('heard')).toBe(1);
  });
});

describe('Enemy AI', () => {
  it('guards its post, chases what it sees, attacks in reach', () => {
    const { engine, add, step, hero } = level({ player: [0, 0, 8] });
    const guard = add('Guard');
    engine.gameplay.components.add(guard, 'enemyAI', { run: 4, reach: 1.5, damage: 10, every: 0.5 });
    const states = [];
    for (const s of ['guarding', 'chasing', 'attacking']) rule(engine, guard, { when: { type: 'stateEnter', state: s }, do: [{ type: 'log', message: s }] });
    const log = console.log;
    console.log = (...a) => states.push(a[2]);
    try {
      engine.gameplay.start();
      step(0.3);
      expect(guard.state).toBe('chasing');
      step(2);
      expect(guard.state).toBe('attacking');
      step(1.2);
    } finally { console.log = log; }
    const h = engine.gameplay.components.listFor(hero).find((c) => c.type === 'health');
    expect(h.state.current).toBeLessThanOrEqual(80); // hit at least twice
    expect(states.filter((x) => x !== 'guarding').slice(0, 2)).toEqual(['chasing', 'attacking']); // guarding until its first look
    // out of reach and out of sight (far behind it): it searches where it saw them, then goes back to its post
    hero.object3D.position.set(0, 0, -40);
    step(0.3);
    expect(guard.state).toBe('searching');
    step(12);
    expect(guard.state).toBe('guarding');
    step(5);
    expect(Math.hypot(guard.object3D.position.x, guard.object3D.position.z)).toBeLessThan(0.5); // back at its post
  });

  it('patrols its points when nothing is going on', () => {
    const { engine, add, step } = level({ player: [50, 0, 50] });
    add('Point 1', { at: [0, 0, 0], groups: ['Round'], size: [0.1, 0.1, 0.1] });
    add('Point 2', { at: [4, 0, 0], groups: ['Round'], size: [0.1, 0.1, 0.1] });
    const guard = add('Guard', { at: [0, 0, 0] });
    engine.gameplay.components.add(guard, 'enemyAI', { points: 'Round', walk: 2, wait: 0 });
    engine.gameplay.start();
    step(0.2);
    expect(guard.state).toBe('patrolling');
    let farthest = 0;
    for (let i = 0; i < 180; i++) { step(); farthest = Math.max(farthest, guard.object3D.position.x); }
    expect(farthest).toBeGreaterThan(3.5);
  });

  it('seeing someone, it calls the others near it: they come to look', () => {
    const { engine, add, step } = level({ player: [0, 0, 8] });
    const a = add('Guard A');
    const b = add('Guard B', { at: [10, 0, 0] });
    b.object3D.rotation.y = Math.PI / 2; // looking away, along +X
    const c = add('Guard C', { at: [-40, 0, 0] }); // too far to hear the call
    for (const g of [a, b, c]) engine.gameplay.components.add(g, 'enemyAI', { alert: 15, attack: 'nothing' });
    engine.gameplay.start();
    step(0.4);
    expect(a.state).toBe('chasing');
    expect(b.senses.heard?.kind).toBe('an alert');
    expect(['searching', 'chasing']).toContain(b.state); // coming to look (and, turned their way, it may see them)
    expect(c.state).toBe('guarding');
    const before = b.object3D.position.clone();
    step(0.5);
    expect(b.object3D.position.distanceTo(before)).toBeGreaterThan(0.5);
  });

  it('shot from out of sight, it goes to look where the shot came from', () => {
    const { engine, add, step, hero } = level({ player: [0, 0, -10] });
    const guard = add('Guard');
    engine.gameplay.components.add(guard, 'health', { max: 10 });
    engine.gameplay.components.add(guard, 'enemyAI', {});
    engine.gameplay.start();
    step(0.3);
    expect(guard.state).toBe('guarding');
    engine.gameplay.damage(guard, 1, hero);
    step(0.15);
    expect(guard.state).toBe('searching');
    expect(guard.senses.heard.kind).toBe('a hit');
    step(1);
    expect(guard.object3D.position.z).toBeLessThan(-0.5);
  });

  it('hurt below its mark, it runs to the cover out of the shooter\'s sight, then comes out', () => {
    // two cover spots: one in the open, one behind a wall from the player
    const { engine, add, step, hero } = level({ player: [0, 0, 10], walls: [[4, 2, 2, 0.3]] });
    add('Open', { at: [-3, 0, 0], groups: ['Cover'], size: [0.1, 0.1, 0.1] });
    add('Hide', { at: [4, 0, 1], groups: ['Cover'], size: [0.1, 0.1, 0.1] });
    const guard = add('Guard');
    engine.gameplay.components.add(guard, 'health', { max: 10 });
    engine.gameplay.components.add(guard, 'enemyAI', { attack: 'nothing', cover: 'Cover', coverBelow: 50, coverFor: 1, run: 4 });
    engine.gameplay.start();
    step(0.3);
    expect(guard.state).toBe('chasing');
    engine.gameplay.damage(guard, 6, hero);
    step(0.2);
    expect(guard.state).toBe('taking cover');
    let nearest = Infinity;
    for (let i = 0; i < 120 && guard.state === 'taking cover'; i++) {
      step();
      nearest = Math.min(nearest, Math.hypot(guard.object3D.position.x - 4, guard.object3D.position.z - 1));
    }
    expect(nearest).toBeLessThan(0.5); // the hidden spot, not the open one
    step(1.5);
    expect(guard.state).not.toBe('taking cover');
    expect(engine.coverClaims.size).toBe(0);
  });

  it('a rule can take it over (stunned) and hand it back', () => {
    const { engine, add, step, input } = level({ player: [0, 0, 8] });
    const guard = add('Guard');
    engine.gameplay.components.add(guard, 'enemyAI', { attack: 'nothing' });
    rule(engine, guard, { when: { type: 'key', code: 'KeyS', mode: 'pressed' }, do: [
      { type: 'setState', target: 'self', state: 'stunned' }, { type: 'wait', seconds: 1 }, { type: 'setState', target: 'self', state: 'guarding' },
    ] });
    engine.gameplay.start();
    step(0.3);
    expect(guard.state).toBe('chasing');
    input.press('KeyS'); step();
    const at = guard.object3D.position.clone();
    step(0.8);
    expect(guard.state).toBe('stunned');
    expect(guard.object3D.position.distanceTo(at)).toBeLessThan(1e-6);
    step(0.5);
    expect(guard.state).toBe('chasing');
  });

  it('Make a noise (a rule): a thrown bottle draws it away', () => {
    const { engine, add, step, input } = level({ player: [0, 0, -30] });
    const guard = add('Guard');
    const bottle = add('Bottle', { at: [6, 0, -2], size: [0.2, 0.2, 0.2] });
    engine.gameplay.components.add(guard, 'enemyAI', {});
    rule(engine, bottle, { when: { type: 'key', code: 'KeyB', mode: 'pressed' }, do: [{ type: 'makeNoise', loud: 12, kind: 'a noise' }] });
    rule(engine, guard, { when: { type: 'update', every: 0 }, if: [{ type: 'heard', kind: 'a noise', within: 5 }], do: [{ type: 'setVariable', name: 'heard', value: 'true' }] });
    engine.gameplay.start();
    step(0.2);
    input.press('KeyB'); step(0.3);
    expect(engine.variables.get('heard')).toBe(true);
    expect(guard.state).toBe('searching');
    step(5);
    expect(Math.hypot(guard.object3D.position.x - 6, guard.object3D.position.z + 2)).toBeLessThan(0.8);
  });
});
