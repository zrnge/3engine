// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Entity } from '../src/entity.js';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { Navigation } from '../src/navigation.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';

/** A small level: its engine (physics, navigation, gameplay) and a way to add boxes. */
function level() {
  const engine = {
    entities: [], variables: new VariableStore(), physics: new PhysicsWorld(), scene: new THREE.Scene(),
    input: null, camera: null, playerEntity: null, time: 0,
    remove() {}, addBehavior() {}, removeBehavior() {}, playEntitySounds() {},
  };
  engine.navigation = new Navigation(engine);
  engine.gameplay = new Gameplay(engine);
  const add = (name, size, at, body = { type: 'static' }, { rotY = 0, geometry = null } = {}) => {
    const mesh = new THREE.Mesh(geometry ?? new THREE.BoxGeometry(...size));
    mesh.name = name;
    mesh.position.set(...at);
    mesh.rotation.y = rotY;
    const e = new Entity(mesh);
    if (body) e.rigidBody = new RigidBody(body);
    engine.entities.push(e);
    engine.scene.add(mesh);
    if (body) engine.physics.register(e);
    mesh.updateMatrixWorld(true);
    return e;
  };
  add('Floor', [40, 1, 40], [0, -0.5, 0]);
  const walker = add('Walker', [0.8, 1.8, 0.8], [-10, 0.9, 0], null);
  const run = (seconds) => {
    for (let t = 0; t < seconds; t += 1 / 60) {
      engine.time += 1 / 60;
      engine.scene.updateMatrixWorld(true);
      engine.physics.step(1 / 60);
      engine.gameplay.update(1 / 60, engine.time);
    }
  };
  return { engine, add, walker, run, nav: engine.navigation };
}

/** Does the segment a→b pass through the (x, z) box of a wall? */
function crosses(a, b, wall) {
  const box = new THREE.Box3().setFromObject(wall.object3D);
  for (let k = 0; k <= 50; k++) {
    const p = new THREE.Vector3().lerpVectors(a, b, k / 50);
    if (p.x > box.min.x && p.x < box.max.x && p.z > box.min.z && p.z < box.max.z) return true;
  }
  return false;
}
const legs = (start, path) => path.map((p, i) => [i === 0 ? start : path[i - 1], p]);

describe('finding a way (navigation)', () => {
  it('a house: through a 1.2 m door, under a ceiling, for a walker 0.8 m wide', () => {
    // two rooms side by side, a thin wall between with an ordinary door in it, a ceiling over all
    for (const doorAt of [0, 0.13, 0.27, 0.41]) { // wherever the door falls on the grid
      const { nav, walker, add } = level();
      add('Ceiling', [14, 0.2, 10], [0, 3.1, 0]);
      const left = add('Wall left', [0.2, 3, 4.4 + doorAt], [0, 1.5, -2.8 - doorAt / 2 + doorAt]);
      const right = add('Wall right', [0.2, 3, 4.4 - doorAt], [0, 1.5, 2.8 + doorAt / 2 + doorAt / 2]);
      walker.object3D.position.set(-4, 0.9, 3);
      const start = walker.object3D.position.clone();
      const path = nav.path(walker, new THREE.Vector3(4, 0, 3));
      expect(path, `door at ${doorAt}`).toBeTruthy();
      for (const [a, b] of legs(start, path)) {
        expect(crosses(a, b, left), `door at ${doorAt}`).toBe(false);
        expect(crosses(a, b, right), `door at ${doorAt}`).toBe(false);
      }
    }
  });

  it('a door half open, where it only just fits: still a way through, not at the wall', () => {
    // 1.08 m left in a doorway (its door swung open in it), for a walker 0.84 m wide: 0.24 m to spare
    for (const shift of [0, 0.1, 0.2, 0.3, 0.4]) {
      const { nav, walker, add } = level();
      add('Ceiling', [14, 0.2, 10], [0, 3.1, 0]);
      const gap = [-0.54 + shift, 0.54 + shift];
      const left = add('Wall left', [0.2, 3, 5 + gap[0]], [0, 1.5, (-5 + gap[0]) / 2]);
      const right = add('Wall right', [0.2, 3, 5 - gap[1]], [0, 1.5, (5 + gap[1]) / 2]);
      // the rooms closed all round: the doorway is the only way
      add('Wall north', [14.4, 3, 0.2], [0, 1.5, -5.1]);
      add('Wall south', [14.4, 3, 0.2], [0, 1.5, 5.1]);
      add('Wall west', [0.2, 3, 10.4], [-7.1, 1.5, 0]);
      add('Wall east', [0.2, 3, 10.4], [7.1, 1.5, 0]);
      walker.object3D.scale.set(0.84 / 0.8, 1, 0.84 / 0.8);
      walker.object3D.position.set(-4, 0.9, 3);
      walker.object3D.updateMatrixWorld(true);
      const start = walker.object3D.position.clone();
      const path = nav.path(walker, new THREE.Vector3(4, 0, 3));
      expect(path?.length, `gap at ${shift}`).toBeGreaterThan(1);
      expect(path.at(-1).x, `gap at ${shift}`).toBeCloseTo(4, 0);
      for (const [a, b] of legs(start, path)) {
        expect(crosses(a, b, left), `gap at ${shift}`).toBe(false);
        expect(crosses(a, b, right), `gap at ${shift}`).toBe(false);
      }
    }
  });

  it('pressed against a wall (its own cell not clear): still a way, from the nearest place it fits — not none, and straight through the wall', () => {
    const { nav, walker, add } = level();
    add('Ceiling', [14, 0.2, 10], [0, 3.1, 0]);
    const left = add('Wall left', [0.2, 3, 4.4], [0, 1.5, -2.8]);
    const right = add('Wall right', [0.2, 3, 4.4], [0, 1.5, 2.8]);
    add('Wall north', [14.4, 3, 0.2], [0, 1.5, -5.1]);
    add('Wall south', [14.4, 3, 0.2], [0, 1.5, 5.1]);
    add('Wall west', [0.2, 3, 10.4], [-7.1, 1.5, 0]);
    add('Wall east', [0.2, 3, 10.4], [7.1, 1.5, 0]);
    walker.object3D.scale.set(0.84 / 0.8, 1, 0.84 / 0.8);
    walker.object3D.position.set(-0.4, 0.9, 3); // its middle 0.3 m from the wall: it overlaps it
    walker.object3D.updateMatrixWorld(true);
    const path = nav.path(walker, new THREE.Vector3(4, 0, 3));
    expect(path?.length).toBeGreaterThan(1);
    expect(path.at(-1).x).toBeCloseTo(4, 0);
    for (const [a, b] of legs(walker.object3D.position.clone().setX(-0.6), path)) {
      expect(crosses(a, b, right)).toBe(false);
      expect(crosses(a, b, left)).toBe(false);
    }
  });

  it('a walker is as wide whichever way it faces (its doorway does not close as it turns)', () => {
    const { nav, walker } = level();
    const sizes = [0, Math.PI / 4, Math.PI / 2, 2].map((yaw) => {
      walker.object3D.rotation.y = yaw;
      walker.object3D.updateMatrixWorld(true);
      return nav.agentFor(walker).radius;
    });
    for (const r of sizes) expect(r).toBeCloseTo(0.4, 5);
  });

  it('nothing in the way: straight there', () => {
    const { nav, walker } = level();
    const path = nav.path(walker, new THREE.Vector3(10, 0, 0));
    expect(path).toHaveLength(1);
    expect(path[0].x).toBeCloseTo(10, 1);
  });

  it('a wall in the way: round it, never through it', () => {
    const { nav, walker, add } = level();
    const wall = add('Wall', [1, 3, 16], [0, 1.5, 0]);
    const start = walker.object3D.position.clone();
    const path = nav.path(walker, new THREE.Vector3(10, 0, 0));
    expect(path.length).toBeGreaterThan(1);
    for (const [a, b] of legs(start, path)) expect(crosses(a, b, wall)).toBe(false);
    expect(path.at(-1).x).toBeCloseTo(10, 1);
  });

  it('into a room through its doorway — a mesh model\'s too', () => {
    // a room 10 × 10 with walls 0.4 thick and a 2 m doorway in its west wall
    for (const asMesh of [false, true]) {
      const { nav, walker, add } = level();
      const parts = [
        [[10.4, 3, 0.4], [0, 1.5, -5]], [[10.4, 3, 0.4], [0, 1.5, 5]], [[0.4, 3, 10], [5, 1.5, 0]],
        [[0.4, 3, 4], [-5, 1.5, -3]], [[0.4, 3, 4], [-5, 1.5, 3]],
      ];
      if (asMesh) {
        const geos = parts.map(([s, p]) => new THREE.BoxGeometry(...s).translate(...p).toNonIndexed());
        const merged = new THREE.BufferGeometry();
        merged.setAttribute('position', new THREE.Float32BufferAttribute(geos.flatMap((g) => [...g.attributes.position.array]), 3));
        add('Room', null, [0, 0, 0], { type: 'static', shape: 'mesh' }, { geometry: merged });
      } else {
        parts.forEach(([s, p], i) => add(`Wall ${i}`, s, p));
      }
      walker.object3D.position.set(-12, 0.9, 6);
      const path = nav.path(walker, new THREE.Vector3(2, 0, 0));
      expect(path, asMesh ? 'mesh' : 'boxes').not.toBeNull();
      // it goes in through the doorway (x = -5, z between -1 and 1)
      const through = legs(walker.object3D.position, path).some(([a, b]) => {
        if ((a.x + 5) * (b.x + 5) > 0) return false; // doesn't cross x = -5
        const t = (-5 - a.x) / (b.x - a.x);
        return Math.abs(a.z + (b.z - a.z) * t) < 1;
      });
      expect(through, asMesh ? 'mesh' : 'boxes').toBe(true);
    }
  });

  it('up a ramp to a platform it can\'t step onto', () => {
    const { nav, walker, add } = level();
    add('Platform', [6, 2, 6], [9, 1, 0]); // 2 m up (x 6 to 12): too high to step onto
    // a ramp 3 m wide against its west side, rising from the floor at x = -2 to its top at x = 6
    const ramp = add('Ramp', [8, 0.4, 3], [2.12, 0.806, 0]);
    ramp.object3D.rotation.z = Math.atan2(2, 8);
    ramp.object3D.updateMatrixWorld(true);
    walker.object3D.position.set(-10, 0.9, 8);
    const path = nav.path(walker, new THREE.Vector3(9, 2, 0));
    expect(path).not.toBeNull();
    expect(path.at(-1).y).toBeGreaterThan(1.9); // it ends on top
    // and gets there up the ramp: its last leg starts at the ramp's foot
    const [from] = legs(walker.object3D.position, path).at(-1);
    expect(from.x).toBeLessThan(0);
    expect(Math.abs(from.z)).toBeLessThan(1.6);
  });

  it('a door that opens: the way through it is found at once', () => {
    const { nav, walker, add } = level();
    add('Wall N', [1, 3, 17], [0, 1.5, -11.5]);
    add('Wall S', [1, 3, 17], [0, 1.5, 11.5]);
    const door = add('Door', [1, 3, 6], [0, 1.5, 0], { type: 'kinematic' });
    const target = new THREE.Vector3(10, 0, 0);
    expect(nav.path(walker, target)).toBeNull(); // shut in
    door.object3D.position.y = 5; // slides up
    door.object3D.updateMatrixWorld(true);
    const path = nav.path(walker, target);
    expect(path).not.toBeNull();
    expect(path.at(-1).x).toBeCloseTo(10, 1);
  });
});

describe('measuring the level again', () => {
  it('a lift going up and down is not measured again and again', () => {
    const { engine, nav, walker, add } = level();
    add('Wall', [1, 3, 16], [0, 1.5, 0]);
    const lift = add('Lift', [2, 0.4, 2], [6, 0.2, 6], { type: 'kinematic' });
    const target = new THREE.Vector3(10, 0, 0);
    engine.physics.step(1 / 60);
    const grids = new Set();
    for (let i = 0; i < 6; i++) {
      lift.object3D.position.y += 0.3; // moving every slice
      lift.object3D.updateMatrixWorld(true);
      engine.physics.step(1 / 60);
      expect(nav.path(walker, target)).not.toBeNull();
      grids.add(nav.grids[0]);
    }
    expect(grids.size).toBe(1);
  });
});

describe('Follower and Patrol find their way', () => {
  it('a follower with a body walks round a wall to its target — never into it', () => {
    const { engine, add, walker, run } = level();
    walker.rigidBody = new RigidBody({ type: 'dynamic', shape: 'capsule', friction: 0 });
    engine.physics.register(walker);
    const wall = add('Wall', [1, 3, 14], [0, 1.5, 0]);
    add('Goal', [0.5, 0.5, 0.5], [10, 0.25, 0], null);
    engine.gameplay.components.add(walker, 'follower', { target: 'Goal', speed: 4, stopAt: 0.5 });
    engine.gameplay.start();
    let touched = false;
    const box = new THREE.Box3().setFromObject(wall.object3D);
    for (let t = 0; t < 9; t += 0.25) {
      run(0.25);
      const p = walker.object3D.position;
      if (p.x > box.min.x - 0.3 && p.x < box.max.x + 0.3 && p.z > box.min.z && p.z < box.max.z) touched = true;
    }
    expect(walker.object3D.position.distanceTo(new THREE.Vector3(10, 0.9, 0))).toBeLessThan(1.2);
    expect(touched).toBe(false);
  });

  it('a patrol goes round its group\'s points, in name order', () => {
    const { engine, add, walker, run } = level();
    for (const [name, x, z] of [['Point 2', 5, 5], ['Point 1', -5, 5], ['Point 3', 5, -5]]) {
      const p = add(name, [0.3, 0.3, 0.3], [x, 0.15, z], null);
      p.groups = ['Waypoints'];
    }
    engine.gameplay.components.add(walker, 'patrol', { points: 'Waypoints', speed: 6, wait: 0 });
    engine.gameplay.start();
    const visits = [];
    for (let t = 0; t < 14; t += 0.05) {
      run(0.05);
      const p = walker.object3D.position;
      for (const e of engine.entities.filter((x) => x.groups)) {
        const q = e.object3D.position;
        if (Math.hypot(p.x - q.x, p.z - q.z) < 0.6 && visits.at(-1) !== e.object3D.name) visits.push(e.object3D.name);
      }
    }
    expect(visits.slice(0, 4)).toEqual(['Point 1', 'Point 2', 'Point 3', 'Point 1']);
  });
});
