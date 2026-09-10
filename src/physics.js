import * as THREE from 'three';

/**
 * Tiny3 Physics — small rigid-body system with AABB collision and raycasts.
 *
 * Body types:
 *   static   : never moves, blocks everything
 *   kinematic: moved by code/animations, blocks dynamic bodies but is not pushed
 *   dynamic  : gravity + velocity + collision response
 */

export const BODY_TYPES = ['static', 'kinematic', 'dynamic'];

export class RigidBody {
  constructor({ type = 'static', mass = 1, restitution = 0, friction = 0.5, gravity = -24 } = {}) {
    this.type = type; // static | kinematic | dynamic
    this.mass = Math.max(0.001, mass);
    this.invMass = this.type === 'dynamic' ? 1 / this.mass : 0;
    this.restitution = restitution;
    this.friction = friction;
    this.gravity = gravity;

    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    this.grounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);

    // half-extents used for AABB collision; computed from object bounding box if not set
    this.halfExtents = null;
  }

  toJSON() {
    return {
      type: this.type,
      mass: this.mass,
      restitution: this.restitution,
      friction: this.friction,
    };
  }
}

/** Get (or create) the RigidBody on an entity. */
export function getBody(entity) {
  return entity?.rigidBody ?? null;
}

export function setBody(entity, body) {
  entity.rigidBody = body;
}

/** Compute world-space AABB for an Object3D. */
export function getWorldAABB(object3D) {
  const box = new THREE.Box3().setFromObject(object3D);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  // for flat geometry (plane), give it a minimal thickness so it can collide
  if (size.y < 0.01) size.y = 0.1;
  // if size is zero in any axis (e.g. degenerate), pad it
  if (size.x < 0.01) size.x = 0.1;
  if (size.z < 0.01) size.z = 0.1;
  const halfSize = size.multiplyScalar(0.5);
  // never allow a zero half-extent
  if (halfSize.x < 0.05) halfSize.x = 0.05;
  if (halfSize.y < 0.05) halfSize.y = 0.05;
  if (halfSize.z < 0.05) halfSize.z = 0.05;
  return { center, halfSize };
}

/** Test overlap between two AABBs. */
export function aabbOverlap(aCenter, aHalf, bCenter, bHalf) {
  return (
    Math.abs(aCenter.x - bCenter.x) < aHalf.x + bHalf.x &&
    Math.abs(aCenter.y - bCenter.y) < aHalf.y + bHalf.y &&
    Math.abs(aCenter.z - bCenter.z) < aHalf.z + bHalf.z
  );
}

/** Compute penetration depth and axis for two overlapping AABBs. */
export function aabbPenetration(aCenter, aHalf, bCenter, bHalf) {
  const overlapX = aHalf.x + bHalf.x - Math.abs(aCenter.x - bCenter.x);
  const overlapY = aHalf.y + bHalf.y - Math.abs(aCenter.y - bCenter.y);
  const overlapZ = aHalf.z + bHalf.z - Math.abs(aCenter.z - bCenter.z);
  if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) return null;

  // resolve smallest axis first
  if (overlapX < overlapY && overlapX < overlapZ) {
    return { axis: new THREE.Vector3(aCenter.x > bCenter.x ? 1 : -1, 0, 0), depth: overlapX };
  } else if (overlapY < overlapZ) {
    return { axis: new THREE.Vector3(0, aCenter.y > bCenter.y ? 1 : -1, 0), depth: overlapY };
  } else {
    return { axis: new THREE.Vector3(0, 0, aCenter.z > bCenter.z ? 1 : -1), depth: overlapZ };
  }
}

/**
 * Tiny physics world.
 */
export class PhysicsWorld {
  constructor() {
    this.bodies = []; // { entity, body }
  }

  register(entity) {
    if (!entity.rigidBody) return;
    if (!this.bodies.find((b) => b.entity === entity)) {
      this.bodies.push({ entity, body: entity.rigidBody });
    }
  }

  unregister(entity) {
    const i = this.bodies.findIndex((b) => b.entity === entity);
    if (i !== -1) this.bodies.splice(i, 1);
  }

  step(dt, engine) {
    // reset grounded state before integration
    for (const { body } of this.bodies) {
      if (body.type === 'dynamic') body.grounded = false;
    }

    // integrate dynamic bodies
    for (const { entity, body } of this.bodies) {
      if (body.type !== 'dynamic') continue;
      body.velocity.y += body.gravity * dt;
      body.velocity.x *= (1 - body.friction * dt);
      body.velocity.z *= (1 - body.friction * dt);

      const o = entity.object3D;
      o.position.x += body.velocity.x * dt;
      o.position.y += body.velocity.y * dt;
      o.position.z += body.velocity.z * dt;
    }

    // resolve collisions with iterative positional correction
    const iterations = 8;
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < this.bodies.length; i++) {
        const a = this.bodies[i];
        if (a.body.type === 'static') continue;
        const aAABB = getWorldAABB(a.entity.object3D);

        for (let j = 0; j < this.bodies.length; j++) {
          if (i === j) continue;
          const b = this.bodies[j];
          if (b.body.type === 'static' && a.body.type !== 'dynamic') continue;
          const bAABB = getWorldAABB(b.entity.object3D);
          const pen = aabbPenetration(aAABB.center, aAABB.halfSize, bAABB.center, bAABB.halfSize);
          if (!pen) continue;

          if (a.body.type === 'dynamic' && b.body.type !== 'dynamic') {
            a.entity.object3D.position.addScaledVector(pen.axis, pen.depth + 0.001);
            const vn = bodyVelocityOnAxis(a.body.velocity, pen.axis);
            if (vn < 0) {
              const restitution = Math.max(a.body.restitution, b.body.restitution);
              const vSep = vn * (1 + restitution);
              removeVelocityOnAxis(a.body.velocity, pen.axis, vSep);
              if (pen.axis.y > 0.5) {
                a.body.grounded = true;
                a.body.groundNormal.copy(pen.axis);
              }
            }
          } else if (a.body.type === 'dynamic' && b.body.type === 'dynamic') {
            // equal mass split for simplicity
            const push = pen.depth * 0.5 + 0.001;
            a.entity.object3D.position.addScaledVector(pen.axis, push);
            b.entity.object3D.position.addScaledVector(pen.axis, -push);
          }
        }
      }
    }
  }

  /** Raycast against all colliders. Returns closest hit { entity, point, normal, distance }. */
  raycast(origin, direction, maxDistance = 100) {
    const dir = direction.clone().normalize();
    let closest = null;
    for (const { entity, body } of this.bodies) {
      const aabb = getWorldAABB(entity.object3D);
      const hit = rayAABB(origin, dir, aabb.center, aabb.halfSize, maxDistance);
      if (hit && (!closest || hit.distance < closest.distance)) {
        closest = { entity, point: hit.point, normal: hit.normal, distance: hit.distance };
      }
    }
    return closest;
  }

  /** Cast a ray straight down from a point and return the distance to the first collider. */
  groundDistance(origin, maxDistance = 10) {
    const hit = this.raycast(origin, new THREE.Vector3(0, -1, 0), maxDistance);
    return hit ? hit.distance : null;
  }
}

function bodyVelocityOnAxis(velocity, axis) {
  return velocity.dot(axis);
}

function removeVelocityOnAxis(velocity, axis, amount = null) {
  const vn = velocity.dot(axis);
  const remove = amount !== null ? amount : vn;
  velocity.x -= axis.x * remove;
  velocity.y -= axis.y * remove;
  velocity.z -= axis.z * remove;
}

/** Ray vs AABB intersection (Slab method). */
function rayAABB(origin, dir, center, halfSize, maxDistance) {
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes = ['x', 'y', 'z'];
  for (const axis of axes) {
    if (Math.abs(dir[axis]) < 1e-6) {
      if (origin[axis] < center[axis] - halfSize[axis] || origin[axis] > center[axis] + halfSize[axis]) {
        return null;
      }
    } else {
      const o1 = (center[axis] - halfSize[axis] - origin[axis]) / dir[axis];
      const o2 = (center[axis] + halfSize[axis] - origin[axis]) / dir[axis];
      tmin = Math.max(tmin, Math.min(o1, o2));
      tmax = Math.min(tmax, Math.max(o1, o2));
    }
  }
  if (tmax < 0 || tmin > tmax || tmin > maxDistance) return null;
  const t = tmin >= 0 ? tmin : tmax;
  const point = origin.clone().addScaledVector(dir, t);
  const normal = new THREE.Vector3();
  const epsilon = 0.001;
  if (Math.abs(point.x - (center.x - halfSize.x)) < epsilon) normal.x = -1;
  else if (Math.abs(point.x - (center.x + halfSize.x)) < epsilon) normal.x = 1;
  else if (Math.abs(point.y - (center.y - halfSize.y)) < epsilon) normal.y = -1;
  else if (Math.abs(point.y - (center.y + halfSize.y)) < epsilon) normal.y = 1;
  else if (Math.abs(point.z - (center.z - halfSize.z)) < epsilon) normal.z = -1;
  else if (Math.abs(point.z - (center.z + halfSize.z)) < epsilon) normal.z = 1;
  else normal.set(0, 1, 0);
  return { point, normal, distance: t };
}
