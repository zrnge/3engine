// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readGlb, writeGlb } from '../src/gltf-files.js';
import { shrinkGlb } from '../src/asset-compress.js';
import { readOtherModel, writeModel, toStandard, CONVERTIBLE } from '../src/model-import.js';
import { assetUses } from '../src/asset-refs.js';
import { AssetLoader } from '../src/loader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Assets: other formats made into .glb, textures made smaller, and what the library counts.

/** A hand-made .glb: a triangle's points, a colour picture, a normal-map picture. */
function sampleGlb() {
  const points = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const colour = new Uint8Array(1001).fill(7);  // "a PNG" (any bytes: the transform is stood in for)
  const normal = new Uint8Array(803).fill(9);
  const parts = [new Uint8Array(points.buffer), colour, normal];
  const bin = new Uint8Array(4000);
  const views = [];
  let at = 0;
  for (const p of parts) {
    at = (at + 3) & ~3;
    bin.set(p, at);
    views.push({ buffer: 0, byteOffset: at, byteLength: p.length });
    at += p.length;
  }
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: at }],
    bufferViews: views,
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    images: [{ bufferView: 1, mimeType: 'image/png' }, { bufferView: 2, mimeType: 'image/png' }],
    textures: [{ source: 0 }, { source: 1 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } }],
  };
  return { bytes: writeGlb(json, bin.subarray(0, at)), points };
}

describe('.glb files', () => {
  it('read back as written: the JSON and the binary chunk', () => {
    const { bytes } = sampleGlb();
    const glb = readGlb(bytes);
    expect(glb.json.images.length).toBe(2);
    expect(glb.bin.length).toBeGreaterThan(1800);
    expect(readGlb(new Uint8Array([1, 2, 3]))).toBe(null);
  });
});

describe('textures made smaller on import', () => {
  it('each picture through the transform; the normal map kept lossless; the rest laid out again, intact', async () => {
    const { bytes, points } = sampleGlb();
    const asked = [];
    // a stand-in for the canvas: a third the size, as JPEG when it may be
    const transform = async (data, mime, opts) => {
      asked.push(opts.jpeg);
      return { bytes: data.subarray(0, Math.floor(data.length / 3)), mime: opts.jpeg ? 'image/jpeg' : mime };
    };
    const r = await shrinkGlb(bytes, { maxSize: 1024, jpeg: true }, { transform });
    expect(r.images).toBe(2);
    expect(r.after).toBeLessThan(r.before);
    expect(asked).toEqual([true, false]); // the normal map: never JPEG
    const glb = readGlb(r.bytes);
    expect(glb.json.images.map((i) => i.mimeType)).toEqual(['image/jpeg', 'image/png']);
    const v = glb.json.bufferViews;
    expect(v.every((x) => x.byteOffset % 4 === 0)).toBe(true);
    expect(v[1].byteLength).toBe(333);
    expect(glb.json.buffers[0].byteLength).toBeGreaterThanOrEqual(v[2].byteOffset + v[2].byteLength);
    // the triangle's points: the same bytes, wherever they are now
    const got = new Float32Array(glb.bin.slice(v[0].byteOffset, v[0].byteOffset + v[0].byteLength).buffer);
    expect([...got]).toEqual([...points]);
  });

  it('nothing smaller: the file as it was', async () => {
    const { bytes } = sampleGlb();
    const r = await shrinkGlb(bytes, {}, { transform: async () => null });
    expect(r.images).toBe(0);
    expect(r.bytes).toBe(bytes);
  });
});

describe('other formats into .glb', () => {
  const file = (name, text) => new File([text], name);
  const cube = `mtllib crate.mtl
o Crate
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
v 1 0 1
v 1 1 1
v 0 1 1
usemtl Wood
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 5 1 4 8
`;
  const mtl = `newmtl Wood
Kd 0.8 0.4 0.1
Ns 20
`;

  it('an .obj with its .mtl: its shape and its colour, as standard materials', async () => {
    const entries = [{ file: file('crate.obj', cube), path: 'crate.obj' }, { file: file('crate.mtl', mtl), path: 'crate.mtl' }];
    const { root, missing } = await readOtherModel(entries[0], entries);
    const meshes = [];
    root.traverse((n) => { if (n.isMesh) meshes.push(n); });
    expect(meshes.length).toBe(1);
    const m = meshes[0].material;
    expect(m.isMeshStandardMaterial).toBe(true);
    expect(m.color.r).toBeCloseTo(new THREE.Color().setRGB(0.8, 0.4, 0.1, THREE.SRGBColorSpace).r, 2);
    expect(meshes[0].geometry.attributes.position.count).toBe(36); // 6 squares, 2 triangles each
    expect(missing).toEqual([]);
  });

  it('written as a .glb that reads back: the same shape', async () => {
    const entries = [{ file: file('crate.obj', cube), path: 'crate.obj' }];
    const { root } = await readOtherModel(entries[0], entries);
    const bytes = await writeModel(root);
    expect(readGlb(bytes)).not.toBe(null);
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    let count = 0;
    gltf.scene.traverse((n) => { if (n.isMesh) count += n.geometry.attributes.position.count; });
    expect(count).toBeGreaterThanOrEqual(24);
  });

  it('an .stl: one shape, grey, its normals made', async () => {
    const stl = `solid t
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid t
`;
    const entries = [{ file: file('part.stl', stl), path: 'part.stl' }];
    const { root } = await readOtherModel(entries[0], entries);
    const mesh = root.children[0];
    expect(mesh.isMesh).toBe(true);
    expect(mesh.geometry.attributes.normal).toBeTruthy();
    expect(mesh.material.isMeshStandardMaterial).toBe(true);
    expect(CONVERTIBLE).toEqual(['obj', 'fbx', 'stl']);
  });

  it('older materials become standard ones, their look kept: shiny is smooth, see-through stays', () => {
    const shiny = toStandard(new THREE.MeshPhongMaterial({ color: 0xff0000, shininess: 100, transparent: true, opacity: 0.5 }));
    const matt = toStandard(new THREE.MeshLambertMaterial({ color: 0x00ff00 }));
    expect(shiny.isMeshStandardMaterial && matt.isMeshStandardMaterial).toBe(true);
    expect(shiny.roughness).toBeLessThan(matt.roughness);
    expect(shiny.transparent && shiny.opacity === 0.5).toBe(true);
    const standard = new THREE.MeshStandardMaterial();
    expect(toStandard(standard)).toBe(standard);
  });

  it('import: converted, made smaller, said so (notes) — a .glb among them as before', async () => {
    const assets = new AssetLoader();
    assets._loader.loadAsync = async () => ({ scene: new THREE.Group(), animations: [] }); // (no blob: URLs here)
    const glb = await writeModel(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    assets.convertible = ['obj'];
    assets.convertModel = async (entry) => new File([glb], entry.file.name.replace('.obj', '.glb'));
    assets.shrinkModel = async (f) => ({ file: new File([await f.arrayBuffer()], f.name), images: 1 });
    const result = await assets.importFiles([file('crate.obj', cube), new File([glb], 'box.glb')]);
    expect(result.errors).toEqual([]);
    expect(result.models.length).toBe(2);
    expect(result.notes.map((n) => [n.name, n.images])).toEqual([['crate.obj', 1], ['box.glb', 1]]);
  });
});

describe('the library counts uses', () => {
  it('each asset id, as many times as the game names it', () => {
    const game = { levels: [{ entities: [{ assetId: 'a' }, { assetId: 'a' }, { material: { maps: { map: { assetId: 'b' } } } }] }], prefabs: { P: { assetId: 'a' } } };
    const uses = assetUses(game);
    expect(uses.get('a')).toBe(3);
    expect(uses.get('b')).toBe(1);
    expect(uses.get('c')).toBe(undefined);
  });
});
