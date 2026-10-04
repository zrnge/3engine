import * as THREE from 'three';
import { AudioLoader } from 'three';
import { Entity } from './entity.js';
import { Player } from './player.js';
import { Coin } from './enemy.js';
import { LightEntity } from './light-entity.js'; // not the editor: exported games load this file
import { makeProbe, isProbe } from './probes.js';
import { assetStore } from './assets-db.js';
import { controlsFromLegacy } from './controls.js';
import { MIX_DEFAULTS } from './sound.js';
import { sfxBuffer } from './sfx.js';
import { materialSpec, createMaterial, materialReady } from './materials.js';
import { modelMaterialRecord, adoptModelMaterials } from './model-parts.js';
import { normalizeUI } from './game-ui.js';
import { RigidBody, DEFAULT_GRAVITY } from './physics.js';
import { prefabFromEntity, instanceRecord, legacySolidBody } from './prefabs.js';
import { normalizeViewModel } from './view-model.js';
import { GENERATORS, makeGenerated, generatorOf } from './generators/generated.js';
import { saveFields, loadFields } from './entity-fields.js';
import { groupsOf, normalizeGroups } from './groups.js';
import { normalizePhysicsParts } from './physics-parts.js';
import { cameraSettingsOf, applyCameraSettings, CAMERA_DEFAULTS } from './cameras.js';
import {
  PRIMITIVE_GEOS, LIGHT_TYPES, primitiveKind, lightKind, firstMesh,
  applyStoredTexture, textureRecord,
} from './factories.js';

/**
 * SceneSerializer — save/load the whole editor scene as JSON.
 *
 * Covers everything the editor itself can create:
 *   - primitive props (box/sphere/cone/cylinder/torus) + their materials
 *   - loaded GLB models (by asset URL)
 *   - lights (directional/point/spot/ambient) + color/intensity/shadow
 *   - which object is the player, and every control (input -> action)
 *   - coins
 *   - camera rig settings (mode, target, FOV, follow offset/height/smooth)
 *
 *   const ser = new SceneSerializer(engine, editor, rig, player, assets);
 *   const json = ser.serialize();          // -> plain object (JSON-safe)
 *   await ser.deserialize(json);           // rebuilds the scene
 *   ser.saveToFile();                      // downloads scene.json
 *   await ser.loadFromFile();              // opens a file picker
 */



function v3(v) { return [round(v.x), round(v.y), round(v.z)]; }
function round(n) { return Math.round(n * 1000) / 1000; }
/**
 * Sizes keep their significant digits, not 3 decimals: a model made in
 * millimetres is scaled 0.0004, which rounded to 0 and vanished on reload.
 */
function size3(v) { return [sig(v.x), sig(v.y), sig(v.z)]; }
function sig(n) { return Number(n.toPrecision(6)); }



export class SceneSerializer {
  /**
   * @param {Engine} engine
   * @param {ObjectEditor} editor
   * @param {CameraRig} rig
   * @param {Player} player
   * @param {AssetLoader} assets
   */
  constructor(engine, editor, rig, player, assets) {
    this.engine = engine;
    this.editor = editor;
    this.rig = rig;
    this.player = player;
    this.assets = assets;
    this._audioLoader = new AudioLoader();
  }

  // ---------- serialize ----------

  serialize() {
    // Links between objects — parent, camera target, player — are saved as
    // places in `entities`, so they count only what made it into the list.
    // (They counted every object: one that couldn't be saved shifted every
    // link after it onto the wrong object.)
    const entities = [];
    const saved = []; // the entity behind each record
    for (const entity of this.editor.selectables) {
      const data = this._serializeEntity(entity);
      if (!data) continue;
      entities.push(data);
      saved.push(entity);
    }
    entities.forEach((d, i) => { d.parent = saved[i].parent ? saved.indexOf(saved[i].parent) : -1; });
    // its place in the level, which loading it gives it again: how a saved game knows it (saves.js)
    saved.forEach((e, i) => { e.levelKey = i; });

    const rig = this.rig;
    const targetIdx = rig.target ? saved.findIndex((e) => e.object3D === rig.target) : -1;

    return {
      version: 1,
      meta: { app: 'Tiny3', savedAt: new Date().toISOString() },
      camera: {
        mode: rig.mode,
        target: targetIdx, // index into entities[], -1 = none
        playMode: rig.playMode || undefined, // "When playing" camera
        // every camera's adjustable settings, as the Camera panel shows them
        // (cameras.js CAMERA_SETTINGS) — several used to be left out of saves
        settings: cameraSettingsOf(rig),
        // free/orbit viewpoint so a reload restores roughly where you were
        position: v3(this.engine.camera.position),
        theta: round(rig.theta),
        phi: round(rig.phi),
        lookAt: v3(rig.lookAt),
      },
      player: this._serializePlayer(saved),
      controls: this.engine.gameplay ? this.engine.gameplay.controls.toJSON() : undefined,
      sceneSounds: this._serializeSounds(null), // music and ambience, not on any object
      audio: this.engine.audio ? this.engine.audio.mixJSON() : undefined,
      variables: this.engine.variables ? this.engine.variables.toJSON() : {},
      ui: this.engine.ui ? normalizeUI(this.engine.ui) : undefined, // title screen, HUD styles
      environment: this.engine.environment ? this.engine.environment.toJSON() : undefined,
      prefabs: this.engine.prefabs?.names().length ? this.engine.prefabs.toJSON() : undefined,
      // where the Logic graph's variables, screens… were dragged to (rules keep their own place)
      logic: this.engine.logicLayout && Object.keys(this.engine.logicLayout).length ? { layout: this.engine.logicLayout } : undefined,
      entities,
    };
  }

  _serializeEntity(entity) {
    const o = entity.object3D;
    const parentIdx = entity.parent
      ? this.editor.selectables.findIndex((e) => e === entity.parent)
      : -1;
    const base = {
      name: o.name || '',
      position: v3(o.position),
      rotation: v3(o.rotation),
      scale: size3(o.scale),
      solid: !!entity.solid,
      rigidBody: entity.rigidBody ? {
        type: entity.rigidBody.type,
        mass: round(entity.rigidBody.mass),
        restitution: round(entity.rigidBody.restitution),
        friction: round(entity.rigidBody.friction),
        // without this every trigger silently becomes solid on reload
        isTrigger: !!entity.rigidBody.isTrigger,
        shape: entity.rigidBody.shape && entity.rigidBody.shape !== 'auto' ? entity.rigidBody.shape : undefined,
        // its own pull (a floating ghost, a moon jump) — it used to be lost on save
        gravity: entity.rigidBody.gravity !== DEFAULT_GRAVITY ? round(entity.rigidBody.gravity) : undefined,
        tumbles: entity.rigidBody.tumbles || undefined, // rolls and topples (see physics.js)
        ignores: entity.rigidBody.ignores?.length ? [...entity.rigidBody.ignores] : undefined, // passes through
      } : undefined,
      behavior: entity.behavior || undefined,
      components: this.engine.gameplay?.components.serializeFor(entity),
      rules: this.engine.gameplay?.rules.serializeFor(entity),
      parent: parentIdx,
      prefab: entity.prefab || undefined, // a linked copy: which prefab it follows
      prefabChild: entity.prefabChild || undefined, // part of its parent's prefab (a car's wheel)
      ...saveFields(entity), // its plain settings: groups, held in view, parts' physics… (entity-fields.js)
    };

    // a light probe: its box (the scale) and its strength
    if (isProbe(o)) return { ...base, type: 'probe', intensity: round(o.userData.probe.intensity ?? 1) };

    // lights
    if (o.isLight) {
      const d = {
        ...base,
        type: 'light',
        lightType: lightKind(o),
        color: '#' + o.color.getHexString(),
        intensity: round(o.intensity),
        castShadow: !!o.castShadow,
      };
      if (o.distance !== undefined) d.distance = round(o.distance);
      if (o.angle !== undefined) d.angle = round(o.angle);
      if (o.penumbra !== undefined) d.penumbra = round(o.penumbra);
      if (o.isSpotLight && o.target) d.targetPosition = v3(o.target.position);
      return d;
    }

    // player
    if (entity === this.player) {
      return { ...base, type: 'player', sounds: this._serializeSounds(entity) };
    }

    // coin
    if (entity instanceof Coin) {
      return { ...base, type: 'coin', sounds: this._serializeSounds(entity) };
    }

    // GLB model imported from disk — persisted in the asset store by id
    // a model's clips from other files, and parts cut from its clips (animation.js)
    const clipExtras = {
      animationFiles: o.userData.animationFiles?.map((f) => ({ ...f })),
      clipCuts: o.userData.clipCuts?.map((c) => ({ ...c })),
    };
    // the surfaces edited here, part by part (the file has the rest)
    const surfaces = modelMaterialRecord(o);
    // made from settings (terrain, a building): the settings; its parts are made again on load
    const gen = generatorOf(o);
    if (gen) return { ...base, type: 'generated', generator: gen.type, params: { ...gen.params }, sounds: this._serializeSounds(entity) };
    const assetId = o.userData.assetId;
    if (assetId) {
      return { ...base, type: 'model', assetId, sounds: this._serializeSounds(entity), ...surfaces, ...clipExtras };
    }

    // GLB model from a real URL (e.g. a file shipped with the project)
    const assetUrl = o.userData.assetUrl;
    if (assetUrl && !assetUrl.startsWith('blob:')) {
      return { ...base, type: 'model', assetUrl, sounds: this._serializeSounds(entity), ...surfaces, ...clipExtras };
    }

    // primitive prop
    const mesh = firstMesh(o);
    const kind = mesh ? primitiveKind(mesh.geometry) : null;
    if (mesh && kind) {
      const d = { ...base, type: 'primitive', primitive: kind, sounds: this._serializeSounds(entity) };
      const m = mesh.material;
      // every texture slot, placement setting and library link (materials.js)
      if (m && m.isMeshStandardMaterial) d.material = materialSpec(m);
      return d;
    }

    // unknown (e.g. a blob-loaded GLB) — can't be reconstructed; skip with a note
    console.warn('[Tiny3] scene save: skipping un-serializable object', o.name || o.type);
    return null;
  }

  /** `saved` is the entity behind each saved record. */
  _serializePlayer(saved) {
    const p = this.player;
    const targetIdx = p.target ? saved.indexOf(p.target) : -1;
    return { target: targetIdx }; // index into entities[], -1 = the hidden default player
  }

  _serializeSounds(entity) {
    const recs = this.engine.sounds.filter((s) => s.entity === entity);
    if (!recs.length) return undefined;
    return recs.map((r) => ({
      name: r.name,
      // id in the asset store — without this the clip cannot be restored at all
      assetId: r.assetId || undefined,
      // a sound-maker sound is just its settings; it is re-made on load
      synth: r.synth ? { ...r.synth } : undefined,
      type: r.type,
      bus: r.bus || undefined,
      volume: round(r.volume ?? 1),
      loop: !!r.loop,
      autoplay: !!r.autoplay,
      overlap: r.overlap === undefined ? undefined : !!r.overlap,
      pitchVary: r.pitchVary ? round(r.pitchVary) : undefined,
      refDistance: round(r.refDistance ?? 5),
      trigger: r.trigger || undefined,
    }));
  }

  // ---------- deserialize ----------

  async deserialize(data) {
    if (!data || data.version !== 1) {
      throw new Error('Unsupported scene file (missing or wrong version).');
    }

    // wipe current editable scene (preserve the editor grid)
    this.editor.select(null);
    // stop + drop all sounds before destroying objects so nodes detach cleanly
    this.engine.stopAllSounds();
    if (this.engine.audio) {
      this.engine.audio.clear();
      this.engine.audio.setMix({ ...MIX_DEFAULTS, ...(data.audio || {}) });
    } else {
      this.engine.sounds = [];
    }
    this.engine.gameplay?.clear();
    this.engine.materialLibrary?.clear(); // rebuilt from the entities' own descriptions
    // scenes from before controls existed kept a fixed key map on the player
    this.engine.gameplay?.controls.load(
      Array.isArray(data.controls) ? data.controls : controlsFromLegacy(data.player)
    );
    this.engine.variables?.load(data.variables || {});
    this.engine.prefabs?.load(data.prefabs || {});
    this.engine.logicLayout = data.logic?.layout && typeof data.logic.layout === 'object' ? { ...data.logic.layout } : {};
    this._generation = (this._generation || 0) + 1; // a model still loading from before is dropped
    if (this.engine.ui) this.engine.ui = normalizeUI(data.ui);
    // scenes saved before environments existed get daylight, like a new scene
    this.engine.environment?.load(data.environment);
    for (const entity of [...this.editor.selectables]) {
      if (typeof entity.destroy === 'function') entity.destroy(this.engine);
      else this.engine.remove(entity);
      this.editor.unregister(entity);
    }
    // every model's animation goes with it (they used to keep playing, unseen)
    for (const m of this.engine.mixers || []) m.mixer?.stopAllAction();
    if (this.engine.mixers) this.engine.mixers.length = 0;
    // the hidden stand-in player is in no save: it starts again where it starts
    // (a scene that stores it puts it where it was, below)
    this.player?.reset?.();
    // ensure the editor grid stays in the scene
    if (this.engine.grid && !this.engine.scene.children.includes(this.engine.grid)) {
      this.engine.scene.add(this.engine.grid);
    }

    // Every model file read at once first — one after another, a level of
    // models over the network (a game on a website) took the sum of them all.
    // `onProgress(done, total)` fills a loading screen as they arrive.
    const list = data.entities || [];
    const models = list.filter((d) => d?.type === 'model');
    const total = models.length + list.length;
    let done = 0;
    const tick = () => this.onProgress?.(++done, total);
    await Promise.all(models.map((d) => Promise.resolve(this.assets?.preload?.(d)).catch(() => {}).then(tick)));

    // rebuild entities (models load async; everything else is instant).
    // Failed entities are kept as holes: `parent` and `camera.target` are stored
    // as indices into this array, so compacting it would silently re-point them.
    const made = [];
    for (const d of list) {
      const entity = await this._buildEntity(d);
      made.push(entity || null);
      if (entity) {
        entity.levelKey = made.length - 1; // its place in the level (see serialize)
        this.engine.add(entity);
        this.editor.register(entity);
      }
      tick();
    }

    // restore parenting after all entities exist
    for (let i = 0; i < (data.entities || []).length; i++) {
      const d = data.entities[i];
      const child = made[i];
      if (!child || !Number.isInteger(d.parent) || d.parent < 0) continue;
      const parent = made[d.parent];
      if (parent && parent !== child) {
        child.setParent(parent, this.engine);
        // A child is saved where it stands relative to its parent, but it was
        // built as if that were a place in the world, and setParent keeps the
        // world place. Put the saved one back. (Every save, Play -> Stop and
        // level switch used to shift children by their parent's offset.)
        this._applyTransform(child.object3D, { ...d, name: child.object3D.name });
      }
    }

    // the scene's own music and ambience
    await this._attachSounds(null, data.sceneSounds);

    // camera
    if (data.camera) {
      const c = data.camera;
      const rig = this.rig;
      // older files kept a few settings loose, and one field of view for every camera
      const legacy = {};
      for (const k of ['followOffset', 'followHeight', 'followLerp', 'followLookUp', 'rotateWithTarget',
        'panSpeed', 'orbitLockTarget', 'distance']) {
        if (c[k] !== undefined) legacy[k] = c[k];
      }
      if (c.fov) for (const k of ['fovOrbit', 'fovFollow', 'fovFps', 'fovFly']) legacy[k] = c.fov;
      // what a file leaves out starts from the default, not from the last game opened
      applyCameraSettings(rig, { ...CAMERA_DEFAULTS, ...legacy, ...(c.settings || {}) });
      rig.playMode = c.playMode || null;
      rig.theta = c.theta ?? rig.theta;
      rig.phi = c.phi ?? rig.phi;
      if (c.lookAt) rig.lookAt.set(c.lookAt[0], c.lookAt[1], c.lookAt[2]);
      if (c.fov && !rig.fovFor) rig.setFov(c.fov);
      if (c.position) this.engine.camera.position.set(c.position[0], c.position[1], c.position[2]);
      const target = c.target >= 0 && made[c.target] ? made[c.target].object3D : null;
      rig.setMode(c.mode || 'orbit', { target });
    }

    // which object is the player, now that entities exist
    this.editor._renderHierarchy();
    const targetIdx = data.player?.target;
    this.player.target = Number.isInteger(targetIdx) && targetIdx >= 0 && made[targetIdx]
      ? made[targetIdx]
      : null;
    this.engine.probes?.invalidate(); // the level's probes captured afresh
    window.dispatchEvent(new CustomEvent('tiny3:player-loaded')); // the panels re-read it all

    return made.filter(Boolean);
  }

  /** Name, position, turn and size from a saved entity. */
  _applyTransform(o, d) {
    o.name = d.name || o.name;
    if (d.position) o.position.set(...d.position);
    if (d.rotation) o.rotation.set(...d.rotation);
    if (d.scale) o.scale.set(...d.scale);
  }

  /** Solid flag, body, script, components, rules and prefab link from a saved entity. */
  _applyBehaviour(entity, d) {
    // what blocks is its body; a Solid tick from before that meant a body gets one now
    const body = d.rigidBody ?? legacySolidBody(d);
    entity.solid = false;
    // its plain settings (entity-fields.js) — its parts' own physics among them, before its body is registered
    loadFields(entity, d);
    if (body) {
      entity.rigidBody = new RigidBody(body);
      this.engine.physics.register(entity);
    }
    if (d.behavior) {
      entity.behavior = d.behavior;
      this.engine.addBehavior(entity, d.behavior);
    }
    const gameplay = this.engine.gameplay;
    if (gameplay) {
      for (const c of d.components || []) gameplay.components.add(entity, c.type, c.props);
      if (d.rules?.length) gameplay.rules.setFor(entity, JSON.parse(JSON.stringify(d.rules)));
    }
    if (typeof d.prefab === 'string' && d.prefab) entity.prefab = d.prefab;
    if (d.prefabChild) entity.prefabChild = true;
  }

  /**
   * Build a light, coin, primitive or already-read model straight away —
   * spawning during play has no frame to wait in. Images, sounds and a model's
   * extra clips arrive a moment later. Returns undefined for what needs loading
   * first (a model whose file hasn't been read) or isn't built here (the player).
   */
  _buildSync(d) {
    let entity;
    switch (d.type) {
      case 'model': {
        const obj = d.assetId
          ? this.assets?.loadFromStoreSync?.(d.assetId, { name: d.name })
          : this.assets?.loadSync?.(d.assetUrl, { name: d.name });
        if (!obj) return undefined;
        this._setUpModel(obj, d);
        this._finishModel(obj, d).catch((err) => console.warn('[Tiny3] model clips or surface:', d.name, err));
        entity = new Entity(obj);
        break;
      }
      case 'light': {
        const light = LIGHT_TYPES[d.lightType](d);
        light.castShadow = !!d.castShadow;
        this._applyTransform(light, d);
        if (d.lightType === 'spot' && d.targetPosition) {
          light.target.position.set(...d.targetPosition);
          this.engine.scene.add(light.target);
        }
        entity = new LightEntity(light, d.name || 'Light');
        break;
      }
      case 'coin': {
        entity = new Coin(d.position?.[0] ?? 0, d.position?.[2] ?? 0);
        this._applyTransform(entity.object3D, d);
        entity.object3D.userData.kind = 'Coin';
        break;
      }
      case 'probe': {
        entity = makeProbe({ name: d.name || 'Light probe', intensity: Number(d.intensity) || 1 });
        this._applyTransform(entity.object3D, d);
        break;
      }
      case 'generated': {
        if (!GENERATORS[d.generator]) return undefined;
        const root = makeGenerated(d.generator, d.params || {});
        this._applyTransform(root, d);
        entity = new Entity(root);
        break;
      }
      case 'primitive': {
        const geo = (PRIMITIVE_GEOS[d.primitive] || PRIMITIVE_GEOS.box)();
        // Every entity carries its full description; the first one naming a
        // library material creates it, the rest share it. A missing image only
        // warns — it must not take the rest of the scene with it.
        const mat = createMaterial({ color: '#539bf5', ...(d.material || {}) },
          { library: this.engine.materialLibrary });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = mesh.receiveShadow = true;
        this._applyTransform(mesh, d);
        mesh.userData.kind = 'Prop';
        entity = new Entity(mesh);
        break;
      }
      default:
        return undefined;
    }
    this._applyBehaviour(entity, d);
    return entity;
  }

  async _buildEntity(d) {
    switch (d.type) {
      case 'player': {
        this._applyTransform(this.player.object3D, d);
        this._applyBehaviour(this.player, d);
        await this._attachSounds(this.player, d.sounds);
        // re-add the player to the engine because the wipe loop removed it
        if (!this.engine.entities.includes(this.player)) {
          this.engine.add(this.player);
        }
        return this.player;
      }
      case 'model': {
        let obj;
        try {
          obj = d.assetId
            ? await this.assets.loadFromStore(d.assetId, { name: d.name })
            : await this.assets.load(d.assetUrl, { name: d.name });
        } catch (err) {
          // a missing asset must not take the whole scene down with it
          console.warn('[Tiny3] could not load model, skipping:', d.name, err);
          return null;
        }
        this._setUpModel(obj, d);
        await this._finishModel(obj, d);
        const entity = new Entity(obj);
        this._applyBehaviour(entity, d);
        await this._attachSounds(entity, d.sounds);
        return entity;
      }
      default: {
        const entity = this._buildSync(d);
        if (!entity) {
          console.warn('[Tiny3] scene load: unknown entity type', d.type);
          return null;
        }
        const mat = d.type === 'primitive' ? entity.object3D.material : null;
        if (mat) await materialReady(mat);
        await this._attachSounds(entity, d.sounds);
        return entity;
      }
    }
  }

  /** A new copy of a model: where it stands and which file it came from. */
  _setUpModel(obj, d) {
    this._applyTransform(obj, d);
    if (d.assetId) obj.userData.assetId = d.assetId;
    else obj.userData.assetUrl = d.assetUrl;
    obj.userData.kind = 'Prop';
  }

  /** A model's clips from other files, the parts cut from its clips, and the surfaces edited here. */
  async _finishModel(obj, d) {
    if (d.animationFiles?.length || d.clipCuts?.length) await this.assets.applyAnimationExtras(obj, d);
    if (d.material || d.partMaterials) await adoptModelMaterials(obj, d, this.engine.materialLibrary);
  }

  // ---------- prefabs ----------

  /**
   * Read the file of every model prefab now, so a copy spawned during play (a
   * shot, a spawner's enemy, an impact) is built inside the frame like any
   * other prefab. It used to arrive a moment later — too late to be launched,
   * timed out or counted, so model shots never flew and spawners never stopped.
   */
  async preloadPrefabs() {
    const lib = this.engine.prefabs;
    if (!lib || !this.assets?.preload) return;
    // every model in every prefab — its child objects' too
    const models = [];
    const collect = (name, rec) => {
      if (rec?.type === 'model') models.push([name, rec]);
      for (const child of rec?.children || []) collect(name, child);
    };
    for (const name of lib.names()) collect(name, lib.get(name));
    await Promise.all(models.map(async ([name, rec]) => {
      try {
        await this.assets.preload(rec);
      } catch (err) {
        console.warn(`[Tiny3] prefab "${name}": could not read its model`, err);
      }
    }));
  }

  /**
   * A prefab record of an entity as it is now — with its child objects (a car
   * with its wheels) — or null for what can't be one (the player).
   */
  prefabRecord(entity) {
    const d = this._serializeEntity(entity);
    if (!d || d.type === 'player') return null;
    const rec = prefabFromEntity(d);
    const children = this.childRecords(entity, { all: true });
    if (children) rec.children = children;
    return rec;
  }

  /**
   * An entity as saved right now, for comparing a copy with its prefab: with
   * the child objects that came from its prefab (not ones added to this copy).
   */
  entityRecord(entity) {
    const d = this._serializeEntity(entity);
    if (!d) return d;
    const children = this.childRecords(entity, { all: false });
    if (children) d.children = children;
    return d;
  }

  /**
   * The records of an entity's child objects — each where it stands on its
   * parent, with its own children — for a prefab (`all`: every child) or for
   * comparing a copy (only the prefab's own children). Undefined if none.
   */
  childRecords(entity, { all = true, keepFlags = false } = {}) {
    const out = [];
    for (const child of entity.children || []) {
      if (!all && !child.prefabChild) continue;
      const d = this._serializeEntity(child);
      if (!d || d.type === 'player') continue;
      delete d.parent;
      delete d.prefab;
      if (!keepFlags) delete d.prefabChild;
      const grand = this.childRecords(child, { all, keepFlags });
      if (grand) d.children = grand;
      out.push(d);
    }
    return out.length ? out : undefined;
  }

  /**
   * Build child objects under `root` from their records, each where it stands
   * on its parent. What can be built at once is (spawning, inside a frame); a
   * model not read yet arrives a moment later. `prefabChild` marks them part of
   * root's prefab, so updating the prefab updates them.
   */
  addChildren(root, records, { prefabChild = true } = {}) {
    const generation = this._generation;
    for (const c of records || []) {
      const adopt = (child) => {
        if (!child || generation !== this._generation || root.alive === false) return;
        this.engine.add(child);
        this.editor.register(child);
        if (prefabChild) child.prefabChild = true;
        child.setParent(root, this.engine);
        this._applyTransform(child.object3D, c); // its place on the parent, not in the world
        this.addChildren(child, c.children, { prefabChild });
      };
      const d = { ...c, parent: -1, children: undefined };
      const child = this._buildSync(d);
      if (child) {
        this._attachSounds(child, d.sounds).catch((err) => console.warn('[Tiny3] child sounds:', err));
        adopt(child);
      } else {
        this._buildEntity(d).then(adopt, (err) => console.warn('[Tiny3] could not build a child object:', c.name, err));
      }
    }
  }

  /** The same, awaited: resolves once every child (and theirs) is in place. */
  async addChildrenAsync(root, records, { prefabChild = true } = {}) {
    for (const c of records || []) {
      const child = await this._buildEntity({ ...c, parent: -1, children: undefined });
      if (!child) continue;
      this.engine.add(child);
      this.editor.register(child);
      if (prefabChild) child.prefabChild = true;
      child.setParent(root, this.engine);
      this._applyTransform(child.object3D, c);
      await this.addChildrenAsync(child, c.children, { prefabChild });
    }
  }

  /**
   * Put a copy of a prefab in the scene. Lights, coins and primitives are built
   * and returned at once; a model loads first, arrives at `position` a moment
   * later, and this returns null. Without a position it stands where the prefab
   * was saved (centred, at its height).
   */
  spawnPrefab(name, position = null) {
    const rec = this.engine.prefabs?.get(name);
    if (!rec) return null;
    const d = instanceRecord(rec, name, position);
    const entity = this._buildSync(d);
    if (entity) {
      this._attachSounds(entity, d.sounds).catch((err) => console.warn('[Tiny3] prefab sounds:', err));
      this.engine.add(entity);
      this.editor.register(entity);
      this.addChildren(entity, d.children); // its wheels, its gun…
      return entity;
    }
    const generation = this._generation;
    this._buildEntity(d).then((made) => {
      // the level changed (or play stopped) while it loaded: it no longer belongs
      if (!made || generation !== this._generation) return;
      this.engine.add(made);
      this.editor.register(made);
      this.addChildren(made, d.children);
    });
    return null;
  }

  /** The same, awaited: resolves to the copy — its child objects too — once it is in the scene. */
  async placePrefab(name, position = null) {
    const rec = this.engine.prefabs?.get(name);
    if (!rec) return null;
    const d = instanceRecord(rec, name, position);
    const entity = await this._buildEntity(d);
    if (!entity) return null;
    this.engine.add(entity);
    this.editor.register(entity);
    await this.addChildrenAsync(entity, d.children);
    return entity;
  }

  // ---------- file helpers ----------

  /** Download the current scene as a .json file. */
  saveToFile(filename = 'scene.json') {
    const json = JSON.stringify(this.serialize(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async _attachSounds(entity, sounds) {
    if (!sounds || !sounds.length) return;
    for (const s of sounds) {
      try {
        let buffer;
        if (s.synth) {
          // made in the sound maker: no file, just re-make it from its settings
          buffer = sfxBuffer(this.engine.listener?.context, s.synth);
        } else {
          // prefer the asset store; fall back to a URL for project-shipped audio.
          // (This used to fetch `s.name` as if it were a path, so no sound ever
          // came back — every save/load and every Play->Stop silently lost audio.)
          const url = s.assetId ? await assetStore.objectURL(s.assetId) : (s.url || null);
          if (!url) {
            console.warn('[Tiny3] sound has no stored asset, skipping:', s.name);
            continue;
          }
          buffer = await this._audioLoader.loadAsync(url);
        }
        this.engine.addSound(entity, buffer, {
          name: s.name,
          assetId: s.assetId || null,
          synth: s.synth || null,
          type: s.type || (entity ? 'positional' : 'global'),
          bus: s.bus,
          volume: s.volume ?? 1,
          loop: !!s.loop,
          autoplay: !!s.autoplay,
          overlap: s.overlap,
          pitchVary: s.pitchVary ?? 0,
          refDistance: s.refDistance ?? 5,
          trigger: s.trigger || null,
        });
      } catch (err) {
        console.warn('[Tiny3] could not restore sound:', s.name, err);
      }
    }
  }

  /** Open a file picker and load a .json scene. Resolves to the rebuilt entities. */
  loadFromFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) { resolve(null); return; }
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          resolve(await this.deserialize(data));
        } catch (err) {
          console.error('[Tiny3] scene load failed:', err);
          reject(err);
        }
      };
      input.click();
    });
  }
}
