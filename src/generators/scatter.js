import * as THREE from 'three';
import { terrainHeightAt, paintGrid, PAINTS } from './terrain.js';

/**
 * Scatter — many of one kind of thing over an area: trees, pines, bushes,
 * rocks, grass, flowers. A forest, a meadow, a scree slope, from a few numbers.
 *
 *   kind       what: trees · pines · bushes · rocks · grass · flowers
 *   count      how many (up to 20 000)
 *   size       the area, metres across (square, round the object's middle)
 *   seed       another number, another arrangement
 *   spacing    no two closer than this (m)
 *   clumping   0 spread evenly … 1 in groups
 *   scaleMin, scaleMax   how small and big, of its usual size
 *   maxSlope   not on ground steeper than this (°)
 *   avoidWater not under a terrain's water
 *   color, color2   leaves / trunk (rocks: stone, moss), and variety: how much each differs
 *   solid      trunks and rocks are bumped into (each a box in the scatter's collider)
 *   far        not drawn beyond this (m, 0: always) — grass need not be drawn a valley away
 *   notOn      kept off what is painted on a terrain: nothing · paths · paths and dirt · any paint
 *
 * Each sits on the ground under it: a terrain's (worked out from its settings,
 * not by casting rays), or the scatter's own level where there is none. It is
 * placed again when the land under it changes or it is moved. Drawn as copies
 * (instances) in cells, so a cell out of view costs nothing, and a forest of
 * thousands of trees is a few dozen draws.
 */

export const SCATTER_KINDS = ['trees', 'pines', 'bushes', 'rocks', 'grass', 'flowers'];
export const SCATTER_NOT_ON = ['nothing', 'paths', 'paths and dirt', 'any paint'];
const KEEP_OFF = { nothing: [], paths: ['path'], 'paths and dirt': ['path', 'dirt', 'mud'], 'any paint': PAINTS };
export const SCATTER_LABELS = { trees: 'Trees', pines: 'Pine trees', bushes: 'Bushes', rocks: 'Rocks', grass: 'Grass', flowers: 'Flowers' };

export const SCATTER_DEFAULTS = Object.freeze({
  kind: 'trees', count: 120, size: 60, seed: 1, spacing: 2.5, clumping: 0.3,
  scaleMin: 0.75, scaleMax: 1.3, maxSlope: 35, avoidWater: true,
  color: '#4f7d36', color2: '#6b4a2f', variety: 0.35, solid: true, far: 0, notOn: 'paths',
});

/** What each kind starts with when chosen. */
export const SCATTER_PRESETS = {
  trees: { count: 120, spacing: 2.5, scaleMin: 0.75, scaleMax: 1.3, color: '#4f7d36', color2: '#6b4a2f', solid: true, far: 0, maxSlope: 35 },
  pines: { count: 160, spacing: 2, scaleMin: 0.7, scaleMax: 1.4, color: '#2f5a37', color2: '#5a3d26', solid: true, far: 0, maxSlope: 40 },
  bushes: { count: 200, spacing: 1.2, scaleMin: 0.6, scaleMax: 1.3, color: '#4a7a3a', color2: '#3d6630', solid: false, far: 150, maxSlope: 40 },
  rocks: { count: 80, spacing: 1.5, scaleMin: 0.4, scaleMax: 2, color: '#8a857c', color2: '#5f6e4a', solid: true, far: 0, maxSlope: 60 },
  grass: { count: 3000, spacing: 0.25, scaleMin: 0.7, scaleMax: 1.4, color: '#6a9a45', color2: '#4f7d36', solid: false, far: 70, maxSlope: 45 },
  flowers: { count: 800, spacing: 0.4, scaleMin: 0.7, scaleMax: 1.2, color: '#e86aa0', color2: '#5f8f45', solid: false, far: 70, maxSlope: 40 },
};

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

export function normalizeScatter(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const D = SCATTER_DEFAULTS;
  const color = (k) => (HEX.test(r[k] ?? '') ? r[k].toLowerCase() : D[k]);
  const lo = num(r.scaleMin, 0.05, 10, D.scaleMin);
  return {
    kind: SCATTER_KINDS.includes(r.kind) ? r.kind : D.kind,
    count: Math.round(num(r.count, 0, 20000, D.count)),
    size: num(r.size, 1, 4000, D.size),
    seed: Math.round(num(r.seed, 1, 99999, D.seed)),
    spacing: num(r.spacing, 0, 50, D.spacing),
    clumping: num(r.clumping, 0, 1, D.clumping),
    scaleMin: lo,
    scaleMax: Math.max(lo, num(r.scaleMax, 0.05, 10, D.scaleMax)),
    maxSlope: num(r.maxSlope, 0, 90, D.maxSlope),
    avoidWater: r.avoidWater !== false,
    color: color('color'), color2: color('color2'),
    variety: num(r.variety, 0, 1, D.variety),
    solid: r.solid === undefined ? D.solid : !!r.solid,
    far: num(r.far, 0, 10000, D.far),
    notOn: SCATTER_NOT_ON.includes(r.notOn) ? r.notOn : D.notOn,
  };
}

// ---------------------------------------------------------------- shapes

/** Shapes merged into one (non-indexed, position and normal). */
function merge(parts) {
  const geos = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = geos.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let at = 0;
  for (const g of geos) {
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array, at * 3);
    nrm.set(g.attributes.normal.array, at * 3);
    at += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return out;
}

/** A shape's points nudged, the same way each time: a rock that isn't a perfect solid. */
function lumpy(g, amount, seed) {
  const pos = g.attributes.position;
  const rand = rng(seed);
  const moved = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    if (!moved.has(key)) moved.set(key, 1 + (rand() - 0.5) * amount);
    const k = moved.get(key);
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

/** Grass blades: thin triangles leaning out from a point. */
function blades(n, height, seed) {
  const rand = rng(seed);
  const v = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.6;
    const lean = 0.12 + rand() * 0.15;
    const w = 0.035;
    const h = height * (0.7 + rand() * 0.5);
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    const px = -cz * w;
    const pz = cx * w;
    v.push(px, 0, pz, -px, 0, -pz, cx * lean * h, h, cz * lean * h);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/** Each kind's parts: shape, which of the two colours, whether it casts a shadow, and its collision box (unit scale). */
function kindParts(kind) {
  switch (kind) {
    case 'trees': {
      const trunk = new THREE.CylinderGeometry(0.12, 0.2, 1.8, 6).translate(0, 0.9, 0);
      const crown = merge([
        lumpy(new THREE.IcosahedronGeometry(1.25, 1), 0.25, 3).scale(1, 0.85, 1).translate(0, 2.6, 0),
        lumpy(new THREE.IcosahedronGeometry(0.8, 1), 0.25, 5).translate(0.55, 2.1, 0.3),
      ]);
      return { parts: [{ geometry: trunk, color: 'color2', shadow: true }, { geometry: crown, color: 'color', shadow: true }], box: [0.5, 2.4, 0.5] };
    }
    case 'pines': {
      const trunk = new THREE.CylinderGeometry(0.1, 0.18, 1.4, 6).translate(0, 0.7, 0);
      const crown = merge([
        new THREE.ConeGeometry(1.3, 2.2, 7).translate(0, 2.1, 0),
        new THREE.ConeGeometry(1.0, 1.9, 7).translate(0, 3.2, 0),
        new THREE.ConeGeometry(0.65, 1.6, 7).translate(0, 4.2, 0),
      ]);
      return { parts: [{ geometry: trunk, color: 'color2', shadow: true }, { geometry: crown, color: 'color', shadow: true }], box: [0.45, 2.6, 0.45] };
    }
    case 'bushes':
      return { parts: [{ geometry: lumpy(new THREE.IcosahedronGeometry(0.75, 1), 0.3, 7).scale(1, 0.7, 1).translate(0, 0.42, 0), color: 'color', shadow: true }], box: [1.2, 0.9, 1.2] };
    case 'rocks':
      return { parts: [{ geometry: lumpy(new THREE.DodecahedronGeometry(0.6, 0), 0.45, 11).scale(1.2, 0.7, 1).translate(0, 0.25, 0), color: 'color', shadow: true }], box: [1.2, 0.8, 1] };
    case 'grass':
      return { parts: [{ geometry: blades(7, 0.5, 13), color: 'color', shadow: false, double: true }], box: null };
    case 'flowers':
      return { parts: [
        { geometry: blades(5, 0.35, 17), color: 'color2', shadow: false, double: true },
        { geometry: merge([0, 1, 2].map((i) => new THREE.IcosahedronGeometry(0.06, 0).translate(Math.cos(i * 2.1) * 0.09, 0.32 + i * 0.04, Math.sin(i * 2.1) * 0.09))), color: 'color', shadow: false },
      ], box: null };
    default:
      return { parts: [], box: null };
  }
}

// ---------------------------------------------------------------- where

/** A small, fast, seeded random number maker (0 … 1). */
function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points over the square (−size/2…size/2), clumped and spaced as asked: [x, z, r1, r2, r3] each. */
export function scatterPoints(p) {
  const rand = rng(p.seed);
  const half = p.size / 2;
  const centres = Array.from({ length: Math.max(1, Math.round(p.count / 10)) }, () => [(rand() * 2 - 1) * half, (rand() * 2 - 1) * half]);
  const spread = p.size * 0.07;
  const cellSize = Math.max(p.spacing, 0.01);
  const taken = new Map();
  const key = (cx, cz) => `${cx},${cz}`;
  const tooClose = (x, z) => {
    if (!(p.spacing > 0)) return false;
    const cx = Math.floor(x / cellSize);
    const cz = Math.floor(z / cellSize);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const [ox, oz] of taken.get(key(cx + dx, cz + dz)) || []) if ((ox - x) ** 2 + (oz - z) ** 2 < p.spacing ** 2) return true;
      }
    }
    return false;
  };
  const out = [];
  for (let tries = 0; out.length < p.count && tries < p.count * 6; tries++) {
    let x;
    let z;
    if (rand() < p.clumping) {
      const [cx, cz] = centres[Math.floor(rand() * centres.length)];
      const a = rand() * Math.PI * 2;
      const r = spread * Math.sqrt(-2 * Math.log(Math.max(1e-6, rand()))) * 0.6;
      x = cx + Math.cos(a) * r;
      z = cz + Math.sin(a) * r;
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
    } else {
      x = (rand() * 2 - 1) * half;
      z = (rand() * 2 - 1) * half;
    }
    if (tooClose(x, z)) continue;
    const k = key(Math.floor(x / cellSize), Math.floor(z / cellSize));
    if (!taken.has(k)) taken.set(k, []);
    taken.get(k).push([x, z]);
    out.push([x, z, rand(), rand(), rand()]);
  }
  return out;
}

const _inv = new THREE.Matrix4();
const _w = new THREE.Vector3();
const _l = new THREE.Vector3();

/**
 * The ground at world (x, z): a terrain's height there, how steep (its normal's
 * y) and whether it is under its water — or null where there is no terrain.
 */
export function groundAt(entities, x, z) {
  let best = null;
  for (const e of entities || []) {
    const root = e.object3D;
    const gen = root?.userData?.generator;
    if (gen?.type !== 'terrain' || !root.parent) continue;
    const p = gen.params;
    root.updateWorldMatrix(true, false);
    _inv.copy(root.matrixWorld).invert();
    _l.set(x, 0, z).applyMatrix4(_inv);
    // (the local point at the terrain's own level: y doesn't matter for an upright terrain)
    const lx = _l.x;
    const lz = _l.z;
    const half = p.size / 2;
    if (Math.abs(lx) > half || Math.abs(lz) > half) continue;
    const pads = root.userData.pads || [];
    const h = terrainHeightAt(p, lx, lz, pads);
    const e2 = p.size / Math.max(16, p.detail);
    const dx = (terrainHeightAt(p, lx + e2, lz, pads) - terrainHeightAt(p, lx - e2, lz, pads)) / (2 * e2);
    const dz = (terrainHeightAt(p, lx, lz + e2, pads) - terrainHeightAt(p, lx, lz - e2, pads)) / (2 * e2);
    const up = 1 / Math.hypot(dx, 1, dz);
    _w.set(lx, h, lz).applyMatrix4(root.matrixWorld);
    const wet = p.water > 0 && h < p.water * p.height + 0.15;
    // what is painted there (strongly enough to show), if anything
    let paint = null;
    const painted = paintGrid(p);
    if (painted) {
      const g = Math.round(((lz + half) / p.size) * (painted.n - 1)) * painted.n + Math.round(((lx + half) / p.size) * (painted.n - 1));
      if (painted.layer[g] && painted.weight[g] > 100) paint = PAINTS[painted.layer[g] - 1];
    }
    if (!best || _w.y > best.y) best = { y: _w.y, up, wet, paint, normal: new THREE.Vector3(-dx, 1, -dz).normalize() };
  }
  return best;
}

/** Where scatters find the ground: set by the engine (its entities), for building one wherever it is made. */
export const scatterWorld = { entities: null };

// ---------------------------------------------------------------- building

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qTilt = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();

/** The scatter's parts: its cells of copies — and, solid, one invisible collider of boxes. */
export function buildScatter(raw, { root = null } = {}) {
  const p = normalizeScatter(raw);
  const { parts, box } = kindParts(p.kind);
  if (!p.count || !parts.length) return [];
  const entities = scatterWorld.entities;
  if (root) root.updateWorldMatrix(true, false);
  const toLocal = root ? new THREE.Matrix4().copy(root.matrixWorld).invert() : null;
  const maxSlope = Math.cos(THREE.MathUtils.degToRad(p.maxSlope));
  const lean = p.kind === 'rocks' || p.kind === 'grass' || p.kind === 'flowers' ? 0.8 : p.kind === 'bushes' ? 0.4 : 0;
  // every point, sat on the ground
  const placed = [];
  for (const [x, z, r1, r2, r3] of scatterPoints(p)) {
    let y = 0;
    let normal = null;
    if (root && entities) {
      _w.set(x, 0, z).applyMatrix4(root.matrixWorld);
      const g = groundAt(entities, _w.x, _w.z);
      if (g) {
        if (g.up < maxSlope) continue;
        if (p.avoidWater && g.wet) continue;
        if (g.paint && KEEP_OFF[p.notOn].includes(g.paint)) continue;
        _l.set(_w.x, g.y, _w.z).applyMatrix4(toLocal);
        y = _l.y;
        normal = g.normal;
      }
    }
    placed.push({ x, y, z, yaw: r1 * Math.PI * 2, scale: p.scaleMin + (p.scaleMax - p.scaleMin) * r2, shade: r3, normal });
  }
  // into cells, so what is out of view isn't drawn
  const cell = Math.min(80, Math.max(16, p.size / 6));
  const cells = new Map();
  for (const it of placed) {
    const k = `${Math.floor(it.x / cell)},${Math.floor(it.z / cell)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(it);
  }
  const materials = parts.map((part) => new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.9, metalness: 0, flatShading: part.color === 'color' && p.kind !== 'grass',
    side: part.double ? THREE.DoubleSide : THREE.FrontSide,
  }));
  const base = { color: new THREE.Color(p.color), color2: new THREE.Color(p.color2) };
  const out = [];
  for (const items of cells.values()) {
    parts.forEach((part, pi) => {
      const mesh = new THREE.InstancedMesh(part.geometry, materials[pi], items.length);
      mesh.name = 'Scatter';
      items.forEach((it, i) => {
        _q.setFromAxisAngle(_up, it.yaw);
        if (lean && it.normal) _q.premultiply(_qTilt.setFromUnitVectors(_up, _l.copy(_up).lerp(it.normal, lean).normalize()));
        _m.compose(_pos.set(it.x, it.y, it.z), _q, _scl.setScalar(it.scale));
        mesh.setMatrixAt(i, _m);
        // each a little different: lighter or darker, a touch of another hue
        _col.copy(base[part.color]).offsetHSL((it.shade - 0.5) * 0.06 * p.variety, 0, (it.shade - 0.5) * 0.3 * p.variety);
        mesh.setColorAt(i, _col);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = part.shadow;
      mesh.receiveShadow = true;
      mesh.userData.scatterCell = { far: p.far };
      out.push(mesh);
    });
  }
  // solid: a box round each trunk or rock, all in one invisible mesh the collider is made from
  if (p.solid && box) {
    const boxes = placed.map((it) => {
      const g = new THREE.BoxGeometry(box[0] * it.scale, box[1] * it.scale, box[2] * it.scale);
      g.rotateY(it.yaw);
      g.translate(it.x, it.y + (box[1] * it.scale) / 2, it.z);
      return g;
    });
    if (boxes.length) {
      const colliders = new THREE.Mesh(merge(boxes), new THREE.MeshBasicMaterial({ visible: false }));
      colliders.name = 'Colliders';
      colliders.visible = false;
      out.push(colliders);
    }
  }
  return out;
}

/**
 * Scatters placed again when what they stand on changes — a terrain made
 * again, moved, levelled under a house — or they themselves are moved. Not
 * every frame while it is dragged: once it has stopped (a quarter of a second).
 */
export class ScatterSystem {
  constructor(engine, regenerate) {
    this.engine = engine;
    this.regenerate = regenerate;
    this._ids = new WeakMap();
    this._next = 1;
    this._sig = new Map(); // scatter object -> what it was placed for
    this._settle = 0;
  }

  _id(o) {
    if (!o) return 0;
    if (!this._ids.has(o)) this._ids.set(o, this._next++);
    return this._ids.get(o);
  }

  update(dt = 0) {
    const entities = this.engine.entities || [];
    scatterWorld.entities = entities;
    const scatters = entities.filter((e) => e.object3D?.userData?.generator?.type === 'scatter' && e.object3D.parent);
    if (!scatters.length) return;
    let land = '';
    for (const e of entities) {
      const o = e.object3D;
      if (o?.userData?.generator?.type !== 'terrain' || !o.parent) continue;
      land += `${this._id(o.userData.generator.params)}:${this._id(o.userData.pads)}:${o.matrixWorld.elements.map((v) => v.toFixed(2)).join(',')};`;
    }
    // what a scatter was placed for: the land, its own settings, where it is
    const sigOf = (o) => `${land}|${this._id(o.userData.generator.params)}|${o.matrixWorld.elements.map((v) => v.toFixed(2)).join(',')}`;
    const stale = scatters.filter((e) => this._sig.get(e.object3D) !== sigOf(e.object3D));
    if (!stale.length) { this._settle = 0; return; }
    // the first time (a level loaded): at once; changing (dragged): once it has stopped
    const first = stale.every((e) => !this._sig.has(e.object3D));
    if (!first) {
      if (this._settle <= 0) this._settle = 0.25;
      this._settle -= dt;
      if (this._settle > 0) return;
    }
    this._settle = 0;
    for (const e of stale) {
      this.regenerate(e.object3D, e.object3D.userData.generator.params);
      this._sig.set(e.object3D, sigOf(e.object3D)); // (made again: its settings are a new object)
      if (e.rigidBody && this.engine.physics) {
        this.engine.physics.unregister(e);
        this.engine.physics.register(e);
      }
    }
  }
}

