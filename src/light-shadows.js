import * as THREE from 'three';

/**
 * Lamp shadows — point and spot lights that cast shadows, made to look right
 * and kept affordable.
 *
 * Each frame, of the lamps set to cast shadows, only the nearest few to the
 * camera do (the level's "Lamp shadows at once"); the others are lit, without
 * shadows, for that frame. The number casting stays the same as the camera
 * moves, so no material is rebuilt when one lamp hands its shadow to another —
 * and a level with forty torches neither renders forty shadow maps (six views
 * each for a point light) nor runs out of the GPU's texture slots, which used
 * to fail every material's shader.
 *
 * Each casting lamp's shadow is tuned to the lamp: its reach (the light's
 * Distance), a bias that keeps surfaces from shadowing themselves, a picture
 * size by the level's Shadow detail, soft edges.
 */

/** Shadow picture size of a lamp, by Shadow detail: a point light draws six of them. */
export const LAMP_SHADOW_SIZES = Object.freeze({ low: 256, medium: 512, high: 1024 });

const _cam = new THREE.Vector3();
const _at = new THREE.Vector3();

/** Its shadow, set for this lamp and detail (once, until either changes). */
export function tuneLampShadow(light, detail = 'medium') {
  const reach = light.distance > 0 ? light.distance : 30;
  const size = LAMP_SHADOW_SIZES[detail] ?? 512;
  const key = `${detail}|${reach}|${light.isSpotLight ? light.angle : ''}`;
  if (light.userData.shadowTuned === key) return;
  light.userData.shadowTuned = key;
  const s = light.shadow;
  if (s.mapSize.x !== size) {
    s.mapSize.set(size, size);
    s.map?.dispose();
    s.map = null;
  }
  s.camera.near = 0.05;
  s.camera.far = reach;
  s.camera.updateProjectionMatrix?.();
  // a point light's six views and a spot's cone, at this resolution: acne-free without floating shadows
  s.bias = light.isPointLight ? -0.002 : -0.0008;
  s.normalBias = 0.02;
  s.radius = 3;
}

/**
 * Before a frame is drawn: the nearest `budget` of the lamps set to cast
 * shadows do; the rest don't, this frame. Returns what puts their own
 * settings back (the editor and a save only ever see those).
 */
export function budgetLampShadows(scene, camera, budget = 4, detail = 'medium') {
  const wanting = [];
  scene.traverseVisible((n) => {
    if ((n.isPointLight || n.isSpotLight) && n.castShadow && n.intensity > 0) wanting.push(n);
  });
  for (const l of wanting) tuneLampShadow(l, detail);
  if (wanting.length <= budget) return null;
  camera.getWorldPosition(_cam);
  const far = wanting
    .map((l) => [l.getWorldPosition(_at).distanceToSquared(_cam), l])
    .sort((a, b) => a[0] - b[0])
    .slice(Math.max(0, budget))
    .map(([, l]) => l);
  for (const l of far) l.castShadow = false;
  return () => { for (const l of far) l.castShadow = true; };
}
