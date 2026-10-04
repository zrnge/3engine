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
    this.rigidBody = null; // physics body (see physics.js)
    this.behavior = null; // script string
    this.parent = null; // Entity or null
    this.children = []; // Entity[]
  }

  start(_engine) {}
  update(_dt, _engine) {}

  /**
   * Reparent this entity under `newParent` (Entity or null for scene root),
   * preserving its world transform.
   *
   * Parenting only moves the object within the Three.js scene graph — the entity
   * stays registered with the engine, so it keeps updating, keeps its rigid body
   * and keeps its behavior script. (It used to be dropped from the engine here,
   * which silently killed every child object.)
   */
  setParent(newParent, engine) {
    if (this.parent === newParent || newParent === this) return;
    const o = this.object3D;

    o.updateMatrixWorld(true);
    const world = o.matrixWorld.clone();

    // detach from whoever currently holds it
    if (this.parent) {
      const idx = this.parent.children.indexOf(this);
      if (idx !== -1) this.parent.children.splice(idx, 1);
    }
    o.parent?.remove(o);

    this.parent = newParent;
    if (newParent) {
      newParent.children.push(this);
      newParent.object3D.updateMatrixWorld(true);
      newParent.object3D.add(o);
      // world -> local under the new parent
      const local = new THREE.Matrix4()
        .copy(newParent.object3D.matrixWorld)
        .invert()
        .multiply(world);
      decomposeInto(o, local);
    } else if (engine) {
      engine.scene.add(o);
      decomposeInto(o, world);
    }
  }

  /** Detach all children and remove this entity from the scene/engine. */
  destroy(engine) {
    this.alive = false;
    // destroy children first
    for (let i = this.children.length - 1; i >= 0; i--) {
      this.children[i].destroy(engine);
    }
    this._clearSolidHelper();
    if (this.parent) this.setParent(null, engine);
    if (engine) engine.remove(this);
  }

  _clearSolidHelper() {
    const helper = this.object3D.userData.__solidHelper;
    if (helper) {
      helper.parent?.remove(helper);
      helper.geometry?.dispose();
      helper.material?.dispose();
      delete this.object3D.userData.__solidHelper;
    }
  }
}

/** Write a matrix into an object's position/quaternion/scale. */
function decomposeInto(object3D, matrix) {
  matrix.decompose(object3D.position, object3D.quaternion, object3D.scale);
  object3D.updateMatrix();
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
