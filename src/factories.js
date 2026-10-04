import * as THREE from 'three';
import { assetStore } from './assets-db.js';

/**
 * The canonical list of things the editor can create, and the introspection
 * needed to recognise them again when a scene is saved.
 *
 * These tables used to be copy-pasted into editor.js, scene.js and game.js.
 * Three copies meant adding a shape in one place produced objects the saver
 * could not identify and silently dropped — so they live here once.
 */

export const PRIMITIVE_GEOS = {
  box: () => new THREE.BoxGeometry(1.5, 1.5, 1.5),
  sphere: () => new THREE.SphereGeometry(0.9, 32, 16),
  cone: () => new THREE.ConeGeometry(0.9, 2, 24),
  cylinder: () => new THREE.CylinderGeometry(0.7, 0.7, 1.8, 24),
  torus: () => new THREE.TorusGeometry(0.9, 0.35, 16, 40),
};

/** geometry.type -> the key in PRIMITIVE_GEOS that produces it. */
const GEO_TYPE_TO_KIND = {
  BoxGeometry: 'box',
  SphereGeometry: 'sphere',
  ConeGeometry: 'cone',
  CylinderGeometry: 'cylinder',
  TorusGeometry: 'torus',
};

export const LIGHT_TYPES = {
  directional: (d) => new THREE.DirectionalLight(d.color, d.intensity),
  point: (d) => new THREE.PointLight(d.color, d.intensity, d.distance ?? 0, d.decay ?? 2),
  spot: (d) => new THREE.SpotLight(
    d.color, d.intensity, d.distance ?? 0,
    d.angle ?? Math.PI / 6, d.penumbra ?? 0, d.decay ?? 2
  ),
  ambient: (d) => new THREE.AmbientLight(d.color, d.intensity),
};

/** Which primitive a geometry came from, or null if it isn't one of ours. */
export function primitiveKind(geo) {
  return geo ? (GEO_TYPE_TO_KIND[geo.type] ?? null) : null;
}

/** Which of the four light kinds a THREE.Light is. */
export function lightKind(light) {
  if (light.isDirectionalLight) return 'directional';
  if (light.isPointLight) return 'point';
  if (light.isSpotLight) return 'spot';
  return 'ambient';
}

/** The first mesh at or beneath a node — the one whose material we edit. */
export function firstMesh(root) {
  if (!root) return null;
  if (root.isMesh) return root;
  let found = null;
  root.traverse?.((n) => { if (!found && n.isMesh) found = n; });
  return found;
}

const imageLoader = new THREE.ImageLoader();
const _images = new Map(); // assetId -> Promise<image>, decoded once however many slots use it

/**
 * A new texture for an image in the asset store (null if it is not there).
 * Every call returns its own Texture — each material places it differently —
 * but they share one decoded image.
 */
export async function loadStoredTexture({ assetId, name } = {}) {
  if (!assetId) return null;
  let image = _images.get(assetId);
  if (!image) {
    image = (async () => {
      const url = await assetStore.objectURL(assetId);
      if (!url) throw new Error(`texture "${name || assetId}" is not in the asset store`);
      return imageLoader.loadAsync(url);
    })();
    _images.set(assetId, image);
    image.catch(() => _images.delete(assetId));
  }
  const texture = new THREE.Texture(await image);
  texture.name = name || assetId;
  texture.userData.assetId = assetId;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Put an image from the asset store onto a material as its colour texture.
 * Textures are kept by asset id, like models and sounds, so they survive save,
 * reload and Play -> Stop. Resolves to the texture once it has decoded.
 */
export async function applyStoredTexture(material, { assetId, name } = {}) {
  let texture;
  try {
    texture = await loadStoredTexture({ assetId, name });
  } catch (err) {
    console.warn('[Tiny3] texture is not in the asset store:', name || assetId, err);
    return null;
  }
  if (!texture) return null;
  texture.colorSpace = THREE.SRGBColorSpace;
  material.map = texture;
  material.needsUpdate = true;
  return texture;
}

/** How a material's texture is saved: its asset id and file name, or nothing. */
export function textureRecord(material) {
  const assetId = material?.map?.userData?.assetId;
  return assetId ? { assetId, name: material.map.name } : undefined;
}

/** Default colours for newly added primitives. */
export const PALETTE = [0x539bf5, 0xf6a435, 0x4dd0a6, 0xf47067, 0xdaaa3f, 0xb083f0];
