// Builds assets/blaster.glb: first-person arms holding a blocky blaster, with
// four animation clips (Idle, Walk, Shoot, Reload) — and assets/blaster-inspect.glb,
// one more move for the same rig in a file of its own. A stand-in for the kind of
// file a game maker brings — the engine knows nothing about these names.
//
//   node tools/make-blaster.mjs
//
// Plain glTF 2.0 written by hand (no exporter needed): box meshes on nodes,
// node animations. The model faces +Z, as glTF models do.
import { writeFileSync } from 'node:fs';
import * as THREE from '../lib/three.module.js';

// ---- one unit box, shared by every part ----
const box = new THREE.BoxGeometry(1, 1, 1);
const positions = new Float32Array(box.attributes.position.array);
const normals = new Float32Array(box.attributes.normal.array);
const indices = new Uint16Array(box.index.array);

const materials = [
  { name: 'Frame', color: [0.16, 0.18, 0.22], metal: 0.6, rough: 0.45 },
  { name: 'Steel', color: [0.55, 0.58, 0.62], metal: 0.9, rough: 0.3 },
  { name: 'Glow', color: [1.0, 0.55, 0.12], metal: 0.1, rough: 0.5 },
  { name: 'Sleeve', color: [0.22, 0.34, 0.3], metal: 0.0, rough: 0.9 },
  { name: 'Skin', color: [0.86, 0.66, 0.52], metal: 0.0, rough: 0.8 },
];

// ---- the parts: [name, material, translation, scale, parent] ----
const nodes = [];
const node = (name, { mesh, t = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1] } = {}) => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...r));
  const n = { name, translation: t, rotation: q.toArray(), scale: s, children: [] };
  if (mesh !== undefined) n.mesh = mesh;
  nodes.push(n);
  return nodes.length - 1;
};
const part = (name, mat, t, s, r) => node(name, { mesh: mat, t, s, r });

const root = node('Blaster');
const rig = node('Rig');
const gun = node('Gun');
const mag = part('Magazine', 2, [0, -0.1, 0.1], [0.05, 0.13, 0.08]);
nodes[gun].children.push(
  part('Body', 0, [0, 0, 0.06], [0.08, 0.11, 0.38]),
  part('Barrel', 1, [0, 0.025, 0.32], [0.045, 0.045, 0.2]),
  part('Sight', 2, [0, 0.075, 0.12], [0.02, 0.03, 0.06]),
  part('Grip', 0, [0, -0.1, -0.06], [0.06, 0.14, 0.07], [-0.25, 0, 0]),
  mag,
);
const armR = part('Arm R', 3, [0.07, -0.13, -0.26], [0.075, 0.075, 0.34], [0.2, 0.12, 0]);
const handR = part('Hand R', 4, [0.03, -0.11, -0.07], [0.07, 0.07, 0.09]);
const armL = part('Arm L', 3, [-0.08, -0.1, -0.02], [0.07, 0.07, 0.34], [0.12, -0.45, 0]);
const handL = part('Hand L', 4, [-0.015, -0.06, 0.16], [0.07, 0.06, 0.09]);
nodes[rig].children.push(gun, armR, handR, armL, handL);
nodes[root].children.push(rig);

// ---- animation: [clip name, [[node, path, times, values]]] ----
const q = (x, y = 0, z = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)).toArray();
const clips = [
  ['Idle', [
    [rig, 'translation', [0, 1, 2], [0, 0, 0, 0, 0.006, 0, 0, 0, 0]],
  ]],
  ['Walk', [
    [rig, 'translation', [0, 0.2, 0.4, 0.6, 0.8], [0, 0, 0, 0.012, -0.018, 0, 0, 0, 0, -0.012, -0.018, 0, 0, 0, 0]],
    [rig, 'rotation', [0, 0.4, 0.8], [...q(0, 0, 0.02), ...q(0, 0, -0.02), ...q(0, 0, 0.02)]],
  ]],
  ['Shoot', [
    [rig, 'translation', [0, 0.05, 0.25], [0, 0, 0, 0, 0.01, -0.06, 0, 0, 0]],
    [rig, 'rotation', [0, 0.05, 0.25], [...q(0), ...q(-0.14), ...q(0)]],
  ]],
  ['Reload', [
    [rig, 'rotation', [0, 0.3, 1.1, 1.4], [...q(0), ...q(0.25, 0, 0.45), ...q(0.25, 0, 0.45), ...q(0)]],
    [mag, 'translation', [0, 0.35, 0.5, 0.8, 1.1, 1.4],
      [0, -0.1, 0.1, 0, -0.1, 0.1, 0, -0.45, 0.1, 0, -0.45, 0.1, 0, -0.1, 0.1, 0, -0.1, 0.1]],
    [mag, 'scale', [0, 0.49, 0.5, 0.8, 0.81, 1.4],
      [0.05, 0.13, 0.08, 0.05, 0.13, 0.08, 0, 0, 0, 0, 0, 0, 0.05, 0.13, 0.08, 0.05, 0.13, 0.08]],
  ]],
];

/**
 * Write a GLB of these nodes and clips. `withMeshes: false` writes the rig
 * alone — an animation-only file, like the one-move-per-file downloads from
 * Mixamo — whose clips fit the full model because the node names match.
 */
function writeGlb(file, clipDefs, { withMeshes = true } = {}) {
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  let offset = 0;
  const add = (typed, { target, type, componentType, count, min, max }) => {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);
    chunks.push(padded);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) });
    offset += padded.length;
    accessors.push({ bufferView: bufferViews.length - 1, componentType, count, type,
      ...(min ? { min, max } : {}) });
    return accessors.length - 1;
  };
  const bounds = (arr) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], arr[i + k]);
      max[k] = Math.max(max[k], arr[i + k]);
    }
    return { min, max };
  };
  let POS;
  let NRM;
  let IDX;
  if (withMeshes) {
    POS = add(positions, { target: 34962, type: 'VEC3', componentType: 5126, count: positions.length / 3, ...bounds(positions) });
    NRM = add(normals, { target: 34962, type: 'VEC3', componentType: 5126, count: normals.length / 3 });
    IDX = add(indices, { target: 34963, type: 'SCALAR', componentType: 5123, count: indices.length });
  }

  const animations = clipDefs.map(([name, tracks]) => {
    const channels = [];
    const samplers = [];
    for (const [target, path, times, values] of tracks) {
      const input = add(new Float32Array(times), {
        type: 'SCALAR', componentType: 5126, count: times.length, min: [times[0]], max: [times[times.length - 1]],
      });
      const output = add(new Float32Array(values), {
        type: path === 'rotation' ? 'VEC4' : 'VEC3', componentType: 5126, count: times.length,
      });
      samplers.push({ input, output, interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: target, path } });
    }
    return { name, channels, samplers };
  });

  const gltf = {
    asset: { version: '2.0', generator: 'Tiny3 tools/make-blaster.mjs' },
    scene: 0,
    scenes: [{ nodes: [root] }],
    nodes: nodes.map((n) => {
      const out = { name: n.name, translation: n.translation, rotation: n.rotation, scale: n.scale };
      if (withMeshes && n.mesh !== undefined) out.mesh = n.mesh;
      if (n.children.length) out.children = n.children;
      return out;
    }),
    ...(withMeshes ? {
      meshes: materials.map((m, i) => ({
        name: m.name, primitives: [{ attributes: { POSITION: POS, NORMAL: NRM }, indices: IDX, material: i }],
      })),
      materials: materials.map((m) => ({
        name: m.name,
        pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: m.metal, roughnessFactor: m.rough },
      })),
    } : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
    animations,
  };

  // ---- GLB: header, JSON chunk, BIN chunk ----
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadded = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(0x20);
  jsonPadded.set(json);
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) { bin.set(c, at); at += c.length; }
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out = new DataView(new ArrayBuffer(total));
  out.setUint32(0, 0x46546c67, true); // "glTF"
  out.setUint32(4, 2, true);
  out.setUint32(8, total, true);
  out.setUint32(12, jsonPadded.length, true);
  out.setUint32(16, 0x4e4f534a, true); // "JSON"
  new Uint8Array(out.buffer, 20, jsonPadded.length).set(jsonPadded);
  const binAt = 20 + jsonPadded.length;
  out.setUint32(binAt, bin.length, true);
  out.setUint32(binAt + 4, 0x004e4942, true); // "BIN"
  new Uint8Array(out.buffer, binAt + 8, bin.length).set(bin);
  writeFileSync(new URL(`../assets/${file}`, import.meta.url), new Uint8Array(out.buffer));
  console.log(`assets/${file}: ${total} bytes, ${withMeshes ? 'model and ' : 'rig only, '}clips: ${clipDefs.map((c) => c[0]).join(', ')}`);
}

writeGlb('blaster.glb', clips);
// a separate move for the same rig, as a store would sell it: one animation, no model
writeGlb('blaster-inspect.glb', [
  ['mixamo.com', [
    [rig, 'rotation', [0, 0.6, 1.6, 2.2], [...q(0), ...q(0.15, 0.9, 0.35), ...q(0.15, 0.9, 0.35), ...q(0)]],
  ]],
], { withMeshes: false });