import * as THREE from 'three';

/**
 * Mesh colliders — an object collides as its real triangles, not as one box
 * round the whole of it. A GLB house can be walked into, a room walked round,
 * a hilly terrain walked over; the camera stays inside its walls.
 *
 * For what doesn't move by physics (static and kinematic bodies): level
 * geometry. A moving (dynamic) body keeps a box, sphere or capsule.
 *
 * The triangles are kept in the object's own space in a bounding-volume tree,
 * built once. Each test turns the query into that space to find the few
 * triangles near it, and turns just those into the world — so an object that
 * is moved, turned or scaled (unevenly too) collides exactly, and nothing is
 * rebuilt when a platform moves.
 */

const LEAF = 8; // triangles per leaf

/**
 * Every triangle of an object, in its own space (its place, turn and size
 * removed): a Float32Array, 9 numbers per triangle. Invisible meshes count —
 * a level's collision stand-ins are often hidden.
 */
export function objectTriangles(object3D, skip = null) {
  object3D.updateWorldMatrix(true, true);
  const inverse = new THREE.Matrix4().copy(object3D.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const out = [];
  object3D.traverse((n) => {
    const g = n.geometry;
    if (!n.isMesh || !g?.attributes?.position || skip?.has(n)) return; // a part left out of it
    if (n.isInstancedMesh) return; // copies drawn of one shape (a scatter's trees): its own collider stands in
    rel.multiplyMatrices(inverse, n.matrixWorld);
    const pos = g.attributes.position;
    const index = g.index;
    const count = index ? index.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, index ? index.getX(i + k) : i + k).applyMatrix4(rel);
        out.push(v.x, v.y, v.z);
      }
    }
  });
  return new Float32Array(out);
}

/** A bounding-volume tree over triangles: which ones are near a box, or along a ray. */
export class TriangleBVH {
  constructor(tris) {
    this.tris = tris;
    const n = tris.length / 9;
    this.count = n;
    this.order = new Uint32Array(n);
    const centroid = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) {
      this.order[t] = t;
      for (let k = 0; k < 3; k++) centroid[t * 3 + k] = (tris[t * 9 + k] + tris[t * 9 + 3 + k] + tris[t * 9 + 6 + k]) / 3;
    }
    // nodes: min xyz, max xyz; for a leaf [start, count], else [left, right] (negated count marks a leaf)
    this.min = [];
    this.max = [];
    this.a = [];
    this.b = [];
    this._build(0, n, centroid);
    this.min = Float32Array.from(this.min);
    this.max = Float32Array.from(this.max);
    this.a = Int32Array.from(this.a);
    this.b = Int32Array.from(this.b);
  }

  _build(start, end, centroid) {
    const node = this.a.length;
    this.a.push(0);
    this.b.push(0);
    let [x0, y0, z0, x1, y1, z1] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let [cx0, cy0, cz0, cx1, cy1, cz1] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = this.order[i];
      for (let k = 0; k < 9; k += 3) {
        const x = this.tris[t * 9 + k];
        const y = this.tris[t * 9 + k + 1];
        const z = this.tris[t * 9 + k + 2];
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
        if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
      }
      const cx = centroid[t * 3];
      const cy = centroid[t * 3 + 1];
      const cz = centroid[t * 3 + 2];
      if (cx < cx0) cx0 = cx; if (cy < cy0) cy0 = cy; if (cz < cz0) cz0 = cz;
      if (cx > cx1) cx1 = cx; if (cy > cy1) cy1 = cy; if (cz > cz1) cz1 = cz;
    }
    this.min.push(x0, y0, z0);
    this.max.push(x1, y1, z1);
    if (end - start <= LEAF) {
      this.a[node] = start;
      this.b[node] = -(end - start); // a leaf
      return node;
    }
    // split the longest side of the centres' box at its middle
    const spans = [cx1 - cx0, cy1 - cy0, cz1 - cz0];
    const axis = spans.indexOf(Math.max(...spans));
    const mid = [cx0 + cx1, cy0 + cy1, cz0 + cz1][axis] / 2;
    let i = start;
    let j = end - 1;
    while (i <= j) {
      if (centroid[this.order[i] * 3 + axis] < mid) i++;
      else {
        const tmp = this.order[i];
        this.order[i] = this.order[j];
        this.order[j] = tmp;
        j--;
      }
    }
    if (i === start || i === end) i = (start + end) >> 1; // all in one place: split them evenly
    this.a[node] = this._build(start, i, centroid);
    this.b[node] = this._build(i, end, centroid);
    return node;
  }

  /** Call `fn(triangle)` for each triangle whose bounds touch the box min..max. */
  query(min, max, fn) {
    if (!this.count) return;
    const stack = [0];
    const { tris } = this;
    while (stack.length) {
      const node = stack.pop();
      const o = node * 3;
      if (this.min[o] > max.x || this.max[o] < min.x || this.min[o + 1] > max.y || this.max[o + 1] < min.y
        || this.min[o + 2] > max.z || this.max[o + 2] < min.z) continue;
      if (this.b[node] <= 0) {
        const start = this.a[node];
        const end = start - this.b[node];
        for (let i = start; i < end; i++) {
          const t = this.order[i];
          const p = t * 9;
          if (Math.min(tris[p], tris[p + 3], tris[p + 6]) > max.x || Math.max(tris[p], tris[p + 3], tris[p + 6]) < min.x
            || Math.min(tris[p + 1], tris[p + 4], tris[p + 7]) > max.y || Math.max(tris[p + 1], tris[p + 4], tris[p + 7]) < min.y
            || Math.min(tris[p + 2], tris[p + 5], tris[p + 8]) > max.z || Math.max(tris[p + 2], tris[p + 5], tris[p + 8]) < min.z) continue;
          fn(t);
        }
      } else {
        stack.push(this.a[node], this.b[node]);
      }
    }
  }

  /**
   * The first triangle along the segment from `origin` to `origin + dir`
   * (both sides of a triangle count): { t (0..1 along it), tri } or null.
   */
  raycast(origin, dir) {
    if (!this.count) return null;
    let best = null;
    const stack = [0];
    const inv = [1 / dir.x, 1 / dir.y, 1 / dir.z];
    const o = [origin.x, origin.y, origin.z];
    while (stack.length) {
      const node = stack.pop();
      // slab test against the node's box, within what is already the best
      let t0 = 0;
      let t1 = best ? best.t : 1;
      for (let k = 0; k < 3; k++) {
        let a = (this.min[node * 3 + k] - o[k]) * inv[k];
        let b = (this.max[node * 3 + k] - o[k]) * inv[k];
        if (a > b) [a, b] = [b, a];
        if (Number.isNaN(a) || Number.isNaN(b)) continue; // parallel and on its edge
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
      }
      if (t0 > t1) continue;
      if (this.b[node] <= 0) {
        const start = this.a[node];
        for (let i = start; i < start - this.b[node]; i++) {
          const t = rayTriangle(origin, dir, this.tris, this.order[i] * 9);
          if (t !== null && (!best || t < best.t)) best = { t, tri: this.order[i] };
        }
      } else {
        stack.push(this.a[node], this.b[node]);
      }
    }
    return best;
  }
}

const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _tv = new THREE.Vector3();
const _qv = new THREE.Vector3();

/** Möller–Trumbore, both sides: how far along `dir` (0..1) the triangle at `tris[p]` is, or null. */
function rayTriangle(origin, dir, tris, p) {
  _e1.set(tris[p + 3] - tris[p], tris[p + 4] - tris[p + 1], tris[p + 5] - tris[p + 2]);
  _e2.set(tris[p + 6] - tris[p], tris[p + 7] - tris[p + 1], tris[p + 8] - tris[p + 2]);
  _pv.crossVectors(dir, _e2);
  const det = _e1.dot(_pv);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  _tv.set(origin.x - tris[p], origin.y - tris[p + 1], origin.z - tris[p + 2]);
  const u = _tv.dot(_pv) * inv;
  if (u < 0 || u > 1) return null;
  _qv.crossVectors(_tv, _e1);
  const v = dir.dot(_qv) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = _e2.dot(_qv) * inv;
  return t >= 0 && t <= 1 ? t : null;
}

/** A mesh shape for an object: its triangles, their tree and their bounds (own space). Null if it has none. */
export function meshShape(object3D, skip = null) {
  const tris = objectTriangles(object3D, skip);
  if (!tris.length) return null;
  const box = new THREE.Box3();
  for (let i = 0; i < tris.length; i += 3) box.expandByPoint(_pv.set(tris[i], tris[i + 1], tris[i + 2]));
  return { tris, bvh: new TriangleBVH(tris), box };
}

// ---------------------------------------------------------------- contacts
// Each returns { n, depth }: move the moving shape by n * depth to leave the triangle.
// `from` is where the shape was before this step, so one that has sunk more than
// halfway through a thin floor is still pushed back out the side it came from.

const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _ap = new THREE.Vector3();
const _bp = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _bestP = new THREE.Vector3();
const _bestQ = new THREE.Vector3();
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _r = new THREE.Vector3();

/** The triangle's unit normal into `out`, or false for a sliver with none. */
function triangleNormal(a, b, c, out) {
  out.crossVectors(_ab.subVectors(b, a), _ac.subVectors(c, a));
  const len = out.length();
  if (len < 1e-12) return false;
  out.divideScalar(len);
  return true;
}

/** The point of triangle abc closest to p (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestOnTriangle(p, a, b, c, out) {
  _ab.subVectors(b, a);
  _ac.subVectors(c, a);
  _ap.subVectors(p, a);
  const d1 = _ab.dot(_ap);
  const d2 = _ac.dot(_ap);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);
  _bp.subVectors(p, b);
  const d3 = _ab.dot(_bp);
  const d4 = _ac.dot(_bp);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return out.copy(a).addScaledVector(_ab, d1 / (d1 - d3));
  _cp.subVectors(p, c);
  const d5 = _ab.dot(_cp);
  const d6 = _ac.dot(_cp);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return out.copy(a).addScaledVector(_ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return out.copy(b).addScaledVector(_c.subVectors(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  }
  const denom = 1 / (va + vb + vc);
  return out.copy(a).addScaledVector(_ab, vb * denom).addScaledVector(_ac, vc * denom);
}

/** Closest points of segments p1q1 and p2q2 into c1, c2 (Ericson 5.1.9), without allocating. */
function segmentSegment(p1, q1, p2, q2, c1, c2) {
  _s1.subVectors(q1, p1);
  _s2.subVectors(q2, p2);
  _r.subVectors(p1, p2);
  const a = _s1.dot(_s1);
  const e = _s2.dot(_s2);
  const f = _s2.dot(_r);
  let s;
  let t;
  if (a <= 1e-12 && e <= 1e-12) { s = 0; t = 0; }
  else if (a <= 1e-12) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = _s1.dot(_r);
    if (e <= 1e-12) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = _s1.dot(_s2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  c1.copy(p1).addScaledVector(_s1, s);
  c2.copy(p2).addScaledVector(_s2, t);
}

function insideTriangle(p, a, b, c, n) {
  const edge = (u, v) => _q.crossVectors(_ab.subVectors(v, u), _ap.subVectors(p, u)).dot(n) >= -1e-9;
  return edge(a, b) && edge(b, c) && edge(c, a);
}

/**
 * A capsule (or a sphere: a === b) against triangle abc. Its rounded shape
 * meets faces, edges and corners where they really are.
 */
export function capsuleTriangle(C, a, b, c, from = C.center) {
  if (!triangleNormal(a, b, c, _n)) return null;
  const d0 = _n.dot(_p.subVectors(C.a, a));
  const d1 = _n.dot(_p.subVectors(C.b, a));
  const side = _n.dot(_p.subVectors(from, a)) >= 0 ? 1 : -1; // the face it came at
  const normal = _n.clone().multiplyScalar(side);
  const faceDepth = () => C.r - Math.min(side * d0, side * d1);

  // the capsule's core passes through the face
  if (d0 * d1 <= 0) {
    const t = d0 === d1 ? 0 : d0 / (d0 - d1);
    _p.copy(C.a).lerp(C.b, t);
    if (insideTriangle(_p, a, b, c, _n)) return { n: normal, depth: faceDepth() };
  }

  // otherwise its core's nearest point to the triangle: an end over the face, or an edge
  let best = Infinity;
  const consider = () => {
    const d2 = _p.distanceToSquared(_q);
    if (d2 < best) { best = d2; _bestP.copy(_p); _bestQ.copy(_q); }
  };
  for (const end of [C.a, C.b]) {
    closestOnTriangle(end, a, b, c, _q);
    _p.copy(end);
    consider();
    if (C.a.equals(C.b)) break; // a sphere: one end
  }
  for (const [u, v] of [[a, b], [b, c], [c, a]]) {
    segmentSegment(C.a, C.b, u, v, _p, _q);
    consider();
  }
  if (best >= C.r * C.r) return null;
  const dist = Math.sqrt(best);
  if (dist < 1e-6) return { n: normal, depth: faceDepth() };
  const n = _bestP.clone().sub(_bestQ).divideScalar(dist);
  // Pushed through to the other side since the last step: back out the way it came.
  // Only if it was over this very triangle — beside a convex edge (the lip of a
  // pit, the top of a ramp) a body is "behind" the plane of a face it never
  // crossed, and was thrown along that face (half a metre, in one step).
  if (n.dot(normal) < -1e-3 && overTriangle(from, a, b, c)) return { n: normal, depth: faceDepth() };
  return { n, depth: C.r - dist };
}

const _over = new THREE.Vector3();
/** Is point p over (or under) triangle abc — inside it, seen along its normal? */
function overTriangle(p, a, b, c) {
  const along = _n.dot(_over.subVectors(p, a));
  _over.copy(p).addScaledVector(_n, -along);
  return insideTriangle(_over, a, b, c, _n);
}

const _axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _edges = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _L = new THREE.Vector3();

/**
 * A box against triangle abc. They touch if no separating axis says otherwise
 * (the full test: box faces, the triangle's face, their edges). A touching box
 * is pushed straight out of the triangle's face — so sliding over the seam
 * between two triangles of a flat floor never nudges it sideways, as pushing
 * along the least overlap would.
 */
export function boxTriangle(B, a, b, c, from = B.center) {
  if (!triangleNormal(a, b, c, _n)) return null;
  _a.subVectors(a, B.center);
  _b.subVectors(b, B.center);
  _c.subVectors(c, B.center);
  _edges[0].subVectors(_b, _a);
  _edges[1].subVectors(_c, _b);
  _edges[2].subVectors(_a, _c);
  const radius = (axis) => B.half.x * Math.abs(B.axes[0].dot(axis)) + B.half.y * Math.abs(B.axes[1].dot(axis))
    + B.half.z * Math.abs(B.axes[2].dot(axis));
  const apart = (axis) => {
    if (axis.lengthSq() < 1e-12) return false; // parallel edges: no axis
    const p0 = _a.dot(axis);
    const p1 = _b.dot(axis);
    const p2 = _c.dot(axis);
    const r = radius(axis);
    return Math.min(p0, p1, p2) >= r || Math.max(p0, p1, p2) <= -r;
  };
  for (let i = 0; i < 3; i++) if (apart(B.axes[i])) return null;
  if (apart(_n)) return null;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) if (apart(_L.crossVectors(B.axes[i], _edges[j]))) return null;
  }
  const side = _n.dot(_p.subVectors(from, a)) >= 0 ? 1 : -1;
  const normal = _n.clone().multiplyScalar(side);
  // the face is at distance d along the normal from the centre; the box reaches rN
  const d = normal.dot(_a);
  return { n: normal, depth: d + radius(normal) };
}
