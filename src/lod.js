import * as THREE from 'three';

/**
 * Level of detail — far things drawn simpler, and farther ones not at all.
 *
 *   - An object with a Level of detail component is drawn with a simpler
 *     version of its shape beyond "Simpler from" (made here, automatically),
 *     and not drawn beyond "Hide from".
 *   - The level's Draw distance hides anything farther than that, for objects
 *     with no Level of detail of their own.
 *
 * Only the drawing changes, and only while it's drawn (apply, then the
 * restore it returns). Physics, clicks and shots always see the object as it
 * is, and so does the editor: all of this is for play.
 */

// ---------------------------------------------------------------- simplifying

/**
 * A simpler copy of a shape, with about `ratio` of its points (0.5, 0.25,
 * 0.1). Vertex clustering: the shape's box is cut into a grid, the points
 * in each cell become one (their average), and triangles squashed flat are
 * dropped. It takes time in proportion to its size, however big, and far
 * away the difference doesn't show. Null when it's too simple to bother with.
 */
export function simplify(geometry, ratio = 0.25) {
  const pos = geometry?.attributes?.position;
  if (!pos || pos.count < 300) return null;
  const index = geometry.index;
  const tris = index ? index.count : pos.count;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const want = Math.max(24, Math.round(pos.count * ratio));
  // points on a surface: the occupied cells grow with the square of the grid
  let res = Math.max(2, Math.round(Math.sqrt(want) * 1.2));
  let built = null;
  for (let tries = 0; tries < 4; tries++) {
    built = cluster(geometry, box, longest / res, index, tris);
    const got = built.count;
    if (got <= want * 1.4 || res <= 2) break;
    res = Math.max(2, Math.floor(res * Math.sqrt(want / got)));
  }
  if (!built || built.count >= pos.count * 0.9) return null; // no simpler than it was
  return built.geometry;
}

function cluster(geometry, box, cell, index, tris) {
  const pos = geometry.attributes.position;
  const names = Object.keys(geometry.attributes).filter((n) => n !== 'normal' && !n.startsWith('skin'));
  const cellOf = new Map(); // grid cell -> new point
  const remap = new Uint32Array(pos.count);
  const sums = names.map((n) => []);
  const counts = [];
  for (let i = 0; i < pos.count; i++) {
    const ix = Math.floor((pos.getX(i) - box.min.x) / cell);
    const iy = Math.floor((pos.getY(i) - box.min.y) / cell);
    const iz = Math.floor((pos.getZ(i) - box.min.z) / cell);
    const key = `${ix},${iy},${iz}`;
    let k = cellOf.get(key);
    if (k === undefined) {
      k = counts.length;
      cellOf.set(key, k);
      counts.push(0);
      names.forEach((n, a) => { for (let c = 0; c < geometry.attributes[n].itemSize; c++) sums[a].push(0); });
    }
    remap[i] = k;
    counts[k]++;
    names.forEach((n, a) => {
      const attr = geometry.attributes[n];
      for (let c = 0; c < attr.itemSize; c++) sums[a][k * attr.itemSize + c] += attr.getComponent(i, c);
    });
  }
  const out = new THREE.BufferGeometry();
  names.forEach((n, a) => {
    const attr = geometry.attributes[n];
    const s = sums[a];
    for (let k = 0; k < counts.length; k++) for (let c = 0; c < attr.itemSize; c++) s[k * attr.itemSize + c] /= counts[k];
    out.setAttribute(n, new THREE.Float32BufferAttribute(s, attr.itemSize, attr.normalized));
  });
  // triangles, group by group (a model with several materials keeps them)
  const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: tris, materialIndex: 0 }];
  const indices = [];
  for (const g of groups) {
    const from = indices.length;
    for (let t = g.start; t < g.start + g.count; t += 3) {
      const a = remap[index ? index.getX(t) : t];
      const b = remap[index ? index.getX(t + 1) : t + 1];
      const c = remap[index ? index.getX(t + 2) : t + 2];
      if (a !== b && b !== c && a !== c) indices.push(a, b, c);
    }
    out.addGroup(from, indices.length - from, g.materialIndex ?? 0);
  }
  out.setIndex(indices);
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return { geometry: out, count: counts.length };
}

// ---------------------------------------------------------------- drawing by distance

const RATIOS = { '50%': 0.5, '25%': 0.25, '10%': 0.1 };
const _p = new THREE.Vector3();
const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();

export class LodSystem {
  constructor(engine) {
    this.engine = engine;
    this._simpler = new WeakMap(); // full shape -> { ratio: simpler shape | null }
    this._queue = [];              // [geometry, ratio] waiting to be simplified
    this._radius = new WeakMap();  // object -> how big it is (for its distance)
  }

  /** The simpler shape, if made — else queued, and the full one meanwhile. */
  simplerOf(geometry, ratio) {
    let byRatio = this._simpler.get(geometry);
    if (!byRatio) this._simpler.set(geometry, (byRatio = {}));
    if (ratio in byRatio) return byRatio[ratio];
    if (!this._queue.some(([g, r]) => g === geometry && r === ratio)) this._queue.push([geometry, ratio]);
    return null;
  }

  /** Make simpler shapes a few milliseconds a frame, so the game doesn't stutter. */
  work(budgetMs = 6) {
    const start = performance.now();
    while (this._queue.length && performance.now() - start < budgetMs) {
      const [geometry, ratio] = this._queue.shift();
      const byRatio = this._simpler.get(geometry) ?? {};
      try { byRatio[ratio] = simplify(geometry, ratio); } catch { byRatio[ratio] = null; }
      this._simpler.set(geometry, byRatio);
    }
  }

  _distance(o, camera) {
    let r = this._radius.get(o);
    if (r === undefined) {
      _box.setFromObject(o);
      r = _box.isEmpty() ? 0 : _box.getBoundingSphere(_sphere).radius;
      if (!_box.isEmpty()) this._radius.set(o, r);
    }
    return { d: Math.max(0, o.getWorldPosition(_p).distanceTo(camera.position) - r), r };
  }

  /**
   * Before drawing: far objects simpler or hidden. Returns what puts them back,
   * to call once drawn. Only in play.
   */
  apply(camera) {
    const engine = this.engine;
    if (!engine.playing || !camera) return null;
    const undo = [];
    const own = new Set();
    for (const c of engine.gameplay?.components.instances || []) {
      if (c.type !== 'lod' || c.entity.alive === false) continue;
      const o = c.entity.object3D;
      if (!o?.parent || !o.visible) continue;
      own.add(c.entity);
      const { d } = this._distance(o, camera);
      const hideFrom = Number(c.props.hideFrom) || 0;
      if (hideFrom > 0 && d > hideFrom) {
        o.visible = false;
        undo.push(() => { o.visible = true; });
        continue;
      }
      const from = Number(c.props.simplerFrom) || 0;
      if (from > 0 && d > from) {
        const ratio = RATIOS[c.props.detail] ?? 0.25;
        o.traverse((n) => {
          if (!n.isMesh || n.isSkinnedMesh || n.isInstancedMesh || !n.geometry) return;
          const simpler = this.simplerOf(n.geometry, ratio);
          if (!simpler) return;
          const full = n.geometry;
          n.geometry = simpler;
          undo.push(() => { n.geometry = full; });
        });
      }
    }
    // the level's draw distance, for everything with no detail of its own
    const far = Number(engine.environment?.settings?.drawDistance) || 0;
    if (far > 0) {
      for (const e of engine.entities) {
        const o = e.object3D;
        if (own.has(e) || !o?.parent || !o.visible || o.isLight || e === engine.playerEntity || e.viewModel) continue;
        if (this._distance(o, camera).d > far) {
          o.visible = false;
          undo.push(() => { o.visible = true; });
        }
      }
    }
    this.work();
    return undo.length ? () => { for (let i = undo.length - 1; i >= 0; i--) undo[i](); } : null;
  }
}
