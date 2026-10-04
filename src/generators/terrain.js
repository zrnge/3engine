import * as THREE from 'three';
import { fbm, ridged, smoothstep } from './noise.js';
import { decodeBytes, decodeInt16, sampleGrid } from '../grid-codec.js';
import { makeProceduralTexture } from '../texgen.js';

/**
 * Terrain — ground shaped from a few numbers: a field, rolling hills, a valley
 * with a river, a mountain, a mountain range, a crater, an island, a plateau.
 *
 *   shape      which kind of land
 *   size       metres across (square)
 *   height     metres from its lowest to its highest
 *   roughness  0 smooth … 1 rugged (more, finer bumps)
 *   seed       a different seed, different land of the same kind
 *   detail     cells along a side (more: smoother, heavier)
 *   water      water level, 0…1 of its height (0: none) — a lake, a river, the sea
 *   colours    grass, rock (where it's steep), snow (above the snow line), sand (by the water), water
 *   ground     'textured' (a fine grain, tiled every groundScale metres) or 'plain'
 *   sculpt     heights raised and lowered by hand: { n, data } — an n × n grid of centimetres (grid-codec.js)
 *   paint      ground painted by hand: { n, layer, weight } — which paint (PAINTS) and how strongly, per point
 *
 * Only these are saved; the land is made again from them. Its middle is at
 * the object's origin, its ground level at y = 0. Over 128 cells it is made in
 * chunks (see chunkLayout): each drawn simpler far away (terrain-lod.js), each
 * its own part of the collider.
 */

export const TERRAIN_SHAPES = ['field', 'hills', 'valley', 'mountain', 'mountains', 'crater', 'island', 'plateau'];
export const TERRAIN_SHAPE_LABELS = {
  field: 'Field (nearly flat)', hills: 'Rolling hills', valley: 'Valley with a river', mountain: 'A mountain',
  mountains: 'Mountain range', crater: 'Crater', island: 'Island in the sea', plateau: 'Plateau (flat top)',
};
const DETAILS = [32, 64, 96, 128, 192, 256, 384, 512, 768, 1024];
/** Cells along a chunk's side, at most: more detail than that is more chunks. */
const CHUNK_CELLS = 128;
export const TERRAIN_DETAILS = DETAILS;

/** What can be painted on the ground, in order (a painted point stores 1 + its index). */
export const PAINTS = ['grass', 'dark grass', 'dirt', 'path', 'mud', 'flowers', 'rock', 'sand', 'snow'];

export const TERRAIN_DEFAULTS = Object.freeze({
  shape: 'hills', size: 120, height: 14, roughness: 0.5, seed: 1, detail: 128, water: 0,
  grass: '#5f8f45', rock: '#7d7468', snow: '#f2f4f7', sand: '#d9c48f', waterColor: '#2f6f9f',
  snowLine: 1, rockSlope: 0.5,
  ground: 'textured', groundScale: 3,
  dirt: '#7a5a3a', path: '#a8977a', darkGrass: '#3d6630', flowers: '#d77fb0',
  sculpt: null, paint: null,
});

/** What each shape starts with when chosen: a height that suits it, and water for the island and the river. */
export const TERRAIN_SHAPE_PRESETS = {
  field: { height: 3, roughness: 0.35, water: 0, snowLine: 1 },
  hills: { height: 14, roughness: 0.5, water: 0, snowLine: 1 },
  valley: { height: 30, roughness: 0.5, water: 0.08, snowLine: 1 },
  mountain: { height: 60, roughness: 0.55, water: 0, snowLine: 0.75 },
  mountains: { height: 70, roughness: 0.6, water: 0, snowLine: 0.7 },
  crater: { height: 25, roughness: 0.45, water: 0.15, snowLine: 1 },
  island: { height: 22, roughness: 0.5, water: 0.22, snowLine: 1 },
  plateau: { height: 20, roughness: 0.45, water: 0, snowLine: 1 },
};

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

export function normalizeTerrain(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const D = TERRAIN_DEFAULTS;
  const color = (k) => (HEX.test(r[k] ?? '') ? r[k].toLowerCase() : D[k]);
  const detail = Number(r.detail);
  return {
    shape: TERRAIN_SHAPES.includes(r.shape) ? r.shape : D.shape,
    size: num(r.size, 4, 4000, D.size),
    height: num(r.height, 0, 1000, D.height),
    roughness: num(r.roughness, 0, 1, D.roughness),
    seed: Math.round(num(r.seed, 1, 99999, D.seed)),
    detail: DETAILS.includes(detail) ? detail : D.detail,
    water: num(r.water, 0, 1, D.water),
    grass: color('grass'), rock: color('rock'), snow: color('snow'), sand: color('sand'), waterColor: color('waterColor'),
    snowLine: num(r.snowLine, 0, 1, D.snowLine),
    rockSlope: num(r.rockSlope, 0, 1, D.rockSlope),
    ground: r.ground === 'plain' ? 'plain' : 'textured',
    groundScale: num(r.groundScale, 0.25, 50, D.groundScale),
    dirt: color('dirt'), path: color('path'), darkGrass: color('darkGrass'), flowers: color('flowers'),
    sculpt: gridOf(r.sculpt, ['data']),
    paint: gridOf(r.paint, ['layer', 'weight']),
  };
}

// settings objects as read (a scatter asks a terrain's height thousands of times, with the same settings)
const _normalized = new WeakMap();
function normalized(raw) {
  if (!raw || typeof raw !== 'object') return normalizeTerrain(raw);
  let p = _normalized.get(raw);
  if (!p) { p = normalizeTerrain(raw); _normalized.set(raw, p); }
  return p;
}

/** A saved grid kept only if it is one: { n, …its encoded fields }. */
function gridOf(g, fields) {
  if (!g || typeof g !== 'object') return null;
  const n = Math.round(Number(g.n));
  if (!(n >= 2 && n <= 2049) || !fields.every((f) => typeof g[f] === 'string')) return null;
  const out = { n };
  for (const f of fields) out[f] = g[f];
  return out;
}

// decoded grids, kept while they are the same text (a terrain is made again often while it is edited)
const _decoded = new Map();
function decoded(key, make) {
  if (_decoded.has(key)) return _decoded.get(key);
  const v = make();
  _decoded.set(key, v);
  if (_decoded.size > 12) _decoded.delete(_decoded.keys().next().value);
  return v;
}

/** Its sculpted heights: { n, values (cm) }, or null. */
export function sculptGrid(p) {
  const g = p.sculpt;
  if (!g) return null;
  return decoded(`s${g.n}|${g.data}`, () => ({ n: g.n, values: decodeInt16(g.data, g.n * g.n) }));
}

/** Its painted ground: { n, layer, weight } (bytes), or null. */
export function paintGrid(p) {
  const g = p.paint;
  if (!g) return null;
  return decoded(`p${g.n}|${g.layer}|${g.weight}`, () => ({ n: g.n, layer: decodeBytes(g.layer, g.n * g.n), weight: decodeBytes(g.weight, g.n * g.n) }));
}

/** Each paint's colour, by its stored number (1…). */
function paintColours(p) {
  const by = { grass: p.grass, 'dark grass': p.darkGrass, dirt: p.dirt, path: p.path, mud: null, flowers: p.flowers, rock: p.rock, sand: p.sand, snow: p.snow };
  const out = [null];
  for (const name of PAINTS) {
    out.push(name === 'mud' ? new THREE.Color(p.dirt).multiplyScalar(0.55) : new THREE.Color(by[name]));
  }
  return out;
}

/**
 * How high the land is, 0…1 of its height (a little under 0 for an island's
 * sea floor), at (u, v): −1…1 across it.
 */
function shapeAt(p, u, v) {
  const octaves = 2 + Math.round(p.roughness * 5);
  const gain = 0.35 + p.roughness * 0.25;
  const opts = { seed: p.seed, octaves, gain };
  const n = fbm(u * 2.2 + 11, v * 2.2 + 7, opts); // −1…1
  const r = Math.hypot(u, v);
  const bump = (k) => n * k * (0.4 + p.roughness);
  switch (p.shape) {
    case 'field':
      return 0.5 + bump(0.5);
    case 'hills':
      return Math.max(0, 0.5 + 0.5 * fbm(u * 1.6 + 3, v * 1.6 - 5, opts)) ** 1.15;
    case 'valley': {
      // low along the middle (a river runs north–south), rising to both sides
      const across = Math.abs(u + 0.12 * fbm(v * 1.5, 3, { seed: p.seed + 9, octaves: 2 }));
      return smoothstep(0.06, 0.95, across) ** 1.3 * (0.8 + 0.2 * n) + Math.max(0, bump(0.04));
    }
    case 'mountain': {
      const peak = (1 - smoothstep(0, 1, r)) ** 1.7;
      const ridges = ridged(u * 2.5 + 1, v * 2.5 + 2, opts);
      return peak * (0.75 + 0.45 * ridges) + Math.max(0, bump(0.03));
    }
    case 'mountains': {
      const edge = 1 - smoothstep(0.75, 1, Math.max(Math.abs(u), Math.abs(v)));
      return ridged(u * 1.8 + 4, v * 1.8 - 1, opts) ** 1.6 * edge;
    }
    case 'crater': {
      const rim = Math.exp(-(((r - 0.48) / 0.16) ** 2));
      const bowl = -0.35 * (1 - smoothstep(0, 0.46, r));
      const outside = 1 - smoothstep(0.6, 1, r);
      return Math.max(-0.2, (rim + bowl) * (0.85 + 0.15 * n) * Math.max(outside, 0.15) + 0.15 + bump(0.03));
    }
    case 'island': {
      const land = 1 - (r / 0.8) ** 1.6;
      return Math.max(-0.15, land * (0.75 + 0.35 * n) + bump(0.02)); // a shallow sea floor round it
    }
    case 'plateau': {
      const t = smoothstep(0, 0.12, 0.55 - r + 0.08 * n);
      return t * (0.92 + 0.08 * n) + Math.max(0, bump(0.04));
    }
    default:
      return 0;
  }
}

/**
 * Level ground under things standing on it (a house, a camp, a road): each pad
 * is a rectangle in the terrain's own space — { x, z (its middle), hx, hz (half
 * its size), cos, sin (its turn), level, blend (m) }. Inside it the ground is at
 * its level; within `blend` of it, it eases back to the land's own height.
 */
export function applyPads(h, x, z, pads) {
  for (const pad of pads) {
    const dx = x - pad.x;
    const dz = z - pad.z;
    const lx = dx * pad.cos + dz * pad.sin; // into the pad's own axes
    const lz = -dx * pad.sin + dz * pad.cos;
    const out = Math.hypot(Math.max(0, Math.abs(lx) - pad.hx), Math.max(0, Math.abs(lz) - pad.hz));
    if (out >= pad.blend) continue;
    h = out <= 0 ? pad.level : pad.level + (h - pad.level) * smoothstep(0, pad.blend, out);
  }
  return h;
}

/** The ground's height in metres at (x, z) in the terrain's own space (levelled under `pads`, if any). */
export function terrainHeightAt(raw, x, z, pads = []) {
  const p = normalized(raw);
  const half = p.size / 2;
  let h = shapeAt(p, x / half, z / half) * p.height;
  const sculpt = sculptGrid(p);
  if (sculpt) h += sampleGrid(sculpt.values, sculpt.n, (x + half) / p.size, (z + half) / p.size) / 100;
  return applyPads(h, x, z, pads);
}

const _a = new THREE.Color();
const _b = new THREE.Color();

/** The land's own shape (no sculpting, no pads) at every point, and its colour grain — kept while its shape is the same. */
const _shapes = new Map();
function shapeGrid(p) {
  const key = `${p.shape}|${p.size}|${p.height}|${p.roughness}|${p.seed}|${p.detail}`;
  if (_shapes.has(key)) return _shapes.get(key);
  const N = p.detail;
  const row = N + 1;
  const half = p.size / 2;
  const cell = p.size / N;
  const base = new Float32Array(row * row);
  const jitter = new Float32Array(row * row);
  for (let j = 0; j < row; j++) {
    for (let i = 0; i < row; i++) {
      const x = -half + i * cell;
      const z = -half + j * cell;
      base[j * row + i] = shapeAt(p, x / half, z / half) * p.height;
      jitter[j * row + i] = fbm(x * 0.15, z * 0.15, { seed: p.seed + 77, octaves: 2 }) * 0.08;
    }
  }
  const out = { base, jitter };
  _shapes.set(key, out);
  if (_shapes.size > 4) _shapes.delete(_shapes.keys().next().value);
  return out;
}

/** The land's own height (no sculpting, no pads) at (x, z) in its own space. */
export function baseHeightAt(raw, x, z) {
  const p = normalized(raw);
  const half = p.size / 2;
  return shapeAt(p, x / half, z / half) * p.height;
}

/**
 * Every point's height and colour over the whole land: (N + 1)² of each, row
 * by row from −Z, west to east. `live` (while a brush is being dragged) is the
 * sculpting and painting as they are now, before they are saved.
 */
export function terrainGrid(raw, { pads = [], live = null } = {}) {
  const p = normalizeTerrain(raw);
  const N = p.detail;
  const row = N + 1;
  const half = p.size / 2;
  const cell = p.size / N;
  const heights = new Float32Array(row * row);
  const sculpt = live?.sculpt ?? sculptGrid(p);
  const { base, jitter: grain } = shapeGrid(p);
  for (let j = 0; j < row; j++) {
    for (let i = 0; i < row; i++) {
      const k = j * row + i;
      let h = base[k];
      if (sculpt) h += (sculpt.n === row ? sculpt.values[k] : sampleGrid(sculpt.values, sculpt.n, i / N, j / N)) / 100;
      heights[k] = pads.length ? applyPads(h, -half + i * cell, -half + j * cell, pads) : h;
    }
  }
  // normals from the neighbours on the whole grid: chunks meet without a seam in their shading
  const normals = new Float32Array(row * row * 3);
  const at = (i, j) => heights[Math.min(N, Math.max(0, j)) * row + Math.min(N, Math.max(0, i))];
  for (let j = 0; j < row; j++) {
    for (let i = 0; i < row; i++) {
      const dx = (at(i + 1, j) - at(i - 1, j)) / ((Math.min(N, i + 1) - Math.max(0, i - 1)) * cell);
      const dz = (at(i, j + 1) - at(i, j - 1)) / ((Math.min(N, j + 1) - Math.max(0, j - 1)) * cell);
      const len = Math.hypot(dx, 1, dz);
      normals.set([-dx / len, 1 / len, -dz / len], (j * row + i) * 3);
    }
  }
  // colours: sand by the water, grass, rock where it is steep, snow up high — then what was painted
  const colors = new Float32Array(row * row * 3);
  const grass = new THREE.Color(p.grass);
  const rock = new THREE.Color(p.rock);
  const snow = new THREE.Color(p.snow);
  const sand = new THREE.Color(p.sand);
  const paints = paintColours(p);
  const painted = live?.paint ?? paintGrid(p);
  const waterY = p.water * p.height;
  const steepFrom = 0.95 - p.rockSlope * 0.35; // normal.y below this starts to be rock
  for (let k = 0; k < row * row; k++) {
    const i = k % row;
    const j = (k - i) / row;
    const x = -half + i * cell;
    const z = -half + j * cell;
    const y = heights[k];
    const t = p.height > 0 ? y / p.height : 0;
    const up = normals[k * 3 + 1];
    const jitter = grain[k];
    _a.copy(grass).offsetHSL(0, 0, jitter * 0.5);
    if (p.water > 0) {
      _a.lerp(sand, 1 - smoothstep(waterY + 0.2, waterY + 0.9 + p.height * 0.02, y));
      _a.lerp(_b.copy(sand).multiplyScalar(0.45), smoothstep(waterY, waterY - 2 - p.height * 0.05, y)); // darker as it gets deeper
    }
    _a.lerp(rock, smoothstep(steepFrom, steepFrom - 0.18, up));
    if (p.snowLine < 1) _a.lerp(_b.copy(snow), smoothstep(p.snowLine - 0.04, p.snowLine + 0.04, t + jitter) * smoothstep(0.45, 0.7, up));
    if (painted) {
      // the nearest painted point: its paint, as strongly as it was laid on
      const pi = Math.round((i / N) * (painted.n - 1));
      const pj = Math.round((j / N) * (painted.n - 1));
      const g = pj * painted.n + pi;
      const layer = painted.layer[g];
      const w = painted.weight[g] / 255;
      if (layer && w > 0 && paints[layer]) {
        _b.copy(paints[layer]);
        if (PAINTS[layer - 1] === 'flowers') _b.lerp(grass, 0.55 - jitter * 4); // flowers in grass, here and there
        else _b.offsetHSL(0, 0, jitter * 0.6);
        _a.lerp(_b, w);
      }
    }
    colors.set([_a.r, _a.g, _a.b], k * 3);
  }
  return { p, N, row, half, cell, heights, normals, colors };
}

/** One chunk's surface — every `step`th point of its part of the grid — with a skirt down its edges if asked. */
function chunkGeometry(grid, i0, j0, cells, step, skirt = 0) {
  const { row, half, cell, heights, normals, colors, p } = grid;
  const n = cells / step + 1;
  const pos = [];
  const nrm = [];
  const col = [];
  const uv = [];
  const tile = p.groundScale;
  const push = (gi, gj, drop = 0) => {
    const k = gj * row + gi;
    const x = -half + gi * cell;
    const z = -half + gj * cell;
    pos.push(x, heights[k] - drop, z);
    nrm.push(normals[k * 3], normals[k * 3 + 1], normals[k * 3 + 2]);
    col.push(colors[k * 3], colors[k * 3 + 1], colors[k * 3 + 2]);
    uv.push(x / tile, -z / tile);
  };
  for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) push(i0 + a * step, j0 + b * step);
  const index = [];
  for (let b = 0; b < n - 1; b++) {
    for (let a = 0; a < n - 1; a++) {
      const v = b * n + a;
      index.push(v, v + n, v + 1, v + 1, v + n, v + n + 1);
    }
  }
  if (skirt > 0) {
    // a strip hanging down each edge: where a simpler chunk meets a finer one, no gap shows
    const edges = [
      Array.from({ length: n }, (_, a) => [a, 0]),
      Array.from({ length: n }, (_, b) => [n - 1, b]),
      Array.from({ length: n }, (_, a) => [n - 1 - a, n - 1]),
      Array.from({ length: n }, (_, b) => [0, n - 1 - b]),
    ];
    for (const edge of edges) {
      for (let e = 0; e < edge.length - 1; e++) {
        const [a0, b0] = edge[e];
        const [a1, b1] = edge[e + 1];
        const top0 = b0 * n + a0;
        const top1 = b1 * n + a1;
        const base = pos.length / 3;
        push(i0 + a0 * step, j0 + b0 * step, skirt);
        push(i0 + a1 * step, j0 + b1 * step, skirt);
        // both ways round: seen from either side of the seam
        index.push(top0, base, top1, top1, base, base + 1, top0, top1, base, top1, base + 1, base);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** How a terrain is cut: chunks along a side, cells along each chunk's side. */
export function chunkLayout(detail) {
  const tiles = Math.max(1, Math.ceil(detail / CHUNK_CELLS));
  return { tiles, cells: detail / tiles };
}

/** Its edges closed down to below its lowest point, rock-coloured: a block of land, not a sheet. */
function sides(grid) {
  const { row, N, half, cell, heights, p } = grid;
  let lowest = Infinity;
  for (const h of heights) lowest = Math.min(lowest, h);
  const bottom = Math.min(0, lowest) - Math.max(1, p.height * 0.1);
  const point = (i, j) => [-half + i * cell, heights[j * row + i], -half + j * cell];
  const edges = [
    Array.from({ length: row }, (_, i) => [i, 0]), // the far edge (−Z), left to right
    Array.from({ length: row }, (_, j) => [N, j]), // the right edge (+X), far to near
    Array.from({ length: row }, (_, i) => [N - i, N]), // the near edge (+Z), right to left
    Array.from({ length: row }, (_, j) => [0, N - j]), // the left edge (−X), near to far
  ];
  const v = [];
  for (const edge of edges) {
    for (let k = 0; k < edge.length - 1; k++) {
      const [ax, ay, az] = point(...edge[k]);
      const [bx, by, bz] = point(...edge[k + 1]);
      // facing out: a, its bottom, b — then b, its bottom… (wound outward)
      v.push(ax, ay, az, bx, by, bz, ax, bottom, az, bx, by, bz, bx, bottom, bz, ax, bottom, az);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(p.rock).multiplyScalar(0.7), roughness: 1, side: THREE.DoubleSide }));
  mesh.name = 'Sides';
  mesh.receiveShadow = true;
  return { mesh, bottom };
}

/** The ground's texture: a fine grain, nearly white, that the land's colours are multiplied by (shared). */
let _groundMaps = null;
function groundMaps() {
  if (_groundMaps) return _groundMaps;
  try {
    const spec = { pattern: 'noise', colorA: '#ffffff', colorB: '#bdb8ae', scale: 7, variation: 0.25, bump: 0.7, size: 256, seed: 11 };
    const map = makeProceduralTexture(spec, 'color');
    map.colorSpace = THREE.SRGBColorSpace;
    const normalMap = makeProceduralTexture(spec, 'normal');
    for (const t of [map, normalMap]) t.userData.sharedGround = true;
    _groundMaps = { map, normalMap };
  } catch {
    _groundMaps = null;
  }
  return _groundMaps;
}

/**
 * The land as an object: its ground in chunks (each with simpler versions for
 * far away: see terrain-lod.js), its sides and, if any, its water.
 */
export function buildTerrain(raw, { pads = [], root = null } = {}) {
  const grid = terrainGrid(raw, { pads, live: root?.userData.liveGrids ?? null });
  const { p, N } = grid;
  const { tiles, cells } = chunkLayout(N);
  const maps = p.ground === 'textured' ? groundMaps() : null;
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0,
    ...(maps ? { map: maps.map, normalMap: maps.normalMap, normalScale: new THREE.Vector2(0.6, 0.6) } : {}),
  });
  const skirt = Math.max(0.5, p.height * 0.04);
  const parts = [];
  for (let cj = 0; cj < tiles; cj++) {
    for (let ci = 0; ci < tiles; ci++) {
      const i0 = ci * cells;
      const j0 = cj * cells;
      const ground = new THREE.Mesh(chunkGeometry(grid, i0, j0, cells, 1), material);
      ground.name = 'Ground';
      ground.castShadow = ground.receiveShadow = true;
      // far away, simpler: every 2nd point, every 4th (and a skirt where it meets a finer one) — drawing only
      const lods = [];
      for (const step of [2, 4]) if (cells / step >= 8) lods.push({ step, geometry: chunkGeometry(grid, i0, j0, cells, step, skirt) });
      ground.userData.terrainChunk = { tiles, size: p.size / tiles, lods };
      parts.push(ground);
    }
  }
  const { mesh: side, bottom } = sides(grid);
  parts.push(side);
  if (p.water > 0) {
    // a body of water, from the bottom of the land up to its level: its sides close the edge,
    // and as a trigger zone you are in it, not on a sheet
    const waterY = p.water * p.height;
    const deep = Math.max(0.05, waterY - bottom);
    const water = new THREE.Mesh(
      new THREE.BoxGeometry(p.size, deep, p.size),
      new THREE.MeshStandardMaterial({ color: p.waterColor, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.75 }),
    );
    water.name = 'Water';
    water.position.y = waterY - deep / 2;
    water.receiveShadow = true;
    parts.push(water);
  }
  return parts;
}
