// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  AnimationPlayer, clipIndex, clipNames, retargetClip, cutClip, composeClips, uniqueClipName,
} from '../src/animation.js';
import { ACTIONS } from '../src/rules.js';
import { ControlRuntime, normalizeControl, CONTROL_ACTIONS } from '../src/controls.js';
import { cloneModel } from '../src/loader.js';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { normalizeViewModel, fitViewModel, renderWithViewModels, VIEW_LAYER } from '../src/view-model.js';
import { Entity } from '../src/entity.js';

/** A model with clips of the given names and lengths (seconds). */
function model(clips) {
  const o = new THREE.Object3D();
  o.name = 'Thing';
  o.userData.animations = Object.entries(clips).map(([name, seconds]) =>
    new THREE.AnimationClip(name, seconds, [new THREE.NumberKeyframeTrack('.position[x]', [0, seconds], [0, 1])]));
  return o;
}
const engineWith = () => ({ mixers: [] });
const run = (engine, seconds, step = 1 / 60) => {
  for (let t = 0; t < seconds; t += step) for (const m of engine.mixers) m.mixer.update(step);
};

describe('finding a clip', () => {
  const clips = model({ 'Rifle Idle': 1, Idle: 1, Walking: 1, WalkJump: 1 }).userData.animations;
  it('exact name first, then the start of a name, then anywhere in it — ignoring case', () => {
    expect(clipIndex(clips, 'idle')).toBe(1);
    expect(clipIndex(clips, 'walk')).toBe(2);
    expect(clipIndex(clips, 'jump')).toBe(3);
    expect(clipIndex(clips, 2)).toBe(2);
    expect(clipIndex(clips, 'reload')).toBe(-1);
    expect(clipIndex(clips, '')).toBe(-1);
  });
  it('lists a model\'s clips in its file\'s order', () => {
    expect(clipNames(model({ B: 1, A: 1 }))).toEqual(['B', 'A']);
  });
});

describe('AnimationPlayer', () => {
  it('one player per model, shared by everything that animates it', () => {
    const engine = engineWith();
    const o = model({ A: 1 });
    expect(AnimationPlayer.for(engine, o)).toBe(AnimationPlayer.for(engine, o));
    expect(engine.mixers).toHaveLength(1);
  });

  it('an action clip plays over movement once, then hands back', () => {
    const engine = engineWith();
    const p = AnimationPlayer.for(engine, model({ Stand: 2, Fire: 0.3 }));
    p.setBase('Stand');
    expect(p.playing).toBe('Stand');
    expect(p.play('Fire')).toBe(true);
    expect(p.playing).toBe('Fire');
    p.setBase('Stand'); // movement keeps asking — it waits
    run(engine, 0.5);
    expect(p.playing).toBe('Stand');
  });

  it('firing again restarts; a different clip waits for one still playing unless it may cut in', () => {
    const engine = engineWith();
    const p = AnimationPlayer.for(engine, model({ Fire: 0.3, Reload: 1.5 }));
    p.play('Reload');
    run(engine, 0.2);
    expect(p.play('Fire')).toBe(false); // mid-reload: let it finish
    expect(p.playing).toBe('Reload');
    expect(p.play('Fire', { interrupt: true })).toBe(true);
    run(engine, 0.1);
    expect(p.play('Fire')).toBe(true); // the same one again: restart
  });

  it('loops until stopped; held clips go back when released', () => {
    const engine = engineWith();
    const p = AnimationPlayer.for(engine, model({ Walk: 1, Dance: 0.5, Aim: 0.4 }));
    p.setBase('Walk');
    p.play('Dance', { mode: 'loop' });
    run(engine, 2);
    expect(p.playing).toBe('Dance');
    p.stop('Walk'); // not what is playing: ignored
    expect(p.playing).toBe('Dance');
    p.stop();
    expect(p.playing).toBe('Walk');
    p.play('Aim', { mode: 'hold' });
    run(engine, 1);
    expect(p.playing).toBe('Aim');
    p.release('Aim');
    expect(p.playing).toBe('Walk');
  });

  it('reset stops everything; dispose also leaves the engine', () => {
    const engine = engineWith();
    const p = AnimationPlayer.for(engine, model({ A: 1 }));
    p.setBase('A');
    p.reset();
    expect(p.playing).toBe('');
    p.dispose(engine);
    expect(engine.mixers).toHaveLength(0);
  });
});

describe('Play animation — a control or a rule action', () => {
  const api = (target) => ({ resolveTarget: (sel, self) => (!sel || sel === 'self' ? self : target) });

  it('plays the clip on the object, with its sound', () => {
    const engine = { ...engineWith(), playSound: vi.fn() };
    const entity = { object3D: model({ Shoot: 0.2 }) };
    ACTIONS.playAnimation.run({ action: { clip: 'Shoot', target: 'self', mode: 'once', speed: 1, sound: 'bang' }, entity, engine, api: api() });
    expect(engine.mixers[0].playing).toBe('Shoot');
    expect(engine.playSound).toHaveBeenCalledWith(entity, 'bang');
  });

  it('is offered to controls, in its own group, with a clip field', () => {
    expect(CONTROL_ACTIONS.playAnimation.group).toBe('Animation');
    expect(CONTROL_ACTIONS.playAnimation.props.clip.type).toBe('clip');
    expect(CONTROL_ACTIONS.stopAnimation).toBeTruthy();
  });

  function runtimeWith(controls, entity) {
    const input = {
      held: new Set(), clicked: new Set(), tapped: new Set(), pointerLocked: false,
      isDown: (c) => input.held.has(c), wasPressed: () => false,
      mouseDown: (b) => input.held.has(`m${b}`), mouseClicked: (b) => input.clicked.has(b), mouseTapped: (b) => input.tapped.has(b),
    };
    const engine = { ...engineWith(), input, playerEntity: entity };
    const runtime = new ControlRuntime(engine);
    runtime.load(controls);
    const step = () => runtime.update(1 / 60, 0, api(entity));
    return { engine, input, runtime, step };
  }

  it('"while held" loops as long as the input is held, then hands back', () => {
    const entity = new Entity(model({ Idle: 1, Aim: 0.5 }));
    const { engine, input, step } = runtimeWith([{
      inputs: [{ type: 'mouse', button: 'right' }], target: 'player',
      action: { type: 'playAnimation', clip: 'Aim', mode: 'while held' },
    }], entity);
    AnimationPlayer.for(engine, entity.object3D).setBase('Idle');
    input.held.add('m2');
    step();
    run(engine, 1);
    step();
    expect(engine.mixers[0].playing).toBe('Aim');
    input.held.delete('m2');
    step();
    expect(engine.mixers[0].playing).toBe('Idle');
  });

  it('with the mouse captured (first person) a click acts on the press, not the release', () => {
    const entity = new Entity(model({ Shoot: 0.2 }));
    const { engine, input, step } = runtimeWith([normalizeControl({
      inputs: [{ type: 'mouse', button: 'left' }], target: 'player',
      action: { type: 'playAnimation', clip: 'Shoot' },
    })], entity);
    input.clicked.add(0); // pressed, not yet released
    step();
    expect(engine.mixers[0]?.playing ?? '').toBe(''); // editing view: waits for the tap
    input.pointerLocked = true;
    step();
    expect(engine.mixers[0].playing).toBe('Shoot');
  });
});

describe('rigged models', () => {
  function rigged() {
    const bone = new THREE.Bone();
    bone.name = 'Arm';
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const n = geometry.attributes.position.count;
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n).fill([1, 0, 0, 0]).flat(), 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    const root = new THREE.Group();
    root.add(bone, mesh);
    root.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton([bone]));
    return root;
  }

  it('a copied model moves its own skeleton, not the original\'s', () => {
    const original = rigged();
    const copy = cloneModel(original);
    let mesh = null;
    copy.traverse((n) => { if (n.isSkinnedMesh) mesh = n; });
    const bone = copy.getObjectByName('Arm');
    expect(mesh.skeleton.bones[0]).toBe(bone);
    bone.position.x = 5; // as an animation would
    copy.updateMatrixWorld(true);
    const v = mesh.getVertexPosition(0, new THREE.Vector3());
    expect(v.x).toBeGreaterThan(4); // the skin followed
  });

  it('a character\'s capsule is no wider than half its height, whatever its arms do', () => {
    const tpose = new Entity(new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 0.3)));
    tpose.rigidBody = new RigidBody({ type: 'dynamic', shape: 'capsule' });
    const w = new PhysicsWorld();
    w.register(tpose);
    expect(w.colliderFor(tpose).r).toBeCloseTo(0.45, 6);
  });
});

describe('held in first-person view', () => {
  it('fills in and cleans up its setting', () => {
    expect(normalizeViewModel(null)).toBeNull();
    const vm = normalizeViewModel({ position: [1, 'x', 2], scale: -3 });
    expect(vm.position).toEqual([0.22, -0.28, -0.6]);
    expect(vm.scale).toBe(1);
    expect(vm.rotation).toEqual([0, 180, 0]);
  });

  it('a first fit sizes it to fit in front of the eye', () => {
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 4));
    const vm = fitViewModel(gun);
    expect(vm.scale).toBeCloseTo(0.55 / 4, 2); // rounded to 3 figures
    expect(vm.position[2]).toBeLessThan(0); // in front
  });

  it('is drawn locked to the camera in a second pass, and left exactly where it was', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(10, 2, 5);
    scene.add(new THREE.DirectionalLight());
    const gun = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    gun.position.set(-3, 0, 0);
    gun.castShadow = true;
    scene.add(gun);
    const held = { object3D: gun, viewModel: normalizeViewModel({ position: [0, 0, -1], rotation: [0, 0, 0], scale: 1 }) };
    const passes = [];
    const renderer = {
      autoClear: true, shadowMap: { autoUpdate: true },
      clearDepth: vi.fn(),
      render: () => passes.push({ layer: camera.layers.mask, at: gun.getWorldPosition(new THREE.Vector3()).toArray(), shadow: gun.castShadow,
        lit: scene.children[0].layers.isEnabled(VIEW_LAYER) }),
    };
    renderWithViewModels(renderer, scene, camera, [held], true);
    expect(passes).toHaveLength(2);
    expect(passes[1].layer).toBe(1 << VIEW_LAYER);
    expect(passes[1].at.map((v) => +v.toFixed(3))).toEqual([10, 2, 4]); // a metre in front of the camera
    expect(passes[1].shadow).toBe(false);
    expect(passes[1].lit).toBe(true);
    expect(renderer.clearDepth).toHaveBeenCalledOnce();
    // and put back
    expect(gun.position.toArray()).toEqual([-3, 0, 0]);
    expect(gun.layers.mask).toBe(1);
    expect(gun.castShadow).toBe(true);
    expect(renderer.autoClear).toBe(true);

    passes.length = 0;
    renderWithViewModels(renderer, scene, camera, [held], false); // not first person: one normal pass
    expect(passes).toHaveLength(1);
  });
});

describe('more clips for a model: from other files, and cut from long ones', () => {
  const rig = () => {
    const root = new THREE.Group();
    const arm = new THREE.Object3D();
    arm.name = 'Arm';
    root.add(arm);
    return root;
  };
  const track = (node, times, values) => new THREE.NumberKeyframeTrack(`${node}.position[x]`, times, values);

  it('a clip from another file keeps only what moves parts this model has', () => {
    const clip = new THREE.AnimationClip('mixamo.com', 1, [track('Arm', [0, 1], [0, 1]), track('Tail', [0, 1], [0, 1])]);
    const fitted = retargetClip(clip, rig(), 'Walking');
    expect(fitted.name).toBe('Walking');
    expect(fitted.tracks.map((t) => t.name)).toEqual(['Arm.position[x]']);
    expect(retargetClip(new THREE.AnimationClip('x', 1, [track('Tail', [0, 1], [0, 1])]), rig())).toBeNull();
  });

  it('a different rig that happens to share a part name is refused', () => {
    // the robot and the blaster both have a "Body" — robot moves on a gun would be nonsense
    const other = new THREE.AnimationClip('Wave', 1, ['Arm', 'Head', 'Hip', 'Leg'].map((n) => track(n, [0, 1], [0, 1])));
    expect(retargetClip(other, rig())).toBeNull();
  });

  it('a part cut from a clip starts at 0, and begins and ends exactly where cut', () => {
    const long = new THREE.AnimationClip('Take 001', 4, [track('Arm', [0, 1, 2, 3, 4], [0, 10, 20, 30, 40])]);
    const part = cutClip(long, 'Wave', 1.5, 3);
    expect(part.name).toBe('Wave');
    expect(part.duration).toBeCloseTo(1.5, 6);
    expect([...part.tracks[0].times]).toEqual([0, 0.5, 1.5]);
    expect([...part.tracks[0].values]).toEqual([15, 20, 30]); // 15 sampled between keys
    expect(cutClip(long, 'none', 2, 2)).toBeNull();
    expect(cutClip(long, 'clamped', 3, 99).duration).toBeCloseTo(1, 6);
  });

  it('the list is the file\'s own clips, then added ones, then the parts — names kept unique', () => {
    const own = [new THREE.AnimationClip('Idle', 2, [track('Arm', [0, 2], [0, 1])])];
    const added = [new THREE.AnimationClip('Run', 1, [track('Arm', [0, 1], [0, 1])])];
    const list = composeClips(own, added, [{ from: 'Idle', name: 'Run', start: 0, end: 1 }, { from: 'Nope', name: 'x', start: 0, end: 1 }]);
    expect(list.map((c) => c.name)).toEqual(['Idle', 'Run', 'Run 2']);
    expect(list[2].tiny3).toEqual({ kind: 'cut', index: 0 });
    expect(uniqueClipName(new Set(['a', 'a 2']), 'a')).toBe('a 3');
  });
});

describe('finding the moves in a long clip', () => {
  const longModel = () => {
    const o = new THREE.Object3D();
    o.userData.animations = [new THREE.AnimationClip('allanimations', 8,
      [new THREE.NumberKeyframeTrack('.position[x]', [0, 8], [0, 80])])];
    return o;
  };

  it('holds the model still at any moment, and plays normally afterwards', () => {
    const engine = engineWith();
    const o = longModel();
    const p = AnimationPlayer.for(engine, o);
    p.pose('allanimations', 3.25);
    run(engine, 0.5); // held: time does not move it
    expect(o.position.x).toBeCloseTo(32.5, 3);
    p.play('allanimations', { mode: 'loop', interrupt: true });
    run(engine, 0.5);
    expect(o.position.x).toBeGreaterThan(1); // running from the start again
  });

  it('loops just a part, to check it before cutting — and stops cleanly', () => {
    const engine = engineWith();
    const o = longModel();
    const p = AnimationPlayer.for(engine, o);
    expect(p.previewPart('allanimations', 2, 3)).toBe(true);
    const seen = [];
    for (let i = 0; i < 90; i++) { p.mixer.update(1 / 30); seen.push(o.position.x); }
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(20 - 1e-6); // never outside 2–3 s
    expect(Math.max(...seen)).toBeLessThanOrEqual(30 + 1e-6);
    p.stop();
    expect(p._preview).toBeNull();
  });
});

describe('placing rigged first-person arms', () => {
  it('keeps their own size and puts the eye at their shoulder end, looking along them', () => {
    const bone = new THREE.Bone();
    const geometry = new THREE.BoxGeometry(0.4, 0.3, 0.8); // arms: longest front to back
    const n = geometry.attributes.position.count;
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n).fill([1, 0, 0, 0]).flat(), 4));
    const arms = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    const root = new THREE.Group();
    root.add(bone, arms);
    root.updateMatrixWorld(true);
    arms.bind(new THREE.Skeleton([bone]));
    const vm = fitViewModel(root);
    expect(vm.scale).toBe(1);
    expect(vm.rotation).toEqual([0, 180, 0]);
    // eye: near the top (y = -0.15 + 0.27), just inside the near end (z = -0.4 + 0.112)
    expect(vm.position).toEqual([0, -0.12, -0.288]);
  });
});

describe('a default clip', () => {
  it('stops when it is no longer asked for (fades out, nothing else to show)', () => {
    const engine = engineWith();
    const p = AnimationPlayer.for(engine, model({ Breathe: 2 }));
    p.setBase('Breathe');
    expect(p.playing).toBe('Breathe');
    p.setBase('');
    expect(p.playing).toBe('');
  });
});
