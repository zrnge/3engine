import * as THREE from 'three';
import { measureLocal } from './physics.js';
import { generatorOf, regenerate } from './generators/generated.js';
import { terrainHeightAt } from './generators/terrain.js';

/**
 * Ground pads — the ground stays out of a house. An object that flattens the
 * ground (entity.flattenGround: a building does, and any object can — a house
 * model, a camp, a road) levels every terrain under it: inside its footprint
 * the ground is at its base, a little below its floor, and round it the land
 * eases back to its own shape (terrain.js applyPads).
 *
 * Worked out from where things are, never saved: whenever a terrain or
 * something on it moves, turns, is resized or changes, the terrain is made
 * again — at most a few times a second while it is being dragged in the
 * editor, once at load in a game.
 */

export const PAD_MARGIN = 0.4; // m of level ground beyond its walls
export const PAD_BLEND = 2.5;  // m over which the land comes back to its own height — at least
// ...and longer where it has further to go (a house on a hillside): a bank no steeper on average than
// 1 in this, so you can walk up (or down) it to the door — it was a fixed 2.5 m, a wall of earth on a slope
const BANK = 2.5;
const BLEND_MAX = 40;
const SINK = 0.03;             // m the ground sits below its base: a floor never fights with it
const EVERY = 0.15;            // s between remakes while something is being dragged

const _box = new THREE.Box3();
const _inv = new THREE.Matrix4();
const _corner = new THREE.Vector3();

const isTerrain = (e) => generatorOf(e.object3D)?.type === 'terrain';
const flattens = (e) => e.flattenGround && e.alive !== false && e.object3D?.parent && e.object3D.visible !== false;

/**
 * The pads `flatteners` make on `terrain`, in its own space: their footprints
 * (their bounds' bottom, turned as they are), their base the ground's level.
 */
export function padsFor(terrain, flatteners) {
  const t = terrain.object3D;
  t.updateWorldMatrix(true, false);
  _inv.copy(t.matrixWorld).invert();
  const params = generatorOf(t)?.params;
  const half = (params?.size ?? 0) / 2;
  const pads = [];
  for (const e of flatteners) {
    if (e === terrain) continue;
    const o = e.object3D;
    o.updateWorldMatrix(true, true);
    measureLocal(o, _box);
    if (_box.isEmpty()) continue;
    const { min, max } = _box;
    const c = [[min.x, min.z], [max.x, min.z], [max.x, max.z], [min.x, max.z]]
      .map(([x, z]) => _corner.set(x, min.y, z).applyMatrix4(o.matrixWorld).applyMatrix4(_inv).clone());
    const u = c[1].clone().sub(c[0]);
    const v = c[3].clone().sub(c[0]);
    const mid = c[0].clone().add(c[2]).multiplyScalar(0.5);
    const len = Math.hypot(u.x, u.z) || 1;
    const pad = {
      x: mid.x, z: mid.z,
      hx: Math.hypot(u.x, u.z) / 2 + PAD_MARGIN,
      hz: Math.hypot(v.x, v.z) / 2 + PAD_MARGIN,
      cos: u.x / len, sin: u.z / len,
      level: Math.min(...c.map((p) => p.y)) - SINK,
      blend: PAD_BLEND,
    };
    // how far the land round it is from its level: the bank is made long enough to walk
    pad.blend = THREE.MathUtils.clamp(BANK * rise(params, pad), PAD_BLEND, BLEND_MAX);
    // off the land altogether: nothing to level
    const reach = Math.hypot(pad.hx, pad.hz) + pad.blend;
    if (Math.abs(pad.x) > half + reach || Math.abs(pad.z) > half + reach) continue;
    pads.push(pad);
  }
  return pads;
}

/** The most the land differs from a pad's level, just round it (its edge, and a little beyond). */
function rise(params, pad) {
  if (!params) return 0;
  let most = 0;
  for (const out of [0, PAD_BLEND, PAD_BLEND * 3]) {
    const hx = pad.hx + out;
    const hz = pad.hz + out;
    for (let k = 0; k < 24; k++) {
      // round its edge: a point on the rectangle, turned as the pad is
      const a = (k / 24) * Math.PI * 2;
      const lx = Math.max(-hx, Math.min(hx, Math.cos(a) * hx * 1.5));
      const lz = Math.max(-hz, Math.min(hz, Math.sin(a) * hz * 1.5));
      const x = pad.x + lx * pad.cos - lz * pad.sin;
      const z = pad.z + lx * pad.sin + lz * pad.cos;
      most = Math.max(most, Math.abs(terrainHeightAt(params, x, z) - pad.level) / (1 + out / PAD_BLEND));
    }
  }
  return most;
}

export class GroundPads {
  constructor(engine) {
    this.engine = engine;
    this._signatures = new WeakMap(); // terrain -> what its pads were worked out from
    this._since = Infinity;
  }

  /** Each frame: a terrain whose ground-flattening things changed is made again (not too often while dragging). */
  update(dt = 0) {
    const entities = this.engine.entities || [];
    const terrains = entities.filter(isTerrain);
    if (!terrains.length) return;
    this._since += dt;
    const flatteners = entities.filter(flattens);
    const parts = flatteners.map((e) => {
      const o = e.object3D;
      o.updateWorldMatrix(true, false);
      return `${o.matrixWorld.elements.map((v) => v.toFixed(3)).join(',')}|${JSON.stringify(generatorOf(o)?.params ?? null)}|${o.children.length}`;
    }).join(';');
    for (const terrain of terrains) {
      const t = terrain.object3D;
      t.updateWorldMatrix(true, false);
      const sig = `${t.matrixWorld.elements.map((v) => v.toFixed(3)).join(',')}|${JSON.stringify(generatorOf(t).params)}#${parts}`;
      if (this._signatures.get(terrain) === sig) continue;
      // while editing, not every frame of a drag; in a game, at once
      if (!this.engine.playing && this._since < EVERY) continue;
      this._signatures.set(terrain, sig);
      this.apply(terrain, flatteners);
    }
    if (this._since >= EVERY) this._since = 0;
  }

  /** Level `terrain` under `flatteners` now, and measure its body again. */
  apply(terrain, flatteners = (this.engine.entities || []).filter(flattens)) {
    const t = terrain.object3D;
    const pads = padsFor(terrain, flatteners);
    const before = JSON.stringify(t.userData.pads || []);
    if (JSON.stringify(pads) === before) return false;
    t.userData.pads = pads;
    regenerate(t, generatorOf(t).params);
    if (terrain.rigidBody && this.engine.physics) {
      this.engine.physics.unregister(terrain);
      this.engine.physics.register(terrain);
    }
    return true;
  }
}
