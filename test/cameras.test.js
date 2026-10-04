// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { CameraRig } from '../src/cameras.js';
import { DRAG_THRESHOLD_PX } from '../src/input.js';

/**
 * Orbit-mode navigation:
 *   orbit  left-drag · one-finger drag
 *   pan    right-drag · two-finger drag
 *   zoom   scroll · pinch · double-click (focusOn)
 */

let canvas;
let rig;

beforeEach(() => {
  canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  rig = new CameraRig(new THREE.PerspectiveCamera(60, 1, 0.1, 1000), canvas);
});

const noInput = (over = {}) => ({
  wheel: 0, pointerDelta: { dx: 0, dy: 0 }, isDown: () => false, ...over,
});

const BUTTONS_HELD = { 0: 1, 1: 4, 2: 2 };

/** Press on the canvas, move in `steps` increments, release — like a real drag. */
function mouseDrag(button, from, to, { steps = 4 } = {}) {
  const buttons = BUTTONS_HELD[button];
  canvas.dispatchEvent(new MouseEvent('mousedown', {
    button, buttons, clientX: from[0], clientY: from[1], bubbles: true,
  }));
  for (let i = 1; i <= steps; i++) {
    window.dispatchEvent(new MouseEvent('mousemove', {
      button, buttons,
      clientX: from[0] + ((to[0] - from[0]) * i) / steps,
      clientY: from[1] + ((to[1] - from[1]) * i) / steps,
    }));
  }
  window.dispatchEvent(new MouseEvent('mouseup', {
    button, buttons: 0, clientX: to[0], clientY: to[1],
  }));
}

function finger(type, id, x, y) {
  const target = type === 'pointerdown' ? canvas : window;
  target.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true,
  }));
}

describe('CameraRig — mouse', () => {
  it('a press that moves less than the drag threshold leaves the camera alone', () => {
    // under the threshold it is a click, and the editor selects with it
    const theta = rig.theta;
    mouseDrag(0, [100, 100], [100 + DRAG_THRESHOLD_PX - 1, 100], { steps: 1 });
    expect(rig.theta).toBe(theta);
  });

  it('left-drag orbits and leaves the pivot where it was', () => {
    const theta = rig.theta;
    const pivot = rig.lookAt.clone();
    mouseDrag(0, [100, 100], [160, 100]);
    expect(rig.theta).toBeCloseTo(theta - 60 * 0.005, 6);
    expect(rig.lookAt.equals(pivot)).toBe(true);
  });

  it('left-drag tumbles a full 360°, over the top and underneath, without the view flipping', () => {
    const phi0 = rig.phi;
    const screenUp = () => new THREE.Vector3().setFromMatrixColumn(rig.camera.matrixWorld, 1);
    rig.update(0, noInput());
    rig.camera.updateMatrixWorld();
    let prevUp = screenUp();
    const heights = [];
    const pxPerTurn = (Math.PI * 2) / 0.005;
    for (let i = 0; i < 40; i++) {
      mouseDrag(0, [100, 100], [100, 100 - pxPerTurn / 40], { steps: 1 });
      rig.update(0, noInput());
      rig.camera.updateMatrixWorld();
      const up = screenUp();
      expect(up.dot(prevUp)).toBeGreaterThan(0.9); // turns smoothly, never snaps upside down
      prevUp = up;
      heights.push(rig.camera.position.y);
    }
    expect(Math.max(...heights)).toBeGreaterThan(rig.distance * 0.9);  // passed over the top
    expect(Math.min(...heights)).toBeLessThan(-rig.distance * 0.9);    // ...and underneath
    expect(rig.phi).toBeCloseTo(phi0, 6);                                // right back where it started
  });

  it('upside down, dragging right still turns the scene right on screen', () => {
    const theta = rig.theta;
    rig.phi = -Math.PI / 3 + Math.PI * 2; // past the top, now upside down
    mouseDrag(0, [100, 100], [160, 100]);
    expect(rig.theta).toBeCloseTo(theta + 60 * 0.005, 6);
  });

  it('first person and fly look round by dragging when the mouse is free (editing)', () => {
    for (const mode of ['fps', 'free']) {
      rig.setMode(mode);
      const yaw = rig.yaw;
      const pitch = rig.pitch;
      mouseDrag(0, [100, 100], [160, 70]);
      expect(rig.yaw, mode).toBeCloseTo(yaw - 60 * 0.0022, 6);
      expect(rig.pitch, mode).toBeCloseTo(pitch + 30 * 0.0022, 6); // dragging up looks up
      mouseDrag(2, [100, 100], [140, 100]); // any button
      expect(rig.yaw, mode).toBeCloseTo(yaw - 100 * 0.0022, 6);
    }
  });

  it('right-drag pans and leaves the angle alone', () => {
    const theta = rig.theta;
    mouseDrag(2, [100, 100], [300, 100]);
    expect(rig.theta).toBe(theta);
    // dragging right slides the pivot left, so the scene follows the cursor
    expect(rig.lookAt.x).toBeLessThan(0);
  });

  it('middle-drag pans too', () => {
    const theta = rig.theta;
    mouseDrag(1, [100, 100], [300, 100]);
    expect(rig.theta).toBe(theta);
    expect(rig.lookAt.x).toBeLessThan(0);
  });

  it('pan speed scales how far a right-drag moves', () => {
    mouseDrag(2, [100, 100], [300, 100]);
    const fast = -rig.lookAt.x;
    rig.lookAt.set(0, 1, 0);
    rig.panSpeed = 1;
    mouseDrag(2, [100, 100], [300, 100]);
    expect(-rig.lookAt.x).toBeCloseTo(fast / 3.5, 6);
  });

  it('stays still while the gizmo owns the pointer', () => {
    // the gizmo disables the rig from its own pointerdown, before ours runs
    rig.enabled = false;
    const theta = rig.theta;
    mouseDrag(0, [100, 100], [200, 100]);
    expect(rig.theta).toBe(theta);
  });

  it('the hand tool turns left-drag into a pan', () => {
    rig.setPanTool(true);
    const theta = rig.theta;
    mouseDrag(0, [100, 100], [300, 100]);
    expect(rig.theta).toBe(theta);
    expect(rig.lookAt.x).toBeLessThan(0);
  });

  it('ends a drag whose mouseup was swallowed', () => {
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      button: 0, buttons: 1, clientX: 100, clientY: 100, bubbles: true,
    }));
    // no button held any more — the release happened somewhere we never saw
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 0, clientX: 150, clientY: 100 }));
    const theta = rig.theta;
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 250, clientY: 100 }));
    expect(rig.theta).toBe(theta);
  });

  it('only navigates in orbit mode', () => {
    rig.setMode('follow');
    const theta = rig.theta;
    mouseDrag(0, [100, 100], [200, 100]);
    expect(rig.theta).toBe(theta);
  });

  it('shows the grab cursor while panning and clears it afterwards', () => {
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      button: 2, buttons: 2, clientX: 100, clientY: 100, bubbles: true,
    }));
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 2, clientX: 150, clientY: 100 }));
    expect(canvas.style.cursor).toBe('grabbing');
    window.dispatchEvent(new MouseEvent('mouseup', { button: 2, buttons: 0 }));
    expect(canvas.style.cursor).toBe('');
  });
});

describe('CameraRig — touch', () => {
  it('one-finger drag orbits', () => {
    const theta = rig.theta;
    finger('pointerdown', 1, 100, 100);
    for (let x = 110; x <= 160; x += 10) finger('pointermove', 1, x, 100);
    finger('pointerup', 1, 160, 100);
    expect(rig.theta).toBeCloseTo(theta - 60 * 0.005, 6);
  });

  it('a one-finger touch under the threshold does not orbit', () => {
    const theta = rig.theta;
    finger('pointerdown', 1, 100, 100);
    finger('pointermove', 1, 102, 101);
    finger('pointerup', 1, 102, 101);
    expect(rig.theta).toBe(theta);
  });

  it('two-finger drag pans without zooming', () => {
    const distance = rig.distance;
    const theta = rig.theta;
    finger('pointerdown', 1, 100, 100);
    finger('pointerdown', 2, 200, 100);
    for (let s = 1; s <= 5; s++) {
      finger('pointermove', 1, 100 + s * 20, 100);
      finger('pointermove', 2, 200 + s * 20, 100);
    }
    finger('pointerup', 1, 200, 100);
    finger('pointerup', 2, 300, 100);
    expect(rig.lookAt.x).toBeLessThan(0);
    expect(rig.distance).toBeCloseTo(distance, 6);
    expect(rig.theta).toBe(theta);
  });

  it('pinching out zooms in, pinching in zooms out', () => {
    const start = rig.distance;
    finger('pointerdown', 1, 150, 100);
    finger('pointerdown', 2, 250, 100);
    finger('pointermove', 1, 100, 100);  // spread 100 -> 150
    finger('pointermove', 2, 300, 100);  // spread 150 -> 200
    expect(rig.distance).toBeCloseTo(start * 0.5, 6);

    finger('pointermove', 1, 200, 100);  // spread 200 -> 100
    expect(rig.distance).toBeCloseTo(start, 6);
    finger('pointerup', 1, 200, 100);
    finger('pointerup', 2, 300, 100);
  });

  it('lifting one finger of a pan carries on as an orbit without a jump', () => {
    finger('pointerdown', 1, 100, 100);
    finger('pointerdown', 2, 300, 100);
    finger('pointerup', 2, 300, 100);
    const theta = rig.theta;
    finger('pointermove', 1, 105, 100);
    // 5px of orbit, not the 200px gap between the fingers
    expect(rig.theta).toBeCloseTo(theta - 5 * 0.005, 6);
    finger('pointerup', 1, 105, 100);
  });

  it('leaves mouse-type pointer events to the mouse handlers', () => {
    const theta = rig.theta;
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 9, pointerType: 'mouse', clientX: 100, clientY: 100, bubbles: true,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 9, pointerType: 'mouse', clientX: 200, clientY: 100,
    }));
    expect(rig.theta).toBe(theta);
  });

  it('turns off browser touch scrolling on the canvas', () => {
    expect(canvas.style.touchAction).toBe('none');
  });
});

describe('CameraRig — zoom', () => {
  it('scrolling zooms by a constant ratio, not a constant distance', () => {
    rig.distance = 10;
    rig.update(0.016, noInput({ wheel: 100 }));
    const near = rig.distance / 10;
    expect(rig.distance).toBeCloseTo(10 * Math.exp(0.12), 6);

    rig.distance = 80;
    rig.update(0.016, noInput({ wheel: 100 }));
    expect(rig.distance / 80).toBeCloseTo(near, 6); // same feel close up and far away
  });

  it('zoom is free: no farthest, and in close it never gets stuck — it flies on through the pivot', () => {
    rig.distance = 10;
    for (let i = 0; i < 40; i++) rig.update(0.016, noInput({ wheel: 300 }));
    expect(rig.distance).toBeGreaterThan(500); // well past the old 120 m
    rig.distance = 3;
    rig.lookAt.set(0, 0, 0);
    rig.update(0.016, noInput());
    const start = rig.camera.position.clone();
    const lookBefore = rig.lookAt.clone();
    for (let i = 0; i < 30; i++) rig.update(0.016, noInput({ wheel: -100 }));
    expect(rig.distance).toBeGreaterThan(0.4); // never zero
    expect(rig.camera.position.distanceTo(start)).toBeGreaterThan(5); // it kept moving in, and on
    expect(rig.lookAt.distanceTo(lookBefore)).toBeGreaterThan(2); // the pivot carried on ahead
    // each notch, close in, still moves a real step
    const before = rig.camera.position.clone();
    rig.update(0.016, noInput({ wheel: -100 }));
    expect(rig.camera.position.distanceTo(before)).toBeGreaterThan(0.3);
  });

  it('focusOn glides onto the point and halves the distance', () => {
    rig.distance = 20;
    const point = new THREE.Vector3(5, 0, -3);
    expect(rig.focusOn(point)).toBe(true);

    rig.update(0.1, noInput());
    expect(rig.lookAt.distanceTo(point)).toBeGreaterThan(0.01); // gliding, not a jump

    for (let i = 0; i < 10; i++) rig.update(0.1, noInput());
    expect(rig.lookAt.distanceTo(point)).toBeLessThan(1e-6);
    expect(rig.distance).toBeCloseTo(10, 6);
  });

  it('scrolling during a glide takes over from it', () => {
    rig.focusOn(new THREE.Vector3(10, 0, 0));
    rig.update(0.05, noInput());
    rig.update(0.05, noInput({ wheel: 100 }));
    const pivot = rig.lookAt.clone();
    rig.update(0.2, noInput());
    expect(rig.lookAt.equals(pivot)).toBe(true);
  });

  it('dragging during a glide takes over from it', () => {
    rig.focusOn(new THREE.Vector3(10, 0, 0));
    rig.update(0.05, noInput());
    mouseDrag(0, [100, 100], [160, 100]);
    const pivot = rig.lookAt.clone();
    rig.update(0.2, noInput());
    expect(rig.lookAt.equals(pivot)).toBe(true);
  });

  it('focusing releases the orbit-to-target lock', () => {
    rig.orbitLockTarget = true;
    rig.focusOn(new THREE.Vector3(1, 1, 1));
    expect(rig.orbitLockTarget).toBe(false);
  });

  it('does not focus outside orbit mode', () => {
    rig.setMode('follow');
    expect(rig.focusOn(new THREE.Vector3())).toBe(false);
  });
});

describe('every camera can be turned and tilted (Camera panel)', () => {
  const dirOf = (cam) => cam.getWorldDirection(new THREE.Vector3());
  const yawDeg = (v) => Math.round(THREE.MathUtils.radToDeg(Math.atan2(v.x, v.z)));

  it('orbit: Turn goes round the point it circles, Tilt over it — live, and dragging still turns it freely', () => {
    rig.update(0.016, noInput());
    const theta = rig.theta;
    const phi = rig.phi;
    rig.orbitTurn = 90;
    rig.update(0.016, noInput());
    expect(rig.theta - theta).toBeCloseTo(Math.PI / 2, 6);
    rig.orbitTilt = 20;
    rig.update(0.016, noInput());
    expect(phi - rig.phi).toBeCloseTo(THREE.MathUtils.degToRad(20), 6);
    rig.update(0.016, noInput()); // unchanged: no more turning
    expect(rig.theta - theta).toBeCloseTo(Math.PI / 2, 6);
    rig.setMode('follow'); rig.setMode('orbit'); // back again: not turned twice
    rig.update(0.016, noInput());
    expect(rig.theta - theta).toBeCloseTo(Math.PI / 2, 6);
  });

  it('first person and fly: the view turned round and tilted, from the view it starts from', () => {
    const target = new THREE.Object3D();
    rig.update(0.016, noInput());
    const before = yawDeg(dirOf(rig.camera));
    rig.fpsTurn = 180;
    rig.fpsTilt = 20;
    rig.setMode('fps', { target });
    rig.update(0.016, noInput());
    const after = dirOf(rig.camera);
    expect(Math.abs(((yawDeg(after) - before + 540) % 360) - 180)).toBe(180); // looking the other way
    expect(after.y).toBeCloseTo(Math.sin(THREE.MathUtils.degToRad(20)), 3); // and up a little
    rig.fpsTurn = 90; // changed live: turns back a quarter
    rig.update(0.016, noInput());
    expect(Math.abs(((yawDeg(dirOf(rig.camera)) - before + 540) % 360) - 180)).toBe(90);
    rig.flyTurn = -90;
    rig.setMode('free');
    const flyFrom = yawDeg(dirOf(rig.camera));
    rig.update(0.016, noInput());
    expect(Math.abs(((yawDeg(dirOf(rig.camera)) - flyFrom + 540) % 360) - 180)).toBe(90);
  });

  it('follow: Turn goes round the target — 180 looks at its face — and Tilt from higher up', () => {
    const target = new THREE.Object3D(); // facing +Z
    rig.setMode('follow', { target });
    for (let i = 0; i < 120; i++) rig.update(1 / 60, noInput());
    expect(rig.camera.position.z).toBeLessThan(-1); // behind it
    rig.followTurn = 180;
    for (let i = 0; i < 240; i++) rig.update(1 / 60, noInput());
    expect(rig.camera.position.z).toBeGreaterThan(1); // in front, looking at its face
    const y = rig.camera.position.y;
    rig.followTilt = 40;
    for (let i = 0; i < 240; i++) rig.update(1 / 60, noInput());
    expect(rig.camera.position.y).toBeGreaterThan(y + 1);
  });
});

describe('first person on a moving body: smooth on any screen', async () => {
  const { PhysicsWorld, RigidBody } = await import('../src/physics.js');
  const { Entity } = await import('../src/entity.js');

  it('the view moves with the picture between physics slices, not slice to slice (144 Hz: no shake)', () => {
    const physics = new PhysicsWorld();
    physics.gravity = 0;
    const hero = new Entity(new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.6, 0.6)));
    hero.rigidBody = new RigidBody({ type: 'dynamic', shape: 'capsule' });
    hero.rigidBody.gravityScale = 0;
    physics.register(hero);
    rig.physics = physics;
    rig.target = hero.object3D;
    rig.headBob = 0;
    rig.setMode('fps');
    const steps = [];
    let last = null;
    for (let i = 0; i < 144; i++) { // a second of walking at 5 m/s, drawn at 144 frames a second
      hero.rigidBody.velocity.set(5, 0, 0);
      physics.step(1 / 144);
      rig.update(1 / 144, noInput());
      const x = rig.camera.position.x;
      if (last !== null && i > 10) steps.push(x - last);
      last = x;
    }
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    expect(mean).toBeCloseTo(5 / 144, 3);
    // each frame about the same step (it was 0 or a whole slice: 0 / 8 cm)
    for (const s of steps) expect(Math.abs(s - mean)).toBeLessThan(mean * 0.2);
  });
});
