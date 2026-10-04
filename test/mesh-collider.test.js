import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { Entity } from '../src/entity.js';
import { TriangleBVH, objectTriangles } from '../src/mesh-collider.js';

/** A static (or kinematic) body that collides as its real triangles. */
function meshBody(object3D, type = 'static') {
  const e = new Entity(object3D);
  e.rigidBody = new RigidBody({ type, shape: 'mesh', friction: 0.5 });
  return e;
}

/** A hollow room 10 × 4 × 10 whose floor is at y = 0: one closed box, seen from inside. */
function room() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 4, 10));
  mesh.position.y = 2;
  return meshBody(mesh);
}

/** A moving body: a 1 m box, or a capsule 0.8 wide and 1.8 tall. */
function mover(x, y, z, shape = 'box') {
  const mesh = new THREE.Mesh(shape === 'capsule' ? new THREE.BoxGeometry(0.8, 1.8, 0.8) : new THREE.BoxGeometry(1, 1, 1));
  mesh.position.set(x, y, z);
  const e = new Entity(mesh);
  e.rigidBody = new RigidBody({ type: 'dynamic', shape, friction: 0, gravity: -24 });
  return e;
}

function world(...entities) {
  const w = new PhysicsWorld();
  for (const e of entities) w.register(e);
  return w;
}
const simulate = (w, seconds, each = null) => {
  for (let t = 0; t < seconds; t += 1 / 60) { each?.(); w.step(1 / 60); }
};

/** Bumpy ground 40 × 40, 64 × 64 squares: height(x, z) says where its surface is. */
const height = (x, z) => Math.sin(x * 0.4) * 0.6 + Math.cos(z * 0.3) * 0.5;
function terrain() {
  const geo = new THREE.PlaneGeometry(40, 40, 64, 64);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, height(pos.getX(i), pos.getZ(i)));
  return meshBody(new THREE.Mesh(geo));
}

describe('mesh colliders — a model collides as its real shape', () => {
  it('stands on the floor INSIDE a hollow room (a box shape would throw it out of the whole room)', () => {
    for (const shape of ['box', 'capsule']) {
      const guest = mover(2, 2, -1, shape);
      const w = world(room(), guest);
      simulate(w, 1.5);
      const bottom = w.colliderFor(guest).min.y;
      expect(bottom, shape).toBeCloseTo(0, 1);
      expect(guest.rigidBody.grounded, shape).toBe(true);
      expect(Math.abs(guest.object3D.position.x - 2), shape).toBeLessThan(0.05);
    }
  });

  it('its walls stop what walks into them', () => {
    const guest = mover(0, 1, 0, 'capsule');
    const w = world(room(), guest);
    simulate(w, 0.5);
    simulate(w, 3, () => { guest.rigidBody.velocity.x = 6; });
    const right = w.colliderFor(guest).max.x;
    expect(right).toBeLessThanOrEqual(5.01);
    expect(right).toBeGreaterThan(4.9);
  });

  it('walks over bumpy ground, staying on its surface', () => {
    const walker = mover(-15, 3, 0, 'capsule');
    const w = world(terrain(), walker);
    simulate(w, 1);
    let worst = 0;
    let grounded = 0;
    let steps = 0;
    simulate(w, 4, () => {
      walker.rigidBody.velocity.x = 6;
      const feet = w.colliderFor(walker).min.y;
      const p = walker.object3D.position;
      worst = Math.max(worst, Math.abs(feet - height(p.x, p.z)));
      steps++;
      if (walker.rigidBody.grounded) grounded++;
    });
    expect(walker.object3D.position.x).toBeGreaterThan(5); // it got across
    expect(worst).toBeLessThan(0.15);                     // never sank in or floated off
    expect(grounded / steps).toBeGreaterThan(0.9);
  });

  it('a box sliding over a floor of many triangles is never nudged sideways at their seams', () => {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40, 40, 40).rotateX(-Math.PI / 2));
    const crate = mover(-15, 0.6, 0.25);
    const w = world(meshBody(floor), crate);
    simulate(w, 0.5);
    simulate(w, 3, () => { crate.rigidBody.velocity.x = 8; });
    expect(crate.object3D.position.x).toBeGreaterThan(5);
    expect(crate.object3D.position.z).toBeCloseTo(0.25, 3);
    expect(crate.object3D.position.y).toBeCloseTo(0.5, 1);
  });

  it('a fast fall onto a paper-thin floor stops on it, not through it', () => {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2));
    const rock = mover(0, 30, 0);
    rock.rigidBody.velocity.y = -28; // more than half its height each step
    const w = world(meshBody(floor), rock);
    simulate(w, 2);
    expect(rock.object3D.position.y).toBeCloseTo(0.5, 1);
  });

  it('a moving, turned and unevenly scaled mesh platform collides exactly and carries its rider', () => {
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    deck.scale.set(8, 0.5, 3);
    deck.rotation.y = 0.4;
    const platform = meshBody(deck, 'kinematic');
    const rider = mover(0, 3, 0, 'capsule');
    const w = world(platform, rider);
    simulate(w, 1.5);
    expect(w.colliderFor(rider).min.y).toBeCloseTo(0.25, 1); // the deck's top
    const x0 = rider.object3D.position.x;
    simulate(w, 1, () => { deck.position.x += 0.04; });
    expect(rider.object3D.position.x - x0).toBeCloseTo(2.4, 1);
  });

  it('a ray from inside a room hits its wall (the follow camera keeps inside it)', () => {
    const w = world(room());
    const hit = w.raycast(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(1, 0, 0), 20);
    expect(hit.distance).toBeCloseTo(5, 4);
    expect(hit.normal.x).toBeCloseTo(-1, 4); // facing back into the room
  });

  it('a dynamic body asked to be a mesh is a box', () => {
    const e = mover(0, 0, 0);
    e.rigidBody.shape = 'mesh';
    expect(world(e).colliderFor(e).kind).toBe('box');
  });

  it('a mesh trigger reports what enters it', () => {
    const zone = room();
    zone.rigidBody.isTrigger = true;
    const guest = mover(0, 1, 0);
    guest.rigidBody.gravity = 0;
    const w = world(zone, guest);
    w.step(1 / 60);
    expect(w.events.length).toBe(0); // well inside, touching no wall
    const seen = [];
    for (let t = 0; t < 1.2; t += 1 / 60) {
      guest.rigidBody.velocity.x = 5;
      w.step(1 / 60);
      seen.push(...w.events.map((e) => e.type));
    }
    expect(seen).toContain('triggerEnter'); // crossing its wall
    expect(seen).toContain('triggerExit');  // and out the other side
  });
});

describe('the triangle tree', () => {
  it('finds exactly the triangles a brute-force search finds', () => {
    const geo = new THREE.IcosahedronGeometry(5, 8);
    const tris = objectTriangles(new THREE.Mesh(geo));
    const bvh = new TriangleBVH(tris);
    const min = new THREE.Vector3(1, -1, 2);
    const max = new THREE.Vector3(3, 2, 6);
    const found = [];
    bvh.query(min, max, (t) => found.push(t));
    const brute = [];
    for (let t = 0; t < tris.length / 9; t++) {
      const xs = [tris[t * 9], tris[t * 9 + 3], tris[t * 9 + 6]];
      const ys = [tris[t * 9 + 1], tris[t * 9 + 4], tris[t * 9 + 7]];
      const zs = [tris[t * 9 + 2], tris[t * 9 + 5], tris[t * 9 + 8]];
      if (Math.min(...xs) <= max.x && Math.max(...xs) >= min.x && Math.min(...ys) <= max.y && Math.max(...ys) >= min.y
        && Math.min(...zs) <= max.z && Math.max(...zs) >= min.z) brute.push(t);
    }
    expect(found.sort((a, b) => a - b)).toEqual(brute);
    expect(brute.length).toBeGreaterThan(10);
  });

  it('raycasts to the nearest triangle', () => {
    const bvh = new TriangleBVH(objectTriangles(new THREE.Mesh(new THREE.SphereGeometry(2, 32, 16))));
    const hit = bvh.raycast(new THREE.Vector3(-10, 0.1, 0.1), new THREE.Vector3(20, 0, 0));
    expect(hit.t * 20).toBeCloseTo(8, 1); // the near side, 2 m before the centre
  });
});
