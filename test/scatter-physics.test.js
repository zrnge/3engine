// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { world } from './helpers/world.js';
import { Entity } from '../src/entity.js';
import { RigidBody } from '../src/physics.js';
import { makeGenerated } from '../src/generators/generated.js';

describe('a solid scatter in play', () => {
  it('a body walking into a tree trunk is stopped by it', () => {
    const { engine, add, step } = world();
    add('Floor', { at: [0, -0.5, 0], size: [60, 1, 60], body: { type: 'static' } });
    const root = makeGenerated('scatter', { kind: 'trees', count: 1, size: 1, seed: 1, solid: true, scaleMin: 1, scaleMax: 1 });
    const trees = new Entity(root);
    engine.scene.add(root);
    engine.entities.push(trees);
    trees.rigidBody = new RigidBody({ type: 'static', shape: 'mesh' });
    root.updateMatrixWorld(true);
    engine.physics.register(trees);
    const col = root.children.find((c) => c.name === 'Colliders');
    const box = new THREE.Box3().setFromObject(col);
    const c = box.getCenter(new THREE.Vector3());
    const walker = add('Walker', { at: [c.x - 3, 1, c.z], size: [0.6, 1.6, 0.6], body: { type: 'dynamic', shape: 'capsule' } });
    // walked straight at it: stopped, or (a trunk's box turned at an angle) slid round it — never through it
    let inside = 0;
    for (let t = 0; t < 120; t++) {
      walker.rigidBody.velocity.x = 4;
      step();
      const p = walker.object3D.position;
      if (p.x > box.min.x + 0.05 && p.x < box.max.x - 0.05 && p.z > box.min.z + 0.05 && p.z < box.max.z - 0.05) inside++;
    }
    expect(inside).toBe(0);
    expect(walker.object3D.position.x < box.min.x || Math.abs(walker.object3D.position.z - c.z) > 0.5).toBe(true);
  });
});
