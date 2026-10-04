import * as THREE from 'three';

/**
 * Which way an object faces about the up axis, and turning it to face another
 * way — read from and made to its whole turn, not rotation.y alone.
 *
 * Turned past 90° as a quaternion (a Turn, a Rotate, Face towards, physics),
 * its rotation reads X 180, Y 180 − the angle, Z 180: the same turn, written the
 * other way. Then rotation.y is not where it faces, and setting rotation.y
 * alone mirrors it — it would walk one way and face another.
 */

const _f = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

/** An angle brought into -π…π. */
export const wrapAngle = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);

/**
 * Its heading, as rotation.y says for an upright object: 0 with its front (+Z)
 * along +Z, π/2 along +X. Its front pointing straight up or down (a model stood
 * up from lying on its back): read from its side instead.
 */
export function yawOf(o) {
  _f.set(0, 0, 1).applyQuaternion(o.quaternion);
  if (Math.hypot(_f.x, _f.z) > 1e-6) return Math.atan2(_f.x, _f.z);
  _f.set(1, 0, 0).applyQuaternion(o.quaternion);
  return Math.atan2(_f.x, _f.z) - Math.PI / 2;
}

/** Turn it about the up axis by `angle` (radians, + to its left), however it is turned already. */
export function turnYaw(o, angle) {
  if (!angle) return;
  o.quaternion.premultiply(_q.setFromAxisAngle(_up, angle)).normalize();
  tidyRotation(o);
}

/**
 * Write its rotation the readable way round: X 180, Y 45, Z 180 is the same
 * turn as X 0, Y 135, Z 0 — an upright object then reads just its heading, in
 * the Inspector and to anything that reads rotation.y.
 */
export function tidyRotation(o) {
  const r = o.rotation;
  if (r.order === 'XYZ' && Math.abs(r.x) > Math.PI / 2 + 1e-9) {
    r.set(wrapAngle(r.x + Math.PI), wrapAngle(Math.PI - r.y), wrapAngle(r.z + Math.PI));
  }
}

/** Face heading `yaw` (as yawOf reads it), keeping any tilt it has. */
export function setYaw(o, yaw) {
  turnYaw(o, wrapAngle(yaw - yawOf(o)));
}
