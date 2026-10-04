/**
 * Bump on every change worth telling apart in a running browser. It is printed
 * to the console and shown in the status bar, so "is my browser serving stale
 * modules?" is a question you can answer by looking, not by guessing.
 */
export const TINY3_VERSION = '0.40.2-camera-turn';

import * as THREE from 'three';
import { Input, isTyping } from './input.js';
import { PhysicsWorld } from './physics.js';
import { matchesWho } from './groups.js';
import { BehaviorRunner } from './behavior.js';
import { VariableStore } from './variables.js';
import { Gameplay } from './gameplay.js';
import { Environment } from './environment.js';
import { SoundSystem } from './sound.js';
import { setMaxAnisotropy, updateWorldUVs } from './materials.js';
import { normalizeUI } from './game-ui.js';
import { Effects } from './effects.js';
import { budgetLampShadows } from './light-shadows.js';
import { Probes } from './probes.js';
import { applyWorldDetail } from './world-detail.js';
import { updateRagdolls } from './ragdoll.js';
import { ScatterSystem } from './generators/scatter.js';
import { regenerate } from './generators/generated.js';
import { Instancer } from './instancing.js';
import { LodSystem } from './lod.js';
import { GroundPads } from './ground-pads.js';
import { EntityIndex } from './entity-index.js';
import { scriptApi } from './script-api.js';
import { applyPoses } from './poses.js';
import { PrefabLibrary } from './prefabs.js';
import { renderWithViewModels } from './view-model.js';
import { releaseAnimations } from './animation.js';
import { disposeObject } from './dispose.js';
import { Navigation } from './navigation.js';
import { ScriptModules } from './script-modules.js';

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
    // Shadows were never switched on, so every "Cast shadows" box did nothing.
    // PCF (not PCF-soft) because it honours shadow.radius — the softness setting.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    document.body.appendChild(this.renderer.domElement);
    // textures use the GPU's best anisotropic filtering (sharp floors at grazing angles)
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());
    // shared materials by name — "Save to library" in the Color & Texture panel
    this.materialLibrary = new Map();
    // reusable objects whose copies stay linked (prefabs.js); shared by every level
    this.prefabs = new PrefabLibrary();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);

    this.camera = new THREE.PerspectiveCamera(
      fov, window.innerWidth / window.innerHeight, 0.1, 1000
    );
    this.camera.position.set(0, 6, 12);
    this.camera.lookAt(0, 0, 0);

    // Given the 3D view so it can capture the mouse there for looking around.
    // (Made with no element, it asked `window` — which can't — so first-person
    // mouse look, fly and "mouse turns the camera" never got the mouse.)
    this.input = new Input(this.renderer.domElement);
    this.entities = [];
    this.entityIndex = new EntityIndex(); // the objects by name and by group (entity-index.js)
    this.onUpdate = null;         // user hook: (dt, engine) => {}
    this.onEntityRemoved = null;  // host hook, so the editor can unregister it
    this.paused = false;
    this.uiHold = false; // a screen or a dialogue that pauses the game is up (screens.js)
    this.onPauseKey = null; // host hook: P opens a pause menu instead of just freezing
    this.time = 0;
    // True only while the game is actually running. The editor leaves this false
    // so gameplay code (player control, auto-created bodies) cannot mutate a scene
    // the user is still building. An exported game sets it true at boot.
    this.playing = false;

    // animation + audio registries (editor features)
    this.physics = new PhysicsWorld();
    // "Passes through: the player" means whichever object is the player now
    this.physics.who = (selector, entity) => matchesWho(selector, entity, this);
    // a way round walls for followers and patrols, measured from the level's solid bodies
    this.navigation = new Navigation(this);
    this._behaviors = new BehaviorRunner(); // compiled per-entity scripts
    this.modules = new ScriptModules(this); // code the scripts share (script-modules.js)

    // --- gameplay layer: named state, components and rules ---
    this.variables = new VariableStore();
    this.gameplay = new Gameplay(this);
    // the entity the keyboard drives; components and rules resolve "player" to it
    this.player = null;
    // title screen and HUD styles (game-ui.js); on-screen messages go to the host
    this.ui = normalizeUI();
    this.onMessage = null; // (text, { seconds, where }) => void
    // visual-only bobs, leans and squashes (poses.js) — drawn, never simulated
    this.poses = new Map();

    // natural lighting: sun, sky, sky-light fill, reflections, fog, tone mapping
    this.effects = new Effects(this); // before the environment, which hands it the level's bloom
    this.instancing = new Instancer(this); // copies drawn together, in play
    this.lod = new LodSystem(this);        // far things simpler, farther ones not drawn, in play
    this.groundPads = new GroundPads(this); // terrain levelled under houses (ground-pads.js)
    this.probes = new Probes(this);        // rooms lit and reflected by themselves, not the sky (probes.js)
    this.scatter = new ScatterSystem(this, regenerate); // forests and meadows kept on the ground under them
    this.environment = new Environment(this);

    // editor reference grid — not part of the scene hierarchy / serialization
    this.grid = new THREE.GridHelper(100, 100, 0x6ee7b7, 0x3d4552);
    this.grid.name = '__grid';
    this.grid.position.y = 0;
    this.scene.add(this.grid);

    this.mixers = [];          // AnimationPlayers, one per animated model (animation.js)

    // one shared audio listener attached to the camera, and every sound in the
    // scene behind a mixer (see sound.js)
    this.listener = new THREE.AudioListener();
    this.camera.add(this.listener);
    this.audio = new SoundSystem(this.listener);

    this._clock = new THREE.Clock();
    this._resizeHandler = () => this._onResize();
    window.addEventListener('resize', this._resizeHandler);
    // P toggles pause — but not while the user is typing a name into a panel field,
    // and only while a game is running: in the editor it froze the camera,
    // selection and gizmo with nothing on screen to say why
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyP' || isTyping() || !this.playing) return;
      // an exported game opens its pause menu instead of silently freezing
      if (this.onPauseKey) this.onPauseKey();
      else this.togglePause();
    });
  }

  /** Add an entity: must have `object3D` (THREE.Object3D) and may have `update(dt, engine)`. */
  add(entity) {
    if (!this.entities.includes(entity)) this.entities.push(entity);
    this.entityIndex?.add(entity);
    // a parented entity lives under its parent's Object3D, not at the scene root
    if (entity.parent) entity.parent.object3D.add(entity.object3D);
    else this.scene.add(entity.object3D);
    this.physics.register(entity);
    if (typeof entity.start === 'function') entity.start(this);
    return entity;
  }

  remove(entity) {
    const i = this.entities.indexOf(entity);
    if (i !== -1) this.entities.splice(i, 1);
    this.entityIndex?.remove(entity);
    this.physics.unregister(entity);
    this.removeBehavior(entity);
    this.gameplay.components.clearEntity(entity);
    this.gameplay.rules.clearEntity(entity);
    const o = entity.object3D;
    o.removeFromParent(); // from under a parent object too, not only the top of the scene
    // What it held goes with it: shots and spawned enemies come and go all game,
    // and each one's animation player, sounds and GPU memory used to stay behind.
    releaseAnimations(this, o);
    this.poses?.delete(o);
    this.audio?.retire(entity);
    this.instancing?.forget(o); // its own materials back first, so they're the ones disposed
    disposeObject(o);
    // let the editor drop it from the hierarchy too — a rule that destroys an
    // object used to leave a dead row in the list and in every target dropdown
    this.onEntityRemoved?.(entity);
  }

  togglePause() { this.paused = !this.paused; }

  start() {
    this.renderer.setAnimationLoop(() => this._tick());
  }

  _tick() {
    let dt = Math.min(this._clock.getDelta(), 0.1); // clamp huge frames (tab switch)
    // the editor's Profiler, while it is open (tools/profiler.js): how long each part of a frame takes
    const P = this.profiler;
    P?.frameStart(this);
    this.input.poll(); // gamepads, read once a frame before anything asks what is held
    // the Debugger's "one frame": a frame's worth while paused (1/60 s, whatever the real time)
    const stepping = this.stepFrames > 0 && (this.paused || this.uiHold);
    if (stepping) { this.stepFrames--; dt = 1 / 60; }
    if ((!this.paused && !this.uiHold) || stepping) {
      this.time += dt;
      // advance physics first so bodies are in a valid state for gameplay code —
      // only in play: while editing, a body must stay where it is put (a player
      // with nothing under it fell out of the world before Play was pressed)
      P?.begin('physics');
      if (this.playing) this.physics.step(dt, this);
      P?.end('physics');
      for (const entity of this.entities) {
        if (typeof entity.update === 'function') entity.update(dt, this);
      }
      // components and rules only run in play mode, like the rest of gameplay
      if (this.playing) this.gameplay.update(dt, this.time);

      // run behavior scripts (the escape hatch under the component system) — in
      // play only: while editing, a script moved objects and the move was saved
      this._lastDt = dt;
      // a script that throws stops, and says so (the editor shows it; see onBehaviorError)
      // ...unless they are off: a game opened from a file, not yet trusted (script-trust.js)
      if (this.playing && this.scriptsAllowed !== false) {
        P?.begin('scripts');
        this._behaviors.run(dt, this.time, this.input.keyState,
          (b, err) => (this.onBehaviorError ? this.onBehaviorError(b.entity, err) : console.error('[Tiny3 behavior]', err)),
          P ? (b, ms) => P.item('scripts', b.entity.object3D?.name || 'unnamed', ms) : null);
        P?.end('scripts');
      }
      // advance every model's animation (one AnimationPlayer each, see animation.js)
      P?.begin('animation');
      for (const m of this.mixers) {
        m.beforeUpdate?.();
        m.mixer.update(dt * (m.speed ?? 1));
        m.afterUpdate?.(dt); // its rig: feet on the ground, a head that turns, root motion (ik.js)
      }
      updateRagdolls(this); // a limp character's bones follow its limbs (ragdoll.js)
      P?.end('animation');
      if (this.onUpdate) this.onUpdate(dt, this);
      this.onFrameDone?.(stepping); // the Debugger: a breakpoint met in this frame pauses after it
    }
    // clear per-frame input even while paused, or `wasPressed` latches forever
    this.input.endFrame();
    // even while paused: the sky follows the camera, and the view can still move
    this.environment.update(dt);
    updateWorldUVs(this.scene); // "tile by size" textures follow each object's scale
    this.groundPads.update(dt); // the ground kept out of what flattens it: a house moved, a terrain changed
    this.scatter.update(dt); // ...and what is scattered on it, placed again
    // physics runs in fixed slices: draw moving bodies smoothly between them
    const restoreMotion = this.playing ? this.physics.applyInterpolation() : null;
    const restorePoses = applyPoses(this.poses); // animation the physics must not see
    // far things simpler or not drawn (lod.js), then copies drawn together (instancing.js)
    const restoreDetail = this.lod.apply(this.camera);
    const restoreWorld = applyWorldDetail(this.entities, this.camera); // far terrain chunks simpler, far scatter cells not drawn
    this.probes.update(dt); // captured again when something changed; what moves takes the probe it is in
    // only the nearest few lamps cast shadows this frame (light-shadows.js)
    const env = this.environment?.settings;
    const restoreLamps = budgetLampShadows(this.scene, this.camera, env?.lampShadows ?? 4, env?.shadowQuality ?? 'medium');
    this.scene.updateMatrixWorld();
    this.instancing.sync(dt);
    // first person: arms and guns "held in view" are drawn locked to the camera
    P?.begin('render');
    renderWithViewModels(this.renderer, this.scene, this.camera, this.entities,
      this.cameraRig?.mode === 'fps', { aim: this.cameraRig?.aimBlend ?? 0, kick: this.cameraRig?.gunKick ?? 0 },
      (scene, camera, held) => this.effects.render(scene, camera, held)); // bloom, AO, depth of field, colour — when the level has them
    P?.end('render');
    restoreLamps?.();
    restoreWorld?.();
    restoreDetail?.();
    restorePoses();
    restoreMotion?.();
    P?.frameEnd(this);
  }

  /** Browsers block audio until a user gesture — resume the context on first click/key. */
  unlockAudio() { this.audio.unlock(); }

  /** Every sound record (see SoundSystem). */
  get sounds() { return this.audio.sounds; }
  set sounds(list) { this.audio.sounds = list; }

  /** The live behavior records (see behavior.js). */
  get behaviors() { return this._behaviors.items; }

  /** The entity that counts as "the player" for components and rules. */
  get playerEntity() {
    return this.player ? (this.player.target ?? this.player) : null;
  }

  /** Compile a per-frame script for an entity. See behavior.js for the script API. */
  addBehavior(entity, code) {
    return this._behaviors.add(entity, code, {
      engine: this,
      fire: () => this.playEntitySounds(entity, { trigger: 'fire' }),
      log: (...args) => { console.log('[behavior]', entity.object3D?.name, ...args); this.onScriptLog?.(entity, args); }, // (the Debugger's trace too)
      api: scriptApi(this, entity), // vars, find, act, spawn… (script-api.js)
    });
  }

  removeBehavior(entity) {
    this._behaviors.remove(entity);
  }

  // ---- sounds: thin wrappers over SoundSystem, which does the work ----

  /** Add a sound to an entity (or the scene, entity = null). See SoundSystem.add. */
  addSound(entity, buffer, opts = {}) { return this.audio.add(entity, buffer, opts); }
  removeSound(rec) { this.audio.remove(rec); }
  clearEntitySounds(entity) { this.audio.clearEntity(entity); }

  /** Play a sound by name — the entity's own first, then the scene's. Empty name = all of its sounds. */
  playSound(entity, name = '') { return this.audio.play(entity, name); }
  stopSound(entity, name = '', fade = 0) { return this.audio.stop(entity, name, fade); }
  playMusic(name, fade = 1) { return this.audio.playMusic(name, fade); }
  stopMusic(fade = 1) { this.audio.stopMusic(fade); }

  /** The old trigger-tag way ('fire', 'jump'), kept for behavior scripts and old scenes. */
  playEntitySounds(entity, { trigger = null } = {}) { return this.audio.playByTrigger(entity, trigger); }
  stopEntitySounds(entity) { this.audio.stop(entity); }

  /** Stop every sound in the engine (used when exiting play mode). */
  stopAllSounds() { this.audio.stopAll(); }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.effects?.setSize(window.innerWidth, window.innerHeight);
  }
}
