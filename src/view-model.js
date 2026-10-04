import * as THREE from 'three';

/**
 * Held in view — first-person arms, a gun, a torch: an object drawn locked to
 * the camera while the game is seen in first person.
 *
 * Any object can be held; its `viewModel` says where, relative to the camera:
 *   { position: [right, up, forward-is-negative], rotation: [x, y, z] degrees, scale,
 *     aim: { position, rotation } }   // optional: where it goes while aiming (the Aim control)
 *
 * Without its own `aim`, aiming brings it to the middle and a little up
 * (aimPoseOf) — a starting point for the Inspector's "Aiming" sliders.
 *
 * It is only DRAWN there, the way poses are (poses.js): its real place in the
 * scene never changes, so saving, physics and the editor's gizmo never see the
 * camera-following copy. And it is drawn in a second pass over a cleared depth
 * buffer, so a held gun never pushes through a wall the player stands against.
 */

export const VIEW_LAYER = 1;

const DEFAULTS = { position: [0.22, -0.28, -0.6], rotation: [0, 180, 0], scale: 1 };

/** Fill in and clamp a view-model setting (from a file, a panel, a prefab). */
export function normalizeViewModel(v) {
  if (!v || typeof v !== 'object') return null;
  const vec = (a, d) => (Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? a.map(Number) : [...d]);
  const s = Number(v.scale);
  const out = {
    position: vec(v.position, DEFAULTS.position),
    rotation: vec(v.rotation, DEFAULTS.rotation),
    scale: Number.isFinite(s) && s > 0 ? s : DEFAULTS.scale,
  };
  if (v.aim && typeof v.aim === 'object') {
    const d = aimPoseOf(out);
    out.aim = { position: vec(v.aim.position, d.position), rotation: vec(v.aim.rotation, d.rotation) };
  }
  return out;
}

// while aiming, a gun held at the usual spot comes to the middle and up: this far
const AIM_SHIFT = [-DEFAULTS.position[0], -DEFAULTS.position[1] / 2, 0];

/** Where a held object goes while aiming: its own aiming place, or (saved before there was one) in and up. */
export function aimPoseOf(vm) {
  if (vm.aim) return vm.aim;
  return { position: vm.position.map((p, i) => +(p + AIM_SHIFT[i]).toFixed(3)), rotation: [...vm.rotation] };
}

/**
 * A starting place for an object about to be held, turned to point where the
 * camera looks (models face +Z; the camera looks down -Z). The sliders in the
 * Inspector take it from there.
 *
 *  - Rigged first-person arms (a skinned model, arm-sized, longest front to
 *    back) were built around the player's eye: kept at their own size, the eye
 *    goes at their shoulder end, level with the top of the hands — the sights
 *    in the middle of the view. (Found with a Sketchfab pistol-and-arms rig.)
 *  - Anything else — a torch, a gun on its own — is sized to about `length`
 *    metres and held a little right of and below the view.
 */
export function fitViewModel(object3D, { length = 0.55 } = {}) {
  const box = new THREE.Box3();
  object3D.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(object3D.matrixWorld).invert();
  let rigged = false;
  object3D.traverse((n) => { if (n.isSkinnedMesh) rigged = true; });
  object3D.traverse((n) => {
    if (!n.geometry) return;
    let local;
    if (n.isSkinnedMesh) { n.computeBoundingBox(); local = n.boundingBox; } // rigged arms: where the skin is
    else {
      if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
      local = n.geometry.boundingBox;
    }
    box.union(new THREE.Box3().copy(local).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, n.matrixWorld)));
  });
  const vm = normalizeViewModel({});
  if (box.isEmpty()) return vm;
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  if (rigged && longest >= 0.2 && longest <= 3 && size.z >= size.x && size.z >= size.y) {
    // the eye, in the model's own space: centred, near the top, just inside the near end
    const eye = new THREE.Vector3(
      (box.min.x + box.max.x) / 2, box.min.y + size.y * 0.9, box.min.z + size.z * 0.14);
    // turned 180° round Y, (x, y, z) becomes (-x, y, -z): move that point onto the camera.
    // Rigged arms aim with their own animation, so aiming leaves them where they are.
    const position = [eye.x, -eye.y, eye.z].map((v) => +v.toFixed(3));
    return { position, rotation: [0, 180, 0], scale: 1, aim: { position: [...position], rotation: [0, 180, 0] } };
  }
  vm.scale = +(length / longest).toPrecision(3);
  // put the model's middle at the default spot, whatever its origin — and, aiming, in the middle and up
  const middle = box.getCenter(new THREE.Vector3()).multiplyScalar(vm.scale)
    .applyEuler(new THREE.Euler(...vm.rotation.map(THREE.MathUtils.degToRad)));
  vm.position = vm.position.map((p, i) => +(p - middle.getComponent(i)).toFixed(3));
  vm.aim = aimPoseOf({ position: vm.position, rotation: vm.rotation });
  return vm;
}

/**
 * A starting aiming place for an object held at `vm`: rigged arms stay where
 * they are (their own clips raise the gun); anything else comes in and up.
 */
export function startingAim(object3D, vm) {
  const fit = fitViewModel(object3D);
  const stays = !!fit.aim && fit.aim.position.every((v, i) => v === fit.position[i]);
  return stays
    ? { position: [...vm.position], rotation: [...vm.rotation] }
    : aimPoseOf({ position: vm.position, rotation: vm.rotation });
}

const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/**
 * Where a held object is drawn this frame, between its usual place and its
 * aiming place (`aim` 0–1), kicked back by recoil (`kick`, metres).
 */
export function heldPose(vm, { aim = 0, kick = 0 } = {}) {
  const to = aim > 0 ? aimPoseOf(vm) : vm;
  const mix = (a, b) => a.map((v, i) => v + (b[i] - v) * aim);
  const position = mix(vm.position, to.position);
  const rotation = mix(vm.rotation, to.rotation);
  if (kick) {
    position[2] += kick;          // back towards the eye
    rotation[0] += kick * 120;    // and the muzzle up a little (degrees)
  }
  return { position, rotation };
}

/**
 * Draw the scene, then anything held in view on top. `active` is whether the
 * view is first person right now; `pose` is how far into aiming and how much
 * recoil (see heldPose). Returns nothing; leaves every object as it was.
 */
export function renderWithViewModels(renderer, scene, camera, entities, active, pose = {}, draw = null) {
  // the world is drawn by `draw` (through the effects, see effects.js), the held things on top of it
  const world = draw ?? ((s, c) => renderer.render(s, c));
  const held = active ? entities.filter((e) => e.viewModel && e.object3D?.visible !== false) : [];
  if (!held.length) {
    world(scene, camera);
    return;
  }

  camera.updateMatrixWorld();
  const restore = [];
  for (const e of held) {
    const o = e.object3D;
    const vm = e.viewModel;
    const at = heldPose(vm, pose);
    restore.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]);
    _e.set(...at.rotation.map(THREE.MathUtils.degToRad));
    _local.compose(new THREE.Vector3(...at.position), _q.setFromEuler(_e),
      new THREE.Vector3(vm.scale, vm.scale, vm.scale));
    _world.multiplyMatrices(camera.matrixWorld, _local);
    if (o.parent) _world.premultiply(_local.copy(o.parent.matrixWorld).invert());
    _world.decompose(o.position, o.quaternion, o.scale);
    o.updateMatrixWorld(true);
    o.traverse((n) => {
      restore.push([n, n.layers.mask, n.castShadow]);
      n.layers.set(VIEW_LAYER);
      n.castShadow = false; // a held gun would throw a huge shadow in front of you
    });
  }
  // lights light both passes
  scene.traverse((n) => {
    if (n.isLight && !n.layers.isEnabled(VIEW_LAYER)) {
      restore.push([n, n.layers.mask]);
      n.layers.enable(VIEW_LAYER);
    }
  });

  // pass 2: the held objects, over a cleared depth buffer, close to the eye — into whatever
  // picture is being drawn: the screen, or the effects' own (so they are graded as the world is)
  const drawHeld = () => {
    const { autoClear } = renderer;
    const background = scene.background;
    const mask = camera.layers.mask;
    const near = camera.near;
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    scene.background = null;
    camera.layers.set(VIEW_LAYER);
    camera.near = Math.min(near, 0.01);
    camera.updateProjectionMatrix();
    renderer.clearDepth();
    renderer.render(scene, camera);
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadows;
    scene.background = background;
    camera.layers.mask = mask;
    camera.near = near;
    camera.updateProjectionMatrix();
  };

  // pass 1: the world (the held objects are on their own layer, so not drawn) — and then them
  if (draw) draw(scene, camera, drawHeld);
  else { renderer.render(scene, camera); drawHeld(); }

  for (const r of restore) {
    if (r.length === 4) {
      const [o, p, q, s] = r;
      o.position.copy(p);
      o.quaternion.copy(q);
      o.scale.copy(s);
      o.updateMatrixWorld(true);
    } else {
      r[0].layers.mask = r[1];
      if (r.length === 3) r[0].castShadow = r[2];
    }
  }
}
