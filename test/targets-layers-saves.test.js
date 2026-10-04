// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { RigidBody, PhysicsWorld } from '../src/physics.js';
import { ACTIONS, CONDITIONS } from '../src/rules.js';
import { COMPONENTS } from '../src/components.js';
import { saveKey } from '../src/saves.js';
import { renameIn } from '../src/editor/inspector.js';
import { world } from './helpers/world.js';

const rule = (engine, e, action, when = { type: 'key', code: 'KeyT', mode: 'pressed' }, extra = {}) =>
  engine.gameplay.rules.add(e, { when, if: [], do: [action], ...extra });
const at = (e) => e.object3D.position.toArray().map((v) => Math.round(v * 100) / 100 + 0);

// ---------------------------------------------------------------- targets

describe('what an action acts on: one, a group, or all that share a name', () => {
  it('a group: every member', () => {
    const { engine, add, step, input } = world();
    const hud = add('HUD');
    const coins = [0, 1, 2].map((i) => add(`Coin ${i}`, { at: [i * 2, 0, 0], groups: ['Coins'] }));
    const rock = add('Rock');
    rule(engine, hud, { type: 'setVisible', target: 'group:Coins', visible: false });
    engine.gameplay.start();
    input.press('KeyT');
    step();
    expect(coins.map((c) => c.object3D.visible)).toEqual([false, false, false]);
    expect(rock.object3D.visible).toBe(true);
  });

  it('a name three objects share: all three — not just the first', () => {
    const { engine, add, step, input } = world();
    const hud = add('HUD');
    const boxes = [0, 1, 2].map((i) => add('Box', { at: [i * 3, 0, 0] }));
    rule(engine, hud, { type: 'destroy', target: 'Box', after: 0 });
    engine.gameplay.start();
    input.press('KeyT');
    step();
    expect(boxes.every((b) => !engine.entities.includes(b))).toBe(true);
  });

  it('one object — "To object", "Towards" — is the nearest of a group or a shared name', () => {
    const { engine, add, step, input } = world();
    add('Spawn', { at: [10, 0, 0] });
    add('Spawn', { at: [-3, 0, 0] });
    add('Spawn', { at: [0, 0, 20] });
    const hero = add('Hero', { at: [-1, 0, 0] });
    const guard = add('Guard', { at: [0, 0, 5] });
    add('E1', { at: [0, 0, 10], groups: ['Enemies'] }); // 5 m away
    add('E2', { at: [4, 0, 5], groups: ['Enemies'] }); // 4 m
    rule(engine, hero, { type: 'moveObject', target: 'self', how: 'to object', object: 'Spawn', seconds: 0 });
    rule(engine, guard, { type: 'face', target: 'self', at: 'group:Enemies' });
    engine.gameplay.start();
    input.press('KeyT');
    step();
    expect(at(hero)).toEqual([-3, 0, 0]); // the nearest Spawn
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(guard.object3D.quaternion);
    expect(f.x).toBeCloseTo(1, 5); // towards E2, 4 m to its side — not E1, 5 m ahead
  });

  it('api: resolveTarget is the nearest; resolveAll is all of them, nearest first', () => {
    const { engine, add } = world();
    const me = add('Me');
    const far = add('Pad', { at: [9, 0, 0] });
    const near = add('Pad', { at: [2, 0, 0] });
    const api = engine.gameplay.api;
    expect(api.resolveTarget('Pad', me, null)).toBe(near);
    expect(api.resolveAll('pad', me, null)).toEqual([near, far]); // any case
    expect(api.resolveAll('Nobody', me, null)).toEqual([]);
    expect(api.resolveTarget('self', me, null)).toBe(me);
  });

  it('a control\'s game action acts on a whole group too', () => {
    const { engine, add, step, input } = world({
      controls: [{ inputs: [{ type: 'key', code: 'KeyL' }], target: 'player', action: { type: 'setVisible', target: 'group:Lamps', visible: false } }],
    });
    engine.hero = add('Hero');
    const lamps = [add('L1', { groups: ['Lamps'] }), add('L2', { groups: ['Lamps'] })];
    engine.gameplay.start();
    input.press('KeyL');
    step();
    expect(lamps.map((l) => l.object3D.visible)).toEqual([false, false]);
  });

  it('every action\'s "Which" is picked (a target field); single objects are object fields', () => {
    const which = Object.entries(ACTIONS).filter(([, d]) => d.props?.target).map(([k, d]) => [k, d.props.target.type]);
    expect(which.length).toBeGreaterThan(15);
    expect(which.every(([, t]) => t === 'target')).toBe(true);
    expect(ACTIONS.moveObject.props.object.type).toBe('object');
    expect(ACTIONS.face.props.at.type).toBe('object');
    expect(ACTIONS.rotate.props.pivotObject.type).toBe('object');
  });

  it('renaming an object reaches every field that names it — Towards, near, touching, pivot, passes through', () => {
    const v = { at: 'Door', of: 'door', what: 'DOOR', pivotObject: 'Door', target: 'Door', spawnAt: 'Door' };
    expect(renameIn(v, 'door', 'Gate')).toBe(true);
    expect(v).toEqual({ at: 'Gate', of: 'Gate', what: 'Gate', pivotObject: 'Gate', target: 'Gate', spawnAt: 'Door' });
  });
});

// ---------------------------------------------------------------- collision layers

describe('collision layers: what a body passes through', () => {
  const fall = (floorBody, boxBody = {}, boxGroups = null) => {
    const { engine, add, step } = world();
    add('Floor', { at: [0, -0.5, 0], size: [20, 1, 20], body: { type: 'static', ...floorBody } });
    const box = add('Box', { at: [0, 2, 0], body: { type: 'dynamic', ...boxBody }, groups: boxGroups });
    engine.gameplay.start();
    step(1.5);
    return box.object3D.position.y;
  };

  it('a box lands on the floor — or falls through what it passes through', () => {
    expect(fall({})).toBeGreaterThan(0.3);
    expect(fall({}, { ignores: ['Floor'] })).toBeLessThan(-3);
  });

  it('either one saying so is enough; by group, or the player', () => {
    expect(fall({ ignores: ['group:Ghosts'] }, {}, ['Ghosts'])).toBeLessThan(-3);
    expect(fall({ ignores: ['group:Ghosts'] }, {}, ['Crates'])).toBeGreaterThan(0.3);
    const { engine, add, step } = world();
    add('Curtain', { at: [0, -0.5, 0], size: [20, 1, 20], body: { type: 'static', ignores: ['player'] } });
    const hero = add('Hero', { at: [0, 2, 0], body: { type: 'dynamic' } });
    engine.hero = hero;
    engine.gameplay.start();
    step(1.5);
    expect(hero.object3D.position.y).toBeLessThan(-3); // the player passes through; nothing else would
  });

  it('a trigger passing through something isn\'t set off by it', () => {
    const { engine, add, step } = world();
    const zone = add('Zone', { size: [4, 4, 4], body: { type: 'static', isTrigger: true, ignores: ['group:Ghosts'] } });
    add('Ghost', { at: [0, 0, 0], body: { type: 'dynamic', gravity: 0 }, groups: ['Ghosts'] });
    add('Crate', { at: [0, 0, 0], body: { type: 'dynamic', gravity: 0 } });
    rule(engine, zone, { type: 'changeVariable', name: 'entered', by: 1 }, { type: 'triggerEnter', who: 'any' });
    engine.gameplay.start();
    step(0.2);
    expect(engine.variables.get('entered')).toBe(1); // the crate only
  });

  it('rays don\'t stop at trigger zones, unless asked', () => {
    const physics = new PhysicsWorld();
    const make = (name, y, body) => {
      const o = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2));
      o.name = name;
      o.position.y = y;
      o.updateMatrixWorld(true);
      const e = { object3D: o, rigidBody: new RigidBody(body) };
      physics.register(e);
      return e;
    };
    make('Zone', 3, { isTrigger: true });
    const floor = make('Floor', 0, {});
    const down = new THREE.Vector3(0, -1, 0);
    expect(physics.raycast(new THREE.Vector3(0, 10, 0), down, 50).entity).toBe(floor);
    expect(physics.raycast(new THREE.Vector3(0, 10, 0), down, 50, { triggers: true }).entity.object3D.name).toBe('Zone');
  });

  it('saved with the body', () => {
    const b = new RigidBody({ type: 'dynamic', ignores: ['group:Ghosts', 'player', '', 7] });
    expect(b.ignores).toEqual(['group:Ghosts', 'player']);
    expect(new RigidBody(JSON.parse(JSON.stringify(b.toJSON()))).ignores).toEqual(['group:Ghosts', 'player']);
    expect(new RigidBody({}).toJSON().ignores).toBeUndefined();
  });
});

// ---------------------------------------------------------------- saves and checkpoints

describe('saving the game, and checkpoints', () => {
  beforeEach(() => localStorage.clear());

  /**
   * A level as a host loads it: made afresh each time, each object its place
   * in the level (levelKey), then gameplay started — as "Go to level" does.
   */
  function level() {
    const w = world();
    const { engine, add } = w;
    engine.ui = { game: { name: 'Coin Run' } };
    const build = () => {
      for (const e of [...engine.entities]) engine.gameplay.destroy(e);
      engine.entities.length = 0;
      const made = {
        floor: add('Floor', { at: [0, -0.5, 0], size: [40, 1, 40], body: { type: 'static' } }),
        coin0: add('Coin', { at: [3, 0.5, 0], groups: ['Coins'] }),
        coin1: add('Coin', { at: [6, 0.5, 0], groups: ['Coins'] }),
        door: add('Door', { at: [0, 1, -5] }),
        hero: add('Hero', { at: [0, 0.5, 0], body: { type: 'dynamic' } }),
      };
      Object.values(made).forEach((e, i) => { e.levelKey = i; });
      engine.hero = made.hero;
      w.made = made;
      return made;
    };
    engine.gameplay.levelName = () => 'Level 1';
    engine.gameplay.onGoToLevel = async () => { build(); engine.gameplay.start({ keepVariables: true }); };
    build();
    engine.gameplay.start();
    return w;
  }

  it('Save, play on, Load: back as it was saved — and what went since, back', async () => {
    const w = level();
    const { engine, step } = w;
    let m = w.made;
    engine.gameplay.destroy(m.coin0); // collected before the save
    m.door.object3D.position.y = 4; // opened
    m.door.object3D.rotation.y = 1;
    engine.variables.set('score', 5);
    m.hero.object3D.position.set(8, 0.5, 2);
    expect(engine.gameplay.saveGame()).toBe(true);
    // play on: more collected, the score up, the player elsewhere
    engine.gameplay.destroy(m.coin1);
    engine.variables.set('score', 9);
    engine.variables.set('madeLater', 1);
    m.hero.object3D.position.set(-10, 0.5, -10);
    expect(engine.gameplay.loadGame()).toBe(true);
    await Promise.resolve(); await Promise.resolve(); // the level loads
    step();
    m = w.made; // made afresh
    expect(engine.entities.includes(m.coin0)).toBe(false); // gone when saved
    expect(engine.entities.includes(m.coin1)).toBe(true); // collected after: back
    expect(m.door.object3D.position.y).toBeCloseTo(4, 3);
    expect(m.door.object3D.rotation.y).toBeCloseTo(1, 3);
    expect(engine.variables.get('score')).toBe(5);
    expect(engine.variables.has('madeLater')).toBe(false);
    expect(m.hero.object3D.position.x).toBeCloseTo(8, 1);
  });

  it('"A saved game exists", Delete saved game; slots; each game its own', () => {
    const { engine } = level();
    const ctx = { engine, vars: engine.variables };
    const has = (slot = 'save') => CONDITIONS.saved.test({ ...ctx, condition: { type: 'saved', slot } });
    expect(has()).toBe(false);
    engine.gameplay.saveGame();
    engine.gameplay.saveGame('slot 2');
    expect(has()).toBe(true);
    expect(has('slot 2')).toBe(true);
    engine.gameplay.deleteSave();
    expect(has()).toBe(false);
    expect(has('slot 2')).toBe(true);
    expect(saveKey('Coin Run', 'slot 2')).not.toBe(saveKey('Other Game', 'slot 2'));
    expect(localStorage.getItem(saveKey('Coin Run', 'slot 2'))).toContain('"level":"Level 1"');
  });

  it('a checkpoint flag: the player respawns standing on it, health full', () => {
    const w = level();
    const { engine, add, step } = w;
    const flag = add('Flag', { at: [10, 1, 0], size: [1, 2, 1] }); // from y 0 to 2
    const { hero } = w.made;
    engine.gameplay.components.add(hero, 'health', { max: 3, atZero: 'respawn' });
    engine.gameplay.components.start(engine.gameplay.api);
    rule(engine, flag, { type: 'checkpoint', at: 'here' }, { type: 'start' });
    engine.gameplay.rules.start(engine.gameplay.api);
    hero.object3D.position.set(-7, 0.5, 3);
    engine.gameplay.damage(hero, 3); // runs out
    step(0.1);
    expect(hero.object3D.position.x).toBeCloseTo(10, 3);
    expect(hero.object3D.position.z).toBeCloseTo(0, 3);
    expect(hero.object3D.position.y).toBeCloseTo(0.5, 1); // put with its feet on the flag's bottom — on the ground
    const health = engine.gameplay.components.listFor(hero).find((c) => c.type === 'health');
    expect(health.state.current).toBe(3);
    expect(COMPONENTS.health.props.atZero.options).toContain('respawn');
  });

  it('no checkpoint: Respawn is where the level began; anything else respawns where it began', () => {
    const w = level();
    const { engine, add, step, input } = w;
    const { hero, door } = w.made;
    rule(engine, add('HUD'), { type: 'respawn', target: 'player', heal: true });
    hero.object3D.position.set(5, 0.5, 5);
    door.object3D.position.set(9, 9, 9);
    input.press('KeyT');
    step();
    expect(at(hero)[0]).toBeCloseTo(0, 1);
    engine.gameplay.respawn(door);
    expect(at(door)).toEqual([0, 1, -5]);
  });

  it('the checkpoint is kept in a save', async () => {
    const w = level();
    const { engine, step } = w;
    w.made.hero.object3D.position.set(12, 0.5, 1);
    engine.gameplay.setCheckpoint(); // where the player is
    engine.gameplay.saveGame();
    engine.gameplay.checkpoint = null;
    engine.gameplay.loadGame();
    await Promise.resolve(); await Promise.resolve();
    step();
    expect(engine.gameplay.checkpoint?.p?.[0]).toBeCloseTo(12, 3);
  });
});
