import * as THREE from 'three';
import { Input } from './input.js';
import { PhysicsWorld } from './physics.js';

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
    this.physics = new PhysicsWorld();
    this.behaviors = [];       // { entity, fn } compiled behavior scripts

    this.mixers = [];          // { root, mixer, clips, actions, current, speed, loop }

    // sounds: each entity can have multiple sounds.
    // Sound type determines behavior:
    //   'positional' -> THREE.PositionalAudio attached to the entity
    //   'ambient'    -> THREE.Audio added to the global listener
    //   'global'     -> THREE.Audio added to the global listener
    this.sounds = [];          // { entity, name, type, audio, volume, loop, autoplay, refDistance, trigger }

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
    this.physics.register(entity);
    if (typeof entity.start === 'function') entity.start(this);
    return entity;
  }

  remove(entity) {
    const i = this.entities.indexOf(entity);
    if (i !== -1) this.entities.splice(i, 1);
    this.physics.unregister(entity);
    this.removeBehavior(entity);
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
      // advance physics first so bodies are in a valid state for gameplay code
      this.physics.step(dt, this);
      for (const entity of this.entities) {
        if (typeof entity.update === 'function') entity.update(dt, this);
      }
      // run behavior scripts in play mode
      for (const b of this.behaviors) {
        try {
          b.scope.delta = dt;
          b.scope.time = this.time;
          b.scope.keys = this.input.keyState;
          b.fn.call(b.scope, dt, this.time);
        } catch (err) {
          console.error('[Tiny3 behavior]', b.entity.object3D.name, err.message);
        }
      }
      // advance animations + fade positional audio
      for (const m of this.mixers) {
        m.mixer.update(dt * (m.speed ?? 1));
        // autoplay in editor mode when a clip is selected but not running
        if (m.autoplay && m.current !== null && m.actions[m.current] && !m.actions[m.current].isRunning()) {
          m.actions[m.current].reset().play();
        }
      }
      if (this.onUpdate) this.onUpdate(dt, this);
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Browsers block audio until a user gesture — resume the context on first click/key. */
  unlockAudio() {
    const ctx = this.listener.context;
    if (ctx.state === 'suspended') ctx.resume();
  }

  /**
   * Add a sound to an entity.
   * @param {Object} entity
   * @param {ArrayBuffer} buffer
   * @param {Object} opts
   * @param {string} opts.name
   * @param {'positional'|'ambient'|'global'} opts.type
   * @param {number} [opts.volume=1]
   * @param {boolean} [opts.loop=false]
   * @param {boolean} [opts.autoplay=false]
   * @param {number} [opts.refDistance=5]
   * @param {string|null} [opts.trigger=null]  // 'fire' etc. for action sounds
   */
  addBehavior(entity, code) {
    this.removeBehavior(entity);
    if (!code || !code.trim()) return;
    const scope = {
      entity: entity.object3D,
      engine: this,
      get delta() { return 0; }, // replaced each frame
      get time() { return 0; },
      get keys() { return {}; },
      fire: () => this.playEntitySounds(entity, { trigger: 'fire' }),
      log: (...args) => console.log('[behavior]', entity.object3D.name, ...args),
    };
    const fn = new Function('dt', 'time', `
      const __keys = this.keys;
      const __fire = () => this.fire();
      const __log = (...a) => this.log(...a);
      ${code}
    `);
    this.behaviors.push({ entity, code, fn, scope });
  }

  removeBehavior(entity) {
    const i = this.behaviors.findIndex((b) => b.entity === entity);
    if (i !== -1) this.behaviors.splice(i, 1);
  }

  addSound(entity, buffer, opts = {}) {
    const type = opts.type || 'positional';
    const name = opts.name || 'sound';
    const volume = opts.volume ?? 1;
    const loop = !!opts.loop;
    const autoplay = !!opts.autoplay;
    const refDistance = opts.refDistance ?? 5;
    const trigger = opts.trigger || null;

    let audio;
    if (type === 'positional') {
      audio = new THREE.PositionalAudio(this.listener);
      audio.setRefDistance(refDistance);
      entity.object3D.add(audio);
    } else {
      audio = new THREE.Audio(this.listener);
    }
    audio.setBuffer(buffer);
    audio.setVolume(volume);
    audio.setLoop(loop);

    const rec = {
      entity, name, type, audio,
      volume, loop, autoplay, refDistance, trigger,
    };
    this.sounds.push(rec);

    if (autoplay && type !== 'positional') {
      this.unlockAudio();
      audio.play();
    }

    return rec;
  }

  /** Remove a specific sound record. */
  removeSound(rec) {
    const i = this.sounds.indexOf(rec);
    if (i === -1) return;
    if (rec.audio.isPlaying) rec.audio.stop();
    if (rec.type === 'positional') {
      rec.entity.object3D.remove(rec.audio);
    }
    rec.audio.disconnect?.();
    this.sounds.splice(i, 1);
  }

  /** Remove every sound attached to an entity. */
  clearEntitySounds(entity) {
    for (const rec of this.sounds.filter((s) => s.entity === entity)) {
      this.removeSound(rec);
    }
  }

  /** Play all sounds on an entity matching a trigger (or all if no trigger). */
  playEntitySounds(entity, { trigger = null, loop = null } = {}) {
    const matches = this.sounds.filter((s) => s.entity === entity && (!trigger || s.trigger === trigger));
    if (!matches.length) return false;
    this.unlockAudio();
    for (const rec of matches) {
      if (loop !== null) {
        rec.loop = !!loop;
        rec.audio.setLoop(rec.loop);
      }
      if (rec.audio.isPlaying) {
        if (!rec.loop) rec.audio.stop();
        else continue;
      }
      rec.audio.play();
    }
    return true;
  }

  /** Stop all sounds on an entity. */
  stopEntitySounds(entity) {
    for (const rec of this.sounds.filter((s) => s.entity === entity)) {
      if (rec.audio.isPlaying) rec.audio.stop();
    }
  }

  /** Stop every sound in the engine (used when exiting play mode). */
  stopAllSounds() {
    for (const rec of this.sounds) {
      if (rec.audio.isPlaying) rec.audio.stop();
    }
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
