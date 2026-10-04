import * as THREE from 'three';

/**
 * Joints — two bodies held together, or one to a point in the world:
 *
 *   hinge    turns about one axis only (a door, a gate, a lever, a wheel) — limits optional
 *   ball     turns any way about a point (a pendulum, a chain's link, a lamp on a cord) — a cone to swing in, optional
 *   fixed    held as it was (welded: a crate glued to a cart; breakable, it comes apart)
 *   rope     no further apart than its length (slack when closer)
 *   spring   pulled back to its length, springy (a bouncing lamp, a car's tow)
 *
 * Solved after everything else each physics slice (PhysicsWorld._slice):
 * where the two have drifted apart, they are moved back together — as far as
 * each can move (its weight; a static one doesn't) — and turned, if they
 * tumble; their speeds take the change, so a pendulum swings rather than
 * stretching. A joint with a "Breaks at" force comes apart when pulled harder
 * than that.
 */

export const JOINT_TYPES = ['hinge', 'ball', 'fixed', 'rope', 'spring'];
const ROUNDS = 6;

const _pA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _e = new THREE.Vector3();
const _n = new THREE.Vector3();
const _r = new THREE.Vector3();
const _t = new THREE.Vector3();
const _w = new THREE.Vector3();
const _aA = new THREE.Vector3();
const _aB = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _c = new THREE.Vector3();
const _back = new THREE.Vector3();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();

/** A joint: what it joins and how. Anchors and axes are in each body's own frame (its place and turn, not its size). */
export class Joint {
  constructor({ a, b = null, type = 'ball', anchorA, anchorB, axisA = null, axisB = null, refA = null, refB = null,
    min = 0, max = 0, cone = 0, coneA = null, coneB = null, length = 0, stiffness = 200, damping = 4, breakForce = 0, qRel = null } = {}) {
    Object.assign(this, { a, b, type, anchorA, anchorB, axisA, axisB, refA, refB, min, max, cone, coneA, coneB, length, stiffness, damping, breakForce, qRel });
    this.broken = false;
    this.load = 0; // the force it held last slice (N)
  }
}

// ---------------------------------------------------------------- the world's side

const frameOf = (rec) => rec?.entity.object3D;
/** A point given in a body's frame (or in the world, with no body), in the world. */
function worldPoint(rec, local, out) {
  const o = frameOf(rec);
  if (!o) return out.copy(local);
  return out.copy(local).applyQuaternion(o.quaternion).add(o.position);
}
const turnOf = (rec, out) => (rec ? out.copy(frameOf(rec).quaternion) : out.identity());

/**
 * Joints, solved: called by PhysicsWorld at the end of each slice with its
 * helpers (each body's give, its turn, building its collider).
 */
export function solveJoints(world, dt, h) {
  const joints = world.joints;
  if (!joints.length) return;
  for (const j of joints) j._lambda = 0;
  for (let round = 0; round < ROUNDS; round++) {
    for (const j of joints) {
      if (j.broken) continue;
      const A = j.recA;
      const B = j.recB;
      if (!A || (j.b && !B)) continue;
      h.build(A);
      if (B) h.build(B);
      solveOne(j, A, B, dt, h);
    }
  }
  for (const j of joints) {
    if (j.broken) continue;
    j.load = Math.abs(j._lambda) / (dt * dt);
    if (j.breakForce > 0 && j.load > j.breakForce) {
      j.broken = true;
      world.brokenJoints.push(j);
    }
    // a spring's give, damped: its two ends' speed apart along it slowed
    if (j.type === 'spring' && j.damping > 0) springDamping(j, j.recA, j.recB, dt, h);
  }
  world.joints = joints.filter((j) => !j.broken);
}

function solveOne(j, A, B, dt, h) {
  worldPoint(A, j.anchorA, _pA);
  worldPoint(B, j.anchorB, _pB);
  _e.subVectors(_pB, _pA);
  const d = _e.length();
  if (j.type === 'rope' || j.type === 'spring') {
    if (d < 1e-6) return;
    const C = d - j.length;
    if (j.type === 'rope' && C <= 0) return; // slack
    _n.copy(_e).divideScalar(d);
    j._lambda += point(A, B, _pA, _pB, _n, C, j.type === 'spring' ? 1 / Math.max(1e-3, j.stiffness) : 0, dt, h, j._lambda);
    return;
  }
  // the two anchors together: all three ways at once (one way at a time, a long
  // arm on a small body — a pendulum's bob — swung sideways each time it was pulled in)
  if (d > 1e-6) j._lambda -= together(A, B, _pA, _pB, _e, dt, h);
  if (j.type === 'hinge') {
    // the two axes one: B turned onto A's
    _aA.copy(j.axisA).applyQuaternion(turnOf(A, _qa));
    _aB.copy(j.axisB).applyQuaternion(turnOf(B, _qb));
    const angle = _aB.angleTo(_aA);
    if (angle > 1e-5) {
      _t.crossVectors(_aB, _aA);
      if (_t.lengthSq() > 1e-12) angular(A, B, _t.normalize().multiplyScalar(angle), dt, h);
    }
    if (j.max > j.min) {
      // how far round it has turned, about the axis, from where it started
      _aA.copy(j.axisA).applyQuaternion(turnOf(A, _qa));
      const rA = _r.copy(j.refA).applyQuaternion(_qa);
      const rB = _w.copy(j.refB).applyQuaternion(turnOf(B, _qb));
      rB.addScaledVector(_aA, -rB.dot(_aA));
      // (the joint's own body's turn from the other's: a door opening its way is +)
      const now = Math.atan2(_c.crossVectors(rB, rA).dot(_aA), rA.dot(rB));
      const lo = THREE.MathUtils.degToRad(j.min);
      const hi = THREE.MathUtils.degToRad(j.max);
      const fix = now < lo ? now - lo : now > hi ? now - hi : 0;
      if (Math.abs(fix) > 1e-5) angular(A, B, _t.copy(_aA).multiplyScalar(fix), dt, h);
    }
  } else if (j.type === 'fixed') {
    // B turned back to how it sat on A
    turnOf(A, _qa).multiply(j.qRel); // where B should be turned
    turnOf(B, _qb);
    _q.copy(_qa).multiply(_qb.invert()); // the turn from where B is to where it should be
    if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }
    const angle = 2 * Math.acos(Math.min(1, _q.w));
    if (angle > 1e-5) {
      const s = Math.sqrt(1 - _q.w * _q.w) || 1;
      angular(A, B, _t.set(_q.x / s, _q.y / s, _q.z / s).multiplyScalar(angle), dt, h);
    }
  } else if (j.type === 'ball' && j.cone > 0 && j.coneA && j.coneB) {
    // a cone to swing in: B's direction no further from A's than this
    _aA.copy(j.coneA).applyQuaternion(turnOf(A, _qa));
    _aB.copy(j.coneB).applyQuaternion(turnOf(B, _qb));
    const angle = _aB.angleTo(_aA);
    const most = THREE.MathUtils.degToRad(j.cone);
    if (angle > most) {
      _t.crossVectors(_aB, _aA);
      if (_t.lengthSq() > 1e-12) angular(A, B, _t.normalize().multiplyScalar(angle - most), dt, h);
    }
  }
}

/**
 * Bring two points `C` closer along n (from A's to B's): each body moved as
 * far as its give lets it, turned if it tumbles, its speed taking the change.
 * `compliance` (1 / stiffness) makes it soft: `sum` is the push it has given
 * already this slice, so a spring pulls as hard as its stretch says, however
 * many rounds (XPBD). Returns the push (for its load).
 */
function point(A, B, pA, pB, n, C, compliance, dt, h, sum = 0) {
  const wA = A ? h.give(A, pA, n) : 0;
  const wB = B ? h.give(B, pB, n) : 0;
  const soft = compliance / (dt * dt);
  const w = wA + wB + soft;
  if (w < 1e-12) return 0;
  const lambda = (-C - soft * sum) / w;
  if (B) shift(B, pB, _t.copy(n).multiplyScalar(lambda), dt, h);
  if (A) shift(A, pA, _t.copy(n).multiplyScalar(-lambda), dt, h);
  return lambda;
}

const _K = new THREE.Matrix3();
const _col = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _unit = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const _arm = new THREE.Vector3();
const _P = new THREE.Vector3();

/** How a push at p (each way: x, y, z) moves p: adds a body's share to the columns. */
function addGive(rec, p, h) {
  if (!rec || rec.body.type !== 'dynamic') return;
  const im = 1 / rec.body.mass;
  const spins = h.spins(rec);
  if (spins) _arm.subVectors(p, rec.col.center);
  for (let k = 0; k < 3; k++) {
    _col[k].addScaledVector(_unit[k], im);
    if (spins) {
      const turn = h.turn(rec, _r.crossVectors(_arm, _unit[k]), _w);
      _col[k].add(_r.crossVectors(turn, _arm));
    }
  }
}

/**
 * Bring two points together (e: from A's to B's): the push that closes the gap
 * exactly, all three ways at once (K⁻¹ e), shared as each body gives. Returns its size.
 */
function together(A, B, pA, pB, e, dt, h) {
  for (const c of _col) c.set(0, 0, 0);
  addGive(A, pA, h);
  addGive(B, pB, h);
  const [c0, c1, c2] = _col;
  _K.set(c0.x, c1.x, c2.x, c0.y, c1.y, c2.y, c0.z, c1.z, c2.z);
  if (Math.abs(_K.determinant()) < 1e-14) return 0;
  _P.copy(e).applyMatrix3(_K.invert()).negate();
  const pushA = _t.copy(_P).negate();
  if (A) shift(A, pA, pushA, dt, h);
  if (B) shift(B, pB, _P, dt, h);
  return _P.length();
}

/** Move a body (and turn it) by a push P at p; its speed (and spin) take the change. */
function shift(rec, p, P, dt, h) {
  if (rec.body.type !== 'dynamic') return;
  const o = rec.entity.object3D;
  const m = rec.body.mass;
  o.position.addScaledVector(P, 1 / m);
  rec.body.velocity.addScaledVector(P, 1 / (m * dt));
  if (h.spins(rec)) {
    const dTheta = h.turn(rec, _w.crossVectors(_r.subVectors(p, rec.col.center), P), new THREE.Vector3());
    rotate(rec, dTheta);
    rec.body.angularVelocity.addScaledVector(dTheta, 1 / dt);
  }
  h.build(rec);
}

/** Turn B by `rot` (a rotation vector) and A the other way, by how easily each turns. */
function angular(A, B, rot, dt, h) {
  const angle = rot.length();
  const n = _n.copy(rot).divideScalar(angle);
  const wA = A && h.spins(A) ? n.dot(h.turn(A, n, _va)) : 0;
  const wB = B && h.spins(B) ? n.dot(h.turn(B, n, _vb)) : 0;
  const w = wA + wB;
  if (w < 1e-12) return;
  const lambda = angle / w;
  if (B && wB > 0) {
    const d = h.turn(B, _t.copy(n).multiplyScalar(lambda), new THREE.Vector3());
    rotate(B, d);
    B.body.angularVelocity.addScaledVector(d, 1 / dt);
    h.build(B);
  }
  if (A && wA > 0) {
    const d = h.turn(A, _t.copy(n).multiplyScalar(-lambda), new THREE.Vector3());
    rotate(A, d);
    A.body.angularVelocity.addScaledVector(d, 1 / dt);
    h.build(A);
  }
}

/** Turn a body by a rotation vector, about its middle. */
function rotate(rec, dTheta) {
  const angle = dTheta.length();
  if (angle < 1e-9) return;
  const o = rec.entity.object3D;
  _q.setFromAxisAngle(_c.copy(dTheta).divideScalar(angle), angle);
  _back.subVectors(o.position, rec.col.center).applyQuaternion(_q);
  o.position.copy(rec.col.center).add(_back);
  o.quaternion.premultiply(_q).normalize();
}

function springDamping(j, A, B, dt, h) {
  worldPoint(A, j.anchorA, _pA);
  worldPoint(B, j.anchorB, _pB);
  _e.subVectors(_pB, _pA);
  const d = _e.length();
  if (d < 1e-6) return;
  _n.copy(_e).divideScalar(d);
  const vA = A ? h.velocityAt(A, _pA, _va) : _va.set(0, 0, 0);
  const vB = B ? h.velocityAt(B, _pB, _vb) : _vb.set(0, 0, 0);
  const apart = _t.subVectors(vB, vA).dot(_n);
  const wA = A ? h.give(A, _pA, _n) : 0;
  const wB = B ? h.give(B, _pB, _n) : 0;
  if (wA + wB < 1e-12) return;
  const J = -apart * Math.min(1, j.damping * dt) / (wA + wB);
  if (B) h.impulse(B, _pB, _t.copy(_n).multiplyScalar(J));
  if (A) h.impulse(A, _pA, _t.copy(_n).multiplyScalar(-J));
}

// ---------------------------------------------------------------- made from settings

/**
 * A joint between `a` and `b` (entities; b null: the world), set up from how
 * they stand now: the anchor (in a's frame, m) is where they are joined; the
 * axis (a's x, y or z) is a hinge's, and a cone's middle.
 */
export function makeJoint(a, b, { type = 'ball', anchor = [0, 0, 0], axis = 'y', min = 0, max = 0, cone = 0, length = 0, stiffness = 200, damping = 4, breakForce = 0 } = {}) {
  const oa = a.object3D;
  const ob = b?.object3D ?? null;
  oa.updateMatrixWorld(true);
  ob?.updateMatrixWorld(true);
  const anchorA = new THREE.Vector3(...anchor);
  const pA = anchorA.clone().applyQuaternion(oa.quaternion).add(oa.position);
  const qA = oa.quaternion.clone();
  const qB = ob ? ob.quaternion.clone() : new THREE.Quaternion();
  const inB = (worldVec) => worldVec.clone().applyQuaternion(qB.clone().invert());
  const local = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const axisA = new THREE.Vector3(...(local[axis] || local.y));
  const refA = new THREE.Vector3(...(axis === 'y' ? local.x : local.y));
  const spec = { a, b, type, anchorA, min, max, cone, stiffness, damping, breakForce };
  if (type === 'rope' || type === 'spring') {
    // joined at the other's middle (or a point in the world)
    spec.anchorB = ob ? new THREE.Vector3() : pA.clone();
    const other = ob ? ob.position : pA;
    spec.length = length > 0 ? length : pA.distanceTo(other);
  } else {
    spec.anchorB = ob ? inB(pA.clone().sub(ob.position)) : pA.clone();
    const axisW = axisA.clone().applyQuaternion(qA);
    const refW = refA.clone().applyQuaternion(qA);
    spec.axisA = axisA;
    spec.axisB = inB(axisW);
    spec.refA = refA;
    spec.refB = inB(refW);
    spec.coneA = axisA.clone();
    spec.coneB = inB(axisW);
    spec.qRel = qA.clone().invert().multiply(qB);
  }
  return new Joint(spec);
}

// ---------------------------------------------------------------- the component

export const JOINT_COMPONENTS = {
  joint: {
    label: 'Joint',
    hint: 'Joins this object to another (or to a point in the world, where it is): a hinge turns about one axis (a door, a gate, a lever), '
      + 'a ball any way (a pendulum, a chain\'s link, a hanging lamp), fixed holds it as it is (welded), a rope keeps them no further apart than '
      + 'its length, a spring pulls them back to it. The anchor is where they are joined, in metres from this object\'s middle, along its own '
      + 'axes. It needs a Dynamic body (a hinge, a ball and fixed make it tumble, so it can turn). "Breaks at" pulls it apart when it is '
      + 'pulled harder than that (newtons): rules hear "A joint breaks".',
    props: {
      type: { type: 'select', options: JOINT_TYPES, default: 'hinge', label: 'Kind' },
      to: { type: 'text', default: '', label: 'To (an object; empty: the world)' },
      anchorX: { type: 'number', default: 0, min: -100, max: 100, step: 0.05, label: 'Anchor X (m)' },
      anchorY: { type: 'number', default: 0, min: -100, max: 100, step: 0.05, label: 'Anchor Y (m)' },
      anchorZ: { type: 'number', default: 0, min: -100, max: 100, step: 0.05, label: 'Anchor Z (m)' },
      axis: { type: 'select', options: ['x', 'y', 'z'], default: 'y', label: 'Axis', showIf: { type: ['hinge', 'ball'] } },
      min: { type: 'number', default: 0, min: -180, max: 180, step: 5, label: 'Turns from (°)', showIf: { type: ['hinge'] } },
      max: { type: 'number', default: 0, min: -180, max: 180, step: 5, label: 'Turns to (°)', showIf: { type: ['hinge'] }, hint: 'Both 0: as far as it likes' },
      cone: { type: 'number', default: 0, min: 0, max: 180, step: 5, label: 'Swings at most (°)', showIf: { type: ['ball'] }, hint: '0: any way at all' },
      length: { type: 'number', default: 0, min: 0, max: 1000, step: 0.1, label: 'Length (m)', showIf: { type: ['rope', 'spring'] }, hint: '0: as far apart as they stand' },
      stiffness: { type: 'number', default: 200, min: 1, max: 100000, step: 10, label: 'Stiffness', showIf: { type: ['spring'] } },
      damping: { type: 'number', default: 4, min: 0, max: 100, step: 0.5, label: 'Damping', showIf: { type: ['spring'] } },
      breakForce: { type: 'number', default: 0, min: 0, max: 1e7, step: 100, label: 'Breaks at (N)', hint: '0: never' },
      collide: { type: 'boolean', default: false, label: 'The two still collide' },
    },
    update(ctx) {
      const { entity, props, state, engine, api } = ctx;
      const world = engine.physics;
      if (!world?.addJoint) return;
      if (!state.joint && !state.failed) {
        if (entity.rigidBody?.type !== 'dynamic') {
          state.failed = true;
          console.warn(`[Tiny3] Joint on "${entity.object3D.name}": it needs a Dynamic body.`);
          return;
        }
        let other = null;
        if (props.to && props.to.trim()) {
          const o = api.findObject(props.to.trim());
          other = o ? (engine.entities || []).find((e) => e.object3D === o) ?? null : null;
          if (!other) return; // not there yet (spawned later?): tried again next frame
        }
        // turning about its anchor: it must tumble (a hinge, a ball, a weld turn it)
        if (['hinge', 'ball', 'fixed'].includes(props.type) && !entity.rigidBody.tumbles) entity.rigidBody.tumbles = true;
        state.joint = world.addJoint(makeJoint(entity, other, {
          type: props.type, anchor: [props.anchorX, props.anchorY, props.anchorZ], axis: props.axis,
          min: props.min, max: props.max, cone: props.cone, length: props.length,
          stiffness: props.stiffness, damping: props.damping, breakForce: props.breakForce,
        }));
        if (other && !props.collide) world.keepApart(entity, other);
        state.other = other;
        return;
      }
      if (state.joint?.broken && !state.said) {
        state.said = true;
        world.keepApart(entity, state.other, false);
        engine.gameplay?.rules?.on('jointBreaks', entity, state.other, api, ctx.time);
      }
    },
    dispose({ engine, state }) {
      if (state?.joint) engine.physics?.removeJoint?.(state.joint);
    },
  },
};
