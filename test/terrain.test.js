// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PhysicsWorld, RigidBody, STEP_UP } from '../src/physics.js';
import { Entity } from '../src/entity.js';
import { Player } from '../src/player.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';

/** Rough ground as a model's mesh: 60 × 12 m, mounds and dips up to 0.7 m, a ledge at x = 8, a pit at x = 16. */
function roughGround() {
  const g = new THREE.PlaneGeometry(60, 12, 120, 24).rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    let y = 0.45 * Math.sin(x * 0.9) * Math.cos(z * 0.7) + 0.25 * Math.sin(x * 2.3 + 1);
    if (x > 8) y += 0.3;
    if (Math.hypot(x - 16, z) < 2) y -= 0.8;
    p.setY(i, y);
  }
  g.computeVertexNormals();
  const ground = new Entity(new THREE.Mesh(g));
  ground.rigidBody = new RigidBody({ type: 'static', shape: 'mesh' });
  return ground;
}

function world(...entities) {
  const w = new PhysicsWorld();
  for (const e of entities) w.register(e);
  return w;
}
const block = (size, at, body = { type: 'static' }) => {
  const e = new Entity(new THREE.Mesh(new THREE.BoxGeometry(...size)));
  e.object3D.position.set(...at);
  if (body) e.rigidBody = new RigidBody(body);
  return e;
};
const hero = (at, extra = {}) => block([0.8, 1.8, 0.8], at, { type: 'dynamic', mass: 70, friction: 0.1, shape: 'capsule', ...extra });

/**
 * Walk `who` along +x at `speed` for `seconds` (the controls set its speed every
 * frame), noting how it went: time off the ground, the biggest jump in height in
 * one slice — as simulated, and as drawn (with the step easing).
 */
function walk(w, who, { speed = 6, seconds = 8, until = Infinity } = {}) {
  const o = who.object3D;
  let slices = 0;
  let air = 0;
  let jolt = 0;
  let drawnJolt = 0;
  let lastY = null;
  let lastDrawn = null;
  for (let t = 0; t < seconds && o.position.x < until; t += 1 / 60) {
    who.rigidBody.velocity.x = speed;
    who.rigidBody.velocity.z = 0;
    w.step(1 / 60);
    const drawn = o.position.y + (o.userData.smoothY || 0);
    if (lastY !== null) {
      slices++;
      if (!who.rigidBody.grounded) air++;
      jolt = Math.max(jolt, Math.abs(o.position.y - lastY));
      drawnJolt = Math.max(drawnJolt, Math.abs(drawn - lastDrawn));
    }
    lastY = o.position.y;
    lastDrawn = drawn;
  }
  return { air: air / slices, jolt, drawnJolt, x: o.position.x, y: o.position.y };
}
const settle = (w, s = 1) => { for (let t = 0; t < s; t += 1 / 60) w.step(1 / 60); };

describe('walking over rough ground', () => {
  it('stays on the ground over mounds, a ledge and a pit — no flying off crests, no jolts', () => {
    // (it used to be in the air a quarter of the time, thrown off every crest, and
    // jumped up to 0.7 m in one slice at a ledge or the lip of the pit)
    for (const shape of ['capsule', 'auto']) {
      const who = hero([-25, 2, 0], { shape });
      const w = world(roughGround(), who);
      settle(w);
      const run = walk(w, who, { seconds: 12, until: 28 });
      expect(run.x, shape).toBeGreaterThan(27);
      expect(run.air, shape).toBeLessThan(0.02);
      expect(run.jolt, shape).toBeLessThan(0.2); // the steep wall of the pit, followed down
      expect(run.drawnJolt, shape).toBeLessThan(0.15);
    }
  });

  it('a steep but walkable slope (50°) slows the climb — it does not throw the runner into the air at the top', () => {
    const ramp = block([6, 0.4, 6], [0, 1.2, 0]);
    ramp.object3D.rotation.z = THREE.MathUtils.degToRad(50);
    const top = block([10, 3.5, 6], [6.85, 3.5 / 2 - 0.3, 0]); // the plateau the ramp leads to
    const who = hero([-6, 1, 0]);
    const w = world(block([60, 1, 20], [0, -0.5, 0]), ramp, top, who);
    settle(w);
    let highest = -Infinity;
    for (let t = 0; t < 4; t += 1 / 60) {
      who.rigidBody.velocity.x = 8;
      w.step(1 / 60);
      if (who.object3D.position.x > 2.5) highest = Math.max(highest, who.object3D.position.y);
    }
    expect(who.object3D.position.x).toBeGreaterThan(4); // it got up
    expect(highest).toBeLessThan(3.2 + 0.9 + 0.15); // never flung above the plateau (its top 3.2, the hero 1.8 tall)
  });
});

describe('stepping up', () => {
  /** Stairs: 6 steps, 0.3 m up and 0.5 m deep each, starting at x = 0. */
  const stairs = () => Array.from({ length: 6 }, (_, i) => block([0.5, 0.3 * (i + 1), 6], [0.25 + i * 0.5, 0.15 * (i + 1), 0]));

  it('a character walks up stairs (0.3 m steps) — each step eased, not a jolt', () => {
    const who = hero([-3, 0.9, 0]);
    const w = world(block([40, 1, 20], [0, -0.5, 0]), ...stairs(), block([6, 1.8, 6], [5.75, 0.9, 0]), who);
    settle(w);
    const run = walk(w, who, { speed: 4, seconds: 3 });
    expect(run.x).toBeGreaterThan(4);
    expect(run.y).toBeCloseTo(1.8 + 0.9, 1); // on the landing at the top
    expect(run.drawnJolt).toBeLessThan(0.15); // each step a glide, not a jolt
  });

  it('a ledge higher than its rounded feet ride over (0.42 m): stepped onto — eased', () => {
    const who = hero([-3, 0.9, 0]);
    const w = world(block([40, 1, 20], [0, -0.5, 0]), block([8, 0.42, 6], [4, 0.21, 0]), who);
    settle(w);
    const run = walk(w, who, { speed: 4, seconds: 2 });
    expect(run.x).toBeGreaterThan(1);
    expect(run.y).toBeCloseTo(0.42 + 0.9, 1);
    expect(run.jolt).toBeGreaterThan(0.3); // up in one go...
    expect(run.drawnJolt).toBeLessThan(0.15); // ...drawn as a glide
  });

  it('but not a wall, a ledge under a low ceiling, or with Steps up onto set to 0', () => {
    const cases = {
      wall: [block([1, 0.9, 6], [0.5, 0.45, 0])],
      ceiling: [block([2, 0.42, 6], [1, 0.21, 0]), block([2, 0.2, 6], [1, 0.42 + 1.2 + 0.1, 0])],
      'no stepping': [block([2, 0.42, 6], [1, 0.21, 0])],
    };
    for (const [name, parts] of Object.entries(cases)) {
      const who = hero([-3, 0.9, 0]);
      if (name === 'no stepping') who.rigidBody.stepHeight = 0;
      const w = world(block([40, 1, 20], [0, -0.5, 0]), ...parts, who);
      settle(w);
      const run = walk(w, who, { speed: 4, seconds: 2 });
      expect(run.x, name).toBeLessThan(-0.3); // stopped at its side
      expect(Math.abs(run.y - 0.9), name).toBeLessThan(0.15); // (its rounded feet may ride a little up the edge)
    }
  });

  it('a crate (a box body) is not stepped up — only characters (capsules) step', () => {
    const crate = block([0.8, 0.8, 0.8], [-3, 0.4, 0], { type: 'dynamic', friction: 0.1 });
    const w = world(block([40, 1, 20], [0, -0.5, 0]), block([2, 0.3, 6], [1, 0.15, 0]), crate);
    settle(w);
    expect(walk(w, crate, { speed: 4, seconds: 2 }).x).toBeLessThan(-0.3);
    expect(STEP_UP).toBe(0.45);
  });

  it('the player is a capsule: the stand-in player and the body controls give it', () => {
    expect(new Player().rigidBody.shape).toBe('capsule');
  });
});

describe('hovering and flying over rough ground', () => {
  it('holds its hover height over mounds and the pit, and counts as on the ground', () => {
    for (const gravity of [-24, 0]) { // a hovercraft, and a flyer with no gravity
      const craft = hero([-25, 3, 0], { gravity });
      craft.rigidBody.hover = 1.5;
      const ground = roughGround();
      const w = world(ground, craft);
      settle(w, 1.5);
      let low = Infinity;
      let high = -Infinity;
      let grounded = 0;
      let n = 0;
      const ray = new THREE.Raycaster();
      for (let t = 0; t < 6; t += 1 / 60) {
        craft.rigidBody.velocity.x = 6;
        w.step(1 / 60);
        const o = craft.object3D.position;
        if (o.x > 27) break;
        ray.set(new THREE.Vector3(o.x, 50, o.z), new THREE.Vector3(0, -1, 0));
        const below = ray.intersectObject(ground.object3D)[0]?.point.y;
        const gap = o.y - 0.9 - below; // from its bottom
        low = Math.min(low, gap);
        high = Math.max(high, gap);
        n++;
        if (craft.rigidBody.grounded) grounded++;
      }
      expect(low, `gravity ${gravity}`).toBeGreaterThan(0.6);  // never scrapes...
      expect(high, `gravity ${gravity}`).toBeLessThan(2.4);    // ...never drifts off
      // it can jump — all but over the pit, where the ground drops out of reach
      expect(grounded / n, `gravity ${gravity}`).toBeGreaterThan(0.85);
    }
  });
});

describe('Tilt with the ground (Movement feel)', () => {
  function drive(tilt) {
    const engine = {
      entities: [], variables: new VariableStore(), physics: new PhysicsWorld(), scene: new THREE.Scene(),
      input: null, camera: null, playerEntity: null, time: 0, poses: new Map(),
      remove() {}, addBehavior() {}, removeBehavior() {}, playEntitySounds() {},
    };
    engine.gameplay = new Gameplay(engine);
    const add = (e) => { engine.entities.push(e); engine.scene.add(e.object3D); engine.physics.register(e); return e; };
    const slope = add(block([30, 1, 20], [0, -0.5, 0]));
    slope.object3D.rotation.z = THREE.MathUtils.degToRad(15); // rising towards -x
    slope.object3D.updateMatrixWorld(true);
    const car = add(block([1.8, 1, 4], [0, 3, 0], { type: 'dynamic', mass: 900, friction: 0.5 }));
    engine.gameplay.components.add(car, 'movement', { tilt });
    engine.gameplay.start();
    for (let t = 0; t < 2; t += 1 / 60) {
      engine.time += 1 / 60;
      engine.scene.updateMatrixWorld(true);
      engine.physics.step(1 / 60);
      engine.gameplay.update(1 / 60, engine.time);
    }
    const tiltQ = engine.poses.get(car.object3D)?.tilt;
    return tiltQ ? THREE.MathUtils.radToDeg(tiltQ.angleTo(new THREE.Quaternion())) : 0;
  }

  it('a car on a 15° slope is drawn leaning with it; at 0 it stays upright', () => {
    expect(drive(1)).toBeCloseTo(15, 0);
    expect(drive(0.5)).toBeCloseTo(7.5, 0);
    expect(drive(0)).toBe(0);
  });
});
