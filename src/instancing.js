import * as THREE from 'three';

/**
 * Instancing — many copies drawn as one.
 *
 * A level with 300 coins, a forest of one tree or a wall of crates drew each
 * copy on its own, and a phone chokes on a few hundred of those. While
 * playing, copies that look alike (the same shape, and the same material but
 * for its colour) are drawn together, each where it is, in its own colour.
 *
 * The objects themselves stay as they were. They're clicked, shot, collided
 * with, hidden, moved and destroyed as ever; only their drawing moves here.
 * Each copy's own mesh keeps its geometry (clicks and shots test it) but
 * draws nothing, and the batch follows it every frame. Held first-person
 * items, rigged (skinned) models, see-through materials, textures tiled by
 * size and objects with a Level of detail are left to draw themselves.
 */

const MIN_COPIES = 4;        // fewer than this: not worth a batch
const RESCAN_SECONDS = 1;    // look for new copies (spawned ones) this often
const NOTHING = new THREE.MeshBasicMaterial({ visible: false }); // a copy's own mesh, while batched
NOTHING.name = '__batched';
const DRAWABLE = new Set(['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial',
  'MeshBasicMaterial', 'MeshToonMaterial', 'MeshMatcapMaterial']);
const TEXTURES = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'lightMap'];
const _m = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _c = new THREE.Color();

/** Which shape: two boxes made with the same sizes are the same shape. */
function shapeKey(g) {
  if (g.parameters && g.type && !g.userData?.t3WorldUV) return `${g.type}:${JSON.stringify(g.parameters)}`;
  return g.uuid;
}

/** Which look, all but its colour — or null: not one to batch. */
function lookKey(m) {
  if (!m || Array.isArray(m) || !DRAWABLE.has(m.type) || m === NOTHING) return null;
  if (m.transparent || m.opacity < 1 || m.userData?.t3?.uv?.worldScale) return null;
  if (m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return null; // a custom shader
  const parts = [m.type, m.side, m.flatShading, m.wireframe, m.vertexColors, m.alphaTest];
  for (const k of TEXTURES) parts.push(m[k]?.uuid ?? '');
  for (const k of ['roughness', 'metalness', 'emissiveIntensity', 'shininess', 'aoMapIntensity', 'envMapIntensity']) parts.push(m[k]);
  if (m.emissive) parts.push(m.emissive.getHexString());
  if (m.specular) parts.push(m.specular.getHexString());
  if (m.normalScale) parts.push(m.normalScale.x, m.normalScale.y);
  return parts.join('|');
}

/** Drawn at all: it and everything above it shown, and still in the scene. */
function shown(o, scene) {
  for (let n = o; n; n = n.parent) {
    if (!n.visible) return false;
    if (n === scene) return true;
  }
  return false;
}

export class Instancer {
  constructor(engine) {
    this.engine = engine;
    this.batches = new Map(); // key -> { mesh (InstancedMesh), members: [{ mesh, material }] }
    this._batched = new Map(); // a copy's mesh -> its own material (given back when it leaves)
    this._clock = 0;
    this._count = -1;
  }

  /** How many draws the batches save, for the curious (and the tests). */
  get saved() {
    let n = 0;
    for (const b of this.batches.values()) n += b.members.length - 1;
    return n;
  }

  /** Every frame before drawing: batches made and kept up to date — in play, when on. */
  sync(dt = 0) {
    const engine = this.engine;
    const on = engine.playing && engine.environment?.settings?.instancing !== false;
    if (!on) {
      if (this.batches.size) this.clear();
      return;
    }
    this._clock -= dt;
    if (this._clock <= 0 || engine.entities.length !== this._count) {
      this._clock = RESCAN_SECONDS;
      this._count = engine.entities.length;
      this._rescan();
    }
    for (const b of this.batches.values()) this._follow(b);
  }

  /** Every copy where it is now, in its colour — or nowhere, if it isn't shown. */
  _follow(b) {
    const scene = this.engine.scene;
    b.members.forEach(({ mesh, color }, i) => {
      if (shown(mesh, scene)) {
        b.mesh.setMatrixAt(i, _m.copy(mesh.matrixWorld));
      } else {
        b.mesh.setMatrixAt(i, _zero);
      }
      if (color) b.mesh.setColorAt(i, _c.copy(color));
    });
    b.mesh.instanceMatrix.needsUpdate = true;
    if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
  }

  /** Find the copies, and make (or remake) a batch for each look shared by enough of them. */
  _rescan() {
    const engine = this.engine;
    const lod = new Set((engine.gameplay?.components.instances || []).filter((c) => c.type === 'lod').map((c) => c.entity));
    const found = new Map(); // key -> [{ mesh, material }]
    for (const e of engine.entities) {
      const root = e.object3D;
      if (!root?.parent || e.viewModel || lod.has(e) || e.object3D.isLight) continue;
      root.traverse((n) => {
        if (!n.isMesh || n.isSkinnedMesh || n.isInstancedMesh || n.morphTargetInfluences || !n.geometry?.attributes?.position) return;
        const material = this._batched.get(n) ?? n.material;
        const look = lookKey(material);
        if (!look) return;
        const key = `${shapeKey(n.geometry)}#${look}#${n.castShadow ? 1 : 0}${n.receiveShadow ? 1 : 0}`;
        let list = found.get(key);
        if (!list) found.set(key, (list = []));
        list.push({ mesh: n, material });
      });
    }
    // batches no longer wanted, or whose copies changed: taken down
    for (const [key, b] of this.batches) {
      const now = found.get(key);
      const same = now && now.length >= MIN_COPIES && now.length === b.members.length && now.every((m, i) => m.mesh === b.members[i].mesh);
      if (!same) this._remove(key);
    }
    for (const [key, list] of found) {
      if (list.length < MIN_COPIES || this.batches.has(key)) continue;
      this._make(key, list);
    }
  }

  _make(key, list) {
    const first = list[0];
    const material = first.material.clone();
    const colored = !!material.color;
    if (colored) material.color.set(0xffffff); // each copy's colour, per instance
    const mesh = new THREE.InstancedMesh(first.mesh.geometry.clone(), material, list.length);
    mesh.name = '__instances';
    mesh.frustumCulled = false; // the copies are everywhere: the batch as a whole is never out of view
    mesh.castShadow = first.mesh.castShadow;
    mesh.receiveShadow = first.mesh.receiveShadow;
    mesh.userData.noShadow = !first.mesh.castShadow;
    const members = list.map(({ mesh: m, material: own }) => {
      if (!this._batched.has(m)) this._batched.set(m, own);
      m.material = NOTHING; // it draws nothing now; the batch draws it
      return { mesh: m, color: colored ? own.color : null };
    });
    const b = { mesh, members };
    this.engine.scene.add(mesh);
    this.batches.set(key, b);
    this._follow(b);
  }

  _remove(key) {
    const b = this.batches.get(key);
    if (!b) return;
    for (const { mesh } of b.members) this.release(mesh);
    b.mesh.removeFromParent();
    b.mesh.geometry.dispose();
    b.mesh.material.dispose();
    b.mesh.dispose();
    this.batches.delete(key);
  }

  /** A copy's own material back (it leaves a batch, or is destroyed). */
  release(mesh) {
    const own = this._batched.get(mesh);
    if (own === undefined) return;
    if (mesh.material === NOTHING) mesh.material = own;
    this._batched.delete(mesh);
  }

  /** An object is being removed from the game: its meshes out of their batches first. */
  forget(object3D) {
    if (!this._batched.size) return;
    object3D.traverse((n) => { if (n.isMesh) this.release(n); });
    this._count = -1; // rescan next frame
  }

  /** Play has stopped (or batching was switched off): everything draws itself again. */
  clear() {
    for (const key of [...this.batches.keys()]) this._remove(key);
    for (const [mesh, own] of this._batched) if (mesh.material === NOTHING) mesh.material = own;
    this._batched.clear();
    this._count = -1;
  }
}
