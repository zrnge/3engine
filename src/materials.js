import * as THREE from 'three';
import { loadStoredTexture } from './factories.js';
import { makeProceduralTexture, normalizeTexParams, PATTERNS } from './texgen.js';
import { assetStore } from './assets-db.js';

/**
 * Materials — the PBR surface of an object, as one plain description that the
 * panel edits, the scene saves, copy/paste and prefabs carry, and undo snapshots:
 *
 *   { color, metalness, roughness, opacity, wireframe,
 *     emissive, emissiveIntensity, normalStrength, flipGreen, aoIntensity,
 *     alphaMode: 'auto' | 'cutout' | 'blend', alphaCutoff,
 *     uv: { repeat: [x, y], offset: [x, y], rotation, wrap, filter, worldScale, tileSize },
 *     maps: { map, normalMap, roughnessMap, metalnessMap, aoMap, orm, emissiveMap, alphaMap },
 *     baseColor?, library? }
 *
 * A map is `{ assetId, name, size?, resizedFrom? }` (an image in the asset store),
 * `{ procedural: {...}, output?, name }` (the texture maker), `null` (empty), or
 * absent — which leaves whatever the material already has, so a model's own
 * textures survive having only its colour edited.
 *
 * This follows the glTF 2.0 metallic-roughness model that Three.js, Unity,
 * Unreal and Godot share: colour and glow are sRGB, everything else is linear
 * data; "ORM" packs AO / roughness / metalness into R / G / B of one image.
 */

export const TEXTURE_SLOTS = {
  map: { label: 'Base colour', srgb: true, hint: 'The surface colour (albedo), with no lighting baked in.' },
  normalMap: { label: 'Normal', hint: 'Fake bumps and dents that catch the light.' },
  roughnessMap: { label: 'Roughness', hint: 'Bright = matte, dark = shiny.' },
  metalnessMap: { label: 'Metalness', hint: 'White = metal, black = not.' },
  aoMap: { label: 'Ambient occl.', hint: 'Ambient occlusion: darkens cracks and crevices.' },
  orm: { label: 'Packed ORM', hint: 'One image: red = AO, green = roughness, blue = metalness (glTF "ORM", Poly Haven "ARM").' },
  emissiveMap: { label: 'Glow', srgb: true, hint: 'Where the surface glows (emissive). Colour and strength are under Surface.' },
  alphaMap: { label: 'Opacity mask', hint: 'White = solid, black = see-through. Set Transparency to Cutout or Blend.' },
};

/** The slots Three.js actually has (ORM fills three of them). */
export const REAL_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap'];
const ORM_SLOTS = ['aoMap', 'roughnessMap', 'metalnessMap'];

export const WRAPS = {
  repeat: THREE.RepeatWrapping,
  mirror: THREE.MirroredRepeatWrapping,
  clamp: THREE.ClampToEdgeWrapping,
};
export const FILTERS = ['smooth', 'pixel'];
export const ALPHA_MODES = ['auto', 'cutout', 'blend'];

export const UV_DEFAULTS = {
  repeat: [1, 1], offset: [0, 0], rotation: 0,
  wrap: 'repeat', filter: 'smooth', worldScale: false, tileSize: 1,
};

const DEG = Math.PI / 180;
let maxAnisotropy = 1;

/** The renderer's best anisotropic filtering — keeps floors sharp at grazing angles. */
export function setMaxAnisotropy(n) { maxAnisotropy = Math.max(1, Number(n) || 1); }

// ---------------------------------------------------------------- the description

const num = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const hex = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  try { return '#' + new THREE.Color(v).getHexString(); } catch (_) { return d; }
};
const round = (x) => Math.round(x * 10000) / 10000;

function normalizeSource(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.procedural) {
    const out = { procedural: normalizeTexParams(s.procedural), name: String(s.name || 'made') };
    if (s.output === 'normal') out.output = 'normal';
    return out;
  }
  if (s.assetId) {
    const out = { assetId: String(s.assetId), name: String(s.name || s.assetId) };
    if (Array.isArray(s.size)) out.size = s.size.slice(0, 2).map(Number);
    if (Array.isArray(s.resizedFrom)) out.resizedFrom = s.resizedFrom.slice(0, 2).map(Number);
    return out;
  }
  return null;
}

/** Fill in defaults, clamp, and accept the older `{ color, map }` form. */
export function normalizeSpec(raw = {}) {
  const r = raw || {};
  const u = r.uv || {};
  const pair = (a, lo, hi, d) => (Array.isArray(a) && a.length >= 2
    ? [num(a[0], lo, hi, d[0]), num(a[1], lo, hi, d[1])]
    : [...d]);
  const maps = {};
  const rawMaps = { ...(r.map !== undefined ? { map: r.map } : {}), ...(r.maps || {}) };
  for (const slot of Object.keys(TEXTURE_SLOTS)) {
    if (slot in rawMaps && rawMaps[slot] !== undefined) maps[slot] = normalizeSource(rawMaps[slot]);
  }
  const spec = {
    color: hex(r.color, '#ffffff'),
    metalness: num(r.metalness, 0, 1, 0),
    roughness: num(r.roughness, 0, 1, 1),
    opacity: num(r.opacity, 0, 1, 1),
    wireframe: !!r.wireframe,
    emissive: hex(r.emissive, '#000000'),
    emissiveIntensity: num(r.emissiveIntensity, 0, 20, 1),
    normalStrength: num(r.normalStrength, 0, 5, 1),
    flipGreen: !!r.flipGreen,
    aoIntensity: num(r.aoIntensity, 0, 3, 1),
    alphaMode: ALPHA_MODES.includes(r.alphaMode) ? r.alphaMode : 'auto',
    alphaCutoff: num(r.alphaCutoff, 0.01, 0.99, 0.5),
    uv: {
      repeat: pair(u.repeat, 0.01, 1000, UV_DEFAULTS.repeat),
      offset: pair(u.offset, -1000, 1000, UV_DEFAULTS.offset),
      rotation: num(u.rotation, -360, 360, 0),
      wrap: WRAPS[u.wrap] !== undefined ? u.wrap : 'repeat',
      filter: FILTERS.includes(u.filter) ? u.filter : 'smooth',
      worldScale: !!u.worldScale,
      tileSize: num(u.tileSize, 0.05, 100, 1),
    },
    maps,
  };
  if (r.baseColor) spec.baseColor = hex(r.baseColor, undefined);
  if (r.library) spec.library = String(r.library);
  return spec;
}

function sourceOf(tex) {
  if (tex.userData.source) return tex.userData.source;
  if (tex.userData.assetId) return { assetId: tex.userData.assetId, name: tex.name || tex.userData.assetId };
  return null;
}

/** Read a material back into its description. */
export function materialSpec(m) {
  const t3 = m.userData.t3 || {};
  const uv = { ...UV_DEFAULTS, ...(t3.uv || {}) };
  const maps = {};
  let orm = null;
  for (const slot of REAL_SLOTS) {
    const tex = m[slot];
    if (!tex) { maps[slot] = null; continue; }
    const src = sourceOf(tex);
    if (!src) continue; // came with a model: leave it alone
    if (src.orm) {
      const { orm: _flag, ...rest } = src;
      orm = rest;
      maps[slot] = null;
      continue;
    }
    maps[slot] = { ...src };
  }
  maps.orm = orm;

  // a model's own settings, until someone edits it here
  const alphaMode = t3.alphaMode
    ?? (m.alphaTest > 0 ? 'cutout' : (m.transparent && m.opacity >= 1 ? 'blend' : 'auto'));
  const spec = {
    color: '#' + m.color.getHexString(),
    metalness: round(m.metalness),
    roughness: round(m.roughness),
    opacity: round(m.opacity),
    wireframe: !!m.wireframe,
    emissive: '#' + m.emissive.getHexString(),
    emissiveIntensity: round(m.emissiveIntensity),
    normalStrength: round(t3.normalStrength ?? Math.abs(m.normalScale?.x ?? 1)),
    flipGreen: !!t3.flipGreen,
    aoIntensity: round(m.aoMapIntensity ?? 1),
    alphaMode,
    alphaCutoff: round(t3.alphaCutoff ?? (m.alphaTest > 0 ? m.alphaTest : 0.5)),
    uv: {
      repeat: [round(uv.repeat[0]), round(uv.repeat[1])],
      offset: [round(uv.offset[0]), round(uv.offset[1])],
      rotation: round(uv.rotation),
      wrap: uv.wrap,
      filter: uv.filter,
      worldScale: !!uv.worldScale,
      tileSize: round(uv.tileSize),
    },
    maps,
  };
  if (m.userData.baseColor !== undefined) spec.baseColor = '#' + new THREE.Color(m.userData.baseColor).getHexString();
  if (t3.library) spec.library = t3.library;
  return spec;
}

// ---------------------------------------------------------------- applying

const _ready = new WeakMap();  // material -> promise of its textures
const _wanted = new WeakMap(); // material -> { slot: source key } — drops stale loads

/** Resolves once every texture the material was last given has loaded. */
export const materialReady = (m) => _ready.get(m) ?? Promise.resolve(m);

function decorate(tex, src, key, srgb) {
  tex.name = src.name;
  tex.userData.source = src;
  tex.userData.sourceKey = key;
  if (src.assetId) tex.userData.assetId = src.assetId;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.userData.samplerKey = null; // let applyTextureSettings configure it
  tex.needsUpdate = true;
  return tex;
}

function setSlot(m, slot, src, made) {
  let wanted = _wanted.get(m);
  if (!wanted) _wanted.set(m, (wanted = {}));
  if (!src) {
    wanted[slot] = null;
    if (m[slot]) { m[slot] = null; m.needsUpdate = true; }
    return null;
  }
  const key = JSON.stringify(src);
  wanted[slot] = key;
  if (m[slot]?.userData?.sourceKey === key) return null; // already showing it
  const srgb = !!TEXTURE_SLOTS[slot].srgb;

  if (src.procedural) {
    let tex = made.get(key);
    if (!tex) {
      tex = decorate(makeProceduralTexture(src.procedural, src.output || (slot === 'normalMap' ? 'normal' : 'color')), src, key, srgb);
      made.set(key, tex);
    }
    m[slot] = tex;
    m.needsUpdate = true;
    return null;
  }

  let job = made.get(key);
  if (!job) {
    job = loadStoredTexture({ assetId: src.assetId, name: src.name })
      .then((tex) => (tex ? decorate(tex, src, key, srgb) : null));
    made.set(key, job);
  }
  return job.then((tex) => {
    if (!tex || wanted[slot] !== key) return; // replaced while it was loading
    m[slot] = tex;
    m.needsUpdate = true;
  }).catch((err) => console.warn('[Tiny3] could not load texture:', src.name, err));
}

const isDefaultUV = (uv) => uv.repeat[0] === 1 && uv.repeat[1] === 1 && uv.offset[0] === 0
  && uv.offset[1] === 0 && uv.rotation === 0 && uv.wrap === 'repeat' && uv.filter === 'smooth';

/** Placement, wrapping and filtering for every texture on the material, plus the scalar extras. */
export function applyTextureSettings(m) {
  const t3 = m.userData.t3 || {};
  const uv = { ...UV_DEFAULTS, ...(t3.uv || {}) };
  if (uv.worldScale) worldUVsUsed = true; // updateWorldUVs has work to do from now on
  const pixel = uv.filter === 'pixel';
  const samplerKey = `${uv.wrap}|${uv.filter}|${maxAnisotropy}`;
  const seen = new Set();
  for (const slot of REAL_SLOTS) {
    const tex = m[slot];
    if (!tex || seen.has(tex)) continue;
    seen.add(tex);
    // a model's own textures keep their own placement unless it is changed here
    if (!tex.userData.source && !tex.userData.assetId && isDefaultUV(uv)) continue;
    tex.repeat.set(uv.repeat[0], uv.repeat[1]);
    tex.offset.set(uv.offset[0], uv.offset[1]);
    tex.center.set(0.5, 0.5);
    tex.rotation = uv.rotation * DEG;
    if (tex.userData.samplerKey !== samplerKey) {
      tex.wrapS = tex.wrapT = WRAPS[uv.wrap] ?? THREE.RepeatWrapping;
      tex.magFilter = pixel ? THREE.NearestFilter : THREE.LinearFilter;
      tex.minFilter = pixel ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
      tex.anisotropy = pixel ? 1 : maxAnisotropy;
      tex.userData.samplerKey = samplerKey;
      tex.needsUpdate = true; // wrap and filters only take effect on re-upload
    }
  }

  const strength = t3.normalStrength ?? 1;
  m.normalScale.set(strength, t3.flipGreen ? -strength : strength);

  const mode = t3.alphaMode || 'auto';
  const transparent = mode === 'blend' || (mode === 'auto' && m.opacity < 1);
  const alphaTest = mode === 'cutout' ? (t3.alphaCutoff ?? 0.5) : 0;
  if (m.transparent !== transparent || m.alphaTest !== alphaTest) {
    m.transparent = transparent;
    m.alphaTest = alphaTest;
    m.needsUpdate = true;
  }
}

/**
 * Make a material match a description. Settings apply at once; images load
 * in the background (see materialReady). Textures already showing the same
 * source are kept, so dragging a slider never reloads anything.
 */
export function applyMaterialSpec(m, raw) {
  const spec = normalizeSpec(raw);
  m.color.set(spec.color);
  m.metalness = spec.metalness;
  m.roughness = spec.roughness;
  m.opacity = spec.opacity;
  m.wireframe = spec.wireframe;
  m.emissive.set(spec.emissive);
  m.emissiveIntensity = spec.emissiveIntensity;
  m.aoMapIntensity = spec.aoIntensity;
  if (spec.baseColor) m.userData.baseColor = new THREE.Color(spec.baseColor).getHex();
  else delete m.userData.baseColor;
  m.userData.t3 = {
    uv: { ...spec.uv, repeat: [...spec.uv.repeat], offset: [...spec.uv.offset] },
    alphaMode: spec.alphaMode,
    alphaCutoff: spec.alphaCutoff,
    normalStrength: spec.normalStrength,
    flipGreen: spec.flipGreen,
    ...(spec.library ? { library: spec.library } : {}),
  };

  const made = new Map(); // one texture per source, so ORM's three slots share it
  const jobs = [];
  for (const slot of REAL_SLOTS) {
    let src = spec.maps[slot];
    if (ORM_SLOTS.includes(slot) && !src && spec.maps.orm) src = { ...spec.maps.orm, orm: true };
    if (src === undefined) continue; // not mentioned: leave it
    const job = setSlot(m, slot, src, made);
    if (job) jobs.push(job);
  }
  applyTextureSettings(m);

  const ready = Promise.all(jobs).then(() => { applyTextureSettings(m); return m; });
  _ready.set(m, ready);
  return ready;
}

/**
 * A new material from a description — or, when it names a library material
 * that already exists, that shared one (and a new one joins the library).
 */
export function createMaterial(raw, { library = null } = {}) {
  const spec = normalizeSpec(raw);
  if (spec.library && library?.has(spec.library)) return library.get(spec.library);
  const m = new THREE.MeshStandardMaterial();
  applyMaterialSpec(m, spec);
  if (spec.library && library) library.set(spec.library, m);
  return m;
}

/** Give an existing mesh (a model's) a saved description, or its shared library material. */
export async function adoptMaterial(mesh, raw, library = null) {
  if (!mesh?.material?.isMeshStandardMaterial) return;
  const spec = normalizeSpec(raw);
  if (spec.library && library?.has(spec.library)) {
    mesh.material = library.get(spec.library);
    return;
  }
  await applyMaterialSpec(mesh.material, spec);
  if (spec.library && library) library.set(spec.library, mesh.material);
}

/**
 * An independent copy — "Make unique". Material.clone() would keep the very
 * same texture objects, so changing the copy's tiling would move the original's
 * textures too. Each texture is cloned (the decoded image is still shared).
 */
export function cloneMaterial(m) {
  const copy = m.clone();
  const clones = new Map(); // ORM's three slots share one texture; keep that
  for (const slot of REAL_SLOTS) {
    const tex = m[slot];
    if (!tex) continue;
    if (!clones.has(tex)) {
      const t = tex.clone();
      t.needsUpdate = true;
      clones.set(tex, t);
    }
    copy[slot] = clones.get(tex);
  }
  if (copy.userData.t3) delete copy.userData.t3.library;
  return copy;
}

/** How many meshes in the scene use this very material. */
export function countUsers(root, m) {
  // objects, not meshes: a model whose part is three meshes is still one object
  const users = new Set();
  root?.traverse?.((o) => {
    if (!o.isMesh || o.material !== m) return;
    let owner = o;
    while (!owner.userData.kind && owner.parent && owner.parent !== root) owner = owner.parent;
    users.add(owner);
  });
  return users.size;
}

// ---------------------------------------------------------------- editing helpers

/**
 * Put a texture in a slot (or clear it with null), with the conventions a
 * texture set expects: a first colour texture replaces the colour (which is
 * remembered and comes back on clear); roughness / metalness / ORM maps set
 * their slider to 1 so the image shows as painted; a glow map needs a glow colour.
 */
export function withTexture(spec, slot, src, { directX = false } = {}) {
  const s = normalizeSpec(spec);
  const had = !!s.maps[slot];
  s.maps = { ...s.maps, [slot]: src ? normalizeSource(src) : null };
  if (src) {
    if (slot === 'map' && !had && !s.baseColor) {
      s.baseColor = s.color;
      s.color = '#ffffff';
    }
    if (slot === 'roughnessMap' || slot === 'orm') s.roughness = 1;
    if (slot === 'metalnessMap' || slot === 'orm') s.metalness = 1;
    if (slot === 'emissiveMap' && s.emissive === '#000000') s.emissive = '#ffffff';
    if (slot === 'normalMap' && directX) s.flipGreen = true;
  } else if (slot === 'map' && s.baseColor) {
    s.color = s.baseColor;
    delete s.baseColor;
  }
  return s;
}

/** The texture maker's result: a colour texture and, if it has bumps, its normal map. */
export function withMadeTexture(spec, rawParams) {
  const params = normalizeTexParams(rawParams);
  const label = PATTERNS[params.pattern].label;
  const s = withTexture(spec, 'map', { procedural: params, name: label });
  return withTexture(s, 'normalMap',
    params.bump > 0 ? { procedural: params, output: 'normal', name: `${label} bumps` } : null);
}

const SLOT_WORDS = [
  ['orm', ['orm', 'arm']],
  ['normalMap', ['normal', 'normals', 'normalgl', 'normaldx', 'nrm', 'nor', 'norm', 'nmap']],
  ['roughnessMap', ['roughness', 'rough', 'rgh']],
  ['metalnessMap', ['metalness', 'metallic', 'metal', 'mtl']],
  ['aoMap', ['ao', 'ambientocclusion', 'occlusion', 'occ']],
  ['emissiveMap', ['emissive', 'emission', 'emit', 'glow']],
  ['alphaMap', ['opacity', 'alpha', 'mask', 'transparency']],
  ['height', ['height', 'displacement', 'disp', 'bump']],
  ['map', ['basecolor', 'basecolour', 'albedo', 'diffuse', 'diff', 'color', 'colour', 'col', 'base']],
];
/** Single-letter suffixes (T_Crate_N.png) only count as the last word. */
const SUFFIX_LETTERS = { n: 'normalMap', r: 'roughnessMap', m: 'metalnessMap', e: 'emissiveMap', d: 'map', a: 'map', h: 'height' };

/**
 * Which slot an image belongs in, from its file name, the way texture sites
 * name them (Poly Haven `_nor_gl`, ambientCG `_NormalGL`, Unreal `T_X_N`).
 * Reads from the end, where the type usually is. `slot` is null when unknown,
 * 'height' for height maps (not supported yet).
 */
export function classifyTexture(fileName) {
  const words = String(fileName || '').replace(/\.[a-z0-9]+$/i, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean);
  const directX = words.some((w) => w === 'dx' || w === 'directx' || w === 'normaldx');
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    for (const [slot, list] of SLOT_WORDS) if (list.includes(w)) return { slot, directX };
    if (i === words.length - 1 && SUFFIX_LETTERS[w]) return { slot: SUFFIX_LETTERS[w], directX };
  }
  return { slot: null, directX };
}

/** Nearest power of two per side, capped — what GPUs mipmap best. */
export function potSize(width, height, max = 2048) {
  const pot = (d) => Math.min(max, 2 ** Math.max(0, Math.round(Math.log2(Math.max(1, d)))));
  return [pot(width), pot(height)];
}

/**
 * Store an image as a texture: resized to power-of-two sides no bigger than
 * `maxSize`, so it mipmaps cleanly and a 4K photo doesn't bloat the scene or
 * the exported game. Returns the map source for a slot.
 */
export async function importTextureFile(file, maxSize = 2048) {
  let blob = file;
  let size;
  let resizedFrom;
  try {
    const bitmap = await createImageBitmap(file);
    const [w, h] = [bitmap.width, bitmap.height];
    const [tw, th] = potSize(w, h, maxSize);
    size = [tw, th];
    if (tw !== w || th !== h) {
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(tw, th)
        : Object.assign(document.createElement('canvas'), { width: tw, height: th });
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, tw, th);
      const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      blob = canvas.convertToBlob
        ? await canvas.convertToBlob({ type, quality: 0.92 })
        : await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
      resizedFrom = [w, h];
    }
    bitmap.close?.();
  } catch (err) {
    console.warn('[Tiny3] could not inspect the image, storing it as it is:', file.name, err);
  }
  const stored = blob === file ? file : new File([blob], file.name, { type: blob.type || file.type });
  const meta = await assetStore.put(stored, { kind: 'texture' });
  const src = { assetId: meta.id, name: file.name };
  if (size) src.size = size;
  if (resizedFrom) src.resizedFrom = resizedFrom;
  return src;
}

// ---------------------------------------------------------------- tile by size

const _originalUV = new WeakMap(); // geometry -> its own uv array
const _worldKey = new WeakMap();   // geometry -> scale/tile key it was built for
// set once any material tiles by size (and kept, so turning it off puts the UVs back)
let worldUVsUsed = false;
const _v = new THREE.Vector3();

/**
 * Box-project a mesh's UVs by its real size, so a texture repeats as the object
 * is scaled instead of stretching — the "world-aligned" / triplanar tiling level
 * editors use. Each face takes the two axes it faces across.
 */
export function applyWorldUV(mesh, scale, tileSize = 1) {
  let g = mesh.geometry;
  if (!g?.attributes?.position || !g.attributes.normal) return;
  if (!g.userData.t3OwnGeometry) {
    // never rewrite UVs another mesh might share
    g = g.clone();
    g.userData.t3OwnGeometry = true;
    mesh.geometry = g;
  }
  if (!_originalUV.has(g) && g.attributes.uv) _originalUV.set(g, g.attributes.uv.array.slice());
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  const t = tileSize || 1;
  for (let i = 0; i < pos.count; i++) {
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);
    const x = pos.getX(i) * scale.x;
    const y = pos.getY(i) * scale.y;
    const z = pos.getZ(i) * scale.z;
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    let u;
    let v;
    if (ax >= ay && ax >= az) { u = nx > 0 ? -z : z; v = y; }
    else if (ay >= az) { u = x; v = ny > 0 ? -z : z; }
    else { u = nz > 0 ? x : -x; v = y; }
    uv[i * 2] = u / t;
    uv[i * 2 + 1] = v / t;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Put a mesh's own UVs back. */
export function restoreUV(mesh) {
  const g = mesh.geometry;
  const orig = g && _originalUV.get(g);
  if (orig) g.setAttribute('uv', new THREE.BufferAttribute(orig.slice(), 2));
  if (g) _worldKey.delete(g);
}

/**
 * Per frame: keep tile-by-size UVs in step with each object's scale. Cheap when
 * nothing changed — and nothing at all until some material has used it: it
 * walked every node of the scene every frame, bones included, in games that
 * never tile by size.
 */
export function updateWorldUVs(root) {
  if (!worldUVsUsed) return;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const uv = o.material?.userData?.t3?.uv;
    const want = !!uv?.worldScale;
    const had = _worldKey.has(o.geometry);
    if (!want) {
      if (had) restoreUV(o);
      return;
    }
    o.getWorldScale(_v);
    const key = `${_v.x.toFixed(4)},${_v.y.toFixed(4)},${_v.z.toFixed(4)},${uv.tileSize}`;
    if (_worldKey.get(o.geometry) === key) return;
    applyWorldUV(o, _v, uv.tileSize);
    _worldKey.set(o.geometry, key);
  });
}
