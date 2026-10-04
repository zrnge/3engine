// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { AnimationPlayer } from '../src/animation.js';
import { humanoidKey, findRig, boneMap, retargetAcrossRigs } from '../src/rig.js';
import { applyRig, restoreRig } from '../src/ik.js';
import { COMPONENTS, defaultProps } from '../src/components.js';
import { world } from './helpers/world.js';

// Animation: movement blended by speed, clips for states, a rig's IK (feet,
// a head that turns, root motion), and clips carried between skeletons.

/** A small humanoid skeleton, its bones named as `names` says, on a skinned mesh — standing on y = 0. */
function humanoid(names) {
  const B = (key, at, parent) => {
    const b = new THREE.Bone();
    b.name = names[key];
    b.position.set(...at);
    if (parent) parent.add(b);
    return b;
  };
  const hips = B('hips', [0, 1, 0]);
  const spine = B('spine', [0, 0.15, 0], hips);
  const chest = B('chest', [0, 0.2, 0], spine);
  const neck = B('neck', [0, 0.2, 0], chest);
  const head = B('head', [0, 0.1, 0], neck);
  const bones = [hips, spine, chest, neck, head];
  for (const [s, x] of [['L', 0.12], ['R', -0.12]]) {
    const up = B(`${s}.upperLeg`, [x, -0.05, 0], hips);
    const low = B(`${s}.lowerLeg`, [0, -0.45, 0], up);
    const foot = B(`${s}.foot`, [0, -0.5, 0], low);
    const sh = B(`${s}.shoulder`, [x * 0.8, 0.15, 0], chest);
    const arm = B(`${s}.upperArm`, [x, 0, 0], sh);
    const fore = B(`${s}.lowerArm`, [x * 2, 0, 0], arm);
    const hand = B(`${s}.hand`, [x * 2, 0, 0], fore);
    bones.push(up, low, foot, sh, arm, fore, hand);
  }
  const geo = new THREE.BoxGeometry(0.4, 1.8, 0.3).translate(0, 0.9, 0);
  const n = geo.attributes.position.count;
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: n * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
  const root = new THREE.Group();
  root.add(mesh);
  mesh.add(hips);
  mesh.bind(new THREE.Skeleton(bones));
  root.updateMatrixWorld(true);
  return { root, mesh, bone: (key) => bones.find((b) => b.name === names[key]) };
}
const MIXAMO = {
  hips: 'mixamorigHips', spine: 'mixamorigSpine', chest: 'mixamorigSpine2', neck: 'mixamorigNeck', head: 'mixamorigHead',
  'L.upperLeg': 'mixamorigLeftUpLeg', 'L.lowerLeg': 'mixamorigLeftLeg', 'L.foot': 'mixamorigLeftFoot',
  'R.upperLeg': 'mixamorigRightUpLeg', 'R.lowerLeg': 'mixamorigRightLeg', 'R.foot': 'mixamorigRightFoot',
  'L.shoulder': 'mixamorigLeftShoulder', 'L.upperArm': 'mixamorigLeftArm', 'L.lowerArm': 'mixamorigLeftForeArm', 'L.hand': 'mixamorigLeftHand',
  'R.shoulder': 'mixamorigRightShoulder', 'R.upperArm': 'mixamorigRightArm', 'R.lowerArm': 'mixamorigRightForeArm', 'R.hand': 'mixamorigRightHand',
};
const BLENDER = {
  hips: 'Hips', spine: 'Abdomen', chest: 'Torso', neck: 'Neck', head: 'Head',
  'L.upperLeg': 'UpperLegL', 'L.lowerLeg': 'LowerLegL', 'L.foot': 'FootL', 'R.upperLeg': 'UpperLegR', 'R.lowerLeg': 'LowerLegR', 'R.foot': 'FootR',
  'L.shoulder': 'ShoulderL', 'L.upperArm': 'UpperArmL', 'L.lowerArm': 'LowerArmL', 'L.hand': 'HandL',
  'R.shoulder': 'ShoulderR', 'R.upperArm': 'UpperArmR', 'R.lowerArm': 'LowerArmR', 'R.hand': 'HandR',
};

describe('reading a skeleton', () => {
  it('a bone\'s body part from its name, whichever tool named it', () => {
    const cases = {
      mixamorigLeftUpLeg: 'L.upperLeg', mixamorig7LeftForeArm_04: 'L.lowerArm', mixamorigRightHandIndex2: 'R.index2',
      UpperLegL: 'L.upperLeg', LowerArmR: 'R.lowerArm', Torso: 'chest', Abdomen: 'spine',
      Bip01_L_Thigh: 'L.upperLeg', calf_r: 'R.lowerLeg', pelvis: 'hips', 'DEF-forearmL': 'L.lowerArm',
      HeadEnd: null, PoleTargetL: null, Armature: null, Body: null,
    };
    for (const [name, key] of Object.entries(cases)) expect([name, humanoidKey(name)]).toEqual([name, key]);
  });

  it('legs, hips and head found on a rig; two rigs\' bones paired by part', () => {
    const { root } = humanoid(MIXAMO);
    const rig = findRig(root);
    expect(rig.legs.map((l) => [l.side, l.up.name, l.foot.name])).toEqual([['L', 'mixamorigLeftUpLeg', 'mixamorigLeftFoot'], ['R', 'mixamorigRightUpLeg', 'mixamorigRightFoot']]);
    expect(rig.legs[0].length).toBeCloseTo(0.95, 3);
    expect(rig.head.name).toBe('mixamorigHead');
    const other = humanoid(BLENDER).root;
    const map = boneMap(other, root);
    expect(map.UpperLegL).toBe('mixamorigLeftUpLeg');
    expect(map.Torso).toBe('mixamorigSpine2');
    expect(Object.keys(map).length).toBe(19);
  });
});

describe('movement blended by speed', () => {
  const clip = (name, d = 1) => new THREE.AnimationClip(name, d, [new THREE.NumberKeyframeTrack('.scale[x]', [0, d], [1, 2])]);
  function model() {
    const root = new THREE.Group();
    root.userData.animations = [clip('Idle', 2), clip('Walk', 1), clip('Run', 0.6), clip('Punch', 0.5), clip('Fall', 1)];
    return { root, player: new AnimationPlayer(root) };
  }
  const run = (player, opts, seconds) => { for (let t = 0; t < seconds; t += 1 / 60) { player.setMoveBlend(opts, 1 / 60); player.mixer.update(1 / 60); } };
  const base = { idle: 'Idle', walk: 'Walk', run: 'Run', walkSpeed: 2, runSpeed: 6, fade: 0.2 };

  it('standing, walking, running: each weighed by speed, eased over the blend time', () => {
    const { player } = model();
    run(player, { ...base, speed: 0 }, 0.5);
    expect(player.blendWeights).toEqual({ Idle: 1 });
    run(player, { ...base, speed: 2 }, 0.5);
    expect(player.blendWeights.Walk).toBeCloseTo(1, 2);
    run(player, { ...base, speed: 4 }, 0.5); // under "run from" (6): walking
    expect(player.blendWeights.Walk).toBeCloseTo(1, 2);
    run(player, { ...base, speed: 5.7 }, 0.5); // half way across the band round it (4.8 to 6.6)
    expect(player.blendWeights.Walk).toBeCloseTo(0.5, 2);
    expect(player.blendWeights.Run).toBeCloseTo(0.5, 2);
    expect(player.playing === 'Walk' || player.playing === 'Run').toBe(true);
    run(player, { ...base, speed: 9 }, 0.5);
    expect(player.playing).toBe('Run');
  });

  it('walking and running in step, and played as fast as it moves', () => {
    const { player } = model();
    run(player, { ...base, speed: 5.7 }, 0.9);
    const walk = player.actions[1];
    const runA = player.actions[2];
    expect((walk.time % 1) / 1).toBeCloseTo((runA.time % 0.6) / 0.6, 2); // the same moment of their stride
    const { player: p2 } = model();
    run(p2, { ...base, speed: 3 }, 0.6);
    run(p2, { ...base, run: '', speed: 3 }, 0.6); // walking only, at 1.5× its clip's speed
    expect(p2.actions[1].getEffectiveTimeScale()).toBeCloseTo(1.5, 2);
    run(p2, { ...base, run: '', speed: 3, match: false }, 0.1);
    expect(p2.actions[1].getEffectiveTimeScale()).toBeCloseTo(1, 5);
  });

  it('an action clip over it fades the mix down, and the mix comes back after; in the air, the air clip', () => {
    const { player } = model();
    run(player, { ...base, speed: 2 }, 0.5);
    player.play('Punch', { mode: 'once', fade: 0.1 });
    run(player, { ...base, speed: 2 }, 0.3);
    expect(player.playing).toBe('Punch');
    expect(player.blendWeights.Walk).toBeLessThan(0.2);
    run(player, { ...base, speed: 2 }, 0.8);
    expect(player.playing).toBe('Walk');
    expect(player.blendWeights.Walk).toBeGreaterThan(0.8);
    run(player, { ...base, air: 'Fall', inAir: true, speed: 2 }, 0.5);
    expect(player.playing).toBe('Fall');
  });
});

describe('clips for states', () => {
  it('chasing loops its clip while it lasts; dead plays once and holds its last frame', () => {
    const { engine, add, step } = world();
    const e = add('Robot', { body: { type: 'dynamic' } });
    e.object3D.userData.animations = ['Idle', 'Walk', 'Run', 'Death'].map((n) => new THREE.AnimationClip(n, 1, [new THREE.NumberKeyframeTrack('.scale[x]', [0, 1], [1, 2])]));
    engine.gameplay.components.add(e, 'animator', {
      style: 'clips', idle: 'Idle', walk: 'Walk',
      states: [{ state: 'chasing', clip: 'Run', play: 'loops' }, { state: 'dead', clip: 'Death', play: 'once, then holds' }],
    });
    engine.gameplay.start();
    step(0.2);
    const player = engine.mixers[0];
    expect(player.playing).toBe('Idle');
    engine.gameplay.setState(e, 'chasing');
    step(0.5);
    expect(player.playing).toBe('Run');
    engine.gameplay.setState(e, 'patrolling'); // a state with no clip: back to moving
    step(0.3);
    expect(player.playing).toBe('Idle');
    engine.gameplay.setState(e, 'dead');
    step(0.1);
    player.mixer.update(2); // (the test world doesn't run the players: as the engine would)
    expect(player.playing).toBe('Death');
    expect(player.actions[3].time).toBeCloseTo(1, 2); // held on its last frame
  });

  it('the field keeps only sensible rows; a component\'s default list is its own', () => {
    const schema = COMPONENTS.animator.props.states;
    expect(schema.type).toBe('stateClips');
    const a = defaultProps('animator');
    const b = defaultProps('animator');
    expect(a.states).not.toBe(b.states);
  });
});

describe('the rig after its clips', () => {
  /** A rig standing at x, on a world with what is under each foot. */
  function stand(blocks) {
    const w = world();
    for (const [x, top] of blocks) w.add('Ground', { at: [x, top - 0.5, 0], size: [0.24, 1, 2], body: { type: 'static' } });
    const { root, bone } = humanoid(MIXAMO);
    const entity = { object3D: root };
    w.engine.scene.add(root);
    root.updateMatrixWorld(true);
    w.engine.physics.step(1 / 60);
    const player = new AnimationPlayer(root);
    return { ...w, root, bone, entity, player };
  }
  const footY = (b) => b.getWorldPosition(new THREE.Vector3()).y;

  it('feet: on a step, that foot rests on it; in a dip, the hips go down so the other reaches', () => {
    const s = stand([[0.12, 0.25], [-0.12, 0]]); // the left foot over a step 25 cm up
    s.player.rig = { entity: s.entity, engine: s.engine, footIK: true };
    applyRig(s.player, 1); // (dt 1: no easing)
    expect(footY(s.bone('L.foot'))).toBeCloseTo(0.25, 2);
    expect(footY(s.bone('R.foot'))).toBeCloseTo(0, 2);
    expect(s.bone('mixamorigHips' && 'hips').position.y).toBeCloseTo(1, 5); // no lower: nothing below the ground
    restoreRig(s.player);
    expect(s.bone('L.upperLeg').quaternion.equals(new THREE.Quaternion())).toBe(true); // put back as it was
    const d = stand([[0.12, 0], [-0.12, -0.2]]); // the right foot over a dip 20 cm down
    d.player.rig = { entity: d.entity, engine: d.engine, footIK: true };
    applyRig(d.player, 1);
    expect(footY(d.bone('R.foot'))).toBeCloseTo(-0.2, 2);
    expect(footY(d.bone('L.foot'))).toBeCloseTo(0, 2);
    expect(d.bone('hips').getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(0.8, 2);
  });

  it('look at: the head turns toward it, no further than a neck turns', () => {
    const s = stand([[0.12, 0], [-0.12, 0]]);
    const facing = () => new THREE.Vector3(0, 0, 1).applyQuaternion(s.bone('head').getWorldQuaternion(new THREE.Quaternion()));
    s.player.rig = { entity: s.entity, engine: s.engine, lookAt: new THREE.Vector3(3, 1.65, 3) }; // 45° to its left
    applyRig(s.player, 1);
    const f = facing();
    expect(THREE.MathUtils.radToDeg(Math.atan2(f.x, f.z))).toBeCloseTo(45, 0);
    restoreRig(s.player);
    s.player._ik.look.identity();
    s.player.rig.lookAt = new THREE.Vector3(0, 1.65, -3); // behind it: it doesn't turn round
    applyRig(s.player, 1);
    expect(facing().z).toBeGreaterThan(0.99);
  });

  it('root motion: the hips\' travel moves the object; the hips stay over it', () => {
    const s = stand([]);
    const hips = s.bone('hips');
    const clip = new THREE.AnimationClip('Lunge', 1, [new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, 1, 0, 0, 1, 1.2])]);
    s.root.userData.animations = [clip];
    s.player.play('Lunge', { mode: 'loop' });
    s.player.rig = { entity: s.entity, engine: s.engine, rootMotion: true };
    for (let t = 0; t < 0.5; t += 1 / 60) { s.player.beforeUpdate(); s.player.mixer.update(1 / 60); s.player.afterUpdate(1 / 60); }
    expect(s.root.position.z).toBeCloseTo(0.6, 1);
    expect(Math.abs(hips.position.z)).toBeLessThan(1e-6);
  });
});

describe('one skeleton\'s clip on another', () => {
  it('a Mixamo-named clip moves a Blender-named rig\'s bones the same way', () => {
    const src = humanoid(MIXAMO);
    const dst = humanoid(BLENDER);
    const lift = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.8); // the left thigh forward
    const clip = new THREE.AnimationClip('Kick', 1, [
      new THREE.QuaternionKeyframeTrack('mixamorigLeftUpLeg.quaternion', [0, 1], [0, 0, 0, 1, ...lift.toArray()]),
    ]);
    const out = retargetAcrossRigs(clip, src.root, dst.root, 'Kick');
    expect(out).not.toBe(null);
    expect(out.tracks.some((t) => t.name === 'UpperLegL.quaternion')).toBe(true);
    const mixer = new THREE.AnimationMixer(dst.root);
    mixer.clipAction(out).play();
    mixer.update(0.999);
    dst.root.updateMatrixWorld(true);
    const q = dst.bone('L.upperLeg').quaternion;
    expect(q.angleTo(lift)).toBeLessThan(0.05);
    // the model it came from is left as it was
    expect(src.bone('L.upperLeg').quaternion.equals(new THREE.Quaternion())).toBe(true);
    // not a body: nothing
    const lone = new THREE.Group();
    expect(retargetAcrossRigs(clip, src.root, lone)).toBe(null);
  });
});
