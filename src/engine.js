import * as THREE from 'three';
import { Input } from './input.js';

/**
 * Engine — core game loop, renderer, scene and entity management.
 *
 * Usage:
 *   const engine = new Engine();
 *   engine.add(myEntity);          // entity: { object3D, update(dt, engine) }
 *   engine.onUpdate = (dt) => {};  // optional per-frame hook
 *   engine.start();
 */
export class Engine {
  constructor({ background = 0x0b0e14, fov = 60 } = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);

    this.camera = new THREE.PerspectiveCamera(
      fov, window.innerWidth / window.innerHeight, 0.1, 1000
    );
    this.camera.position.set(0, 6, 12);
    this.camera.lookAt(0, 0, 0);

    this.input = new Input();
    this.entities = [];
    this.onUpdate = null;      // user hook: (dt, engine) => {}
    this.paused = false;
    this.time = 0;

    // animation + audio registries (editor features)
    this.mixers = [];          // { root, mixer, clips, actions, current, speed, loop }
    this.sounds = [];          // { entity, audio, name, volume, loop, autoplay, refDistance }

    // one shared audio listener attached to the camera
    this.listener = new THREE.AudioListener();
    this.camera.add(this.listener);

    this._clock = new THREE.Clock();
    this._resizeHandler = () => this._onResize();
    window.addEventListener('resize', this._resizeHandler);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyP') this.togglePause();
    });
  }

  /** Add an entity: must have `object3D` (THREE.Object3D) and may have `update(dt, engine)`. */
  add(entity) {
    this.entities.push(entity);
    this.scene.add(entity.object3D);
    if (typeof entity.start === 'function') entity.start(this);
    return entity;
  }

  remove(entity) {
    const i = this.entities.indexOf(entity);
    if (i !== -1) this.entities.splice(i, 1);
    this.scene.remove(entity.object3D);
  }

  togglePause() { this.paused = !this.paused; }

  start() {
    this.renderer.setAnimationLoop(() => this._tick());
  }

  _tick() {
    const dt = Math.min(this._clock.getDelta(), 0.1); // clamp huge frames (tab switch)
    if (!this.paused) {
      this.time += dt;
      for (const entity of this.entities) {
        if (typeof entity.update === 'function') entity.update(dt, this);
      }
      // advance animations + fade positional audio
      for (const m of this.mixers) m.mixer.update(dt * (m.speed ?? 1));
      if (this.onUpdate) this.onUpdate(dt, this);
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Browsers block audio until a user gesture — resume the context on first click/key. */
  unlockAudio() {
    const ctx = this.listener.context;
    if (ctx.state === 'suspended') ctx.resume();
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
