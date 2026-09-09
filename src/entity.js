import * as THREE from 'three';

/**
 * Entity — base class for game objects.
 * Subclasses get `this.object3D` and override `update(dt, engine)`.
 */
export class Entity {
  constructor(object3D = new THREE.Group()) {
    this.object3D = object3D;
    this.alive = true;
  }

  start(_engine) {}
  update(_dt, _engine) {}

  destroy(engine) {
    this.alive = false;
    engine.remove(this);
  }
}

/** Axis-aligned bounding-box collision test on two Object3Ds with given half-sizes. */
export function aabbCollides(a, halfA, b, halfB) {
  return (
    Math.abs(a.position.x - b.position.x) < halfA.x + halfB.x &&
    Math.abs(a.position.y - b.position.y) < halfA.y + halfB.y &&
    Math.abs(a.position.z - b.position.z) < halfA.z + halfB.z
  );
}
