import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { assetStore } from './assets-db.js';
import { retargetClip, uniqueClipName, composeClips } from './animation.js';
import { retargetAcrossRigs, bodyOf } from './rig.js';
import { DECODERS, packGltf } from './gltf-files.js';
import { cloneMaterial } from './materials.js';

/**
 * Rebind animation clips from the original glTF scene to a cloned scene.
 * THREE.clone() creates new UUIDs, but GLTFLoader animation tracks reference
 * the original object UUIDs. This helper maps old UUIDs to the matching cloned
 * nodes by traversal order (which clone preserves) and rewrites track names.
 */
function rebindClips(clips, oldRoot, newRoot) {
  if (!clips || !clips.length) return [];
  const oldNodes = [];
  oldRoot.traverse((o) => oldNodes.push(o));
  const newNodes = [];
  newRoot.traverse((o) => newNodes.push(o));
  const uuidMap = new Map();
  for (let i = 0; i < oldNodes.length && i < newNodes.length; i++) {
    uuidMap.set(oldNodes[i].uuid, newNodes[i]);
  }
  return clips.map((clip) => {
    const newClip = clip.clone();
    for (const track of newClip.tracks) {
      const dot = track.name.indexOf('.');
      const oldUuid = dot === -1 ? track.name : track.name.slice(0, dot);
      const newObj = uuidMap.get(oldUuid);
      if (newObj) {
        track.name = newObj.uuid + track.name.slice(dot);
      }
    }
    return newClip;
  });
}

/** Walk two trees of the same shape side by side. */
function parallelTraverse(a, b, fn) {
  fn(a, b);
  for (let i = 0; i < a.children.length; i++) parallelTraverse(a.children[i], b.children[i], fn);
}

/**
 * Copy a model, skeletons included.
 *
 * Object3D.clone() copies bones, but each copied skinned mesh keeps pointing
 * at the ORIGINAL bones — which are in no scene and never animate. So a rigged
 * character stood frozen however its clips played, and a model like the robot
 * (rigid parts on bones, skinned hands) came apart: the parts moved, the
 * hands stayed behind. Point each copy at its own copied bones (what three.js's
 * SkeletonUtils.clone does).
 */
export function cloneModel(source) {
  const clone = source.clone(true);
  const sourceOf = new Map();
  const cloneOf = new Map();
  parallelTraverse(source, clone, (s, c) => { sourceOf.set(c, s); cloneOf.set(s, c); });
  clone.traverse((node) => {
    if (!node.isSkinnedMesh) return;
    const src = sourceOf.get(node);
    const skeleton = src.skeleton.clone();
    skeleton.bones = src.skeleton.bones.map((bone) => cloneOf.get(bone) ?? bone);
    node.bind(skeleton, src.bindMatrix);
  });
  return clone;
}

/**
 * Why a model could not be read, in words for the person who picked it — and
 * what to do about it. The loader's own messages ("No DRACOLoader instance
 * provided", "Unexpected token") only make sense to a programmer.
 */
export function describeModelError(err) {
  const msg = String(err?.message ?? err ?? '');
  // a decoder's own file could not be fetched: lib/ is missing some of its files
  const decoderFile = Object.values(DECODERS).flatMap((d) => d.files).find((f) => msg.includes(f));
  if (decoderFile) {
    return `Its compression needs ${decoderFile}, which could not be loaded. `
      + 'If the editor is on a web server (GitHub Pages), check that the whole lib folder was uploaded.';
  }
  if (/DRACOLoader/i.test(msg)) {
    return 'It is compressed with Draco, and the Draco decoder is not available here.';
  }
  if (/KTX2/i.test(msg)) {
    return 'Its textures are KTX2 / Basis compressed, and the KTX2 decoder is not available here.';
  }
  if (/Meshopt/i.test(msg)) {
    return 'It is compressed with meshopt, and the meshopt decoder is not available here.';
  }
  const buffer = msg.match(/Failed to load buffer "([^"]*)"/i);
  if (buffer) {
    return `This .gltf keeps its data in another file ("${buffer[1]}"). `
      + 'Pick that file together with it, or drop the whole folder.';
  }
  if (/Unsupported asset|Legacy binary/i.test(msg)) {
    return 'It is an old glTF 1.0 file. Only glTF 2.0 (.glb / .gltf) is supported — open it in Blender and export it again.';
  }
  if (msg === 'NO_SCENE_CLIPS') {
    return 'It holds animations only — nothing to place. To use them, select a model and add this file with '
      + '＋ Clips from other files (Animation panel).';
  }
  if (msg === 'NO_SCENE') return 'There is nothing in it to show: the file has no objects. Export it again with the objects included.';
  if (/JSON|Unexpected token|Unsupported glTF-Binary header/i.test(msg)) {
    return 'It is not a .glb or .gltf model, or the file is damaged.';
  }
  return msg || 'Unknown error.';
}

/**
 * AssetLoader — loads GLB/GLTF models into the scene.
 *
 *   const assets = new AssetLoader();
 *   const duck = await assets.load('./assets/duck.glb', { scale: 0.5, position: [2, 0, 0] });
 *   scene.add(duck);
 *
 * The returned object is a THREE.Group wrapping the model, so it can be
 * positioned / selected / moved like any other object.
 */
export class AssetLoader {
  /**
   * `renderer` lets KTX2 textures pick a format the GPU can use (without it,
   * those models can't be read). `decoderFiles` is for an exported game, which
   * carries the decoders' files inside it: file name -> blob: URL. The editor
   * reads them from lib/ instead.
   */
  constructor({ renderer = null, decoderFiles = null } = {}) {
    const packed = decoderFiles || {};
    this._manager = new THREE.LoadingManager();
    this._manager.setURLModifier((url) => packed[url.split('/').pop()] ?? url);
    this._loader = new GLTFLoader(this._manager);
    // Compressed models: Draco geometry, meshopt buffers and KTX2 / Basis
    // textures. Each decoder's files are fetched the first time a model needs it.
    this._loader.setDRACOLoader(new DRACOLoader(this._manager).setDecoderPath(DECODERS.draco.dir));
    this._loader.setMeshoptDecoder(MeshoptDecoder);
    if (renderer) {
      this._loader.setKTX2Loader(new KTX2Loader(this._manager)
        .setTranscoderPath(DECODERS.basis.dir).detectSupport(renderer));
    }
    // set by the editor (model-import.js, asset-compress.js) — never in an exported game:
    this.convertModel = null; // (entry, entries) => a .glb File, for .obj / .fbx / .stl
    this.convertible = [];    // the extensions it reads
    this.shrinkModel = null;  // (file) => { file, before, after, images }: textures made smaller on import
    this._cache = new Map(); // url -> Promise<gltf>
    this._ready = new Map(); // url -> gltf, once read: copies can then be made inside a frame
  }

  /** The parsed file (cached: the same file is read once however often it is placed). */
  _gltf(url) {
    if (!this._cache.has(url)) {
      const reading = this._loader.loadAsync(url).then((gltf) => {
        this._ready.set(url, gltf);
        return gltf;
      });
      // a failed read is not kept: trying again reads the file again
      reading.catch(() => { if (this._cache.get(url) === reading) this._cache.delete(url); });
      this._cache.set(url, reading);
    }
    return this._cache.get(url);
  }

  /**
   * Read a model's file (and the files its extra clips come from) ahead of
   * time, so loadSync / loadFromStoreSync can copy it later without waiting.
   * `rec` is a saved model: { assetId } or { assetUrl }, and `animationFiles`.
   */
  async preload(rec = {}) {
    const url = rec.assetId ? await assetStore.objectURL(rec.assetId) : rec.assetUrl;
    if (!url) throw new Error(`[Tiny3] asset ${rec.assetId} is not in the asset store`);
    await this._gltf(url);
    for (const file of rec.animationFiles || []) {
      const clipsUrl = await assetStore.objectURL(file.assetId);
      if (clipsUrl) await this._gltf(clipsUrl).catch(() => {}); // a missing clip file is reported when it is used
    }
  }

  /** The animation clips in a stored file, without placing its model. */
  async clipsFromStore(assetId) {
    return (await this._gltfFromStore(assetId)).animations || [];
  }

  async _gltfFromStore(assetId) {
    const url = await assetStore.objectURL(assetId);
    if (!url) throw new Error(`[Tiny3] asset ${assetId} is not in the asset store`);
    return this._gltf(url);
  }

  /**
   * Give a loaded model clips from other files and the parts cut from its
   * clips (see animation.js):
   *   { animationFiles: [{ assetId, name }], clipCuts: [{ from, name, start, end }] }
   * A file with one clip names it after the file ("Walking.glb" → "Walking"):
   * Mixamo names every clip "mixamo.com". A clip for a skeleton named
   * differently (a Mixamo dance for a Blender robot) is carried across by body
   * part (rig.js), once per kind of skeleton. Returns, per file, how many of
   * its clips this model could use, and how many of those were carried across.
   */
  async applyAnimationExtras(root, { animationFiles = [], clipCuts = [] } = {}) {
    const own = root.userData.fileAnimations ?? (root.userData.fileAnimations = [...(root.userData.animations || [])]);
    const taken = new Set(own.map((c) => c.name));
    const added = [];
    const report = [];
    for (const file of animationFiles || []) {
      let clips = [];
      try {
        clips = await this.clipsFromStore(file.assetId);
      } catch (err) {
        console.warn('[Tiny3] could not read animations from', file.name, err);
        report.push({ file: file.name, used: 0, of: 0, missing: true });
        continue;
      }
      const stem = String(file.name || '').replace(/\.[^.]+$/, '') || 'clip';
      let used = 0;
      let across = 0;
      let source = null; // the file's own model, a copy: what its clips were made for
      for (const clip of clips) {
        const name = uniqueClipName(taken, clips.length === 1 ? stem : (clip.name || stem));
        let fitted = retargetClip(clip, root, name);
        if (!fitted) {
          // another skeleton: by body part (the same skeleton's copies reuse what was worked out)
          const rig = bodyOf(root).bones.map((b) => b.name).join('|');
          const key = `${file.assetId}|${clip.uuid}|${rig}`;
          this._acrossRigs ??= new Map();
          if (!this._acrossRigs.has(key)) {
            try {
              source ??= cloneModel((await this._gltfFromStore(file.assetId)).scene);
              this._acrossRigs.set(key, retargetAcrossRigs(clip, source, root, name));
            } catch (err) {
              console.warn('[Tiny3] could not carry a clip across to this skeleton:', clip.name, err);
              this._acrossRigs.set(key, null);
            }
          }
          const made = this._acrossRigs.get(key);
          if (made) {
            fitted = made.clone();
            fitted.name = name;
            across++;
          }
        }
        if (!fitted) continue;
        taken.add(fitted.name);
        fitted.tiny3 = { kind: 'added', assetId: file.assetId, file: file.name };
        added.push(fitted);
        used++;
      }
      report.push({ file: file.name, used, of: clips.length, across });
    }
    const files = (animationFiles || []).map((f) => ({ assetId: f.assetId, name: f.name }));
    const cuts = (clipCuts || []).map((c) => ({ from: c.from, name: c.name, start: +c.start, end: +c.end }));
    root.userData.animationFiles = files.length ? files : undefined;
    root.userData.clipCuts = cuts.length ? cuts : undefined;
    root.userData.animations = composeClips(own, added, cuts, taken);
    return report;
  }

  /**
   * Load a GLB/GLTF model.
   * @param {string} url
   * @param {{ scale?: number|[number,number,number], position?: [number,number,number], name?: string }} opts
   * @returns {Promise<THREE.Group>}
   */
  async load(url, opts = {}) {
    return this._copy(url, await this._gltf(url), opts);
  }

  /** The same, straight away — or null if the file has not been read yet (see preload). */
  loadSync(url, opts = {}) {
    const gltf = this._ready.get(url);
    return gltf ? this._copy(url, gltf, opts) : null;
  }

  /** loadFromStore, straight away — or null if the file has not been read yet. */
  loadFromStoreSync(assetId, opts = {}) {
    const url = assetStore.cachedURL(assetId);
    const root = url ? this.loadSync(url, opts) : null;
    if (root) root.userData.assetId = assetId;
    return root;
  }

  /** A placeable copy of a parsed file. */
  _copy(url, gltf, { scale = 1, position = [0, 0, 0], name } = {}) {
    // nothing to place: a file of animations only (or an empty one)
    if (!gltf.scene) throw new Error(gltf.animations?.length ? 'NO_SCENE_CLIPS' : 'NO_SCENE');
    // copy so the same file can be placed several times — skeletons and all
    const model = cloneModel(gltf.scene);
    // Each copy owns its materials, as a primitive does: recolouring one duck
    // recoloured every duck (and every duck placed later), though the panel said
    // "this object only". Shared looks are what library materials and prefabs
    // are for. Each mesh is marked with its part — which of the file's
    // materials it has — so a part edited here is found again on load.
    const parts = new Map(); // the file's material -> { index, copy }
    model.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        // every copy of the file draws this same geometry: removing one copy must not free it
        if (node.geometry) node.geometry.userData.shared = true;
        if (node.material && !Array.isArray(node.material)) {
          let part = parts.get(node.material);
          if (!part) parts.set(node.material, (part = { index: parts.size, copy: cloneMaterial(node.material) }));
          node.material = part.copy;
          node.userData.part = part.index;
        }
        // some GLBs leave a degenerate draw range — reset it
        const g = node.geometry;
        if (g && !Number.isFinite(g.drawRange.count)) {
          g.drawRange.count = g.index ? g.index.count : g.attributes.position.count;
        }
      }
      // some GLBs ship a zero-scale node which collapses the model to a point
      const s = node.scale;
      if (s.x === 0 && s.y === 0 && s.z === 0) s.set(1, 1, 1);
    });

    const root = new THREE.Group();
    root.name = name ?? url.split('/').pop();
    root.add(model);

    const s = Array.isArray(scale) ? scale : [scale, scale, scale];
    root.scale.set(s[0], s[1], s[2]);
    root.position.set(position[0], position[1], position[2]);
    root.userData.assetUrl = url;
    // keep the animation clips so the editor can play them
    // rebind tracks to the cloned hierarchy so the mixer can find the targets
    root.userData.animations = rebindClips(gltf.animations || [], gltf.scene, model);
    return root;
  }

  /**
   * Load a model that lives in the asset store (see assets-db.js).
   * This is how disk-loaded models survive save / reload / play-stop.
   */
  async loadFromStore(assetId, opts = {}) {
    const url = await assetStore.objectURL(assetId);
    if (!url) throw new Error(`[Tiny3] asset ${assetId} is not in the asset store`);
    const root = await this.load(url, opts);
    root.userData.assetId = assetId;
    return root;
  }

  /**
   * Store and load every model among `files` — from the file picker or a drop:
   * each .glb, and each .gltf packed into one .glb together with the .bin and
   * image files it names. `files` are File objects, or { file, path } with the
   * path inside a dropped folder. Everything else among them is only there to
   * be found by a .gltf. One model failing doesn't stop the others.
   * With the editor's converter, also each .obj (with its .mtl), .fbx and .stl,
   * made into a .glb; with its shrinker, every model's textures made smaller.
   * Resolves to { models: [root, …], errors: [{ name, error }], notes: [{ name, before, after, images, missing }] }.
   */
  async importFiles(files, opts = {}) {
    const entries = [...files].map((f) => (f?.file ? f : { file: f, path: f.webkitRelativePath || f.name }));
    const models = [];
    const errors = [];
    const notes = [];
    for (const entry of entries) {
      const ext = entry.file.name.split('.').pop().toLowerCase();
      const other = this.convertModel && this.convertible.includes(ext);
      if (ext !== 'glb' && ext !== 'gltf' && !other) continue;
      try {
        let file = entry.file;
        let name = file.name;
        const note = { name: entry.file.name, before: entry.file.size, after: entry.file.size, images: 0, missing: [] };
        if (ext === 'gltf') {
          // a download is often folder/scene.gltf: the folder says what it is
          const folder = entry.path.split('/').slice(-2, -1)[0];
          name = folder || name;
          file = new File([await packGltf(entry, entries)], `${name.replace(/\.gltf$/i, '')}.glb`,
            { type: 'model/gltf-binary' });
        } else if (other) {
          file = await this.convertModel(entry, entries); // into a .glb
          name = name.replace(/\.[^.]+$/, '');
          note.missing = file.missing || [];
        }
        if (this.shrinkModel) {
          note.before = file.size; // the model as it came (made a .glb), before its textures were made smaller
          const small = await this.shrinkModel(file);
          if (small?.file) {
            file = small.file;
            note.images = small.images;
          }
        }
        note.after = file.size;
        const meta = await assetStore.put(file, { kind: 'model' });
        models.push(await this.loadFromStore(meta.id, { ...opts, name }));
        notes.push(note);
      } catch (error) {
        console.error('[Tiny3] model import failed:', entry.path, error);
        errors.push({ name: entry.file.name, error });
      }
    }
    if (!models.length && !errors.length && entries.length) {
      const kinds = ['.glb', '.gltf', ...this.convertible.map((e) => `.${e}`)].join(', ');
      errors.push({ name: entries[0].file.name, error: new Error(`There is no model among these files (${kinds}).`) });
    }
    return { models, errors, notes };
  }

  /**
   * Ask the OS for model files — a .glb, or a .gltf together with its .bin and
   * textures — and import them (see importFiles). Resolves to null if cancelled.
   */
  pickAndImport(opts = {}) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = ['.glb,.gltf,.bin,.png,.jpg,.jpeg,.webp,.ktx2,model/gltf-binary,model/gltf+json',
        ...this.convertible.map((e) => `.${e}`), ...(this.convertible.length ? ['.mtl', '.bmp', '.gif'] : [])].join(',');
      input.addEventListener('change', () => {
        const files = [...(input.files || [])];
        if (!files.length) { resolve(null); return; }
        this.importFiles(files, opts).then(resolve, reject);
      });
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  }
}
