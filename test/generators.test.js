// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Entity } from '../src/entity.js';
import { RigidBody } from '../src/physics.js';
import { GENERATORS, makeGenerated, regenerate, generatorOf } from '../src/generators/generated.js';
import { TERRAIN_SHAPES, terrainHeightAt, normalizeTerrain } from '../src/generators/terrain.js';
import { panelPieces, normalizeBuilding } from '../src/generators/building.js';
import { world } from './helpers/world.js';

const part = (root, name) => root.children.find((c) => c.name === name);
const heightOf = (root) => {
  const g = part(root, 'Ground').geometry.attributes.position;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < g.count; i++) { lo = Math.min(lo, g.getY(i)); hi = Math.max(hi, g.getY(i)); }
  return { lo, hi };
};

describe('terrain', () => {
  it('every shape makes ground, coloured, within its height; water only when asked', () => {
    for (const shape of TERRAIN_SHAPES) {
      const root = makeGenerated('terrain', { shape, size: 60, height: 20, detail: 64, water: 0 });
      const ground = part(root, 'Ground');
      expect(ground.geometry.attributes.color, shape).toBeTruthy();
      const { lo, hi } = heightOf(root);
      expect(hi, shape).toBeLessThanOrEqual(20 * 1.35);
      expect(lo, shape).toBeGreaterThan(-20 * 0.5);
      expect(part(root, 'Water'), shape).toBeUndefined();
      expect(part(root, 'Sides'), shape).toBeTruthy(); // closed round its edges
    }
    const lake = makeGenerated('terrain', { shape: 'island', water: 0.2, height: 20 });
    const surface = part(lake, 'Water');
    surface.geometry.computeBoundingBox();
    expect(surface.position.y + surface.geometry.boundingBox.max.y).toBeCloseTo(4, 5); // its surface at its level
  });

  it('each kind has its own form: a mountain peaks in the middle, a valley is low along it, an island sinks at its edge', () => {
    const at = (shape, x, z) => terrainHeightAt({ shape, size: 100, height: 50 }, x, z);
    expect(at('mountain', 0, 0)).toBeGreaterThan(at('mountain', 40, 40) + 25);
    expect(at('valley', 0, 0)).toBeLessThan(at('valley', 40, 0) - 20);
    expect(at('island', 0, 0)).toBeGreaterThan(5);
    expect(at('island', 48, 48)).toBeLessThan(0);
    expect(Math.abs(at('field', 10, 10) - at('field', -20, 5))).toBeLessThan(50 * 0.5);
    expect(at('plateau', 0, 0)).toBeGreaterThan(at('plateau', 45, 45) + 30);
  });

  it('the same variation is the same land; another is different; its height is where its ground is', () => {
    const a = makeGenerated('terrain', { shape: 'hills', seed: 5, detail: 32 });
    const b = makeGenerated('terrain', { shape: 'hills', seed: 5, detail: 32 });
    const c = makeGenerated('terrain', { shape: 'hills', seed: 6, detail: 32 });
    const ys = (r) => [...part(r, 'Ground').geometry.attributes.position.array].filter((_, i) => i % 3 === 1);
    expect(ys(a)).toEqual(ys(b));
    expect(ys(a)).not.toEqual(ys(c));
    const pos = part(a, 'Ground').geometry.attributes.position;
    const params = generatorOf(a).params;
    for (const i of [0, 100, 500, 1000]) expect(pos.getY(i)).toBeCloseTo(terrainHeightAt(params, pos.getX(i), pos.getZ(i)), 5);
  });

  it('settings are cleaned up; a shape brings what suits it', () => {
    expect(normalizeTerrain({ shape: 'moon', size: -5, detail: 77, grass: 'green' })).toMatchObject({ shape: 'hills', size: 4, detail: 128, grass: '#5f8f45' });
    expect(GENERATORS.terrain.onChange({ shape: 'island', height: 3 }, 'shape')).toMatchObject({ height: 22, water: 0.22 });
  });

  it('remade from new settings: its own parts replaced, a child put under it kept', () => {
    const root = makeGenerated('terrain', { water: 0 });
    const tree = new THREE.Object3D();
    root.add(tree);
    regenerate(root, { ...generatorOf(root).params, water: 0.3 });
    expect(part(root, 'Water')).toBeTruthy();
    expect(root.children).toContain(tree);
    expect(root.children.filter((c) => c.name === 'Ground').length).toBe(1);
  });

  it('its water is a trigger zone: walk into the lake and a rule hears it ("at part Water")', () => {
    const w = world();
    const params = { shape: 'island', size: 40, height: 10, water: 0.3, detail: 64 };
    const land = new Entity(makeGenerated('terrain', params));
    land.rigidBody = new RigidBody({ type: 'static', shape: 'mesh' });
    land.physicsParts = { ...GENERATORS.terrain.parts };
    w.engine.entities.push(land);
    w.engine.scene.add(land.object3D);
    w.engine.physics.register(land);
    w.engine.gameplay.rules.add(land, { when: { type: 'triggerEnter', who: 'player', part: 'Water' }, if: [],
      do: [{ type: 'changeVariable', name: 'wet', by: 1 }] });
    const hero = w.add('Hero', { at: [0, terrainHeightAt(params, 0, 0) + 1.2, 0], size: [0.6, 1.6, 0.6], body: { type: 'dynamic', shape: 'capsule', friction: 0.1 } });
    w.engine.hero = hero;
    w.engine.gameplay.start();
    w.step(0.5);
    expect(w.engine.variables.get('wet', 0)).toBe(0); // on the hill: dry
    for (let t = 0; t < 4; t += 1 / 60) { hero.rigidBody.velocity.x = 5; w.step(); }
    expect(w.engine.variables.get('wet', 0)).toBe(1); // down the beach, into the sea
  });

  it('you stand on it: on its hills, where its ground is', () => {
    const w = world();
    const land = new Entity(makeGenerated('terrain', { shape: 'hills', size: 40, height: 6, detail: 64 }));
    land.rigidBody = new RigidBody({ type: 'static', shape: 'mesh' });
    w.engine.entities.push(land);
    w.engine.scene.add(land.object3D);
    w.engine.physics.register(land);
    const hero = w.add('Hero', { at: [5, 12, -4], size: [0.6, 1.6, 0.6], body: { type: 'dynamic', shape: 'capsule' } });
    w.step(2);
    const ground = terrainHeightAt(generatorOf(land.object3D).params, 5, -4);
    expect(hero.object3D.position.y - 0.8).toBeCloseTo(ground, 0);
    expect(hero.rigidBody.grounded).toBe(true);
  });
});

describe('building', () => {
  it('a panel with holes: what is left is the panel less the holes', () => {
    const area = (rs) => rs.reduce((s, r) => s + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
    const pieces = panelPieces(8, 3, [{ x0: 1, x1: 2, y0: 1, y1: 2 }, { x0: 3.5, x1: 4.6, y0: 0, y1: 2.3 }]);
    expect(area(pieces)).toBeCloseTo(24 - 1 - 1.1 * 2.3, 6);
    expect(panelPieces(4, 3, []).length).toBe(1);
  });

  it('its parts: walls, a floor, windows, sills, a roof; two storeys: a second floor and stairs', () => {
    const one = makeGenerated('building', {});
    expect(one.children.map((c) => c.name)).toEqual(
      ['Wall front', 'Wall back', 'Wall left', 'Wall right', 'Floor', 'Inner wall', 'Windows', 'Sills', 'Roof', 'Gables']);
    const two = makeGenerated('building', { storeys: 2, roof: 'hip', glass: false });
    const names = two.children.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Floor 2', 'Stairs 1', 'Roof']));
    expect(names).not.toContain('Windows');
    expect(names).not.toContain('Gables');
    expect(makeGenerated('building', { roof: 'none' }).children.some((c) => c.name === 'Roof')).toBe(false);
  });

  it('room for its stairs: a narrow two-storey house is made wide enough', () => {
    expect(normalizeBuilding({ width: 3, storeys: 2 }).width).toBeGreaterThan(3.5);
    expect(normalizeBuilding({ width: 3, storeys: 1 }).width).toBe(3);
  });

  it('real openings: a ray goes in at the door and out of a window, not through a wall', () => {
    const root = makeGenerated('building', { width: 8, depth: 6, door: 'front', windows: 2, glass: false, rooms: 'one room' });
    const ray = new THREE.Raycaster();
    const hits = (from, dir) => { ray.set(new THREE.Vector3(...from), new THREE.Vector3(...dir).normalize()); ray.far = 10; return new Set(ray.intersectObject(root, true).map((h) => h.object)).size; };
    expect(hits([0, 1.2, 6], [0, 0, -1])).toBe(1); // in at the door, to the back wall
    expect(hits([2.5, 1.2, 6], [0, 0, -1])).toBeGreaterThan(1); // the front wall beside it
    // the side walls' windows, at a third and two thirds along: in at one, out of the other
    expect(hits([-6, 0.1 + 0.9 + 0.5, -3 + 0.2 + 5.6 / 3], [1, 0, 0])).toBe(0);
    expect(hits([-6, 0.1 + 0.9 + 0.5, 0], [1, 0, 0])).toBe(2); // between them: both walls
  });

  /** A building in a small world, solid as a mesh; and a hero to walk. */
  function house(params) {
    const w = world();
    w.add('Ground', { at: [0, -0.5, 0], size: [60, 1, 60], body: { type: 'static' } });
    const b = new Entity(makeGenerated('building', params));
    b.rigidBody = new RigidBody({ type: 'static', shape: 'mesh' });
    w.engine.entities.push(b);
    w.engine.scene.add(b.object3D);
    w.engine.physics.register(b);
    return { ...w, b };
  }
  const walkHero = (w, at, v, seconds) => {
    const hero = w.add('Hero', { at, size: [0.6, 1.6, 0.6], body: { type: 'dynamic', shape: 'capsule', friction: 0.1 } });
    w.step(0.3);
    for (let t = 0; t < seconds; t += 1 / 60) {
      hero.rigidBody.velocity.x = v[0];
      hero.rigidBody.velocity.z = v[1];
      w.step();
    }
    return hero.object3D.position;
  };

  it('walk in at the door; a wall stops you', () => {
    expect(walkHero(house({ rooms: 'one room' }), [0, 0.9, 6], [0, -3], 2.5).z).toBeLessThan(1); // inside
    expect(walkHero(house({ rooms: 'one room' }), [2.5, 0.9, 6], [0, -3], 2.5).z).toBeGreaterThan(3); // the wall
  });

  it('up the stairs to the next floor', () => {
    const w = house({ storeys: 2, rooms: 'one room', width: 8, depth: 6 });
    // the flight on the back wall, from the left, rising to the right
    const p = walkHero(w, [-3.5, 0.95, -2.3], [2.5, 0], 3);
    expect(p.y).toBeGreaterThan(3 + 0.1 + 0.6);
  });
});
