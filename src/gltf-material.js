import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import {
  gltfJson, dataUriBytes, DECODERS, dirOf, baseName, decodeUri, findFile, missingFiles,
} from './gltf-files.js';
import { TEXTURE_SLOTS, normalizeSpec } from './materials.js';

/**
 * Materials out of a glTF model — for the Color & Texture panel, which could
 * only take pictures. A material pack (Poly Haven, ambientCG, Sketchfab, a
 * Substance or Blender export) is a .glb or .gltf: each material in it is a
 * whole surface — colour, normal, roughness / metalness, AO, glow, see-through
 * — with its factors, tiling and filtering. This reads all of that straight
 * from the file: the JSON and the images exactly as they are stored in it
 * (nothing redrawn, nothing re-encoded). Only KTX2 / Basis pictures — the GPU
 * format optimised models use — need the renderer, to be turned into PNGs
 * (see ktx2ToPng).
 *
 *   const model = await readModelMaterials(files);   // files as picked or dropped
 *   model.materials                                  // [{ name, settings, maps, notes }]
 *   const { spec, lines } = await modelMaterialSpec(model, 0, { importImage });
 *   applyMaterialSpec(material, spec);
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const WRAP = { 33071: 'clamp', 33648: 'mirror', 10497: 'repeat' };
const NEAREST = 9728;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/ktx2': 'ktx2' };

export const isModelFile = (name) => /\.(glb|gltf)$/i.test(String(name || ''));

/** The JSON and binary chunk of a .glb (or a .gltf with everything inside) — or null. */
export function readGlb(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || view.getUint32(0, true) !== GLB_MAGIC) {
    const json = gltfJson(bytes);
    return json ? { json, bin: null } : null;
  }
  const total = Math.min(bytes.length, view.getUint32(8, true));
  let json = null;
  let bin = null;
  for (let at = 12; at + 8 <= total;) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === CHUNK_JSON) {
      try { json = JSON.parse(new TextDecoder().decode(body)); } catch { return null; }
    } else if (type === CHUNK_BIN && !bin) {
      bin = body;
    }
    at += 8 + length;
  }
  return json ? { json, bin } : null;
}

/** What kind of picture these bytes are, from their first bytes. */
function sniff(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  if (bytes[0] === 0xab && bytes[1] === 0x4b && bytes[2] === 0x54 && bytes[3] === 0x58) return 'image/ktx2';
  return '';
}

/**
 * Image `index` of the file: { bytes, type, name } — or null when its data is
 * not in the file (a picture beside a .glb that wasn't given with it).
 */
export function imageData(gltf, index, fallbackName = 'texture') {
  const img = gltf.json.images?.[index];
  if (!img) return null;
  let bytes = gltf.files?.get(index) ?? null; // a .gltf's picture, read from the file beside it
  if (bytes) {
    // named as its file
  } else if (img.bufferView !== undefined) {
    const view = gltf.json.bufferViews?.[img.bufferView];
    if (!view || (view.buffer ?? 0) !== 0 || !gltf.bin) return null;
    const start = view.byteOffset || 0;
    bytes = gltf.bin.subarray(start, start + view.byteLength);
  } else if (/^data:/i.test(img.uri || '')) {
    bytes = dataUriBytes(img.uri);
  }
  if (!bytes?.length) return null;
  const type = sniff(bytes) || img.mimeType || /^data:([^;,]+)/i.exec(img.uri || '')?.[1] || 'image/png';
  const own = img.name || (img.uri && !/^data:/i.test(img.uri) ? decodeURIComponent(img.uri.split('/').pop()) : '');
  const base = (own || fallbackName).replace(/\.[a-z0-9]+$/i, '');
  return { bytes, type, name: `${base}.${EXT[type] || 'png'}` };
}

/**
 * The picture a texture reference shows: { image } — with `ktx2: true` when
 * its only picture is KTX2 / Basis, which a browser can't read as an image
 * (see ktx2ToPng). A plain PNG / JPEG fallback is taken over WebP or KTX2 when both are there.
 */
function textureImage(json, ref) {
  const tex = ref && json.textures?.[ref.index];
  if (!tex) return null;
  const ext = tex.extensions || {};
  const image = tex.source ?? ext.EXT_texture_webp?.source ?? ext.EXT_texture_avif?.source;
  if (image !== undefined) return { image };
  if (ext.KHR_texture_basisu?.source !== undefined) return { image: ext.KHR_texture_basisu.source, ktx2: true };
  return null;
}

/** glTF colours are linear; the panel's are the usual (sRGB) hex. */
const hexOf = (rgb = [0, 0, 0]) => `#${new THREE.Color().setRGB(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0,
  THREE.LinearSRGBColorSpace).getHexString()}`;

/** Tiling, wrapping and filtering from a texture reference (its sampler, KHR_texture_transform). */
function placementOf(json, ref) {
  const uv = { repeat: [1, 1], offset: [0, 0], rotation: 0, wrap: 'repeat', filter: 'smooth', worldScale: false, tileSize: 1 };
  if (!ref) return uv;
  const tex = json.textures?.[ref.index];
  const sampler = tex?.sampler !== undefined ? json.samplers?.[tex.sampler] : null;
  if (sampler) {
    uv.wrap = WRAP[sampler.wrapS] || 'repeat';
    if (sampler.magFilter === NEAREST) uv.filter = 'pixel';
  }
  const t = ref.extensions?.KHR_texture_transform;
  // A tiny scale is not tiling: it unpacks a compressed model's UVs (KHR_mesh_quantization)
  // and only means something on that model's own mesh — on a box it would show one pixel.
  if (t && !(Array.isArray(t.scale) && Math.min(Math.abs(t.scale[0]), Math.abs(t.scale[1])) < 0.01)) {
    if (Array.isArray(t.scale)) uv.repeat = [t.scale[0], t.scale[1]];
    // glTF measures v from the top of the picture; the panel from the bottom
    if (Array.isArray(t.offset)) uv.offset = [t.offset[0], -t.offset[1]];
    if (t.rotation) uv.rotation = -THREE.MathUtils.radToDeg(t.rotation);
  }
  return uv;
}

/**
 * Every material in the file, described for the panel: its settings in the
 * panel's terms and, per slot, which of the file's images goes there.
 */
export function describeMaterials(gltf) {
  const { json } = gltf;
  return (json.materials || []).map((def, index) => {
    const pbr = def.pbrMetallicRoughness || {};
    const sg = def.extensions?.KHR_materials_pbrSpecularGlossiness; // older files
    const notes = [];
    const maps = {};
    const put = (slot, ref) => {
      const found = textureImage(json, ref);
      if (found) maps[slot] = found;
    };
    const colorRef = sg ? sg.diffuseTexture : pbr.baseColorTexture;
    put('map', colorRef);
    // glTF keeps roughness (green) and metalness (blue) in one picture; with the AO
    // (red) in it too that is one "ORM" picture — otherwise the same picture in both slots
    const mr = pbr.metallicRoughnessTexture;
    const occ = def.occlusionTexture;
    const mrImage = textureImage(json, mr)?.image;
    if (mr && occ && mrImage !== undefined && mrImage === textureImage(json, occ)?.image) {
      put('orm', mr);
    } else {
      put('roughnessMap', mr);
      put('metalnessMap', mr);
      put('aoMap', occ);
    }
    put('normalMap', def.normalTexture);
    put('emissiveMap', def.emissiveTexture);
    if (sg) notes.push('an older "specular-glossiness" material: its colour and gloss are used, its specular picture is not');
    if (def.extensions?.KHR_materials_unlit) notes.push('"unlit" in the file: here it is lit like everything else');
    if (def.extensions?.KHR_materials_transmission) notes.push('glass-like transmission is shown as plain see-through');

    const alphaMode = def.alphaMode === 'MASK' ? 'cutout' : def.alphaMode === 'BLEND' ? 'blend' : 'auto';
    const base = sg ? (sg.diffuseFactor || [1, 1, 1, 1]) : (pbr.baseColorFactor || [1, 1, 1, 1]);
    const settings = {
      color: hexOf(base),
      // an opaque material ignores its alpha, in glTF as here
      opacity: alphaMode === 'auto' ? 1 : (base[3] ?? 1),
      metalness: sg ? 0 : (pbr.metallicFactor ?? 1),
      roughness: sg ? 1 - (sg.glossinessFactor ?? 1) : (pbr.roughnessFactor ?? 1),
      emissive: hexOf(def.emissiveFactor),
      emissiveIntensity: def.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1,
      normalStrength: def.normalTexture?.scale ?? 1,
      flipGreen: false, // glTF normal maps are OpenGL style
      aoIntensity: occ?.strength ?? 1,
      alphaMode,
      alphaCutoff: def.alphaCutoff ?? 0.5,
      wireframe: false,
      uv: placementOf(json, colorRef || def.normalTexture || mr || occ || def.emissiveTexture),
    };
    const textures = Object.keys(maps).length;
    return { index, name: def.name || `Material ${index + 1}`, settings, maps, notes, textures };
  });
}

/**
 * Read a picked or dropped model — a .glb, or a .gltf with its pictures —
 * for its materials. `files`: File objects or { file, path } (a folder keeps
 * its layout). `prefer`: which model, when a folder holds several. Resolves
 * to { name, gltf, materials } or null when there is no model among them.
 * A .gltf's pictures are read from the files beside it; its .bin is not
 * needed (it holds the shapes). Missing pictures throw an error with
 * `missing` and `needsFolder` (see missingFiles).
 */
export async function readModelMaterials(files, { prefer = null } = {}) {
  const entries = [...files].map((f) => (f?.file ? f : { file: f, path: f.webkitRelativePath || f.name }));
  const model = (prefer && entries.find((e) => e.file.name === prefer)) || entries.find((e) => isModelFile(e.file.name));
  if (!model) return null;
  let gltf;
  if (/\.gltf$/i.test(model.file.name)) {
    let json;
    try { json = JSON.parse(await model.file.text()); } catch { json = null; }
    if (!json?.asset) throw new Error('It is not a .glb or .gltf model, or the file is damaged.');
    gltf = { json, bin: null, files: await gltfPictures(json, model, entries) };
  } else {
    gltf = readGlb(new Uint8Array(await model.file.arrayBuffer()));
  }
  if (!gltf) throw new Error('It is not a .glb or .gltf model, or the file is damaged.');
  return { name: model.file.name, gltf, materials: describeMaterials(gltf) };
}

/** Every picture a .gltf's materials use, from the files given with it: image index -> bytes. */
async function gltfPictures(json, model, entries) {
  const base = dirOf(model.path);
  const used = new Set();
  const note = (ref) => {
    const tex = ref && json.textures?.[ref.index];
    if (!tex) return;
    const ext = tex.extensions || {};
    for (const src of [tex.source, ext.EXT_texture_webp?.source, ext.EXT_texture_avif?.source, ext.KHR_texture_basisu?.source]) {
      if (src !== undefined) { used.add(src); return; } // the first it would use
    }
  };
  for (const m of json.materials || []) {
    const pbr = m.pbrMetallicRoughness || {};
    const sg = m.extensions?.KHR_materials_pbrSpecularGlossiness;
    [pbr.baseColorTexture, pbr.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture, m.emissiveTexture,
      sg?.diffuseTexture].forEach(note);
  }
  const out = new Map();
  const missing = [];
  const read = async (uri) => {
    if (/^data:/i.test(uri)) return dataUriBytes(uri);
    const found = findFile(entries, base, uri);
    if (!found) { missing.push(decodeUri(uri)); return null; }
    return new Uint8Array(await found.file.arrayBuffer());
  };
  for (const i of used) {
    const img = json.images?.[i];
    if (!img) continue;
    if (img.uri !== undefined) {
      const bytes = await read(img.uri);
      if (bytes) out.set(i, bytes);
      if (bytes && !img.name && !/^data:/i.test(img.uri)) img.name = baseName(decodeUri(img.uri)).replace(/\.[a-z0-9]+$/i, '');
    } else if (img.bufferView !== undefined) {
      // a picture inside a buffer: that buffer's file is needed after all
      const view = json.bufferViews?.[img.bufferView];
      const buffer = view && json.buffers?.[view.buffer ?? 0];
      if (!buffer?.uri) continue;
      const bytes = await read(buffer.uri);
      if (bytes) out.set(i, bytes.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength));
    }
  }
  if (missing.length) throw missingFiles(model.file.name, missing);
  return out;
}

/**
 * The panel's description of material `index` of a read model, its pictures
 * stored through `importImage({ bytes, type, name }) -> map source` (each
 * picture once, however many slots use it). Every slot is set — to the
 * model's picture or to none — so the surface becomes that material, not a
 * mix with what was there. `decodeKtx2(data) -> data` turns a KTX2 picture
 * into one importImage can take (without it, those are skipped). `lines`
 * says what went where.
 */
export async function modelMaterialSpec(model, index, { importImage, decodeKtx2 = null }) {
  const mat = model.materials[index];
  const stored = new Map(); // image index -> promise of its map source
  const maps = {};
  const lines = [];
  for (const slot of Object.keys(TEXTURE_SLOTS)) {
    const ref = mat.maps[slot];
    maps[slot] = null;
    if (!ref) continue;
    const label = TEXTURE_SLOTS[slot].label;
    const data = imageData(model.gltf, ref.image, `${mat.name} ${label}`);
    if (!data) {
      lines.push(`${label} → skipped: its picture is not inside the file`);
      continue;
    }
    const ktx2 = data.type === 'image/ktx2';
    if (ktx2 && !decodeKtx2) {
      lines.push(`${label} → skipped: its picture is KTX2-compressed, which can't be read here`);
      continue;
    }
    if (!stored.has(ref.image)) stored.set(ref.image, (ktx2 ? decodeKtx2(data) : Promise.resolve(data)).then(importImage));
    try {
      maps[slot] = await stored.get(ref.image);
      lines.push(`${label} ← ${data.name}${ktx2 ? ' (KTX2, turned into PNG)' : ''}`);
    } catch (err) {
      lines.push(`${label} → failed: ${err.message}`);
    }
  }
  for (const note of mat.notes) lines.push(`Note: ${note}`);
  return { spec: normalizeSpec({ ...mat.settings, maps }), lines };
}

/** Just one slot's picture of material `index` ({ data } or { why } it has none). */
export function modelSlotImage(model, index, slot) {
  const mat = model.materials[index];
  // a packed ORM picture answers for roughness, metalness and AO too (each reads its own channel)
  const ref = mat.maps[slot] ?? (['roughnessMap', 'metalnessMap', 'aoMap'].includes(slot) ? mat.maps.orm : null);
  const label = TEXTURE_SLOTS[slot].label;
  if (!ref) return { why: `"${mat.name}" has no ${label.toLowerCase()} picture` };
  const data = imageData(model.gltf, ref.image, `${mat.name} ${label}`);
  if (!data) return { why: `its ${label.toLowerCase()} picture is not inside the file` };
  return { data }; // a KTX2 one (data.type 'image/ktx2') still needs ktx2ToPng
}

// ---------------------------------------------------------------- KTX2 pictures

let _ktx2 = null; // { renderer, loader }: made the first time a model has KTX2 pictures

/**
 * A KTX2 / Basis picture ({ bytes, type, name }) as a PNG one. Transcoded to a
 * format this GPU shows, drawn once into an offscreen target, read back — the
 * stored values exactly (no colour conversion on the way in or out), top row
 * first like the file. Needs the editor's renderer.
 */
export async function ktx2ToPng(data, renderer, maxSize = 4096) {
  if (!renderer) throw new Error('KTX2 pictures need the 3D view to be turned into PNGs');
  if (_ktx2?.renderer !== renderer) {
    _ktx2 = { renderer, loader: new KTX2Loader().setTranscoderPath(DECODERS.basis.dir).detectSupport(renderer) };
  }
  const texture = await _ktx2.loader._createTexture(data.bytes.slice().buffer);
  try {
    const bytes = await textureToPng(renderer, texture, maxSize);
    return { bytes, type: 'image/png', name: data.name.replace(/\.ktx2$/i, '.png') };
  } finally {
    texture.dispose();
  }
}

/** Draw a texture as it is stored into an RGBA image; resolves to PNG bytes. */
export async function textureToPng(renderer, texture, maxSize = 4096) {
  const w0 = texture.image?.width || 1;
  const h0 = texture.image?.height || 1;
  const k = Math.min(1, maxSize / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k));
  const h = Math.max(1, Math.round(h0 * k));
  // what is stored, not what it means: no sRGB decode here, none on the way out
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  const target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: texture } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv); }',
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  const scene = new THREE.Scene();
  scene.add(quad);
  const before = renderer.getRenderTarget();
  const pixels = new Uint8Array(w * h * 4);
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, new THREE.Camera());
    renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
  } finally {
    renderer.setRenderTarget(before);
    target.dispose();
    material.dispose();
    quad.geometry.dispose();
  }
  // The GPU reads back bottom row first, and the texture's first row (the picture's
  // top, uploaded unflipped) sits at the bottom of the quad: already top row first.
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), w, h), 0, 0);
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
