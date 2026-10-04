// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Entity } from '../src/entity.js';
import { RigidBody } from '../src/physics.js';
import { physicsPartList, partRoles, normalizePhysicsParts } from '../src/physics-parts.js';
import { EVENTS } from '../src/rules.js';
import { world } from './helpers/world.js';

// A model's parts, each with physics of its own: in its body, left out, an own box, a trigger zone.

const mesh = (name, size, at) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(...size));
  m.name = name;
  m.position.set(...at);
  return m;
};

/** A field, as one model: its ground, a rock, a patch of grass, a pond. */
function field() {
  const g = new THREE.Group();
  g.name = 'Field';
  g.add(mesh('Ground', [60, 1, 60], [0, -0.5, 0]));
  g.add(mesh('Rock', [2, 3, 6], [6, 1.5, 0]));
  g.add(mesh('Grass', [2, 1.2, 6], [-6, 0.6, 0]));
  g.add(mesh('Water', [6, 0.6, 4], [0, 0.3, 8]));
  return g;
}

function scene(model, parts, shape = 'mesh') {
  const w = world();
  const { engine } = w;
  const e = new Entity(model);
  e.physicsParts = parts;
  engine.entities.push(e);
  engine.scene.add(model);
  model.updateMatrixWorld(true);
  e.rigidBody = new RigidBody({ type: 'static', shape });
  engine.physics.register(e);
  const hero = w.add('Hero', { at: [0, 1, 0], size: [0.6, 1.6, 0.6], body: { type: 'dynamic', shape: 'capsule', friction: 0.1 } });
  engine.hero = hero;
  return { ...w, model: e, hero };
}

const walk = ({ hero, step }, vx, vz, seconds = 2.5) => {
  for (let t = 0; t < seconds; t += 1 / 60) {
    hero.rigidBody.velocity.x = vx;
    hero.rigidBody.velocity.z = vz;
    step();
  }
  return hero.object3D.position;
};

describe('a model\'s parts, each its own physics', () => {
  it('listed by their names from the model down — one key each, even for twins', () => {
    const g = field();
    const twin = mesh('Rock', [1, 1, 1], [0, 0, 0]);
    g.add(twin);
    const list = physicsPartList(g);
    expect(list.map((p) => p.key)).toEqual(['Ground', 'Rock', 'Grass', 'Water', 'Rock#2']);
    expect(list[4].node).toBe(twin);
  });

  it('a field: the rock stops you, the grass doesn\'t, the pond is a zone you walk into', () => {
    const w = scene(field(), { Grass: 'none', Water: 'trigger' });
    const { engine, model, hero, step } = w;
    engine.gameplay.rules.add(model, { when: { type: 'triggerEnter', who: 'player', part: 'Water' }, if: [],
      do: [{ type: 'changeVariable', name: 'splashes', by: 1 }] });
    engine.gameplay.rules.add(model, { when: { type: 'triggerEnter', who: 'player', part: 'Nowhere' }, if: [],
      do: [{ type: 'changeVariable', name: 'wrong', by: 1 }] });
    engine.gameplay.start();
    step(0.3);
    expect(walk(w, 6, 0).x).toBeLessThan(5); // the rock (from x 5): stopped
    hero.object3D.position.set(0, 1, 0);
    expect(walk(w, -6, 0).x).toBeLessThan(-8); // the grass (x -7 to -5): straight through
    hero.object3D.position.set(0, 1, 0);
    const p = walk(w, 0, 6, 1.6);
    expect(p.z).toBeGreaterThan(7); // into the pond: not stopped
    expect(engine.variables.get('splashes')).toBe(1); // "enters me, at part Water"
    expect(engine.variables.get('wrong')).toBe(0);
    expect(engine.physics.touching(model)).toContain(hero); // touching the model, at its pond
  });

  it('by itself the whole model is one collider: the grass stops you too', () => {
    const w = scene(field(), undefined);
    w.engine.gameplay.start();
    w.step(0.3);
    expect(walk(w, -6, 0).x).toBeGreaterThan(-5.5);
  });

  it('an archway: its pillars and top as boxes of their own — walk through the middle', () => {
    const arch = new THREE.Group();
    arch.add(mesh('Pillar L', [1, 4, 1], [-2.5, 2, 0]), mesh('Pillar R', [1, 4, 1], [2.5, 2, 0]), mesh('Top', [6, 1, 1], [0, 4.5, 0]));
    arch.position.set(0, 0, -5);
    const floor = (w) => w.add('Floor', { at: [0, -0.5, 0], size: [60, 1, 60], body: { type: 'static' } });
    // one box round all of it: a wall
    const whole = scene(arch.clone(), undefined, 'box');
    floor(whole);
    whole.engine.gameplay.start();
    expect(walk(whole, 0, -5).z).toBeGreaterThan(-4.5);
    // each part its own box: through the gap; but not through a pillar
    const parts = scene(arch, { 'Pillar L': 'box', 'Pillar R': 'box', Top: 'box' }, 'box');
    floor(parts);
    parts.engine.gameplay.start();
    expect(walk(parts, 0, -5).z).toBeLessThan(-7);
    parts.hero.object3D.position.set(-2.5, 1, 0);
    expect(walk(parts, 0, -5).z).toBeGreaterThan(-4.5);
  });

  it('a ray hits the model, and says at which part; a left-out part is not in the way', () => {
    const { engine, model } = scene(field(), { Grass: 'none', Rock: 'box' });
    engine.physics.step(1 / 60);
    const hit = engine.physics.raycast(new THREE.Vector3(6, 10, 0), new THREE.Vector3(0, -1, 0), 50);
    expect(hit.entity).toBe(model);
    expect(hit.part).toBe('Rock');
    expect(hit.distance).toBeCloseTo(7, 3); // its top, at 3
    const grass = engine.physics.raycast(new THREE.Vector3(-6, 10, 0), new THREE.Vector3(0, -1, 0), 50);
    expect(grass.distance).toBeCloseTo(10, 3); // through the grass, to the ground
  });

  it('gone with it: hidden, its parts\' colliders go too', () => {
    const { engine, model } = scene(field(), { Rock: 'box', Water: 'trigger' });
    const count = () => engine.physics.bodies.filter((b) => b.entity === model || b.entity.owner === model).length;
    expect(count()).toBe(3);
    engine.physics.unregister(model);
    expect(count()).toBe(0);
  });

  it('kept clean for saving; only the roles of its own; rules can ask "at which part"', () => {
    expect(normalizePhysicsParts({ Rock: 'body', Grass: 'none', Water: 'trigger', X: 'nonsense', '': 'box' })).toEqual({ Grass: 'none', Water: 'trigger' });
    expect(normalizePhysicsParts({ Rock: 'body' })).toBeUndefined();
    const e = new Entity(field());
    e.physicsParts = { Grass: 'none', Gone: 'box' };
    expect(partRoles(e).map((p) => [p.key, p.role])).toEqual([['Grass', 'none']]); // a part no longer on the model: left be
    for (const t of ['triggerEnter', 'triggerExit', 'collision']) expect(EVENTS[t].props.part.type).toBe('part');
  });
});
