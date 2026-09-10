import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
  constructor() {
    this._loader = new GLTFLoader();
    this._cache = new Map(); // url -> Promise<gltf>
  }

  /**
   * Load a GLB/GLTF model.
   * @param {string} url
   * @param {{ scale?: number|[number,number,number], position?: [number,number,number], name?: string }} opts
   * @returns {Promise<THREE.Group>}
   */
  async load(url, { scale = 1, position = [0, 0, 0], name } = {}) {
    if (!this._cache.has(url)) {
      this._cache.set(url, this._loader.loadAsync(url));
    }
    const gltf = await this._cache.get(url);

    // clone so the same file can be placed several times
    const model = gltf.scene.clone(true);
    model.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
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

  /** Ask the OS for a .glb/.gltf file and load it via an object URL. */
  pickAndLoad(opts = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.glb,.gltf,model/gltf-binary';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) { resolve(null); return; }
        const url = URL.createObjectURL(file);
        this._cache.delete(url); // never cache blobs
        const obj = await this.load(url, { ...opts, name: opts.name ?? file.name });
        resolve(obj);
      };
      input.click();
    });
  }
}
