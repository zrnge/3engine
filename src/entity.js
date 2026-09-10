import * as THREE from 'three';

/**
 * Entity — base class for game objects.
 * Subclasses get `this.object3D` and override `update(dt, engine)`.
 */
export class Entity {
  constructor(object3D = new THREE.Group()) {
    this.object3D = object3D;
    this.alive = true;
    this.solid = false; // if true, player cannot walk through this object
    this.parent = null; // Entity or null
    this.children = []; // Entity[]
  }

  start(_engine) {}
  update(_dt, _engine) {}

  /** Reparent this entity under `newParent` (Entity or null for scene root). */
  setParent(newParent, engine) {
    if (this.parent === newParent) return;
    // detach from old parent
    if (this.parent) {
      const idx = this.parent.children.indexOf(this);
      if (idx !== -1) this.parent.children.splice(idx, 1);
      // preserve world transform before reparenting
      this.object3D.applyMatrix4(this.parent.object3D.matrixWorld);
      this.object3D.updateMatrix();
      this.parent.object3D.remove(this.object3D);
    } else if (engine) {
      engine.scene.remove(this.object3D);
      this.object3D.updateMatrixWorld();
    }
    // remove from engine root list if it was there
    if (engine) engine.remove(this);

    this.parent = newParent;
    if (newParent) {
      newParent.children.push(this);
      newParent.object3D.add(this.object3D);
      // convert world matrix back to local under new parent
      const parentInv = new THREE.Matrix4().copy(newParent.object3D.matrixWorld).invert();
      this.object3D.applyMatrix4(parentInv);
      this.object3D.updateMatrix();
    } else if (engine) {
      engine.scene.add(this.object3D);
      engine.add(this);
    }
  }

  /** Detach all children and remove this entity from the scene/engine. */
  destroy(engine) {
    this.alive = false;
    // destroy children first
    for (let i = this.children.length - 1; i >= 0; i--) {
      this.children[i].destroy(engine);
    }
    if (this.parent) this.setParent(null, engine);
    else engine.remove(this);
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

/** Compute world-space AABB half-extents for an Object3D (including children). */
export function getWorldHalfSize(object3D) {
  const box = new THREE.Box3().setFromObject(object3D);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  return { center, halfSize: size.multiplyScalar(0.5) };
}
