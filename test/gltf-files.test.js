// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { gltfJson, extensionsUsed, decodersNeeded, writeGlb, packGltf, DECODERS } from '../src/gltf-files.js';

/** A stand-in for a File: what packGltf reads from one. */
const file = (name, data) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  return {
    name,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer,
  };
};
const entry = (path, data) => ({ file: file(path.split('/').pop(), data), path });

/** One triangle: 3 positions (36 bytes) in a .bin, as a real exporter writes it. */
const TRIANGLE = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const triangleGltf = (over = {}) => ({
  asset: { version: '2.0' },
  scenes: [{ nodes: [0] }], scene: 0,
  nodes: [{ mesh: 0, name: 'Tri' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
  buffers: [{ uri: 'scene.bin', byteLength: 36 }],
  ...over,
});
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]); // enough to be carried, not decoded

/** The bytes of a bufferView inside a .glb. */
function viewBytes(glb, json, index) {
  const dv = new DataView(glb.buffer, glb.byteOffset);
  const jsonLength = dv.getUint32(12, true);
  const binStart = 20 + jsonLength + 8;
  const view = json.bufferViews[index];
  return glb.subarray(binStart + (view.byteOffset || 0), binStart + (view.byteOffset || 0) + view.byteLength);
}

describe('reading a glTF file', () => {
  it('finds the JSON of a .glb and of a .gltf, and nothing in anything else', () => {
    const json = { asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] };
    expect(gltfJson(writeGlb(json))).toEqual(json);
    expect(gltfJson(new TextEncoder().encode(JSON.stringify(json)))).toEqual(json);
    expect(gltfJson(new TextEncoder().encode('ID3 an mp3'))).toBeNull();
    expect(gltfJson(new TextEncoder().encode('{"not":"a model"}'))).toBeNull();
  });

  it('says which decoders a set of files needs — only those', () => {
    const draco = writeGlb({ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] });
    const basis = writeGlb({ asset: { version: '2.0' }, extensionsUsed: ['KHR_texture_basisu', 'EXT_meshopt_compression'] });
    const plain = writeGlb({ asset: { version: '2.0' } });
    expect(extensionsUsed(basis)).toEqual(['KHR_texture_basisu', 'EXT_meshopt_compression']);
    expect(decodersNeeded([plain])).toEqual([]);
    expect(decodersNeeded([draco, plain])).toEqual(['draco']);
    expect(decodersNeeded([draco, basis]).sort()).toEqual(['basis', 'draco']);
    expect(DECODERS.draco.files).toContain('draco_decoder.wasm');
  });
});

describe('packing a .gltf with its files into one .glb', () => {
  it('moves the .bin and the images inside, byte for byte, and the result loads', async () => {
    const gltf = triangleGltf({
      images: [{ uri: 'textures/wood%20grain.png' }],
      textures: [{ source: 0 }],
    });
    const entries = [
      entry('crate/scene.gltf', JSON.stringify(gltf)),
      entry('crate/scene.bin', TRIANGLE.buffer),
      entry('crate/textures/wood grain.png', PNG), // the uri is percent-encoded
      entry('crate/readme.txt', 'not wanted'),
    ];
    const glb = await packGltf(entries[0], entries);
    const json = gltfJson(glb);

    expect(json.buffers).toEqual([{ byteLength: expect.any(Number) }]); // the .glb's own data, no files
    expect(json.images[0].uri).toBeUndefined();
    expect(json.images[0].mimeType).toBe('image/png');
    expect([...viewBytes(glb, json, json.images[0].bufferView)]).toEqual([...PNG]);
    expect(new Float32Array(viewBytes(glb, json, 0).slice().buffer)).toEqual(TRIANGLE);
    for (const view of json.bufferViews) expect(view.byteOffset % 4).toBe(0);

    const loaded = await new GLTFLoader().parseAsync(glb.slice().buffer, '');
    const mesh = loaded.scene.getObjectByName('Tri');
    expect([...mesh.geometry.getAttribute('position').array]).toEqual([...TRIANGLE]);
  });

  it('finds files picked one by one (no folders), and data: URIs inside the .gltf', async () => {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(TRIANGLE.buffer)));
    const gltf = triangleGltf({
      buffers: [{ uri: `data:application/octet-stream;base64,${b64}`, byteLength: 36 }],
      images: [{ uri: 'textures/a.png' }],
    });
    const entries = [entry('model.gltf', JSON.stringify(gltf)), entry('a.png', PNG)];
    const json = gltfJson(await packGltf(entries[0], entries));
    expect(json.buffers).toHaveLength(1);
    expect(json.images[0].bufferView).toBeGreaterThan(0);
  });

  it('keeps a meshopt model working: its compressed data moves, its fallback buffer stays', async () => {
    const gltf = triangleGltf({
      extensionsUsed: ['EXT_meshopt_compression'],
      buffers: [{ byteLength: 36, extensions: { EXT_meshopt_compression: { fallback: true } } }, { uri: 'packed.bin', byteLength: 20 }],
      bufferViews: [{
        buffer: 0, byteOffset: 0, byteLength: 36, byteStride: 12,
        extensions: { EXT_meshopt_compression: { buffer: 1, byteOffset: 4, byteLength: 16, byteStride: 12, count: 3, mode: 'ATTRIBUTES' } },
      }],
    });
    const entries = [entry('m.gltf', JSON.stringify(gltf)), entry('packed.bin', new Uint8Array(20).fill(7))];
    const json = gltfJson(await packGltf(entries[0], entries));
    expect(json.buffers[0].byteLength).toBe(20); // the chunk: packed.bin
    expect(json.buffers[1].extensions.EXT_meshopt_compression.fallback).toBe(true);
    expect(json.bufferViews[0].buffer).toBe(1); // still the fallback
    expect(json.bufferViews[0].extensions.EXT_meshopt_compression).toMatchObject({ buffer: 0, byteOffset: 4 });
  });

  it('names every file that is missing, and says how to bring them', async () => {
    const gltf = triangleGltf({ images: [{ uri: 'textures/a.png' }, { uri: 'textures/b.png' }] });
    const entries = [entry('car/scene.gltf', JSON.stringify(gltf)), entry('car/textures/a.png', PNG)];
    const err = await packGltf(entries[0], entries).catch((e) => e);
    expect(err.message).toMatch(/scene\.bin, textures\/b\.png\./);
    // in a folder beside it, which a picker can't reach into: choose (or drop) the model's folder
    expect(err.message).toMatch(/choose the folder the model is in, or drop that folder/);
    expect(err).toMatchObject({ missing: ['scene.bin', 'textures/b.png'], needsFolder: true });
  });
});
