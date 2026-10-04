/**
 * Input — keyboard, mouse and pointer-lock tracker.
 *
 *   input.isDown('KeyW')          // held this frame
 *   input.wasPressed('Space')     // pressed since last frame (edge trigger)
 *   input.mouseDown(0)            // mouse button held (0 = left)
 *   input.mouseClicked(0)         // mouse button pressed since last frame
 *   input.mouseTapped(0)          // pressed AND released without dragging — a click
 *   input.mouseReleased(0)        // released since last frame (click or drag)
 *   input.mouse                   // { x, y } in pixels
 *   input.mouseNDC                // { x, y } in [-1, 1] — feed raycaster.setFromCamera
 *   input.wheel                   // wheel delta accumulated this frame
 *   input.pointerDelta            // { dx, dy } mouse movement this frame
 *   input.pointerLocked           // true while pointer lock is active
 *   input.requestPointerLock()    // lock the pointer (FPS / free cameras)
 *   input.exitPointerLock()
 */
/**
 * How far (px) a press may travel and still count as a click. Shared with the
 * camera so the two agree exactly: under this it selects, at or over it orbits.
 */
export const DRAG_THRESHOLD_PX = 4;

/** Clicks on these are UI, not the scene: editor panels, notices and on-screen game buttons. */
const UI_SELECTOR = '.panel, .dock, .t3-touch, .modal, .notice';

// ---------------------------------------------------------------- gamepads
// A gamepad's buttons and stick directions are codes like keys ('PadA',
// 'PadLStickUp'), so everything that takes a key takes them too: controls,
// "Key pressed" rules, keys.PadA in a script. Standard layout (Xbox names).

/** Buttons by their index in the standard layout. */
export const PAD_BUTTONS = [
  'PadA', 'PadB', 'PadX', 'PadY', 'PadLB', 'PadRB', 'PadLT', 'PadRT',
  'PadBack', 'PadStart', 'PadLS', 'PadRS', 'PadUp', 'PadDown', 'PadLeft', 'PadRight',
];
/** Stick directions: [axis, sign]. Up is a negative axis value. */
export const PAD_STICKS = {
  PadLStickUp: [1, -1], PadLStickDown: [1, 1], PadLStickLeft: [0, -1], PadLStickRight: [0, 1],
  PadRStickUp: [3, -1], PadRStickDown: [3, 1], PadRStickLeft: [2, -1], PadRStickRight: [2, 1],
};
/** A stick this close to the middle counts as let go (worn sticks never quite centre). */
export const PAD_DEADZONE = 0.2;

const beyondDeadzone = (v) => (v > PAD_DEADZONE ? Math.min(1, (v - PAD_DEADZONE) / (1 - PAD_DEADZONE)) : 0);

/** How far each gamepad code is pushed on one pad, 0..1 (a trigger or stick part way). */
export function padState(pad) {
  const out = new Map();
  if (!pad) return out;
  (pad.buttons || []).forEach((b, i) => {
    const code = PAD_BUTTONS[i];
    if (!code) return;
    // a button reports 1 when pressed; a trigger how far it is pulled
    const pressed = typeof b === 'object' ? b.pressed : Number(b) > 0.5;
    const value = typeof b === 'object' ? b.value : Number(b);
    if (pressed) out.set(code, Math.min(1, value > 0 ? value : 1));
  });
  for (const [code, [axis, sign]] of Object.entries(PAD_STICKS)) {
    const v = beyondDeadzone((pad.axes?.[axis] ?? 0) * sign);
    if (v > 0) out.set(code, v);
  }
  return out;
}

/** The gamepads plugged in now (none where the browser has no Gamepad API). */
function connectedPads() {
  try {
    return [...(navigator.getGamepads?.() || [])].filter((p) => p && p.connected !== false);
  } catch (_) {
    return []; // blocked by a permissions policy
  }
}

/**
 * Wait for the next key press, or gamepad button or stick push — for "press
 * what should do it". Calls `onCode(code)` once; Esc cancels with null.
 * Returns a function that stops waiting.
 */
export function captureNextInput(onCode, { ignore = [] } = {}) {
  const held = new Set();
  for (const pad of connectedPads()) for (const code of padState(pad).keys()) held.add(code);
  let frame = 0;
  const finish = (code) => { stop(); onCode(code); };
  const onKey = (ev) => {
    if (ignore.includes(ev.code)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation(); // the editor's own shortcuts (R = rotate…) must not fire
    finish(ev.code === 'Escape' ? null : ev.code);
  };
  const poll = () => {
    for (const pad of connectedPads()) {
      for (const code of padState(pad).keys()) if (!held.has(code)) { finish(code); return; }
    }
    frame = requestAnimationFrame(poll);
  };
  const stop = () => {
    window.removeEventListener('keydown', onKey, true);
    cancelAnimationFrame(frame);
  };
  window.addEventListener('keydown', onKey, true);
  frame = requestAnimationFrame(poll);
  return stop;
}

/** Inputs that take no typing: keys pressed on them are still shortcuts. */
const NOT_TEXT = new Set(['range', 'checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file', 'image']);

/**
 * Is the keyboard busy typing into a field? Then letters, digits and Ctrl+C / V /
 * Z belong to the text, not to the editor's shortcuts. (Typing "3" into a
 * position used to switch to the first-person camera, and Ctrl+V in a name field
 * pasted a copy of an object into the scene.)
 */
export function isTyping(el = typeof document !== 'undefined' ? document.activeElement : null) {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !NOT_TEXT.has(el.type);
}

export class Input {
  constructor(domElement = window) {
    this._down = new Set();
    this._pressed = new Set();
    this._mouseDown = new Set();
    this._mouseClicked = new Set();
    this._mouseTapped = new Set();
    this._mouseReleased = new Set();
    this._presses = new Map(); // button -> { x, y, travel } while held
    // on-screen game buttons, by id (see play-overlay.js); a touch joystick pushes part way
    this._virtualDown = new Set();
    this._virtualPressed = new Set();
    this._virtualValue = new Map();
    // gamepads, as read at the start of the frame: code -> how far (0..1), and both sticks
    this._pad = new Map();
    this.sticks = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };

    this.mouse = { x: 0, y: 0 };          // client pixels
    this.mouseNDC = { x: 0, y: 0 };       // normalized device coords
    this.pointerDelta = { dx: 0, dy: 0 }; // movement since last frame
    this.wheel = 0;
    this.pointerLocked = false;
    this._dom = domElement;

    // `keyState.KeyW` -> true while held. A proxy so behavior scripts can read
    // any key code without us allocating a fresh snapshot object every frame.
    this.keyState = new Proxy({}, {
      get: (_t, code) => this.isDown(code),
      has: (_t, code) => this.isDown(code),
      ownKeys: () => [...new Set([...this._down, ...this._pad.keys()])],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });

    window.addEventListener('keydown', (e) => {
      if (!this._down.has(e.code)) this._pressed.add(e.code);
      this._down.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      if (this._down.has(e.code)) (this._released ??= new Set()).add(e.code);
      this._down.delete(e.code);
    });
    window.addEventListener('blur', () => {
      this._down.clear();
      this._mouseDown.clear();
      this._presses.clear();
      this._virtualDown.clear();
    });

    window.addEventListener('mousedown', (e) => {
      // clicks on editor UI panels must not count as scene clicks
      if (e.target && e.target.closest && e.target.closest(UI_SELECTOR)) return;
      if (!this._mouseDown.has(e.button)) this._mouseClicked.add(e.button);
      this._mouseDown.add(e.button);
      this._presses.set(e.button, { x: e.clientX, y: e.clientY, travel: 0 });
    });
    window.addEventListener('mouseup', (e) => {
      this._mouseDown.delete(e.button);
      const press = this._presses.get(e.button);
      if (!press) return; // the press started on a panel
      this._presses.delete(e.button);
      this._mouseReleased.add(e.button);
      // furthest it ever got, so dragging away and back is still a drag
      const travel = Math.max(press.travel, Math.hypot(e.clientX - press.x, e.clientY - press.y));
      if (travel < DRAG_THRESHOLD_PX) this._mouseTapped.add(e.button);
    });

    window.addEventListener('mousemove', (e) => {
      for (const press of this._presses.values()) {
        press.travel = Math.max(press.travel, Math.hypot(e.clientX - press.x, e.clientY - press.y));
      }
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
      if (this.pointerLocked) {
        this.pointerDelta.dx += e.movementX;
        this.pointerDelta.dy += e.movementY;
      }
    });

    window.addEventListener('wheel', (e) => {
      // don't let panel scrolling leak into the 3D view
      if (e.target && e.target.closest && e.target.closest(UI_SELECTOR)) return;
      this.wheel += e.deltaY;
    }, { passive: true });

    // right-click is reserved for camera control in the 3D view, not the browser menu
    window.addEventListener('contextmenu', (e) => {
      if (e.target && e.target.closest && e.target.closest(UI_SELECTOR)) return;
      e.preventDefault();
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement != null;
    });
  }

  /** The element the mouse is captured on: the 3D view, or the page if none was given. */
  get lockTarget() {
    return this._dom?.requestPointerLock ? this._dom : (typeof document !== 'undefined' ? document.body : null);
  }

  requestPointerLock() {
    // newer browsers return a promise that rejects without a click; that's fine
    if (!this.pointerLocked) this.lockTarget?.requestPointerLock?.()?.catch?.(() => {});
  }

  exitPointerLock() {
    if (this.pointerLocked) document.exitPointerLock?.();
  }

  /**
   * Read the gamepads — once a frame, before anything asks what is held. A
   * button or stick direction pushed since the last read counts as pressed,
   * like a key going down.
   */
  poll() {
    const now = new Map();
    const sticks = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    for (const pad of connectedPads()) {
      for (const [code, v] of padState(pad)) now.set(code, Math.max(now.get(code) ?? 0, v));
      for (const [side, axis] of [['left', 0], ['right', 2]]) {
        const x = pad.axes?.[axis] ?? 0;
        const y = pad.axes?.[axis + 1] ?? 0;
        const m = Math.hypot(x, y);
        const k = beyondDeadzone(m);
        if (k > Math.hypot(sticks[side].x, sticks[side].y)) sticks[side] = { x: (x / m) * k, y: (y / m) * k };
      }
    }
    for (const code of now.keys()) if (!this._pad.has(code)) this._pressed.add(code);
    for (const code of this._pad.keys()) if (!now.has(code)) (this._released ??= new Set()).add(code);
    this._pad = now;
    this.sticks = sticks;
  }

  /** A stick's push, x right and y down, each -1..1 (nothing inside the dead zone). */
  stick(side = 'left') { return this.sticks[side] || { x: 0, y: 0 }; }

  isDown(code) { return this._down.has(code) || this._pad.has(code); }
  wasPressed(code) { return this._pressed.has(code); }
  /** Let go this frame (a key or a pad button). */
  wasReleased(code) { return !!this._released?.has(code); }
  /** How far a key or button is pushed, 0..1: a key all the way, a stick or trigger part way. */
  value(code) { return this._pad.get(code) ?? (this._down.has(code) ? 1 : 0); }
  mouseDown(button = 0) { return this._mouseDown.has(button); }
  mouseClicked(button = 0) { return this._mouseClicked.has(button); }
  /** Pressed and released this frame without travelling DRAG_THRESHOLD_PX. */
  mouseTapped(button = 0) { return this._mouseTapped.has(button); }
  /** Released this frame, whether it was a click or the end of a drag. */
  mouseReleased(button = 0) { return this._mouseReleased.has(button); }

  /** An on-screen button went down or up — or a touch joystick direction, pushed `value` (0..1) of the way. */
  setVirtual(id, down, value = 1) {
    if (down) {
      if (!this._virtualDown.has(id)) this._virtualPressed.add(id);
      this._virtualDown.add(id);
      this._virtualValue.set(id, value);
    } else {
      this._virtualDown.delete(id);
      this._virtualValue.delete(id);
    }
  }
  virtualDown(id) { return this._virtualDown.has(id); }
  virtualPressed(id) { return this._virtualPressed.has(id); }
  virtualValue(id) { return this._virtualDown.has(id) ? (this._virtualValue.get(id) ?? 1) : 0; }
  /** Let go of every on-screen button — when they are removed mid-press. */
  releaseVirtual() {
    this._virtualDown.clear();
    this._virtualPressed.clear();
    this._virtualValue.clear();
  }

  /** Call once per frame, after all updates, to clear per-frame state. */
  endFrame() {
    this._pressed.clear();
    this._released?.clear();
    this._virtualPressed.clear();
    this._mouseClicked.clear();
    this._mouseTapped.clear();
    this._mouseReleased.clear();
    this.pointerDelta.dx = 0;
    this.pointerDelta.dy = 0;
    this.wheel = 0;
  }
}
