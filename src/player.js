import * as THREE from 'three';
import { Entity, getWorldHalfSize } from './entity.js';

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
      fire: ['KeyF'],
    };

    // action callbacks — editor/game can hook into fire/jump/etc
    this.onFire = null; // set externally: (player, engine) => {}
    this.onJump = null;
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
      const vx = (rx / len) * this.speed * dt;
      const vz = (rz / len) * this.speed * dt;

      // try X movement, then Z, sliding along solid walls
      pos.x = THREE.MathUtils.clamp(pos.x + vx, -BOUND, BOUND);
      this._resolveSolidCollision(engine, pos);
      pos.z = THREE.MathUtils.clamp(pos.z + vz, -BOUND, BOUND);
      this._resolveSolidCollision(engine, pos);

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
      if (typeof this.onJump === 'function') this.onJump(this, engine);
    }

    if (this._pressed(input, 'fire')) {
      if (typeof this.onFire === 'function') this.onFire(this, engine);
    }

    this.velocityY += GRAVITY * dt;
    pos.y += this.velocityY * dt;
    if (pos.y <= GROUND_Y) {
      pos.y = GROUND_Y;
      this.velocityY = 0;
      this.grounded = true;
    }
  }

  /** Push the player out of any solid entity's world AABB (axis-separated, so we slide). */
  _resolveSolidCollision(engine, pos) {
    const playerBox = new THREE.Box3().setFromObject(this.object3D);
    const playerCenter = new THREE.Vector3();
    const playerSize = new THREE.Vector3();
    playerBox.getCenter(playerCenter);
    playerBox.getSize(playerSize);
    const pHalf = playerSize.multiplyScalar(0.5);

    for (const entity of engine.entities) {
      if (!entity || entity === this || !entity.solid) continue;
      const { center, halfSize } = getWorldHalfSize(entity.object3D);

      // only block horizontal movement when vertically overlapping
      const overlapY = pHalf.y + halfSize.y - Math.abs(playerCenter.y - center.y);
      if (overlapY <= 0) continue;

      const overlapX = pHalf.x + halfSize.x - Math.abs(pos.x - center.x);
      const overlapZ = pHalf.z + halfSize.z - Math.abs(pos.z - center.z);

      if (overlapX > 0 && overlapZ > 0) {
        // resolve the smaller axis overlap so we slide along walls
        if (overlapX < overlapZ) {
          pos.x = center.x + (pos.x > center.x ? 1 : -1) * (pHalf.x + halfSize.x);
        } else {
          pos.z = center.z + (pos.z > center.z ? 1 : -1) * (pHalf.z + halfSize.z);
        }
      }
    }
  }
}
