import * as THREE from 'three';
import { findRig } from './rig.js';

/**
 * After a model's clips have posed it this frame (animation.js), its rig:
 *
 *   root motion   a clip that moves the hips forward moves the object instead
 *                 (or its body), the hips kept over it — a lunge travels, a dance moves
 *   feet          each leg bent (two-bone IK) so its foot rests on the ground
 *                 under it, the hips lowered as far as the lower foot needs
 *   look at       the head (and a little of the neck and chest) turned toward
 *                 something, no further than a neck turns, eased
 *
 * Bones it moves are put back before the clips pose them next frame (restore),
 * so nothing it does builds up on a bone a clip doesn't move.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);

/** Turn a bone by a rotation given in the world, keeping the rest of its pose. */
function rotateWorld(bone, qWorld) {
  bone.getWorldQuaternion(_qw);
  _qw.premultiply(qWorld);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qp).invert();
    _qw.premultiply(_qp);
  }
  bone.quaternion.copy(_qw);
  bone.updateMatrixWorld(true);
}

/** Remember a bone as the clips left it, to put back before next frame's clips. */
function save(state, bone) {
  if (state.saved.some((s) => s[0] === bone)) return;
  state.saved.push([bone, bone.quaternion.clone(), bone.position.clone()]);
}

/** Before the clips pose the model: what the rig moved last frame, back as it was. */
export function restoreRig(player) {
  const state = player._ik;
  if (!state) return;
  for (const [bone, q, p] of state.saved) { bone.quaternion.copy(q); bone.position.copy(p); }
  state.saved.length = 0;
}

/** After the clips: root motion, feet, the head — as the Animator asked (player.rig). */
export function applyRig(player, dt) {
  const ask = player.rig;
  if (!ask || (!ask.footIK && !ask.lookAt && !ask.rootMotion)) return;
  const root = player.root;
  if (!root.parent) return;
  const rig = findRig(root);
  const state = player._ik ?? (player._ik = { saved: [], offsets: {}, look: new THREE.Quaternion(), hipsLast: null, clip: null });
  root.updateMatrixWorld(true);
  if (ask.rootMotion && rig.hips) rootMotion(player, rig, state, ask, dt);
  if (ask.footIK && rig.legs.length) feet(player, rig, state, ask, dt);
  if (ask.lookAt && rig.head) look(rig, state, ask.lookAt, dt);
  else if (rig.head && state.lookWeight > 0) look(rig, state, null, dt); // easing back
}

// ---------------------------------------------------------------- root motion

function rootMotion(player, rig, state, ask, dt) {
  const hips = rig.hips;
  const parent = hips.parent;
  if (!parent || !rig.hipsRest) return;
  const clip = player.current;
  // where the clip has the hips, in the model's own space (the model itself moves: that isn't the clip's)
  const model = player.root;
  const now = model.worldToLocal(parent.localToWorld(_a.copy(hips.position)));
  const last = state.hipsLast;
  state.hipsLast = now.clone();
  const sameClip = state.clip === clip;
  state.clip = clip;
  save(state, hips);
  // the hips kept over the object: only their height is the clip's
  hips.position.set(rig.hipsRest.x, hips.position.y, rig.hipsRest.z);
  hips.updateMatrixWorld(true);
  if (!last || !sameClip) return;
  const local = _b.subVectors(now, last);
  // a loop starting again jumps the hips back: not a move
  const legs = rig.legs[0]?.length || 1;
  if (Math.hypot(local.x, local.z) > legs * 0.8 / Math.max(1e-6, model.getWorldScale(_c).x)) return;
  // into the world: turned and sized as the model is, level
  const move = local.applyMatrix3(new THREE.Matrix3().setFromMatrix4(model.matrixWorld)).setY(0);
  const entity = ask.entity;
  const o = entity?.object3D ?? player.root;
  const body = entity?.rigidBody;
  if (body?.type === 'dynamic' && dt > 0) {
    body.velocity.x = move.x / dt;
    body.velocity.z = move.z / dt;
  } else {
    o.position.add(move);
    o.updateMatrixWorld(true);
  }
}

// ---------------------------------------------------------------- feet

/** Two bones (up → low → end) bent so the end reaches `target` (world), the knee bending as it did. */
function twoBone(leg, target) {
  const { up, low, foot } = leg;
  up.getWorldPosition(_a);
  low.getWorldPosition(_b);
  foot.getWorldPosition(_c);
  const l1 = _a.distanceTo(_b);
  const l2 = _b.distanceTo(_c);
  const d = Math.min(l1 + l2 - 1e-3, Math.max(Math.abs(l1 - l2) + 1e-3, _a.distanceTo(target)));
  // the knee: its angle opened or closed to what this distance needs, about the leg's own bend
  const ba = _n.subVectors(_a, _b).normalize();
  const bc = _t.subVectors(_c, _b).normalize();
  const axis = new THREE.Vector3().crossVectors(ba, bc);
  if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0).applyQuaternion(up.getWorldQuaternion(_qw)); // straight: bend about its own side
  axis.normalize();
  const now = Math.acos(Math.min(1, Math.max(-1, ba.dot(bc))));
  const want = Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2))));
  rotateWorld(low, _q.setFromAxisAngle(axis, want - now));
  // then the thigh turned so the foot lands on the target
  foot.getWorldPosition(_c);
  up.getWorldPosition(_a);
  const from = _b.subVectors(_c, _a).normalize();
  const to = _n.subVectors(target, _a).normalize();
  rotateWorld(up, _q.setFromUnitVectors(from, to));
}

function feet(player, rig, state, ask, dt) {
  const engine = ask.engine;
  const entity = ask.entity;
  const physics = engine?.physics;
  if (!physics?.raycast) return;
  const root = player.root;
  const base = (entity?.object3D ?? root).getWorldPosition(new THREE.Vector3()).y;
  const body = entity?.rigidBody;
  const airborne = body && body.type === 'dynamic' && !body.grounded;
  const skip = (e) => e === entity || e.owner === entity;
  const k = dt > 0 ? Math.min(1, dt * 12) : 1;
  // each foot: where the ground is under it, and how far it must go to stand on it
  const want = [];
  for (const leg of rig.legs) {
    const foot = leg.foot.getWorldPosition(new THREE.Vector3());
    const lift = Math.max(0, foot.y - base); // the clip's own lift of the foot (a step)
    const from = new THREE.Vector3(foot.x, base + leg.length * 0.6, foot.z);
    const hit = airborne ? null : physics.raycast(from, _down, leg.length * 1.4, { skip });
    let offset = 0;
    if (hit) offset = Math.max(-leg.length * 0.45, Math.min(leg.length * 0.45, hit.point.y + lift - foot.y));
    state.offsets[leg.side] = (state.offsets[leg.side] ?? 0) + (offset - (state.offsets[leg.side] ?? 0)) * k;
    want.push({ leg, foot, offset: state.offsets[leg.side] });
  }
  // the hips down as far as the lower foot needs (up never: the legs would stretch)
  const drop = Math.min(0, ...want.map((w) => w.offset));
  if (rig.hips && drop < -1e-4) {
    save(state, rig.hips);
    const parent = rig.hips.parent;
    const at = rig.hips.getWorldPosition(new THREE.Vector3());
    at.y += drop;
    rig.hips.position.copy(parent ? parent.worldToLocal(at) : at);
    rig.hips.updateMatrixWorld(true);
  }
  for (const { leg, foot, offset } of want) {
    if (Math.abs(offset - drop) < 1e-4 && Math.abs(drop) < 1e-4) continue;
    save(state, leg.up);
    save(state, leg.low);
    save(state, leg.foot);
    const footTurn = leg.foot.getWorldQuaternion(new THREE.Quaternion());
    twoBone(leg, foot.clone().setY(foot.y + offset));
    // the foot keeps the way it was turned by its clip
    rotateWorld(leg.foot, _q.copy(leg.foot.getWorldQuaternion(_qw)).invert().premultiply(footTurn));
  }
}

// ---------------------------------------------------------------- looking

const MAX_TURN = THREE.MathUtils.degToRad(75);

function look(rig, state, target, dt) {
  const head = rig.head;
  const k = dt > 0 ? Math.min(1, dt * 6) : 1;
  let wantQ = null;
  if (target) {
    const at = head.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3().subVectors(target, at);
    // the way the body faces: the model's front (+Z), level
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(rootQuat(head));
    front.y = 0;
    if (dir.lengthSq() > 1e-6 && front.lengthSq() > 1e-6) {
      dir.normalize();
      front.normalize();
      const angle = front.angleTo(dir);
      if (angle < MAX_TURN * 1.3) {
        // no further than a neck turns (and its eyes a little more)
        wantQ = new THREE.Quaternion().setFromUnitVectors(front, dir);
        if (angle > MAX_TURN) wantQ.slerp(new THREE.Quaternion(), 1 - MAX_TURN / angle);
      }
    }
  }
  state.look.slerp(wantQ ?? new THREE.Quaternion(), k);
  state.lookWeight = 1 - Math.abs(state.look.w);
  if (state.lookWeight < 1e-5) return;
  // shared out: the chest a little, the neck some, the head the most
  const parts = [[rig.chest, 0.15], [rig.neck, 0.3], [head, 0.55]].filter(([b]) => b);
  const total = parts.reduce((s, [, w]) => s + w, 0);
  for (const [bone, w] of parts) {
    save(state, bone);
    rotateWorld(bone, new THREE.Quaternion().slerp(state.look, w / total));
  }
}

/** The model's own turn in the world (its root object: the top of what holds the head). */
function rootQuat(node) {
  let top = node;
  while (top.parent && top.parent.type !== 'Scene') top = top.parent;
  return top.getWorldQuaternion(new THREE.Quaternion());
}
