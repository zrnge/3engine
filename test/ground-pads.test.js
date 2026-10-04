// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Entity } from '../src/entity.js';
import { RigidBody } from '../src/physics.js';
import { makeGenerated, generatorOf } from '../src/generators/generated.js';
import { terrainHeightAt, applyPads } from '../src/generators/terrain.js';
import { GroundPads, padsFor, PAD_BLEND, PAD_MARGIN } from '../src/ground-pads.js';
import { world } from './helpers/world.js';

// The ground kept out of a house: a terrain levelled under what flattens it.

const HILLS = { shape: 'hills', size: 80, height: 12, detail: 128, seed: 3 };

/** The terrain's ground height under (x, z): a ray straight down onto its Ground. */
const groundAt = (terrain, x, z) => {
  const ground = terrain.object3D.children.find((c) => c.name === 'Ground');
  terrain.object3D.updateMatrixWorld(true);
  const hit = new THREE.Raycaster(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0)).intersectObject(ground, false)[0];
  return hit ? hit.point.y : null;
};

/** A terrain and a house on it, at (x, z), its floor a metre below the ground's height there. */
function scene({ at = [12, 8], turn = 0, flatten = true } = {}) {
  const engine = { entities: [], playing: false, physics: null };
  const terrain = new Entity(makeGenerated('terrain', HILLS));
  const base = terrainHeightAt(HILLS, ...at) - 1; // set a little into the slope, as a house so often is
  const house = new Entity(makeGenerated('building', { width: 8, depth: 6 }));
  house.object3D.position.set(at[0], base, at[1]);
  house.object3D.rotation.y = turn;
  if (flatten) house.flattenGround = true;
  engine.entities.push(terrain, house);
  const root = new THREE.Scene();
  root.add(terrain.object3D, house.object3D);
  root.updateMatrixWorld(true);
  return { engine, terrain, house, base, pads: new GroundPads(engine) };
}

describe('the ground kept out of a house', () => {
  it('a pad: level inside, its own height beyond its blend, between in between', () => {
    const pad = { x: 0, z: 0, hx: 2, hz: 1, cos: 1, sin: 0, level: 3, blend: 2 };
    expect(applyPads(10, 1.5, 0.5, [pad])).toBe(3);
    expect(applyPads(10, 5, 0, [pad])).toBe(10);
    const mid = applyPads(10, 3, 0, [pad]);
    expect(mid).toBeGreaterThan(3);
    expect(mid).toBeLessThan(10);
  });

  it('a house on a hillside: no ground above its floor inside it; the hill as it was a little way off', () => {
    const { engine, terrain, house, base, pads } = scene();
    const [hx, hz] = [house.object3D.position.x, house.object3D.position.z];
    // before: the hill comes up inside somewhere (that is the trouble)
    const inside = [[0, 0], [3, 2], [-3, -2], [3.5, -2.5], [-3.5, 2.5]];
    const before = Math.max(...inside.map(([dx, dz]) => groundAt(terrain, hx + dx, hz + dz)));
    expect(before).toBeGreaterThan(base + 0.1);
    pads.update(0);
    for (const [dx, dz] of inside) expect(groundAt(terrain, hx + dx, hz + dz)).toBeLessThanOrEqual(base + 1e-3);
    const far = hx + 4 + PAD_MARGIN + PAD_BLEND + 2;
    expect(groundAt(terrain, far, hz)).toBeCloseTo(terrainHeightAt(HILLS, far, hz), 1);
    expect(generatorOf(terrain.object3D).params).toEqual(expect.objectContaining(HILLS)); // its settings untouched: not saved
    expect(engine.entities).toContain(house);
  });

  it('turned, it is levelled along its turn', () => {
    const { terrain, house, base, pads } = scene({ turn: Math.PI / 4 });
    pads.update(0);
    // its far corner, along its turned width
    const corner = new THREE.Vector3(3.8, 0, 2.8).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4).add(house.object3D.position);
    expect(groundAt(terrain, corner.x, corner.z)).toBeLessThanOrEqual(base + 1e-3);
  });

  it('moved: levelled where it is now, the land back where it was', () => {
    const { terrain, house, pads } = scene();
    pads.update(0);
    const [ox, oz] = [house.object3D.position.x, house.object3D.position.z];
    house.object3D.position.set(-15, terrainHeightAt(HILLS, -15, -10), -10);
    house.object3D.updateMatrixWorld(true);
    pads.update(1);
    expect(groundAt(terrain, ox + 3, oz + 2)).toBeCloseTo(terrainHeightAt(HILLS, ox + 3, oz + 2), 1);
    expect(groundAt(terrain, -15, -10)).toBeLessThanOrEqual(house.object3D.position.y + 1e-3);
  });

  it('not asked to: the ground left as it is; nothing on it: no pads', () => {
    const { terrain, house, pads } = scene({ flatten: false });
    pads.update(0);
    expect(terrain.object3D.userData.pads ?? []).toEqual([]);
    expect(padsFor(terrain, [house]).length).toBe(1); // were it asked
  });

  it('you walk in at its door — the hill no longer in the way inside', () => {
    const w = world();
    const terrain = new Entity(makeGenerated('terrain', HILLS));
    const at = [12, 8];
    const base = terrainHeightAt(HILLS, ...at);
    const house = new Entity(makeGenerated('building', { width: 8, depth: 6, rooms: 'one room' }));
    house.object3D.position.set(at[0], base, at[1]);
    house.flattenGround = true;
    for (const e of [terrain, house]) {
      e.rigidBody = new RigidBody({ type: 'static', shape: 'mesh' });
      w.engine.entities.push(e);
      w.engine.scene.add(e.object3D);
    }
    w.engine.scene.updateMatrixWorld(true);
    new GroundPads(w.engine).update(0);
    for (const e of [terrain, house]) w.engine.physics.register(e);
    const hero = w.add('Hero', { at: [at[0], base + 1.2, at[1] + 4.5], size: [0.6, 1.6, 0.6], body: { type: 'dynamic', shape: 'capsule', friction: 0.1 } });
    w.step(0.4);
    for (let t = 0; t < 2.5; t += 1 / 60) { hero.rigidBody.velocity.z = -3; hero.rigidBody.velocity.x = 0; w.step(); }
    expect(hero.object3D.position.z).toBeLessThan(at[1] + 1); // inside
    expect(hero.object3D.position.y).toBeLessThan(base + 0.1 + 0.8 + 0.3); // on its floor, not up on a hill in it
  });

  it('on a mountainside: the bank up to its door is walkable — you get in (a fixed 2.5 m bank was too steep to climb)', () => {
    const w = world();
    const MOUNT = { shape: 'mountain', size: 120, height: 60, detail: 128, seed: 1 };
    const at = [14, 21];
    const base = terrainHeightAt(MOUNT, ...at); // the hill falls away in front of its door: it stands on a bank
    const terrain = new Entity(makeGenerated('terrain', MOUNT));
    const house = new Entity(makeGenerated('building', { storeys: 2, roof: 'hip' }));
    house.object3D.position.set(at[0], base, at[1]);
    house.flattenGround = true;
    for (const e of [terrain, house]) {
      e.rigidBody = new RigidBody({ type: 'static', shape: 'mesh' });
      w.engine.entities.push(e);
      w.engine.scene.add(e.object3D);
    }
    w.engine.scene.updateMatrixWorld(true);
    new GroundPads(w.engine).update(0);
    for (const e of [terrain, house]) w.engine.physics.register(e);
    expect(base - terrainHeightAt(MOUNT, at[0], at[1] + 7)).toBeGreaterThan(2); // well below its door, out there
    const hero = w.add('Hero', { at: [at[0], base + 1.5, at[1] + 7], size: [1, 1, 1], body: { type: 'dynamic', shape: 'capsule', friction: 0.1 } });
    w.step(0.5);
    for (let t = 0; t < 3; t += 1 / 60) { hero.rigidBody.velocity.z = -3; hero.rigidBody.velocity.x = 0; w.step(); }
    expect(hero.object3D.position.z).toBeLessThan(at[1]); // in, and across its front room
    expect(terrain.object3D.userData.pads[0].blend).toBeGreaterThan(PAD_BLEND); // a longer bank, where the land falls away
  });
});
