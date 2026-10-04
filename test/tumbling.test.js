import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { Entity } from '../src/entity.js';

/** A world with a floor 200 m wide (its top at y = 0) and a way to add things. */
function level() {
  const w = new PhysicsWorld();
  const add = (size, at, body, { sphere = false } = {}) => {
    const geo = sphere ? new THREE.SphereGeometry(size[0] / 2, 16, 12) : new THREE.BoxGeometry(...size);
    const mesh = new THREE.Mesh(geo);
    mesh.position.set(...at);
    const e = new Entity(mesh);
    e.rigidBody = new RigidBody(body);
    w.register(e);
    return e;
  };
  add([200, 1, 200], [0, -0.5, 0], { type: 'static' });
  const run = (seconds) => { for (let t = 0; t < seconds; t += 1 / 60) w.step(1 / 60); };
  return { w, add, run };
}
const crate = (extra = {}) => ({ type: 'dynamic', tumbles: true, friction: 0.5, ...extra });
/** How far an object is turned from where it started, in degrees. */
const turned = (e) => THREE.MathUtils.radToDeg(e.object3D.quaternion.angleTo(new THREE.Quaternion()));
/** Is one of its own axes pointing straight up (so it lies on a face)? */
const onAFace = (e) => [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  .some((a) => Math.abs(new THREE.Vector3(...a).applyQuaternion(e.object3D.quaternion).y) > 0.9995);

describe('tumbling bodies', () => {
  it('a crate dropped flat lands flat and stays still', () => {
    const { add, run } = level();
    const box = add([1, 1, 1], [0, 3, 0], crate());
    run(3);
    expect(box.object3D.position.y).toBeCloseTo(0.5, 1);
    expect(turned(box)).toBeLessThan(1);
    expect(box.rigidBody.velocity.length()).toBeLessThan(0.05);
    expect(box.rigidBody.grounded).toBe(true);
  });

  it('a crate dropped on its corner topples and comes to rest on a face', () => {
    const { add, run } = level();
    const box = add([1, 1, 1], [0, 2, 0], crate());
    box.object3D.rotation.set(0.5, 0, 0.6);
    run(5);
    expect(onAFace(box)).toBe(true);
    expect(box.object3D.position.y).toBeCloseTo(0.5, 1);
    expect(box.rigidBody.angularVelocity.length()).toBeLessThan(0.05);
  });

  it('hanging over a ledge: it tips off if its middle is past the edge, stays if not', () => {
    for (const [overhang, falls] of [[0.3, true], [-0.3, false]]) {
      const { add, run } = level();
      add([4, 2, 4], [0, 1, 0], { type: 'static' }); // a platform, its edge at x = 2, top at y = 2
      const box = add([1, 1, 1], [2 + overhang, 2.5, 0], crate());
      run(3);
      if (falls) {
        expect(box.object3D.position.y, 'falls off').toBeLessThan(1);
        expect(turned(box), 'turning as it goes').toBeGreaterThan(20);
      } else {
        expect(box.object3D.position.y, 'stays').toBeCloseTo(2.5, 1);
        expect(turned(box)).toBeLessThan(1);
      }
    }
  });

  it('a ball rolls down a slope — turning as it goes — and rolls to a stop on the flat', () => {
    const { add, run } = level();
    const slope = add([8, 0.5, 4], [0, 1.2, 0], { type: 'static' });
    slope.object3D.rotation.z = -0.3; // down towards +x
    const ball = add([1, 1, 1], [-2.5, 3, 0], crate(), { sphere: true });
    run(1.5);
    const v = ball.rigidBody.velocity;
    expect(v.x).toBeGreaterThan(1); // rolling downhill
    // rolling, not sliding: it spins about -z, at about v / r
    expect(-ball.rigidBody.angularVelocity.z).toBeGreaterThan(0.7 * (Math.hypot(v.x, v.y) / 0.5));
    run(12);
    expect(ball.rigidBody.velocity.length()).toBeLessThan(0.05);
    expect(ball.rigidBody.angularVelocity.length()).toBeLessThan(0.05);
    expect(ball.object3D.position.y).toBeCloseTo(0.5, 1);
  });

  it('a stack of crates stands', () => {
    const { add, run } = level();
    const stack = [0, 1, 2].map((i) => add([1, 1, 1], [0, 0.5 + i * 1.001, 0], crate()));
    run(4);
    stack.forEach((box, i) => {
      expect(box.object3D.position.y).toBeCloseTo(0.5 + i, 1);
      expect(Math.abs(box.object3D.position.x)).toBeLessThan(0.05);
      expect(turned(box)).toBeLessThan(2);
    });
  });

  it('a push low on a tall crate shoves it; a hit high up knocks it over', () => {
    const { add, run } = level();
    const tall = add([0.6, 2, 0.6], [0, 1, 0], crate({ mass: 2 }));
    const ball = add([0.3, 0.3, 0.3], [-3, 1.8, 0], { type: 'dynamic', gravity: 0, mass: 3 }, { sphere: true });
    ball.rigidBody.velocity.set(12, 0, 0);
    run(3);
    expect(tall.object3D.position.x).toBeGreaterThan(0.3);
    expect(turned(tall)).toBeGreaterThan(60); // on its side
  });

  it('a heavy hero walking into a crate pushes it along', () => {
    const { add, run } = level();
    const box = add([1, 1, 1], [1.5, 0.5, 0], crate());
    const hero = add([0.8, 1.8, 0.8], [0, 0.9, 0], { type: 'dynamic', shape: 'capsule', mass: 70, friction: 0.1 });
    for (let t = 0; t < 2; t += 1 / 60) {
      hero.rigidBody.velocity.x = 2; // the controls set its speed every frame
      run(1 / 60);
    }
    expect(box.object3D.position.x).toBeGreaterThan(3);
    expect(hero.object3D.position.x).toBeGreaterThan(2);
  });

  it('a body without Tumbles never turns, however it is hit', () => {
    const { add, run } = level();
    const box = add([1, 1, 1], [0, 0.5, 0], { type: 'dynamic', friction: 0.5 });
    const ball = add([0.3, 0.3, 0.3], [-3, 0.9, 0.4], { type: 'dynamic', gravity: 0 }, { sphere: true });
    ball.rigidBody.velocity.set(10, 0, 0);
    run(2);
    expect(turned(box)).toBe(0);
    expect(box.rigidBody.angularVelocity.length()).toBe(0);
  });

  it('one body standing on another moving one is on the ground, and doesn\'t gather speed', () => {
    const { add, run } = level();
    add([1, 1, 1], [0, 0.5, 0], { type: 'dynamic' });
    const top = add([0.8, 0.8, 0.8], [0, 1.41, 0], { type: 'dynamic' });
    run(3);
    expect(top.rigidBody.grounded).toBe(true);
    expect(Math.abs(top.rigidBody.velocity.y)).toBeLessThan(1);
    expect(top.object3D.position.y).toBeCloseTo(1.4, 1);
  });

  it("rests on a model's real (mesh) floor too", () => {
    const w = new PhysicsWorld();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2));
    const floor = new Entity(ground);
    floor.rigidBody = new RigidBody({ type: 'static', shape: 'mesh' });
    w.register(floor);
    const box = new Entity(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    box.object3D.position.set(0, 2, 0);
    box.object3D.rotation.set(0.4, 0, 0.3);
    box.rigidBody = new RigidBody(crate());
    w.register(box);
    for (let t = 0; t < 4; t += 1 / 60) w.step(1 / 60);
    expect(onAFace(box)).toBe(true);
    expect(box.object3D.position.y).toBeCloseTo(0.5, 1);
  });

  it('on a slope: grippy stays put, slippery slides down', () => {
    for (const [friction, slides] of [[1, false], [0.1, true]]) {
      const { add, run } = level();
      const slope = add([10, 0.5, 6], [0, 1, 0], { type: 'static', friction });
      slope.object3D.rotation.z = -0.35; // about 20°, down towards +x
      const box = add([1, 1, 1], [0, 2.2, 0], crate({ friction }));
      box.object3D.rotation.z = -0.35;
      run(2);
      const moved = box.object3D.position.x;
      if (slides) expect(moved, 'slides').toBeGreaterThan(2);
      else expect(Math.abs(moved), 'stays').toBeLessThan(0.1);
    }
  });

  it('is saved with the body', () => {
    expect(new RigidBody({ type: 'dynamic', tumbles: true }).toJSON().tumbles).toBe(true);
    expect(new RigidBody({ type: 'dynamic' }).tumbles).toBe(false);
  });
});
