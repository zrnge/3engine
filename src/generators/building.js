import * as THREE from 'three';
import { createMaterial } from '../materials.js';

/**
 * Building — a house (or a hut, a shop, a tower) made from a few numbers:
 * its size and storeys, a door on one side, windows on every side, one or two
 * rooms, stairs between floors, and a gable, hip or flat roof.
 *
 * It is made of real walls with real openings — you walk in at the door and
 * look out of the windows (glass in them, unless left out) — so it collides
 * as it looks (its physics: a mesh) and walkers find their way round inside.
 * Its parts are named (Wall front, Floor 2, Stairs 1, Windows, Roof…), so a
 * part can be given a role of its own in Physics, like any model's.
 *
 * The middle of its ground floor is at the object's origin; its front (the
 * door, by default) faces +Z.
 */

export const ROOF_TYPES = ['gable', 'hip', 'flat', 'none'];
export const ROOF_LABELS = { gable: 'Gable (two slopes)', hip: 'Hip (four slopes)', flat: 'Flat', none: 'None (open top)' };
export const WALL_STYLES = ['plaster', 'bricks', 'wood', 'stone'];
export const SIDES = ['front', 'back', 'left', 'right'];
export const ROOM_LAYOUTS = ['one room', 'two rooms'];

export const BUILDING_DEFAULTS = Object.freeze({
  width: 8, depth: 6, storeys: 1, storeyHeight: 3, wall: 0.2,
  rooms: 'two rooms',
  door: 'front', doorOffset: 0, doorWidth: 1.3, doorHeight: 2.2, // the editor's stand-in player is 1 m across: room for it
  windows: 2, windowWidth: 1, windowHeight: 1.1, sill: 0.9, glass: true,
  roof: 'gable', pitch: 35, overhang: 0.4,
  stairs: true,
  wallStyle: 'plaster', wallColor: '#d9cbb3', roofColor: '#8a3b2e', floorColor: '#8b6a45', trimColor: '#f2efe8',
});

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
const STEP_RISE = 0.28; // m: well under what the player steps up (0.45)
const STAIR_WIDTH = 1;

/** How long a flight of stairs is for a storey this high. */
const stairLength = (storeyHeight) => Math.ceil(storeyHeight / STEP_RISE) * STEP_RISE;

export function normalizeBuilding(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const D = BUILDING_DEFAULTS;
  const color = (k) => (HEX.test(r[k] ?? '') ? r[k].toLowerCase() : D[k]);
  const out = {
    width: num(r.width, 2, 200, D.width),
    depth: num(r.depth, 2, 200, D.depth),
    storeys: Math.round(num(r.storeys, 1, 10, D.storeys)),
    storeyHeight: num(r.storeyHeight, 2.2, 8, D.storeyHeight),
    wall: num(r.wall, 0.05, 1, D.wall),
    rooms: ROOM_LAYOUTS.includes(r.rooms) ? r.rooms : D.rooms,
    door: SIDES.includes(r.door) || r.door === 'none' ? r.door : D.door,
    doorOffset: num(r.doorOffset, -1, 1, D.doorOffset),
    doorWidth: num(r.doorWidth, 0.6, 6, D.doorWidth),
    doorHeight: num(r.doorHeight, 1.6, 6, D.doorHeight),
    windows: Math.round(num(r.windows, 0, 20, D.windows)),
    windowWidth: num(r.windowWidth, 0.2, 6, D.windowWidth),
    windowHeight: num(r.windowHeight, 0.2, 5, D.windowHeight),
    sill: num(r.sill, 0, 4, D.sill),
    glass: r.glass === undefined ? D.glass : !!r.glass,
    roof: ROOF_TYPES.includes(r.roof) ? r.roof : D.roof,
    pitch: num(r.pitch, 5, 70, D.pitch),
    overhang: num(r.overhang, 0, 3, D.overhang),
    stairs: r.stairs === undefined ? D.stairs : !!r.stairs,
    wallStyle: WALL_STYLES.includes(r.wallStyle) ? r.wallStyle : D.wallStyle,
    wallColor: color('wallColor'), roofColor: color('roofColor'), floorColor: color('floorColor'), trimColor: color('trimColor'),
  };
  // a door no taller than its storey, windows that fit between the floor and the ceiling
  out.doorHeight = Math.min(out.doorHeight, out.storeyHeight - 0.2);
  out.windowHeight = Math.min(out.windowHeight, out.storeyHeight - 0.4);
  out.sill = Math.min(out.sill, out.storeyHeight - out.windowHeight - 0.2);
  // stairs up: wide enough for a flight on the back wall (two, alternating, from three storeys)
  if (out.stairs && out.storeys > 1) {
    const flights = out.storeys > 2 ? 2 : 1;
    out.width = Math.max(out.width, flights * stairLength(out.storeyHeight) + 2 * out.wall + 0.6);
    out.depth = Math.max(out.depth, 2 * (STAIR_WIDTH + out.wall) + 1.2);
  }
  return out;
}

// ---------------------------------------------------------------- geometry

/**
 * A panel `w` × `h` with rectangular holes ({ x0, x1, y0, y1 }), as the
 * rectangles left: cut in columns at each hole's sides.
 */
export function panelPieces(w, h, holes = []) {
  const hs = holes
    .map((o) => ({ x0: Math.max(0, o.x0), x1: Math.min(w, o.x1), y0: Math.max(0, o.y0), y1: Math.min(h, o.y1) }))
    .filter((o) => o.x1 - o.x0 > 1e-6 && o.y1 - o.y0 > 1e-6);
  const xs = [...new Set([0, w, ...hs.flatMap((o) => [o.x0, o.x1])])].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const xa = xs[i];
    const xb = xs[i + 1];
    if (xb - xa < 1e-6) continue;
    const cuts = hs.filter((o) => o.x0 <= xa + 1e-9 && o.x1 >= xb - 1e-9).sort((a, b) => a.y0 - b.y0);
    let y = 0;
    for (const c of cuts) {
      if (c.y0 > y + 1e-6) out.push({ x0: xa, x1: xb, y0: y, y1: c.y0 });
      y = Math.max(y, c.y1);
    }
    if (h > y + 1e-6) out.push({ x0: xa, x1: xb, y0: y, y1: h });
  }
  return out;
}

/** A box `size` at `center`, its texture laid on in metres (`tile` m a repeat), whatever its size. */
function boxGeo([sx, sy, sz], [cx, cy, cz], tile = 2) {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  g.translate(cx, cy, cz);
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const [u, v] = ax > 0.5 ? [p.getZ(i), p.getY(i)] : ay > 0.5 ? [p.getX(i), p.getZ(i)] : [p.getX(i), p.getY(i)];
    uv.setXY(i, u / tile, v / tile);
  }
  return g;
}

/** Many geometries as one (positions, normals, texture places). */
function merge(list) {
  const geos = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const count = geos.reduce((s, g) => s + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2]]) {
    const arr = new Float32Array(count * size);
    let at = 0;
    for (const g of geos) {
      const a = g.attributes[name];
      if (a) arr.set(a.array, at);
      at += g.attributes.position.count * size;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------- materials

const shade = (hex, by) => `#${new THREE.Color(hex).offsetHSL(0, 0, by).getHexString()}`;
const made = (pattern, colorA, colorB, extra = {}) => ({
  color: '#ffffff', roughness: 0.9,
  maps: {
    map: { name: pattern, procedural: { pattern, seed: 7, size: 512, colorA, colorB, ...extra } },
    normalMap: { name: `${pattern} bumps`, procedural: { pattern, seed: 7, size: 512, colorA, colorB, ...extra }, output: 'normal' },
  },
});

function materials(p) {
  const wall = {
    plaster: made('noise', p.wallColor, shade(p.wallColor, -0.06), { scale: 10, bump: 0.15 }),
    bricks: made('bricks', p.wallColor, shade(p.wallColor, -0.25), { scale: 6, variation: 0.2 }),
    wood: made('planks', p.wallColor, shade(p.wallColor, -0.3), { scale: 5, variation: 0.3 }),
    stone: made('tiles', p.wallColor, shade(p.wallColor, -0.3), { scale: 4, variation: 0.35 }),
  }[p.wallStyle];
  return {
    wall: createMaterial(wall),
    floor: createMaterial(made('planks', p.floorColor, shade(p.floorColor, -0.2), { scale: 5, variation: 0.3 })),
    roof: createMaterial(made('tiles', p.roofColor, shade(p.roofColor, -0.2), { scale: 6, variation: 0.25 })),
    trim: createMaterial({ color: p.trimColor, roughness: 0.6 }),
    glass: createMaterial({ color: '#a8c8e0', roughness: 0.05, metalness: 0.1, opacity: 0.3 }),
  };
}

// ---------------------------------------------------------------- the building

/** The building's parts, each a named mesh: walls, floors, stairs, windows, roof. */
export function buildBuilding(raw) {
  const p = normalizeBuilding(raw);
  const { width: W, depth: D, storeys, storeyHeight: H, wall: t } = p;
  const top = storeys * H; // where the walls end
  const FLOOR = 0.1; // each floor's top is this far above its storey's base
  const mats = materials(p);
  const parts = [];
  const add = (name, geos, mat) => {
    if (!geos.length) return;
    const mesh = new THREE.Mesh(merge(geos), mat);
    mesh.name = name;
    mesh.castShadow = mesh.receiveShadow = true;
    parts.push(mesh);
  };

  // each outer wall: its length, where along it the door is, and how to place a piece of it
  const walls = {
    front: { length: W, place: (s0, s1, y0, y1) => [[s1 - s0, y1 - y0, t], [-W / 2 + (s0 + s1) / 2, (y0 + y1) / 2, D / 2 - t / 2]] },
    back: { length: W, place: (s0, s1, y0, y1) => [[s1 - s0, y1 - y0, t], [-W / 2 + (s0 + s1) / 2, (y0 + y1) / 2, -D / 2 + t / 2]] },
    left: { length: D - 2 * t, place: (s0, s1, y0, y1) => [[t, y1 - y0, s1 - s0], [-W / 2 + t / 2, (y0 + y1) / 2, -D / 2 + t + (s0 + s1) / 2]] },
    right: { length: D - 2 * t, place: (s0, s1, y0, y1) => [[t, y1 - y0, s1 - s0], [W / 2 - t / 2, (y0 + y1) / 2, -D / 2 + t + (s0 + s1) / 2]] },
  };
  const glass = [];
  const trim = [];
  for (const [side, w] of Object.entries(walls)) {
    const L = w.length;
    const holes = [];
    // the door: on the ground floor, where along the wall its offset says
    let doorAt = null;
    if (p.door === side && L > p.doorWidth + 0.4) {
      const room = L / 2 - p.doorWidth / 2 - 0.3;
      doorAt = L / 2 + p.doorOffset * Math.max(0, room);
      holes.push({ x0: doorAt - p.doorWidth / 2, x1: doorAt + p.doorWidth / 2, y0: 0, y1: FLOOR + p.doorHeight });
    }
    // windows, evenly along each storey — none in the door's way
    const fit = p.windows > 0 && p.windowWidth * p.windows + 0.3 * (p.windows + 1) <= L;
    for (let k = 0; fit && k < storeys; k++) {
      for (let i = 0; i < p.windows; i++) {
        const s = (L * (i + 1)) / (p.windows + 1);
        if (k === 0 && doorAt !== null && Math.abs(s - doorAt) < p.doorWidth / 2 + p.windowWidth / 2 + 0.2) continue;
        const y0 = k * H + FLOOR + p.sill;
        const hole = { x0: s - p.windowWidth / 2, x1: s + p.windowWidth / 2, y0, y1: y0 + p.windowHeight };
        holes.push(hole);
        if (p.glass) {
          const [size, at] = w.place(hole.x0, hole.x1, hole.y0, hole.y1);
          const thin = size.map((v) => (Math.abs(v - t) < 1e-9 ? 0.04 : v));
          glass.push(boxGeo(thin, at));
        }
        // a sill under it
        const [ss, sa] = w.place(hole.x0 - 0.05, hole.x1 + 0.05, y0 - 0.06, y0);
        trim.push(boxGeo(ss.map((v) => (Math.abs(v - t) < 1e-9 ? t + 0.12 : v)), sa, 1));
      }
    }
    add(`Wall ${side}`, panelPieces(L, top, holes).map((r) => boxGeo(...w.place(r.x0, r.x1, r.y0, r.y1))), mats.wall);
  }

  // floors: the ground floor, and one for each storey above with a hole over the stairs below it
  const inner = { w: W - 2 * t, d: D - 2 * t };
  const flight = stairLength(H);
  const stairFoot = (k) => { // where the flight from storey k up to k + 1 stands (x0, x1 along the width; on the back wall)
    const fromLeft = k % 2 === 0;
    const x0 = fromLeft ? 0 : inner.w - flight;
    return { x0, x1: x0 + flight, z0: 0, z1: STAIR_WIDTH, fromLeft };
  };
  const hasStairs = p.stairs && storeys > 1;
  for (let k = 0; k < storeys; k++) {
    const holes = hasStairs && k > 0 ? [(({ x0, x1, z0, z1 }) => ({ x0, x1, y0: z0, y1: z1 }))(stairFoot(k - 1))] : [];
    const y = k === 0 ? FLOOR / 2 : k * H;
    const thick = k === 0 ? FLOOR : 2 * FLOOR;
    add(k === 0 ? 'Floor' : `Floor ${k + 1}`, panelPieces(inner.w, inner.d, holes)
      .map((r) => boxGeo([r.x1 - r.x0, thick, r.y1 - r.y0], [-W / 2 + t + (r.x0 + r.x1) / 2, y, -D / 2 + t + (r.y0 + r.y1) / 2])), mats.floor);
  }
  // stairs: solid steps, each a riser higher, from one floor to the next
  for (let k = 0; hasStairs && k < storeys - 1; k++) {
    const f = stairFoot(k);
    const n = Math.round(flight / STEP_RISE);
    const base = k * H + FLOOR;
    const rise = H / n;
    const steps = [];
    for (let i = 0; i < n; i++) {
      const s0 = f.fromLeft ? f.x0 + i * STEP_RISE : f.x1 - (i + 1) * STEP_RISE;
      const h = (i + 1) * rise;
      steps.push(boxGeo([STEP_RISE, h, STAIR_WIDTH], [-W / 2 + t + s0 + STEP_RISE / 2, base + h / 2, -D / 2 + t + STAIR_WIDTH / 2], 1));
    }
    add(`Stairs ${k + 1}`, steps, mats.floor);
  }

  // inside: a wall across the middle with a doorway on each storey (front room, back room)
  if (p.rooms === 'two rooms' && inner.d > 2.5) {
    const holes = [];
    for (let k = 0; k < storeys; k++) holes.push({ x0: inner.w / 2 - 0.5, x1: inner.w / 2 + 0.5, y0: k * H, y1: k * H + FLOOR + 2.1 });
    const it = Math.max(0.1, t * 0.6);
    add('Inner wall', panelPieces(inner.w, top, holes)
      .map((r) => boxGeo([r.x1 - r.x0, r.y1 - r.y0, it], [-W / 2 + t + (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, 0])), mats.wall);
  }
  add('Windows', glass, mats.glass);
  add('Sills', trim, mats.trim);

  // the roof
  const o = p.overhang;
  const slope = Math.tan(THREE.MathUtils.degToRad(p.pitch));
  if (p.roof === 'gable') {
    // two slopes meeting along the width; the ends filled in, wall-coloured
    const run = D / 2 + o;
    const len = run / Math.cos(THREE.MathUtils.degToRad(p.pitch));
    const rise = (D / 2) * slope;
    const thick = 0.15;
    const slab = (sign) => {
      const g = boxGeo([W + 2 * o, thick, len], [0, 0, 0], 2);
      g.rotateX(sign * THREE.MathUtils.degToRad(p.pitch));
      // its middle: halfway between the eave and the ridge, lifted onto the wall
      const lift = thick / 2 / Math.cos(THREE.MathUtils.degToRad(p.pitch));
      g.translate(0, top + rise - (run / 2) * slope + lift, sign * run / 2);
      return g;
    };
    add('Roof', [slab(1), slab(-1)], mats.roof);
    const shape = new THREE.Shape([new THREE.Vector2(-D / 2, 0), new THREE.Vector2(D / 2, 0), new THREE.Vector2(0, rise)]);
    const ends = [-1, 1].map((sign) => {
      const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
      g.rotateY(Math.PI / 2); // its triangle across the depth, its thickness along the width
      g.translate(sign * (W / 2) - (sign > 0 ? t : 0), top, 0);
      return g;
    });
    add('Gables', ends, mats.wall);
  } else if (p.roof === 'hip') {
    const rise = (Math.min(W, D) / 2 + o) * slope;
    const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).toNonIndexed();
    g.rotateY(Math.PI / 4); // a square base along the walls
    g.scale(W + 2 * o, rise, D + 2 * o);
    g.translate(0, top + rise / 2, 0);
    add('Roof', [g], mats.roof);
  } else if (p.roof === 'flat') {
    add('Roof', [boxGeo([W + 2 * o, 0.25, D + 2 * o], [0, top + 0.125, 0])], mats.roof);
  }
  return parts;
}
