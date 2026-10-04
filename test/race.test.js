// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { Entity } from '../src/entity.js';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';
import { defaultControls } from '../src/controls.js';
import { ordinal, formatTime } from '../src/race.js';

/** A car: a body and four named wheels, front +Z. */
function carModel() {
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 4));
  body.position.y = 0.75;
  root.add(body);
  for (const [name, x, z] of [['Wheel_FL', 0.85, 1.3], ['Wheel_FR', -0.85, 1.3], ['Wheel_RL', 0.85, -1.3], ['Wheel_RR', -0.85, -1.3]]) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 12).rotateZ(Math.PI / 2));
    t.name = name;
    t.position.set(x, 0.35, z);
    root.add(t);
  }
  return root;
}

/**
 * A square track, 70 m a side: the start / finish gate at the origin (cars start
 * there facing +z), then Checkpoint 1 (0, 70), 2 (70, 70), 3 (70, 0). Gates are
 * plain shapes, no bodies: cars drive through them.
 */
function track({ laps = 2, countdown = 3, cars = 2, player = false, props = {} } = {}) {
  const engine = {
    entities: [], variables: new VariableStore(), physics: new PhysicsWorld(), scene: new THREE.Scene(),
    input: {
      _down: new Set(), _pressed: new Set(),
      isDown(c) { return this._down.has(c); }, wasPressed(c) { return this._pressed.has(c); }, mouseDown() { return false; },
      mouseTapped() { return false; }, virtualDown() { return false; }, virtualPressed() { return false; }, mouseNDC: { x: 0, y: 0 },
    },
    camera: null, hero: null, poses: new Map(), time: 0, player: { target: null },
    cameraRig: { shake: vi.fn(), setFovBoost: vi.fn(), target: null, fallbackTarget: null },
    onMessage: vi.fn(),
    get playerEntity() { return this.player.target ?? this.hero; },
    playEntitySounds: vi.fn(), remove() {}, addBehavior() {}, removeBehavior() {},
  };
  engine.gameplay = new Gameplay(engine);
  engine.gameplay.controls.load(defaultControls());
  const put = (object, name) => {
    object.name = name;
    const e = new Entity(object);
    engine.entities.push(e);
    engine.scene.add(object);
    return e;
  };
  const floor = put(new THREE.Mesh(new THREE.BoxGeometry(400, 1, 400)), 'Floor');
  floor.object3D.position.set(35, -0.5, 35);
  floor.rigidBody = new RigidBody({ type: 'static' });
  engine.physics.register(floor);
  const gate = (name, x, z, across) => {
    const g = put(new THREE.Mesh(new THREE.BoxGeometry(across === 'x' ? 16 : 1, 3, across === 'x' ? 1 : 16)), name);
    g.object3D.position.set(x, 1.5, z);
    return g;
  };
  const finish = gate('Start line', 0, 0, 'x');
  const checkpoints = [gate('Checkpoint 1', 0, 70, 'x'), gate('Checkpoint 2', 70, 70, 'z'), gate('Checkpoint 3', 70, 0, 'z')];
  for (const c of checkpoints) c.groups = ['Checkpoints'];
  const racers = [];
  for (let i = 0; i < cars; i++) {
    const m = carModel();
    m.position.set(-3 + i * 3.5, 0.3, -3);
    const car = put(m, `Car ${i + 1}`);
    engine.gameplay.components.add(car, 'vehicle', {});
    racers.push(car);
  }
  if (player) engine.hero = racers[0];
  engine.gameplay.components.add(finish, 'race', { laps, countdown, ...props });
  engine.gameplay.start();
  const step = (seconds) => {
    for (let t = 0; t < seconds; t += 1 / 60) {
      engine.time += 1 / 60;
      engine.scene.updateMatrixWorld(true);
      engine.physics.step(1 / 60);
      engine.gameplay.update(1 / 60, engine.time);
      engine.input._pressed.clear();
    }
  };
  const race = () => engine.gameplay.components.listFor(finish)[0].state.race;
  return { engine, step, racers, finish, checkpoints, race };
}

describe('the race: its words', () => {
  it('places and times', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
    expect(formatTime(83.44)).toBe('1:23.4');
    expect(formatTime(7.05)).toBe('0:07.0'); // (a tenth down, never up past the clock)
    expect(formatTime(0)).toBe('0:00.0');
  });
});

describe('a race', () => {
  it('3, 2, 1, GO!: every car held on the line until GO', () => {
    const { engine, step, racers } = track({ cars: 2 });
    const start = racers.map((c) => c.object3D.position.clone());
    step(2.9);
    const along = (c, i) => Math.hypot(c.object3D.position.x - start[i].x, c.object3D.position.z - start[i].z);
    racers.forEach((c, i) => expect(along(c, i)).toBeLessThan(0.1)); // (only settled onto its springs)
    const said = engine.onMessage.mock.calls.map(([text]) => text);
    expect(said).toEqual(['3', '2', '1']);
    step(2);
    expect(engine.onMessage.mock.calls.map(([t]) => t)).toContain('GO!');
    racers.forEach((c, i) => expect(c.object3D.position.distanceTo(start[i])).toBeGreaterThan(3)); // away they go
  });

  it('the other cars drive the checkpoints round, lap after lap, and finish — never stuck for good', () => {
    const { step, racers, race } = track({ cars: 2, laps: 2, countdown: 0 });
    step(1 / 60);
    let resets = 0;
    const reset = race().resetRacer.bind(race());
    race().resetRacer = (r) => { resets++; reset(r); };
    let t = 0;
    while (race().results.length < 2 && t < 120) { step(1); t++; }
    expect(resets).toBe(0); // driven cleanly round: never stuck, never put back
    const r = race();
    expect(r.results).toHaveLength(2); // both finished
    for (const car of racers) {
      const me = r.racers.find((x) => x.entity === car);
      expect(me.lap).toBe(2);
      expect(me.passed).toBe(8); // 4 checkpoints (the line one of them) × 2 laps
      expect(me.bestLap).toBeGreaterThan(5);
    }
    expect(t).toBeLessThan(90); // two laps of 280 m in well under a minute and a half
  });

  it("the player's race: checkpoints in order — a skipped one doesn't count — laps, and the variables the HUD shows", () => {
    const { engine, step, racers, checkpoints, finish, race } = track({ cars: 1, player: true, laps: 2, countdown: 0 });
    const car = racers[0];
    const teleport = (obj) => {
      const p = obj.object3D.position;
      car.object3D.position.set(p.x, 0.3, p.z);
      car.rigidBody.velocity.set(0, 0, 0);
      step(0.2);
    };
    step(0.5);
    expect(engine.variables.get('lap')).toBe(1);
    expect(engine.variables.get('position')).toBe(1);
    teleport(checkpoints[1]); // skipped Checkpoint 1: nothing
    expect(race().player.passed).toBe(0);
    for (const c of checkpoints) teleport(c);
    teleport(finish);
    expect(race().player.lap).toBe(1);
    expect(engine.variables.get('lap')).toBe(2);
    expect(engine.onMessage.mock.calls.map(([t]) => t).some((t) => /Final lap!/.test(t))).toBe(true);
    expect(engine.variables.get('raceTime')).toBeGreaterThan(1);
    for (const c of checkpoints) teleport(c);
    teleport(finish);
    // finished first (the only one): won
    expect(engine.gameplay.outcome).toMatchObject({ result: 'win' });
    expect(engine.gameplay.outcome.message).toMatch(/You finished 1st! 0:\d\d\.\d/);
    expect(engine.variables.get('bestLap')).toBeGreaterThan(0);
  });

  it('beaten to the line by another car: finished 2nd — lost (top 1 wins)', () => {
    const { engine, step, racers, race } = track({ cars: 2, player: true, laps: 1, countdown: 0 });
    const player = racers[0];
    let t = 0;
    while (race().results.length < 1 && t < 90) {
      player.vehicle.setInput(0, 0, true); // the player sits still…
      step(0.5);
      t += 0.5;
    }
    expect(race().results[0].entity).toBe(racers[1]); // …the other car wins
    expect(engine.variables.get('position')).toBe(2);
    // the player then goes round (in a hurry: teleporting)
    for (const name of ['Checkpoint 1', 'Checkpoint 2', 'Checkpoint 3', 'Start line']) {
      const p = engine.entities.find((e) => e.object3D.name === name).object3D.position;
      player.object3D.position.set(p.x, 0.3, p.z);
      step(0.2);
    }
    expect(engine.gameplay.outcome).toMatchObject({ result: 'lose' });
    expect(engine.gameplay.outcome.message).toMatch(/You finished 2nd!/);
  });

  it('positions go by laps, checkpoints and the way to the next', () => {
    const { step, racers, race } = track({ cars: 2, countdown: 0 });
    step(0.1);
    const r = race();
    const [a, b] = r.racers;
    racers[0].object3D.position.set(0, 0.3, 50); // most of the way to Checkpoint 1
    racers[1].object3D.position.set(0, 0.3, 20);
    expect(r.positions().get(a)).toBe(1);
    expect(r.positions().get(b)).toBe(2);
    b.passed = 1; // one checkpoint further on
    b.last = 1;
    b.next = 2;
    expect(r.positions().get(b)).toBe(1);
  });

  it('R puts the player back at its last checkpoint, facing the next, standing still', () => {
    const { engine, step, racers, race } = track({ cars: 1, player: true, countdown: 0 });
    const car = racers[0];
    step(0.5);
    const cp1 = engine.entities.find((e) => e.object3D.name === 'Checkpoint 1').object3D.position;
    car.object3D.position.set(cp1.x, 0.3, cp1.z);
    step(0.2);
    expect(race().player.last).toBe(1);
    car.object3D.position.set(30, 5, 30); // off in a field, upside down
    car.object3D.rotation.set(Math.PI, 0, 0);
    engine.input._pressed.add('KeyR');
    step(1 / 60);
    const p = car.object3D.position;
    expect(Math.hypot(p.x - cp1.x, p.z - cp1.z)).toBeLessThan(0.5);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.object3D.quaternion);
    expect(fwd.x).toBeGreaterThan(0.99); // Checkpoint 2 is along +x from Checkpoint 1
    expect(car.rigidBody.velocity.length()).toBeLessThan(1);
  });

  it("the player's car is a speedometer: its speed in the variable speed", () => {
    const { engine, step, racers } = track({ cars: 1, player: true, countdown: 0 });
    engine.input._down.add('KeyW');
    step(3);
    expect(engine.variables.get('speed')).toBe(Math.round(Math.abs(racers[0].vehicle.kmh)));
    expect(engine.variables.get('speed')).toBeGreaterThan(30);
  });

  it('an arrow floats over the next checkpoint, and goes with the race', () => {
    const { engine, step, finish } = track({ cars: 1, player: true, countdown: 0 });
    step(0.5);
    const arrow = engine.scene.getObjectByName('__raceArrow');
    expect(arrow.visible).toBe(true);
    expect(Math.hypot(arrow.position.x - 0, arrow.position.z - 70)).toBeLessThan(0.5); // over Checkpoint 1
    engine.gameplay.components.clearEntity(finish);
    expect(engine.scene.getObjectByName('__raceArrow')).toBeUndefined();
  });
});
