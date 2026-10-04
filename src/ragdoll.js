import * as THREE from 'three';
import { RigidBody } from './physics.js';
import { bodyOf, skinBones } from './rig.js';
import { makeJoint } from './joints.js';
import { AnimationPlayer } from './animation.js';

/**
 * Ragdolls — a character gone limp: its clips stop, and its body is a set of
 * capsules (pelvis, torso, head, upper and lower arms, thighs and shins) held
 * together by joints that swing only so far (a knee doesn't bend round
 * backwards to its hip). They fall, tumble and come to rest under physics,
 * and its bones follow them each frame — down a slope, over a railing, flung
 * by a blast.
 *
 * Made from its skeleton's body parts (rig.js: any rig with humanoid bone
 * names). A shape with no skeleton just tumbles as itself.
 */

/** [segment, from (body part), to (body part, or the end of from's bones), share of its weight, how thick (× its length), swing limit (°), joined to] */
const SEGMENTS = [
  ['pelvis', 'hips', ['spine', 'spine1', 'chest'], 0.15, 0.45, 0, null],
  ['torso', ['spine1', 'chest', 'spine'], ['neck', 'head'], 0.3, 0.38, 35, 'pelvis'],
  ['head', 'head', null, 0.08, 0.45, 45, 'torso'],
  ...['L', 'R'].flatMap((s) => [
    [`${s}.upperArm`, `${s}.upperArm`, `${s}.lowerArm`, 0.03, 0.22, 100, 'torso'],
    [`${s}.lowerArm`, `${s}.lowerArm`, `${s}.hand`, 0.02, 0.2, 120, `${s}.upperArm`],
    [`${s}.upperLeg`, `${s}.upperLeg`, `${s}.lowerLeg`, 0.1, 0.22, 80, 'pelvis'],
    [`${s}.lowerLeg`, `${s}.lowerLeg`, `${s}.foot`, 0.05, 0.2, 120, `${s}.upperLeg`],
  ]),
];

const isUnder = (node, parent) => { for (let n = node?.parent; n; n = n.parent) if (n === parent) return true; return false; };
const pick = (byKey, keys) => (Array.isArray(keys) ? keys.map((k) => byKey[k]).find(Boolean) : byKey[keys]) ?? null;
/** Where a bone's own reach ends: the end of its chain of single children (its "_end"). */
function endOf(bone) {
  let n = bone;
  while (n.children.length) n = n.children[0];
  return n === bone ? null : n;
}

export class Ragdoll {
  constructor(engine, entity, { push = null } = {}) {
    this.engine = engine;
    this.entity = entity;
    this.parts = [];   // { name, bone, proxy (entity), offsetQ, offsetP? }
    this.joints = [];
    this.build(push);
  }

  build(push) {
    const { engine, entity } = this;
    const root = entity.object3D;
    const physics = engine.physics;
    root.updateMatrixWorld(true);
    const { byKey } = bodyOf(skinBones(root));
    const scale = root.getWorldScale(new THREE.Vector3()).x || 1;
    const total = entity.rigidBody?.mass || 70;
    const speed = entity.rigidBody?.velocity?.clone() ?? new THREE.Vector3();
    if (push) speed.add(push);
    // its own collider gives way to its limbs'
    physics.unregister(entity);
    // its clips stop: from now on its bones follow its limbs
    const player = engine.mixers?.find((m) => m.root === root);
    if (player instanceof AnimationPlayer) { player.reset(); player.rig = null; }
    entity.ragdoll = this;
    const made = {};
    for (const [name, fromKey, toKey, share, thick, cone, parent] of SEGMENTS) {
      const bone = pick(byKey, fromKey);
      if (!bone) continue;
      let to = toKey ? pick(byKey, toKey) : null;
      if (to && !isUnder(to, bone)) to = null;
      to ??= endOf(bone);
      const a = bone.getWorldPosition(new THREE.Vector3());
      let b = to ? to.getWorldPosition(new THREE.Vector3()) : null;
      if (!b || b.distanceTo(a) < 0.02 * scale) {
        // a head with no end: as tall as a third of the torso, upwards
        const torso = made.torso;
        const up = 0.25 * (torso ? torso.length : 1.6 * scale * 0.3);
        b = a.clone().add(new THREE.Vector3(0, up, 0).applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion())));
      }
      const length = a.distanceTo(b);
      if (length < 0.02) continue;
      const radius = THREE.MathUtils.clamp(length * thick, 0.03, 0.3);
      // a capsule along its own up (y) from a to b
      const group = new THREE.Group();
      group.name = `${root.name} · ${name}`;
      group.userData.ragdollPart = true;
      group.position.copy(a).add(b).multiplyScalar(0.5);
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      engine.scene.add(group);
      group.updateMatrixWorld(true);
      const proxy = {
        object3D: group,
        owner: entity, // hits on a limb are hits on the character
        rigidBody: new RigidBody({ type: 'dynamic', tumbles: true, shape: 'capsule', mass: Math.max(0.5, total * share), friction: 0.9, restitution: 0 }),
      };
      proxy.rigidBody.box = new THREE.Box3(new THREE.Vector3(-radius, -length / 2 - radius, -radius), new THREE.Vector3(radius, length / 2 + radius, radius));
      proxy.rigidBody.velocity.copy(speed);
      physics.register(proxy);
      const part = {
        name, bone, proxy, length, a, cone, parent,
        offsetQ: group.quaternion.clone().invert().multiply(bone.getWorldQuaternion(new THREE.Quaternion())),
      };
      if (name === 'pelvis') part.offsetP = group.worldToLocal(bone.getWorldPosition(new THREE.Vector3()));
      made[name] = part;
      this.parts.push(part);
    }
    // its limbs never collide with each other (they overlap at their joints)
    physics.keepApart(entity, entity);
    // joined where each starts on its parent, swinging only so far
    for (const part of this.parts) {
      const parent = made[part.parent];
      if (!parent) continue;
      const p = parent.proxy.object3D;
      const anchor = part.a.clone().sub(p.position).applyQuaternion(p.quaternion.clone().invert());
      const joint = makeJoint(parent.proxy, part.proxy, { type: 'ball', anchor: anchor.toArray(), axis: 'y', cone: part.cone });
      physics.addJoint(joint);
      this.joints.push(joint);
    }
    // parents' bones first: each is set in its parent's frame
    const depth = (b) => { let d = 0; for (let n = b; n; n = n.parent) d++; return d; };
    this.parts.sort((x, y) => depth(x.bone) - depth(y.bone));
  }

  /** Its bones to where its limbs are now. */
  update() {
    const q = new THREE.Quaternion();
    const pq = new THREE.Quaternion();
    for (const part of this.parts) {
      const g = part.proxy.object3D;
      const bone = part.bone;
      q.copy(g.quaternion).multiply(part.offsetQ); // the bone's turn in the world
      if (bone.parent) bone.parent.getWorldQuaternion(pq).invert();
      else pq.identity();
      bone.quaternion.copy(pq.multiply(q));
      if (part.offsetP && bone.parent) {
        const at = g.localToWorld(part.offsetP.clone());
        bone.position.copy(bone.parent.worldToLocal(at));
      }
      bone.updateMatrixWorld(true);
    }
  }

  /** Its limbs out of the world (play stopped, the character gone). */
  dispose() {
    const physics = this.engine.physics;
    for (const j of this.joints) physics.removeJoint(j);
    for (const part of this.parts) {
      physics.unregister(part.proxy);
      part.proxy.object3D.removeFromParent();
    }
    physics.keepApart(this.entity, this.entity, false);
    if (this.entity.ragdoll === this) delete this.entity.ragdoll;
    this.parts = [];
    this.joints = [];
  }
}

/**
 * Make a character go limp. `push` (m/s, a vector) flings it — away from a
 * blast, the way a shot came. Its limbs are each moving as fast as it was,
 * plus the push. A character already limp stays as it is.
 */
export function goLimp(engine, entity, { push = null } = {}) {
  if (!entity?.object3D || entity.ragdoll) return entity?.ragdoll ?? null;
  const rig = bodyOf(skinBones(entity.object3D));
  if (!rig.byKey.hips) {
    // no skeleton: it just tumbles as itself
    if (entity.rigidBody) {
      entity.rigidBody.type = 'dynamic';
      entity.rigidBody.invMass = 1 / entity.rigidBody.mass;
      entity.rigidBody.tumbles = true;
      if (push) entity.rigidBody.velocity.add(push);
    }
    return null;
  }
  const doll = new Ragdoll(engine, entity, { push });
  (engine.ragdolls ??= []).push(doll);
  return doll;
}

/** Every ragdoll's bones to its limbs (each frame), and those whose character is gone, cleared. */
export function updateRagdolls(engine) {
  const list = engine.ragdolls;
  if (!list?.length) return;
  for (const doll of [...list]) {
    if (!doll.entity.object3D.parent) {
      doll.dispose();
      list.splice(list.indexOf(doll), 1);
      continue;
    }
    doll.update();
  }
}

/** Every ragdoll gone (play stops or starts again). */
export function clearRagdolls(engine) {
  for (const doll of engine.ragdolls || []) doll.dispose();
  if (engine.ragdolls) engine.ragdolls.length = 0;
}
