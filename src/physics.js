import * as THREE from 'three';
import { meshShape, capsuleTriangle, boxTriangle, closestOnTriangle } from './mesh-collider.js';
import { solveJoints } from './joints.js';
import { matchesWho } from './groups.js';
import { partRoles } from './physics-parts.js';

/**
 * Tiny3 Physics — rigid bodies, collision shapes, contacts and raycasts.
 *
 * Body types:
 *   static   : never moves, blocks everything
 *   kinematic: moved by code/animations, blocks dynamic bodies but is not pushed
 *   dynamic  : gravity + velocity + collision response
 *
 * Shapes (RigidBody.shape):
 *   auto    : a sphere for sphere meshes, a box for everything else
 *   box     : static and kinematic boxes turn with their object — a tilted plank
 *             collides as a tilted plank; moving (dynamic) bodies keep an upright
 *             box, so a character turning to face its run never shoves into walls
 *   sphere  : round, the size of the object
 *   capsule : an upright pill — rounded feet slide over small steps and ledges
 *   mesh    : its real triangles (see mesh-collider.js) — a model's rooms, stairs
 *             and hills. For static and kinematic bodies; a dynamic one uses a box
 *
 * Tumbling (RigidBody.tumbles): a dynamic body that turns as well as moves —
 * crates topple off ledges, barrels and balls roll, a stack knocked over falls
 * apart. Its shape turns with it, and each contact pushes at the points that
 * touch, so a push off-centre spins it. Off by default: a character must stay
 * upright, and one that isn't marked keeps the steady upright shape.
 *
 * The world steps in fixed 1/60 s slices however fast the screen draws, so a
 * jump is the same height at 30 and at 144 frames per second; drawing is
 * smoothed between slices (applyInterpolation). Ground up to 60° counts as
 * ground; up to ~45° it is treated like flat ground (lifted straight up, only
 * the fall stopped), so a body stands still on it and walks up it at full speed.
 * Steeper than that, it slides. A capsule body (a character) steps up ledges,
 * kerbs and stairs up to 0.45 m. Sudden rises and drops while walking (a step,
 * a rock) are drawn eased over a moment, camera included: the physics is where
 * it is, the picture glides (object3D.userData.smoothY holds the difference).
 */

export const BODY_TYPES = ['static', 'kinematic', 'dynamic'];
/** How hard a dynamic body falls (m/s²) unless it says otherwise — a snappy, game-like pull. */
export const DEFAULT_GRAVITY = -24;
export const BODY_SHAPES = ['auto', 'box', 'sphere', 'capsule', 'mesh'];
export const FIXED_STEP = 1 / 60;

const WALKABLE = 0.5; // contact normal.y above this is ground (up to 60°)
const STICKY = 0.7;   // ...above this (up to ~45°) a body stands still without sliding
/** The steepest ground this body stands on (its Movement's "Steepest slope"; 60° unless set): normal.y above this. */
const walkable = (body) => (body.maxSlope > 0 ? Math.cos(Math.min(89, body.maxSlope) * Math.PI / 180) : WALKABLE);
/** Its weight when shoving a tumbling body: × its "Push strength" (1 unless set; 0: it gives way). */
const pushMass = (body) => body.mass * (body.pushStrength >= 0 ? Math.max(1e-3, body.pushStrength) : 1);
/** The most it pushes another moving body with in a slice (an impulse): its Push strength × its weight. */
const pushCap = (body, dt) => (body.pushStrength >= 0 ? body.pushStrength * body.mass * Math.abs(body.gravity || DEFAULT_GRAVITY) * dt : Infinity);
const SNAP = 0.3;     // how far a walking body is pulled down to stay on a slope (more when fast)
const SNAP_MAX = 1;   // ...at most, however fast
// a character (a capsule) walking into a ledge, kerb, stair or rock no higher
// than this steps up onto it (RigidBody.stepHeight changes it; 0 = never)
export const STEP_UP = 0.45;
const SOFTEN = 0.8;   // a sudden rise or drop on the ground is drawn eased out: this much left each slice
const SOFT_MAX = 0.6; // ...never lagging more than this (m)
const MIN_HALF = 0.05;
// bodies this close are paired for testing: more than the slope snap and the solver's pushes
const PAIR_MARGIN = 0.2;
// tumbling bodies
const SOLVE_ROUNDS = 10;     // passes over their contacts each slice: more, steadier stacks
const SINK_FIX = 0.8;        // how much of its sinking in a tumbling body climbs out of each slice...
const SINK_OK = 0.003;       // ...leaving this much (m), so touching stays touching
const SINK_DEEP = 0.02;      // sunk deeper than this (a hard landing): the rest is pushed straight out
const BOUNCE_MIN = 1;        // m/s: hitting slower than this doesn't bounce (resting stays at rest)
const SPIN_DRAG = 0.05;      // the air slows a spin, a little
const ROLL_DRAG = 1.2;       // × friction: spinning on the ground slows (a crate stops rocking)
const ROLL_RESIST = 0.1;     // × friction × its weight: a rolling ball slows steadily and stops (grass, not ice)
const REST_SPEED = 0.1;      // m/s: slower than this on the ground for a moment...
const REST_SPIN = 0.2;       // ...turning slower than this (rad/s)...
const REST_TIME = 0.3;       // ...for this long (s): it has come to rest, and is held still

export class RigidBody {
  constructor({
    type = 'static', mass = 1, restitution = 0, friction = 0.5,
    gravity = DEFAULT_GRAVITY, isTrigger = false, shape = 'auto', tumbles = false, ignores = [],
  } = {}) {
    this.type = type; // static | kinematic | dynamic
    this.mass = Math.max(0.001, mass);
    this.invMass = this.type === 'dynamic' ? 1 / this.mass : 0;
    this.restitution = restitution;
    this.friction = friction;
    this.gravity = gravity;
    // A trigger detects overlaps but never blocks anything — the basis of
    // pickups, checkpoints, damage zones and goal areas.
    this.isTrigger = !!isTrigger;
    this.shape = BODY_SHAPES.includes(shape) ? shape : 'auto';
    // how high a capsule steps up onto ledges and stairs, and whether sudden rises
    // are drawn eased (set per frame by the Movement feel component; not saved)
    this.stepHeight = STEP_UP;
    this.smoothSteps = true;
    // hold this high above the ground below (m; 0 = off): hovercraft, drones, flyers
    this.hover = 0;
    // turns as well as moves (dynamic bodies only): topples, spins and rolls
    this.tumbles = !!tumbles;
    // what it passes through, as if neither were there: groups ('group:Ghosts'),
    // 'player', or objects by name — either one saying so is enough. A trigger
    // passing through something isn't set off by it either.
    this.ignores = Array.isArray(ignores) ? ignores.filter((s) => typeof s === 'string' && s.trim()) : [];

    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    this.grounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundRec = null; // what it stands on, so a moving platform can carry it

    // half-extents used for AABB collision; computed from object bounding box if not set
    this.halfExtents = null;
  }

  toJSON() {
    return {
      type: this.type,
      mass: this.mass,
      restitution: this.restitution,
      friction: this.friction,
      isTrigger: this.isTrigger,
      shape: this.shape,
      gravity: this.gravity,
      tumbles: this.tumbles,
      ...(this.ignores.length ? { ignores: [...this.ignores] } : {}),
    };
  }
}

/** What the joint solver needs of a body (joints.js). */
const JOINT_HELPERS = {
  give: (rec, p, d) => giveAt(rec, p, d),
  turn: (rec, v, out) => turnBy(rec, v, out),
  spins: (rec) => isTumbling(rec.body) && !!rec.invI,
  build: (rec) => buildCollider(rec),
  velocityAt: (rec, p, out) => velocityAt(rec, p, out),
  impulse: (rec, p, J) => impulseAt(rec, p, J),
};

/** A body that turns as it moves (see RigidBody.tumbles). */
export const isTumbling = (body) => !!body && body.type === 'dynamic' && body.tumbles && !body.isTrigger;

/** Get (or create) the RigidBody on an entity. */
export function getBody(entity) {
  return entity?.rigidBody ?? null;
}

export function setBody(entity, body) {
  entity.rigidBody = body;
}

const _box = new THREE.Box3();

/**
 * Compute a world-space AABB for an Object3D.
 * Pass `out` ({ center, halfSize }) to fill an existing pair of vectors instead
 * of allocating.
 */
export function getWorldAABB(object3D, out = null) {
  const center = out ? out.center : new THREE.Vector3();
  const halfSize = out ? out.halfSize : new THREE.Vector3();

  _box.setFromObject(object3D);
  if (_box.isEmpty()) {
    // no geometry (an empty, or a light with a rigid body) — a point at its origin,
    // padded below. Without this the collider would sit at the world origin.
    object3D.getWorldPosition(center);
    halfSize.set(0, 0, 0);
  } else {
    _box.getCenter(center);
    _box.getSize(halfSize);
  }

  // for flat geometry (plane), give it a minimal thickness so it can collide
  if (halfSize.y < 0.01) halfSize.y = 0.1;
  // if size is zero in any axis (e.g. degenerate), pad it
  if (halfSize.x < 0.01) halfSize.x = 0.1;
  if (halfSize.z < 0.01) halfSize.z = 0.1;
  halfSize.multiplyScalar(0.5);
  // never allow a zero half-extent
  if (halfSize.x < MIN_HALF) halfSize.x = MIN_HALF;
  if (halfSize.y < MIN_HALF) halfSize.y = MIN_HALF;
  if (halfSize.z < MIN_HALF) halfSize.z = MIN_HALF;

  return out || { center, halfSize };
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

// ---------------------------------------------------------------- colliders

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _part = new THREE.Box3();
const _back = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _hoverFrom = new THREE.Vector3();
const _nudge = new THREE.Vector3();

function makeCollider() {
  return {
    kind: 'box',
    center: new THREE.Vector3(),
    at: new THREE.Vector3(), // where its object stood when it was built (see _sweep)
    q: new THREE.Quaternion(), // ...how it was turned, and sized: moved since? (see _fresh)
    s: new THREE.Vector3(),
    built: false,
    half: new THREE.Vector3(),
    axes: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
    a: new THREE.Vector3(), // capsule segment ends (a sphere has a === b)
    b: new THREE.Vector3(),
    r: 0,
    min: new THREE.Vector3(),
    max: new THREE.Vector3(),
    // where its centre was before this step: which side of a thin floor it came from
    prev: new THREE.Vector3(),
    // a mesh collider's triangles, and where the object stands (its own space <-> the world)
    mesh: null,
    matrix: new THREE.Matrix4(),
    inverse: new THREE.Matrix4(),
  };
}

/** The object's size in its own space (its own position, turn and scale removed). */
export function measureLocal(o, out, skip = null) {
  out.makeEmpty();
  o.updateWorldMatrix(true, true);
  if (Math.abs(o.matrixWorld.determinant()) < 1e-12) return out; // squashed flat: no size
  _inv.copy(o.matrixWorld).invert();
  o.traverse((n) => {
    const g = n.geometry;
    if (!g || !g.attributes?.position || skip?.has(n)) return; // a part with a role of its own
    let box;
    if (n.isSkinnedMesh) {
      // where the skin really is: a rigged mesh's raw vertices sit wherever its
      // file left them, which made a character's collider huge and lifted it
      // off the ground
      n.computeBoundingBox();
      box = n.boundingBox;
    } else {
      if (!g.boundingBox) g.computeBoundingBox();
      box = g.boundingBox;
    }
    _rel.multiplyMatrices(_inv, n.matrixWorld);
    out.union(_part.copy(box).applyMatrix4(_rel));
  });
  return out;
}

function shapeOf(rec) {
  const shape = rec.body.shape;
  // a moving body can't be a mesh (it has no inside to be pushed out of): a box
  if (shape === 'mesh') return rec.body.type === 'dynamic' ? 'box' : 'mesh';
  if (shape && shape !== 'auto') return shape;
  const o = rec.entity.object3D;
  return o.isMesh && o.geometry?.type === 'SphereGeometry' ? 'sphere' : 'box';
}

/** Rebuild a body's collider from where its object is now. */
function buildCollider(rec) {
  const o = rec.entity.object3D;
  const col = rec.col;
  o.updateWorldMatrix(true, false);
  if (!rec.local) rec.local = measureLocal(o, new THREE.Box3(), rec.skip);
  // a body may say what its box is, in its object's own space (a car's: from its
  // wheels' middles up, so its springs hold it off the ground — see vehicle.js)
  const local = rec.body.box || rec.local;
  col.at.copy(o.position);
  col.q.copy(o.quaternion);
  col.s.copy(o.scale);
  col.built = true;
  o.matrixWorld.decompose(_p, _q, _s);
  _s.set(Math.abs(_s.x), Math.abs(_s.y), Math.abs(_s.z));
  if (local.isEmpty()) {
    col.center.copy(_p);
    col.half.set(0, 0, 0);
  } else {
    local.getCenter(_c);
    col.center.copy(_c).applyMatrix4(o.matrixWorld);
    local.getSize(col.half).multiply(_s).multiplyScalar(0.5);
  }
  col.half.set(Math.max(MIN_HALF, col.half.x), Math.max(MIN_HALF, col.half.y), Math.max(MIN_HALF, col.half.z));

  // where its centre was before this step (dynamic bodies move; the rest are where they were)
  col.prev.copy(col.center);
  if (rec.prev && rec.body.type === 'dynamic') col.prev.add(_back.subVectors(rec.prev, o.position));

  let shape = shapeOf(rec);
  if (shape === 'mesh') {
    if (rec.mesh === undefined) rec.mesh = meshShape(o, rec.skip); // built once; null: no triangles
    if (rec.mesh) {
      col.kind = 'mesh';
      col.mesh = rec.mesh;
      col.matrix.copy(o.matrixWorld);
      col.inverse.copy(o.matrixWorld).invert();
      _part.copy(rec.mesh.box).applyMatrix4(o.matrixWorld);
      col.min.copy(_part.min);
      col.max.copy(_part.max);
      return col;
    }
    shape = 'box';
  }
  col.mesh = null;
  // a moving body stays upright, unless it tumbles; everything else turns with its object
  const tumbles = isTumbling(rec.body);
  if (rec.body.type === 'dynamic' && !tumbles) {
    col.axes[0].set(1, 0, 0); col.axes[1].set(0, 1, 0); col.axes[2].set(0, 0, 1);
  } else {
    col.axes[0].set(1, 0, 0).applyQuaternion(_q);
    col.axes[1].set(0, 1, 0).applyQuaternion(_q);
    col.axes[2].set(0, 0, 1).applyQuaternion(_q);
  }
  if (tumbles) inertiaOf(rec, shape);
  if (shape === 'box') {
    col.kind = 'box';
    for (const k of ['x', 'y', 'z']) {
      const e = Math.abs(col.axes[0][k]) * col.half.x + Math.abs(col.axes[1][k]) * col.half.y
        + Math.abs(col.axes[2][k]) * col.half.z;
      col.min[k] = col.center[k] - e;
      col.max[k] = col.center[k] + e;
    }
  } else {
    col.kind = 'capsule';
    if (shape === 'sphere') {
      col.r = Math.max(col.half.x, col.half.y, col.half.z);
      col.a.copy(col.center);
      col.b.copy(col.center);
    } else {
      // An upright pill round the body. Outstretched arms (or a T-pose) must not
      // make a character a barrel: no wider than half its height, unless its
      // narrower side is wider still.
      const wide = Math.max(col.half.x, col.half.z);
      const narrow = Math.min(col.half.x, col.half.z);
      col.r = Math.min(wide, Math.max(col.half.y * 0.5, narrow));
      const h = Math.max(0, col.half.y - col.r);
      // upright — unless it tumbles: then along the object's own up (a barrel on its side)
      const along = tumbles ? col.axes[1] : _yAxis;
      col.a.copy(col.center).addScaledVector(along, -h);
      col.b.copy(col.center).addScaledVector(along, h);
    }
    col.min.copy(col.a).min(col.b).subScalar(col.r);
    col.max.copy(col.a).max(col.b).addScalar(col.r);
  }
  return col;
}

/**
 * How hard a tumbling body is to turn about each of its own axes, as
 * 1 / moment of inertia (rec.invI): a solid box of its size, or a ball.
 */
function inertiaOf(rec, shape) {
  const { half } = rec.col;
  const m = rec.body.mass;
  if (!rec.invI) rec.invI = new THREE.Vector3();
  if (shape === 'sphere') {
    const r = Math.max(half.x, half.y, half.z);
    rec.invI.setScalar(1 / (0.4 * m * r * r));
    return;
  }
  const [x2, y2, z2] = [half.x * half.x, half.y * half.y, half.z * half.z];
  rec.invI.set(3 / (m * (y2 + z2)), 3 / (m * (x2 + z2)), 3 / (m * (x2 + y2)));
}

function moveCollider(col, d) {
  col.center.add(d);
  col.a.add(d);
  col.b.add(d);
  col.min.add(d);
  col.max.add(d);
}

const boundsOverlap = (A, B) => A.min.x < B.max.x && A.max.x > B.min.x
  && A.min.y < B.max.y && A.max.y > B.min.y && A.min.z < B.max.z && A.max.z > B.min.z;

// ---------------------------------------------------------------- contacts
// Each returns { n, depth }: move A by n * depth to separate it from B.

const _d = new THREE.Vector3();
const _L = new THREE.Vector3();
const _x = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _cq = new THREE.Vector3();

const _R = new Float64Array(9); // A's axes against B's (dot products), for boxBox
const _AR = new Float64Array(9);
const _tA = new Float64Array(3);
const _tB = new Float64Array(3);
const _hA = new Float64Array(3);
const _hB = new Float64Array(3);

/**
 * Oriented box vs oriented box: the separating-axis test (15 axes) — which
 * axis they overlap least along is the way out, and by how much. Worked out
 * from the dot products of their axes, once: an edge-against-edge axis needs
 * no cross product until it wins. (It made a closure and a vector each call,
 * and a pile of crates asks it thousands of times a slice.)
 */
function boxBox(A, B) {
  const a = A.axes;
  const b = B.axes;
  const dx = B.center.x - A.center.x;
  const dy = B.center.y - A.center.y;
  const dz = B.center.z - A.center.z;
  _hA[0] = A.half.x; _hA[1] = A.half.y; _hA[2] = A.half.z;
  _hB[0] = B.half.x; _hB[1] = B.half.y; _hB[2] = B.half.z;
  for (let i = 0; i < 3; i++) {
    _tA[i] = dx * a[i].x + dy * a[i].y + dz * a[i].z;
    _tB[i] = dx * b[i].x + dy * b[i].y + dz * b[i].z;
    for (let j = 0; j < 3; j++) {
      const r = a[i].x * b[j].x + a[i].y * b[j].y + a[i].z * b[j].z;
      _R[i * 3 + j] = r;
      _AR[i * 3 + j] = Math.abs(r);
    }
  }
  let best = Infinity;
  let depth = 0;
  let axis = -1; // 0-2 A's faces, 3-5 B's, 6-14 an edge of A's (i) across one of B's (j): 6 + 3i + j
  let sign = 1;
  // A's faces
  for (let i = 0; i < 3; i++) {
    const rB = _hB[0] * _AR[i * 3] + _hB[1] * _AR[i * 3 + 1] + _hB[2] * _AR[i * 3 + 2];
    const overlap = _hA[i] + rB - Math.abs(_tA[i]);
    if (overlap <= 0) return null; // a gap: not touching
    if (overlap < best) { best = overlap; depth = overlap; axis = i; sign = _tA[i] > 0 ? -1 : 1; }
  }
  // B's faces
  for (let j = 0; j < 3; j++) {
    const rA = _hA[0] * _AR[j] + _hA[1] * _AR[3 + j] + _hA[2] * _AR[6 + j];
    const overlap = rA + _hB[j] - Math.abs(_tB[j]);
    if (overlap <= 0) return null;
    if (overlap < best) { best = overlap; depth = overlap; axis = 3 + j; sign = _tB[j] > 0 ? -1 : 1; }
  }
  // an edge of each: very slightly disfavoured, so faces win ties (steadier resting)
  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3;
    const i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j++) {
      const len = Math.sqrt(Math.max(0, 1 - _R[i * 3 + j] * _R[i * 3 + j]));
      if (len < 1e-6) continue; // parallel edges give no axis
      const j1 = (j + 1) % 3;
      const j2 = (j + 2) % 3;
      const rA = _hA[i1] * _AR[i2 * 3 + j] + _hA[i2] * _AR[i1 * 3 + j];
      const rB = _hB[j1] * _AR[i * 3 + j2] + _hB[j2] * _AR[i * 3 + j1];
      const dist = _tA[i2] * _R[i1 * 3 + j] - _tA[i1] * _R[i2 * 3 + j];
      const overlap = (rA + rB - Math.abs(dist)) / len;
      if (overlap <= 0) return null;
      if (overlap * 1.05 < best) { best = overlap * 1.05; depth = overlap; axis = 6 + i * 3 + j; sign = dist > 0 ? -1 : 1; }
    }
  }
  const n = new THREE.Vector3();
  if (axis < 3) n.copy(a[axis]);
  else if (axis < 6) n.copy(b[axis - 3]);
  else {
    const i = Math.floor((axis - 6) / 3);
    n.crossVectors(a[i], b[(axis - 6) % 3]).normalize();
  }
  return { n: n.multiplyScalar(sign), depth };
}

function closestOnSegment(a, b, p, out) {
  _x.subVectors(b, a);
  const len2 = _x.lengthSq();
  const t = len2 < 1e-12 ? 0 : THREE.MathUtils.clamp(_L.subVectors(p, a).dot(_x) / len2, 0, 1);
  return out.copy(a).addScaledVector(_x, t);
}

function closestOnBox(B, p, out) {
  _L.subVectors(p, B.center);
  out.copy(B.center);
  for (let i = 0; i < 3; i++) {
    const h = B.half.getComponent(i);
    out.addScaledVector(B.axes[i], THREE.MathUtils.clamp(_L.dot(B.axes[i]), -h, h));
  }
  return out;
}

/** Capsule (or sphere) vs oriented box. */
function capsuleBox(C, B) {
  closestOnSegment(C.a, C.b, B.center, _cp);
  for (let k = 0; k < 4; k++) {
    closestOnBox(B, _cp, _cq);
    closestOnSegment(C.a, C.b, _cq, _cp);
  }
  closestOnBox(B, _cp, _cq);
  _d.subVectors(_cp, _cq);
  const dist = _d.length();
  if (dist >= C.r) return null;
  if (dist > 1e-6) return { n: _d.clone().divideScalar(dist), depth: C.r - dist };
  // the capsule's core is inside the box: leave by the nearest face
  _d.subVectors(_cp, B.center);
  let best = Infinity;
  const n = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 3; i++) {
    const l = _d.dot(B.axes[i]);
    const pen = B.half.getComponent(i) - Math.abs(l);
    if (pen < best) { best = pen; n.copy(B.axes[i]).multiplyScalar(l >= 0 ? 1 : -1); }
  }
  return { n, depth: best + C.r };
}

/** Closest points between two segments (Ericson, Real-Time Collision Detection 5.1.9). */
function closestSegSeg(p1, q1, p2, q2, c1, c2) {
  const d1 = new THREE.Vector3().subVectors(q1, p1);
  const d2 = new THREE.Vector3().subVectors(q2, p2);
  const r = new THREE.Vector3().subVectors(p1, p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  const eps = 1e-12;
  let s;
  let t;
  if (a <= eps && e <= eps) { s = 0; t = 0; }
  else if (a <= eps) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e <= eps) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > eps ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  c1.copy(p1).addScaledVector(d1, s);
  c2.copy(p2).addScaledVector(d2, t);
}

function capsuleCapsule(A, B) {
  closestSegSeg(A.a, A.b, B.a, B.b, _cp, _cq);
  _d.subVectors(_cp, _cq);
  const dist = _d.length();
  const reach = A.r + B.r;
  if (dist >= reach) return null;
  const n = dist > 1e-6 ? _d.clone().divideScalar(dist) : new THREE.Vector3(0, 1, 0);
  return { n, depth: reach - dist };
}

const _lmin = new THREE.Vector3();
const _lmax = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _ta = new THREE.Vector3();
const _tb = new THREE.Vector3();
const _tc = new THREE.Vector3();

/**
 * Box or capsule A against mesh M: the triangles near A (found in M's own
 * space), each tested where it is in the world. One contact per call — the
 * solver asks again until nothing overlaps: a capsule's deepest first (a flat
 * floor's face before a seam's edge), a box's shallowest (the side of a table
 * before its top, so it is stopped, not lifted onto it).
 */
function meshContact(A, M) {
  _lmin.set(Infinity, Infinity, Infinity);
  _lmax.set(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    _corner.set(i & 1 ? A.max.x : A.min.x, i & 2 ? A.max.y : A.min.y, i & 4 ? A.max.z : A.min.z)
      .applyMatrix4(M.inverse);
    _lmin.min(_corner);
    _lmax.max(_corner);
  }
  const { tris, bvh } = M.mesh;
  const isBox = A.kind === 'box';
  let best = null;
  bvh.query(_lmin, _lmax, (t) => {
    const p = t * 9;
    _ta.set(tris[p], tris[p + 1], tris[p + 2]).applyMatrix4(M.matrix);
    _tb.set(tris[p + 3], tris[p + 4], tris[p + 5]).applyMatrix4(M.matrix);
    _tc.set(tris[p + 6], tris[p + 7], tris[p + 8]).applyMatrix4(M.matrix);
    const c = isBox ? boxTriangle(A, _ta, _tb, _tc, A.prev) : capsuleTriangle(A, _ta, _tb, _tc, A.prev);
    if (!c || !(c.depth > 0)) return;
    if (!best || (isBox ? c.depth < best.depth : c.depth > best.depth)) best = c;
  });
  return best;
}

/** How to push collider A out of collider B, or null if they don't touch. */
export function contactBetween(A, B) {
  if (B.kind === 'mesh') return A.kind === 'mesh' ? null : meshContact(A, B);
  if (A.kind === 'mesh') {
    const c = meshContact(B, A);
    if (c) c.n.negate();
    return c;
  }
  if (A.kind === 'box' && B.kind === 'box') return boxBox(A, B);
  if (A.kind === 'capsule' && B.kind === 'box') return capsuleBox(A, B);
  if (A.kind === 'box' && B.kind === 'capsule') {
    const c = capsuleBox(B, A);
    if (c) c.n.negate();
    return c;
  }
  return capsuleCapsule(A, B);
}

// ---------------------------------------------------------------- tumbling

const _pts = Array.from({ length: 8 }, () => new THREE.Vector3());
const _ids = new Int8Array(8); // which corner (or end) each point is, to match it up next slice
const _depths = new Float64Array(8); // how far each point has sunk in
const _corners8 = Array.from({ length: 8 }, () => new THREE.Vector3());
const _reach = new Float64Array(8);
const _k1 = new THREE.Vector3();
const _k2 = new THREE.Vector3();
const _k3 = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _r = new THREE.Vector3();
const _rd = new THREE.Vector3();
const _w = new THREE.Vector3();
const _t = new THREE.Vector3();
const _r2 = new THREE.Vector3();
const _ZERO3 = Object.freeze(new THREE.Vector3()); // a still body's motion: only ever read
const _spin = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/** How near counts as touching for a body's corners: a little, for its size. */
const touchOf = (col) => Math.max(0.004, 0.04 * Math.min(col.half.x, col.half.y, col.half.z));

/** The point of mesh M's surface nearest p, within `reach` (into out) — or null. */
function nearestOnMesh(M, p, reach, out) {
  _lmin.set(Infinity, Infinity, Infinity);
  _lmax.set(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    _corner.set(p.x + (i & 1 ? reach : -reach), p.y + (i & 2 ? reach : -reach), p.z + (i & 4 ? reach : -reach))
      .applyMatrix4(M.inverse);
    _lmin.min(_corner);
    _lmax.max(_corner);
  }
  const { tris, bvh } = M.mesh;
  let best = reach * reach;
  let found = false;
  bvh.query(_lmin, _lmax, (t) => {
    const q = t * 9;
    _ta.set(tris[q], tris[q + 1], tris[q + 2]).applyMatrix4(M.matrix);
    _tb.set(tris[q + 3], tris[q + 4], tris[q + 5]).applyMatrix4(M.matrix);
    _tc.set(tris[q + 6], tris[q + 7], tris[q + 8]).applyMatrix4(M.matrix);
    const d = closestOnTriangle(p, _ta, _tb, _tc, _k3).distanceToSquared(p);
    if (d <= best) { best = d; out.copy(_k3); found = true; }
  });
  return found ? out : null;
}

/**
 * Where tumbling collider T touches O (c: move T by c.n × c.depth), into
 * _pts (with _ids and _depths); returns how many. A box: the corners that
 * touch (see incidentCorners). A ball: one point; a pill: one, or both ends
 * when it lies along the surface.
 */
function contactPoints(T, O, c) {
  const n = c.n;
  let count = 0;
  if (T.kind === 'capsule') {
    if (O.kind === 'capsule') {
      closestSegSeg(T.a, T.b, O.a, O.b, _k1, _k2);
      _ids[count] = 0;
      _depths[count] = c.depth;
      _pts[count++].copy(_k1).addScaledVector(n, -(T.r - c.depth / 2));
      return count;
    }
    const sa = -T.a.dot(n);
    const sb = -T.b.dot(n);
    const top = Math.max(sa, sb);
    const touch = touchOf(T);
    if (sa >= top - touch) {
      _ids[count] = 0;
      _depths[count] = c.depth - (top - sa);
      _pts[count++].copy(T.a).addScaledVector(n, -(T.r - c.depth / 2));
    }
    if (sb >= top - touch && T.a.distanceToSquared(T.b) > 1e-12) {
      _ids[count] = 1;
      _depths[count] = c.depth - (top - sb);
      _pts[count++].copy(T.b).addScaledVector(n, -(T.r - c.depth / 2));
    }
    return count;
  }
  if (O.kind === 'capsule') {
    // a box against a ball or a pill (a character): the one point where they meet
    closestOnSegment(O.a, O.b, T.center, _k1);
    for (let k = 0; k < 4; k++) {
      closestOnBox(T, _k1, _k2);
      closestOnSegment(O.a, O.b, _k2, _k1);
    }
    _ids[count] = 0;
    _depths[count] = c.depth;
    _pts[count++].copy(_k1).addScaledVector(n, O.r - c.depth / 2);
    return count;
  }
  // Box against box: the normal is one box's face; the corners that touch it are
  // the other's. (A crate a little tilted on a level one touches by its own
  // corners — the lower crate's would say "flat", and it was never levelled.)
  if (O.kind === 'box' && squareTo(T, n) > squareTo(O, n) + 1e-6) {
    return incidentCorners(O, T, _dirIn.copy(n), c.depth, 10);
  }
  return incidentCorners(T, O, _dirIn.copy(n).negate(), c.depth, 0);
}

/** How square box B sits to direction n: 1 when one of its faces is across it. */
const squareTo = (B, n) => Math.max(Math.abs(B.axes[0].dot(n)), Math.abs(B.axes[1].dot(n)), Math.abs(B.axes[2].dot(n)));
const _dirIn = new THREE.Vector3();

/**
 * Box I's corners that reach furthest along `into` (into R) and are really
 * against R — all four under one lying flat, two along an edge, only the
 * ones still on a ledge when it hangs over. Into _pts/_ids/_depths.
 */
function incidentCorners(I, R, into, depth, idBase) {
  let count = 0;
  const touch = touchOf(I);
  let top = -Infinity;
  for (let i = 0; i < 8; i++) {
    const k = _corners8[i].copy(I.center)
      .addScaledVector(I.axes[0], i & 1 ? I.half.x : -I.half.x)
      .addScaledVector(I.axes[1], i & 2 ? I.half.y : -I.half.y)
      .addScaledVector(I.axes[2], i & 4 ? I.half.z : -I.half.z);
    _reach[i] = k.dot(into);
    if (_reach[i] > top) top = _reach[i];
  }
  const near = depth + touch;
  const far = 2 * Math.max(I.half.x, I.half.y, I.half.z);
  _k2.set(0, 0, 0);
  let lowest = 0;
  for (let i = 0; i < 8; i++) {
    if (_reach[i] < top - touch) continue;
    const k = _corners8[i];
    _k2.add(k);
    lowest++;
    // R's surface nearest this corner: the corner itself when it rests on R; when
    // it hangs past R's edge, that edge — so the part still on a ledge holds it up
    const on = R.kind === 'mesh' ? nearestOnMesh(R, k, far, _k1) : closestOnBox(R, k, _k1);
    if (!on) continue;
    _ids[count] = idBase + i;
    _depths[count] = depth - (top - _reach[i]);
    if (on.distanceTo(k) <= near) _pts[count++].copy(k);
    else if (closestOnBox(I, on, _k3).distanceTo(on) <= near) _pts[count++].copy(on);
  }
  if (count === 0) {
    // an edge across an edge: between its lowest corners and R's nearest surface
    _k2.divideScalar(lowest);
    _ids[count] = idBase + 8;
    _depths[count] = depth;
    if (R.kind === 'box') {
      closestOnBox(R, _k2, _k1);
      closestOnBox(I, _k1, _k3);
      _pts[count++].addVectors(_k1, _k3).multiplyScalar(0.5);
    } else {
      _pts[count++].copy(_k2);
    }
  }
  return count;
}

/** 1/inertia × v, in the world: how a twist v would spin a tumbling body. */
function turnBy(rec, v, out) {
  const { axes } = rec.col;
  const I = rec.invI;
  const x = axes[0].dot(v) * I.x;
  const y = axes[1].dot(v) * I.y;
  const z = axes[2].dot(v) * I.z;
  return out.set(0, 0, 0).addScaledVector(axes[0], x).addScaledVector(axes[1], y).addScaledVector(axes[2], z);
}

const spins = (rec) => isTumbling(rec.body) && !!rec.invI;

/** How fast a body's point p is moving (a still body's: not at all). */
function velocityAt(rec, p, out) {
  if (rec.body.type !== 'dynamic') return out.set(0, 0, 0);
  out.copy(rec.body.velocity);
  if (spins(rec)) out.add(_k3.crossVectors(rec.body.angularVelocity, _r.subVectors(p, rec.col.center)));
  return out;
}

/** How much a push along d at p changes that point's speed, per unit of push. */
function giveAt(rec, p, d) {
  if (rec.body.type !== 'dynamic') return 0;
  let k = 1 / rec.body.mass;
  if (spins(rec)) {
    _rd.crossVectors(_r.subVectors(p, rec.col.center), d);
    k += _rd.dot(turnBy(rec, _rd, _w));
  }
  return k;
}

/** Push a body at point p by impulse J (and turn it, if it tumbles). */
function impulseAt(rec, p, J) {
  if (rec.body.type !== 'dynamic') return;
  rec.body.velocity.addScaledVector(J, 1 / rec.body.mass);
  if (spins(rec)) {
    rec.body.angularVelocity.add(turnBy(rec, _rd.crossVectors(_r.subVectors(p, rec.col.center), J), _w));
  }
}

/**
 * A contact point's levers, worked out once a slice. For its push (n) and its
 * two frictions (t1, t2), what a push along each does to T and to O:
 *   [T's arm (r × d), T's turn per push (1/I · arm), O's arm, O's turn]
 * 36 numbers. Each of the solver's passes is then sums and products, not the
 * same cross products and inertia turns worked out again ten times a slice.
 */
function levers(T, O, p, dirs) {
  const J = new Float64Array(36);
  const tSpins = spins(T);
  const oSpins = O.body.type === 'dynamic' && spins(O);
  _r.subVectors(p, T.col.center);
  _r2.subVectors(p, O.col.center);
  for (let k = 0; k < 3; k++) {
    const d = dirs[k];
    const o = k * 12;
    if (tSpins) {
      _rd.crossVectors(_r, d);
      turnBy(T, _rd, _w);
      J[o] = _rd.x; J[o + 1] = _rd.y; J[o + 2] = _rd.z;
      J[o + 3] = _w.x; J[o + 4] = _w.y; J[o + 5] = _w.z;
    }
    if (oSpins) {
      _rd.crossVectors(_r2, d);
      turnBy(O, _rd, _w);
      J[o + 6] = _rd.x; J[o + 7] = _rd.y; J[o + 8] = _rd.z;
      J[o + 9] = _w.x; J[o + 10] = _w.y; J[o + 11] = _w.z;
    }
  }
  return J;
}

/** How much a push along direction k (0 n, 1 t1, 2 t2) changes the point's closing speed, per unit. */
function giveAlong(m, J, k) {
  const o = k * 12;
  return m.iMT + J[o] * J[o + 3] + J[o + 1] * J[o + 4] + J[o + 2] * J[o + 5]
    + m.iMO + J[o + 6] * J[o + 9] + J[o + 7] * J[o + 10] + J[o + 8] * J[o + 11];
}

/**
 * How fast T's point moves along direction k, against O's — from their
 * speeds and spins (lvT, avT, lvO, avO: the real ones, or the "pseudo" ones
 * of climbing out).
 */
function speedAlong(m, J, k, lvT, avT, lvO, avO) {
  const d = m.dirs[k];
  const o = k * 12;
  let v = lvT.x * d.x + lvT.y * d.y + lvT.z * d.z + avT.x * J[o] + avT.y * J[o + 1] + avT.z * J[o + 2];
  if (m.oDyn) v -= lvO.x * d.x + lvO.y * d.y + lvO.z * d.z + avO.x * J[o + 6] + avO.y * J[o + 7] + avO.z * J[o + 8];
  return v;
}

/** Push T by dj along direction k at the point — and O the other way. */
function pushAlong(m, J, k, dj, lvT, avT, lvO, avO) {
  const d = m.dirs[k];
  const o = k * 12;
  const a = dj * m.iMT;
  lvT.x += d.x * a; lvT.y += d.y * a; lvT.z += d.z * a;
  avT.x += J[o + 3] * dj; avT.y += J[o + 4] * dj; avT.z += J[o + 5] * dj;
  if (!m.oDyn) return;
  const b = dj * m.iMO;
  lvO.x -= d.x * b; lvO.y -= d.y * b; lvO.z -= d.z * b;
  avO.x -= J[o + 9] * dj; avO.y -= J[o + 10] * dj; avO.z -= J[o + 11] * dj;
}

/**
 * The contacts a tumbling body T has with O this slice, for the solver:
 * each point's push along the normal and its friction along two directions
 * across it, kept as running totals — a later pass may take back some of
 * what an earlier one gave, never more (things push, they don't pull).
 * That is what lets a crate rest on four corners without rocking. `warm`:
 * the same points' pushes last slice (by corner), given again straight
 * away — a stack stays settled instead of being solved from nothing each
 * slice, which left it swaying until it fell.
 */
function makeManifold(T, O, c, warm, dt) {
  const count = contactPoints(T.col, O.col, c);
  const n = c.n.clone();
  const t1 = new THREE.Vector3();
  if (Math.abs(n.y) < 0.9) t1.set(0, 1, 0).cross(n).normalize(); // any direction across the normal
  else t1.set(1, 0, 0).cross(n).normalize();
  const t2 = new THREE.Vector3().crossVectors(n, t1);
  const e = Math.max(T.body.restitution, O.body.type === 'dynamic' ? O.body.restitution : 0);
  const oDyn = O.body.type === 'dynamic';
  const m = {
    T, O, n, t1, t2, dirs: [n, t1, t2], points: [],
    mu: Math.sqrt(Math.max(0, T.body.friction) * Math.max(0, O.body.friction)),
    iMT: 1 / T.body.mass, iMO: oDyn ? 1 / O.body.mass : 0, oDyn,
  };
  const vT = T.body.velocity;
  const wT = T.body.angularVelocity;
  const vO = O.body.velocity;
  const wO = O.body.angularVelocity;
  for (let i = 0; i < count; i++) {
    const p = _pts[i].clone();
    const J = levers(T, O, p, m.dirs);
    const vn = speedAlong(m, J, 0, vT, wT, vO, wO);
    m.points.push({
      id: _ids[i],
      p,
      J,
      kn: giveAlong(m, J, 0),
      k1: giveAlong(m, J, 1),
      k2: giveAlong(m, J, 2),
      // hit hard enough: come off at e × the speed it hit. A corner not quite down yet
      // (a gap under it) may still close the gap this slice: it only holds if it would
      // pass through — otherwise a crate a degree off flat stood propped on it.
      bounce: _depths[i] < 0 ? _depths[i] / dt : vn < -BOUNCE_MIN ? -e * vn : 0,
      depth: Math.max(0, _depths[i]),
      jp: 0, // its push out of the sinking (see climbOut)
      jn: 0,
      j1: 0,
      j2: 0,
    });
  }
  if (warm) {
    const mu = m.mu;
    for (const c of m.points) {
      const w = warm.get(c.id);
      if (!w) continue;
      c.jn = w.jn;
      c.j1 = Math.min(mu * w.jn, Math.max(-mu * w.jn, w.j1));
      c.j2 = Math.min(mu * w.jn, Math.max(-mu * w.jn, w.j2));
      if (c.jn) pushAlong(m, c.J, 0, c.jn, vT, wT, vO, wO);
      if (c.j1) pushAlong(m, c.J, 1, c.j1, vT, wT, vO, wO);
      if (c.j2) pushAlong(m, c.J, 2, c.j2, vT, wT, vO, wO);
    }
  }
  return m;
}

/** One pass over a manifold's points: no closing in, then friction up to μ × the push. */
function solveManifold(m, backwards) {
  const vT = m.T.body.velocity;
  const wT = m.T.body.angularVelocity;
  const vO = m.O.body.velocity;
  const wO = m.O.body.angularVelocity;
  const { mu, points } = m;
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const c = points[backwards ? count - 1 - i : i]; // each way in turn: no corner goes first every time
    const J = c.J;
    if (c.kn > 0) {
      const vn = speedAlong(m, J, 0, vT, wT, vO, wO);
      const total = Math.max(0, c.jn + (c.bounce - vn) / c.kn);
      const dj = total - c.jn;
      c.jn = total;
      if (dj !== 0) pushAlong(m, J, 0, dj, vT, wT, vO, wO);
    }
    const most = mu * c.jn;
    if (c.k1 > 0) {
      const total = Math.min(most, Math.max(-most, c.j1 - speedAlong(m, J, 1, vT, wT, vO, wO) / c.k1));
      const dj = total - c.j1;
      c.j1 = total;
      if (dj !== 0) pushAlong(m, J, 1, dj, vT, wT, vO, wO);
    }
    if (c.k2 > 0) {
      const total = Math.min(most, Math.max(-most, c.j2 - speedAlong(m, J, 2, vT, wT, vO, wO) / c.k2));
      const dj = total - c.j2;
      c.j2 = total;
      if (dj !== 0) pushAlong(m, J, 2, dj, vT, wT, vO, wO);
    }
  }
}

/**
 * Climbing out of what it has sunk into, at each point — so a crate resting
 * a little tilted is levelled as it is lifted, where a push straight up by
 * its deepest corner left it tilted and rocking. A separate "pseudo" motion
 * (rec.pv, rec.pw) that moves it this slice and is then forgotten: sinking
 * out never turns into speed, so nothing bounces off the floor.
 */
function climbOut(m, dt, backwards) {
  const { T, O } = m;
  const vT = T.pv;
  const wT = T.pw;
  const vO = O.pv ?? _ZERO3;
  const wO = O.pw ?? _ZERO3;
  const count = m.points.length;
  for (let i = 0; i < count; i++) {
    const c = m.points[backwards ? count - 1 - i : i];
    if (!(c.kn > 0)) continue;
    const vn = speedAlong(m, c.J, 0, vT, wT, vO, wO);
    const want = SINK_FIX * Math.max(0, c.depth - SINK_OK) / dt;
    const total = Math.max(0, c.jp + (want - vn) / c.kn);
    const dj = total - c.jp;
    c.jp = total;
    if (dj !== 0) pushAlong(m, c.J, 0, dj, vT, wT, vO, wO);
  }
}

/**
 * A contact as the game hears it: between the objects (a model, not its part's
 * collider), with the part each was touched at, if a part of its own.
 */
function contactEvent(type, a, b, hit = null) {
  const e = {
    type, a: a.entity.owner ?? a.entity, b: b.entity.owner ?? b.entity,
    aPart: a.entity.partKey ?? null, bPart: b.entity.partKey ?? null,
  };
  // a new touch: which way they met and how each was moving, before anything was
  // pushed apart — who hit whom, how hard, from which side ("Something hits me")
  if (hit) Object.assign(e, hit);
  return e;
}

/** A (moved by n) rests on B when n points up — or B on A when it points down. */
function standOn(A, B, n) {
  if (n.y > walkable(A.body)) {
    A.body.grounded = true;
    A.body.groundNormal.copy(n);
    A.body.groundRec = B;
  } else if (n.y < -walkable(B.body) && B.body.type === 'dynamic') {
    B.body.grounded = true;
    B.body.groundNormal.copy(n).negate();
    B.body.groundRec = A;
  }
}

// ---------------------------------------------------------------- the world

const _up = new THREE.Vector3();

export class PhysicsWorld {
  constructor() {
    this.bodies = []; // { entity, body, id, col, local, prev, curr, last, delta, near }
    this._sorted = [];   // the bodies along one axis, for finding pairs (see _pairs)
    this._sortedStale = false;
    this._nextId = 1;
    this._overlaps = new Set();  // pair keys overlapping as of the last step
    this._warm = new Map();      // tumbling contacts' pushes last slice, by pair (see makeManifold)
    // Contacts produced by the last step (all its slices), drained by the
    // component/rule runtimes.
    this.events = [];
    this.fixedStep = FIXED_STEP;
    this.maxSubSteps = 8; // after a long hitch, catch up at most this much
    this._accum = 0;
    // who a "passes through" entry means — the engine gives it the player (see Engine)
    this.who = (selector, entity) => matchesWho(selector, entity, null);
    this.joints = [];        // what holds bodies together (joints.js)
    this.brokenJoints = [];  // ...and those pulled apart this step, for whoever asks
    this._apart = new Map(); // entity -> the entities it never collides with (joined to it, a ragdoll's own limbs)
  }

  /** Hold two bodies together (a Joint from joints.js). */
  addJoint(joint) {
    joint.recA = this.bodies.find((b) => b.entity === joint.a) ?? null;
    joint.recB = joint.b ? this.bodies.find((b) => b.entity === joint.b) ?? null : null;
    this.joints.push(joint);
    return joint;
  }

  removeJoint(joint) {
    const i = this.joints.indexOf(joint);
    if (i !== -1) this.joints.splice(i, 1);
  }

  /** Two bodies that never collide with each other (`on` false: they do again). */
  keepApart(a, b, on = true) {
    if (!a || !b) return;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!this._apart.has(x)) this._apart.set(x, new Set());
      if (on) this._apart.get(x).add(y);
      else this._apart.get(x).delete(y);
    }
  }

  /** Do these two pass through each other (either's "Passes through" names the other)? */
  _passes(a, b) {
    if (this._apart.size) {
      const ea = a.entity.owner ?? a.entity;
      const eb = b.entity.owner ?? b.entity;
      if (this._apart.get(ea)?.has(eb)) return true;
    }
    const ia = a.body.ignores;
    const ib = b.body.ignores;
    if (!ia?.length && !ib?.length) return false;
    const ea = a.entity.owner ?? a.entity; // a part is its model, for who it is
    const eb = b.entity.owner ?? b.entity;
    return !!(ia?.some((s) => this.who(s, eb)) || ib?.some((s) => this.who(s, ea)));
  }

  register(entity) {
    if (!entity.rigidBody) return;
    if (!this.bodies.find((b) => b.entity === entity)) {
      // a model's parts with physics of their own (physics-parts.js): out of its own
      // collider, and — an own box, a trigger zone — a collider each, following the part
      const roles = partRoles(entity);
      this._add(entity, roles.length ? new Set(roles.map((p) => p.node)) : null);
      for (const p of roles) {
        if (p.role === 'none') continue;
        const part = {
          object3D: p.node, owner: entity, partKey: p.key, partName: p.name,
          rigidBody: new RigidBody({
            type: 'static', isTrigger: p.role === 'trigger',
            friction: entity.rigidBody.friction, restitution: entity.rigidBody.restitution,
          }),
        };
        this._add(part, null);
      }
    }
  }

  /** One collider among the bodies (an object, or a part of a model with its own). */
  _add(entity, skip) {
    this.bodies.push({
      entity,
      body: entity.rigidBody,
      id: this._nextId++,
      col: makeCollider(),
      local: null,         // size in the object's own space, measured once
      prev: null,          // positions either side of the last slice, for smooth drawing
      curr: null,
      last: null,          // non-dynamic: where it was last slice, to carry riders
      delta: new THREE.Vector3(),
      near: [],            // the bodies near it this slice
      // kept for code that read the old axis-aligned record
      aabb: { center: new THREE.Vector3(), halfSize: new THREE.Vector3() },
      skip, // the model's parts left out of this collider (their own, or none)
    });
    this._sortedStale = true;
  }

  unregister(entity) {
    // it, and the colliders of its parts
    const gone = this.bodies.filter((b) => b.entity === entity || b.entity.owner === entity);
    if (!gone.length) return;
    const ids = new Set(gone.map((b) => b.id));
    // what held it goes with it
    this.joints = this.joints.filter((j) => !gone.includes(j.recA) && !gone.includes(j.recB));
    this._apart.delete(entity);
    for (const set of this._apart.values()) set.delete(entity);
    this.bodies = this.bodies.filter((b) => !ids.has(b.id));
    this._sortedStale = true;
    // forget overlaps involving these bodies, or they would never report an exit
    for (const key of [...this._overlaps]) {
      const [a, b] = key.split(':');
      if (ids.has(+a) || ids.has(+b)) this._overlaps.delete(key);
    }
  }

  /** The RigidBody registered for an entity, or null. */
  bodyFor(entity) {
    return this.bodies.find((b) => b.entity === entity)?.body ?? null;
  }

  /**
   * How tall its body is, as a share of its full height, from its feet: 0.5 a
   * crouch, 1 standing. Lower at once; up again only as far as there is room
   * over its head (a low pipe keeps it crouched). Returns the share it has now.
   */
  setHeight(entity, share) {
    const rec = this.bodies.find((b) => b.entity === entity);
    if (!rec) return 1;
    const body = rec.body;
    const o = rec.entity.object3D;
    o.updateWorldMatrix(true, false);
    if (!rec.local) rec.local = measureLocal(o, new THREE.Box3(), rec.skip);
    const now = body.heightShare ?? 1;
    let want = THREE.MathUtils.clamp(Number(share) || 1, 0.2, 1);
    if (Math.abs(want - now) < 1e-4) return now;
    if (!body.standing) body.standing = { box: body.box ?? null, full: (body.box || rec.local).clone() };
    const full = body.standing.full;
    if (full.isEmpty()) return now;
    const tall = full.max.y - full.min.y;
    if (want > now) {
      // up: only into the room there is over its head
      const col = this._fresh(rec);
      const top = { cx: col.center.x, cz: col.center.z, hx: col.half.x, hz: col.half.z, y: col.max.y };
      const rise = (want - now) * tall * Math.abs(o.getWorldScale(_s).y);
      const skip = (e, b) => e === entity || e.owner === entity || b.isTrigger;
      let room = rise;
      for (const [dx, dz] of [[0, 0], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
        // (its own vector: a ray rebuilds colliders, which use the shared ones)
        const from = new THREE.Vector3(top.cx + dx * top.hx, top.y - 0.02, top.cz + dz * top.hz);
        const hit = this.raycast(from, _yAxis, rise + 0.02, { skip });
        if (hit) room = Math.min(room, Math.max(0, hit.distance - 0.03));
      }
      if (room < rise) want = now + (room / rise) * (want - now);
      if (want - now < 1e-3) return now;
    }
    if (want >= 1 - 1e-4) {
      body.box = body.standing.box;
      delete body.standing;
      body.heightShare = 1;
    } else {
      body.box = full.clone();
      body.box.max.y = full.min.y + tall * want;
      body.heightShare = want;
    }
    rec.col.built = false; // its collider is rebuilt from the new box
    return body.heightShare;
  }

  /** The collider an entity has right now (for tests and tools). */
  colliderFor(entity) {
    const rec = this.bodies.find((b) => b.entity === entity);
    return rec ? buildCollider(rec) : null;
  }

  /**
   * Advance by `dt` seconds in fixed slices. A short frame may run no slice
   * (the time carries over); a long one runs several.
   */
  step(dt) {
    this.events.length = 0;
    this.brokenJoints.length = 0; // those pulled apart this step
    if (this.bodies.length === 0) return;
    this._accum += Math.min(Math.max(0, dt), 0.25);
    let slices = 0;
    while (this._accum >= this.fixedStep - 1e-9 && slices < this.maxSubSteps) {
      this._slice(this.fixedStep);
      this._accum -= this.fixedStep;
      slices++;
    }
    if (slices === this.maxSubSteps) this._accum = 0; // don't spiral after a stall
    if (this._accum < 0) this._accum = 0;
  }

  _slice(dt) {
    const bodies = this.bodies;

    this._crossed = []; // triggers a fast body went right through this slice (see _sweep)
    // moving platforms: how far each non-dynamic body moved since the last slice
    for (const r of bodies) {
      if (r.body.type === 'dynamic') continue;
      const p = r.entity.object3D.position;
      if (!r.last) r.last = p.clone();
      r.delta.subVectors(p, r.last);
      r.last.copy(p);
    }

    for (const r of bodies) {
      const body = r.body;
      if (body.type !== 'dynamic') continue;
      const o = r.entity.object3D;
      // ...and whoever stands on one rides along
      const g = body.groundRec;
      if (body.grounded && g && g.body.type === 'kinematic' && g.delta.lengthSq() < 1 && bodies.includes(g)) {
        o.position.add(g.delta);
      }
      if (!r.prev) { r.prev = o.position.clone(); r.curr = o.position.clone(); }
      r.prev.copy(o.position);

      body.wasGrounded = body.grounded;
      body.grounded = false;
      r.stepped = false; // one step up a slice (see _stepUp)
      body.velocity.y += body.gravity * dt;
      if (isTumbling(body)) {
        // what slows it is what it touches (see solveManifold), not the air — and it
        // moves once its contacts are solved (below): resting, it doesn't sink in first
        this._slow(r, dt);
        continue;
      }
      body.velocity.x *= (1 - body.friction * dt);
      body.velocity.z *= (1 - body.friction * dt);

      o.position.addScaledVector(body.velocity, dt);
      this._sweep(r); // fast: not through anything thin on the way (CCD)
    }

    for (const r of bodies) buildCollider(r);
    // only bodies that come near each other are ever tested (see _pairs)
    const pairs = this._pairs();
    // Contacts are read BEFORE the solver separates anything: once a dynamic body
    // has been pushed out of a wall the overlap is gone.
    this._collectContacts(pairs);

    // vehicles: wheels on springs, tyres gripping and sliding (vehicle.js) — pushes
    // like any other, before the contacts are solved
    for (const r of bodies) {
      if (r.body.vehicle && isTumbling(r.body) && r.invI) r.body.vehicle.slice(this._vehicleContext(r, dt));
    }

    // tumbling bodies: first how they move — pushed where they touch, so they turn...
    const manifolds = [];
    for (let i = 0; i < pairs.length; i++) {
      const [p, q] = pairs[i];
      if (p.body.isTrigger || q.body.isTrigger) continue;
      const T = isTumbling(p.body) ? p : isTumbling(q.body) ? q : null;
      if (!T) continue;
      const O = T === p ? q : p;
      // the contact collected just now, seen from T (its way out of O)
      let c = this._contacts?.[i];
      if (!c) continue;
      if (T !== p) c = { n: c.n.clone().negate(), depth: c.depth };
      manifolds.push(makeManifold(T, O, c, this._warm.get(`${T.id}:${O.id}`), dt));
    }
    for (let it = 0; it < SOLVE_ROUNDS && manifolds.length; it++) {
      const backwards = it % 2 === 1;
      for (let k = 0; k < manifolds.length; k++) solveManifold(manifolds[backwards ? manifolds.length - 1 - k : k], backwards);
    }
    // how hard each was hit this frame (the change in its speed, m/s — the hardest
    // kept until read): a car's crash (vehicle.js)
    for (const m of manifolds) {
      let j = 0;
      for (const c of m.points) j += c.jn;
      const dv = j / m.T.body.mass;
      if (dv > (m.T.body.impact || 0)) { m.T.body.impact = dv; m.T.body.impactWith = m.O.entity; }
      if (m.O.body.type === 'dynamic' && j / m.O.body.mass > (m.O.body.impact || 0)) {
        m.O.body.impact = j / m.O.body.mass;
        m.O.body.impactWith = m.T.entity;
      }
    }
    this._warm = new Map();
    for (const m of manifolds) {
      this._warm.set(`${m.T.id}:${m.O.id}`, new Map(m.points.map((c) => [c.id, { jn: c.jn, j1: c.j1, j2: c.j2 }])));
    }
    // ...then they move, along and round, as the solver left them...
    for (const r of bodies) {
      if (!isTumbling(r.body) || !r.prev) continue;
      this._advance(r, dt);
      buildCollider(r);
    }
    // ...and climb out of anything they had sunk into
    if (manifolds.length) this._climbOut(manifolds, dt);

    // The pairs that can push: not a trigger, one of them moving. A pair is
    // looked at again only if one of its two has been moved since it last was:
    // otherwise the answer is the same (no contact) — 8 passes of every pair
    // were most of a crowd's time.
    const push = [];
    for (const pq of pairs) {
      const [p, q] = pq;
      if (p.body.isTrigger || q.body.isTrigger) continue; // nothing collides with a trigger
      if (p.body.type !== 'dynamic' && q.body.type !== 'dynamic') continue; // only dynamic bodies are pushed
      push.push(pq);
    }
    let clock = 1;
    for (const pq of push) { pq[0].moved = 1; pq[1].moved = 1; }
    const seen = new Float64Array(push.length); // when each pair was last looked at
    for (let it = 0; it < 8; it++) {
      for (let k = 0; k < push.length; k++) {
        const [p, q] = push[k];
        if (seen[k] && p.moved < seen[k] && q.moved < seen[k]) continue; // neither moved since: still apart
        seen[k] = ++clock;
        const pMoves = p.body.type === 'dynamic';
        const A = pMoves ? p : q;
        const B = pMoves ? q : p;
        if (!boundsOverlap(A.col, B.col)) continue;
        // ...then, like everything else, out of what it has sunk into
        if (isTumbling(A.body) || isTumbling(B.body)) {
          const T = isTumbling(A.body) ? A : B;
          if (this._separate(T, T === A ? B : A) !== false) { T.moved = ++clock; (T === A ? B : A).moved = clock; }
          continue;
        }
        const c = contactBetween(A.col, B.col);
        if (!c) continue;
        A.moved = ++clock; // touching: whatever happens next moves it — look at its pairs again
        if (B.body.type === 'dynamic') B.moved = clock;

        if (B.body.type !== 'dynamic') {
          // a ledge low enough to step onto: up onto it, instead of stopped by its side
          const walk = walkable(A.body);
          if (c.n.y <= walk && this._stepUp(A, B, c)) continue;
          this._pushOut(A, c, B);
          if (c.n.y > walk) {
            A.body.grounded = true;
            A.body.groundNormal.copy(c.n);
            A.body.groundRec = B;
          }
        } else {
          // Two moving bodies: apart by weight (a crate gives way to a heavy hero),
          // and neither keeps moving into the other. They used to be split evenly
          // with their speeds untouched, so a body standing on another fell faster
          // and faster, unseen, until it stepped off — and it could never jump off.
          const iA = 1 / A.body.mass;
          const iB = 1 / B.body.mass;
          // A character's Push strength: the most it shoves with (× its own weight). Pushing
          // harder than that, it is held back instead, as by a wall — a heavy crate barely
          // shifts for a weak one. (n points from B to A: A pushes along -n, B along +n.)
          const vn = _v.subVectors(A.body.velocity, B.body.velocity).dot(c.n);
          const e = vn < -BOUNCE_MIN ? Math.max(A.body.restitution, B.body.restitution) : 0;
          let j = vn < 0 ? -(1 + e) * vn / (iA + iB) : 0;
          const most = Math.min(pushCap(A.body, dt), pushCap(B.body, dt));
          const held = j > most ? most / j : 1; // the share of the push that gets through
          const share = c.depth / (iA + iB);
          const bMoves = share * iB * held;
          _d.copy(c.n).multiplyScalar(c.depth - bMoves + 0.0005);
          A.entity.object3D.position.add(_d);
          moveCollider(A.col, _d);
          _d.copy(c.n).multiplyScalar(-(bMoves + 0.0005));
          B.entity.object3D.position.add(_d);
          moveCollider(B.col, _d);
          if (j > 0) {
            if (held < 1) {
              // B takes what gets through; A is stopped (and bounced) along n against it
              j = most;
              B.body.velocity.addScaledVector(c.n, -j * iB);
              const left = _v.subVectors(A.body.velocity, B.body.velocity).dot(c.n);
              if (left < 0) A.body.velocity.addScaledVector(c.n, -(1 + e) * left);
            } else {
              A.body.velocity.addScaledVector(c.n, j * iA);
              B.body.velocity.addScaledVector(c.n, -j * iB);
            }
          }
          standOn(A, B, c.n);
        }
      }
    }

    // walking down a slope or over a crest: stay on the ground instead of flying off —
    // reaching further down the faster it goes (a slope down to 45° at its speed)
    for (const A of bodies) {
      const body = A.body;
      if (body.type !== 'dynamic' || body.isTrigger || body.tumbles) continue;
      if (body.hover > 0) { this._hover(A, dt); continue; } // held above the ground, not on it
      if (!body.wasGrounded || body.grounded || body.velocity.y > 0.5) continue;
      const reach = Math.min(SNAP_MAX, Math.max(SNAP, Math.hypot(body.velocity.x, body.velocity.z) * dt * 1.2));
      this._snapDown(A, reach);
    }

    // what holds bodies together: a hinge, a chain, a rope, a ragdoll's limbs (joints.js)
    if (this.joints.length) solveJoints(this, dt, JOINT_HELPERS);

    for (const r of bodies) {
      if (r.body.type !== 'dynamic') continue;
      if (r.curr) r.curr.copy(r.entity.object3D.position);
      if (isTumbling(r.body)) this._settle(r, dt);
      else this._soften(r);
    }
  }

  /** A tumbling body slowed: spinning in the air a little, rolling along the ground steadily. */
  _slow(r, dt) {
    const { body } = r;
    const w = body.angularVelocity;
    w.multiplyScalar(1 / (1 + SPIN_DRAG * dt));
    if (body.wasGrounded) {
      w.multiplyScalar(Math.max(0, 1 - ROLL_DRAG * body.friction * dt));
      if (r.col.kind === 'capsule') {
        // rolling resistance: a ball on the ground loses speed along it (friction turns its spin to match)
        const n = body.groundNormal;
        const v = body.velocity;
        _t.copy(v).addScaledVector(n, -v.dot(n));
        const speed = _t.length();
        if (speed > 1e-6) v.addScaledVector(_t, -Math.min(speed, ROLL_RESIST * body.friction * Math.abs(body.gravity) * dt) / speed);
      }
    }
  }

  /** A tumbling body's move this slice: along, and round its middle (not its origin, often at its feet). */
  _advance(r, dt) {
    const { body } = r;
    const o = r.entity.object3D;
    const w = body.angularVelocity;
    if (!r.prevQ) { r.prevQ = new THREE.Quaternion(); r.currQ = new THREE.Quaternion(); }
    r.prevQ.copy(o.quaternion);
    o.position.addScaledVector(body.velocity, dt);
    this._sweep(r); // fast: not through anything thin on the way — a thrown crate, a car, a limb (CCD)
    const speed = w.length();
    if (speed * dt < 1e-7) return;
    _spin.setFromAxisAngle(_axis.copy(w).divideScalar(speed), speed * dt);
    o.updateWorldMatrix(true, false);
    if (!r.local) r.local = measureLocal(o, new THREE.Box3(), r.skip);
    const local = body.box || r.local;
    if (!local.isEmpty() && (!o.parent || o.parent.isScene)) {
      local.getCenter(_c).applyMatrix4(o.matrixWorld);
      _back.subVectors(o.position, _c).applyQuaternion(_spin);
      o.position.copy(_c).add(_back);
    }
    o.quaternion.premultiply(_spin);
  }

  /** What a vehicle (vehicle.js) gets each slice: its body, rays, and pushes at a point. */
  _vehicleContext(rec, dt) {
    return {
      rec,
      dt,
      gravity: rec.body.gravity,
      raycast: (origin, dir, length) => this._rayNow(origin, dir, length, rec),
      velocityAt: (p, out) => velocityAt(rec, p, out),
      giveAt: (p, d) => giveAt(rec, p, d),
      impulseAt: (p, J) => impulseAt(rec, p, J),
    };
  }

  /**
   * A ray against the colliders as this slice built them (raycast() rebuilds every
   * one, too slow four times a slice per car): still, solid bodies only, not `self`.
   */
  _rayNow(origin, dir, length, self) {
    const x0 = Math.min(origin.x, origin.x + dir.x * length);
    const x1 = Math.max(origin.x, origin.x + dir.x * length);
    const y0 = Math.min(origin.y, origin.y + dir.y * length);
    const y1 = Math.max(origin.y, origin.y + dir.y * length);
    const z0 = Math.min(origin.z, origin.z + dir.z * length);
    const z1 = Math.max(origin.z, origin.z + dir.z * length);
    let best = null;
    for (const r of this.bodies) {
      if (r === self || r.body.isTrigger || r.body.type === 'dynamic') continue;
      if (self && this._passes(self, r)) continue; // a car's wheels don't ride on what it passes through
      const c = r.col;
      if (c.max.x < x0 || c.min.x > x1 || c.max.y < y0 || c.min.y > y1 || c.max.z < z0 || c.min.z > z1) continue;
      const hit = rayCollider(origin, dir, c, length);
      if (hit && (!best || hit.distance < best.distance)) best = { ...hit, entity: r.entity };
    }
    return best;
  }

  /** Tumbling bodies out of what they sank into (see climbOut), each turned and moved by its share. */
  _climbOut(manifolds, dt) {
    const moved = new Set();
    for (const m of manifolds) {
      for (const rec of [m.T, m.O]) {
        if (rec.body.type !== 'dynamic' || moved.has(rec)) continue;
        moved.add(rec);
        (rec.pv ||= new THREE.Vector3()).set(0, 0, 0);
        (rec.pw ||= new THREE.Vector3()).set(0, 0, 0);
      }
    }
    for (let it = 0; it < SOLVE_ROUNDS; it++) {
      const backwards = it % 2 === 1;
      for (let k = 0; k < manifolds.length; k++) climbOut(manifolds[backwards ? manifolds.length - 1 - k : k], dt, backwards);
    }
    for (const rec of moved) {
      const o = rec.entity.object3D;
      o.position.addScaledVector(rec.pv, dt);
      const turn = rec.pw.length() * dt;
      if (spins(rec) && turn > 1e-9) {
        _spin.setFromAxisAngle(_axis.copy(rec.pw).normalize(), turn);
        _back.subVectors(o.position, rec.col.center).addScaledVector(rec.pv, -dt).applyQuaternion(_spin);
        o.position.copy(rec.col.center).addScaledVector(rec.pv, dt).add(_back);
        o.quaternion.premultiply(_spin);
      }
      buildCollider(rec);
    }
  }

  /**
   * A tumbling body T and another O apart (by weight, if O moves too) — only
   * as far as climbing out (above) leaves it deeper than SINK_DEEP. Its speed
   * is the solver's.
   */
  _separate(T, O) {
    const c = contactBetween(T.col, O.col);
    if (!c) return false;
    const n = c.n;
    standOn(T, O, n);
    if (c.depth <= SINK_DEEP) return false; // touching, but nothing moved
    const iT = 1 / pushMass(T.body);
    const iO = O.body.type === 'dynamic' ? 1 / pushMass(O.body) : 0;
    const share = (c.depth - SINK_DEEP / 2) / (iT + iO);
    _d.copy(n).multiplyScalar(share * iT + 0.001);
    T.entity.object3D.position.add(_d);
    moveCollider(T.col, _d);
    if (iO) {
      _d.copy(n).multiplyScalar(-(share * iO + 0.001));
      O.entity.object3D.position.add(_d);
      moveCollider(O.col, _d);
    }
  }

  /** Come to rest: a crate that has landed stops rocking; a ball rolls to a stop. */
  _settle(r, dt) {
    const b = r.body;
    if (b.vehicle) { // a car parks itself (vehicle.js): held here, it could never pull away
      if (r.currQ) r.currQ.copy(r.entity.object3D.quaternion);
      return;
    }
    const still = b.grounded && b.velocity.lengthSq() < REST_SPEED * REST_SPEED
      && b.angularVelocity.lengthSq() < REST_SPIN * REST_SPIN;
    r.rest = still ? (r.rest || 0) + dt : 0;
    if (r.rest > REST_TIME) {
      b.angularVelocity.set(0, 0, 0);
      if (b.groundNormal.y > 0.97) { b.velocity.x = 0; b.velocity.z = 0; } // on the flat; a slope may still slide it
    }
    if (r.currQ) r.currQ.copy(r.entity.object3D.quaternion);
  }

  /** Separate a dynamic body from something immovable, and stop it moving into it. */
  _pushOut(A, c, B = null) {
    const o = A.entity.object3D;
    const v = A.body.velocity;
    const walk = walkable(A.body);
    if (c.n.y > STICKY && c.n.y > walk) {
      // Standing on it: treated like flat ground. Lift straight up and stop the
      // fall only, so resting on a slope never creeps sideways and walking up
      // one keeps its speed. Exactly as far as clears it (see _liftToClear).
      const most = c.depth / c.n.y;
      const lift = B && c.n.y < 0.98 && most > 0.01 ? this._liftToClear(A, B, most) : most;
      _up.set(0, lift + 0.001, 0);
      if (v.y < 0) v.y = -v.y * A.body.restitution;
    } else if (c.n.y > walk) {
      // Steep but walkable (45°–60°): out along the slope, and only the fall stopped.
      // Bouncing its speed off the slope turned a run into an upward throw — a
      // runner took off over every crest like a ski jump. It climbs slower instead.
      _up.copy(c.n).multiplyScalar(c.depth + 0.001);
      if (v.y < 0) v.y = 0;
    } else {
      _up.copy(c.n).multiplyScalar(c.depth + 0.001);
      const vn = v.dot(c.n);
      if (vn < 0) v.addScaledVector(c.n, -vn * (1 + A.body.restitution));
    }
    o.position.add(_up);
    moveCollider(A.col, _up);
  }

  /**
   * The pairs of bodies near enough to touch this slice: [lower id, higher id].
   * Sweep and prune — the bodies are kept sorted along the level's longer axis
   * (x or z), so each one is paired only with the few whose span reaches its
   * own. Every body used to be tested against every other, eight times a
   * slice: fine for dozens, not for hundreds. Two static bodies are never a
   * pair (they can't start touching). The margin covers the slope snap and
   * the solver's pushes within the slice.
   */
  _pairs() {
    const M = PAIR_MARGIN * 2;
    if (this._sorted.length !== this.bodies.length || this._sortedStale) {
      this._sorted = [...this.bodies];
      this._sortedStale = false;
    }
    const list = this._sorted;
    // along x or z, whichever the bodies are spread over more
    let lo = Infinity;
    let hi = -Infinity;
    let loZ = Infinity;
    let hiZ = -Infinity;
    for (const r of list) {
      lo = Math.min(lo, r.col.min.x); hi = Math.max(hi, r.col.max.x);
      loZ = Math.min(loZ, r.col.min.z); hiZ = Math.max(hiZ, r.col.max.z);
    }
    const k = hiZ - loZ > hi - lo ? 'z' : 'x';
    const other = k === 'x' ? 'z' : 'x';
    // insertion sort: the order barely changes from one slice to the next
    for (let i = 1; i < list.length; i++) {
      const r = list[i];
      const v = r.col.min[k];
      let j = i - 1;
      while (j >= 0 && list[j].col.min[k] > v) { list[j + 1] = list[j]; j--; }
      list[j + 1] = r;
    }
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const reach = a.col.max[k] + M;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.col.min[k] > reach) break; // sorted: nothing further along reaches back
        if (a.body.type === 'static' && b.body.type === 'static') continue;
        if (a.col.min.y > b.col.max.y + M || b.col.min.y > a.col.max.y + M) continue;
        if (a.col.min[other] > b.col.max[other] + M || b.col.min[other] > a.col.max[other] + M) continue;
        if (this._passes(a, b)) continue; // collision layers: as if not there
        if ((a.entity.owner ?? a.entity) === (b.entity.owner ?? b.entity)) continue; // a model and its own parts
        out.push(a.id < b.id ? [a, b] : [b, a]);
      }
    }
    for (const r of list) r.near.length = 0; // each body's neighbours, for the slope snap
    for (const [a, b] of out) { a.near.push(b); b.near.push(a); }
    return out;
  }

  /**
   * Down onto walkable ground within `reach` below, if there is some: true if
   * it landed. Found by searching for the drop at which it first touches, not
   * worked out from one contact: over a crest or an edge of rough ground that
   * guess came out too far, the ground counted as out of reach, and a runner
   * flew off every bump.
   */
  _snapDown(A, reach = SNAP) {
    const land = this._landing(A, reach);
    if (!land) return false; // nothing below within reach
    this._dropBy(A, land);
    return true;
  }

  /**
   * How far down (at most `reach`) walkable ground is: { drop, B, n } or null.
   * Down in 5 cm steps to the first touch (the top of a ledge is met part way,
   * and gone again further down, where only its side is), then exactly where between.
   */
  _landing(A, reach) {
    const steps = Math.max(2, Math.ceil(reach / 0.05));
    let lo = 0;
    let hi = -1;
    let hit = null;
    for (let k = 1; k <= steps && !hit; k++) {
      const d = (reach * k) / steps + (k === steps ? 0.002 : 0);
      hit = this._groundAt(A, d);
      if (hit) hi = d;
      else lo = d;
    }
    if (!hit) return null;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      const h = this._groundAt(A, mid);
      if (h) { hi = mid; hit = h; } else lo = mid;
    }
    return { drop: hi, B: hit.B, n: hit.n };
  }

  /** Down by a landing (see _landing): on the ground, its fall stopped. */
  _dropBy(A, land) {
    const drop = -land.drop + 0.0005;
    A.entity.object3D.position.y += drop;
    _up.set(0, drop, 0);
    moveCollider(A.col, _up);
    A.body.grounded = true;
    A.body.groundNormal.copy(land.n);
    A.body.groundRec = land.B;
    if (A.body.velocity.y < 0) A.body.velocity.y = 0;
  }

  /** Walkable ground the body would touch `d` lower down: { B, n } or null. */
  _groundAt(A, d) {
    _up.set(0, -d, 0);
    moveCollider(A.col, _up);
    let found = null;
    for (const B of A.near) {
      if (B === A || B.body.type === 'dynamic' || B.body.isTrigger || !boundsOverlap(A.col, B.col)) continue;
      const c = contactBetween(A.col, B.col);
      if (c && c.n.y > walkable(A.body) && c.depth > 1e-4) { found = { B, n: c.n }; break; }
    }
    _up.set(0, d, 0);
    moveCollider(A.col, _up);
    return found;
  }

  /**
   * How far straight up clears A of B, at most `most` (what one contact says).
   * On an edge or a crest that contact says too much — a character met the lip
   * of a ledge, shot up and dropped back — so it is searched for.
   */
  _liftToClear(A, B, most) {
    let lo = 0;
    let hi = most;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      _up.set(0, mid, 0);
      moveCollider(A.col, _up);
      const c = boundsOverlap(A.col, B.col) ? contactBetween(A.col, B.col) : null;
      _up.set(0, -mid, 0);
      moveCollider(A.col, _up);
      if (c && c.depth > 5e-4) lo = mid; else hi = mid;
    }
    return hi;
  }

  /**
   * A character walking into the side of something low — a kerb, a stair, a
   * rock, a ledge in a model's terrain — steps up onto it: raised by its step
   * height, and if nothing blocks it there (a taller wall, a low ceiling),
   * down onto the top. Only a capsule (a character's shape) that was on the
   * ground and is walking into it; true if it stepped.
   */
  _stepUp(A, B, c) {
    const body = A.body;
    const step = body.stepHeight ?? STEP_UP;
    if (!(step > 0) || body.hover > 0 || A.stepped || A.col.kind !== 'capsule' || body.tumbles || body.isTrigger || !body.wasGrounded) return false;
    if (c.n.y < -0.3 || body.velocity.y > 0.5) return false; // a ceiling, or jumping
    const v = body.velocity;
    const h = Math.hypot(c.n.x, c.n.z);
    if (h < 1e-6 || (v.x * c.n.x + v.z * c.n.z) / h > -0.05) return false; // not walking into it
    const o = A.entity.object3D;
    const y0 = o.position.y;
    // up by a step: clear of every wall still there?
    o.position.y += step;
    _up.set(0, step, 0);
    moveCollider(A.col, _up);
    let clear = true;
    for (const C of A.near) {
      if (C === A || C.body.isTrigger || C.body.type === 'dynamic' || !boundsOverlap(A.col, C.col)) continue;
      const k = contactBetween(A.col, C.col);
      if (k && k.n.y <= walkable(A.body) && k.depth > 0.002) { clear = false; break; }
    }
    // ...then down onto the top of what it stepped onto (higher than where it was).
    // Pressed against its side, a capsule's middle is a whole radius short of the
    // edge — too far back to stand on it — so the landing is looked for a little
    // further on too; it is set down at that height where it is, and rolls onto the
    // top as it walks on (no jump forward).
    if (clear) {
      const ahead = [0, A.col.r * 0.5, A.col.r];
      for (const a of ahead) {
        _nudge.set((-c.n.x / h) * a, 0, (-c.n.z / h) * a);
        moveCollider(A.col, _nudge);
        const land = this._landing(A, step);
        _nudge.negate();
        moveCollider(A.col, _nudge);
        if (land && step - land.drop > 0.01) {
          this._dropBy(A, land);
          A.stepped = true;
          return true;
        }
      }
    }
    // no: back where it was, and the side stops it as usual
    _up.set(0, y0 - o.position.y, 0);
    o.position.y = y0;
    moveCollider(A.col, _up);
    return false;
  }

  /**
   * Hover: held `body.hover` metres above whatever solid ground is below, by
   * a damped spring — it glides over hills and dips into pits instead of
   * scraping along or flying off. Gravity is held off while there is ground
   * in reach (with none, it falls — or flies on, with no gravity), and it
   * counts as on the ground there, so it can still jump.
   */
  _hover(A, dt) {
    const body = A.body;
    const height = body.hover;
    const col = A.col;
    _hoverFrom.set(col.center.x, col.min.y + 0.05, col.center.z);
    const hit = this.raycast(_hoverFrom, _down, height * 2 + 1.05, {
      skip: (e, b) => e === A.entity || b.isTrigger || b.type === 'dynamic',
    });
    if (!hit) return;
    const gap = hit.distance - 0.05;
    const k = 60; // firm...
    const damp = 2 * Math.sqrt(k) * 0.9; // ...and without bobbing
    body.velocity.y += (k * (height - gap) - damp * body.velocity.y - body.gravity) * dt;
    if (gap < height + 0.5) {
      body.grounded = true;
      body.groundNormal.copy(hit.normal.y > 0 ? hit.normal : _yAxis);
      body.groundRec = this.bodies.find((r) => r.entity === hit.entity) ?? null;
    }
  }

  /**
   * Walking over a step, a rock or a bump moves the body up or down in one
   * slice; drawn like that the character (and the camera with it) jolts. The
   * part of that rise or drop beyond a 45° slope's worth is kept as an offset
   * the picture eases out of (smoothY, added when drawing), so it glides.
   */
  _soften(r) {
    const { body } = r;
    const o = r.entity.object3D;
    let off = (r.smoothY || 0) * SOFTEN;
    if (body.smoothSteps !== false && body.grounded && body.wasGrounded && r.prev && !isTumbling(body)) {
      const dy = o.position.y - r.prev.y;
      const allow = Math.hypot(o.position.x - r.prev.x, o.position.z - r.prev.z) + 0.01;
      const jolt = dy - THREE.MathUtils.clamp(dy, -allow, allow);
      off = THREE.MathUtils.clamp(off - jolt, -SOFT_MAX, SOFT_MAX);
    }
    if (Math.abs(off) < 1e-4) off = 0;
    r.smoothY = off;
    if (off) o.userData.smoothY = off;
    else delete o.userData.smoothY;
  }

  /** How fast a body is going (m/s): its velocity, or — moved by a rule, a path, a script — how far it went this slice. */
  _velocityOf(r) {
    if (r.body.type === 'dynamic') return r.body.velocity.clone();
    return r.delta ? r.delta.clone().divideScalar(this.fixedStep) : new THREE.Vector3();
  }

  /**
   * Diff this slice's overlaps against the last to produce enter/stay/exit
   * contacts. Shapes are tested for real, not just their bounding boxes.
   */
  _collectContacts(pairs = this._pairs()) {
    const current = new Set();
    // each pair's contact, kept for the solver this slice (nothing moves in between)
    const contacts = (this._contacts = new Array(pairs.length));

    for (let i = 0; i < pairs.length; i++) {
      const [a, b] = pairs[i];
      if (!boundsOverlap(a.col, b.col)) continue;
      const c = contactBetween(a.col, b.col);
      if (!c) continue;
      contacts[i] = c;
      const key = `${a.id}:${b.id}`;
      current.add(key);
      const isTrigger = a.body.isTrigger || b.body.isTrigger;
      const type = this._overlaps.has(key)
        ? (isTrigger ? 'triggerStay' : 'collisionStay')
        : (isTrigger ? 'triggerEnter' : 'collisionEnter');
      // n: a's way out of b (from b towards a); a body that isn't dynamic moves as it was moved this slice
      const hit = type === 'collisionEnter'
        ? { normal: c.n.clone(), va: this._velocityOf(a), vb: this._velocityOf(b) }
        : null;
      this.events.push(contactEvent(type, a, b, hit));
    }
    // a trigger a fast body went right through in one slice (a finish line, a goal):
    // touched all the same — entered now, left next slice
    for (const [p, q] of this._crossed || []) {
      const [a, b] = p.id < q.id ? [p, q] : [q, p];
      const key = `${a.id}:${b.id}`;
      if (current.has(key)) continue;
      current.add(key);
      if (!this._overlaps.has(key)) this.events.push(contactEvent('triggerEnter', a, b));
    }

    for (const key of this._overlaps) {
      if (current.has(key)) continue;
      const [aId, bId] = key.split(':').map(Number);
      const a = this.bodies.find((r) => r.id === aId);
      const b = this.bodies.find((r) => r.id === bId);
      if (!a || !b) continue; // one of them was removed; unregister already cleaned up
      const isTrigger = a.body.isTrigger || b.body.isTrigger;
      this.events.push(contactEvent(isTrigger ? 'triggerExit' : 'collisionExit', a, b));
    }

    this._overlaps = current;
  }

  /**
   * Continuous collision. Moved farther than its own size this slice, a body
   * could have gone right through something thin: a wall, a floor, an enemy.
   * So look along the way it went, and stop it just inside the first thing in
   * the way. It is then hit, pushed back and heard of (collision, shot) as
   * usual. Trigger zones on the way are noted, so they're set off too. Slower
   * bodies (walking, most falling) never need it: their contacts catch them.
   */
  _sweep(r) {
    const o = r.entity.object3D;
    const from = r.prev;
    const h = r.col.half;
    const radius = Math.min(h.x, h.y, h.z);
    if (!from || !(radius > 0)) return;
    const move = _swMove.subVectors(o.position, from);
    const dist = move.length();
    if (dist <= radius) return;
    const dir = move.divideScalar(dist);
    // traced from its collider's middle (a model's origin is often at its feet), from where it was
    const start = _swStart.copy(from).add(r.col.center).sub(r.col.at);
    const end = _swEnd.copy(start).addScaledVector(dir, dist);
    const lo = _swLo.copy(start).min(end).subScalar(radius);
    const hi = _swHi.copy(start).max(end).addScalar(radius);
    let best = Infinity;
    const triggers = [];
    for (const q of this.bodies) {
      if (q === r || this._passes(r, q)) continue;
      const c = q.col;
      if (c.max.x < lo.x || c.min.x > hi.x || c.max.y < lo.y || c.min.y > hi.y || c.max.z < lo.z || c.min.z > hi.z) continue;
      const t = sweepInto(start, dir, c, dist, radius);
      if (t === null) continue;
      if (q.body.isTrigger) triggers.push([q, t]);
      else if (t < best) best = t;
    }
    if (best < Infinity) {
      // just inside it: the contacts see it this slice
      o.position.copy(from).addScaledVector(dir, Math.min(dist, best + Math.min(radius * 0.5, 0.05)));
    }
    for (const [q, t] of triggers) if (t <= best) this._crossed.push([r, q]);
  }

  /** The entities touching `entity` as of the last step — solid contacts and triggers. */
  touching(entity) {
    const mine = new Set(this.bodies.filter((b) => b.entity === entity || b.entity.owner === entity).map((b) => b.id));
    if (!mine.size) return [];
    const out = [];
    for (const key of this._overlaps) {
      const [a, b] = key.split(':').map(Number);
      if (!mine.has(a) && !mine.has(b)) continue;
      const id = mine.has(a) ? b : a;
      const other = this.bodies.find((r) => r.id === id);
      const e = other ? other.entity.owner ?? other.entity : null;
      if (e && e !== entity && !out.includes(e)) out.push(e);
    }
    return out;
  }

  /** Forget all contact history — call when play stops, so nothing leaks across runs. */
  resetContacts() {
    this._overlaps.clear();
    this._warm.clear();
    this.events.length = 0;
    this._accum = 0;
    for (const r of this.bodies) {
      r.prev = null;
      r.curr = null;
      r.prevQ = null;
      r.currQ = null;
      r.rest = 0;
      r.smoothY = 0;
      delete r.entity.object3D.userData.smoothY;
      r.last = null;
      r.body.groundRec = null;
    }
  }

  /**
   * Where `object3D` is drawn this frame (see applyInterpolation): between its
   * last two slices, a step eased out added. For a camera riding it — at the
   * player's eyes, it must move with the picture, not jump slice to slice (on
   * a screen faster than the 60 slices a second, the view shook as it walked).
   */
  drawnPosition(object3D, out) {
    const p = object3D.position;
    const r = this.bodies.find((b) => b.entity.object3D === object3D && !b.entity.owner);
    if (!r || r.body.type !== 'dynamic' || !r.curr || !r.prev
      || p.distanceToSquared(r.curr) > 1e-10 || r.prev.distanceToSquared(r.curr) > 4) {
      return out.set(p.x, p.y + (object3D.userData.smoothY || 0), p.z);
    }
    const alpha = THREE.MathUtils.clamp(this._accum / this.fixedStep, 0, 1);
    out.lerpVectors(r.prev, r.curr, alpha);
    out.y += r.smoothY || 0;
    return out;
  }

  /**
   * Draw moving bodies where they are between two slices, so motion is smooth
   * whatever the screen's rate. Returns a function that puts them back.
   * Bodies moved by anything but the physics (a gizmo, a respawn) are left alone.
   */
  applyInterpolation() {
    const alpha = THREE.MathUtils.clamp(this._accum / this.fixedStep, 0, 1);
    const saved = [];
    for (const r of this.bodies) {
      if (r.body.type !== 'dynamic' || !r.curr) continue;
      const p = r.entity.object3D.position;
      if (p.distanceToSquared(r.curr) > 1e-10) continue; // moved outside the physics
      if (r.prev.distanceToSquared(r.curr) > 4) continue;  // a teleport: don't smear it
      saved.push([p, p.clone()]);
      p.lerpVectors(r.prev, r.curr, alpha);
      p.y += r.smoothY || 0; // a step eased out (see _soften)
      // ...and a tumbling one turns smoothly too
      const q = r.entity.object3D.quaternion;
      if (r.currQ && isTumbling(r.body) && q.angleTo(r.currQ) < 1e-6) {
        saved.push([q, q.clone()]);
        q.slerpQuaternions(r.prevQ, r.currQ, alpha);
      }
    }
    return () => { for (const [p, v] of saved) p.copy(v); };
  }

  /**
   * Raycast against all colliders. Returns closest hit { entity, point, normal, distance }.
   * `skip(entity, body)` leaves bodies out — e.g. the camera looking past its own target.
   */
  /**
   * The nearest body along a ray. Trigger zones aren't in the way (they block
   * nothing) unless `triggers`; `skip(entity, body)` leaves out more.
   */
  raycast(origin, direction, maxDistance = 100, { skip = null, triggers = false } = {}) {
    const dir = direction.clone().normalize();
    // each body's collider as built this slice (rebuilt only if it has moved since), and
    // first its box: a ray misses nearly all of them, and that is a few sums to say so.
    // (Every body's collider was rebuilt for every ray: 2–6 ms a ray among a thousand.)
    const ix = 1 / dir.x;
    const iy = 1 / dir.y;
    const iz = 1 / dir.z;
    let best = maxDistance;
    let closest = null;
    for (const rec of this.bodies) {
      if (!triggers && rec.body.isTrigger) continue;
      const col = this._fresh(rec);
      if (!rayMeetsBox(origin, ix, iy, iz, col.min, col.max, best)) continue;
      if (skip?.(rec.entity, rec.body)) continue;
      const hit = rayCollider(origin, dir, col, best);
      if (hit && hit.distance <= best) {
        best = hit.distance;
        closest = { entity: rec.entity.owner ?? rec.entity, part: rec.entity.partKey ?? null,
          point: hit.point, normal: hit.normal, distance: hit.distance };
      }
    }
    return closest;
  }

  /** A body's collider as it stands now: the one built this slice, unless it has been moved since. */
  _fresh(rec) {
    const col = rec.col;
    const o = rec.entity.object3D;
    if (!col.built || !o.position.equals(col.at) || !o.quaternion.equals(col.q) || !o.scale.equals(col.s)) buildCollider(rec);
    return col;
  }

  /**
   * Every body with its collider as it stands now: [{ entity, body, col, moving }].
   * `moving`: a kinematic body that moved last slice (a lift, a door opening).
   * The colliders are the world's own, rebuilt: read them straight away.
   */
  colliders() {
    return this.bodies.map((rec) => ({
      entity: rec.entity,
      body: rec.body,
      col: buildCollider(rec),
      moving: rec.body.type === 'kinematic' && rec.delta.lengthSq() > 1e-10,
    }));
  }

  /** Cast a ray straight down from a point and return the distance to the first collider. */
  groundDistance(origin, maxDistance = 10) {
    const hit = this.raycast(origin, new THREE.Vector3(0, -1, 0), maxDistance);
    return hit ? hit.distance : null;
  }
}

/** A ray (unit `dir`) against one collider: { point, normal, distance } or null. */
export function rayCollider(origin, dir, col, maxDistance) {
  if (col.kind === 'mesh') return rayMesh(origin, dir, col, maxDistance);
  if (col.kind === 'box') return rayOBB(origin, dir, col, maxDistance);
  return rayAABB(origin, dir,
    new THREE.Vector3().addVectors(col.min, col.max).multiplyScalar(0.5),
    new THREE.Vector3().subVectors(col.max, col.min).multiplyScalar(0.5), maxDistance);
}

/**
 * A box standing straight at `center` with half-sizes `half`, for asking
 * "does anything solid overlap here?" with contactBetween (navigation does).
 */
export function probeBox(center, half) {
  const col = makeCollider();
  col.center.copy(center);
  col.half.copy(half);
  col.prev.copy(center);
  col.min.subVectors(center, half);
  col.max.addVectors(center, half);
  return col;
}

/**
 * Ray vs a mesh collider: the ray turned into the mesh's own space (as a
 * segment, so its length maps exactly whatever the object's scale), then its
 * triangle tree.
 */
function rayMesh(origin, dir, col, maxDistance) {
  const from = origin.clone().applyMatrix4(col.inverse);
  const to = origin.clone().addScaledVector(dir, maxDistance).applyMatrix4(col.inverse);
  const hit = col.mesh.bvh.raycast(from, to.sub(from));
  if (!hit) return null;
  const { tris } = col.mesh;
  const p = hit.tri * 9;
  const a = new THREE.Vector3(tris[p], tris[p + 1], tris[p + 2]).applyMatrix4(col.matrix);
  const b = new THREE.Vector3(tris[p + 3], tris[p + 4], tris[p + 5]).applyMatrix4(col.matrix);
  const c = new THREE.Vector3(tris[p + 6], tris[p + 7], tris[p + 8]).applyMatrix4(col.matrix);
  const normal = new THREE.Vector3().crossVectors(b.sub(a), c.sub(a)).normalize();
  if (normal.dot(dir) > 0) normal.negate(); // the side the ray came from
  const distance = hit.t * maxDistance;
  return { point: origin.clone().addScaledVector(dir, distance), normal, distance };
}

/** Ray vs oriented box: the slab test in the box's own space. */
function rayOBB(origin, dir, col, maxDistance) {
  const rel = new THREE.Vector3().subVectors(origin, col.center);
  const o = new THREE.Vector3(rel.dot(col.axes[0]), rel.dot(col.axes[1]), rel.dot(col.axes[2]));
  const d = new THREE.Vector3(dir.dot(col.axes[0]), dir.dot(col.axes[1]), dir.dot(col.axes[2]));
  const hit = rayAABB(o, d, new THREE.Vector3(), col.half, maxDistance);
  if (!hit) return null;
  const normal = new THREE.Vector3()
    .addScaledVector(col.axes[0], hit.normal.x)
    .addScaledVector(col.axes[1], hit.normal.y)
    .addScaledVector(col.axes[2], hit.normal.z);
  return { point: origin.clone().addScaledVector(dir, hit.distance), normal, distance: hit.distance };
}

const _swMove = new THREE.Vector3();
const _swStart = new THREE.Vector3();
const _swEnd = new THREE.Vector3();
const _swLo = new THREE.Vector3();
const _swHi = new THREE.Vector3();
const _swO = new THREE.Vector3();
const _swD = new THREE.Vector3();
const _swC = new THREE.Vector3();
const _swH = new THREE.Vector3();
const _zero = new THREE.Vector3();

/**
 * How far a ball of `radius` goes from `origin` along `dir` before it first
 * touches `col` — or null: not within `maxDistance`, or touching it already
 * (the contacts deal with that). A box is grown by the radius; a mesh is met
 * by its middle, backed off by the radius.
 */
function sweepInto(origin, dir, col, maxDistance, radius) {
  if (col.kind === 'mesh') {
    const hit = rayMesh(origin, dir, col, maxDistance + radius);
    return hit ? Math.max(0, hit.distance - radius) : null;
  }
  let o = origin;
  let d = dir;
  let center;
  if (col.kind === 'box') {
    _swC.subVectors(origin, col.center);
    o = _swO.set(_swC.dot(col.axes[0]), _swC.dot(col.axes[1]), _swC.dot(col.axes[2]));
    d = _swD.set(dir.dot(col.axes[0]), dir.dot(col.axes[1]), dir.dot(col.axes[2]));
    center = _zero;
    _swH.copy(col.half).addScalar(radius);
  } else {
    center = _swC.addVectors(col.min, col.max).multiplyScalar(0.5);
    _swH.subVectors(col.max, col.min).multiplyScalar(0.5).addScalar(radius);
  }
  if (Math.abs(o.x - center.x) <= _swH.x && Math.abs(o.y - center.y) <= _swH.y && Math.abs(o.z - center.z) <= _swH.z) return null;
  const hit = rayAABB(o, d, center, _swH, maxDistance);
  return hit ? hit.distance : null;
}

/** Does a ray (its direction as 1/x, 1/y, 1/z) meet a box standing straight, within `max`? */
function rayMeetsBox(o, ix, iy, iz, min, max, far) {
  let t1 = (min.x - o.x) * ix;
  let t2 = (max.x - o.x) * ix;
  let lo = Math.min(t1, t2);
  let hi = Math.max(t1, t2);
  t1 = (min.y - o.y) * iy;
  t2 = (max.y - o.y) * iy;
  lo = Math.max(lo, Math.min(t1, t2));
  hi = Math.min(hi, Math.max(t1, t2));
  t1 = (min.z - o.z) * iz;
  t2 = (max.z - o.z) * iz;
  lo = Math.max(lo, Math.min(t1, t2));
  hi = Math.min(hi, Math.max(t1, t2));
  // NaN (a ray along a face, 0 × ∞) counts as a meeting: the exact test decides
  return !(hi < 0 || lo > hi || lo > far);
}

/** Ray vs AABB intersection (Slab method). */
function rayAABB(origin, dir, center, halfSize, maxDistance) {
  let tmin = -Infinity;
  let tmax = Infinity;
  let inAxis = null; // the slab the ray enters last: the face it hits
  let outAxis = null; // the slab it leaves first: the face it hits from inside
  const axes = ['x', 'y', 'z'];
  for (const axis of axes) {
    if (Math.abs(dir[axis]) < 1e-6) {
      if (origin[axis] < center[axis] - halfSize[axis] || origin[axis] > center[axis] + halfSize[axis]) {
        return null;
      }
    } else {
      const o1 = (center[axis] - halfSize[axis] - origin[axis]) / dir[axis];
      const o2 = (center[axis] + halfSize[axis] - origin[axis]) / dir[axis];
      if (Math.min(o1, o2) > tmin) { tmin = Math.min(o1, o2); inAxis = axis; }
      if (Math.max(o1, o2) < tmax) { tmax = Math.max(o1, o2); outAxis = axis; }
    }
  }
  if (tmax < 0 || tmin > tmax || tmin > maxDistance) return null;
  const inside = tmin < 0;
  const t = inside ? tmax : tmin;
  const point = origin.clone().addScaledVector(dir, t);
  // Which face: the slab that decided the hit. (Picked by "which face is the
  // point on", a ray landing on an edge got the side's normal — straight down
  // onto a platform's rim read as a wall, so walkers couldn't find its top.)
  const normal = new THREE.Vector3();
  const axis = inside ? outAxis : inAxis;
  if (axis) normal[axis] = inside ? Math.sign(dir[axis]) : -Math.sign(dir[axis]);
  else normal.set(0, 1, 0);
  return { point, normal, distance: t };
}
