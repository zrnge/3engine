import * as THREE from 'three';

/**
 * A model's parts, for its physics. A model is many meshes (a tree's trunk and
 * its leaves; a table's top and legs; a house's walls, door and curtains), and
 * each can be its own:
 *   body     in the object's own collider (all of them, unless told otherwise)
 *   none     left out: not solid at all (leaves, a cape, an antenna)
 *   box      a solid box of its own round just that part (a table's legs: walk under it)
 *   trigger  a zone of its own that is entered, not bumped (a doorway, a hit zone)
 *
 *   entity.physicsParts = { 'Tree/Leaves': 'none', 'Door zone': 'trigger' }
 *
 * A part is known by the names of its nodes from the model down ("Tree/Leaves"),
 * so the setting is kept with the game. A part's own box or zone follows it as it
 * moves, and what touches it is said to touch the model, and at which part.
 */

export const PART_ROLES = Object.freeze(['body', 'none', 'box', 'trigger']);
export const PART_ROLE_LABELS = Object.freeze({
  body: 'In its body', none: 'Left out (not solid)', box: 'Own box (solid)', trigger: 'Trigger zone',
});

/** Every mesh of a model, as a part: its key (its names, from the model down), its name, its node. */
export function physicsPartList(root) {
  const out = [];
  if (!root) return out;
  const seen = new Map();
  root.traverse((n) => {
    if (n === root || !n.isMesh || !n.geometry?.attributes?.position || n.userData?.editorOnly || n.isInstancedMesh) return;
    const names = [];
    for (let p = n; p && p !== root; p = p.parent) names.unshift(p.name || p.type);
    let key = names.join('/');
    const k = (seen.get(key) || 0) + 1;
    seen.set(key, k);
    if (k > 1) key = `${key}#${k}`; // a second mesh by the same names
    out.push({ key, name: n.name || names[names.length - 2] || n.type, node: n });
  });
  return out;
}

/** The parts with a role other than "in its body", as [{ key, role, node, name }] — those found on the model. */
export function partRoles(entity) {
  const roles = entity?.physicsParts;
  if (!roles || !Object.keys(roles).length) return [];
  return physicsPartList(entity.object3D)
    .filter((p) => PART_ROLES.includes(roles[p.key]) && roles[p.key] !== 'body')
    .map((p) => ({ ...p, role: roles[p.key] }));
}

/** Clean a part list for saving: only parts with a role of their own. */
export function normalizePhysicsParts(raw) {
  const out = {};
  for (const [key, role] of Object.entries(raw || {})) {
    if (typeof key === 'string' && key && PART_ROLES.includes(role) && role !== 'body') out[key] = role;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * In the editor: a box round each part with a role of its own on the selected
 * object — red, solid; yellow, a trigger zone; grey dashes, left out. Not part
 * of the level, never saved, gone in play.
 */
export function showPhysicsParts(editor, entity) {
  const scene = editor.engine?.scene;
  if (!scene) return;
  for (const m of scene.children.filter((c) => c.userData.physicsPartMarker)) {
    scene.remove(m);
    m.geometry?.dispose();
    m.material?.dispose();
  }
  if (!entity || editor.engine.playing) return;
  const color = { box: 0xff3333, trigger: 0xf6c343, none: 0x8b949e };
  for (const p of partRoles(entity)) {
    const box = new THREE.Box3().setFromObject(p.node);
    if (box.isEmpty()) continue;
    const helper = new THREE.Box3Helper(box, color[p.role]);
    helper.name = '__physicsPart';
    helper.userData.physicsPartMarker = true;
    helper.material.depthTest = false;
    helper.material.transparent = true;
    helper.material.opacity = p.role === 'none' ? 0.5 : 0.9;
    helper.renderOrder = 998;
    scene.add(helper);
  }
}
