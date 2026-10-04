import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { BehaviorRunner, compileBehavior } from '../src/behavior.js';
import { Entity } from '../src/entity.js';
import { RigidBody } from '../src/physics.js';

const makeEntity = (name = 'Thing') => {
  const e = new Entity(new THREE.Object3D());
  e.object3D.name = name;
  return e;
};

describe('BehaviorRunner', () => {
  it('runs a script and exposes a live delta', () => {
    // REGRESSION: the scope used getter-only `delta`/`time`/`keys`, so the
    // per-frame write threw TypeError in strict mode and no script ever ran.
    const runner = new BehaviorRunner();
    const entity = makeEntity();
    runner.add(entity, 'entity.position.x += delta * 10');

    expect(runner.run(0.1, 0)).toBe(1);
    expect(entity.object3D.position.x).toBeCloseTo(1, 6);

    runner.run(0.1, 0.1);
    expect(entity.object3D.position.x).toBeCloseTo(2, 6);
  });

  it('exposes entity, time, body and keys to the script', () => {
    const runner = new BehaviorRunner();
    const entity = makeEntity('Hero');
    entity.rigidBody = new RigidBody({ type: 'dynamic' });
    // `engine` is in scope, so the script can report back through it
    const seen = {};
    runner.add(entity, `
      engine.name = entity.name;
      engine.time = time;
      engine.jump = keys.Space === true;
      body.velocity.y = 5;
    `, { engine: seen });

    runner.run(0.016, 3.5, { Space: true });

    expect(seen.name).toBe('Hero');
    expect(seen.time).toBeCloseTo(3.5, 6);
    expect(seen.jump).toBe(true);
    expect(entity.rigidBody.velocity.y).toBe(5);
  });

  it('picks up a rigid body added after the script was compiled', () => {
    const runner = new BehaviorRunner();
    const entity = makeEntity();
    runner.add(entity, 'if (body) body.velocity.x = 3');

    runner.run(0.016, 0);            // no body yet — must not throw
    expect(runner.get(entity).failed).toBe(false);

    entity.rigidBody = new RigidBody({ type: 'dynamic' });
    runner.run(0.016, 0);
    expect(entity.rigidBody.velocity.x).toBe(3);
  });

  it('calls fire() through to the host', () => {
    const runner = new BehaviorRunner();
    const fire = vi.fn();
    runner.add(makeEntity(), 'fire()', { fire });
    runner.run(0.016, 0);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('reads keys through a proxy-style key map', () => {
    const runner = new BehaviorRunner();
    const entity = makeEntity();
    runner.add(entity, 'if (keys.KeyW) entity.position.z -= 1');

    runner.run(0.016, 0, { KeyW: false });
    expect(entity.object3D.position.z).toBe(0);

    runner.run(0.016, 0, { KeyW: true });
    expect(entity.object3D.position.z).toBe(-1);
  });

  it('disables a throwing script after one report instead of flooding', () => {
    const runner = new BehaviorRunner();
    const entity = makeEntity('Broken');
    runner.add(entity, 'nope.boom()');
    const onError = vi.fn();

    expect(runner.run(0.016, 0, {}, onError)).toBe(0);
    expect(runner.run(0.016, 0, {}, onError)).toBe(0);
    expect(runner.run(0.016, 0, {}, onError)).toBe(0);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(runner.get(entity).failed).toBe(true);
  });

  it('revives a failed script when it is re-applied', () => {
    const runner = new BehaviorRunner();
    const entity = makeEntity();
    runner.add(entity, 'nope.boom()');
    runner.run(0.016, 0, {}, () => {});
    expect(runner.get(entity).failed).toBe(true);

    runner.add(entity, 'entity.position.y = 2');
    expect(runner.run(0.016, 0)).toBe(1);
    expect(entity.object3D.position.y).toBe(2);
  });

  it('replaces rather than stacks scripts for the same entity', () => {
    const runner = new BehaviorRunner();
    const entity = makeEntity();
    runner.add(entity, 'entity.position.x += 1');
    runner.add(entity, 'entity.position.x += 1');
    runner.run(0.016, 0);
    expect(runner.items).toHaveLength(1);
    expect(entity.object3D.position.x).toBe(1);
  });

  it('ignores empty or whitespace-only code', () => {
    const runner = new BehaviorRunner();
    expect(runner.add(makeEntity(), '')).toBeNull();
    expect(runner.add(makeEntity(), '   \n  ')).toBeNull();
    expect(runner.items).toHaveLength(0);
  });

  it('reports a syntax error at compile time rather than every frame', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = new BehaviorRunner();
    expect(runner.add(makeEntity(), 'this is not javascript {{{')).toBeNull();
    expect(runner.items).toHaveLength(0);
    spy.mockRestore();
  });

  it('compiles a bare body into a callable function', () => {
    const fn = compileBehavior('entity.position.x = delta');
    const scope = {
      entity: { position: { x: 0 } }, engine: null, body: null,
      keys: {}, delta: 0, time: 0, fire() {}, log() {},
    };
    fn.call(scope, 0.25, 0);
    expect(scope.entity.position.x).toBe(0.25);
  });
});
