// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { encodeBytes, decodeBytes, encodeInt16, decodeInt16, sampleGrid } from '../src/grid-codec.js';
import { buildTerrain, terrainHeightAt, chunkLayout, normalizeTerrain, PAINTS } from '../src/generators/terrain.js';
import { makeGenerated, regenerate, generatorOf } from '../src/generators/generated.js';
import { scatterPoints, normalizeScatter, groundAt, scatterWorld, ScatterSystem } from '../src/generators/scatter.js';
import { applyWorldDetail } from '../src/world-detail.js';
import { applyBrush } from '../src/editor/terrain-brush.js';
import { objectTriangles } from '../src/mesh-collider.js';
import { Entity } from '../src/entity.js';

// The world: grids saved small, terrain in chunks (simpler far away), sculpting and
// painting, and scattering — forests, rocks, grass — on the ground under them.

describe('grids saved as text', () => {
  it('bytes and signed numbers come back as they were; untouched grids are tiny', () => {
    const bytes = new Uint8Array(513 * 513);
    expect(encodeBytes(bytes).length).toBeLessThan(12);
    bytes.fill(200, 1000, 1500);
    bytes[70000] = 3;
    const text = encodeBytes(bytes);
    expect(text.length).toBeLessThan(40);
    expect(decodeBytes(text, bytes.length)).toEqual(bytes);
    const heights = new Int16Array(65 * 65);
    heights[10] = -1234; heights[11] = 32000; heights[4000] = -32768;
    expect(decodeInt16(encodeInt16(heights), heights.length)).toEqual(heights);
    expect(decodeBytes('not base64 !!', 10)).toEqual(new Uint8Array(10)); // broken: nothing, not a crash
  });

  it('a grid read between its points, at any resolution', () => {
    const g = [0, 10, 20, 30]; // 2 × 2
    expect(sampleGrid(g, 2, 0, 0)).toBe(0);
    expect(sampleGrid(g, 2, 1, 1)).toBe(30);
    expect(sampleGrid(g, 2, 0.5, 0.5)).toBe(15);
  });
});

describe('terrain in chunks', () => {
  it('more than 128 cells: chunks, each with simpler versions; the ground meets itself at their edges', () => {
    expect(chunkLayout(128)).toEqual({ tiles: 1, cells: 128 });
    expect(chunkLayout(512)).toEqual({ tiles: 4, cells: 128 });
    expect(chunkLayout(768)).toEqual({ tiles: 6, cells: 128 });
    const parts = buildTerrain({ shape: 'hills', size: 200, detail: 256 });
    const grounds = parts.filter((m) => m.name === 'Ground');
    expect(grounds.length).toBe(4);
    for (const g of grounds) expect(g.userData.terrainChunk.lods.map((l) => l.step)).toEqual([2, 4]);
    // the shared edge of two chunks: the same heights
    const [a, b] = grounds; // (0,0) and (1,0): a's east edge is b's west edge
    const edge = (mesh, x) => {
      const pos = mesh.geometry.attributes.position;
      const out = [];
      for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i) - x) < 1e-6) out.push([+pos.getZ(i).toFixed(3), +pos.getY(i).toFixed(4)]);
      return out.sort((p, q) => p[0] - q[0]);
    };
    expect(edge(a, 0)).toEqual(edge(b, 0));
    expect(edge(a, 0).length).toBe(129);
  });

  it('far chunks are drawn simpler — only while drawn', () => {
    const root = makeGenerated('terrain', { shape: 'hills', size: 400, detail: 512 });
    const scene = new THREE.Scene();
    scene.add(root);
    root.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(-190, 20, -190); // over one corner
    camera.updateMatrixWorld(true);
    const grounds = root.children.filter((c) => c.name === 'Ground');
    const full = grounds.map((g) => g.geometry);
    const restore = applyWorldDetail([{ object3D: root }], camera);
    const swapped = grounds.filter((g, i) => g.geometry !== full[i]);
    expect(grounds[0].geometry).toBe(full[0]); // the chunk under the camera: as it is
    expect(swapped.length).toBeGreaterThan(8); // the far ones: simpler
    expect(grounds[grounds.length - 1].geometry.attributes.position.count).toBeLessThan(full[0].attributes.position.count / 8);
    restore();
    expect(grounds.every((g, i) => g.geometry === full[i])).toBe(true);
  });
});

describe('sculpt and paint', () => {
  /** A stroke on a flat field, as the brush makes one. */
  function stroke(params = {}) {
    const p = normalizeTerrain({ shape: 'field', size: 40, height: 0, detail: 64, ...params });
    const n = p.detail + 1;
    const live = { sculpt: { n, values: new Int16Array(n * n) }, paint: { n, layer: new Uint8Array(n * n), weight: new Uint8Array(n * n) } };
    return { p, n, half: p.size / 2, cell: p.size / p.detail, base: new Float32Array(n * n), live, level: 0 };
  }
  const at = (s, x, z) => {
    const i = Math.round((x + s.half) / s.cell);
    const j = Math.round((z + s.half) / s.cell);
    return j * s.n + i;
  };

  it('raise lifts the ground under the brush, most in its middle; lower takes it down', () => {
    const s = stroke();
    for (let t = 0; t < 30; t++) applyBrush(s, { tool: 'raise', size: 5, strength: 1 }, 0, 0, 1 / 30);
    const mid = s.live.sculpt.values[at(s, 0, 0)] / 100;
    const edge = s.live.sculpt.values[at(s, 4, 0)] / 100;
    expect(mid).toBeGreaterThan(1.5);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(mid);
    expect(s.live.sculpt.values[at(s, 10, 0)]).toBe(0); // outside the brush
    for (let t = 0; t < 60; t++) applyBrush(s, { tool: 'lower', size: 5, strength: 1 }, 0, 0, 1 / 30);
    expect(s.live.sculpt.values[at(s, 0, 0)]).toBeLessThan(0);
  });

  it('flatten brings the ground to where the stroke began; smooth evens a spike', () => {
    const s = stroke();
    s.live.sculpt.values[at(s, 1, 1)] = 500; // a 5 m spike
    for (let t = 0; t < 60; t++) applyBrush(s, { tool: 'smooth', size: 3, strength: 1 }, 1, 1, 1 / 30);
    expect(s.live.sculpt.values[at(s, 1, 1)]).toBeLessThan(150);
    const f = stroke();
    f.live.sculpt.values.fill(300);
    f.level = 1; // began 1 m up
    for (let t = 0; t < 90; t++) applyBrush(f, { tool: 'flatten', size: 4, strength: 1 }, 0, 0, 1 / 30);
    expect(f.live.sculpt.values[at(f, 0, 0)] / 100).toBeCloseTo(1, 1);
  });

  it('paint lays a paint on, another fades it out first, erase takes it away', () => {
    const s = stroke();
    const q = at(s, 0, 0);
    for (let t = 0; t < 30; t++) applyBrush(s, { tool: 'paint', paint: 'dirt', size: 3, strength: 1 }, 0, 0, 1 / 30);
    expect(s.live.paint.layer[q]).toBe(PAINTS.indexOf('dirt') + 1);
    expect(s.live.paint.weight[q]).toBe(255);
    applyBrush(s, { tool: 'paint', paint: 'snow', size: 3, strength: 0.3 }, 0, 0, 1 / 30);
    expect(s.live.paint.layer[q]).toBe(PAINTS.indexOf('dirt') + 1); // still dirt, a little less
    expect(s.live.paint.weight[q]).toBeLessThan(255);
    for (let t = 0; t < 60; t++) applyBrush(s, { tool: 'paint', paint: 'erase', size: 3, strength: 1 }, 0, 0, 1 / 30);
    expect(s.live.paint.weight[q]).toBe(0);
  });

  it('saved, the terrain is made with them: its height and its colour', () => {
    const n = 65;
    const values = new Int16Array(n * n);
    values[32 * n + 32] = 250; // 2.5 m in the middle
    const layer = new Uint8Array(n * n);
    const weight = new Uint8Array(n * n);
    layer[32 * n + 32] = PAINTS.indexOf('snow') + 1;
    weight[32 * n + 32] = 255;
    const params = {
      shape: 'field', size: 40, height: 0, detail: 64, ground: 'plain', snow: '#ffffff', grass: '#00ff00',
      sculpt: { n, data: encodeInt16(values) }, paint: { n, layer: encodeBytes(layer), weight: encodeBytes(weight) },
    };
    expect(terrainHeightAt(params, 0, 0)).toBeCloseTo(2.5, 3);
    expect(terrainHeightAt(params, 10, 10)).toBeCloseTo(0, 3);
    const ground = buildTerrain(params).find((m) => m.name === 'Ground');
    const pos = ground.geometry.attributes.position;
    const col = ground.geometry.attributes.color;
    let mid = -1;
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i)) < 1e-6 && Math.abs(pos.getZ(i)) < 1e-6) mid = i;
    expect(pos.getY(mid)).toBeCloseTo(2.5, 3);
    expect(col.getX(mid)).toBeGreaterThan(0.9); // snow white, not grass green
  });
});

describe('scatter', () => {
  it('as many as asked, never closer than the spacing, the same each time for a seed', () => {
    const p = normalizeScatter({ count: 300, size: 60, spacing: 2, clumping: 0.5, seed: 4 });
    const pts = scatterPoints(p);
    expect(pts.length).toBe(300);
    let closest = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) closest = Math.min(closest, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
    }
    expect(closest).toBeGreaterThanOrEqual(2);
    expect(pts.every(([x, z]) => Math.abs(x) <= 30 && Math.abs(z) <= 30)).toBe(true);
    expect(scatterPoints(p)).toEqual(pts);
    expect(scatterPoints({ ...p, seed: 5 })).not.toEqual(pts);
  });

  /** A level: a terrain and a scatter over it. */
  function level(terrain, scatter) {
    const scene = new THREE.Scene();
    const land = new Entity(makeGenerated('terrain', terrain));
    scene.add(land.object3D);
    land.object3D.updateMatrixWorld(true);
    const entities = [land];
    scatterWorld.entities = entities;
    const trees = new Entity(makeGenerated('scatter', scatter));
    scene.add(trees.object3D);
    entities.push(trees);
    trees.object3D.updateMatrixWorld(true);
    regenerate(trees.object3D, generatorOf(trees.object3D).params); // placed now the land is there
    return { scene, land, trees, entities };
  }
  const instances = (root) => {
    const out = [];
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    for (const c of root.children) {
      if (!c.isInstancedMesh || c.userData.scatterPart > 0) continue;
      for (let i = 0; i < c.count; i++) { c.getMatrixAt(i, m); out.push(v.setFromMatrixPosition(m).clone()); }
    }
    return out;
  };

  it('each stands on the terrain under it', () => {
    const { land, trees } = level({ shape: 'hills', size: 100, height: 20, detail: 64 }, { kind: 'rocks', count: 50, size: 60, maxSlope: 90 });
    const all = instances(trees.object3D);
    expect(all.length).toBeGreaterThan(40);
    for (const v of all.slice(0, 20)) expect(v.y).toBeCloseTo(terrainHeightAt(generatorOf(land.object3D).params, v.x, v.z), 3);
  });

  it('not on slopes steeper than asked; not under the water', () => {
    const steep = level({ shape: 'mountain', size: 100, height: 70, detail: 64 }, { kind: 'pines', count: 200, size: 90, spacing: 1, maxSlope: 90 });
    const gentle = level({ shape: 'mountain', size: 100, height: 70, detail: 64 }, { kind: 'pines', count: 200, size: 90, spacing: 1, maxSlope: 15 });
    expect(instances(gentle.trees.object3D).length).toBeLessThan(instances(steep.trees.object3D).length * 0.8);
    const island = level({ shape: 'island', size: 100, height: 20, water: 0.3, detail: 64 }, { kind: 'grass', count: 400, size: 100, spacing: 0.5 });
    const p = generatorOf(island.land.object3D).params;
    for (const v of instances(island.trees.object3D)) expect(v.y).toBeGreaterThanOrEqual(p.water * p.height);
  });

  it('drawn in cells (copies); solid trees have a collider of boxes, grass none; copies are not in a collider', () => {
    const { trees } = level({ shape: 'field', size: 200, height: 2, detail: 64 }, { kind: 'trees', count: 200, size: 180, solid: true, far: 0 });
    const cells = trees.object3D.children.filter((c) => c.isInstancedMesh);
    expect(cells.length).toBeGreaterThan(4);
    const colliders = trees.object3D.children.find((c) => c.name === 'Colliders');
    expect(colliders.visible).toBe(false);
    expect(objectTriangles(trees.object3D).length / 9).toBe(200 * 12); // a box (12 triangles) each, nothing from the copies
    const grass = level({ shape: 'field', size: 60 }, { kind: 'grass', count: 500, size: 50, solid: true, far: 40 });
    expect(grass.trees.object3D.children.some((c) => c.name === 'Colliders')).toBe(false);
    expect(grass.trees.object3D.children.every((c) => !c.isInstancedMesh || c.userData.scatterCell.far === 40)).toBe(true);
  });

  it('far cells are not drawn (only while drawn)', () => {
    const { trees } = level({ shape: 'field', size: 400 }, { kind: 'grass', count: 2000, size: 380, spacing: 0.5, far: 50 });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 2, 0);
    camera.updateMatrixWorld(true);
    trees.object3D.updateMatrixWorld(true);
    const cells = trees.object3D.children.filter((c) => c.isInstancedMesh);
    const restore = applyWorldDetail([trees], camera);
    const hidden = cells.filter((c) => !c.visible).length;
    expect(hidden).toBeGreaterThan(cells.length / 2);
    expect(cells.some((c) => c.visible)).toBe(true);
    restore();
    expect(cells.every((c) => c.visible)).toBe(true);
  });

  it('kept off a painted path', () => {
    const n = 33;
    const layer = new Uint8Array(n * n);
    const weight = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 14; i <= 18; i++) { layer[j * n + i] = PAINTS.indexOf('path') + 1; weight[j * n + i] = 255; } // a path north–south down the middle
    const terrain = { shape: 'field', size: 64, height: 1, detail: 32, paint: { n, layer: encodeBytes(layer), weight: encodeBytes(weight) } };
    const on = level(terrain, { kind: 'rocks', count: 300, size: 60, spacing: 0.5, maxSlope: 90, notOn: 'nothing' });
    const off = level(terrain, { kind: 'rocks', count: 300, size: 60, spacing: 0.5, maxSlope: 90, notOn: 'paths' });
    const onPath = (v) => Math.abs(v.x) < 3.5;
    expect(instances(on.trees.object3D).filter(onPath).length).toBeGreaterThan(10);
    expect(instances(off.trees.object3D).filter(onPath).length).toBe(0);
  });

  it('the land changed under it: placed again', () => {
    const { land, trees, entities } = level({ shape: 'field', size: 100, height: 2, detail: 32 }, { kind: 'rocks', count: 30, size: 60, maxSlope: 90 });
    const engine = { entities, physics: null };
    const system = new ScatterSystem(engine, regenerate);
    system.update(0.016); // noted
    const before = instances(trees.object3D)[0].y;
    regenerate(land.object3D, { ...generatorOf(land.object3D).params, shape: 'hills', height: 30 });
    land.object3D.updateMatrixWorld(true);
    system.update(0.016);
    system.update(0.3); // settled
    const after = instances(trees.object3D)[0];
    expect(after.y).not.toBeCloseTo(before, 2);
    expect(after.y).toBeCloseTo(groundAt(entities, after.x, after.z).y, 3);
  });
});
