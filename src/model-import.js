import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { baseName } from './gltf-files.js';

/**
 * Other model formats, made into .glb on import — so everything after (the
 * store, saving, copies, physics, exported games) knows one kind of model.
 *
 *   .obj   with its .mtl and textures, if dropped or picked with it
 *   .fbx   its meshes, skeleton and animations, and its textures (in the file, or beside it)
 *   .stl   a single shape (3D printing, CAD)
 *
 * Their materials (an older kind: shiny / matt) become the engine's standard
 * ones — colour, texture, bumps, glow, see-through kept. In the editor only:
 * an exported game only ever reads the .glb this makes.
 */

export const CONVERTIBLE = ['obj', 'fbx', 'stl'];
/** File types the picker offers alongside a model: what it may name. */
export const MODEL_COMPANIONS = ['.mtl', '.bin', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.ktx2'];

/**
 * A loading manager that finds the files a model names among those given with
 * it (by name, wherever they were in a folder), and says when they are all in.
 */
function managerFor(entries) {
  const byName = new Map();
  for (const e of entries) byName.set(baseName(e.path || e.file.name).toLowerCase(), e.file);
  const urls = [];
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(blob:|data:)/.test(url)) return url;
    const file = byName.get(baseName(decodeURIComponent(url)).toLowerCase());
    if (!file) return url; // not given: it fails, and the model comes without it
    const u = URL.createObjectURL(file);
    urls.push(u);
    return u;
  });
  let pending = 0;
  let waiting = null;
  const start = manager.itemStart.bind(manager);
  const end = manager.itemEnd.bind(manager);
  manager.itemStart = (u) => { pending++; start(u); };
  manager.itemEnd = (u) => {
    pending--;
    end(u);
    if (pending <= 0 && waiting) { waiting(); waiting = null; }
  };
  const missing = [];
  const error = manager.itemError.bind(manager);
  manager.itemError = (u) => { missing.push(baseName(decodeURIComponent(u))); error(u); };
  return {
    manager,
    missing,
    /** Every texture it asked for: in, or failed. */
    settled: () => new Promise((resolve) => {
      // (a loader may start one a moment after parsing)
      setTimeout(() => { if (pending <= 0) resolve(); else waiting = resolve; }, 0);
    }),
    release: () => { for (const u of urls) URL.revokeObjectURL(u); },
  };
}

/** An older material (Phong, Lambert) as a standard one, its look kept. */
export function toStandard(m) {
  if (!m || m.isMeshStandardMaterial || m.isMeshBasicMaterial) return m;
  const out = new THREE.MeshStandardMaterial({
    name: m.name,
    color: m.color ?? 0xffffff,
    map: m.map ?? null,
    normalMap: m.normalMap ?? null,
    emissive: m.emissive ?? 0x000000,
    emissiveMap: m.emissiveMap ?? null,
    alphaMap: m.alphaMap ?? null,
    aoMap: m.aoMap ?? null,
    transparent: !!m.transparent,
    opacity: m.opacity ?? 1,
    side: m.side ?? THREE.FrontSide,
    vertexColors: !!m.vertexColors,
    // shiny → smooth; Phong's shininess runs 0…1000
    roughness: m.shininess !== undefined ? Math.max(0.15, 1 - Math.min(1, Math.sqrt(m.shininess / 100))) : 0.85,
    metalness: 0,
  });
  if (m.bumpMap && !m.normalMap) { out.bumpMap = m.bumpMap; out.bumpScale = m.bumpScale ?? 1; }
  if (out.map) out.map.colorSpace = THREE.SRGBColorSpace;
  if (out.emissiveMap) out.emissiveMap.colorSpace = THREE.SRGBColorSpace;
  return out;
}

function standardise(root) {
  root.traverse((n) => {
    if (!n.isMesh) return;
    n.material = Array.isArray(n.material) ? n.material.map(toStandard) : toStandard(n.material);
    n.castShadow = n.receiveShadow = true;
  });
  return root;
}

/** The model in `entry` (and the files with it) as an object, ready to write. Resolves to { root, missing }. */
export async function readOtherModel(entry, entries) {
  const ext = entry.file.name.split('.').pop().toLowerCase();
  const files = managerFor(entries);
  try {
    let root;
    if (ext === 'obj') {
      const text = await entry.file.text();
      const loader = new OBJLoader(files.manager);
      // its materials file: named in it (mtllib), or any .mtl given with it
      const named = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
      const mtl = entries.find((e) => named && baseName(e.path || e.file.name).toLowerCase() === baseName(named).toLowerCase())
        ?? entries.find((e) => /\.mtl$/i.test(e.file.name));
      if (mtl) {
        const materials = new MTLLoader(files.manager).parse(await mtl.file.text(), '');
        materials.preload();
        loader.setMaterials(materials);
      }
      root = loader.parse(text);
    } else if (ext === 'fbx') {
      root = new FBXLoader(files.manager).parse(await entry.file.arrayBuffer(), '');
    } else if (ext === 'stl') {
      const geometry = new STLLoader(files.manager).parse(await entry.file.arrayBuffer());
      geometry.computeVertexNormals();
      const colored = !!geometry.attributes.color;
      root = new THREE.Group();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: colored ? 0xffffff : 0xb8bcc4, vertexColors: colored, roughness: 0.6 }));
      mesh.name = entry.file.name.replace(/\.stl$/i, '');
      root.add(mesh);
    } else {
      throw new Error(`.${ext} is not a model this can read`);
    }
    await files.settled();
    root.name ||= entry.file.name.replace(/\.[^.]+$/, '');
    return { root: standardise(root), missing: files.missing };
  } finally {
    // (textures already read keep their pictures; the URLs to the dropped files can go)
    setTimeout(files.release, 0);
  }
}

/** An object (and its animations) written as .glb bytes. */
export async function writeModel(root, animations = root.animations || []) {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true, animations, onlyVisible: false });
  return new Uint8Array(result);
}

/**
 * A model in another format as a .glb File, named as it was. `entries` are
 * every file given with it ({ file, path }). Throws if it can't be read;
 * textures it names but that weren't given are listed in `file.missing`.
 */
export async function convertModel(entry, entries) {
  const { root, missing } = await readOtherModel(entry, entries);
  // (an .fbx often carries an empty take beside its real one)
  const clips = (root.animations || []).filter((c) => c.duration > 0 && c.tracks.length);
  const bytes = await writeModel(root, clips);
  const file = new File([bytes], `${entry.file.name.replace(/\.[^.]+$/, '')}.glb`, { type: 'model/gltf-binary' });
  file.missing = missing;
  return file;
}
