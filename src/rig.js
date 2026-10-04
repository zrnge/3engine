import * as THREE from 'three';

/**
 * A model's skeleton, read as a body: which bone is the hips, the spine, the
 * neck and head, each shoulder, arm, hand, thigh, shin and foot — from the
 * bones' names, whichever tool named them:
 *
 *   Mixamo     mixamorig:LeftUpLeg (and Sketchfab's mixamorig7:LeftUpLeg_03)
 *   Blender    UpperLeg.L, thigh.L, shin.R, DEF-forearm.L
 *   3ds Max    Bip01 L Thigh, Bip01 R Calf
 *   Unreal     thigh_l, calf_r, upperarm_l, lowerarm_r
 *
 * (three.js tidies names on loading: "UpperLeg.L" arrives as "UpperLegL",
 * "mixamorig:Hips" as "mixamorigHips" — both are read.)
 *
 * Used for the Animator's IK (ik.js: feet, a head that turns, root motion) and
 * to share clips between models whose skeletons are named differently.
 */

const PARTS = [
  // [canonical part, words that mean it] — earlier entries win (forearm before arm, upleg before leg)
  ['thumb', /thumb/], ['index', /index|pointer/], ['middle', /middle/], ['ring', /ring/], ['pinky', /pinky|little/],
  ['toe', /toe|ball/],
  ['foot', /foot|ankle/],
  ['upperLeg', /upleg|upperleg|thigh/],
  ['lowerLeg', /lowerleg|calf|shin|knee|(?<!up)leg/],
  ['lowerArm', /forearm|lowerarm|elbow/],
  ['shoulder', /shoulder|clavicle|collar/],
  ['hand', /hand|palm|wrist/],
  ['upperArm', /upperarm|(?<!fore|lower)arm/],
  ['hips', /hips|pelvis/],
  ['chest', /spine2|spine3|chest|torso|upperchest/],
  ['spine1', /spine1/],
  ['spine', /spine|abdomen/],
  ['neck', /neck/],
  ['head', /head/],
];

/**
 * A bone's place in a body — "L.upperLeg", "R.hand", "hips", "L.index2" — or
 * null for one that isn't (an end marker, a weapon, a pole target).
 */
export function humanoidKey(raw) {
  let name = String(raw || '');
  if (/_end$|end$|target|pole|ik[_A-Z]|nub|twist|roll|helper|weapon|prop/i.test(name)) return null;
  name = name.replace(/^.*?mixamorig\d*:?/i, '').replace(/^mixamorig\d*/i, '').replace(/^(bip0?1|def|org|mch)[\s_.-]*/i, '');
  name = name.replace(/_\d+$/, '').replace(/\.0\d\d$/, ''); // Sketchfab's _03, Blender's .001
  // the side: a word, a separate letter, or a trailing capital L / R after a lower-case letter
  let side = '';
  const test = (re) => re.test(name);
  if (test(/left/i) || test(/(^|[\s_.-])l($|[\s_.-])/i) || test(/[a-z0-9]L$/) || test(/^L[A-Z]/)) side = 'L';
  else if (test(/right/i) || test(/(^|[\s_.-])r($|[\s_.-])/i) || test(/[a-z0-9]R$/) || test(/^R[A-Z]/)) side = 'R';
  let core = name.replace(/left|right/ig, '');
  if (side) core = core.replace(/(^|[\s_.-])[lr]($|[\s_.-])/ig, '$1$2').replace(side === 'L' ? /([a-z0-9])L$/ : /([a-z0-9])R$/, '$1').replace(side === 'L' ? /^L([A-Z])/ : /^R([A-Z])/, '$1');
  core = core.toLowerCase().replace(/[\s_.:-]/g, '');
  if (!core) return null;
  for (const [part, re] of PARTS) {
    if (!re.test(core)) continue;
    const finger = ['thumb', 'index', 'middle', 'ring', 'pinky'].includes(part);
    const n = finger ? (/(\d)/.exec(core.replace(/^.*?(thumb|index|middle|ring|pinky|little|pointer)/, ''))?.[1] ?? '1') : '';
    const sided = side || (['hips', 'spine', 'spine1', 'chest', 'neck', 'head'].includes(part) ? '' : null);
    if (sided === null) return null; // a limb with no side can't be placed
    return `${sided ? `${sided}.` : ''}${part}${n}`;
  }
  return null;
}

/**
 * A model's bones by body part: { key: bone } (the first bone named for each),
 * and its bones in order. `root` is a model, or a list of bones (a skeleton's).
 */
export function bodyOf(root) {
  const byKey = {};
  const bones = [];
  const take = (n) => {
    if (!n.isBone) return;
    bones.push(n);
    const key = humanoidKey(n.name);
    if (key && !byKey[key]) byKey[key] = n;
  };
  if (Array.isArray(root)) root.forEach(take);
  else root.traverse(take);
  return { byKey, bones };
}

const _rq = new THREE.Quaternion();
const _rq2 = new THREE.Quaternion();

const isUnder = (node, parent) => { for (let n = node?.parent; n; n = n.parent) if (n === parent) return true; return false; };

/**
 * What the Animator's IK needs, found once per model and kept: its hips, its
 * legs (each a thigh, a shin and the foot at the end — the foot bone, or the
 * shin's end), its head and neck, and the hips' place at rest.
 */
export function findRig(root) {
  if (root.userData._rig !== undefined) return root.userData._rig;
  const { byKey } = bodyOf(root);
  const legs = [];
  for (const side of ['L', 'R']) {
    const up = byKey[`${side}.upperLeg`];
    const low = byKey[`${side}.lowerLeg`];
    if (!up || !low || !isUnder(low, up)) continue;
    let foot = byKey[`${side}.foot`];
    if (!foot || !isUnder(foot, low)) {
      // a rig whose feet hang elsewhere (an IK rig baked): the end of the shin
      foot = null;
      low.traverse((n) => { if (!foot && n !== low && n.children.length === 0) foot = n; });
    }
    if (!foot) continue;
    legs.push({ side, up, low, foot, length: 0 });
  }
  const rig = { hips: byKey.hips || null, head: byKey.head || null, neck: byKey.neck || null, chest: byKey.chest || null, legs };
  root.updateMatrixWorld(true);
  for (const leg of legs) {
    const a = leg.up.getWorldPosition(new THREE.Vector3());
    const b = leg.low.getWorldPosition(new THREE.Vector3());
    const c = leg.foot.getWorldPosition(new THREE.Vector3());
    leg.length = a.distanceTo(b) + b.distanceTo(c);
  }
  rig.hipsRest = rig.hips ? restPosition(root, rig.hips) : null;
  root.userData._rig = rig;
  return rig;
}

/** A bone's place in its parent at rest (from its skeleton's bind pose; else where it is now). */
function restPosition(root, bone) {
  let skinned = null;
  root.traverse((n) => { if (!skinned && n.isSkinnedMesh && n.skeleton.bones.includes(bone)) skinned = n; });
  if (!skinned) return bone.position.clone();
  const bones = skinned.skeleton.bones;
  const i = bones.indexOf(bone);
  const world = new THREE.Matrix4().copy(skinned.skeleton.boneInverses[i]).invert();
  const p = bones.indexOf(bone.parent);
  if (p >= 0) world.premultiply(new THREE.Matrix4().copy(skinned.skeleton.boneInverses[p]));
  return new THREE.Vector3().setFromMatrixPosition(world);
}

// ---------------------------------------------------------------- one rig's clip on another

/** The bones its skin follows (some files nest a copy of each bone in the one a clip moves: these are the skin's). */
export function skinBones(root) {
  const skin = mainSkin(root);
  return skin ? skin.skeleton.bones : bodyOf(root).bones;
}

/** The skinned mesh that moves most of a model (the body, not a hat). */
function mainSkin(root) {
  let best = null;
  root.traverse((n) => { if (n.isSkinnedMesh && (!best || n.skeleton.bones.length > best.skeleton.bones.length)) best = n; });
  return best;
}

/**
 * Which of `source`'s bones moves each of `target`'s: { targetBoneName:
 * sourceBoneName }, by body part. Empty if either isn't a body.
 */
export function boneMap(target, source) {
  const t = bodyOf(skinBones(target)).byKey;
  const s = bodyOf(skinBones(source)).byKey;
  const map = {};
  for (const [key, bone] of Object.entries(t)) if (s[key]) map[bone.name] = s[key].name;
  return map;
}

/**
 * A clip made for another skeleton (`source`, the model it came with), for
 * this one (`target`), matched by body part and carried across in world
 * space, as each bone's turn from its own rest pose — so a T-posed rig's clip
 * moves an A-posed one, and a Mixamo dance moves a Blender robot. Its hips' height is this model's own (a clip's hip
 * travel is in the other rig's size). Null unless most of a body matches
 * (8 parts or more: hips, legs, arms…).
 */
export function retargetAcrossRigs(clip, source, target, name = clip.name) {
  const sSkin = mainSkin(source);
  const tSkin = mainSkin(target);
  if (!sSkin || !tSkin) return null;
  const names = boneMap(target, source);
  if (Object.keys(names).length < 8) return null;
  const hip = bodyOf(skinBones(source)).byKey.hips?.name;
  if (!hip) return null;
  // each moment: how far each of the source's bones has turned from its own rest pose (in its model's
  // space), applied to the matching bone on top of this skeleton's rest pose — so neither rig's rest
  // pose (a T or an A, bones rolled one way or another) matters, only the movement
  const sBones = sSkin.skeleton.bones;
  const tBones = tSkin.skeleton.bones;
  const bySource = new Map(sBones.map((b) => [b.name, b]));
  const pairs = tBones.filter((b) => names[b.name] && bySource.has(names[b.name])).map((b) => [b, bySource.get(names[b.name])]);
  const depth = (b) => { let d = 0; for (let n = b; n; n = n.parent) d++; return d; };
  pairs.sort((a, b) => depth(a[0]) - depth(b[0])); // parents first
  const restore = [];
  source.traverse((n) => restore.push([n, n.position.clone(), n.quaternion.clone(), n.scale.clone()]));
  for (const b of tBones) restore.push([b, b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
  const rel = (root, node, out) => {
    const r = root.getWorldQuaternion(_rq).invert();
    return node.getWorldQuaternion(out).premultiply(r);
  };
  // rest poses, in each model's own space
  sSkin.skeleton.pose();
  tSkin.skeleton.pose();
  source.updateMatrixWorld(true);
  target.updateMatrixWorld(true);
  const sRest = new Map(pairs.map(([, s]) => [s, rel(source, s, new THREE.Quaternion())]));
  const tRest = new Map(pairs.map(([t]) => [t, rel(target, t, new THREE.Quaternion())]));
  const tLocalRest = new Map(tBones.map((b) => [b, b.quaternion.clone()]));
  const mixer = new THREE.AnimationMixer(source);
  const fps = 30;
  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const quats = pairs.map(() => new Float32Array(frames * 4));
  const times = new Float32Array(frames);
  const want = new THREE.Quaternion();
  const parentRel = new THREE.Quaternion();
  try {
    // once, held at its end: a looping clip at exactly its length is back at its start
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    for (let f = 0; f < frames; f++) {
      const t = Math.min(clip.duration, f / fps);
      mixer.setTime(t);
      source.updateMatrixWorld(true);
      for (const b of tBones) b.quaternion.copy(tLocalRest.get(b));
      target.updateMatrixWorld(true);
      pairs.forEach(([tb, sb], k) => {
        // the source's turn from rest, onto the target's rest
        rel(source, sb, want).multiply(_rq2.copy(sRest.get(sb)).invert());
        want.multiply(tRest.get(tb));
        // into its parent's space, as the parent is now
        rel(target, tb.parent, parentRel).invert();
        tb.quaternion.copy(parentRel.multiply(want));
        tb.updateMatrixWorld(true);
        tb.quaternion.toArray(quats[k], f * 4);
      });
      times[f] = t;
    }
  } finally {
    mixer.stopAllAction();
    mixer.uncacheRoot(source);
    for (const [n, p, q, sc] of restore) { n.position.copy(p); n.quaternion.copy(q); n.scale.copy(sc); }
    target.updateMatrixWorld(true);
    source.updateMatrixWorld(true);
  }
  const moved = pairs.map(([b]) => b);
  // named as nodes, for a player rooted at the model
  const tracks = moved.map((b, k) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, quats[k]));
  if (!tracks.length) return null;
  return new THREE.AnimationClip(name, clip.duration, tracks);
}
