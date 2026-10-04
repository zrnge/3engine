// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { writeGlb } from '../src/gltf-files.js';
import {
  readGlb, describeMaterials, readModelMaterials, modelMaterialSpec, modelSlotImage, imageData, isModelFile,
} from '../src/gltf-material.js';

/** A stand-in for a File: what the reader uses of one. */
const file = (name, data) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  return { name, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
};

// pictures: enough of each to be told apart, not decoded
const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
const jpg = (n) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n]);
const KTX2 = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb]);

/**
 * A material pack as an exporter writes one: its pictures in the .glb's binary chunk.
 *   Wood   — colour, one ORM picture (AO in it too), normal (strength 0.8), tiling × 4,
 *            pixelated + mirrored; a warm colour factor; glow with a strength
 *   Metal  — roughness/metalness picture and a separate AO picture; see-through (blend)
 *   Leaves — cutout at 0.3; its colour picture only as KTX2
 */
function pack() {
  const pictures = [jpg(1), png(2), png(3), png(4), png(5), KTX2];
  const bin = [];
  let length = 0;
  const bufferViews = pictures.map((p) => {
    const view = { buffer: 0, byteOffset: length, byteLength: p.length };
    bin.push(p);
    length += p.length;
    return view;
  });
  const all = new Uint8Array(length);
  let at = 0;
  for (const p of bin) { all.set(p, at); at += p.length; }
  const json = {
    asset: { version: '2.0' },
    bufferViews,
    buffers: [{ byteLength: length }],
    images: [
      { bufferView: 0, mimeType: 'image/jpeg', name: 'wood_diff' },
      { bufferView: 1, mimeType: 'image/png', name: 'wood_arm' },
      { bufferView: 2, mimeType: 'image/png' },
      { bufferView: 3, mimeType: 'image/png', name: 'metal_rough' },
      { bufferView: 4, mimeType: 'image/png', name: 'metal_ao' },
      { bufferView: 5, mimeType: 'image/ktx2', name: 'leaves' },
    ],
    samplers: [{ magFilter: 9728, wrapS: 33648, wrapT: 33648 }],
    textures: [
      { source: 0, sampler: 0 }, { source: 1 }, { source: 2 }, { source: 3 }, { source: 4 },
      { extensions: { KHR_texture_basisu: { source: 5 } } },
    ],
    extensionsUsed: ['KHR_texture_transform', 'KHR_materials_emissive_strength', 'KHR_texture_basisu'],
    materials: [
      {
        name: 'Wood',
        pbrMetallicRoughness: {
          baseColorFactor: [0.5, 0.2, 0.1, 1],
          baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { scale: [4, 4] } } },
          metallicRoughnessTexture: { index: 1 },
          metallicFactor: 0,
          roughnessFactor: 0.9,
        },
        occlusionTexture: { index: 1, strength: 0.7 },
        normalTexture: { index: 2, scale: 0.8 },
        emissiveFactor: [1, 0.5, 0],
        extensions: { KHR_materials_emissive_strength: { emissiveStrength: 3 } },
      },
      {
        name: 'Metal',
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5], metallicRoughnessTexture: { index: 3 } },
        occlusionTexture: { index: 4 },
        alphaMode: 'BLEND',
      },
      {
        pbrMetallicRoughness: { baseColorTexture: { index: 5 }, metallicFactor: 0 },
        alphaMode: 'MASK',
        alphaCutoff: 0.3,
      },
    ],
  };
  return writeGlb(json, all);
}

/** Stores a picture: a map source naming it, and counts the calls. */
const store = () => vi.fn(async ({ name, type, bytes }) => ({ assetId: `id-${name}`, name, type, first: bytes[0] }));

describe('materials out of a glTF model (Color & Texture panel)', () => {
  it('reads a .glb\'s JSON and its binary chunk', () => {
    const gltf = readGlb(pack());
    expect(gltf.json.materials).toHaveLength(3);
    expect(gltf.bin.length).toBeGreaterThan(0);
    expect(readGlb(new TextEncoder().encode('not a model'))).toBeNull();
    expect(isModelFile('Pack.GLB') && isModelFile('scene.gltf') && !isModelFile('wood.png')).toBe(true);
  });

  it('describes every material in the panel\'s own terms', () => {
    const [wood, metal, leaves] = describeMaterials(readGlb(pack()));
    // colours in the file are linear; the panel's are ordinary hex
    expect(wood.settings.color).toBe(`#${new THREE.Color().setRGB(0.5, 0.2, 0.1, THREE.LinearSRGBColorSpace).getHexString()}`);
    expect(wood.settings.color).toBe('#bc7c59');
    expect(wood.settings).toMatchObject({
      metalness: 0, roughness: 0.9, normalStrength: 0.8, aoIntensity: 0.7, emissiveIntensity: 3, alphaMode: 'auto', opacity: 1,
    });
    expect(wood.settings.emissive).toBe('#ffbc00');
    expect(wood.settings.uv).toMatchObject({ repeat: [4, 4], wrap: 'mirror', filter: 'pixel' });
    // AO, roughness and metalness in one picture: the ORM slot
    expect(wood.maps).toEqual({ map: { image: 0 }, orm: { image: 1 }, normalMap: { image: 2 } });
    expect(wood.textures).toBe(3);
    // separate AO: roughness and metalness share their picture, AO has its own
    expect(metal.maps).toEqual({ roughnessMap: { image: 3 }, metalnessMap: { image: 3 }, aoMap: { image: 4 } });
    expect(metal.settings).toMatchObject({ alphaMode: 'blend', opacity: 0.5, metalness: 1, roughness: 1 });
    expect(leaves.name).toBe('Material 3');
    expect(leaves.settings).toMatchObject({ alphaMode: 'cutout', alphaCutoff: 0.3 });
    expect(leaves.maps.map).toEqual({ image: 5, ktx2: true });
  });

  it('a chosen material becomes the whole surface — each picture stored once, as it was in the file', async () => {
    const model = { name: 'pack.glb', gltf: readGlb(pack()) };
    model.materials = describeMaterials(model.gltf);
    const importImage = store();
    const { spec, lines } = await modelMaterialSpec(model, 1, { importImage });
    expect(importImage).toHaveBeenCalledTimes(2); // the shared roughness / metalness picture once
    expect(spec.maps.roughnessMap).toEqual(spec.maps.metalnessMap);
    expect(spec.maps.roughnessMap).toMatchObject({ assetId: 'id-metal_rough.png', name: 'metal_rough.png' });
    expect(spec.maps.aoMap.name).toBe('metal_ao.png');
    // every other slot emptied: it becomes this material, not a mix with what was there
    expect(spec.maps.map).toBeNull();
    expect(spec.maps.normalMap).toBeNull();
    expect(spec.alphaMode).toBe('blend');
    expect(lines).toContain('Roughness ← metal_rough.png');

    const wood = await modelMaterialSpec(model, 0, { importImage: store() });
    expect(wood.spec.maps.map).toMatchObject({ name: 'wood_diff.jpg' });
    expect(wood.spec.maps.orm.name).toBe('wood_arm.png');
    // a picture with no name of its own is named after its material and slot
    expect(wood.spec.maps.normalMap.name).toBe('Wood Normal.png');
    expect(wood.spec.uv.repeat).toEqual([4, 4]);

    // KTX2: skipped with nothing to decode it...
    const leaves = await modelMaterialSpec(model, 2, { importImage: store() });
    expect(leaves.spec.maps.map).toBeNull();
    expect(leaves.lines.join('\n')).toMatch(/Base colour → skipped: .*KTX2/);
    // ...and turned into a PNG with (in the editor: ktx2ToPng, through the renderer)
    const decodeKtx2 = vi.fn(async (data) => ({ bytes: png(6), type: 'image/png', name: data.name.replace('.ktx2', '.png') }));
    const decoded = await modelMaterialSpec(model, 2, { importImage: store(), decodeKtx2 });
    expect(decoded.spec.maps.map).toMatchObject({ name: 'leaves.png' });
    expect(decoded.lines).toContain('Base colour ← leaves.ktx2 (KTX2, turned into PNG)');
  });

  it('the pictures are the file\'s own bytes', () => {
    const gltf = readGlb(pack());
    const wood = imageData(gltf, 0);
    expect(wood).toMatchObject({ type: 'image/jpeg', name: 'wood_diff.jpg' });
    expect([...wood.bytes]).toEqual([...jpg(1)]);
  });

  it('one slot\'s picture only: from a packed ORM picture for roughness, or why there is none', () => {
    const model = { gltf: readGlb(pack()) };
    model.materials = describeMaterials(model.gltf);
    expect(modelSlotImage(model, 0, 'roughnessMap').data.name).toBe('wood_arm.png');
    expect(modelSlotImage(model, 0, 'normalMap').data.name).toBe('Wood Normal.png');
    expect(modelSlotImage(model, 1, 'normalMap').why).toMatch(/"Metal" has no normal picture/);
    expect(modelSlotImage(model, 2, 'map').data.type).toBe('image/ktx2'); // for ktx2ToPng
  });

  it('a .gltf with its pictures beside it (a Sketchfab or Poly Haven download), or inside it', async () => {
    const json = {
      asset: { version: '2.0' },
      images: [{ uri: 'textures/brick_diff.jpg' }, { uri: `data:image/png;base64,${btoa(String.fromCharCode(...png(9)))}` }],
      textures: [{ source: 0 }, { source: 1 }],
      materials: [{ name: 'Brick', pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } }],
    };
    const files = [
      { file: file('brick.gltf', JSON.stringify(json)), path: 'brick/brick.gltf' },
      { file: file('brick_diff.jpg', jpg(7)), path: 'brick/textures/brick_diff.jpg' },
    ];
    const model = await readModelMaterials(files);
    expect(model.name).toBe('brick.gltf');
    expect(model.materials.map((m) => m.name)).toEqual(['Brick']);
    const importImage = store();
    const { spec } = await modelMaterialSpec(model, 0, { importImage });
    expect(spec.maps.map).toEqual({ assetId: 'id-brick_diff.jpg', name: 'brick_diff.jpg' });
    expect(spec.maps.normalMap.name).toBe('Brick Normal.png');
    // the picture beside it, and the one inside it, each as its own bytes
    const given = Object.fromEntries(importImage.mock.calls.map(([d]) => [d.name, [...d.bytes]]));
    expect(given).toEqual({ 'brick_diff.jpg': [...jpg(7)], 'Brick Normal.png': [...png(9)] });

    // without the picture it names: says which file it needs, and that its folder will do
    const err = await readModelMaterials([files[0]]).catch((e) => e);
    expect(err).toMatchObject({ missing: ['textures/brick_diff.jpg'], needsFolder: true });
    expect(err.message).toMatch(/brick\.gltf keeps .*textures\/brick_diff\.jpg.*choose the folder the model is in/);
    // no model among the files at all
    expect(await readModelMaterials([file('wood.png', png(1))])).toBeNull();
  });

  it('tiling that only unpacks a compressed model\'s UVs is not taken (it would show one pixel)', () => {
    const json = {
      asset: { version: '2.0' },
      images: [{ uri: `data:image/png;base64,${btoa(String.fromCharCode(...png(1)))}` }],
      textures: [{ source: 0 }],
      materials: [
        { pbrMetallicRoughness: { baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { scale: [0.000244, 0.000244], offset: [0.0007, 0.0007] } } } } },
        { pbrMetallicRoughness: { baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { scale: [2, 3], offset: [0.5, 0.25], rotation: Math.PI / 2 } } } } },
      ],
    };
    const [packed, tiled] = describeMaterials({ json, bin: null });
    expect(packed.settings.uv).toMatchObject({ repeat: [1, 1], offset: [0, 0], rotation: 0 });
    expect(tiled.settings.uv).toMatchObject({ repeat: [2, 3], offset: [0.5, -0.25], rotation: -90 });
  });

  it('a Poly Haven folder: the material needs only its pictures (not the .bin), found in textures/ — the right model among several', async () => {
    const pack = (name, pic) => ({
      asset: { version: '2.0' },
      buffers: [{ uri: `${name}.bin`, byteLength: 36 }],
      images: [{ uri: `textures/${name}_diff_4k.jpg` }],
      textures: [{ source: 0 }],
      materials: [{ name, pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      _pic: pic,
    });
    // the folder as a folder picker gives it: its own layout, two packs, no .bin files at all
    const folder = [
      { file: file('stacked_brick_wall.gltf', JSON.stringify(pack('stacked_brick_wall'))), path: 'downloads/stacked_brick_wall/stacked_brick_wall.gltf' },
      { file: file('stacked_brick_wall_diff_4k.jpg', jpg(3)), path: 'downloads/stacked_brick_wall/textures/stacked_brick_wall_diff_4k.jpg' },
      { file: file('wood.gltf', JSON.stringify(pack('wood'))), path: 'downloads/wood/wood.gltf' },
      { file: file('wood_diff_4k.jpg', jpg(4)), path: 'downloads/wood/textures/wood_diff_4k.jpg' },
    ];
    const model = await readModelMaterials(folder, { prefer: 'stacked_brick_wall.gltf' });
    expect(model.name).toBe('stacked_brick_wall.gltf');
    const importImage = store();
    const { spec } = await modelMaterialSpec(model, 0, { importImage });
    expect(spec.maps.map.name).toBe('stacked_brick_wall_diff_4k.jpg');
    expect([...importImage.mock.calls[0][0].bytes]).toEqual([...jpg(3)]);
  });

  it('a damaged file is said to be one', async () => {
    await expect(readModelMaterials([file('bad.glb', 'glTF but not really')])).rejects.toThrow(/damaged/);
  });
});
