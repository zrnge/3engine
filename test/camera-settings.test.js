// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  CameraRig, CAMERA_SETTINGS, CAMERA_FIELDS, cameraSettingsOf, applyCameraSettings,
} from '../src/cameras.js';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { Entity } from '../src/entity.js';
import { ControlRuntime, CONTROL_ACTIONS } from '../src/controls.js';
import { ACTIONS } from '../src/rules.js';

let canvas;
let rig;
let target;
beforeEach(() => {
  canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  rig = new CameraRig(new THREE.PerspectiveCamera(60, 1, 0.1, 1000), canvas);
  target = new THREE.Object3D();
  target.position.set(10, 0, 5);
  rig.fallbackTarget = target;
});

const input = (over = {}) => ({
  wheel: 0, pointerDelta: { dx: 0, dy: 0 }, pointerLocked: false, isDown: () => false, ...over,
});
const cam = () => rig.camera.position;
const settle = (n = 200) => { for (let i = 0; i < n; i++) rig.update(1 / 60, input()); };

describe('every camera has its own settings', () => {
  it('each field says what it is, and has a real range', () => {
    for (const [mode, def] of Object.entries(CAMERA_SETTINGS)) {
      expect(CameraRig.MODES).toContain(mode);
      for (const f of def.fields) {
        expect(f.label, f.key).toBeTruthy();
        expect(rig[f.key], `${mode}.${f.key} exists on the rig`).not.toBeUndefined();
        expect(f.default, `${mode}.${f.key} has a default`).not.toBeUndefined();
        expect(rig[f.key], `a new rig starts ${f.key} at its default`).toBe(f.default);
        if (f.type !== 'boolean') expect(f.min).toBeLessThan(f.max);
      }
    }
  });

  it('first person: the eye is where Eye height and Eye forward put it', () => {
    rig.setMode('fps');
    rig.eyeHeight = 1.7;
    rig.eyeForward = 0.3;
    rig.update(1 / 60, input());
    // looking down -Z (yaw 0): forward is -Z
    expect(cam().toArray().map((v) => +v.toFixed(3))).toEqual([10, 1.7, 4.7]);
  });

  it('first person: mouse speed, the look limit and invert up/down', () => {
    rig.setMode('fps');
    rig.lookSensitivity = 2;
    rig.update(1 / 60, input({ pointerDelta: { dx: 100, dy: 0 } }));
    expect(rig.yaw).toBeCloseTo(-100 * 0.0022 * 2, 6);
    rig.pitchLimit = 30;
    rig.update(1 / 60, input({ pointerDelta: { dx: 0, dy: -5000 } }));
    expect(rig.pitch).toBeCloseTo(THREE.MathUtils.degToRad(30), 6);
    rig.invertY = true;
    rig.update(1 / 60, input({ pointerDelta: { dx: 0, dy: -5000 } }));
    expect(rig.pitch).toBeCloseTo(-THREE.MathUtils.degToRad(30), 6);
  });

  it('follow: Distance behind, Height above, and To the side', () => {
    rig.rotateWithTarget = true; // behind the way it faces (+Z)
    rig.setMode('follow');
    Object.assign(rig, { followOffset: 4, followHeight: 2, followSide: 1, followLookUp: 1 });
    settle();
    const p = cam().toArray().map((v) => +v.toFixed(2));
    expect(p).toEqual([9, 2, 1]); // 4 behind (-Z), 2 up, 1 to its right (-X when facing +Z)
  });

  it('follow: the scroll wheel zooms only between Zoom closest and Zoom farthest', () => {
    rig.setMode('follow');
    Object.assign(rig, { followMin: 3, followMax: 8, followOffset: 6 });
    rig.update(1 / 60, input({ wheel: 5000 }));
    expect(rig.followOffset).toBe(8);
    rig.update(1 / 60, input({ wheel: -5000 }));
    expect(rig.followOffset).toBe(3);
  });

  it('follow: with "Mouse turns the camera", moving the mouse swings it round the target', () => {
    rig.setMode('follow');
    Object.assign(rig, { followMouse: true, followOffset: 5, followHeight: 1, followLookUp: 1, followSide: 0 });
    rig.followYaw = 0;
    settle();
    expect(cam().z).toBeCloseTo(0, 1); // behind, along -Z
    rig.update(1 / 60, input({ pointerLocked: true, pointerDelta: { dx: -Math.PI / 2 / 0.0022, dy: 0 } }));
    settle();
    const off = cam().clone().sub(target.position);
    expect(Math.hypot(off.x, off.z)).toBeCloseTo(5, 1); // still 5 away…
    expect(Math.abs(off.x)).toBeGreaterThan(4.9);       // …a quarter turn round
    expect(rig.wantsPointerLock()).toBe(true);
  });

  it('follow: "Keep out of walls" pulls the camera in front of a wall behind the target', () => {
    const world = new PhysicsWorld();
    const wall = new Entity(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 0.5)));
    wall.object3D.position.set(10, 0, 2); // 3 behind the target
    wall.rigidBody = new RigidBody({ type: 'static' });
    world.register(wall);
    rig.physics = world;
    rig.rotateWithTarget = true;
    rig.setMode('follow');
    Object.assign(rig, { followOffset: 6, followHeight: 1, followLookUp: 1, followSide: 0 });
    settle();
    expect(cam().z).toBeGreaterThan(2.25); // this side of the wall
    rig.followAvoidWalls = false;
    settle();
    expect(cam().z).toBeCloseTo(-1, 1); // through it, if you ask for that
  });

  it('fly: Speed, and Shift multiplies it', () => {
    rig.setMode('free');
    rig.flySpeed = 4;
    rig.flyFast = 5;
    const start = cam().clone();
    rig.update(1, input({ isDown: (k) => k === 'KeyW' }));
    expect(start.distanceTo(cam())).toBeCloseTo(4, 3);
    const mid = cam().clone();
    rig.update(1, input({ isDown: (k) => k === 'KeyW' || k === 'ShiftLeft' }));
    expect(mid.distanceTo(cam())).toBeCloseTo(20, 3);
  });

  it('each camera keeps its own field of view', () => {
    Object.assign(rig, { fovOrbit: 50, fovFollow: 70, fovFps: 90, fovFly: 100 });
    for (const [mode, fov] of [['follow', 70], ['fps', 90], ['free', 100], ['orbit', 50]]) {
      rig.setMode(mode);
      expect(rig.camera.fov, mode).toBe(fov);
    }
  });

  it('only cameras that look with the mouse ask to capture it — and a game can say no', () => {
    expect(rig.wantsPointerLock('orbit')).toBe(false);
    expect(rig.wantsPointerLock('follow')).toBe(false);
    expect(rig.wantsPointerLock('fps')).toBe(true);
    expect(rig.wantsPointerLock('free')).toBe(true);
    rig.captureMouse = false; // e.g. first person that turns with keys
    expect(rig.wantsPointerLock('fps')).toBe(false);
    expect(CAMERA_SETTINGS.fps.fields.some((f) => f.key === 'captureMouse')).toBe(true); // in the panel
  });
});

describe('saving camera settings', () => {
  it('every setting round-trips, clamped to its range; junk is ignored', () => {
    Object.assign(rig, { eyeHeight: 1.6, followSide: -0.75, followMouse: true, fovFps: 95, flySpeed: 22 });
    const saved = JSON.parse(JSON.stringify(cameraSettingsOf(rig)));
    expect(Object.keys(saved).sort()).toEqual(CAMERA_FIELDS.map((f) => f.key).sort());
    const other = new CameraRig(new THREE.PerspectiveCamera(), document.createElement('canvas'));
    applyCameraSettings(other, { ...saved, eyeHeight: 999, flySpeed: 'fast', nonsense: 1 });
    expect(other.eyeHeight).toBe(5);          // clamped to the slider's range
    expect(other.flySpeed).toBe(10);          // a broken number is left alone
    expect(other.followSide).toBe(-0.75);
    expect(other.followMouse).toBe(true);
    expect(other.fovFps).toBe(95);
    expect(other.nonsense).toBeUndefined();
  });
});

describe('moving with a mouse-turned follow camera', () => {
  it('"forward" is where the camera faces, and the character still faces the way it walks', () => {
    const player = new Entity(new THREE.Object3D());
    const engine = {
      cameraRig: rig, camera: rig.camera, playerEntity: player, physics: null,
      input: { isDown: (c) => c === 'KeyW', wasPressed: () => false, mouseDown: () => false, mouseTapped: () => false, mouseClicked: () => false },
    };
    rig.camera.position.set(0, 2, 0);
    rig.camera.lookAt(5, 2, 0); // facing +X
    rig.mode = 'follow';
    rig.followMouse = true;
    const runtime = new ControlRuntime(engine);
    runtime.load([{ inputs: [{ type: 'key', code: 'KeyW' }], target: 'player',
      action: { type: 'move', direction: 'forward', speed: 5, relative: 'world', face: true } }]);
    runtime.update(0.1, 0, { resolveTarget: () => player });
    const v = player.rigidBody.velocity; // the player gets a body; moving sets its velocity
    expect(v.x).toBeGreaterThan(1);      // along the camera, not world -Z
    expect(Math.abs(v.z)).toBeLessThan(0.01);
    expect(player.object3D.rotation.y).toBeCloseTo(Math.PI / 2, 3); // turned to face its way
  });
});

describe('how the view moves with the body (first person)', () => {
  const walkTarget = () => { const t = new THREE.Object3D(); rig.fallbackTarget = t; rig.setMode('fps'); return t; };
  const eyeYs = (t, seconds, move) => {
    const ys = [];
    for (let i = 0; i < seconds * 60; i++) { move(t, i); rig.update(1 / 60, input()); ys.push(rig.camera.position.y - t.position.y); }
    return ys;
  };
  const walk = (t) => { t.position.z -= 5 / 60; }; // 5 m/s straight ahead
  const range = (ys) => Math.max(...ys) - Math.min(...ys);

  it('stays perfectly still unless a game asks for movement (all off by default)', () => {
    const t = walkTarget();
    expect(range(eyeYs(t, 2, walk))).toBeLessThan(1e-9);
    expect(rig.camera.rotation.z).toBe(0);
  });

  it('head bob: up and down with each step while walking, still when stopped', () => {
    const t = walkTarget();
    rig.headBob = 0.05;
    rig.bobStep = 1;
    const walking = eyeYs(t, 2, walk);
    expect(range(walking.slice(60))).toBeGreaterThan(0.05); // near ±0.05 once up to speed
    expect(range(walking.slice(60))).toBeLessThan(0.11);
    const stopped = eyeYs(t, 2, () => {});
    expect(range(stopped.slice(90))).toBeLessThan(0.002); // eases out
  });

  it('breathing: a slow rise and fall while standing still', () => {
    const t = walkTarget();
    rig.breathing = 0.01;
    const ys = eyeYs(t, 4.5, () => {});
    expect(range(ys)).toBeGreaterThan(0.015);
    expect(range(ys)).toBeLessThan(0.021);
  });

  it('dips on landing and springs back', () => {
    const t = walkTarget();
    rig.landDip = 1;
    t.position.y = 5;
    eyeYs(t, 0.4, (o) => { o.position.y -= 12 / 60; }); // falling fast
    const after = eyeYs(t, 1, () => {});
    expect(Math.min(...after)).toBeLessThan(rig.eyeHeight - 0.1); // a dip…
    expect(after[after.length - 1]).toBeCloseTo(rig.eyeHeight, 2); // …and back
  });

  it('leans into a strafe', () => {
    const t = walkTarget();
    rig.strafeTilt = 4;
    eyeYs(t, 1, (o) => { o.position.x += 5 / 60; }); // stepping right
    expect(rig.camera.rotation.z).toBeLessThan(-THREE.MathUtils.degToRad(2));
  });
});

describe('shaking the camera', () => {
  it('shakes, fades out, and "Shake strength 0" turns it off', () => {
    rig.setMode('orbit');
    rig.update(1 / 60, input());
    const still = rig.camera.position.clone();
    rig.shake(0.8, 0.5);
    let moved = 0;
    for (let i = 0; i < 20; i++) { rig.update(1 / 60, input()); moved = Math.max(moved, rig.camera.position.distanceTo(still)); }
    expect(moved).toBeGreaterThan(0.01);
    for (let i = 0; i < 40; i++) rig.update(1 / 60, input());
    expect(rig.camera.position.distanceTo(still)).toBeLessThan(1e-6); // over
    rig.shakeScale = 0;
    rig.shake(1, 1);
    rig.update(1 / 60, input());
    expect(rig.camera.position.distanceTo(still)).toBeLessThan(1e-6);
  });

  it('is an action for rules and controls', () => {
    const engine = { cameraRig: { shake: vi.fn() } };
    ACTIONS.shakeCamera.run({ action: { strength: 0.6, seconds: 0.2 }, engine });
    expect(engine.cameraRig.shake).toHaveBeenCalledWith(0.6, 0.2);
    expect(CONTROL_ACTIONS.shakeCamera).toBeTruthy();
  });
});

describe('sprint — a movement action bound to whatever key the game chooses', () => {
  it('while held, moving is faster; let go and it is normal again', () => {
    const player = new Entity(new THREE.Object3D());
    const held = new Set();
    const engine = {
      cameraRig: rig, camera: rig.camera, playerEntity: player, physics: null,
      input: { isDown: (c) => held.has(c), wasPressed: () => false, mouseDown: () => false, mouseTapped: () => false, mouseClicked: () => false },
    };
    const runtime = new ControlRuntime(engine);
    runtime.load([
      { inputs: [{ type: 'key', code: 'KeyW' }], target: 'player', action: { type: 'move', direction: 'forward', speed: 5 } },
      { inputs: [{ type: 'key', code: 'ShiftLeft' }], target: 'player', action: { type: 'sprint', multiplier: 2, fovBoost: 10 } },
    ]);
    const topSpeed = () => {
      for (let i = 0; i < 60; i++) runtime.update(1 / 60, 0, { resolveTarget: () => player });
      const v = player.rigidBody.velocity;
      return Math.hypot(v.x, v.z);
    };
    held.add('KeyW');
    expect(topSpeed()).toBeCloseTo(5, 1);
    held.add('ShiftLeft');
    expect(topSpeed()).toBeCloseTo(10, 1);
    for (let i = 0; i < 30; i++) rig.update(1 / 60, input());
    expect(rig.camera.fov).toBeCloseTo(rig.fovFor() + 10, 0); // the view opens while sprinting
    held.delete('ShiftLeft');
    expect(topSpeed()).toBeCloseTo(5, 1);
    for (let i = 0; i < 60; i++) rig.update(1 / 60, input());
    expect(rig.camera.fov).toBeCloseTo(rig.fovFor(), 3);
  });

  it('holding sprint while standing still does nothing', () => {
    const player = new Entity(new THREE.Object3D());
    const engine = { cameraRig: rig, camera: rig.camera, playerEntity: player, physics: null,
      input: { isDown: (c) => c === 'ShiftLeft', wasPressed: () => false, mouseDown: () => false, mouseTapped: () => false, mouseClicked: () => false } };
    const runtime = new ControlRuntime(engine);
    runtime.load([
      { inputs: [{ type: 'key', code: 'KeyW' }], target: 'player', action: { type: 'move', direction: 'forward', speed: 5 } },
      { inputs: [{ type: 'key', code: 'ShiftLeft' }], target: 'player', action: { type: 'sprint', multiplier: 3, fovBoost: 15 } },
    ]);
    for (let i = 0; i < 30; i++) { runtime.update(1 / 60, 0, { resolveTarget: () => player }); rig.update(1 / 60, input()); }
    expect(rig.camera.fov).toBeCloseTo(rig.fovFor(), 3);
    expect(CONTROL_ACTIONS.sprint.group).toBe('Movement');
  });
});
