/**
 * Input — keyboard, mouse and pointer-lock tracker.
 *
 *   input.isDown('KeyW')          // held this frame
 *   input.wasPressed('Space')     // pressed since last frame (edge trigger)
 *   input.mouseDown(0)            // mouse button held (0 = left)
 *   input.mouseClicked(0)         // mouse button pressed since last frame
 *   input.mouse                   // { x, y } in pixels
 *   input.mouseNDC                // { x, y } in [-1, 1] — feed raycaster.setFromCamera
 *   input.wheel                   // wheel delta accumulated this frame
 *   input.pointerDelta            // { dx, dy } mouse movement this frame
 *   input.pointerLocked           // true while pointer lock is active
 *   input.requestPointerLock()    // lock the pointer (FPS / free cameras)
 *   input.exitPointerLock()
 */
export class Input {
  constructor(domElement = window) {
    this._down = new Set();
    this._pressed = new Set();
    this._mouseDown = new Set();
    this._mouseClicked = new Set();

    this.mouse = { x: 0, y: 0 };          // client pixels
    this.mouseNDC = { x: 0, y: 0 };       // normalized device coords
    this.pointerDelta = { dx: 0, dy: 0 }; // movement since last frame
    this.wheel = 0;
    this.pointerLocked = false;
    this._dom = domElement;

    window.addEventListener('keydown', (e) => {
      if (!this._down.has(e.code)) this._pressed.add(e.code);
      this._down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this._down.delete(e.code));
    window.addEventListener('blur', () => {
      this._down.clear();
      this._mouseDown.clear();
    });

    window.addEventListener('mousedown', (e) => {
      // clicks on editor UI panels must not count as scene clicks
      if (e.target && e.target.closest && e.target.closest('.panel')) return;
      if (!this._mouseDown.has(e.button)) this._mouseClicked.add(e.button);
      this._mouseDown.add(e.button);
    });
    window.addEventListener('mouseup', (e) => this._mouseDown.delete(e.button));

    window.addEventListener('mousemove', (e) => {
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
      if (e.target && e.target.closest && e.target.closest('.panel')) return;
      this.wheel += e.deltaY;
    }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement != null;
    });
  }

  requestPointerLock() {
    if (!this.pointerLocked) this._dom.requestPointerLock?.();
  }

  exitPointerLock() {
    if (this.pointerLocked) document.exitPointerLock?.();
  }

  isDown(code) { return this._down.has(code); }
  wasPressed(code) { return this._pressed.has(code); }
  mouseDown(button = 0) { return this._mouseDown.has(button); }
  mouseClicked(button = 0) { return this._mouseClicked.has(button); }

  /** Call once per frame, after all updates, to clear per-frame state. */
  endFrame() {
    this._pressed.clear();
    this._mouseClicked.clear();
    this.pointerDelta.dx = 0;
    this.pointerDelta.dy = 0;
    this.wheel = 0;
  }
}
