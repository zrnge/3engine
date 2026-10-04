// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { Entity } from '../src/entity.js';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { VehicleRig, attachVehicle, findWheels } from '../src/vehicle.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';
import { defaultControls } from '../src/controls.js';

/**
 * A car model as a 3D tool exports one: a body, four wheels named Wheel_FL…,
 * the front left one a tyre with a rim inside it, a steering wheel and a spare.
 * Front: +Z; 1.8 wide, 4 long, wheels 0.35 m.
 */
function carModel() {
  const root = new THREE.Group();
  root.name = 'Car';
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 4));
  body.name = 'Body';
  body.position.y = 0.75;
  root.add(body);
  const steering = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.03));
  steering.name = 'SteeringWheel';
  steering.position.set(0.4, 1.1, 0.3);
  root.add(steering);
  const spare = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2).rotateX(Math.PI / 2));
  spare.name = 'SpareTire';
  spare.position.set(0, 1.0, -2.05);
  root.add(spare);
  for (const [name, x, z] of [['Wheel_FL', 0.85, 1.3], ['Wheel_FR', -0.85, 1.3], ['Wheel_RL', 0.85, -1.3], ['Wheel_RR', -0.85, -1.3]]) {
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 16).rotateZ(Math.PI / 2));
    tyre.name = name === 'Wheel_FL' ? 'Tire_FL' : name;
    tyre.position.set(x, 0.35, z);
    root.add(tyre);
    if (name === 'Wheel_FL') {
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.27, 12).rotateZ(Math.PI / 2));
      rim.name = 'Rim_FL';
      rim.position.set(x, 0.35, z);
      root.add(rim);
    }
  }
  return root;
}

/** A world with a big floor; `extra` more static bodies. */
function level(...extra) {
  const w = new PhysicsWorld();
  const floor = new Entity(new THREE.Mesh(new THREE.BoxGeometry(3000, 1, 3000)));
  floor.object3D.position.y = -0.5;
  floor.rigidBody = new RigidBody({ type: 'static' });
  w.register(floor);
  for (const e of extra) w.register(e);
  return w;
}
function car(w, { at = [0, 0.3, 0], settings = {}, model = carModel() } = {}) {
  model.position.set(...at);
  model.updateMatrixWorld(true);
  const e = new Entity(model);
  attachVehicle({ physics: w }, e, settings, RigidBody);
  return e;
}
const run = (w, seconds, each) => { for (let t = 0; t < seconds; t += 1 / 60) { each?.(t); w.step(1 / 60); } };
const upright = (e) => new THREE.Vector3(0, 1, 0).applyQuaternion(e.object3D.quaternion).y;
const heading = (e) => { const f = new THREE.Vector3(0, 0, 1).applyQuaternion(e.object3D.quaternion); return Math.atan2(f.x, f.z); };
/** How far it has turned, adding up each slice's turn (no wrapping at ±180°). */
function turned(w, e, seconds, each) {
  let total = 0;
  let last = heading(e);
  run(w, seconds, (t) => {
    each?.(t);
    const h = heading(e);
    let d = h - last;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    last = h;
  });
  return THREE.MathUtils.radToDeg(total);
}

describe('a car model: its wheels', () => {
  it('found by name — a tyre and its rim as one wheel; not the steering wheel or the spare', () => {
    const wheels = findWheels(carModel());
    expect(wheels).toHaveLength(4);
    const fl = wheels.find((w) => w.parts.some((p) => p.name === 'Tire_FL'));
    expect(fl.parts.map((p) => p.name).sort()).toEqual(['Rim_FL', 'Tire_FL']);
    expect(fl.radius).toBeCloseTo(0.35, 2);
    expect(wheels.flatMap((w) => w.parts).some((p) => /Steering|Spare/.test(p.name))).toBe(false);
  });

  it('sorted into front and back, left and right, by its front', () => {
    const e = new Entity(carModel());
    const rig = new VehicleRig(e, {});
    expect(rig.wheels.filter((w) => w.front)).toHaveLength(2);
    expect(rig.wheels.find((w) => w.parts[0]?.node.name === 'Tire_FL')).toMatchObject({ front: true, left: true });
    // a model made facing -Z: its "front" wheels are the other pair
    const back = new VehicleRig(new Entity(carModel()), { front: '-Z' });
    expect(back.wheels.find((w) => w.parts[0]?.node.name === 'Tire_FL').front).toBe(false);
  });

  it('built in the editor — tyres parented to a stretched body box — its wheels stay round as they spin and steer', () => {
    // the body: the 1.5 m box primitive scaled to 1.9 × 0.7 × 4.2; the tyres its children, sized against that
    const s = [1.9 / 1.5, 0.7 / 1.5, 4.2 / 1.5];
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5));
    body.scale.set(...s);
    for (const [tag, x, z] of [['FL', 0.9, 1.35], ['FR', -0.9, 1.35], ['RL', 0.9, -1.35], ['RR', -0.9, -1.35]]) {
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.8, 16));
      tyre.name = `Car tire ${tag}`;
      tyre.rotation.z = Math.PI / 2;
      tyre.position.set(x / s[0], -0.57 / s[1], z / s[2]);
      tyre.scale.set(0.38 / (0.7 * s[1]), 0.28 / (1.8 * s[0]), 0.38 / (0.7 * s[2]));
      body.add(tyre);
    }
    const w = level();
    const e = car(w, { at: [0, 1, 0], model: body });
    w.register(e);
    run(w, 2.5, (t) => e.vehicle.setInput(1, t > 1 ? 0.6 : 0, false));
    expect(e.vehicle.speed).toBeGreaterThan(5); // it drives
    e.vehicle.pose();
    const tyre = body.getObjectByName('Car tire FL');
    tyre.updateMatrixWorld(true);
    // round: its world shape is a true cylinder — no shear, 0.76 across both ways, 0.28 wide
    const [ax, ay, az] = [0, 1, 2].map((i) => new THREE.Vector3().setFromMatrixColumn(tyre.matrixWorld, i));
    expect(Math.abs(ax.dot(ay)) + Math.abs(ay.dot(az)) + Math.abs(ax.dot(az))).toBeLessThan(1e-6);
    expect(ax.length() * 0.7 * 2).toBeCloseTo(0.76, 3);
    expect(az.length() * 0.7 * 2).toBeCloseTo(0.76, 3);
    expect(ay.length() * 1.8).toBeCloseTo(0.28, 3);
  });

  it('a model without wheels (or a plain box) gets four at its corners; its box stops at their middles', () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 1.2, 4));
    const rig = new VehicleRig(new Entity(box), {});
    expect(rig.wheels).toHaveLength(4);
    expect(rig.drawnWheels).toBe(false);
    expect(rig.chassisBox.min.y).toBeGreaterThan(-0.6); // raised off the bottom: the wheels hold it up
    expect(rig.chassisBox.max.y).toBeCloseTo(0.6, 5);
  });
});

describe('driving', () => {
  it('sits on its springs: level, still, every wheel on the ground, its body off it', () => {
    const w = level();
    const e = car(w);
    run(w, 2);
    expect(upright(e)).toBeGreaterThan(0.999);
    expect(e.rigidBody.velocity.length()).toBeLessThan(0.02);
    expect(e.vehicle.grounded).toBe(4);
    expect(w.colliderFor(e).min.y).toBeGreaterThan(0.1);
  });

  it('0–100 km/h in the time set, never past its top speed', () => {
    for (const accelTime of [4, 8]) {
      const w = level();
      const e = car(w, { settings: { accelTime, topSpeed: 140 } });
      run(w, 1);
      let t100 = null;
      let fastest = 0;
      run(w, 25, (t) => {
        e.vehicle.setInput(1, 0, false);
        if (t100 === null && e.vehicle.kmh >= 100) t100 = t;
        fastest = Math.max(fastest, e.vehicle.kmh);
      });
      expect(t100).toBeGreaterThan(accelTime - 0.3);
      expect(t100).toBeLessThan(accelTime * 1.1 + 0.2); // within 10% (it squats and pitches as it pulls away)
      expect(fastest).toBeLessThan(141);
      expect(fastest).toBeGreaterThan(130);
    }
  });

  it('brakes to a stop, then — the pedal still held — reverses, up to its reverse speed', () => {
    const w = level();
    const e = car(w);
    run(w, 1);
    run(w, 12, () => e.vehicle.setInput(1, 0, false));
    const from = e.vehicle.kmh;
    let stopped = null;
    run(w, 8, (t) => {
      e.vehicle.setInput(-1, 0, false);
      if (stopped === null && e.vehicle.kmh < 0.5) stopped = t;
    });
    expect(stopped).toBeLessThan((2.5 * from) / 100 + 0.5); // "stops from 100 in 2.5 s"
    expect(e.vehicle.kmh).toBeLessThan(-25);
    expect(e.vehicle.kmh).toBeGreaterThan(-31);
  });

  it('steers the way it is asked; less sharply the faster it goes; stays on its wheels', () => {
    const w = level();
    const e = car(w);
    run(w, 1);
    // slowly, right: a tight turn clockwise (seen from above)
    const slow = turned(w, e, 3, () => e.vehicle.setInput(e.vehicle.kmh < 20 ? 0.6 : 0, 1, false));
    expect(slow).toBeLessThan(-60);
    // left, at speed
    const w2 = level();
    const fast = car(w2);
    run(w2, 1);
    run(w2, 10, () => fast.vehicle.setInput(1, 0, false));
    const speed = fast.vehicle.speed;
    let lowest = 1;
    const deg = turned(w2, fast, 2, () => { fast.vehicle.setInput(0.3, -1, false); lowest = Math.min(lowest, upright(fast)); });
    expect(deg).toBeGreaterThan(20);
    const radius = speed / THREE.MathUtils.degToRad(deg / 2); // m, at that speed
    expect(radius).toBeGreaterThan(8); // not the tight turn of a crawl
    expect(lowest).toBeGreaterThan(0.9);
  });

  it('drives dead straight at any stability, any drive — no wagging, no spinning out (it used to, flat out)', () => {
    for (const [stability, drive] of [[0, 'rear'], [0.5, 'all'], [1, 'rear'], [0.4, 'front']]) {
      const w = level();
      const e = car(w, { settings: { stability, drive } });
      run(w, 1);
      const deg = turned(w, e, 10, () => e.vehicle.setInput(1, 0, false));
      expect(Math.abs(deg), `${stability} ${drive}`).toBeLessThan(2);
      expect(e.vehicle.kmh, `${stability} ${drive}`).toBeGreaterThan(100);
    }
  });

  it('corners like a sporty car (about 1.2–1.5 G), leaning a little, never rolling over', () => {
    for (const stability of [0, 1]) {
      const w = level();
      const e = car(w, { settings: { stability } });
      run(w, 1);
      run(w, 5, () => e.vehicle.setInput(1, 0, false));
      let g = 0;
      let lean = 0;
      const last = e.rigidBody.velocity.clone();
      run(w, 2, () => {
        e.vehicle.setInput(1, 1, false);
        const a = e.rigidBody.velocity.clone().sub(last).multiplyScalar(60);
        a.y = 0;
        g = Math.max(g, a.length() / 9.81);
        last.copy(e.rigidBody.velocity);
        lean = Math.max(lean, THREE.MathUtils.radToDeg(Math.acos(Math.min(1, upright(e)))));
      });
      expect(g, `stability ${stability}`).toBeGreaterThan(1);
      expect(g, `stability ${stability}`).toBeLessThan(1.7);
      expect(lean, `stability ${stability}`).toBeLessThan(8);
    }
  });

  it('the handbrake in a turn lets the back slide out: a drift', () => {
    const slip = (handbrake) => {
      const w = level();
      const e = car(w);
      run(w, 1);
      run(w, 8, () => e.vehicle.setInput(1, 0, false));
      let most = 0;
      run(w, 0.8, () => {
        e.vehicle.setInput(1, 0.6, handbrake);
        const across = new THREE.Vector3(1, 0, 0).applyQuaternion(e.object3D.quaternion);
        most = Math.max(most, Math.abs(e.rigidBody.velocity.dot(across)));
      });
      return most;
    };
    expect(slip(true)).toBeGreaterThan(slip(false) * 1.5);
  });

  it('spun round and sliding backwards faster than reverse: holding reverse slows it to reverse speed', () => {
    const w = level();
    const e = car(w);
    run(w, 1);
    e.rigidBody.velocity.set(0, 0, -15); // 54 km/h backwards (its front is +z)
    run(w, 6, () => e.vehicle.setInput(-1, 0, false));
    expect(e.vehicle.kmh).toBeGreaterThan(-31);
    expect(e.vehicle.kmh).toBeLessThan(-25);
  });

  it('parked on a slope, it stays put', () => {
    const slope = new Entity(new THREE.Mesh(new THREE.BoxGeometry(40, 1, 40)));
    slope.object3D.rotation.x = THREE.MathUtils.degToRad(10);
    slope.rigidBody = new RigidBody({ type: 'static' });
    const w = new PhysicsWorld();
    w.register(slope);
    const e = car(w, { at: [0, 1.2, 0] });
    run(w, 2);
    const at = e.object3D.position.clone();
    run(w, 3);
    expect(e.object3D.position.distanceTo(at)).toBeLessThan(0.05);
    expect(e.vehicle.grounded).toBe(4);
  });

  it('off a ramp: flies, and lands on its wheels', () => {
    const ramp = new Entity(new THREE.Mesh(new THREE.BoxGeometry(6, 0.5, 8)));
    ramp.object3D.position.set(0, 0.6, 30);
    ramp.object3D.rotation.x = -THREE.MathUtils.degToRad(15); // rising towards +z
    ramp.rigidBody = new RigidBody({ type: 'static' });
    const w = level(ramp);
    const e = car(w);
    run(w, 1);
    let airborne = 0;
    run(w, 6, () => {
      e.vehicle.setInput(1, 0, false);
      if (e.vehicle.grounded === 0) airborne += 1 / 60;
    });
    run(w, 2, () => e.vehicle.setInput(0, 0, false));
    expect(airborne).toBeGreaterThan(0.3);
    expect(upright(e)).toBeGreaterThan(0.98);
    expect(e.vehicle.grounded).toBe(4);
  });

  it('over rough ground: on its wheels, moving on', () => {
    const g = new THREE.PlaneGeometry(30, 200, 30, 200).rotateX(-Math.PI / 2); // 30 wide, 200 long (z)
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, 0.25 * Math.sin(p.getX(i) * 0.8) * Math.cos(p.getZ(i) * 1.1) + 0.15 * Math.sin(p.getZ(i) * 2.1));
    g.computeVertexNormals();
    const ground = new Entity(new THREE.Mesh(g));
    ground.rigidBody = new RigidBody({ type: 'static', shape: 'mesh' });
    const w = new PhysicsWorld();
    w.register(ground);
    const model = carModel();
    const e = car(w, { at: [0, 1, -80], model });
    run(w, 1);
    let lowest = 1;
    run(w, 8, () => { e.vehicle.setInput(1, 0, false); lowest = Math.min(lowest, upright(e)); });
    expect(e.object3D.position.z).toBeGreaterThan(-20);
    expect(lowest).toBeGreaterThan(0.85);
  });
});

describe('its engine, as its sound hears it', () => {
  it('revs up through five gears, dropping at each change; idles when stopped', () => {
    const w = level();
    const e = car(w, { settings: { topSpeed: 160 } });
    const rig = e.vehicle;
    run(w, 1, () => rig.update(1 / 60));
    expect(rig.rpm).toBeLessThan(1100); // idling
    const gears = new Set();
    let drops = 0;
    let highest = 0;
    let last = rig.rpm;
    let lastGear = rig.gear;
    run(w, 30, () => {
      rig.setInput(1, 0, false);
      rig.update(1 / 60);
      gears.add(rig.gear);
      if (rig.gear > lastGear && rig.rpm < last + 1) drops++;
      highest = Math.max(highest, rig.rpm);
      last = rig.rpm;
      lastGear = rig.gear;
    });
    expect([...gears].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(drops).toBeGreaterThanOrEqual(3);
    expect(highest).toBeLessThanOrEqual(6800);
    expect(rig.load).toBeGreaterThan(0.9);
  });

  it('the hint and the buttons speak of a car: throttle, steering, handbrake', async () => {
    const { controlsHint } = await import('../src/controls.js');
    const hint = controlsHint(defaultControls(), { vehicle: true });
    expect(hint).toMatch(/W\/↑ throttle/);
    expect(hint).toMatch(/S\/↓ brake \/ reverse/);
    expect(hint).toMatch(/D\/→ steer right/);
    expect(hint).toMatch(/Space handbrake/);
    expect(controlsHint(defaultControls())).toMatch(/Space jump/);
  });
});

describe('its wheels, drawn', () => {
  it('spin with the speed, the front ones steer, and they ride the springs', () => {
    const w = level();
    const e = car(w);
    const rig = e.vehicle;
    const node = (name) => e.object3D.getObjectByName(name);
    run(w, 1);
    run(w, 1, () => rig.setInput(1, 1, false));
    rig.pose();
    // the front left tyre and its rim turned together, about the wheel's middle
    const tyre = node('Tire_FL');
    const rim = node('Rim_FL');
    expect(tyre.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.1);
    expect(tyre.quaternion.angleTo(rim.quaternion)).toBeLessThan(1e-6);
    // steered: its axle no longer across the car, by the steering angle
    const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(tyre.quaternion);
    const steered = Math.atan2(-axle.z, axle.x);
    expect(Math.abs(Math.abs(steered) - Math.abs(rig.steer))).toBeLessThan(0.05);
    // a back wheel spins but doesn't steer
    const rear = new THREE.Vector3(1, 0, 0).applyQuaternion(node('Wheel_RL').quaternion);
    expect(Math.abs(rear.z)).toBeLessThan(1e-6);
    // on the ground: its bottom at the floor
    e.object3D.updateMatrixWorld(true);
    const bottom = new THREE.Box3().setFromObject(node('Wheel_RL'), true).min.y; // (precise: a spinning wheel's rough box pokes out)
    expect(Math.abs(bottom)).toBeLessThan(0.06);
  });
});

describe('with the controls and the gameplay components', () => {
  function world() {
    const engine = {
      entities: [], variables: new VariableStore(), physics: new PhysicsWorld(), scene: new THREE.Scene(),
      input: {
        _down: new Set(),
        _pressed: new Set(),
        isDown(c) { return this._down.has(c); }, wasPressed(c) { return this._pressed.has(c); }, mouseDown() { return false; },
        mouseTapped() { return false; }, virtualDown() { return false; }, virtualPressed() { return false; }, mouseNDC: { x: 0, y: 0 },
        press(c) { this._pressed.add(c); },
      },
      camera: null, hero: null, poses: new Map(), time: 0,
      player: { target: null },
      cameraRig: { shake: vi.fn(), setFovBoost: vi.fn(), target: null, fallbackTarget: null },
      get playerEntity() { return this.player.target ?? this.hero; },
      playEntitySounds: vi.fn(), remove() {}, addBehavior() {}, removeBehavior() {},
    };
    engine.gameplay = new Gameplay(engine);
    engine.gameplay.controls.load(defaultControls());
    const floor = new Entity(new THREE.Mesh(new THREE.BoxGeometry(3000, 1, 3000)));
    floor.object3D.position.y = -0.5;
    floor.rigidBody = new RigidBody({ type: 'static' });
    engine.physics.register(floor);
    engine.entities.push(floor);
    const step = (seconds) => {
      for (let t = 0; t < seconds; t += 1 / 60) {
        engine.time += 1 / 60;
        engine.scene.updateMatrixWorld(true);
        engine.physics.step(1 / 60);
        engine.gameplay.update(1 / 60, engine.time);
        engine.input._pressed.clear();
      }
    };
    return { engine, step };
  }
  function addCar(engine, props = {}, at = [0, 0.3, 0]) {
    const model = carModel();
    model.position.set(...at);
    const e = new Entity(model);
    engine.entities.push(e);
    engine.scene.add(model);
    engine.gameplay.components.add(e, 'vehicle', props);
    return e;
  }

  it('the player\'s car: W drives, D steers right, S brakes then reverses, Space is the handbrake', () => {
    const { engine, step } = world();
    const e = addCar(engine);
    engine.hero = e;
    engine.gameplay.start();
    step(1);
    expect(e.vehicle).toBeTruthy();
    expect(e.rigidBody).toMatchObject({ type: 'dynamic', tumbles: true, mass: 1200 });
    engine.input._down.add('KeyW');
    step(3);
    expect(e.vehicle.kmh).toBeGreaterThan(40);
    engine.input._down.add('KeyD');
    step(0.5);
    expect(e.vehicle.steer).toBeGreaterThan(0.1); // right
    engine.input._down.add('Space');
    step(0.1);
    expect(e.vehicle.input.handbrake).toBe(true);
    engine.input._down.clear();
    engine.input._down.add('KeyS');
    step(8);
    expect(e.vehicle.kmh).toBeLessThan(-10); // stopped, then backing up
  });

  it('left on its roof, it is set back on its wheels (unless told not to)', () => {
    for (const selfRight of [true, false]) {
      const { engine, step } = world();
      const e = addCar(engine, { selfRight }, [0, 3, 0]);
      e.object3D.rotation.z = Math.PI; // upside down
      engine.gameplay.start();
      step(4);
      expect(upright(e) > 0.95, `selfRight ${selfRight}`).toBe(selfRight);
    }
  });

  it('walk up, press E: in and driving; E again (slowed down): out beside it', () => {
    const { engine, step } = world();
    const e = addCar(engine);
    const walker = new Entity(new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.8, 0.8)));
    walker.object3D.name = 'Hero';
    walker.object3D.position.set(8, 0.9, 0); // too far to get in
    walker.rigidBody = new RigidBody({ type: 'dynamic', shape: 'capsule', mass: 70 });
    engine.physics.register(walker);
    engine.entities.push(walker);
    engine.scene.add(walker.object3D);
    engine.hero = walker;
    engine.cameraRig.fallbackTarget = walker.object3D;
    engine.gameplay.start();
    step(0.5);
    engine.input.press('KeyE');
    step(0.1);
    expect(engine.playerEntity).toBe(walker); // too far away
    walker.object3D.position.set(2.2, 0.9, 0);
    step(0.3);
    expect(engine.gameplay.controls.prompt).toMatchObject({ key: 'E', text: 'Drive' });
    engine.input.press('KeyE');
    step(0.1);
    expect(engine.playerEntity).toBe(e); // in: the car is the player
    expect(e.vehicle.driver).toBe(walker);
    expect(walker.object3D.visible).toBe(false);
    expect(engine.physics.bodyFor(walker)).toBeNull(); // out of the way while inside
    expect(engine.cameraRig.fallbackTarget).toBe(e.object3D); // the camera follows the car
    // the keys drive it now
    engine.input._down.add('KeyW');
    step(3);
    expect(e.vehicle.kmh).toBeGreaterThan(40);
    engine.input.press('KeyE'); // too fast to get out
    step(0.1);
    expect(e.vehicle.driver).toBe(walker);
    engine.input._down.clear();
    engine.input._down.add('KeyS');
    for (let i = 0; i < 80 && e.vehicle.kmh > 3; i++) step(0.1);
    engine.input._down.clear();
    engine.input.press('KeyE');
    step(0.1);
    expect(engine.playerEntity).toBe(walker); // out again
    expect(walker.object3D.visible).toBe(true);
    expect(engine.physics.bodyFor(walker)).toBe(walker.rigidBody);
    const gap = walker.object3D.position.distanceTo(e.object3D.position);
    expect(gap).toBeGreaterThan(1);
    expect(gap).toBeLessThan(3.5); // beside its door
    expect(e.vehicle.input.handbrake).toBe(true); // left parked
    expect(engine.cameraRig.fallbackTarget).toBe(walker.object3D);
  });

  it("a hard crash thumps, shakes the view and runs 'I crash (harder than 20 km/h)'; a nudge doesn't", () => {
    const { engine, step } = world();
    const wall = new Entity(new THREE.Mesh(new THREE.BoxGeometry(20, 3, 1)));
    wall.object3D.position.set(0, 1.5, 40);
    wall.object3D.name = 'Wall';
    wall.rigidBody = new RigidBody({ type: 'static' });
    engine.physics.register(wall);
    engine.entities.push(wall);
    const e = addCar(engine);
    engine.hero = e;
    engine.gameplay.rules.add(e, {
      when: { type: 'crash', who: 'any', harder: 20 }, if: [], do: [{ type: 'changeVariable', name: 'crashes', by: 1 }],
    });
    engine.gameplay.start();
    engine.input._down.add('KeyW');
    for (let i = 0; i < 100 && e.object3D.position.z < 36; i++) step(0.1);
    const speed = e.vehicle.kmh;
    step(1.5);
    engine.input._down.clear();
    expect(speed).toBeGreaterThan(40);
    expect(engine.variables.get('crashes')).toBe(1);
    expect(engine.cameraRig.shake).toHaveBeenCalled();
    // a nudge at a crawl: nothing
    engine.variables.set('crashes', 0);
    engine.cameraRig.shake.mockClear();
    step(2);
    engine.input._down.add('KeyW');
    step(1);
    engine.input._down.clear();
    expect(engine.variables.get('crashes') ?? 0).toBe(0);
  });

  it('drifting leaves skid marks, and the view widens with the speed', () => {
    const { engine, step } = world();
    const e = addCar(engine);
    engine.hero = e;
    engine.gameplay.start();
    engine.input._down.add('KeyW');
    step(6);
    const widen = engine.cameraRig.setFovBoost.mock.calls.at(-1)[0];
    expect(widen).toBeGreaterThan(2);
    expect(widen).toBeLessThanOrEqual(10);
    expect(e.vehicle.skids.count).toBe(0); // driving straight: no marks
    engine.input._down.add('KeyD');
    engine.input._down.add('Space');
    step(1.2);
    expect(e.vehicle.skids.count).toBeGreaterThan(5);
    expect(engine.scene.getObjectByName('__skidMarks')).toBeTruthy();
    // and they go when the car does
    engine.gameplay.components.clearEntity(e);
    expect(engine.scene.getObjectByName('__skidMarks')).toBeUndefined();
  });

  it('a Patrol drives a car round its waypoints', () => {
    const { engine, step } = world();
    const points = [[30, 0], [30, 30], [0, 30]].map(([x, z], i) => {
      const p = new Entity(new THREE.Object3D());
      p.object3D.name = `Point ${i + 1}`;
      p.object3D.position.set(x, 0, z);
      p.groups = ['Track'];
      engine.entities.push(p);
      engine.scene.add(p.object3D);
      return p;
    });
    const e = addCar(engine);
    engine.gameplay.components.add(e, 'patrol', { points: 'Track', speed: 12, wait: 0, avoid: false });
    engine.gameplay.start();
    const visited = [];
    for (let t = 0; t < 30; t += 0.1) {
      step(0.1);
      for (const p of points) {
        const d = Math.hypot(p.object3D.position.x - e.object3D.position.x, p.object3D.position.z - e.object3D.position.z);
        if (d < 5 && visited.at(-1) !== p.object3D.name) visited.push(p.object3D.name);
      }
    }
    expect(visited.slice(0, 4)).toEqual(['Point 1', 'Point 2', 'Point 3', 'Point 1']);
    expect(upright(e)).toBeGreaterThan(0.95);
  });
});
