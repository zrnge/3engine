import * as THREE from 'three';

/**
 * Poses — a visual-only nudge to an object: a bob, a lean, a squash.
 *
 *   engine.poses.set(object3D, { y: 0.1, lean: 0.15, sx: 1.1, sy: 0.8, sz: 1.1, tilt });
 *
 * `tilt` (a Quaternion, in its parent's space) leans it with the ground under
 * it — a car over a bump, a board on a slope (Movement feel's "Tilt with the ground").
 *
 * Physics measures each body from its object's real shape every step, so
 * squashing the object itself would squash its collider too — a character
 * would jitter and sink. Poses are put on just before a frame is drawn and
 * taken off straight after, so only the picture moves.
 */

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Apply every pose; returns a function that puts everything back exactly. */
export function applyPoses(poses) {
  if (!poses || !poses.size) return () => {};
  const saved = [];
  for (const [o, p] of poses) {
    if (!o.parent) continue; // removed from the scene
    saved.push([o, o.position.y, o.quaternion.clone(), o.scale.clone()]);
    o.position.y += p.y || 0;
    if (p.tilt) o.quaternion.premultiply(p.tilt);
    if (p.lean) o.quaternion.multiply(_q.setFromEuler(_e.set(p.lean, 0, 0))); // tilt forward (local +Z)
    o.scale.set(o.scale.x * (p.sx ?? 1), o.scale.y * (p.sy ?? 1), o.scale.z * (p.sz ?? 1));
  }
  return () => {
    for (const [o, y, q, s] of saved) {
      o.position.y = y;
      o.quaternion.copy(q);
      o.scale.copy(s);
    }
  };
}
