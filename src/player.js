import * as THREE from 'three';
import { Entity } from './entity.js';

const GRAVITY = -24;
const GROUND_Y = 0.5; // half the cube height
const BOUND = 14;     // arena half-extent

/**
 * Player — keyboard-driven character with REBINDABLE controls.
 *
 *   player.controls = {
 *     forward: ['KeyW', 'ArrowUp'],     // any of these codes = move forward
 *     back:    ['KeyS', 'ArrowDown'],
 *     left:    ['KeyA', 'ArrowLeft'],
 *     right:   ['KeyD', 'ArrowRight'],
 *     jump:    ['Space'],
 *   };
 *   player.speed = 8;          // move speed (units/sec)
 *   player.jumpVelocity = 9;
 *   player.enabled = true;     // false = editor takes over, player won't move
 *   player.rotateToMovement = true; // body turns toward travel direction
 *
 * In 'fps' camera mode movement is relative to the camera rig's yaw;
 * otherwise it is world-aligned.
 */
export class Player extends Entity {
  constructor() {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0x4dd0a6 });
    super(new THREE.Mesh(geometry, material));
    this.object3D.name = 'Player';
    this.object3D.position.set(0, GROUND_Y, 0);
    this.velocityY = 0;
    this.grounded = true;
    this.halfSize = new THREE.Vector3(0.5, 0.5, 0.5);

    // ---- user-adjustable control settings ----
    this.enabled = true;
    this.speed = 8;
    this.jumpVelocity = 9;
    this.rotateToMovement = true;
    this.controls = {
      forward: ['KeyW', 'ArrowUp'],
      back: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
      jump: ['Space'],
    };
  }

  /** True if any bound key for an action is currently held. */
  _held(input, action) {
    return this.controls[action]?.some((code) => input.isDown(code)) ?? false;
  }

  /** True if any bound key for an action was pressed this frame. */
  _pressed(input, action) {
    return this.controls[action]?.some((code) => input.wasPressed(code)) ?? false;
  }

  update(dt, engine) {
    if (!this.enabled) return;
    const input = engine.input;
    const pos = this.object3D.position;
    const fpsMode = engine.cameraRig?.mode === 'fps';

    let dx = 0, dz = 0;
    if (this._held(input, 'left')) dx -= 1;
    if (this._held(input, 'right')) dx += 1;
    if (this._held(input, 'forward')) dz -= 1;
    if (this._held(input, 'back')) dz += 1;

    if (dx !== 0 || dz !== 0) {
      // rotate input into camera space in fps mode
      const yaw = fpsMode ? engine.cameraRig.yaw : 0;
      const rx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const rz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      const len = Math.hypot(rx, rz);
      pos.x = THREE.MathUtils.clamp(pos.x + (rx / len) * this.speed * dt, -BOUND, BOUND);
      pos.z = THREE.MathUtils.clamp(pos.z + (rz / len) * this.speed * dt, -BOUND, BOUND);
      if (!fpsMode && this.rotateToMovement) {
        this.object3D.rotation.y = Math.atan2(rx, rz);
      }
    }

    if (fpsMode) {
      this.object3D.rotation.y = engine.cameraRig.yaw; // body faces look direction
    }

    if (this._pressed(input, 'jump') && this.grounded) {
      this.velocityY = this.jumpVelocity;
      this.grounded = false;
    }

    this.velocityY += GRAVITY * dt;
    pos.y += this.velocityY * dt;
    if (pos.y <= GROUND_Y) {
      pos.y = GROUND_Y;
      this.velocityY = 0;
      this.grounded = true;
    }
  }
}
