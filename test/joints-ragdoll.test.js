import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { Entity } from '../src/entity.js';
import { makeJoint } from '../src/joints.js';
import { goLimp, updateRagdolls, clearRagdolls } from '../src/ragdoll.js';
import { world } from './helpers/world.js';

/** A world with a floor 200 m wide (its top at y = 0), and a way to add things. */
function level({ floor = true } = {}) {
  const w = new PhysicsWorld();
  const scene = new THREE.Scene();
  const add = (size, at, body) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
    mesh.position.set(...at);
    scene.add(mesh);
    const e = new Entity(mesh);
    e.rigidBody = new RigidBody(body);
    w.register(e);
    return e;
  };
  if (floor) add([200, 1, 200], [0, -0.5, 0], { type: 'static' });
  const run = (seconds, each = null) => {
    for (let t = 0; t < seconds; t += 1 / 60) { w.step(1 / 60); each?.(t); }
  };
  return { w, scene, add, run };
}
const crate = (extra = {}) => ({ type: 'dynamic', tumbles: true, friction: 0.5, mass: 10, ...extra });
const pos = (e) => e.object3D.position;

describe('joints', () => {
  it('a pendulum on a ball joint swings, staying as long as it was', () => {
    const { w, add, run } = level({ floor: false });
    const bob = add([0.3, 0.3, 0.3], [2, 5, 0], crate());
    // joined to a point in the world 2 m to its left
    w.addJoint(makeJoint(bob, null, { type: 'ball', anchor: [-2, 0, 0] }));
    const pivot = new THREE.Vector3(0, 5, 0);
    let lowest = Infinity;
    let maxStretch = 0;
    run(1.2, () => {
      lowest = Math.min(lowest, pos(bob).y);
      maxStretch = Math.max(maxStretch, Math.abs(pos(bob).distanceTo(pivot) - 2));
    });
    expect(lowest, 'it swung down').toBeLessThan(3.3);
    expect(maxStretch, 'never stretched').toBeLessThan(0.08);
  });

  it('a hinged door turns about its hinge only, and no further than its limits', () => {
    const { w, add, run } = level();
    const door = add([1, 2, 0.1], [0.5, 1.05, 0], crate({ mass: 20, gravity: 0 }));
    // hinged along its left edge (x = 0), upright; it opens 0°–90°
    w.addJoint(makeJoint(door, null, { type: 'hinge', anchor: [-0.5, 0, 0], axis: 'y', min: 0, max: 90 }));
    door.rigidBody.velocity.set(0, 0, -3); // a shove on its face
    door.rigidBody.angularVelocity.set(0, 6, 0);
    let most = 0;
    run(2, () => {
      const yaw = THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(door.object3D.quaternion, 'YXZ').y);
      most = Math.max(most, yaw);
    });
    const e = new THREE.Euler().setFromQuaternion(door.object3D.quaternion, 'YXZ');
    expect(most, 'it opened').toBeGreaterThan(30);
    expect(most, 'not past its stop').toBeLessThan(97);
    expect(Math.abs(THREE.MathUtils.radToDeg(e.x)), 'no tilt').toBeLessThan(3);
    expect(Math.abs(THREE.MathUtils.radToDeg(e.z)), 'no lean').toBeLessThan(3);
    // its hinge edge stays where it was
    const hinge = new THREE.Vector3(-0.5, 0, 0).applyQuaternion(door.object3D.quaternion).add(pos(door));
    expect(hinge.distanceTo(new THREE.Vector3(0, 1.05, 0))).toBeLessThan(0.05);
  });

  it('a rope holds a weight no further than its length, and goes slack closer', () => {
    const { w, add, run } = level({ floor: false });
    const weight = add([0.3, 0.3, 0.3], [0, 4, 0], crate());
    w.addJoint(makeJoint(weight, null, { type: 'rope', length: 2 })); // tied to where it is: 2 m of rope
    run(2);
    expect(pos(weight).y, 'hangs at the end of the rope').toBeCloseTo(2, 1);
    // thrown up: slack, it flies freely above
    weight.rigidBody.velocity.set(0, 6, 0);
    run(0.3);
    expect(pos(weight).y).toBeGreaterThan(2.5);
  });

  it('a spring bounces a weight and settles it a little below its length', () => {
    const { w, add, run } = level({ floor: false });
    const weight = add([0.3, 0.3, 0.3], [0, 3, 0], crate({ mass: 1 }));
    w.addJoint(makeJoint(weight, null, { type: 'spring', length: 1, stiffness: 100, damping: 2 }));
    // its world end is where it began (y = 3) and it starts at its length below (y = 2)
    weight.object3D.position.y = 2;
    let low = Infinity;
    run(0.6, () => { low = Math.min(low, pos(weight).y); });
    expect(low, 'it bounced past where it rests').toBeLessThan(1.85);
    run(4);
    expect(pos(weight).y, 'settled: stretched by its weight (mg/k: 24 m/s² gravity, 0.24 m)').toBeCloseTo(1.76, 1);
    expect(Math.abs(weight.rigidBody.velocity.y)).toBeLessThan(0.1);
  });

  it('two welded (fixed) boxes fall and land as one', () => {
    const { w, add, run } = level();
    const a = add([1, 1, 1], [0, 3, 0], crate());
    const b = add([1, 1, 1], [1, 3, 0], crate());
    w.addJoint(makeJoint(a, b, { type: 'fixed' }));
    w.keepApart(a, b);
    a.rigidBody.angularVelocity.set(0, 0, 2);
    run(3);
    expect(pos(a).distanceTo(pos(b)), 'still 1 m apart').toBeCloseTo(1, 1);
    expect(a.object3D.quaternion.angleTo(b.object3D.quaternion), 'turned alike').toBeLessThan(0.05);
    expect(Math.min(pos(a).y, pos(b).y)).toBeLessThan(1);
  });

  it('a joint pulled harder than it can hold breaks: the weight falls', () => {
    const { w, add, run } = level({ floor: false });
    const weight = add([0.3, 0.3, 0.3], [0, 3, 0], crate({ mass: 50 }));
    const rope = w.addJoint(makeJoint(weight, null, { type: 'rope', length: 1, breakForce: 200 })); // 50 kg is ~490 N
    let seen = false;
    run(1, () => { if (w.brokenJoints.includes(rope)) seen = true; });
    expect(rope.broken).toBe(true);
    expect(seen, 'told, the slice it broke').toBe(true);
    expect(w.joints).not.toContain(rope);
    expect(pos(weight).y).toBeLessThan(1);
  });

  it('a rope that holds stays whole', () => {
    const { w, add, run } = level({ floor: false });
    const weight = add([0.3, 0.3, 0.3], [0, 3, 0], crate({ mass: 5 }));
    const rope = w.addJoint(makeJoint(weight, null, { type: 'rope', length: 1, breakForce: 2000 }));
    run(1);
    expect(rope.broken).toBe(false);
    expect(pos(weight).y).toBeGreaterThan(1.8);
  });

  it('a chain of links hangs from a point: each joined to the next', () => {
    const { w, add, run } = level({ floor: false });
    const links = [];
    for (let i = 0; i < 5; i++) links.push(add([0.1, 0.4, 0.1], [0.4 * i + 0.2, 6, 0], crate({ mass: 1 })));
    links.forEach((l) => { l.object3D.rotation.z = Math.PI / 2; });
    w.addJoint(makeJoint(links[0], null, { type: 'ball', anchor: [0, 0.2, 0] }));
    for (let i = 1; i < links.length; i++) {
      w.addJoint(makeJoint(links[i - 1], links[i], { type: 'ball', anchor: [0, -0.2, 0] }));
      w.keepApart(links[i - 1], links[i]);
    }
    run(4);
    const end = links[4];
    expect(pos(end).y, 'hangs below where it was tied').toBeLessThan(5);
    expect(pos(end).y, 'but no further than its 2 m').toBeGreaterThan(3.8);
    expect(pos(links[0]).distanceTo(new THREE.Vector3(0, 6, 0))).toBeLessThan(0.35);
  });

  it('removing a body takes its joints with it', () => {
    const { w, add } = level({ floor: false });
    const a = add([0.3, 0.3, 0.3], [0, 3, 0], crate());
    w.addJoint(makeJoint(a, null, { type: 'rope', length: 1 }));
    w.unregister(a);
    expect(w.joints.length).toBe(0);
  });
});

describe('a tumbling body moving fast (CCD)', () => {
  it('a crate thrown at 80 m/s stops at a 10 cm wall', () => {
    const { add, run } = level();
    add([0.1, 4, 4], [5, 2, 0], { type: 'static' });
    const box = add([0.3, 0.3, 0.3], [0, 1.5, 0], crate({ gravity: 0 }));
    box.rigidBody.velocity.set(80, 0, 0);
    run(0.5);
    expect(pos(box).x).toBeLessThan(5);
  });
});

/** A hero (a capsule) on a ramp, or on the flat with a crate to push. */
function hero(w, add, at, { maxSlope, pushStrength } = {}) {
  const h = add([0.8, 1.8, 0.8], at, { type: 'dynamic', shape: 'capsule', friction: 0, mass: 70 });
  // (set each frame by its Movement feel)
  if (maxSlope) h.rigidBody.maxSlope = maxSlope;
  if (pushStrength !== undefined) h.rigidBody.pushStrength = pushStrength;
  return h;
}

describe('character options', () => {
  const ramp = (deg) => {
    const L = level();
    const r = L.add([10, 0.5, 4], [0, 3, 0], { type: 'static' }); // its middle 3 m up
    r.object3D.rotation.z = THREE.MathUtils.degToRad(deg);
    r.object3D.updateMatrixWorld(true);
    return L;
  };

  it('steepest slope: on a 40° ramp it stands with the default (60°), slides off with 30°', () => {
    for (const [limit, slides] of [[0, false], [30, true]]) {
      const { add, run } = ramp(40);
      const h = hero(null, add, [0, 5.2, 0], limit ? { maxSlope: limit } : {});
      run(0.3);
      const x0 = pos(h).x;
      const y0 = pos(h).y;
      run(1);
      if (slides) expect(y0 - pos(h).y, 'slid down').toBeGreaterThan(0.5);
      else expect(Math.abs(pos(h).x - x0), 'stood still').toBeLessThan(0.05);
    }
  });

  it('push strength: a strong hero shoves a heavy crate, a weak one is held back', () => {
    const moved = {};
    for (const strength of [0.2, 5]) {
      const { add, run } = level();
      const h = hero(null, add, [0, 0.9, 0], { pushStrength: strength });
      const box = add([1, 1, 1], [1.2, 0.5, 0], { type: 'dynamic', mass: 200, friction: 0.5 });
      run(0.3);
      const x0 = pos(box).x;
      run(1, () => { h.rigidBody.velocity.x = 3; });
      moved[strength] = pos(box).x - x0;
    }
    expect(moved[5], 'strong: shoved along').toBeGreaterThan(1.5);
    expect(moved[0.2], 'weak: hardly').toBeLessThan(moved[5] / 3);
  });

  it('crouching: lower from its feet, kept down under a low ceiling, up again once out', () => {
    const { w, add, run } = level();
    const h = hero(w, add, [0, 0.9, 0]);
    add([2, 0.5, 4], [3, 1.6, 0], { type: 'static' }); // a beam: underside at 1.35 m
    run(0.3);
    expect(w.setHeight(h, 0.55)).toBeCloseTo(0.55, 2);
    const col = w.colliderFor(h);
    expect(col.max.y - col.min.y, 'about 1 m tall').toBeCloseTo(0.99, 1);
    expect(col.min.y, 'feet where they were').toBeCloseTo(0, 1);
    // under the beam: no room to stand
    run(1.2, () => { h.rigidBody.velocity.x = 2.5; });
    expect(pos(h).x, 'went under it').toBeGreaterThan(2.3);
    expect(pos(h).x).toBeLessThan(3.8);
    const share = w.setHeight(h, 1);
    expect(share, 'kept low').toBeLessThan(0.8);
    // out the other side: stands
    run(1, () => { h.rigidBody.velocity.x = 2.5; w.setHeight(h, 1); });
    expect(pos(h).x).toBeGreaterThan(4.1);
    expect(h.rigidBody.heightShare).toBe(1);
    expect(h.rigidBody.box ?? null, 'its own box back').toBe(null);
  });
});

/** A humanoid skeleton (Mixamo-style names) standing with its feet at y = 0. */
function humanoid() {
  const root = new THREE.Group();
  root.name = 'Dummy';
  const bone = (name, parent, [x, y, z]) => {
    const b = new THREE.Bone();
    b.name = `mixamorig:${name}`;
    b.position.set(x, y, z);
    parent.add(b);
    return b;
  };
  const hips = bone('Hips', root, [0, 1, 0]);
  const spine = bone('Spine', hips, [0, 0.12, 0]);
  const chest = bone('Spine1', spine, [0, 0.15, 0]);
  const neck = bone('Neck', chest, [0, 0.25, 0]);
  const head = bone('Head', neck, [0, 0.1, 0]);
  bone('HeadTop_End', head, [0, 0.2, 0]);
  for (const [s, k] of [['Left', 1], ['Right', -1]]) {
    const sh = bone(`${s}Shoulder`, chest, [0.08 * k, 0.2, 0]);
    const arm = bone(`${s}Arm`, sh, [0.1 * k, 0, 0]);
    const fore = bone(`${s}ForeArm`, arm, [0.27 * k, 0, 0]);
    bone(`${s}Hand`, fore, [0.25 * k, 0, 0]);
    const thigh = bone(`${s}UpLeg`, hips, [0.1 * k, -0.05, 0]);
    const shin = bone(`${s}Leg`, thigh, [0, -0.43, 0]);
    const foot = bone(`${s}Foot`, shin, [0, -0.42, 0]);
    bone(`${s}ToeBase`, foot, [0, -0.05, 0.12]);
  }
  return root;
}

describe('ragdolls', () => {
  function stage() {
    const L = level();
    const engine = { physics: L.w, scene: L.scene, mixers: [] };
    const root = humanoid();
    L.scene.add(root);
    const dummy = new Entity(root);
    dummy.rigidBody = new RigidBody({ type: 'dynamic', shape: 'capsule', mass: 70 });
    dummy.rigidBody.box = new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 1.8, 0.3));
    L.w.register(dummy);
    return { ...L, engine, dummy, root };
  }

  it('a character gone limp falls into a heap: its limbs on the floor, its bones with them', () => {
    const { engine, dummy, root, w, run } = stage();
    const head = root.getObjectByName('mixamorig:Head');
    const doll = goLimp(engine, dummy, { push: new THREE.Vector3(2, 0, 0) });
    expect(doll).toBeTruthy();
    expect(dummy.ragdoll).toBe(doll);
    expect(doll.parts.length, 'pelvis, torso, head, 4 arm parts, 4 leg parts').toBe(11);
    expect(w.bodyFor(dummy), 'its own body is gone').toBe(null);
    expect(doll.joints.length).toBe(10);
    run(3, () => updateRagdolls(engine));
    root.updateMatrixWorld(true);
    const headAt = head.getWorldPosition(new THREE.Vector3());
    expect(headAt.y, 'its head on the ground').toBeLessThan(0.6);
    expect(headAt.x, 'flung the way it was pushed').toBeGreaterThan(0.2);
    for (const p of doll.parts) {
      const at = p.proxy.object3D.position;
      expect(at.y, `${p.name} above the floor`).toBeGreaterThan(-0.05);
      expect(at.y, `${p.name} down`).toBeLessThan(0.7);
    }
    // its limbs are still joined: a forearm near its upper arm
    const upper = doll.parts.find((p) => p.name === 'L.upperArm').proxy.object3D.position;
    const lower = doll.parts.find((p) => p.name === 'L.lowerArm').proxy.object3D.position;
    expect(upper.distanceTo(lower)).toBeLessThan(0.45);
  });

  it('going limp twice keeps the one ragdoll; clearing takes its limbs out of the world', () => {
    const { engine, dummy, scene, w } = stage();
    const doll = goLimp(engine, dummy);
    expect(goLimp(engine, dummy)).toBe(doll);
    const before = w.bodies.length;
    clearRagdolls(engine);
    expect(w.bodies.length).toBe(before - 11);
    expect(w.joints.length).toBe(0);
    expect(dummy.ragdoll).toBeUndefined();
    expect(scene.children.some((c) => c.userData.ragdollPart)).toBe(false);
  });

  it('a shape with no skeleton just tumbles', () => {
    const { add, run } = level();
    const box = add([0.5, 1.8, 0.5], [0, 0.9, 0], { type: 'dynamic', mass: 70 });
    expect(goLimp({ physics: null, scene: null }, box, { push: new THREE.Vector3(3, 0, 0) })).toBe(null);
    expect(box.rigidBody.tumbles).toBe(true);
    run(2);
    expect(Math.abs(new THREE.Euler().setFromQuaternion(box.object3D.quaternion).z), 'toppled').toBeGreaterThan(0.8);
  });
});

describe('in a game: going limp, joints breaking, crouching', () => {
  /** The test humanoid as a character in a game world, with a body. */
  function character(engine, at = [0, 0, 0]) {
    const root = humanoid();
    root.position.set(...at);
    engine.scene.add(root);
    const e = new Entity(root);
    e.rigidBody = new RigidBody({ type: 'dynamic', shape: 'capsule', mass: 70 });
    e.rigidBody.box = new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 1.8, 0.3));
    engine.entities.push(e);
    engine.physics.register(e);
    return e;
  }

  it('Health "go limp": it falls as a ragdoll, flung away from what hurt it, and stays in the level', () => {
    const { engine, add, step } = world();
    add('Floor', { at: [0, -0.5, 0], size: [40, 1, 40], body: { type: 'static' } });
    const hero = add('Hero', { at: [-2, 0.9, 0], size: [0.8, 1.8, 0.8], body: { type: 'kinematic' } });
    const guard = character(engine);
    engine.gameplay.components.add(guard, 'health', { max: 10, atZero: 'go limp' });
    engine.gameplay.start();
    step(0.2);
    engine.gameplay.damage(guard, 20, hero);
    step(0.1);
    expect(guard.ragdoll, 'limp').toBeTruthy();
    expect(engine.entities).toContain(guard);
    step(2);
    const pelvis = guard.ragdoll.parts.find((p) => p.name === 'pelvis').proxy.object3D.position;
    expect(pelvis.x, 'away from the hero').toBeGreaterThan(0.3);
    expect(pelvis.y, 'down').toBeLessThan(0.5);
    engine.gameplay.clear();
    expect(guard.ragdoll, 'cleared when the game ends').toBeUndefined();
  });

  it('the rule action "Go limp (ragdoll)"', () => {
    const { engine, add, step, input } = world();
    add('Floor', { at: [0, -0.5, 0], size: [40, 1, 40], body: { type: 'static' } });
    const dummy = character(engine);
    engine.gameplay.rules.add(dummy, { when: { type: 'key', code: 'KeyK', mode: 'pressed' }, if: [], do: [{ type: 'ragdoll', target: 'self', push: 0 }] });
    engine.gameplay.start();
    step(0.1);
    expect(dummy.ragdoll).toBeFalsy();
    input.press('KeyK');
    step();
    expect(dummy.ragdoll).toBeTruthy();
  });

  it('"A joint breaks" sets off its rules', () => {
    const { engine, add, step } = world();
    const lamp = add('Lamp', { at: [0, 5, 0], size: [0.3, 0.3, 0.3], body: { type: 'dynamic', mass: 50 } });
    engine.gameplay.components.add(lamp, 'joint', { type: 'rope', length: 1, breakForce: 200 });
    engine.gameplay.rules.add(lamp, { when: { type: 'jointBreaks', who: 'any' }, if: [], do: [{ type: 'setVariable', name: 'fell', value: 1 }] });
    engine.gameplay.start();
    step(1);
    expect(engine.variables.get('fell')).toBe(1);
    expect(lamp.object3D.position.y).toBeLessThan(3);
  });

  it('the Crouch control: lower and slower while held, up again when let go', () => {
    const controls = [
      { inputs: [{ type: 'key', code: 'KeyD' }], target: 'player', action: { type: 'move', direction: 'right', speed: 4, relative: 'world', face: false } },
      { inputs: [{ type: 'key', code: 'KeyC' }], target: 'player', action: { type: 'crouch', height: 0.5, speed: 0.5 } },
    ];
    const { engine, add, step, input } = world({ controls });
    add('Floor', { at: [0, -0.5, 0], size: [200, 1, 10], body: { type: 'static' } });
    engine.hero = add('Hero', { at: [0, 0.9, 0], size: [0.8, 1.8, 0.8], body: { type: 'dynamic', shape: 'capsule', friction: 0, mass: 70 } });
    engine.gameplay.start();
    step(0.2);
    const walk = (s) => { const x0 = engine.hero.object3D.position.x; for (let t = 0; t < s; t += 1 / 60) { input.press('KeyD'); step(); } return (engine.hero.object3D.position.x - x0) / s; };
    const full = walk(1);
    input.press('KeyC');
    const low = walk(1);
    expect(engine.hero.crouched).toBe(true);
    const col = engine.physics.colliderFor(engine.hero);
    expect(col.max.y - col.min.y).toBeCloseTo(0.9, 1);
    expect(engine.hero.object3D.userData.eyeDrop).toBeCloseTo(0.9, 1);
    expect(low).toBeLessThan(full * 0.65);
    input.release('KeyC');
    step(0.1);
    expect(engine.hero.crouched).toBe(false);
    expect(engine.physics.colliderFor(engine.hero).max.y - engine.physics.colliderFor(engine.hero).min.y).toBeCloseTo(1.8, 1);
  });
});
