import * as THREE from 'three';

/**
 * CameraRig — switchable camera controller driven by the engine's camera.
 *
 *   const rig = new CameraRig(engine.camera, engine.renderer.domElement);
 *   rig.setMode('follow', { target: player.object3D });
 *   rig.update(dt, input);   // call every frame
 *
 * Modes:
 *   orbit  — drag to orbit a target, wheel to zoom (default)
 *   follow — chase cam behind a target object, wheel to zoom
 *   fps    — pointer-lock mouse look at a target's head + WASD (handled by Player)
 *   free   — pointer-lock fly cam: mouse look, WASD + Q/E up/down, Shift = fast
 */
export class CameraRig {
  static MODES = ['orbit', 'follow', 'fps', 'free'];

  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;
    this.mode = 'orbit';
    this.target = null; // THREE.Object3D for follow/fps/orbit

    // orbit / follow state
    this.theta = Math.PI * 0.25;
    this.phi = Math.PI / 3.2;
    this.distance = 14;
    this.lookAt = new THREE.Vector3(0, 1, 0);

    // fps / free yaw-pitch state
    this.yaw = 0;
    this.pitch = 0;
    this._freePos = camera.position.clone();
    this._dragging = false;
    this._last = { x: 0, y: 0 };

    domElement.addEventListener('mousedown', (e) => {
      if (this.mode === 'orbit' && e.button === 0) {
        this._dragging = true;
        this._last.x = e.clientX;
        this._last.y = e.clientY;
      }
    });
    window.addEventListener('mouseup', () => { this._dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (this._dragging && this.mode === 'orbit') {
        this.theta -= (e.clientX - this._last.x) * 0.005;
        this.phi = THREE.MathUtils.clamp(
          this.phi - (e.clientY - this._last.y) * 0.005, 0.15, Math.PI / 2 - 0.05
        );
        this._last.x = e.clientX;
        this._last.y = e.clientY;
      }
    });
  }

  /** Switch mode. opts.target = Object3D to follow/orbit/look from. */
  setMode(mode, { target = this.target } = {}) {
    if (!CameraRig.MODES.includes(mode)) return;
    this.mode = mode;
    this.target = target;
    // seed yaw/pitch from current camera so the view doesn't snap
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    this._freePos.copy(this.camera.position);
  }

  update(dt, input) {
    switch (this.mode) {
      case 'orbit': this._orbit(dt, input); break;
      case 'follow': this._follow(dt, input); break;
      case 'fps': this._fps(dt, input); break;
      case 'free': this._free(dt, input); break;
    }
  }

  _orbit(_dt, input) {
    this.distance = THREE.MathUtils.clamp(this.distance + input.wheel * 0.01, 3, 60);
    if (this.target) this.lookAt.lerp(this.target.position, 0.15);
    const sinPhi = Math.sin(this.phi);
    this.camera.position.set(
      this.lookAt.x + this.distance * sinPhi * Math.sin(this.theta),
      this.lookAt.y + this.distance * Math.cos(this.phi),
      this.lookAt.z + this.distance * sinPhi * Math.cos(this.theta)
    );
    this.camera.lookAt(this.lookAt);
  }

  _follow(dt, input) {
    if (!this.target) { this._orbit(dt, input); return; }
    this.distance = THREE.MathUtils.clamp(this.distance + input.wheel * 0.01, 3, 30);
    const t = this.target.position;
    const heading = this.target.rotation.y;
    const desired = new THREE.Vector3(
      t.x - Math.sin(heading) * this.distance * 0.45,
      t.y + this.distance * 0.45,
      t.z - Math.cos(heading) * this.distance * 0.45
    );
    this.camera.position.lerp(desired, 1 - Math.pow(0.001, dt)); // smooth chase
    this.camera.lookAt(t.x, t.y + 1, t.z);
  }

  _fps(dt, input) {
    const sens = 0.0022;
    this.yaw -= input.pointerDelta.dx * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.pointerDelta.dy * sens, -1.4, 1.4);
    if (this.target) {
      const t = this.target.position;
      this.camera.position.set(t.x, t.y + 1.1, t.z); // head height
    }
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  _free(dt, input) {
    const sens = 0.0022;
    this.yaw -= input.pointerDelta.dx * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.pointerDelta.dy * sens, -1.4, 1.4);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    const speed = (input.isDown('ShiftLeft') || input.isDown('ShiftRight')) ? 30 : 10;
    const move = new THREE.Vector3();
    if (input.isDown('KeyW')) move.z -= 1;
    if (input.isDown('KeyS')) move.z += 1;
    if (input.isDown('KeyA')) move.x -= 1;
    if (input.isDown('KeyD')) move.x += 1;
    if (input.isDown('KeyE')) move.y += 1;
    if (input.isDown('KeyQ')) move.y -= 1;
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed * dt);
      move.applyQuaternion(this.camera.quaternion);
      this._freePos.add(move);
    }
    this.camera.position.copy(this._freePos);
  }
}
