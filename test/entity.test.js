import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Entity, aabbCollides, getWorldHalfSize } from '../src/entity.js';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { BehaviorRunner } from '../src/behavior.js';

/**
 * A stand-in for Engine with the parts entity code touches. The real Engine
 * needs a WebGL context, which we have no business creating in a unit test.
 */
function fakeEngine() {
  const scene = new THREE.Scene();
  const physics = new PhysicsWorld();
  const behaviors = new BehaviorRunner();
  const entities = [];
  return {
    scene, physics, entities, behaviors,
    add(entity) {
      if (!entities.includes(entity)) entities.push(entity);
      if (entity.parent) entity.parent.object3D.add(entity.object3D);
      else scene.add(entity.object3D);
      physics.register(entity);
      return entity;
    },
    remove(entity) {
      const i = entities.indexOf(entity);
      if (i !== -1) entities.splice(i, 1);
      physics.unregister(entity);
      behaviors.remove(entity);
      scene.remove(entity.object3D);
    },
  };
}

const named = (name) => {
  const e = new Entity(new THREE.Object3D());
  e.object3D.name = name;
  return e;
};

describe('Entity.setParent', () => {
  it('keeps the child registered with the engine', () => {
    // REGRESSION: setParent used to call engine.remove(), so a reparented object
    // silently stopped updating, lost its rigid body and lost its script.
    const engine = fakeEngine();
    const parent = engine.add(named('Parent'));
    const child = engine.add(named('Child'));
    child.rigidBody = new RigidBody({ type: 'dynamic' });
    engine.physics.register(child);
    engine.behaviors.add(child, 'entity.position.y += delta');

    child.setParent(parent, engine);

    expect(engine.entities).toContain(child);
    expect(engine.physics.bodyFor(child)).toBe(child.rigidBody);
    expect(engine.behaviors.get(child)).not.toBeNull();
  });

  it('moves the object into the parent in the scene graph', () => {
    const engine = fakeEngine();
    const parent = engine.add(named('Parent'));
    const child = engine.add(named('Child'));

    child.setParent(parent, engine);

    expect(child.object3D.parent).toBe(parent.object3D);
    expect(parent.children).toContain(child);
    expect(child.parent).toBe(parent);
    expect(engine.scene.children).not.toContain(child.object3D);
  });

  it('preserves the child world position when parenting', () => {
    const engine = fakeEngine();
    const parent = engine.add(named('Parent'));
    parent.object3D.position.set(10, 0, 0);
    const child = engine.add(named('Child'));
    child.object3D.position.set(3, 1, 0);

    child.setParent(parent, engine);

    const world = child.object3D.getWorldPosition(new THREE.Vector3());
    expect(world.x).toBeCloseTo(3, 6);
    expect(world.y).toBeCloseTo(1, 6);
    // local position is now relative to the parent
    expect(child.object3D.position.x).toBeCloseTo(-7, 6);
  });

  it('preserves the child world position when unparenting', () => {
    const engine = fakeEngine();
    const parent = engine.add(named('Parent'));
    parent.object3D.position.set(10, 5, 0);
    const child = engine.add(named('Child'));
    child.setParent(parent, engine);
    child.object3D.position.set(1, 0, 0); // local -> world (11, 5, 0)

    child.setParent(null, engine);

    expect(child.object3D.position.x).toBeCloseTo(11, 6);
    expect(child.object3D.position.y).toBeCloseTo(5, 6);
    expect(child.object3D.parent).toBe(engine.scene);
  });

  it('preserves world scale and rotation through a scaled parent', () => {
    const engine = fakeEngine();
    const parent = engine.add(named('Parent'));
    parent.object3D.scale.set(2, 2, 2);
    parent.object3D.rotation.y = Math.PI / 2;
    const child = engine.add(named('Child'));
    child.object3D.position.set(4, 0, 0);

    child.setParent(parent, engine);
    child.object3D.updateMatrixWorld(true);

    const world = child.object3D.getWorldPosition(new THREE.Vector3());
    expect(world.x).toBeCloseTo(4, 5);
    expect(world.z).toBeCloseTo(0, 5);
    const scale = child.object3D.getWorldScale(new THREE.Vector3());
    expect(scale.x).toBeCloseTo(1, 5);
  });

  it('moves cleanly between two parents', () => {
    const engine = fakeEngine();
    const a = engine.add(named('A'));
    const b = engine.add(named('B'));
    const child = engine.add(named('Child'));

    child.setParent(a, engine);
    child.setParent(b, engine);

    expect(a.children).not.toContain(child);
    expect(b.children).toEqual([child]);
    expect(child.object3D.parent).toBe(b.object3D);
  });

  it('is a no-op when the parent is unchanged, or is itself', () => {
    const engine = fakeEngine();
    const parent = engine.add(named('Parent'));
    const child = engine.add(named('Child'));
    child.setParent(parent, engine);

    child.setParent(parent, engine);
    expect(parent.children).toEqual([child]);

    child.setParent(child, engine);
    expect(child.parent).toBe(parent);
  });
});

describe('Entity.destroy', () => {
  it('removes the entity from the engine, physics and behaviors', () => {
    const engine = fakeEngine();
    const e = engine.add(named('Doomed'));
    e.rigidBody = new RigidBody({ type: 'dynamic' });
    engine.physics.register(e);
    engine.behaviors.add(e, 'entity.position.y += delta');

    e.destroy(engine);

    expect(engine.entities).not.toContain(e);
    expect(engine.physics.bodyFor(e)).toBeNull();
    expect(engine.behaviors.get(e)).toBeNull();
    expect(e.alive).toBe(false);
  });

  it('destroys children too, and unparents a nested entity properly', () => {
    const engine = fakeEngine();
    const parent = engine.add(named('Parent'));
    const child = engine.add(named('Child'));
    child.setParent(parent, engine);

    parent.destroy(engine);

    expect(engine.entities).not.toContain(parent);
    expect(engine.entities).not.toContain(child);
    expect(child.alive).toBe(false);
  });

  it('removes a parented entity from the engine (not just from its parent)', () => {
    // REGRESSION: destroy() took an either/or branch — a parented entity was
    // detached but never removed from engine.entities, so it kept updating.
    const engine = fakeEngine();
    const parent = engine.add(named('Parent'));
    const child = engine.add(named('Child'));
    child.setParent(parent, engine);

    child.destroy(engine);

    expect(engine.entities).not.toContain(child);
    expect(parent.children).not.toContain(child);
  });
});

describe('collision helpers', () => {
  it('detects overlapping half-extents', () => {
    const a = new THREE.Object3D();
    const b = new THREE.Object3D();
    b.position.set(0.5, 0, 0);
    const half = new THREE.Vector3(0.5, 0.5, 0.5);
    expect(aabbCollides(a, half, b, half)).toBe(true);

    b.position.set(2, 0, 0);
    expect(aabbCollides(a, half, b, half)).toBe(false);
  });

  it('computes world half-size including children', () => {
    const root = new THREE.Object3D();
    const child = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    child.position.set(3, 0, 0);
    root.add(child);
    root.updateMatrixWorld(true);

    const { halfSize } = getWorldHalfSize(root);
    expect(halfSize.x).toBeCloseTo(1, 6);
  });
});
