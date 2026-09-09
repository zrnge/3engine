import * as THREE from 'three';
import { Entity } from './entity.js';

const SPEED = 8;
const JUMP_VELOCITY = 9;
const GRAVITY = -24;
const GROUND_Y = 0.5; // half the cube height
const BOUND = 14;     // arena half-extent

/**
 * Player — WASD/arrows + Space. In 'fps' camera mode movement is relative to
 * the camera rig's yaw; otherwise it is world-aligned.
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
  }

  update(dt, engine) {
    const input = engine.input;
    const pos = this.object3D.position;

    let dx = 0, dz = 0;
    if (input.isDown('KeyA') || input.isDown('ArrowLeft')) dx -= 1;
    if (input.isDown('KeyD') || input.isDown('ArrowRight')) dx += 1;
    if (input.isDown('KeyW') || input.isDown('ArrowUp')) dz -= 1;
    if (input.isDown('KeyS') || input.isDown('ArrowDown')) dz += 1;

    if (dx !== 0 || dz !== 0) {
      // rotate input into camera space in fps mode
      const yaw = engine.cameraRig?.mode === 'fps' ? engine.cameraRig.yaw : 0;
      const rx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const rz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      const len = Math.hypot(rx, rz);
      pos.x = THREE.MathUtils.clamp(pos.x + (rx / len) * SPEED * dt, -BOUND, BOUND);
      pos.z = THREE.MathUtils.clamp(pos.z + (rz / len) * SPEED * dt, -BOUND, BOUND);
      if (engine.cameraRig?.mode !== 'fps') {
        this.object3D.rotation.y = Math.atan2(rx, rz);
      }
    }

    if (engine.cameraRig?.mode === 'fps') {
      this.object3D.rotation.y = engine.cameraRig.yaw; // body faces look direction
    }

    if (input.wasPressed('Space') && this.grounded) {
      this.velocityY = JUMP_VELOCITY;
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
