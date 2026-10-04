import * as THREE from 'three';

/**
 * Where a new model goes, and how big it is.
 *
 * A model used to arrive at the world's origin at whatever size its file said:
 * often inside the ground, off to one side of the view, or a hundred times too
 * big. Now it stands on whatever it is dropped on (or the ground in the middle
 * of the view), and a file that looks like it is in the wrong units gets a
 * one-click fix offered — never forced, since glTF files are in metres and a
 * huge model may well be a city.
 */

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

/**
 * An object's world-space bounds — its skin where a rigged character really is
 * (before anything is drawn, its bones haven't posed it yet).
 *
 * updateMatrixWorld, not updateWorldMatrix: only the former is what drawing
 * does, and refreshes a skinned mesh bound to where it stands ("attached" bind
 * mode). Without it a freshly loaded robot measured 310 m across instead of 3.
 */
export function boundsOf(object3D, out = new THREE.Box3()) {
  object3D.updateWorldMatrix(true, false); // its parents
  object3D.updateMatrixWorld(true); // itself and everything below
  object3D.traverse((n) => {
    if (!n.isSkinnedMesh) return;
    n.skeleton.update();
    n.boundingBox = null; // measured again, posed
  });
  return out.setFromObject(object3D);
}

/**
 * Move `object3D` (at the top of the scene) so it stands on `point`: its bottom
 * on the surface, its middle over the point — wherever its file put its origin.
 */
export function standOn(object3D, point) {
  boundsOf(object3D, _box);
  if (_box.isEmpty()) {
    object3D.position.copy(point);
    return object3D;
  }
  _box.getCenter(_v);
  object3D.position.x += point.x - _v.x;
  object3D.position.z += point.z - _v.z;
  object3D.position.y += point.y - _box.min.y;
  object3D.updateWorldMatrix(false, true);
  return object3D;
}

/**
 * Where something dropped at screen point `ndc` (-1..1) lands: on the surface
 * of one of `objects` under the pointer, else on the ground (y = 0) — unless
 * that is further than `maxDistance` (looking at the horizon) — else on the
 * ground straight below a spot `fallback` metres ahead.
 */
export function dropPoint(camera, ndc, objects = [], { maxDistance = 60, fallback = 8 } = {}) {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
  const hit = objects.length ? raycaster.intersectObjects(objects, true)[0] : null;
  if (hit) return hit.point.clone();
  const { ray } = raycaster;
  const ground = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
  if (ground && ground.distanceTo(ray.origin) <= maxDistance) return ground;
  const ahead = ray.origin.clone().addScaledVector(ray.direction, fallback);
  ahead.y = 0;
  return ahead;
}

const metres = (n) => (n >= 10 ? `${Math.round(n)} m` : n >= 0.1 ? `${Number(n.toFixed(2))} m` : `${Number((n * 100).toFixed(1))} cm`);

/**
 * Sizes a file might have meant, for a model that came out unusually big or
 * small: [{ label, scale }] — empty when its size is believable. glTF is in
 * metres, but some tools write centimetres (a person 180 units tall) or
 * millimetres; and anything can be fitted to a plain metre.
 */
export function sizeSuggestions(longest, { tiny = 0.05, huge = 50 } = {}) {
  if (!(longest > 0) || !Number.isFinite(longest) || (longest >= tiny && longest <= huge)) return [];
  const out = [];
  if (longest > huge) {
    for (const [unit, k] of [['centimetres', 0.01], ['millimetres', 0.001]]) {
      const size = longest * k;
      if (size >= 0.1 && size <= huge) out.push({ label: `Made in ${unit} (${metres(size)})`, scale: k });
    }
  }
  out.push({ label: 'Fit to 1 m', scale: 1 / longest });
  return out;
}

export { metres as formatMetres };
