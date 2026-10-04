// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { world } from './helpers/world.js';

// Continuous collision: fast things don't go through thin ones (physics.js _sweep).

const count = (engine, e, name, when) => engine.gameplay.rules.add(e, { when, if: [], do: [{ type: 'changeVariable', name, by: 1 }] });

function range({ wall = {}, bullet = {}, speed = 150 } = {}) {
  const { engine, add, step } = world();
  // a wall 10 cm thick, 10 m ahead; a bullet 20 cm across at 150 m/s — 2.5 m a slice,
  // starting where its slices land either side of the wall, never in it
  const w = add('Wall', { at: [10, 0, 0], size: [0.1, 4, 4], body: { type: 'static', ...wall } });
  const b = add('Bullet', { at: [0.3, 0, 0], size: [0.2, 0.2, 0.2], body: { type: 'dynamic', gravity: 0, friction: 0, ...bullet } });
  count(engine, w, 'hits', { type: 'collision', who: 'any' });
  engine.gameplay.start();
  b.rigidBody.velocity.set(speed, 0, 0);
  return { engine, add, step, w, b };
}

describe('fast things don\'t go through thin ones (CCD)', () => {
  it('a bullet at 150 m/s stops at a 10 cm wall — and hits it', () => {
    const { engine, step, b } = range();
    step(0.5);
    expect(b.object3D.position.x).toBeLessThan(10);
    expect(b.object3D.position.x).toBeGreaterThan(9.5);
    expect(engine.variables.get('hits')).toBeGreaterThanOrEqual(1);
  });

  it('...but not a wall it passes through', () => {
    const { engine, step, b } = range({ bullet: { ignores: ['Wall'] } });
    step(0.5);
    expect(b.object3D.position.x).toBeGreaterThan(30);
    expect(engine.variables.get('hits')).toBe(0);
  });

  it('...nor a wall of triangles (a mesh)', () => {
    const { step, b } = range({ wall: { shape: 'mesh' } });
    step(0.5);
    expect(b.object3D.position.x).toBeLessThan(10);
  });

  it('a thin enemy standing still is hit, not flown through', () => {
    const { engine, add, step } = world();
    const enemy = add('Enemy', { at: [8, 0, 0], size: [0.15, 2, 1], body: { type: 'dynamic', gravity: 0 } });
    const bullet = add('Bullet', { size: [0.2, 0.2, 0.2], body: { type: 'dynamic', gravity: 0, friction: 0 } });
    count(engine, enemy, 'shot', { type: 'collision', who: 'Bullet' });
    engine.gameplay.start();
    bullet.rigidBody.velocity.set(200, 0, 0);
    step(0.3);
    expect(engine.variables.get('shot')).toBeGreaterThanOrEqual(1);
  });

  it('a very fast fall lands on a 5 cm floor', () => {
    const { engine, add, step } = world();
    add('Floor', { at: [0, -0.025, 0], size: [20, 0.05, 20], body: { type: 'static' } });
    const crate = add('Crate', { at: [0, 30, 0], body: { type: 'dynamic' } });
    engine.gameplay.start();
    crate.rigidBody.velocity.y = -120; // 2 m a slice
    step(1);
    expect(crate.object3D.position.y).toBeGreaterThan(0.3);
    expect(crate.object3D.position.y).toBeLessThan(0.7);
  });

  it('a finish line (a thin trigger) crossed in one slice is still crossed — entered, then left', () => {
    const { engine, add, step } = world();
    const line = add('Finish', { at: [10, 0, 0], size: [0.05, 4, 4], body: { type: 'static', isTrigger: true } });
    const car = add('Car', { at: [0.3, 0, 0], size: [0.3, 0.3, 0.3], body: { type: 'dynamic', gravity: 0, friction: 0 } });
    count(engine, line, 'entered', { type: 'triggerEnter', who: 'any' });
    count(engine, line, 'left', { type: 'triggerExit', who: 'any' });
    engine.gameplay.start();
    car.rigidBody.velocity.set(120, 0, 0);
    step(0.4);
    expect(car.object3D.position.x).toBeGreaterThan(20); // through: it blocks nothing
    expect(engine.variables.get('entered')).toBe(1);
    expect(engine.variables.get('left')).toBe(1);
  });

  it('slow things are left to their contacts: resting and walking are as they were', () => {
    const { engine, add, step } = world();
    add('Floor', { at: [0, -0.5, 0], size: [40, 1, 40], body: { type: 'static' } });
    const box = add('Box', { at: [0, 0.5, 0], body: { type: 'dynamic', friction: 0.1 } });
    engine.gameplay.start();
    step(0.5);
    const y = box.object3D.position.y;
    box.rigidBody.velocity.x = 6;
    step(0.5);
    expect(box.object3D.position.y).toBeCloseTo(y, 2);
    expect(box.object3D.position.x).toBeGreaterThan(1.5);
  });
});
