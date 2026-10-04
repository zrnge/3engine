import * as THREE from 'three';
import { Entity } from './entity.js';
import { RigidBody } from './physics.js';

/**
 * Player — decides which object "the player" is.
 *
 *   player.target = someEntity;   // that object is the player; null = this hidden cube
 *
 * What the player can DO lives in the scene's controls (see controls.js): every
 * key, mouse button and on-screen button, and what each one does, is data the
 * Controls panel edits. Nothing here is hardcoded any more.
 */
/** Where the hidden stand-in player starts — and is put back on every scene load. */
export const PLAYER_HOME = Object.freeze([0, 1.5, 0]);

export class Player extends Entity {
  constructor() {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0x4dd0a6 });
    super(new THREE.Mesh(geometry, material));
    this.object3D.name = 'Player';
    this.object3D.userData.kind = 'Player';
    // Never drawn: it stands in for a player until an object is chosen. Hidden
    // here, not by whoever makes it — an exported game made it without hiding it,
    // and every game had a green cube where the player starts.
    this.object3D.visible = false;
    this.object3D.position.set(...PLAYER_HOME);
    this.halfSize = new THREE.Vector3(0.5, 0.5, 0.5);
    // a capsule: its rounded feet ride over bumps and it steps up ledges and stairs,
    // where a box's flat bottom caught on every edge of rough ground and juddered
    this.rigidBody = new RigidBody({ type: 'dynamic', mass: 70, friction: 0.1, gravity: -24, restitution: 0, shape: 'capsule' });

    // the entity that actually plays; defaults to self
    this.target = null;
    this._ownBodyDetached = false;
  }

  /**
   * Back where it starts, standing still. It is no object in the scene, so no
   * save holds it: Play → Stop left it wherever the game had taken it (and the
   * first-person view with it), and every level began where the last one ended.
   */
  reset() {
    this.object3D.position.set(...PLAYER_HOME);
    this.object3D.rotation.set(0, 0, 0);
    if (this.rigidBody) {
      this.rigidBody.velocity.set(0, 0, 0);
      this.rigidBody.grounded = false;
    }
  }

  /** The entity currently being driven — the chosen target, or this Player. */
  get controlled() {
    return this.target ?? this;
  }

  /** The object3D currently being controlled. */
  get controlledObject() {
    return this.controlled.object3D;
  }

  /**
   * When another entity is the player, this one's (invisible) body must stop
   * simulating — otherwise a hidden cube falls through the level shoving things.
   */
  _syncOwnBody(engine) {
    const driving = !!this.target;
    if (driving === this._ownBodyDetached) return;
    if (driving) engine.physics.unregister(this);
    else if (this.rigidBody) engine.physics.register(this);
    this._ownBodyDetached = driving;
  }

  update(dt, engine) {
    // inert in the editor: gameplay only runs in Play mode
    if (!engine.playing) return;
    this._syncOwnBody(engine);
  }
}
