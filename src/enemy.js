import * as THREE from 'three';
import { Entity } from './entity.js';

const BOUND = 9;

/** Collectible spinning coin. Pick it up for +1 score. */
export class Coin extends Entity {
  constructor(x, z) {
    const geometry = new THREE.CylinderGeometry(0.4, 0.4, 0.1, 24);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffd166, metalness: 0.6, roughness: 0.3,
    });
    super(new THREE.Mesh(geometry, material));
    this.object3D.rotation.x = Math.PI / 2;
    this.object3D.position.set(x, 0.6, z);
    this.halfSize = new THREE.Vector3(0.45, 0.45, 0.45);
  }

  update(dt) {
    this.object3D.rotation.z += dt * 3;
    this.object3D.position.y = 0.6 + Math.sin(performance.now() / 400) * 0.1;
  }

  static randomPosition() {
    return [
      (Math.random() * 2 - 1) * BOUND,
      (Math.random() * 2 - 1) * BOUND,
    ];
  }
}

const ENEMY_SPEED = 2.2;

/** Homing enemy sphere. Touch it and you lose a life. */
export class Enemy extends Entity {
  constructor(target) {
    const geometry = new THREE.IcosahedronGeometry(0.55, 0);
    const material = new THREE.MeshStandardMaterial({
      color: 0xef476f, flatShading: true,
    });
    super(new THREE.Mesh(geometry, material));

    // spawn on a random edge of the arena
    const side = Math.floor(Math.random() * 4);
    const along = (Math.random() * 2 - 1) * BOUND;
    const edge = [
      [along, -BOUND], [along, BOUND], [-BOUND, along], [BOUND, along],
    ][side];
    this.object3D.position.set(edge[0], 0.55, edge[1]);

    this.target = target; // usually the player
    this.halfSize = new THREE.Vector3(0.55, 0.55, 0.55);
    this.speed = ENEMY_SPEED + Math.random() * 1.5;
  }

  update(dt) {
    const pos = this.object3D.position;
    const t = this.target.object3D.position;
    const dx = t.x - pos.x, dz = t.z - pos.z;
    const len = Math.hypot(dx, dz) || 1;
    pos.x += (dx / len) * this.speed * dt;
    pos.z += (dz / len) * this.speed * dt;
    this.object3D.rotation.y = Math.atan2(dx, dz);
    this.object3D.rotation.x += dt * 4;
  }
}
