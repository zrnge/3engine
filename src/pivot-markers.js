import * as THREE from 'three';
import { ACTIONS } from './rules.js';
import { pivotPoint, forgetBounds } from './pivot.js';

/**
 * In the editor: a dot where the selected object's rules turn or scale
 * something about (its pivot), so which side is "left" or "front" can be seen,
 * and a line along the axis a Rotate or Turn turns it about. Neither is part of
 * the level: never picked, never saved, and gone in play.
 */

const COLOR = 0xffb020;
const _Y = new THREE.Vector3(0, 1, 0);

/** Draw the pivots of `entity`'s rules (none: clear them). Called whenever the Inspector is drawn. */
export function showPivots(editor, entity) {
  const engine = editor.engine;
  const scene = engine?.scene;
  if (!scene) return;
  for (const m of scene.children.filter((c) => c.userData.pivotMarker)) {
    scene.remove(m);
    m.traverse((n) => { n.geometry?.dispose(); n.material?.dispose(); });
  }
  if (!entity?.object3D || engine.playing) return;
  forgetBounds(); // measured afresh: a shape may have changed
  const api = engine.gameplay?.api;
  const resolve = (selector) => api?.resolveTarget(selector, entity, null) ?? null;
  for (const rule of engine.gameplay?.rules.listFor(entity) || []) {
    for (const action of [...(rule.do || []), ...(rule.else || [])]) {
      if (!ACTIONS[action.type]?.props?.pivot || !action.pivot || action.pivot === 'its origin') continue;
      if (action.type === 'moveObject' && action.how === 'by') continue; // a move by: every point moves alike
      const target = resolve(action.target || 'self');
      if (target?.object3D) scene.add(marker(target, action, resolve));
    }
  }
}

/** The axis a Rotate or Turn turns about, in the world (null: none to show). */
function axisOf(action, o, out) {
  if (action.type === 'turn') return out.set(0, 1, 0);
  if (action.type !== 'rotate' || action.how === 'to') return null;
  out.set(Number(action.x) || 0, Number(action.y) || 0, Number(action.z) || 0);
  if (out.lengthSq() < 1e-12) return null;
  if (action.relative !== 'world') out.applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
  return out.normalize();
}

function marker(target, action, resolve) {
  const o = target.object3D;
  const size = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
  const big = Math.max(size.x, size.y, size.z) || 1;
  const r = THREE.MathUtils.clamp(big * 0.04, 0.04, 0.3);
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(r, 16, 12),
    new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false, transparent: true }),
  );
  dot.name = '__pivot';
  dot.userData.pivotMarker = true;
  dot.renderOrder = 999; // over the object: a hinge is on its edge, half inside it
  dot.frustumCulled = false; // it is placed as it is drawn
  const dir = new THREE.Vector3();
  const line = axisOf(action, o, dir) ? new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -big * 0.75, 0), new THREE.Vector3(0, big * 0.75, 0)]),
    new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true, opacity: 0.85 }),
  ) : null;
  if (line) {
    line.renderOrder = 1000;
    line.frustumCulled = false;
    dot.add(line);
  }
  // where it is now, every frame: the object may be dragged, turned or scaled in the editor
  const place = () => {
    const p = pivotPoint(target, action, resolve);
    dot.visible = !!p;
    if (!p) return;
    dot.position.copy(p);
    if (line && axisOf(action, o, dir)) dot.quaternion.setFromUnitVectors(_Y, dir);
    dot.updateMatrixWorld(true);
  };
  dot.onBeforeRender = place;
  place();
  return dot;
}
