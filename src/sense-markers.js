import * as THREE from 'three';
import { SENSE_DEFAULTS, eyeOf } from './ai.js';
import { yawOf } from './heading.js';

/**
 * In the editor: what the selected object with Senses (or an Enemy AI) sees
 * — a fan as far as it sees and as wide as its field of view, at its eyes —
 * the ring it notices anything within, and the ring it hears footsteps in.
 * Not part of the level: never picked, never saved, gone in play.
 */

const SIGHT = 0x40c8ff;
const NEAR = 0xffd040;
const STEPS = 0x9a7dff;
const SEGMENTS = 48;

/** Draw `entity`'s senses (none: clear them). Called whenever the Inspector is drawn. */
export function showSenses(editor, entity) {
  const engine = editor.engine;
  const scene = engine?.scene;
  if (!scene) return;
  for (const m of scene.children.filter((c) => c.userData.senseMarker)) {
    scene.remove(m);
    m.traverse((n) => { n.geometry?.dispose(); n.material?.dispose(); });
  }
  if (!entity?.object3D || engine.playing) return;
  const list = engine.gameplay?.components.listFor(entity) || [];
  const senses = list.find((c) => c.type === 'senses');
  if (!senses && !list.some((c) => c.type === 'enemyAI')) return;
  scene.add(marker(entity, { ...SENSE_DEFAULTS, ...(senses?.props || {}) }));
}

/** Points of an arc about the origin on the ground plane, from yaw `a` to `b` (radians, 0 along +Z). */
function arc(r, a, b, y = 0) {
  const pts = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = a + ((b - a) * i) / SEGMENTS;
    pts.push(new THREE.Vector3(Math.sin(t) * r, y, Math.cos(t) * r));
  }
  return pts;
}

function lines(points, color, opacity = 0.9) {
  const l = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity }),
  );
  l.renderOrder = 1000;
  l.frustumCulled = false;
  return l;
}

function marker(entity, p) {
  const group = new THREE.Group();
  group.name = '__senses';
  group.userData.senseMarker = true;
  const sight = Number(p.sight) || 0;
  const half = (Math.min(360, Math.max(1, Number(p.fov) || 120)) / 2) * Math.PI / 180;
  // the fan, flat at its eyes: two edges and the far arc (a whole ring at 360°)
  let fan = null;
  if (sight > 0) {
    const edge = arc(sight, -half, half);
    fan = lines(half >= Math.PI - 1e-6 ? edge : [new THREE.Vector3(), ...edge, new THREE.Vector3()], SIGHT);
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(sight, SEGMENTS, -Math.PI / 2 - half, half * 2).rotateX(-Math.PI / 2), // centred on +Z, its front
      new THREE.MeshBasicMaterial({ color: SIGHT, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }),
    );
    fill.frustumCulled = false;
    fan.add(fill);
    group.add(fan);
  }
  // rings on the ground: what it notices any way it faces, what footsteps it hears
  const feel = Number(p.feel) || 0;
  const near = feel > 0 ? lines(arc(feel, 0, Math.PI * 2), NEAR, 0.8) : null;
  const steps = p.footsteps !== 'never' && Number(p.stepsWithin) > 0 ? lines(arc(Number(p.stepsWithin), 0, Math.PI * 2), STEPS, 0.45) : null;
  if (near) group.add(near);
  if (steps) group.add(steps);
  const eye = new THREE.Vector3();
  const box = new THREE.Box3();
  // where it is now, every frame: it may be dragged or turned in the editor
  const place = () => {
    const o = entity.object3D;
    if (!o.parent) { group.visible = false; return; }
    group.visible = true;
    eyeOf(entity, eye);
    box.setFromObject(o);
    const floor = box.isEmpty() ? eye.y : box.min.y + 0.02;
    group.position.set(eye.x, 0, eye.z);
    group.rotation.set(0, yawOf(o), 0);
    if (fan) fan.position.y = eye.y;
    if (near) near.position.y = floor;
    if (steps) steps.position.y = floor;
    group.updateMatrixWorld(true);
  };
  for (const l of [fan, near, steps]) if (l) l.onBeforeRender = place;
  place();
  return group;
}
