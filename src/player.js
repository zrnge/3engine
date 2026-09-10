import * as THREE from 'three';
import { Entity, getWorldHalfSize } from './entity.js';
import { RigidBody } from './physics.js';

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
    this.object3D.position.set(0, 1.5, 0);
    this.velocityY = 0;
    this.grounded = true;
    this.halfSize = new THREE.Vector3(0.5, 0.5, 0.5);
    this.rigidBody = new RigidBody({ type: 'dynamic', mass: 70, friction: 0.1, gravity: -24, restitution: 0 });

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
      fire: ['KeyF'],
    };

    // action callbacks — editor/game can hook into fire/jump/etc
    this.onFire = null; // set externally: (player, engine) => {}
    this.onJump = null;

    // target entity that actually moves; defaults to self
    this.target = null;
  }

  /** The object3D currently being controlled. */
  get controlledObject() {
    return this.target ? this.target.object3D : this.object3D;
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
    const object3D = this.controlledObject;
    const body = object3D.userData.body || this.rigidBody;
    if (!body || body.type !== 'dynamic') return;

    const fpsMode = engine.cameraRig?.mode === 'fps';

    let dx = 0, dz = 0;
    if (this._held(input, 'left')) dx -= 1;
    if (this._held(input, 'right')) dx += 1;
    if (this._held(input, 'forward')) dz -= 1;
    if (this._held(input, 'back')) dz += 1;

    if (dx !== 0 || dz !== 0) {
      const yaw = fpsMode ? engine.cameraRig.yaw : 0;
      const rx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const rz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      const len = Math.hypot(rx, rz);
      const targetSpeed = this.speed;
      const accel = this.speed * 6 * dt;
      body.velocity.x += (rx / len) * accel;
      body.velocity.z += (rz / len) * accel;
      // clamp horizontal speed
      const hs = Math.hypot(body.velocity.x, body.velocity.z);
      if (hs > targetSpeed) {
        const scale = targetSpeed / hs;
        body.velocity.x *= scale;
        body.velocity.z *= scale;
      }

      if (!fpsMode && this.rotateToMovement) {
        object3D.rotation.y = Math.atan2(rx, rz);
      }
    } else {
      // brake quickly when no movement keys are held so the player doesn't slide
      const brake = Math.min(1, 12 * dt);
      body.velocity.x *= (1 - brake);
      body.velocity.z *= (1 - brake);
      if (Math.abs(body.velocity.x) < 0.01) body.velocity.x = 0;
      if (Math.abs(body.velocity.z) < 0.01) body.velocity.z = 0;
    }

    if (fpsMode) {
      object3D.rotation.y = engine.cameraRig.yaw;
    }

    if (this._pressed(input, 'jump') && body.grounded) {
      body.velocity.y = this.jumpVelocity;
      body.grounded = false;
      if (typeof this.onJump === 'function') this.onJump(this, engine);
    }

    if (this._pressed(input, 'fire')) {
      if (typeof this.onFire === 'function') this.onFire(this, engine);
    }
  }
}
