// A small world for gameplay tests: physics, variables, gameplay, input driven by hand —
// no renderer. Shared by the tests of rules, controls, saves and collision layers.
import { vi } from 'vitest';
import * as THREE from 'three';
import { Entity } from '../../src/entity.js';
import { PhysicsWorld, RigidBody } from '../../src/physics.js';
import { VariableStore } from '../../src/variables.js';
import { Gameplay } from '../../src/gameplay.js';
import { matchesWho } from '../../src/groups.js';

/** Input driven by hand: keys and mouse buttons down, pressed, released this frame; where the pointer is. */
export function fakeInput() {
  return {
    _down: new Set(), _pressed: new Set(), _released: new Set(),
    _mouse: new Set(), _tapped: new Set(), _mouseUp: new Set(),
    mouseNDC: { x: 0, y: 0 }, pointerLocked: false,
    isDown(c) { return this._down.has(c); },
    wasPressed(c) { return this._pressed.has(c); },
    wasReleased(c) { return this._released.has(c); },
    mouseDown(b) { return this._mouse.has(b); },
    mouseTapped(b) { return this._tapped.has(b); },
    mouseClicked(b) { return this._tapped.has(b); },
    mouseReleased(b) { return this._mouseUp.has(b); },
    virtualDown() { return false; }, virtualPressed() { return false; },
    press(c) { this._down.add(c); this._pressed.add(c); },
    release(c) { this._down.delete(c); this._released.add(c); },
    endFrame() { this._pressed.clear(); this._released.clear(); this._tapped.clear(); this._mouseUp.clear(); },
  };
}

export function world({ controls = [] } = {}) {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 1, 10);
  camera.lookAt(0, 1, 0);
  camera.updateMatrixWorld(true);
  const engine = {
    entities: [], variables: new VariableStore(), physics: new PhysicsWorld(), scene: new THREE.Scene(),
    input: fakeInput(), camera, hero: null, poses: new Map(), time: 0, player: { target: null },
    cameraRig: { mode: 'orbit', shake: vi.fn(), setFovBoost: vi.fn() },
    onMessage: vi.fn(),
    get playerEntity() { return this.player.target ?? this.hero; },
    playEntitySounds: vi.fn(), addBehavior() {}, removeBehavior() {},
    // as Engine.remove: out of the level, its body, components and rules with it
    remove(entity) {
      const i = this.entities.indexOf(entity);
      if (i !== -1) this.entities.splice(i, 1);
      this.physics.unregister(entity);
      this.gameplay.components.clearEntity(entity);
      this.gameplay.rules.clearEntity(entity);
      entity.object3D.removeFromParent();
    },
  };
  engine.physics.who = (selector, entity) => matchesWho(selector, entity, engine); // as Engine does
  engine.gameplay = new Gameplay(engine);
  engine.gameplay.controls.load(controls);
  const add = (name, { at = [0, 0, 0], size = [1, 1, 1], body = null, groups = null } = {}) => {
    const e = new Entity(new THREE.Mesh(new THREE.BoxGeometry(...size)));
    e.object3D.name = name;
    e.object3D.position.set(...at);
    if (groups) e.groups = groups;
    engine.entities.push(e);
    engine.scene.add(e.object3D);
    if (body) {
      e.rigidBody = new RigidBody(body);
      engine.physics.register(e);
    }
    e.object3D.updateMatrixWorld(true);
    return e;
  };
  const step = (seconds = 1 / 60) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
      engine.time += 1 / 60;
      engine.scene.updateMatrixWorld(true);
      engine.physics.step(1 / 60);
      engine.gameplay.update(1 / 60, engine.time);
      engine.input.endFrame();
    }
  };
  return { engine, add, step, input: engine.input };
}
