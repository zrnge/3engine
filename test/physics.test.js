import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  PhysicsWorld, RigidBody, getWorldAABB, aabbOverlap, aabbPenetration,
} from '../src/physics.js';
import { Entity } from '../src/entity.js';

/** A 1x1x1 box entity at (x, y, z) with the given body type. */
function box(type, x = 0, y = 0, z = 0, size = 1) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
  mesh.position.set(x, y, z);
  const e = new Entity(mesh);
  e.rigidBody = new RigidBody({ type, friction: 0, gravity: -24 });
  return e;
}

function world(...entities) {
  const w = new PhysicsWorld();
  for (const e of entities) w.register(e);
  return w;
}

/** Advance the world in fixed slices so results don't depend on one big step. */
function simulate(w, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) w.step(dt);
}

describe('getWorldAABB', () => {
  it('measures a mesh in world space', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
    mesh.position.set(1, 2, 3);
    const { center, halfSize } = getWorldAABB(mesh);
    expect(center.toArray()).toEqual([1, 2, 3]);
    expect(halfSize.toArray()).toEqual([1, 2, 3]);
  });

  it('accounts for scale', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.scale.set(4, 1, 1);
    const { halfSize } = getWorldAABB(mesh);
    expect(halfSize.x).toBeCloseTo(2, 6);
    expect(halfSize.y).toBeCloseTo(0.5, 6);
  });

  it('pads a degenerate (flat) axis so planes can still collide', () => {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(10, 10));
    plane.rotation.x = -Math.PI / 2;
    plane.updateMatrixWorld(true);
    const { halfSize } = getWorldAABB(plane);
    expect(halfSize.y).toBeGreaterThanOrEqual(0.05);
  });

  it('falls back to the object origin when there is no geometry', () => {
    // an empty (or a light with a rigid body) — previously this produced a
    // phantom collider sitting at the world origin
    const empty = new THREE.Object3D();
    empty.position.set(7, 8, 9);
    empty.updateMatrixWorld(true);
    const { center } = getWorldAABB(empty);
    expect(center.toArray()).toEqual([7, 8, 9]);
  });

  it('fills a provided output record instead of allocating', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    const out = { center: new THREE.Vector3(), halfSize: new THREE.Vector3() };
    const result = getWorldAABB(mesh, out);
    expect(result).toBe(out);
    expect(out.halfSize.toArray()).toEqual([1, 1, 1]);
  });
});

describe('aabb helpers', () => {
  const v = (x, y, z) => new THREE.Vector3(x, y, z);

  it('detects overlap and separation', () => {
    expect(aabbOverlap(v(0, 0, 0), v(1, 1, 1), v(1, 0, 0), v(1, 1, 1))).toBe(true);
    expect(aabbOverlap(v(0, 0, 0), v(1, 1, 1), v(3, 0, 0), v(1, 1, 1))).toBe(false);
  });

  it('resolves along the shallowest axis', () => {
    // deeply overlapped in x/z, barely in y -> must push along y
    const pen = aabbPenetration(v(0, 0.9, 0), v(1, 1, 1), v(0, -1, 0), v(1, 1, 1));
    expect(pen.axis.toArray()).toEqual([0, 1, 0]);
    expect(pen.depth).toBeCloseTo(0.1, 6);
  });

  it('returns null when the boxes do not touch', () => {
    expect(aabbPenetration(v(0, 0, 0), v(1, 1, 1), v(5, 0, 0), v(1, 1, 1))).toBeNull();
  });
});

describe('PhysicsWorld', () => {
  it('applies gravity to dynamic bodies only', () => {
    const dyn = box('dynamic', 0, 10);
    const stat = box('static', 5, 10);
    const kin = box('kinematic', -5, 10);
    const w = world(dyn, stat, kin);

    simulate(w, 0.5);

    expect(dyn.object3D.position.y).toBeLessThan(10);
    expect(stat.object3D.position.y).toBe(10);
    expect(kin.object3D.position.y).toBe(10);
  });

  it('rests a falling body on static ground instead of tunnelling', () => {
    const ground = box('static', 0, -0.5, 0, 10);
    const faller = box('dynamic', 0, 6);
    const w = world(ground, faller);

    simulate(w, 3);

    // ground top is at y = 4.5 (centre -0.5, half-height 5); box half-height 0.5
    expect(faller.object3D.position.y).toBeCloseTo(5, 1);
    expect(faller.rigidBody.grounded).toBe(true);
    expect(faller.rigidBody.velocity.y).toBeCloseTo(0, 1);
  });

  it('never leaves a dynamic body overlapping a static one', () => {
    const ground = box('static', 0, -0.5, 0, 10);
    const faller = box('dynamic', 0, 6);
    const w = world(ground, faller);
    simulate(w, 3);

    const a = getWorldAABB(ground.object3D);
    const b = getWorldAABB(faller.object3D);
    expect(aabbOverlap(a.center, a.halfSize, b.center, b.halfSize)).toBe(false);
  });

  it('clears grounded once a body leaves the floor', () => {
    const ground = box('static', 0, -0.5, 0, 10);
    const faller = box('dynamic', 0, 6);
    const w = world(ground, faller);
    simulate(w, 3);
    expect(faller.rigidBody.grounded).toBe(true);

    faller.rigidBody.velocity.y = 20; // jump
    w.step(1 / 60);
    expect(faller.rigidBody.grounded).toBe(false);
  });

  it('bounces a body with restitution and does not with zero', () => {
    const ground = box('static', 0, -0.5, 0, 10);
    const bouncy = box('dynamic', 0, 6);
    bouncy.rigidBody.restitution = 0.8;
    const w = world(ground, bouncy);

    // step until the first contact, then check it is moving back up
    let rebounded = false;
    for (let i = 0; i < 400; i++) {
      w.step(1 / 60);
      if (bouncy.rigidBody.grounded && bouncy.rigidBody.velocity.y > 1) {
        rebounded = true;
        break;
      }
    }
    expect(rebounded).toBe(true);
  });

  it('pushes two overlapping dynamic bodies apart', () => {
    const a = box('dynamic', -0.2, 10);
    const b = box('dynamic', 0.2, 10);
    a.rigidBody.gravity = 0;
    b.rigidBody.gravity = 0;
    const w = world(a, b);

    w.step(1 / 60);

    const sep = Math.abs(a.object3D.position.x - b.object3D.position.x);
    expect(sep).toBeGreaterThan(0.4);
  });

  it('does not push a static body when a dynamic one lands on it', () => {
    const ground = box('static', 0, -0.5, 0, 10);
    const faller = box('dynamic', 0, 6);
    const w = world(ground, faller);
    simulate(w, 2);
    expect(ground.object3D.position.y).toBe(-0.5);
  });

  it('registers each entity once and unregisters cleanly', () => {
    const e = box('dynamic');
    const w = world(e);
    w.register(e);
    expect(w.bodies).toHaveLength(1);
    expect(w.bodyFor(e)).toBe(e.rigidBody);

    w.unregister(e);
    expect(w.bodies).toHaveLength(0);
    expect(w.bodyFor(e)).toBeNull();
  });

  it('ignores entities with no rigid body', () => {
    const w = new PhysicsWorld();
    w.register(new Entity(new THREE.Object3D()));
    expect(w.bodies).toHaveLength(0);
  });

  it('steps an empty world without error', () => {
    expect(() => new PhysicsWorld().step(1 / 60)).not.toThrow();
  });

  describe('raycast', () => {
    it('reports the closest hit along the ray', () => {
      const near = box('static', 0, 0, -2);
      const far = box('static', 0, 0, -8);
      const w = world(near, far);

      const hit = w.raycast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), 20);
      expect(hit.entity).toBe(near);
      expect(hit.distance).toBeCloseTo(1.5, 6);
    });

    it('returns null past maxDistance', () => {
      const w = world(box('static', 0, 0, -50));
      expect(w.raycast(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), 10)).toBeNull();
    });

    it('measures ground distance below a point', () => {
      const w = world(box('static', 0, -0.5, 0, 10));
      const d = w.groundDistance(new THREE.Vector3(0, 10, 0));
      expect(d).toBeCloseTo(5.5, 6);
    });
  });
});

// ---------------------------------------------------------------- the new foundations

const DEG = Math.PI / 180;

/** A static plank, tilted about Z (the +X end up), centred on the origin. */
function plank(angleDeg, { length = 10, thick = 0.5, type = 'static', trigger = false } = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, thick, 4));
  mesh.rotation.z = angleDeg * DEG;
  const e = new Entity(mesh);
  e.rigidBody = new RigidBody({ type, isTrigger: trigger });
  return e;
}

/** Where the top face of a tilted plank is at x. */
const surfaceY = (angleDeg, x, thick = 0.5) => Math.tan(angleDeg * DEG) * x + (thick / 2) / Math.cos(angleDeg * DEG);

describe('fixed timestep', () => {
  it('jumps the same height at 30, 60 and 144 frames per second', () => {
    const apex = (fps) => {
      const ground = box('static', 0, -0.5, 0, 10);
      const jumper = box('dynamic', 0, 5);
      const w = world(ground, jumper);
      simulate(w, 1, 1 / fps);
      jumper.rigidBody.velocity.y = 9;
      jumper.rigidBody.grounded = false;
      const start = jumper.object3D.position.y;
      let top = start;
      for (let t = 0; t < 1.2; t += 1 / fps) {
        w.step(1 / fps);
        top = Math.max(top, jumper.object3D.position.y);
      }
      return top - start;
    };
    const at60 = apex(60);
    expect(at60).toBeCloseTo(81 / 48 - 9 / 120, 2); // v²/2g, less half a slice of rise
    expect(Math.abs(apex(30) - at60)).toBeLessThan(0.02);
    expect(Math.abs(apex(144) - at60)).toBeLessThan(0.02);
  });

  it('carries leftover time over, and caps the catch-up after a stall', () => {
    const w = world(box('dynamic', 0, 10));
    const slice = vi.spyOn(w, '_slice');
    w.step(1 / 144);
    expect(slice).not.toHaveBeenCalled();
    w.step(1 / 144);
    w.step(1 / 144);
    expect(slice).toHaveBeenCalledTimes(1);
    slice.mockClear();
    w.step(5); // a tab left in the background
    expect(slice).toHaveBeenCalledTimes(w.maxSubSteps);
  });

  it('draws moving bodies smoothly between slices, and puts them back', () => {
    const mover = box('dynamic', 0, 10);
    mover.rigidBody.gravity = 0;
    mover.rigidBody.velocity.x = 6;
    const w = world(mover);
    w.step(1 / 60);
    const real = mover.object3D.position.x;
    w.step(1 / 120); // half a slice: no physics step, but time has passed
    const restore = w.applyInterpolation();
    expect(mover.object3D.position.x).toBeCloseTo(real - 0.05, 6); // halfway through the last slice
    restore();
    expect(mover.object3D.position.x).toBe(real);

    mover.object3D.position.x = 50; // moved by something else — a gizmo, a respawn
    w.applyInterpolation()();
    expect(mover.object3D.position.x).toBe(50);
  });
});

describe('real collision shapes', () => {
  it('a tilted plank collides as tilted, not as its bounding box', () => {
    const faller = box('dynamic', 3, 6);
    const w = world(plank(30), faller);
    simulate(w, 2);
    // an upright 1 m box on a 30° slope rests on its downhill-facing corner
    const expected = surfaceY(30, 3.5) + 0.5;
    expect(faller.object3D.position.y).toBeCloseTo(expected, 1);
    expect(faller.object3D.position.y).toBeLessThan(3.1); // its bounding box would hold it at ~3.2
    expect(faller.rigidBody.grounded).toBe(true);
    expect(faller.rigidBody.groundNormal.x).toBeCloseTo(-0.5, 2);
  });

  it('stands still on a gentle slope instead of sliding down it', () => {
    const faller = box('dynamic', 2, 5);
    const w = world(plank(25), faller);
    simulate(w, 1.5);
    const x = faller.object3D.position.x;
    simulate(w, 2);
    expect(Math.abs(faller.object3D.position.x - x)).toBeLessThan(0.02);
  });

  it('slides off a slope too steep to stand on', () => {
    const faller = box('dynamic', 1, 5);
    const w = world(plank(65, { length: 12 }), faller);
    simulate(w, 0.6);
    const x = faller.object3D.position.x;
    simulate(w, 1);
    expect(faller.object3D.position.x).toBeLessThan(x - 0.5);
  });

  it('walks up a ramp, and stays on it walking back down', () => {
    const walker = box('dynamic', -3, 2);
    const w = world(plank(20, { length: 14 }), walker);
    simulate(w, 1);
    const y0 = walker.object3D.position.y;
    const walk = (vx, seconds) => {
      let grounded = 0;
      let steps = 0;
      for (let t = 0; t < seconds; t += 1 / 60) {
        walker.rigidBody.velocity.x = vx;
        w.step(1 / 60);
        steps++;
        if (walker.rigidBody.grounded) grounded++;
      }
      return grounded / steps;
    };
    expect(walk(4, 1.5)).toBeGreaterThan(0.95);
    expect(walker.object3D.position.y).toBeGreaterThan(y0 + 1.5); // climbed
    expect(walk(-4, 1.5)).toBeGreaterThan(0.95);                   // never hopped off going down
    expect(walker.object3D.position.y).toBeCloseTo(y0, 0);
  });

  it('moving platforms carry whoever stands on them', () => {
    const platform = box('kinematic', 0, 0, 0, 4);
    const rider = box('dynamic', 0, 3);
    const w = world(platform, rider);
    simulate(w, 1);
    const x0 = rider.object3D.position.x;
    for (let i = 0; i < 60; i++) {
      platform.object3D.position.x += 0.05;
      w.step(1 / 60);
    }
    expect(rider.object3D.position.x - x0).toBeCloseTo(3, 1);
  });

  it('spheres and capsules rest at their real size', () => {
    const ground = box('static', 0, -0.5, 0, 10); // top at 4.5
    const ball = new Entity(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8)));
    ball.object3D.position.set(0, 9, 0);
    ball.rigidBody = new RigidBody({ type: 'dynamic' }); // auto -> sphere
    const pill = new Entity(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1)));
    pill.object3D.position.set(3, 9, 0);
    pill.rigidBody = new RigidBody({ type: 'dynamic', shape: 'capsule' });
    const w = world(ground, ball, pill);
    simulate(w, 2);
    expect(ball.object3D.position.y).toBeCloseTo(5.5, 1);
    expect(pill.object3D.position.y).toBeCloseTo(5.5, 1);
    expect(w.colliderFor(ball).kind).toBe('capsule');
    expect(w.colliderFor(pill).r).toBeCloseTo(0.5, 6);
  });

  it('triggers use their real shape, not their bounding box', () => {
    const zone = plank(45, { length: 6, thick: 0.2, trigger: true }); // a thin diagonal strip
    const corner = box('dynamic', 1.8, -1.8, 0, 0.3);   // inside its bounding box, far from the strip
    const onIt = box('dynamic', 1, 1, 0, 0.3);          // right on the strip
    corner.rigidBody.gravity = 0;
    onIt.rigidBody.gravity = 0;
    const w = world(zone, corner, onIt);
    w.step(1 / 60);
    const touching = w.events.filter((e) => e.type === 'triggerEnter').map((e) => (e.a === zone ? e.b : e.a));
    expect(touching).toEqual([onIt]);
  });

  it('raycasts hit a tilted face where it really is', () => {
    const w = world(plank(30));
    const hit = w.raycast(new THREE.Vector3(3, 10, 0), new THREE.Vector3(0, -1, 0), 20);
    expect(hit.distance).toBeCloseTo(10 - surfaceY(30, 3), 4);
    expect(hit.normal.x).toBeCloseTo(-0.5, 4);
    expect(hit.normal.y).toBeCloseTo(Math.cos(30 * DEG), 4);
  });

  it('a turning character keeps an upright box; a turned wall keeps its turn', () => {
    const hero = box('dynamic', 0, 0, 0, 1);
    hero.object3D.rotation.y = 0.7;
    const wall = box('static', 5, 0, 0, 1);
    wall.object3D.rotation.y = 0.7;
    const w = world(hero, wall);
    expect(w.colliderFor(hero).axes[0].toArray()).toEqual([1, 0, 0]);
    expect(w.colliderFor(wall).axes[0].x).toBeCloseTo(Math.cos(0.7), 6);
  });

  it('saves the shape with the body', () => {
    expect(new RigidBody({ shape: 'capsule' }).toJSON().shape).toBe('capsule');
    expect(new RigidBody({ shape: 'blob' }).shape).toBe('auto');
  });

  it('a ray landing on a box\'s edge gets the face it came through', () => {
    // straight down onto the rim of a crate: its top, not its side
    const crate = box('static', 0, 0, 0, 2);
    const w = world(crate);
    const down = w.raycast(new THREE.Vector3(1, 5, 0), new THREE.Vector3(0, -1, 0));
    expect(down.normal.toArray()).toEqual([0, 1, 0]);
    expect(down.point.y).toBeCloseTo(1, 6);
    const across = w.raycast(new THREE.Vector3(-5, 1, 0), new THREE.Vector3(1, 0, 0));
    expect(across.normal.toArray()).toEqual([-1, 0, 0]);
    // from inside, the face it leaves by
    const out = w.raycast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));
    expect(out.normal.toArray()).toEqual([0, 0, 1]);
    expect(out.distance).toBeCloseTo(1, 6);
  });
});

describe('finding who is near whom (broadphase)', () => {
  /** Boxes scattered at random over a 200 m square: some static, some moving. */
  function scatter(n, seed = 7) {
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(box(i % 3 === 0 ? 'dynamic' : 'static', rnd() * 200 - 100, rnd() * 4, rnd() * 200 - 100, 0.5 + rnd() * 3));
    }
    return out;
  }

  it('pairs exactly the bodies whose boxes come near each other — the same as testing every pair', () => {
    const w = world(...scatter(300));
    for (const r of w.bodies) buildColliderFor(w, r);
    const got = new Set(w._pairs().map(([a, b]) => `${a.id}:${b.id}`));
    const M = 0.4;
    const near = (a, b) => ['x', 'y', 'z'].every((k) => a.col.min[k] <= b.col.max[k] + M && b.col.min[k] <= a.col.max[k] + M);
    const want = new Set();
    for (let i = 0; i < w.bodies.length; i++) {
      for (let j = i + 1; j < w.bodies.length; j++) {
        const [a, b] = [w.bodies[i], w.bodies[j]];
        if (a.body.type === 'static' && b.body.type === 'static') continue;
        if (near(a, b)) want.add(`${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`);
      }
    }
    expect(got).toEqual(want);
    expect(want.size).toBeLessThan(300); // a handful each, not 45 000
  });

  it('a level of a thousand bodies steps quickly', () => {
    const floor = box('static', 0, -1, 0, 1);
    floor.object3D.scale.set(220, 1, 220);
    const w = world(floor, ...scatter(1000));
    simulate(w, 1 / 6); // warmed up first
    // the fastest of three batches: the other test files share the machine, and one
    // slow moment of theirs is not this being slow
    let perSlice = Infinity;
    for (let batch = 0; batch < 3; batch++) {
      const t = performance.now();
      simulate(w, 1 / 3); // 20 slices
      perSlice = Math.min(perSlice, (performance.now() - t) / 20);
    }
    // about 7 ms alone; the other test files share the machine. Testing every pair eight
    // times, as it used to, took hundreds.
    expect(perSlice).toBeLessThan(60);
    const fallenThrough = w.bodies.filter((r) => r.body.type === 'dynamic' && r.entity.object3D.position.y < -1);
    expect(fallenThrough).toEqual([]);
  });
});

/** Build a body's collider as a slice would (for looking at pairs without stepping). */
function buildColliderFor(w, r) { w.colliderFor(r.entity); }
