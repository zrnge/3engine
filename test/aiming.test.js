// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { CameraRig } from '../src/cameras.js';
import { Entity } from '../src/entity.js';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';
import { CONTROL_ACTIONS, ACTION_GROUPS, normalizeControl } from '../src/controls.js';
import { EVENTS } from '../src/rules.js';
import { AnimationPlayer } from '../src/animation.js';
import { crosshairShows, normalizeCrosshair } from '../src/game-ui.js';
import { normalizeViewModel, aimPoseOf, heldPose, fitViewModel, startingAim } from '../src/view-model.js';
import { normalizeGroups, matchesWho, allGroups } from '../src/groups.js';
import { COMPONENTS } from '../src/components.js';

/** Input the control runtime reads, driven by hand. */
function fakeInput() {
  return {
    _down: new Set(), _pressed: new Set(), _mouseDown: new Set(), _tapped: new Set(),
    mouseNDC: { x: 0, y: 0 }, pointerLocked: false,
    isDown(c) { return this._down.has(c); },
    wasPressed(c) { return this._pressed.has(c); },
    mouseDown(b) { return this._mouseDown.has(b); },
    mouseTapped(b) { return this._tapped.has(b); },
    mouseClicked() { return false; },
    virtualDown() { return false; },
    virtualPressed() { return false; },
    hold(...codes) { for (const c of codes) { this._down.add(c); this._pressed.add(c); } },
    let(...codes) { for (const c of codes) this._down.delete(c); },
    endFrame() { this._pressed.clear(); this._tapped.clear(); },
  };
}

const still = { wheel: 0, pointerDelta: { dx: 0, dy: 0 }, pointerLocked: false, isDown: () => false };

function world(controls, { mode = 'fps' } = {}) {
  const rig = new CameraRig(new THREE.PerspectiveCamera(60, 1, 0.1, 1000), document.createElement('canvas'));
  const engine = {
    entities: [], variables: new VariableStore(), physics: new PhysicsWorld(), input: fakeInput(),
    scene: new THREE.Scene(), cameraRig: rig, camera: rig.camera, hero: null, time: 0,
    get playerEntity() { return this.hero; },
    playSound: vi.fn(),
    remove(e) {
      const i = this.entities.indexOf(e);
      if (i !== -1) this.entities.splice(i, 1);
      this.scene.remove(e.object3D);
    },
    addBehavior() {}, removeBehavior() {},
  };
  engine.gameplay = new Gameplay(engine);
  engine.gameplay.spawnPrefab = (name, p) => add(engine, `${name} ${engine.entities.length}`, { ...p, size: 0.2 });
  engine.hero = add(engine, 'Hero', { body: { type: 'dynamic', friction: 0, gravity: 0 } });
  engine.gameplay.controls.load(controls);
  rig.setMode(mode, { target: engine.hero.object3D });
  return engine;
}

function add(engine, name, { x = 0, y = 0, z = 0, size = 1, body = null } = {}) {
  const e = new Entity(new THREE.Mesh(new THREE.BoxGeometry(size, size, size)));
  e.object3D.name = name;
  e.object3D.position.set(x, y, z);
  engine.entities.push(e);
  engine.scene.add(e.object3D);
  if (body) {
    e.rigidBody = new RigidBody(body);
    engine.physics.register(e);
  }
  return e;
}

function tick(engine, frames = 1, { camera = true } = {}) {
  for (let i = 0; i < frames; i++) {
    const dt = 1 / 60;
    engine.time += dt;
    engine.scene.updateMatrixWorld(true);
    engine.gameplay.update(dt, engine.time);
    if (camera) engine.cameraRig.update(dt, still);
    engine.camera.updateMatrixWorld();
    engine.input.endFrame();
  }
}

const aimControl = (action = {}, inputs = [{ type: 'mouse', button: 'right' }]) => ({ inputs, target: 'player', action: { type: 'aim', ...action } });
const walk = { inputs: [{ type: 'key', code: 'KeyW' }], target: 'player', action: { type: 'move', direction: 'forward', speed: 8 } };
const speedOf = (e) => Math.hypot(e.rigidBody.velocity.x, e.rigidBody.velocity.z);

describe('the Aim control — nothing aims until a game adds one', () => {
  it('is a control like any other, in its own group, with nothing bound by default', () => {
    expect(ACTION_GROUPS).toContain('Aim & shoot');
    for (const t of ['aim', 'shoot', 'hitscan', 'recoil']) expect(CONTROL_ACTIONS[t].group).toBe('Aim & shoot');
    const c = normalizeControl(aimControl());
    expect(c.action).toMatchObject({ press: 'while held', zoom: 20, lookSpeed: 0.6, moveSpeed: 0.6, crosshair: 'keep', sprint: false, clip: '' });
  });

  it('while held: zooms in, slows the mouse and the walk — and lets go of it all', () => {
    const engine = world([walk, aimControl()]);
    const rig = engine.cameraRig;
    engine.input.hold('KeyW');
    tick(engine, 60);
    expect(speedOf(engine.hero)).toBeCloseTo(8, 1);
    expect(rig.camera.fov).toBeCloseTo(60, 5);

    engine.input._mouseDown.add(2);
    tick(engine, 60);
    expect(engine.gameplay.controls.aiming).toBeTruthy();
    expect(rig.camera.fov).toBeCloseTo(40, 3);
    expect(rig._aimLookScale()).toBeCloseTo(0.6, 5);
    expect(speedOf(engine.hero)).toBeCloseTo(4.8, 1);

    engine.input._mouseDown.delete(2);
    tick(engine, 60);
    expect(engine.gameplay.controls.aiming).toBe(null);
    expect(rig.camera.fov).toBeCloseTo(60, 5);
    expect(rig._aimLookScale()).toBe(1);
    expect(speedOf(engine.hero)).toBeCloseTo(8, 1);
  });

  it('eases in over "Takes" seconds', () => {
    const engine = world([aimControl({ time: 0.5 })]);
    engine.input._mouseDown.add(2);
    tick(engine, 15); // a quarter of a second
    expect(engine.cameraRig.aimBlend).toBeGreaterThan(0.2);
    expect(engine.cameraRig.aimBlend).toBeLessThan(0.8);
    tick(engine, 30);
    expect(engine.cameraRig.aimBlend).toBe(1);
  });

  it('"press on/off": one press aims, the next stops', () => {
    const engine = world([aimControl({ press: 'press on/off' }, [{ type: 'key', code: 'KeyQ' }])]);
    engine.input.hold('KeyQ'); tick(engine); engine.input.let('KeyQ');
    tick(engine, 30);
    expect(engine.gameplay.controls.aiming).toBeTruthy();
    engine.input.hold('KeyQ'); tick(engine); engine.input.let('KeyQ');
    tick(engine, 30);
    expect(engine.gameplay.controls.aiming).toBe(null);
  });

  it('stops a sprint, unless the Aim allows it', () => {
    const sprint = { inputs: [{ type: 'key', code: 'ShiftLeft' }], target: 'player', action: { type: 'sprint', multiplier: 2 } };
    for (const [allowed, expected] of [[false, 4.8], [true, 9.6]]) {
      const engine = world([walk, sprint, aimControl({ sprint: allowed })]);
      engine.input.hold('KeyW', 'ShiftLeft');
      engine.input._mouseDown.add(2);
      tick(engine, 60);
      expect(speedOf(engine.hero)).toBeCloseTo(expected, 1);
    }
  });

  it('third person: the camera moves in over the shoulder and the player turns to face the aim, even walking sideways', () => {
    const strafe = { inputs: [{ type: 'key', code: 'KeyD' }], target: 'player', action: { type: 'move', direction: 'right', speed: 4 } };
    const engine = world([strafe, aimControl({ closer: 0.5, shoulder: 0.6 })], { mode: 'follow' });
    const rig = engine.cameraRig;
    rig.followMouse = true;
    rig.followYaw = 0.8;
    rig.followLerp = 30;
    tick(engine, 60);
    const far = rig.camera.position.distanceTo(engine.hero.object3D.position);

    engine.input._mouseDown.add(2);
    engine.input.hold('KeyD');
    tick(engine, 90);
    const near = rig.camera.position.distanceTo(engine.hero.object3D.position);
    expect(near).toBeLessThan(far * 0.8);
    const look = rig.camera.getWorldDirection(new THREE.Vector3());
    const facing = engine.hero.object3D.rotation.y;
    expect(Math.cos(facing - Math.atan2(look.x, look.z))).toBeGreaterThan(0.999); // faces where the camera looks
    expect(speedOf(engine.hero)).toBeGreaterThan(1); // and still walks sideways
  });

  it('a clip plays once when aiming starts and stays on its last frame, then lets go', () => {
    const engine = world([aimControl({ clip: 'Raise' })]);
    const track = new THREE.VectorKeyframeTrack('.position', [0, 0.5], [0, 0, 0, 0, 1, 0]);
    engine.hero.object3D.userData.animations = [new THREE.AnimationClip('Raise', 0.5, [track])];
    const player = AnimationPlayer.for(engine, engine.hero.object3D);
    engine.input._mouseDown.add(2);
    tick(engine);
    player.mixer.update(2); // well past its end
    expect(player.playing).toBe('Raise');
    expect(engine.hero.object3D.position.y).toBeCloseTo(1, 3); // held at the top, not looping back
    engine.input._mouseDown.delete(2);
    tick(engine);
    expect(player.playing).toBe('');
  });

  it('the crosshair can hide while aiming down the sights', () => {
    const c = normalizeCrosshair({ style: 'cross' });
    expect(crosshairShows(c, { mode: 'fps', captured: true })).toBe(true);
    expect(crosshairShows(c, { mode: 'fps', captured: true, aimHides: true })).toBe(false);
    const engine = world([aimControl({ crosshair: 'hide' })]);
    engine.input._mouseDown.add(2);
    tick(engine, 30);
    expect(engine.cameraRig.hidesCrosshair).toBe(true);
    engine.input._mouseDown.delete(2);
    tick(engine, 30);
    expect(engine.cameraRig.hidesCrosshair).toBe(false);
  });
});

describe('shooting where you aim', () => {
  const fire = (action) => ({ inputs: [{ type: 'key', code: 'KeyF' }], target: 'player', action });
  const pull = (engine) => { engine.input.hold('KeyF'); tick(engine); engine.input.let('KeyF'); };

  it('an instant hit takes Health off what is in the middle of the view and runs its "I\'m shot" rules', () => {
    expect(EVENTS.shot.label).toBeTruthy();
    const engine = world([fire({ type: 'hitscan', damage: 1 })]);
    const can = add(engine, 'Can', { y: 1.1, z: -10 });
    engine.gameplay.components.add(can, 'health', { max: 3, destroyAtZero: false });
    engine.gameplay.rules.setFor(can, [{ when: { type: 'shot', who: 'player' }, if: [], do: [{ type: 'changeVariable', name: 'hits', by: 1 }] }]);
    tick(engine, 2);
    pull(engine);
    const health = engine.gameplay.components.listFor(can).find((c) => c.type === 'health');
    expect(health.state.current).toBe(2);
    expect(engine.variables.get('hits')).toBe(1);
    expect(engine.gameplay.controls.lastShot.hit).toBe('Can');
  });

  it('passes through hidden things and trigger zones, but not walls', () => {
    const engine = world([fire({ type: 'hitscan' })]);
    add(engine, 'Can', { y: 1.1, z: -10 });
    add(engine, 'Ghost', { y: 1.1, z: -4 }).object3D.visible = false;
    add(engine, 'Zone', { y: 1.1, z: -5, body: { type: 'static', isTrigger: true } });
    tick(engine, 2);
    pull(engine);
    expect(engine.gameplay.controls.lastShot.hit).toBe('Can');
    add(engine, 'Wall', { y: 1.1, z: -7 });
    pull(engine);
    expect(engine.gameplay.controls.lastShot.hit).toBe('Wall');
  });

  it('first person: a shot prefab aimed with the camera flies up when you look up', () => {
    const engine = world([fire({ type: 'shoot', prefab: 'Bullet', speed: 20, aim: 'camera' })]);
    engine.cameraRig.pitch = 0.5;
    tick(engine, 2);
    pull(engine);
    const bullet = engine.entities.find((e) => e.object3D.name.startsWith('Bullet'));
    const v = bullet.rigidBody.velocity;
    expect(v.length()).toBeCloseTo(20, 3);
    expect(v.y / 20).toBeCloseTo(Math.sin(0.5), 2);
  });

  it('"facing" (the default for Shoot prefab) still shoots level, the way the shooter faces', () => {
    const engine = world([fire({ type: 'shoot', prefab: 'Bullet', speed: 10 })], { mode: 'orbit' });
    engine.hero.object3D.rotation.y = Math.PI / 2; // facing +X
    tick(engine, 2);
    pull(engine);
    const bullet = engine.entities.find((e) => e.object3D.name.startsWith('Bullet'));
    expect(bullet.rigidBody.velocity.x).toBeCloseTo(10, 5);
    expect(bullet.rigidBody.velocity.y).toBeCloseTo(0, 5);
    expect(bullet.object3D.position.x).toBeCloseTo(1.2, 5);
  });

  it('third person: aimed with the camera, it hits what the camera centres on — not a crate between camera and player', () => {
    const engine = world([fire({ type: 'hitscan', aim: 'camera' })], { mode: 'follow' });
    const rig = engine.cameraRig;
    Object.assign(rig, { followHeight: 1, followLookUp: 1, followOffset: 6, followYaw: 0, followMouse: true, followLerp: 60, followAvoidWalls: false });
    add(engine, 'Can', { y: 1, z: 10 });
    add(engine, 'Crate', { y: 1, z: -3 });
    tick(engine, 60);
    pull(engine);
    expect(engine.gameplay.controls.lastShot.hit).toBe('Can');
  });

  it('aimed with the pointer (top-down): shoots level towards where the mouse points, and turns to it', () => {
    const engine = world([fire({ type: 'shoot', prefab: 'Bullet', speed: 10, aim: 'pointer' })], { mode: 'orbit' });
    engine.camera.position.set(0, 20, 10);
    engine.camera.lookAt(0, 0, 0);
    engine.camera.updateMatrixWorld();
    engine.input.mouseNDC = { x: 0.6, y: 0 }; // right of the player on screen
    engine.input.hold('KeyF');
    tick(engine, 1, { camera: false });
    const bullet = engine.entities.find((e) => e.object3D.name.startsWith('Bullet'));
    const v = bullet.rigidBody.velocity;
    expect(v.x).toBeGreaterThan(5);
    expect(v.y).toBeCloseTo(0, 5);
    expect(Math.sin(engine.hero.object3D.rotation.y)).toBeGreaterThan(0.5);
  });

  it('"Shots per second" keeps firing while held, no faster', () => {
    const engine = world([fire({ type: 'hitscan', rate: 5, damage: 1 })]);
    const can = add(engine, 'Can', { y: 1.1, z: -10 });
    engine.gameplay.components.add(can, 'health', { max: 100, destroyAtZero: false });
    tick(engine, 2);
    engine.input.hold('KeyF');
    tick(engine, 60); // one second
    const left = engine.gameplay.components.listFor(can).find((c) => c.type === 'health').state.current;
    expect(100 - left).toBeGreaterThanOrEqual(5);
    expect(100 - left).toBeLessThanOrEqual(6);
  });

  it('an impact prefab appears where it hits, and goes', () => {
    const engine = world([fire({ type: 'hitscan', impact: 'Spark', impactLife: 0.5 })]);
    add(engine, 'Can', { y: 1.1, z: -10 });
    tick(engine, 2);
    pull(engine);
    const spark = engine.entities.find((e) => e.object3D.name.startsWith('Spark'));
    expect(spark.object3D.position.z).toBeCloseTo(-9.5, 3);
    tick(engine, 40);
    expect(engine.entities.includes(spark)).toBe(false);
  });
});

describe('what a shot can hit: anything, the player, a group, or one object', () => {
  const fire = (action) => ({ inputs: [{ type: 'key', code: 'KeyF' }], target: 'player', action: { type: 'hitscan', ...action } });
  const pull = (engine) => { engine.input.hold('KeyF'); tick(engine); engine.input.let('KeyF'); };
  const healthOf = (engine, e) => engine.gameplay.components.listFor(e).find((c) => c.type === 'health')?.state.current;
  const target = (engine, name, pos, groups) => {
    const e = add(engine, name, pos);
    if (groups) e.groups = groups;
    engine.gameplay.components.add(e, 'health', { max: 5, destroyAtZero: false });
    return e;
  };

  it('groups are matched by name, whatever the case; a name or "any" as before', () => {
    const engine = world([]);
    const e = add(engine, 'Grunt');
    e.groups = normalizeGroups(' Enemies, robots ,enemies,');
    expect(e.groups).toEqual(['Enemies', 'robots']);
    expect(matchesWho('group:enemies', e, engine)).toBe(true);
    expect(matchesWho('group:Targets', e, engine)).toBe(false);
    expect(matchesWho('grunt', e, engine)).toBe(true);
    expect(matchesWho('any', e, engine)).toBe(true);
    expect(matchesWho('player', engine.hero, engine)).toBe(true);
    expect(allGroups(engine.entities, [{ groups: ['Targets'] }])).toEqual(['Enemies', 'robots', 'Targets']);
  });

  it('"Can hit" a group: a friend in the way stops the shot — or, going through, is passed by', () => {
    const engine = world([fire({ hits: 'group:Enemies', damage: 1 })]);
    const friend = target(engine, 'Friend', { y: 1.1, z: -5 }, ['Friends']);
    const enemy = target(engine, 'Grunt', { y: 1.1, z: -10 }, ['Enemies']);
    tick(engine, 2);
    pull(engine);
    expect(engine.gameplay.controls.lastShot).toMatchObject({ hit: null, blockedBy: 'Friend' });
    expect(healthOf(engine, friend)).toBe(5); // not hurt: it isn't something this shot can hit
    engine.gameplay.controls.list[0].action.through = true;
    pull(engine);
    expect(engine.gameplay.controls.lastShot.hit).toBe('Grunt');
    expect(healthOf(engine, enemy)).toBe(4);
    expect(healthOf(engine, friend)).toBe(5);
  });

  it('"Can hit" one object by name; nothing past Range is hit', () => {
    const engine = world([fire({ hits: 'Boss', range: 8 })]);
    target(engine, 'Boss', { y: 1.1, z: -10 });
    tick(engine, 2);
    pull(engine);
    expect(engine.gameplay.controls.lastShot.hit).toBe(null); // 10 m away, reaches 8
    engine.gameplay.controls.list[0].action.range = 20;
    pull(engine);
    expect(engine.gameplay.controls.lastShot.hit).toBe('Boss');
  });

  it('a blast ("Also hits within") hits what it can hit near where the shot lands — not the rest', () => {
    const engine = world([fire({ hits: 'group:Enemies', splash: 3, damage: 2 })]);
    const a = target(engine, 'A', { y: 1.1, z: -10 }, ['Enemies']);
    const b = target(engine, 'B', { x: 2, y: 1.1, z: -10 }, ['Enemies']);
    const far = target(engine, 'Far', { x: 8, y: 1.1, z: -10 }, ['Enemies']);
    const crate = target(engine, 'Crate', { x: -2, y: 1.1, z: -10 });
    tick(engine, 2);
    pull(engine);
    expect(engine.gameplay.controls.lastShot).toMatchObject({ hit: 'A', splashed: ['B'] });
    expect([a, b, far, crate].map((e) => healthOf(engine, e))).toEqual([3, 3, 5, 5]);
  });

  it('aimed with the pointer: hits what the mouse is on, and the shooter turns to it', () => {
    const engine = world([fire({ aim: 'pointer' })], { mode: 'orbit' });
    target(engine, 'Left', { x: -4, z: 0 });
    target(engine, 'Right', { x: 4, z: 0 });
    engine.camera.position.set(0, 20, 10);
    engine.camera.lookAt(0, 0, 0);
    engine.camera.updateMatrixWorld();
    const onScreen = (x) => new THREE.Vector3(x, 0, 0).project(engine.camera);
    const p = onScreen(4);
    engine.input.mouseNDC = { x: p.x, y: p.y };
    engine.input.hold('KeyF');
    tick(engine, 1, { camera: false });
    expect(engine.gameplay.controls.lastShot.hit).toBe('Right');
    expect(Math.sin(engine.hero.object3D.rotation.y)).toBeGreaterThan(0.9);
  });

  it('a Damager (a bullet prefab) and an "I\'m shot" rule take a group too', () => {
    expect(COMPONENTS.damager.props.who.type).toBe('who');
    expect(EVENTS.shot.props.who.type).toBe('who');
    expect(CONTROL_ACTIONS.hitscan.props.hits.type).toBe('who');
  });
});

describe('what a hit does: after enough damage, hide it, move it, animate it', () => {
  const fire = { inputs: [{ type: 'key', code: 'KeyF' }], target: 'player', action: { type: 'hitscan', damage: 1 } };
  const pull = (engine, times = 1) => {
    for (let i = 0; i < times; i++) { engine.input.hold('KeyF'); tick(engine); engine.input.let('KeyF'); }
  };
  const health = (engine, e) => engine.gameplay.components.listFor(e).find((c) => c.type === 'health');

  it('Health "When it runs out": hide — after the tenth hit it is gone from sight and out of the way', () => {
    const engine = world([fire]);
    const can = add(engine, 'Can', { y: 1.1, z: -10, body: { type: 'static' } });
    engine.gameplay.components.add(can, 'health', { max: 10, atZero: 'hide' });
    tick(engine, 2);
    pull(engine, 9);
    expect(can.object3D.visible).toBe(true);
    pull(engine);
    tick(engine);
    expect(can.object3D.visible).toBe(false);
    expect(engine.physics.bodyFor(can)).toBe(null); // nothing bumps into it any more
    expect(engine.entities.includes(can)).toBe(true); // hidden, not destroyed
    pull(engine);
    expect(engine.gameplay.controls.lastShot.hit).toBe(null); // and shots pass where it was
  });

  it('"After (s)" waits before it goes — time for a falling-over animation', () => {
    const engine = world([fire]);
    const can = add(engine, 'Can', { y: 1.1, z: -10 });
    engine.gameplay.components.add(can, 'health', { max: 1, atZero: 'destroy', delay: 0.5 });
    tick(engine, 2);
    pull(engine);
    tick(engine, 10);
    expect(engine.entities.includes(can)).toBe(true);
    tick(engine, 30);
    expect(engine.entities.includes(can)).toBe(false);
  });

  it('old saves: "Destroy at 0" off means nothing happens at 0', () => {
    const engine = world([]);
    const e = add(engine, 'Old');
    expect(engine.gameplay.components.add(e, 'health', { max: 2, destroyAtZero: false }).props.atZero).toBe('nothing');
    expect(engine.gameplay.components.add(add(engine, 'Old2'), 'health', { destroyAtZero: true }).props.atZero).toBe('destroy');
  });

  it('rules: "My health runs out" moves it to a respawn point and plays its clip; "I\'m hurt" counts each hit', () => {
    const engine = world([fire]);
    const dummy = add(engine, 'Dummy', { y: 1.1, z: -10 });
    add(engine, 'Respawn', { x: 20, y: 0, z: 20 });
    dummy.object3D.userData.animations = [new THREE.AnimationClip('Fall', 1, [new THREE.NumberKeyframeTrack('.rotation[x]', [0, 1], [0, 1.5])])];
    engine.gameplay.components.add(dummy, 'health', { max: 3, atZero: 'nothing' });
    engine.gameplay.rules.setFor(dummy, [
      { when: { type: 'hurt', who: 'player' }, if: [], do: [{ type: 'changeVariable', name: 'hurts', by: 1 }] },
      { when: { type: 'healthOut', who: 'any' }, if: [], do: [
        { type: 'playAnimation', clip: 'Fall', target: 'self' },
        { type: 'moveObject', how: 'to object', object: 'Respawn', seconds: 0 },
      ] },
    ]);
    tick(engine, 2);
    pull(engine, 2);
    expect(engine.variables.get('hurts')).toBe(2);
    expect(dummy.object3D.position.x).toBe(0);
    pull(engine);
    expect(engine.variables.get('hurts')).toBe(3);
    expect(dummy.object3D.position.toArray()).toEqual([20, 0, 20]);
    expect(AnimationPlayer.for(engine, dummy.object3D).playing).toBe('Fall');
  });

  it('the condition "My health is": a rule on "I\'m shot" that only acts when it is low', () => {
    const engine = world([fire]);
    const boss = add(engine, 'Boss', { y: 1.1, z: -10 });
    engine.gameplay.components.add(boss, 'health', { max: 5, atZero: 'nothing' });
    engine.gameplay.rules.setFor(boss, [{ when: { type: 'shot', who: 'player' },
      if: [{ type: 'health', op: '<=', value: 2 }], do: [{ type: 'setVariable', name: 'enraged', value: 1 }] }]);
    tick(engine, 2);
    pull(engine, 2);
    expect(engine.variables.get('enraged', 0)).toBe(0);
    pull(engine);
    expect(health(engine, boss).state.current).toBe(2);
    expect(engine.variables.get('enraged', 0)).toBe(1);
  });

  it('"Move object" by an offset, sliding there over its seconds', () => {
    const engine = world([]);
    const door = add(engine, 'Door', { x: 1 });
    engine.gameplay.rules.setFor(door, [{ when: { type: 'start' }, if: [], do: [{ type: 'moveObject', how: 'by', y: 3, seconds: 1 }] }]);
    engine.gameplay.start();
    tick(engine, 30);
    expect(door.object3D.position.y).toBeGreaterThan(0.5);
    expect(door.object3D.position.y).toBeLessThan(2.5);
    tick(engine, 40);
    expect(door.object3D.position.toArray()).toEqual([1, 3, 0]);
  });
});

describe('recoil', () => {
  const up = (rig) => rig.camera.getWorldDirection(new THREE.Vector3()).y;

  it('kicks the view up and the gun back, then settles', () => {
    const engine = world([]);
    const rig = engine.cameraRig;
    tick(engine, 2);
    const level = up(rig);
    rig.kick({ up: 5, side: 0, back: 0.05, recover: 0.2 });
    tick(engine);
    expect(up(rig)).toBeGreaterThan(level + 0.05);
    expect(rig.gunKick).toBeGreaterThan(0.03);
    tick(engine, 60);
    expect(up(rig)).toBeCloseTo(level, 3);
    expect(rig.gunKick).toBe(0);
    expect(rig.pitch).toBe(0); // on top of the aim, never fed into it
  });

  it('"Settles in" 0: the aim stays where the kick put it', () => {
    const engine = world([]);
    engine.cameraRig.kick({ up: 3, side: 0, recover: 0 });
    tick(engine, 30);
    expect(engine.cameraRig.pitch).toBeCloseTo(THREE.MathUtils.degToRad(3), 5);
  });

  it('is a rule action too, and a control on the same input as a shot', () => {
    const engine = world([{ inputs: [{ type: 'key', code: 'KeyF' }], target: 'player', action: { type: 'recoil', up: 2, recover: 0.3 } }]);
    tick(engine, 2);
    engine.input.hold('KeyF');
    tick(engine);
    expect(engine.cameraRig.gunKick).toBeGreaterThan(0);
  });
});

describe('held in view: an aiming place', () => {
  const vm = normalizeViewModel({ position: [0.22, -0.28, -0.6], rotation: [0, 180, 0], scale: 1 });

  it('without its own, aiming brings it to the middle and up', () => {
    expect(vm.aim).toBeUndefined(); // nothing saved that wasn't set
    expect(aimPoseOf(vm).position).toEqual([0, -0.14, -0.6]);
  });

  it('is drawn between the two as aiming eases in, and kicked back by recoil', () => {
    const own = normalizeViewModel({ ...vm, aim: { position: [0, -0.1, -0.4], rotation: [0, 180, 0] } });
    expect(own.aim.position).toEqual([0, -0.1, -0.4]);
    expect(heldPose(own, { aim: 0 }).position).toEqual([0.22, -0.28, -0.6]);
    expect(heldPose(own, { aim: 1 }).position).toEqual([0, -0.1, -0.4]);
    const half = heldPose(own, { aim: 0.5 }).position;
    expect(half[0]).toBeCloseTo(0.11, 5);
    const kicked = heldPose(own, { kick: 0.05 });
    expect(kicked.position[2]).toBeCloseTo(-0.55, 5);
    expect(kicked.rotation[0]).toBeGreaterThan(0); // muzzle up
  });

  it('a gun on its own gets an aiming place in the middle; rigged arms keep theirs (their clips aim)', () => {
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.15, 0.5));
    const fit = fitViewModel(gun);
    expect(fit.aim.position[0]).toBeCloseTo(fit.position[0] - 0.22, 5);
    expect(startingAim(gun, fit).position).toEqual(aimPoseOf({ position: fit.position, rotation: fit.rotation }).position);
  });
});

describe('firing while aiming', () => {
  const clips = () => [
    new THREE.AnimationClip('Raise', 0.5, [new THREE.VectorKeyframeTrack('.position', [0, 0.5], [0, 0, 0, 0, 1, 0])]),
    new THREE.AnimationClip('Kick', 0.3, [new THREE.VectorKeyframeTrack('.position', [0, 0.15, 0.3], [0, 0, 0, 0, 0, -0.5, 0, 0, 0])]),
  ];
  const shootKey = (extra = {}) => ({ inputs: [{ type: 'key', code: 'KeyF' }], target: 'player', action: { type: 'playAnimation', clip: 'Kick', ...extra } });

  it('a shot fires, and its clip plays on top of the aiming pose instead of dropping the gun', () => {
    const engine = world([
      aimControl({ clip: 'Raise' }),
      shootKey(),
      { inputs: [{ type: 'key', code: 'KeyF' }], target: 'player', action: { type: 'hitscan' } },
    ]);
    add(engine, 'Can', { y: 1.1, z: -10 });
    engine.hero.object3D.userData.animations = clips();
    const player = AnimationPlayer.for(engine, engine.hero.object3D);
    engine.input._mouseDown.add(2);
    tick(engine, 2);
    player.mixer.update(1); // raised
    engine.input.hold('KeyF');
    tick(engine);
    engine.input.let('KeyF');
    expect(engine.gameplay.controls.lastShot.hit).toBe('Can'); // it fired
    expect(player.playing).toBe('Raise');                    // still aiming
    expect(player.layered).toBe('Kick');                     // the shot's clip on top
    player.mixer.update(0.15);
    const p = engine.hero.object3D.position;
    expect(p.y).toBeCloseTo(1, 3);    // the raised pose
    expect(p.z).toBeCloseTo(-0.5, 3); // plus the kick
    player.mixer.update(0.5);
    tick(engine);
    expect(player.layered).toBe('');
    expect(p.z).toBeCloseTo(0, 3);
    expect(player.playing).toBe('Raise');
  });

  it('a held clip set to "Cut off others" cuts in once, not every frame (it used to cut every shot short)', () => {
    const engine = world([
      { inputs: [{ type: 'mouse', button: 'right' }], target: 'player', action: { type: 'playAnimation', clip: 'Raise', mode: 'while held', interrupt: true } },
      shootKey({ interrupt: true }),
    ]);
    engine.hero.object3D.userData.animations = clips();
    const player = AnimationPlayer.for(engine, engine.hero.object3D);
    engine.input._mouseDown.add(2);
    tick(engine, 2);
    engine.input.hold('KeyF');
    tick(engine);
    engine.input.let('KeyF');
    tick(engine, 3);
    expect(player.playing).toBe('Kick');
  });
});

describe('Play animation "while held, once"', () => {
  it('plays through and stays on its last frame while held', () => {
    const engine = world([{ inputs: [{ type: 'key', code: 'KeyR' }], target: 'player', action: { type: 'playAnimation', clip: 'Raise', mode: 'while held, once' } }]);
    const track = new THREE.VectorKeyframeTrack('.position', [0, 0.5], [0, 0, 0, 0, 1, 0]);
    engine.hero.object3D.userData.animations = [new THREE.AnimationClip('Raise', 0.5, [track])];
    const player = AnimationPlayer.for(engine, engine.hero.object3D);
    engine.input.hold('KeyR');
    tick(engine);
    player.mixer.update(3);
    tick(engine);
    expect(player.playing).toBe('Raise');
    expect(engine.hero.object3D.position.y).toBeCloseTo(1, 3);
  });
});
