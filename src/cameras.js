import * as THREE from 'three';
import { yawOf } from './heading.js';
import { DRAG_THRESHOLD_PX } from './input.js';

const ORBIT_RAD_PER_PX = 0.005;
// Zoom is multiplicative: each wheel notch (deltaY ~100) scales distance by ~13%,
// so it feels the same whether you are 2 units from a model or 80.
const WHEEL_ZOOM = 0.0012;
// Orbit zoom is free — no closest, no farthest. Far out it moves by the same
// share of the distance each notch; close in, a notch still moves at least
// ZOOM_STEP metres per unit of zoom, and nearer the pivot than ZOOM_FLOOR the
// pivot itself is carried on ahead: you fly in and through, never stuck.
const ZOOM_STEP = 4;
const ZOOM_FLOOR = 0.5;
const ZOOM_FARTHEST = 100000; // only so the numbers stay numbers
const LOOK_RAD_PER_PX = 0.0022; // mouse look at "Mouse speed" 1
// a gamepad's right stick at full tilt turns this fast (radians a second) at "Mouse speed" 1
const STICK_LOOK = 2.6;
const STICK_PX = STICK_LOOK / LOOK_RAD_PER_PX; // the same, as mouse movement a second
const _UP = new THREE.Vector3(0, 1, 0);

/**
 * Every adjustable setting of every camera, described once: the Camera panel
 * draws its sliders from this, the scene saves exactly these, and exported
 * games load them. Add one here and it is editable, saved and undoable.
 *   { key, label, min, max, step, default }  a number (on the CameraRig as `key`)
 *   { key, label, type: 'boolean', default } a switch
 */
export const CAMERA_SETTINGS = {
  orbit: {
    label: 'Orbit',
    hint: 'Circles a point or the target. Drag to turn, scroll to zoom.',
    fields: [
      { key: 'distance', label: 'Distance', min: 1, max: 150, step: 0.5, default: 14 },
      { key: 'orbitHeight', label: 'Raise by', min: -5, max: 10, step: 0.25, default: 0 },
      { key: 'orbitTurn', label: 'Turn round (°)', min: -180, max: 180, step: 5, default: 0 },
      { key: 'orbitTilt', label: 'Tilt over (°)', min: -85, max: 85, step: 1, default: 0 },
      { key: 'panSpeed', label: 'Pan speed', min: 0.5, max: 14, step: 0.5, default: 3.5 },
      { key: 'fovOrbit', label: 'Field of view', min: 30, max: 110, step: 1, default: 60 },
      { key: 'viewDistance', label: 'View distance (m)', min: 50, max: 20000, step: 50, default: 1000 },
      { key: 'orbitLockTarget', label: 'Stay centred on the target', type: 'boolean', default: true },
    ],
  },
  follow: {
    label: 'Follow',
    hint: 'Third person: behind the target (the player if none is chosen).',
    fields: [
      { key: 'followOffset', label: 'Distance', min: 0.5, max: 40, step: 0.25, default: 6 },
      { key: 'followHeight', label: 'Height', min: -2, max: 20, step: 0.25, default: 3 },
      { key: 'followSide', label: 'To the side', min: -5, max: 5, step: 0.05, default: 0 },
      { key: 'followLookUp', label: 'Aim at height', min: -2, max: 6, step: 0.25, default: 1 },
      { key: 'followLookAhead', label: 'Look ahead', min: 0, max: 10, step: 0.25, default: 0 },
      { key: 'followTurn', label: 'Turn round the target (°)', min: -180, max: 180, step: 5, default: 0 },
      { key: 'followTilt', label: 'Tilt the view (°)', min: -60, max: 60, step: 1, default: 0 },
      { key: 'followLerp', label: 'Snappiness', min: 1, max: 30, step: 0.5, default: 8 },
      { key: 'followMin', label: 'Zoom closest', min: 0.5, max: 20, step: 0.25, default: 1 },
      { key: 'followMax', label: 'Zoom farthest', min: 1, max: 80, step: 0.5, default: 40 },
      { key: 'fovFollow', label: 'Field of view', min: 30, max: 110, step: 1, default: 60 },
      { key: 'viewDistance', label: 'View distance (m)', min: 50, max: 20000, step: 50, default: 1000 },
      { key: 'followMouse', label: 'Mouse turns the camera', type: 'boolean', default: false },
      { key: 'captureMouse', label: 'Capture the mouse to look around', type: 'boolean', default: true },
      { key: 'rotateWithTarget', label: 'Swing behind as the target turns', type: 'boolean', default: true },
      { key: 'followAvoidWalls', label: 'Keep out of walls', type: 'boolean', default: true },
      { key: 'followLockY', label: 'Keep a fixed height (top-down)', type: 'boolean', default: false },
      { key: 'shakeScale', label: 'Shake strength', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  },
  fps: {
    label: 'First person',
    hint: 'Through the target\'s eyes (the player if none is chosen).',
    fields: [
      { key: 'eyeHeight', label: 'Eye height', min: -2, max: 5, step: 0.05, default: 1.1 },
      { key: 'eyeForward', label: 'Eye forward', min: -2, max: 2, step: 0.05, default: 0 },
      { key: 'fpsTurn', label: 'Turn the view (°)', min: -180, max: 180, step: 5, default: 0,
        tip: 'Which way you look from the body: 180 for first-person arms modelled looking backwards (down -Z). While playing the body keeps this turn from the view' },
      { key: 'fpsTilt', label: 'Tilt the view (°)', min: -80, max: 80, step: 1, default: 0 },
      { key: 'lookSensitivity', label: 'Mouse speed', min: 0.1, max: 4, step: 0.05, default: 1 },
      { key: 'pitchLimit', label: 'Look up/down (°)', min: 10, max: 89, step: 1, default: 80 },
      { key: 'fovFps', label: 'Field of view', min: 30, max: 110, step: 1, default: 60 },
      { key: 'viewDistance', label: 'View distance (m)', min: 50, max: 20000, step: 50, default: 1000 },
      { key: 'invertY', label: 'Invert up/down', type: 'boolean', default: false },
      { key: 'captureMouse', label: 'Capture the mouse to look around', type: 'boolean', default: true },
      // how the view moves with the body — all 0 (still) until a game wants it
      { key: 'headBob', label: 'Head bob (walking)', min: 0, max: 0.2, step: 0.005, default: 0 },
      { key: 'bobStep', label: 'Step length (m)', min: 0.3, max: 4, step: 0.1, default: 1.6 },
      { key: 'bobSway', label: 'Side-to-side sway', min: 0, max: 2, step: 0.05, default: 0.5 },
      { key: 'breathing', label: 'Breathing (standing)', min: 0, max: 0.05, step: 0.001, default: 0 },
      { key: 'landDip', label: 'Dip on landing', min: 0, max: 1, step: 0.05, default: 0 },
      { key: 'strafeTilt', label: 'Lean when strafing (°)', min: 0, max: 8, step: 0.25, default: 0 },
      { key: 'shakeScale', label: 'Shake strength', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  },
  free: {
    label: 'Fly',
    hint: 'Free flight: mouse to look, W A S D to move, Q / E down / up, Shift for speed.',
    fields: [
      { key: 'flySpeed', label: 'Speed', min: 0.5, max: 100, step: 0.5, default: 10 },
      { key: 'flyFast', label: 'Shift speed ×', min: 1, max: 10, step: 0.5, default: 3 },
      { key: 'flyTurn', label: 'Turn the view (°)', min: -180, max: 180, step: 5, default: 0 },
      { key: 'flyTilt', label: 'Tilt the view (°)', min: -80, max: 80, step: 1, default: 0 },
      { key: 'lookSensitivity', label: 'Mouse speed', min: 0.1, max: 4, step: 0.05, default: 1 },
      { key: 'fovFly', label: 'Field of view', min: 30, max: 110, step: 1, default: 60 },
      { key: 'viewDistance', label: 'View distance (m)', min: 50, max: 20000, step: 50, default: 1000 },
      { key: 'invertY', label: 'Invert up/down', type: 'boolean', default: false },
      { key: 'captureMouse', label: 'Capture the mouse to look around', type: 'boolean', default: true },
    ],
  },
};

/** Each setting once (some, like mouse speed, appear under two cameras). */
export const CAMERA_FIELDS = [...new Map(Object.values(CAMERA_SETTINGS)
  .flatMap((m) => m.fields).map((f) => [f.key, f])).values()];

/** Every setting at its starting value — a new rig, and anything a file leaves out. */
export const CAMERA_DEFAULTS = Object.fromEntries(CAMERA_FIELDS.map((f) => [f.key, f.default]));

/** Which setting is each camera's field of view. */
export const FOV_KEY = { orbit: 'fovOrbit', follow: 'fovFollow', fps: 'fovFps', free: 'fovFly' };

/** A rig's settings as plain data, for saving. Works on anything shaped like a rig. */
export function cameraSettingsOf(rig) {
  const out = {};
  for (const f of CAMERA_FIELDS) {
    const v = rig[f.key];
    if (v === undefined) continue;
    out[f.key] = f.type === 'boolean' ? !!v : Math.round(Number(v) * 1000) / 1000;
  }
  return out;
}

/** Put saved settings back, clamped to each one's range; unknown or broken ones are ignored. */
export function applyCameraSettings(rig, data) {
  if (!data || typeof data !== 'object') return;
  for (const f of CAMERA_FIELDS) {
    if (!(f.key in data)) continue;
    if (f.type === 'boolean') rig[f.key] = !!data[f.key];
    else {
      const n = Number(data[f.key]);
      if (Number.isFinite(n)) rig[f.key] = Math.min(f.max, Math.max(f.min, n));
    }
  }
}

/**
 * CameraRig — switchable camera controller driven by the engine's camera.
 *
 *   const rig = new CameraRig(engine.camera, engine.renderer.domElement);
 *   rig.setMode('follow', { target: player.object3D });
 *   rig.update(dt, input);   // call every frame
 *
 * Modes:
 *   orbit  — the editor's navigation camera (controls below)
 *   follow — chase cam tied to ANY target object; offset/height/lerp/FOV are
 *            user-adjustable so a model (e.g. the player) can be "attached"
 *   fps    — pointer-lock mouse look at a target's head + WASD (handled by Player)
 *   free   — pointer-lock fly cam: mouse look, WASD + Q/E up/down, Shift = fast
 *
 * Orbit-mode controls:
 *   Orbit  left-drag           · one-finger drag
 *   Pan    right-drag          · two-finger drag
 *          (also middle-drag, Space + left-drag, or the hand tool)
 *   Zoom   scroll              · pinch
 *          double-click a model to glide in and centre on it
 *
 * A left press that travels less than DRAG_THRESHOLD_PX is a click, not an
 * orbit — the editor uses it for selection. The same threshold decides both,
 * so a click can never nudge the camera and a drag can never select.
 */
const _drawnA = new THREE.Vector3();
const _drawnB = new THREE.Vector3();
/**
 * Where a target is drawn: its position, plus the step or bump it is still
 * easing out of (physics.js, _soften) — so the view glides over a kerb or up
 * a stair with the character instead of jolting where the physics jumped.
 */
const drawnAt = (o, out) => out.set(o.position.x, o.position.y + (o.userData.smoothY || 0), o.position.z);

const _facing = new THREE.Vector3();
const _zoomDir = new THREE.Vector3();
/**
 * Which way a target faces (a heading, like rotation.y): its own front
 * (userData.forward — a car's, which may not be +Z), turned as it is turned.
 * Read from its whole turn, so a car pitching over a crest keeps its heading.
 */
function headingOf(o) {
  const f = o.userData.forward;
  if (!f) return yawOf(o);
  _facing.set(f[0], f[1], f[2]).applyQuaternion(o.quaternion);
  return Math.hypot(_facing.x, _facing.z) > 1e-3 ? Math.atan2(_facing.x, _facing.z) : yawOf(o);
}

export class CameraRig {
  static MODES = ['orbit', 'follow', 'fps', 'free'];

  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;
    this.mode = 'orbit';
    this.target = null; // THREE.Object3D for follow/fps/orbit
    // what follow / first person use when no target is chosen: the player, set by the host
    this.fallbackTarget = null;
    // the camera the game plays with (Play and exported games); null = the editor's view
    this.playMode = null;
    this.enabled = true; // editor sets false while a gizmo drag is active

    // Every adjustable setting — orbit distance and zoom limits, the follow
    // camera's distance / height / side / smoothing, first-person eye height and
    // mouse speed, fly speed, each camera's field of view — starts at its
    // default in CAMERA_SETTINGS, the one place they are described.
    // (panSpeed multiplies the 1:1 pan rate: strict 1:1 crawls close up.)
    Object.assign(this, CAMERA_DEFAULTS);

    // orbit state
    this.theta = Math.PI * 0.25;
    this.phi = Math.PI / 3.2;
    this.lookAt = new THREE.Vector3(0, 1, 0);
    // Pan rate scales with pivot distance, so zoomed right in it would crawl
    // worst of all. Clamping the reach keeps close-up panning usable.
    this.panMinDistance = 10;

    // follow state
    this.followDamping = 1;    // multiplies Snappiness (1 = as set)
    this.followYaw = 0;        // which way it faces the target (followMouse turns it)
    this.followPitch = 0;      // how far the mouse has tilted it from its resting height
    this.physics = null;       // host sets it, for "Keep out of walls"

    // fps / free yaw-pitch state
    this.yaw = 0;
    this.pitch = 0;
    this._freePos = camera.position.clone();

    this._drag = null;         // mouse drag: { gesture, startX, startY, lastX, lastY, active }
    this._touches = new Map(); // pointerId -> { x, y }
    this._touchStart = null;   // one-finger orbit: { x, y, active }
    this._focus = null;        // double-click glide in progress

    // Hand tool: left-drag pans instead of orbiting — for trackpads, where a
    // held right-button drag is awkward.
    this.panTool = false;      // toolbar toggle
    this.allowSpacePan = true; // host clears this in play mode, where Space jumps
    this._spaceDown = false;

    // we interpret one- and two-finger gestures ourselves; without this the
    // browser would scroll or zoom the page instead
    domElement.style.touchAction = 'none';

    const typingInField = () => {
      const a = document.activeElement;
      return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
    };
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || !this.allowSpacePan || typingInField()) return;
      e.preventDefault(); // Space would otherwise scroll or re-trigger a focused button
      if (!this._spaceDown) {
        this._spaceDown = true;
        if (!this._drag) this._setCursor('grab');
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space') return;
      this._spaceDown = false;
      if (!this._drag) this._setCursor(this.panTool ? 'grab' : '');
    });
    window.addEventListener('blur', () => {
      this._spaceDown = false;
      this._touches.clear();
      this._endDrag();
    });

    // ---- mouse ----
    domElement.addEventListener('mousedown', (e) => this._onMouseDown(e));
    domElement.addEventListener('auxclick', (e) => {
      // middle-click would otherwise paste on some platforms
      if (e.button === 1) e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => this._onMouseMove(e));
    window.addEventListener('mouseup', () => this._endDrag());
    // A trackpad pinch arrives as ctrl+wheel. The zoom itself comes through
    // input.wheel like any scroll; this only stops the browser zooming the page.
    domElement.addEventListener('wheel', (e) => {
      if (e.ctrlKey) e.preventDefault();
    }, { passive: false });

    // ---- touch ----
    domElement.addEventListener('pointerdown', (e) => this._onTouchDown(e));
    window.addEventListener('pointermove', (e) => this._onTouchMove(e));
    window.addEventListener('pointerup', (e) => this._onTouchUp(e));
    window.addEventListener('pointercancel', (e) => this._onTouchUp(e));
  }

  // ------------------------------------------------------------------ mouse

  _onMouseDown(e) {
    // enabled is false when the gizmo claimed this press (its pointerdown runs
    // first) — a handle drag must move the object, not the camera
    if (this.enabled === false || e.target?.closest?.('.panel')) return;

    let gesture = null;
    if (e.button === 0) gesture = this.isHandActive() ? 'pan' : 'orbit';
    else if (e.button === 2 || e.button === 1) gesture = 'pan';
    if (!gesture) return;

    if (e.button === 1) e.preventDefault(); // stop the middle-click autoscroll widget
    this._drag = {
      gesture,
      startX: e.clientX, startY: e.clientY,
      lastX: e.clientX, lastY: e.clientY,
      active: false,
    };
    // the hand tool grabs straight away; a normal press waits to see if it drags
    if (gesture === 'pan' && e.button === 0) this._setCursor('grabbing');
  }

  _onMouseMove(e) {
    const d = this._drag;
    if (!d) return;
    // a swallowed mouseup (context menu, focus loss) must not strand the drag;
    // `buttons` is the ground truth for what is still held
    if (e.buttons === 0) { this._endDrag(); return; }

    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
      d.active = true;
      this._focus = null; // grabbing the camera cancels a double-click glide
    }

    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    // a follow camera the mouse turns can also be dragged round (no mouse capture needed)
    if (this.mode === 'follow' && this.followMouse && d.gesture === 'orbit' && this.enabled !== false) {
      this._turnFollow(dx, dy);
      return;
    }
    // First person and fly with the mouse free (editing, or a game that doesn't
    // capture it): drag with any button to look round. A plain click still selects.
    if ((this.mode === 'fps' || this.mode === 'free') && this.enabled !== false) {
      if (!(typeof document !== 'undefined' && document.pointerLockElement)) {
        this._look({ pointerDelta: { dx, dy } });
        this._setCursor('move');
      }
      return;
    }
    if (this.mode !== 'orbit' || this.enabled === false) return;

    if (d.gesture === 'pan') {
      this._pan(dx, dy);
      this._setCursor('grabbing');
    } else {
      this._orbitBy(dx, dy);
      this._setCursor('move');
    }
  }

  _endDrag() {
    if (!this._drag) return;
    this._drag = null;
    this._setCursor(this.isHandActive() ? 'grab' : '');
  }

  // ------------------------------------------------------------------ touch

  _onTouchDown(e) {
    if (e.pointerType !== 'touch' || e.target?.closest?.('.panel')) return;
    this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._touches.size === 1) {
      this._touchStart = { x: e.clientX, y: e.clientY, active: false };
    }
  }

  _onTouchMove(e) {
    if (e.pointerType !== 'touch') return;
    const t = this._touches.get(e.pointerId);
    if (!t) return;

    const before = this._twoFingers();
    const prevX = t.x;
    const prevY = t.y;
    t.x = e.clientX;
    t.y = e.clientY;
    // a finger on a gizmo handle drives the gizmo (it disables the rig)
    if (this.enabled === false || this.mode !== 'orbit') return;

    if (this._touches.size === 1) {
      const s = this._touchStart;
      if (!s.active) {
        if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_THRESHOLD_PX) return;
        s.active = true;
        this._focus = null;
      }
      this._orbitBy(e.clientX - prevX, e.clientY - prevY);
      return;
    }

    // two fingers: the midpoint pans, the spread pinches
    const after = this._twoFingers();
    this._focus = null;
    this._pan(after.mx - before.mx, after.my - before.my, 1);
    if (before.spread > 0 && after.spread > 0) this._zoomBy(before.spread / after.spread);
  }

  _onTouchUp(e) {
    if (e.pointerType !== 'touch' || !this._touches.has(e.pointerId)) return;
    this._touches.delete(e.pointerId);
    // lifting one of two fingers carries on as an orbit from where the other is,
    // rather than jumping by the distance between them
    if (this._touches.size === 1) {
      const [p] = this._touches.values();
      this._touchStart = { x: p.x, y: p.y, active: true };
    }
  }

  /** Midpoint and spread of the first two touches. */
  _twoFingers() {
    const [a, b] = this._touches.values();
    if (!a || !b) return { mx: 0, my: 0, spread: 0 };
    return {
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
      spread: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  // ------------------------------------------------------------------ moves

  /**
   * Tumble all the way round, over the top and underneath. Upside down the
   * horizontal drag flips, so dragging right always turns the scene right on screen.
   */
  _orbitBy(pixelDx, pixelDy) {
    const upsideDown = Math.sin(this.phi) < 0;
    this.theta -= pixelDx * ORBIT_RAD_PER_PX * (upsideDown ? -1 : 1);
    const turn = Math.PI * 2;
    this.phi = (((this.phi - pixelDy * ORBIT_RAD_PER_PX) % turn) + turn) % turn;
  }

  /**
   * Turn and tilt the view by the Camera panel's "Turn" and "Tilt" for this
   * camera (degrees): by how much they changed since last looked at, so the
   * mouse — or a drag in the editor — still turns it freely on top. Orbit goes
   * round and over the point it circles; first person and fly turn the view.
   */
  _turnLook(prefix) {
    const seen = (this._turnSeen ??= {});
    const turn = Number(this[`${prefix}Turn`]) || 0;
    const tilt = Number(this[`${prefix}Tilt`]) || 0;
    const was = seen[prefix];
    seen[prefix] = { turn, tilt };
    if (!was || (was.turn === turn && was.tilt === tilt)) return;
    const dTurn = THREE.MathUtils.degToRad(turn - was.turn);
    const dTilt = THREE.MathUtils.degToRad(tilt - was.tilt);
    if (prefix === 'orbit') {
      this.theta += dTurn;
      this.phi -= dTilt; // it tumbles all the way over, as dragging does
      return;
    }
    const limit = THREE.MathUtils.degToRad(this.pitchLimit ?? 89);
    this.yaw += dTurn;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dTilt, -limit, limit);
  }

  /** Zoom by `factor` of the distance: <1 in, >1 out. Free: nothing stops it (see ZOOM_STEP). */
  _zoomBy(factor) {
    if (!(factor > 0) || factor === 1) return;
    const share = this.distance * (factor - 1);
    const least = ZOOM_STEP * Math.abs(Math.log(factor)) * (factor < 1 ? -1 : 1);
    const next = this.distance + (Math.abs(share) >= Math.abs(least) ? share : least);
    if (next >= ZOOM_FLOOR) {
      this.distance = Math.min(next, ZOOM_FARTHEST);
      return;
    }
    // in past the pivot's floor: the pivot goes on ahead, and the camera with it
    const ahead = ZOOM_FLOOR - next;
    this.distance = ZOOM_FLOOR;
    _zoomDir.subVectors(this.lookAt, this.camera.position);
    if (_zoomDir.lengthSq() < 1e-12) return;
    this.lookAt.addScaledVector(_zoomDir.normalize(), ahead);
    this.orbitLockTarget = false; // through the target: no longer held to it
  }

  /**
   * Slide the orbit pivot across the view plane.
   *
   * The base rate tracks the cursor 1:1 at the pivot distance, then `speed`
   * scales it. `panMinDistance` stops close-up panning from crawling.
   */
  _pan(pixelDx, pixelDy, speed = this.panSpeed) {
    const height = this.dom?.clientHeight || window.innerHeight;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const reach = Math.max(this.distance, this.panMinDistance);
    const worldPerPixel = ((2 * reach * Math.tan(vFov / 2)) / height) * speed;

    const right = new THREE.Vector3()
      .setFromMatrixColumn(this.camera.matrixWorld, 0)
      .multiplyScalar(-pixelDx * worldPerPixel);
    const up = new THREE.Vector3()
      .setFromMatrixColumn(this.camera.matrixWorld, 1)
      .multiplyScalar(pixelDy * worldPerPixel);

    // live readout for diagnosing "panning feels slow" without guessing
    this.lastPan = {
      pixels: Math.round(Math.hypot(pixelDx, pixelDy)),
      units: +Math.hypot(right.x + up.x, right.y + up.y, right.z + up.z).toFixed(4),
      worldPerPixel: +worldPerPixel.toFixed(5),
      panSpeed: speed,
      distance: +this.distance.toFixed(1),
    };

    this.lookAt.add(right).add(up);
    // panning means you want to look somewhere else, not stay glued to the target
    this.orbitLockTarget = false;
  }

  /**
   * Glide the orbit pivot onto a world point and move in — what a double-click
   * on a model does. `zoom` is the fraction of the current distance to end at.
   */
  focusOn(point, { zoom = 0.5, duration = 0.35 } = {}) {
    if (this.mode !== 'orbit') return false;
    this.orbitLockTarget = false; // the pivot is now where you clicked
    this._focus = {
      fromLook: this.lookAt.clone(),
      toLook: point.clone(),
      fromDist: this.distance,
      toDist: THREE.MathUtils.clamp(this.distance * zoom, 0.05, ZOOM_FARTHEST),
      t: 0,
      duration,
    };
    return true;
  }

  /**
   * Glide the orbit camera onto something `radius` metres round centred at
   * `center`, at the distance that shows all of it (a model just added).
   */
  frame(center, radius, { duration = 0.45 } = {}) {
    if (this.mode !== 'orbit' || !(radius > 0)) return false;
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov || 60) / 2;
    const fits = (radius / Math.sin(halfFov)) * 1.15;
    this.orbitLockTarget = false; // the pivot is now the model
    this._focus = {
      fromLook: this.lookAt.clone(),
      toLook: center.clone(),
      fromDist: this.distance,
      toDist: THREE.MathUtils.clamp(fits, 0.05, ZOOM_FARTHEST),
      t: 0,
      duration,
    };
    return true;
  }

  // ------------------------------------------------------------------ tools

  /** True while the hand tool is on, or Space is held as a temporary override. */
  isHandActive() {
    return this.panTool || this._spaceDown;
  }

  /** Turn the toolbar hand tool on or off. */
  setPanTool(on) {
    this.panTool = !!on;
    if (!this._drag) this._setCursor(this.isHandActive() ? 'grab' : '');
  }

  _setCursor(value) {
    if (this.dom) this.dom.style.cursor = value || '';
  }

  /** Switch mode. opts.target = Object3D to follow/orbit/look from. */
  setMode(mode, { target = this.target } = {}) {
    if (!CameraRig.MODES.includes(mode)) return;
    this.mode = mode;
    this.target = target;
    this._focus = null;
    // seed yaw/pitch from current camera so the view doesn't snap
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    // first person starts looking straight ahead, not down at the floor the
    // editing view was looking at
    if (mode === 'fps') this.pitch = 0;
    // its own Turn and Tilt (Camera panel), from the view it starts from (the orbit
    // camera keeps its own angle: its Turn and Tilt move it as they change)
    const prefix = { fps: 'fps', free: 'fly' }[mode];
    if (prefix) {
      (this._turnSeen ??= {})[prefix] = { turn: 0, tilt: 0 };
      this._turnLook(prefix);
    }
    if (mode === 'follow') {
      // start behind the target on the side the camera is on now
      const t = target ?? this.fallbackTarget;
      if (t) this.followYaw = Math.atan2(t.position.x - this.camera.position.x, t.position.z - this.camera.position.z);
      this.followPitch = 0;
    }
    this._freePos.copy(this.camera.position);
    this.setFov(this.fovFor(mode)); // each camera keeps its own field of view
  }

  /** This camera's field of view (degrees). */
  fovFor(mode = this.mode) { return this[FOV_KEY[mode]] ?? this.camera.fov; }

  /**
   * Does this camera look with the mouse, so a click should capture it? A game
   * can say no ("Capture the mouse" off): first person then turns by its
   * controls only, and a mouse-turned follow camera turns by dragging.
   */
  wantsPointerLock(mode = this.mode) {
    if (!this.captureMouse) return false;
    return mode === 'fps' || mode === 'free' || (mode === 'follow' && this.followMouse);
  }

  /** Turn and tilt a mouse-driven follow camera by a mouse movement (pixels). */
  _turnFollow(dx, dy) {
    const k = LOOK_RAD_PER_PX * this.lookSensitivity * this._aimLookScale();
    this.followYaw -= dx * k;
    const rest = Math.atan2(this.followHeight - this.followLookUp, this.followOffset);
    this.followPitch = THREE.MathUtils.clamp(this.followPitch + dy * k * (this.invertY ? -1 : 1), -1.2 - rest, 1.45 - rest);
  }

  /** Mouse look — and a gamepad's right stick — for first person and fly, at the chosen speed and limits. */
  _look(input, dt = 0) {
    const k = LOOK_RAD_PER_PX * this.lookSensitivity * this._aimLookScale();
    const limit = THREE.MathUtils.degToRad(this.pitchLimit);
    const pad = this._stick(input, dt);
    this.yaw -= (input.pointerDelta.dx + pad.x) * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch - (input.pointerDelta.dy + pad.y) * k * (this.invertY ? -1 : 1), -limit, limit);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  /** The right stick's push this frame, as if the mouse had moved that far. */
  _stick(input, dt) {
    const s = dt > 0 ? input.stick?.('right') : null;
    return s ? { x: s.x * STICK_PX * dt, y: s.y * STICK_PX * dt } : { x: 0, y: 0 };
  }

  /** Attach/detach the camera target without changing mode (e.g. pick a model). */
  setTarget(object3D) { this.target = object3D || null; }

  /** Where the target is drawn this frame: smoothed between physics slices, as the picture is. */
  _drawnAt(o, out) {
    return this.physics?.drawnPosition ? this.physics.drawnPosition(o, out) : drawnAt(o, out);
  }

  /** Field of view in degrees (updates the projection matrix). */
  setFov(deg) {
    const fov = THREE.MathUtils.clamp(Number(deg) || 60, 20, 120);
    if (fov !== this.camera.fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  update(dt, input) {
    if (this.enabled === false) return;
    switch (this.mode) {
      case 'orbit': this._orbit(dt, input); break;
      case 'follow': this._follow(dt, input); break;
      case 'fps': this._fps(dt, input); break;
      case 'free': this._free(dt, input); break;
    }
    this._applyShake(dt);
    this._applyRecoil(dt);
    this._applyFov(dt);
    // how far the camera sees: it was fixed at 1000 m, cutting off big worlds
    const far = Number(this.viewDistance) || 1000;
    if (this.camera.far !== far) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Open the field of view by `degrees` (sprinting); eased in and out. 0 = back to normal. */
  setFovBoost(degrees = 0) { this._fovBoostTarget = Math.max(0, Number(degrees) || 0); }

  /**
   * Aim (the Aim control), or stop aiming with null:
   *   { zoom: degrees narrower, look: mouse speed ×, closer: follow distance ×,
   *     shoulder: metres to the side (follow), time: seconds to get there,
   *     hideCrosshair }
   * It eases in and out over `time`; `aimBlend` says how far it has got.
   * `instant` jumps straight there (Play starting or stopping).
   */
  setAim(spec, { instant = false } = {}) {
    if (spec) this._aimSpec = { ...spec };
    this._aimOn = !!spec;
    if (instant) this._aim = this._aimOn ? 1 : 0;
  }

  _updateAim(dt) {
    const want = this._aimOn ? 1 : 0;
    const now = this._aim || 0;
    if (now === want) return;
    const time = Math.max(0, Number(this._aimSpec?.time) || 0);
    const step = time > 0 ? dt / time : 1;
    this._aim = want > now ? Math.min(1, now + step) : Math.max(0, now - step);
  }

  /** How far into aiming (0–1, eased), or 1 while the editor previews the aiming pose. */
  get aimBlend() {
    const t = this._aim || 0;
    return Math.max(t * t * (3 - 2 * t), this.previewAim ? 1 : 0);
  }

  /** Aiming has hidden the crosshair (sights instead). */
  get hidesCrosshair() { return !!this._aimSpec?.hideCrosshair && this._aimOn && this.aimBlend > 0.5; }

  /** How much aiming slows the mouse (1 = not at all). */
  _aimLookScale() {
    const look = Number(this._aimSpec?.look);
    return Number.isFinite(look) && look > 0 ? 1 + (look - 1) * this.aimBlend : 1;
  }

  _applyFov(dt) {
    // sprinting widens it (eased here), aiming narrows it (eased by _updateAim)
    this._updateAim(dt);
    const want = this._fovBoostTarget || 0;
    let boost = this._fovBoost || 0;
    boost += (want - boost) * Math.min(1, dt * 8);
    if (!want && boost < 0.05) boost = 0;
    this._fovBoost = boost;
    const extra = boost - (Number(this._aimSpec?.zoom) || 0) * (this.previewAim ? 0 : this.aimBlend);
    if (!extra && !this._fovExtra) return;
    this._fovExtra = extra;
    this.camera.fov = THREE.MathUtils.clamp(this.fovFor() + extra, 5, 150);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Recoil: kick the view up by `up` degrees and sideways by up to `side`
   * (either way, at random), and a held gun back by `back` metres. It settles
   * over `recover` seconds; 0 leaves the aim where the kick put it, so a burst
   * climbs and the player pulls it back down.
   */
  kick({ up = 1.5, side = 0.5, back = 0.03, recover = 0.2 } = {}) {
    const u = THREE.MathUtils.degToRad(Number(up) || 0);
    const s = THREE.MathUtils.degToRad((Math.random() * 2 - 1) * (Number(side) || 0));
    const r = this._recoil ?? (this._recoil = { pitch: 0, yaw: 0, back: 0, recover: 0.2 });
    if (Number(recover) > 0) {
      r.pitch += u;
      r.yaw += s;
      r.recover = Number(recover);
    } else if (this.mode === 'follow') {
      this.followPitch -= u; // tilting a follow camera down aims it up
      this.followYaw += s;
    } else {
      const limit = THREE.MathUtils.degToRad(this.pitchLimit);
      this.pitch = THREE.MathUtils.clamp(this.pitch + u, -limit, limit);
      this.yaw += s;
    }
    r.back = Math.min(0.3, r.back + Math.max(0, Number(back) || 0));
  }

  /** How far a held gun is kicked back right now (metres), for drawing it. */
  get gunKick() { return this._recoil?.back || 0; }

  _applyRecoil(dt) {
    const r = this._recoil;
    if (!r || (!r.pitch && !r.yaw && !r.back)) return;
    // on top of where the camera looks, like a shake — never fed back into the aim
    if (r.pitch || r.yaw) {
      this.camera.rotateOnWorldAxis(_UP, r.yaw);
      this.camera.rotateX(r.pitch);
    }
    const settle = Math.exp(-dt * 4 / Math.max(0.02, r.recover));
    r.pitch = Math.abs(r.pitch * settle) < 1e-5 ? 0 : r.pitch * settle;
    r.yaw = Math.abs(r.yaw * settle) < 1e-5 ? 0 : r.yaw * settle;
    const gun = Math.exp(-dt * 18); // the gun snaps back quicker than the view
    r.back = r.back * gun < 1e-4 ? 0 : r.back * gun;
  }

  /** Forget aiming and recoil: Play starting or stopping. */
  resetAim() {
    this.setAim(null, { instant: true });
    this._aimSpec = null;
    this._recoil = null;
    this.setFovBoost(0);
  }

  // ------------------------------------------------------------------ feel
  // How the view moves with the body (first person) and shakes (any camera).
  // Drawn on top of where the camera is — never fed back into it — so a bob or
  // a shake can't make the player drift or aim wrong afterwards.

  /**
   * Shake the view: `strength` 0–1 (a hit, a shot, an explosion), fading out
   * over `seconds`. "Shake strength" scales it; 0 turns shaking off.
   */
  shake(strength = 0.4, seconds = 0.35) {
    const s = Math.max(0, Number(strength) || 0);
    const secs = Math.max(0.05, Number(seconds) || 0.35);
    if (!s) return;
    // a stronger shake takes over; a weaker one during a big one adds nothing
    const now = this._shake?.left > 0 ? this._shake.strength * (this._shake.left / this._shake.seconds) : 0;
    if (s >= now) this._shake = { strength: s, seconds: secs, left: secs };
  }

  _applyShake(dt) {
    const sh = this._shake;
    if (!sh || sh.left <= 0 || !(this.shakeScale > 0)) return;
    sh.left = Math.max(0, sh.left - dt);
    const fade = sh.left / sh.seconds;
    const a = sh.strength * this.shakeScale * fade * fade; // eases out
    const t = (this._shakeT = (this._shakeT || 0) + dt);
    // layered sines rather than random: jittery without being noisy frame to frame
    const n = (f, o) => Math.sin(t * f + o) * 0.6 + Math.sin(t * f * 2.3 + o * 1.7) * 0.4;
    this.camera.position.x += n(31, 0) * a * 0.08;
    this.camera.position.y += n(37, 2) * a * 0.08;
    this.camera.rotation.x += n(29, 4) * a * 0.03;
    this.camera.rotation.y += n(33, 6) * a * 0.03;
    this.camera.rotation.z += n(27, 8) * a * 0.04;
  }

  /** How the first-person target is moving, from where it has been (m/s), smoothed. */
  _trackMotion(target, dt) {
    const p = this._drawnAt(target, _drawnB); // a step eased out is not a fall (no landing dip on a stair)
    const m = this._motion ?? (this._motion = { last: p.clone(), speed: 0, lateral: 0, vy: 0, fall: 0 });
    if (dt > 0) {
      const vx = (p.x - m.last.x) / dt;
      const vy = (p.y - m.last.y) / dt;
      const vz = (p.z - m.last.z) / dt;
      if (Math.hypot(vx, vy, vz) > 60) { m.last.copy(p); return m; } // a teleport, not a run
      const k = Math.min(1, dt * 12);
      m.speed += (Math.hypot(vx, vz) - m.speed) * k;
      // along the camera's right: (cos yaw, 0, -sin yaw)
      m.lateral += ((vx * Math.cos(this.yaw) - vz * Math.sin(this.yaw)) - m.lateral) * k;
      m.vy = vy;
    }
    m.last.copy(p);
    return m;
  }

  /** First person: head bob as it walks, breathing as it stands, a dip on landing, a lean when strafing. */
  _feel(dt, target) {
    if (!(this.headBob > 0 || this.breathing > 0 || this.landDip > 0 || this.strafeTilt > 0)) return;
    const m = this._trackMotion(target, dt);
    const f = this._feelState ?? (this._feelState = { phase: 0, amp: 0, breath: 0, dip: 0, dipV: 0, roll: 0, wasFalling: 0 });
    const onGround = Math.abs(m.vy) < 1.5;
    // walking: one bob up and down per step, one sway side to side per two
    const walking = onGround && m.speed > 0.3 ? Math.min(1, m.speed / 6) : 0;
    f.amp += (walking - f.amp) * Math.min(1, dt * 8);
    f.phase += (m.speed * dt / Math.max(0.1, this.bobStep)) * Math.PI;
    let up = Math.sin(f.phase * 2) * this.headBob * f.amp;
    const side = Math.sin(f.phase) * this.headBob * this.bobSway * f.amp;
    // standing: a slow breath, fading out as it starts to walk
    f.breath += dt;
    up += Math.sin(f.breath * Math.PI * 2 / 4) * this.breathing * (1 - f.amp);
    // landing: dip by how hard it came down, then spring back
    if (m.vy < -4) f.wasFalling = Math.max(f.wasFalling, -m.vy);
    else if (onGround && f.wasFalling) {
      f.dipV -= Math.min(0.5, f.wasFalling * 0.035) * this.landDip * 8;
      f.wasFalling = 0;
    }
    f.dipV += (-f.dip * 60 - f.dipV * 9) * dt; // a damped spring back to 0
    f.dip += f.dipV * dt;
    up += f.dip;
    // strafing: lean into the side it moves to
    const lean = -THREE.MathUtils.clamp(m.lateral / 6, -1, 1) * THREE.MathUtils.degToRad(this.strafeTilt);
    f.roll += (lean - f.roll) * Math.min(1, dt * 6);

    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.camera.position.addScaledVector(right, side);
    this.camera.position.y += up;
    this.camera.rotation.z += f.roll;
  }

  _orbit(dt, input) {
    this._turnLook('orbit');
    if (input.wheel) {
      this._focus = null; // scrolling takes over from a double-click glide
      this._zoomBy(Math.exp(input.wheel * WHEEL_ZOOM));
    }

    if (this._focus) {
      const f = this._focus;
      f.t = Math.min(1, f.t + dt / f.duration);
      const k = 1 - (1 - f.t) ** 3; // ease out
      this.lookAt.lerpVectors(f.fromLook, f.toLook, k);
      this.distance = f.fromDist + (f.toDist - f.fromDist) * k;
      if (f.t >= 1) this._focus = null;
    } else if (this.target && this.orbitLockTarget) {
      this.lookAt.lerp(this._drawnAt(this.target, _drawnA), 0.15);
    }

    const sinPhi = Math.sin(this.phi);
    const cosPhi = Math.cos(this.phi);
    this.camera.position.set(
      this.lookAt.x + this.distance * sinPhi * Math.sin(this.theta),
      this.lookAt.y + this.distance * cosPhi + this.orbitHeight,
      this.lookAt.z + this.distance * sinPhi * Math.cos(this.theta)
    );
    // "up" on screen follows the orbit (it's the way the camera moves as phi
    // shrinks), so looking straight down, or over the top, never flips the view.
    // Put back afterwards: other code calling camera.lookAt expects world-up.
    this.camera.up.set(-cosPhi * Math.sin(this.theta), sinPhi, -cosPhi * Math.cos(this.theta));
    this.camera.lookAt(this.lookAt);
    this.camera.up.set(0, 1, 0);
  }

  _follow(dt, input) {
    const target = this.target ?? this.fallbackTarget;
    if (!target) { this._orbit(dt, input); return; }
    if (input.wheel) {
      const lo = Math.min(this.followMin, this.followMax);
      this.followOffset = THREE.MathUtils.clamp(
        this.followOffset * Math.exp(input.wheel * WHEEL_ZOOM), lo, Math.max(lo, this.followMax));
    }
    if (this.followMouse && input.pointerLocked) this._turnFollow(input.pointerDelta.dx, input.pointerDelta.dy);
    if (this.followMouse) { // a gamepad's right stick turns it too, mouse captured or not
      const pad = this._stick(input, dt);
      if (pad.x || pad.y) this._turnFollow(pad.x, pad.y);
    }
    const t = this._drawnAt(target, _drawnA);
    // which way is "behind": the mouse's say, the target's facing, or where the camera started
    const heading = (this.followMouse ? this.followYaw : (this.rotateWithTarget ? headingOf(target) : this.followYaw))
      + THREE.MathUtils.degToRad(this.followTurn || 0); // round the target: 180 from the front, 90 from the side
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const rx = -fz; // the camera's right, for an over-the-shoulder offset
    const rz = fx;
    // aiming moves it in, over the shoulder
    const aim = this._aimSpec ? this.aimBlend : 0;
    const side = this.followSide + (Number(this._aimSpec?.shoulder) || 0) * aim;
    const closer = 1 + ((Number(this._aimSpec?.closer) || 1) - 1) * aim;
    const pivot = new THREE.Vector3(t.x + rx * side, t.y + this.followLookUp, t.z + rz * side);

    // at rest: Distance behind and Height above; the mouse tilts it round the pivot from there
    const up = this.followHeight - this.followLookUp;
    const reach = (Math.hypot(this.followOffset, up) || 0.001) * closer;
    const pitch = Math.atan2(up, this.followOffset) + (this.followMouse ? this.followPitch : 0)
      + THREE.MathUtils.degToRad(this.followTilt || 0); // from higher up (+) or lower down (−)
    const back = Math.cos(pitch) * reach;
    const desired = new THREE.Vector3(pivot.x - fx * back, pivot.y + Math.sin(pitch) * reach, pivot.z - fz * back);
    if (this.followLockY) desired.y = this.camera.position.y;

    // never behind a wall: pull in to just in front of whatever is in the way
    let pulledIn = false;
    if (this.followAvoidWalls && this.physics) {
      const toCamera = desired.clone().sub(pivot);
      const length = toCamera.length();
      const hit = length > 0.01 && this.physics.raycast(pivot, toCamera, length, {
        skip: (e, body) => body.isTrigger || body.type === 'dynamic' || e.object3D === target,
      });
      if (hit) {
        desired.copy(pivot).addScaledVector(toCamera.normalize(), Math.max(0.2, hit.distance - 0.25));
        pulledIn = true;
      }
    }

    // frame-rate independent smoothing; followLerp is "per second" (a wall snaps it in)
    const k = pulledIn ? 1 : 1 - Math.exp(-this.followLerp * dt * this.followDamping);
    this.camera.position.lerp(desired, k);

    // look at the target, optionally ahead of it
    const look = pivot.clone();
    look.x += fx * this.followLookAhead;
    look.z += fz * this.followLookAhead;
    this.camera.lookAt(look);
  }

  _fps(dt, input) {
    this._turnLook('fps');
    this._look(input, dt);
    const target = this.target ?? this.fallbackTarget;
    if (target) {
      const t = this._drawnAt(target, _drawnA);
      // at the eyes: Eye height up, Eye forward along where you look
      const f = this.eyeForward;
      // crouched: the eyes lower with the body, eased (controls.js)
      const drop = Number(target.userData?.eyeDrop) || 0;
      this._eyeDrop = (this._eyeDrop ?? 0) + (drop - (this._eyeDrop ?? 0)) * (1 - Math.exp(-12 * dt));
      this.camera.position.set(t.x - Math.sin(this.yaw) * f, t.y + this.eyeHeight - this._eyeDrop, t.z - Math.cos(this.yaw) * f);
      this._feel(dt, target);
    }
  }

  _free(dt, input) {
    this._turnLook('fly');
    this._look(input, dt);
    const fast = input.isDown('ShiftLeft') || input.isDown('ShiftRight') || input.isDown('PadLS');
    const speed = this.flySpeed * (fast ? this.flyFast : 1);
    const move = new THREE.Vector3();
    if (input.isDown('KeyW')) move.z -= 1;
    if (input.isDown('KeyS')) move.z += 1;
    if (input.isDown('KeyA')) move.x -= 1;
    if (input.isDown('KeyD')) move.x += 1;
    if (input.isDown('KeyE') || input.isDown('PadRB')) move.y += 1;
    if (input.isDown('KeyQ') || input.isDown('PadLB')) move.y -= 1;
    const stick = input.stick?.('left'); // a gamepad flies it too
    if (stick) { move.x += stick.x; move.z += stick.y; }
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed * dt);
      move.applyQuaternion(this.camera.quaternion);
      this._freePos.add(move);
    }
    this.camera.position.copy(this._freePos);
  }
}
