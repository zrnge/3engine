// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Entity } from '../src/entity.js';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';
import { defaultControls } from '../src/controls.js';

/** Keys held by hand, as Input reads them. */
function keys() {
  return {
    _down: new Set(), _pressed: new Set(),
    isDown(c) { return this._down.has(c); },
    wasPressed(c) { return this._pressed.has(c); },
    value(c) { return this._down.has(c) ? 1 : 0; },
    mouseDown() { return false; }, mouseTapped() { return false; }, mouseClicked() { return false; },
    virtualDown() { return false; }, virtualPressed() { return false; },
    press(c) { this._down.add(c); this._pressed.add(c); },
    release(c) { this._down.delete(c); },
    endFrame() { this._pressed.clear(); },
  };
}

/** A floor 20 m long (x from -10 to 10, top at 0) and a hero standing on it at `x`. */
function world({ feel = null, x = 0, y = 0.9 } = {}) {
  const engine = {
    entities: [], variables: new VariableStore(), physics: new PhysicsWorld(), input: keys(),
    scene: new THREE.Scene(), camera: null, hero: null, time: 0,
    get playerEntity() { return this.hero; },
    playEntitySounds() {}, remove() {}, addBehavior() {}, removeBehavior() {},
  };
  engine.gameplay = new Gameplay(engine);
  engine.gameplay.controls.load(defaultControls());
  const add = (mesh, body, at) => {
    mesh.position.set(...at);
    const e = new Entity(mesh);
    e.rigidBody = new RigidBody(body);
    engine.entities.push(e);
    engine.scene.add(mesh);
    engine.physics.register(e);
    return e;
  };
  add(new THREE.Mesh(new THREE.BoxGeometry(20, 1, 4)), { type: 'static' }, [0, -0.5, 0]);
  engine.hero = add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.8, 0.8)),
    { type: 'dynamic', shape: 'capsule', friction: 0, mass: 70 }, [x, y, 0]);
  if (feel) engine.gameplay.components.add(engine.hero, 'movement', feel);
  engine.gameplay.start();
  const step = (seconds = 1 / 60, each = null) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
      each?.();
      engine.time += 1 / 60;
      engine.scene.updateMatrixWorld(true);
      engine.physics.step(1 / 60);
      engine.gameplay.update(1 / 60, engine.time);
      engine.input.endFrame();
    }
  };
  step(0.5); // standing
  return { engine, hero: engine.hero, input: engine.input, step, body: engine.hero.rigidBody };
}

const speedX = (body) => Math.abs(body.velocity.x);

describe('Movement feel — how a character moves, set per character', () => {
  it('without it, it moves as always: full speed in about a sixth of a second, and stops quickly', () => {
    const { input, step, body } = world({ x: -8 });
    input.press('KeyD');
    step(0.25);
    expect(speedX(body)).toBeCloseTo(8, 0);
    input.release('KeyD');
    step(0.4);
    expect(speedX(body)).toBeLessThan(0.1);
  });

  it('"Speeds up in" and "Stops in" set how quickly it gets going and stops', () => {
    const slow = world({ x: -8, feel: { accelTime: 1, brakeTime: 1 } });
    slow.input.press('KeyD');
    slow.step(0.5);
    expect(speedX(slow.body)).toBeGreaterThan(3);
    expect(speedX(slow.body)).toBeLessThan(5);
    slow.input.release('KeyD');
    slow.step(0.25);
    expect(speedX(slow.body)).toBeGreaterThan(1); // still sliding

    const snappy = world({ x: -8, feel: { accelTime: 0, brakeTime: 0 } });
    snappy.input.press('KeyD');
    snappy.step(2 / 60);
    expect(speedX(snappy.body)).toBeCloseTo(8, 1);
    snappy.input.release('KeyD');
    snappy.step(1 / 60);
    expect(speedX(snappy.body)).toBe(0);
  });

  it('coyote time: a jump just after running off the edge still jumps; a late one does not', () => {
    const run = (late) => {
      const w = world({ x: 9.2, feel: { coyote: 0.15 } });
      w.body.velocity.x = 3;
      let off = null;
      w.step(1, () => {
        w.body.velocity.x = 3;
        if (off === null && !w.body.grounded) off = w.engine.time;
        if (off !== null && w.engine.time - off >= late && !w.input.isDown('Space')) w.input.press('Space');
      });
      return w.body.velocity.y;
    };
    // jumped: on the way up (or at least falling much slower than a plain fall)
    expect(run(0.05)).toBeGreaterThan(run(0.4) + 5);
  });

  it('a jump pressed just before landing happens as it lands', () => {
    const w = world({ feel: { buffer: 0.2 } });
    w.body.velocity.y = 6; // in the air
    w.step(1 / 60);
    let pressedAt = null;
    let jumped = false;
    w.step(1.5, () => {
      const falling = w.body.velocity.y < -5 && w.hero.object3D.position.y < 1.3;
      if (pressedAt === null && falling) { w.input.press('Space'); pressedAt = w.engine.time; }
      if (pressedAt !== null && w.body.velocity.y > 5) jumped = true;
    });
    expect(pressedAt).not.toBeNull();
    expect(jumped).toBe(true);
  });

  it('"Jumps in the air": one more jump in the air, then no more until it lands', () => {
    const w = world({ feel: { airJumps: 1 } });
    w.input.press('Space');
    w.step(0.3);
    w.input.release('Space');
    const before = w.body.velocity.y;
    w.input.press('Space');
    w.step(1 / 60);
    expect(w.body.velocity.y).toBeGreaterThan(before + 3); // the second jump
    w.input.release('Space');
    w.step(0.1);
    const again = w.body.velocity.y;
    w.input.press('Space');
    w.step(1 / 60);
    expect(w.body.velocity.y).toBeLessThan(again); // none left: only falling
  });

  it('letting go early makes a lower jump', () => {
    const apex = (holdFor) => {
      const w = world({ feel: { shortHop: true } });
      let top = 0;
      w.input.press('Space');
      w.step(1.2, () => {
        if (w.engine.time > 0.5 + holdFor) w.input.release('Space');
        top = Math.max(top, w.hero.object3D.position.y);
      });
      return top;
    };
    expect(apex(0.05)).toBeLessThan(apex(1) - 0.5);
  });

  it('with no steering in the air, a jump keeps its course', () => {
    const w = world({ x: -5, feel: { airControl: 0 } });
    w.input.press('KeyD');
    w.step(0.3);
    const vx = w.body.velocity.x;
    w.input.press('Space');
    w.step(2 / 60);
    w.input.release('KeyD');
    w.input.press('KeyA'); // steer back: it can't
    w.step(0.2);
    expect(w.body.velocity.x).toBeCloseTo(vx, 3);
  });

  it('"Fastest fall" caps the speed of a fall', () => {
    const w = world({ feel: { maxFall: 10 } });
    w.hero.object3D.position.y = 40;
    w.step(1.5);
    expect(w.body.velocity.y).toBeGreaterThanOrEqual(-10.01);
  });
});
