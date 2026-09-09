/**
 * Input — keyboard state tracker.
 *
 *   input.isDown('KeyW')        // held this frame
 *   input.wasPressed('Space')   // pressed since last frame (edge trigger)
 */
export class Input {
  constructor() {
    this._down = new Set();
    this._pressed = new Set();

    window.addEventListener('keydown', (e) => {
      if (!this._down.has(e.code)) this._pressed.add(e.code);
      this._down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this._down.delete(e.code));
    window.addEventListener('blur', () => this._down.clear());
  }

  isDown(code) { return this._down.has(code); }
  wasPressed(code) { return this._pressed.has(code); }

  /** Call once per frame, after all updates, to clear edge-triggered presses. */
  endFrame() { this._pressed.clear(); }
}
