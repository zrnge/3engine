import * as THREE from 'three';
import { Entity } from './entity.js';

const SPEED = 8;
const JUMP_VELOCITY = 10;
const GRAVITY = -24;
const GROUND_Y = 0.5; // half the cube height
const BOUND = 9;      // arena half-extent

/** Player-controlled cube: WASD/arrows to move, Space to jump. */
export class Player extends Entity {
  constructor() {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0x4dd0a6 });
    super(new THREE.Mesh(geometry, material));
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
      const len = Math.hypot(dx, dz);
      pos.x = THREE.MathUtils.clamp(pos.x + (dx / len) * SPEED * dt, -BOUND, BOUND);
      pos.z = THREE.MathUtils.clamp(pos.z + (dz / len) * SPEED * dt, -BOUND, BOUND);
      this.object3D.rotation.y = Math.atan2(dx, dz);
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

    // little spin while airborne, for juice
    if (!this.grounded) this.object3D.rotation.x += dt * 6;
    else this.object3D.rotation.x = 0;
  }
}
