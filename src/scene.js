import * as THREE from 'three';
import { AudioLoader } from 'three';
import { Entity } from './entity.js';
import { Player } from './player.js';
import { Coin } from './enemy.js';
import { LightEntity } from './editor.js';

/**
 * SceneSerializer — save/load the whole editor scene as JSON.
 *
 * Covers everything the editor itself can create:
 *   - primitive props (box/sphere/cone/cylinder/torus) + their materials
 *   - loaded GLB models (by asset URL)
 *   - lights (directional/point/spot/ambient) + color/intensity/shadow
 *   - the player (transform + control bindings + tuning)
 *   - coins
 *   - camera rig settings (mode, target, FOV, follow offset/height/smooth)
 *
 *   const ser = new SceneSerializer(engine, editor, rig, player, assets);
 *   const json = ser.serialize();          // -> plain object (JSON-safe)
 *   await ser.deserialize(json);           // rebuilds the scene
 *   ser.saveToFile();                      // downloads scene.json
 *   await ser.loadFromFile();              // opens a file picker
 */

const PRIMITIVE_GEOS = {
  box: () => new THREE.BoxGeometry(1.5, 1.5, 1.5),
  sphere: () => new THREE.SphereGeometry(0.9, 32, 16),
  cone: () => new THREE.ConeGeometry(0.9, 2, 24),
  cylinder: () => new THREE.CylinderGeometry(0.7, 0.7, 1.8, 24),
  torus: () => new THREE.TorusGeometry(0.9, 0.35, 16, 40),
};

const LIGHT_TYPES = {
  directional: (d) => new THREE.DirectionalLight(d.color, d.intensity),
  point: (d) => new THREE.PointLight(d.color, d.intensity, d.distance ?? 0, d.decay ?? 2),
  spot: (d) => new THREE.SpotLight(d.color, d.intensity, d.distance ?? 0, d.angle ?? Math.PI / 6, d.penumbra ?? 0, d.decay ?? 2),
  ambient: (d) => new THREE.AmbientLight(d.color, d.intensity),
};

function v3(v) { return [round(v.x), round(v.y), round(v.z)]; }
function round(n) { return Math.round(n * 1000) / 1000; }

/** Detect which primitive geometry a mesh uses (by constructor), if any. */
function primitiveKind(geo) {
  if (!geo) return null;
  if (geo.type === 'BoxGeometry') return 'box';
  if (geo.type === 'SphereGeometry') return 'sphere';
  if (geo.type === 'ConeGeometry') return 'cone';
  if (geo.type === 'CylinderGeometry') return 'cylinder';
  if (geo.type === 'TorusGeometry') return 'torus';
  return null;
}

function firstMesh(root) {
  if (root.isMesh) return root;
  let found = null;
  root.traverse?.((n) => { if (!found && n.isMesh) found = n; });
  return found;
}

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
    const entities = [];
    for (const entity of this.editor.selectables) {
      const data = this._serializeEntity(entity);
      if (data) entities.push(data);
    }

    const rig = this.rig;
    const targetIdx = rig.target
      ? this.editor.selectables.findIndex((e) => e.object3D === rig.target)
      : -1;

    return {
      version: 1,
      meta: { app: 'Tiny3', savedAt: new Date().toISOString() },
      camera: {
        mode: rig.mode,
        target: targetIdx, // index into entities[], -1 = none
        fov: round(this.engine.camera.fov),
        followOffset: round(rig.followOffset),
        followHeight: round(rig.followHeight),
        followLerp: round(rig.followLerp),
        followLookUp: round(rig.followLookUp),
        rotateWithTarget: rig.rotateWithTarget,
        // free/orbit viewpoint so a reload restores roughly where you were
        position: v3(this.engine.camera.position),
        theta: round(rig.theta),
        phi: round(rig.phi),
        distance: round(rig.distance),
        lookAt: v3(rig.lookAt),
      },
      player: this._serializePlayer(),
      entities,
    };
  }

  _serializeEntity(entity) {
    const o = entity.object3D;
    const base = {
      name: o.name || '',
      position: v3(o.position),
      rotation: v3(o.rotation),
      scale: v3(o.scale),
      solid: !!entity.solid,
    };

    // lights
    if (o.isLight) {
      const type = o.isDirectionalLight ? 'directional'
        : o.isPointLight ? 'point'
        : o.isSpotLight ? 'spot'
        : 'ambient';
      const d = {
        ...base,
        type: 'light',
        lightType: type,
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

    // GLB model (loaded from a real URL, not a blob — blobs can't persist)
    const assetUrl = o.userData.assetUrl;
    if (assetUrl && !assetUrl.startsWith('blob:')) {
      return { ...base, type: 'model', assetUrl, sounds: this._serializeSounds(entity) };
    }

    // primitive prop
    const mesh = firstMesh(o);
    const kind = mesh ? primitiveKind(mesh.geometry) : null;
    if (mesh && kind) {
      const d = { ...base, type: 'primitive', primitive: kind, sounds: this._serializeSounds(entity) };
      const m = mesh.material;
      if (m && m.isMeshStandardMaterial) {
        d.material = {
          color: '#' + m.color.getHexString(),
          metalness: round(m.metalness),
          roughness: round(m.roughness),
          opacity: round(m.opacity),
          wireframe: !!m.wireframe,
        };
      }
      return d;
    }

    // unknown (e.g. a blob-loaded GLB) — can't be reconstructed; skip with a note
    console.warn('[Tiny3] scene save: skipping un-serializable object', o.name || o.type);
    return null;
  }

  _serializePlayer() {
    const p = this.player;
    return {
      enabled: p.enabled,
      speed: round(p.speed),
      jumpVelocity: round(p.jumpVelocity),
      rotateToMovement: p.rotateToMovement,
      controls: JSON.parse(JSON.stringify(p.controls)),
    };
  }

  _serializeSounds(entity) {
    const recs = this.engine.sounds.filter((s) => s.entity === entity);
    if (!recs.length) return undefined;
    return recs.map((r) => ({
      name: r.name,
      type: r.type,
      volume: round(r.volume),
      loop: !!r.loop,
      autoplay: !!r.autoplay,
      refDistance: round(r.refDistance),
      trigger: r.trigger || undefined,
    }));
  }

  // ---------- deserialize ----------

  async deserialize(data) {
    if (!data || data.version !== 1) {
      throw new Error('Unsupported scene file (missing or wrong version).');
    }

    // wipe current editable scene
    this.editor.select(null);
    // stop + drop all sounds before destroying objects so nodes detach cleanly
    this.engine.stopAllSounds();
    this.engine.sounds = [];
    for (const entity of [...this.editor.selectables]) {
      if (typeof entity.destroy === 'function') entity.destroy(this.engine);
      else this.engine.remove(entity);
      this.editor.unregister(entity);
    }

    // rebuild entities (models load async; everything else is instant)
    const made = [];
    for (const d of data.entities || []) {
      const entity = await this._buildEntity(d);
      if (entity) {
        this.engine.add(entity);
        this.editor.register(entity);
        made.push(entity);
      }
    }

    // camera
    if (data.camera) {
      const c = data.camera;
      const rig = this.rig;
      rig.followOffset = c.followOffset ?? rig.followOffset;
      rig.followHeight = c.followHeight ?? rig.followHeight;
      rig.followLerp = c.followLerp ?? rig.followLerp;
      rig.followLookUp = c.followLookUp ?? rig.followLookUp;
      rig.rotateWithTarget = c.rotateWithTarget ?? rig.rotateWithTarget;
      rig.theta = c.theta ?? rig.theta;
      rig.phi = c.phi ?? rig.phi;
      rig.distance = c.distance ?? rig.distance;
      if (c.lookAt) rig.lookAt.set(c.lookAt[0], c.lookAt[1], c.lookAt[2]);
      if (c.fov) rig.setFov(c.fov);
      if (c.position) this.engine.camera.position.set(c.position[0], c.position[1], c.position[2]);
      const target = c.target >= 0 && made[c.target] ? made[c.target].object3D : null;
      rig.setMode(c.mode || 'orbit', { target });
    }

    // player settings
    if (data.player) {
      const p = this.player;
      const d = data.player;
      p.enabled = d.enabled ?? p.enabled;
      p.speed = d.speed ?? p.speed;
      p.jumpVelocity = d.jumpVelocity ?? p.jumpVelocity;
      p.rotateToMovement = d.rotateToMovement ?? p.rotateToMovement;
      if (d.controls) p.controls = d.controls;
      // reflect in the controls panel UI if present
      document.getElementById('ctl-enabled')?.dispatchEvent(new Event('sync'));
      window.dispatchEvent(new CustomEvent('tiny3:player-loaded'));
    }

    return made;
  }

  async _buildEntity(d) {
    const apply = (o) => {
      o.name = d.name || o.name;
      if (d.position) o.position.set(...d.position);
      if (d.rotation) o.rotation.set(...d.rotation);
      if (d.scale) o.scale.set(...d.scale);
    };
    const applySolid = (entity) => {
      if (d.solid !== undefined) entity.solid = !!d.solid;
    };

    switch (d.type) {
      case 'light': {
        const light = LIGHT_TYPES[d.lightType](d);
        light.castShadow = !!d.castShadow;
        apply(light);
        if (d.lightType === 'spot' && d.targetPosition) {
          light.target.position.set(...d.targetPosition);
          this.engine.scene.add(light.target);
        }
        const entity = new LightEntity(light, d.name || 'Light');
        applySolid(entity);
        await this._attachSounds(entity, d.sounds);
        return entity;
      }
      case 'player': {
        apply(this.player.object3D);
        applySolid(this.player);
        await this._attachSounds(this.player, d.sounds);
        return this.player;
      }
      case 'coin': {
        const coin = new Coin(d.position?.[0] ?? 0, d.position?.[2] ?? 0);
        apply(coin.object3D);
        coin.object3D.userData.kind = 'Coin';
        applySolid(coin);
        await this._attachSounds(coin, d.sounds);
        return coin;
      }
      case 'model': {
        const obj = await this.assets.load(d.assetUrl, { name: d.name });
        apply(obj);
        obj.userData.assetUrl = d.assetUrl;
        obj.userData.kind = 'Prop';
        const entity = new Entity(obj);
        applySolid(entity);
        await this._attachSounds(entity, d.sounds);
        return entity;
      }
      case 'primitive': {
        const geo = (PRIMITIVE_GEOS[d.primitive] || PRIMITIVE_GEOS.box)();
        const m = d.material || {};
        const mat = new THREE.MeshStandardMaterial({
          color: m.color || 0x539bf5,
          metalness: m.metalness ?? 0,
          roughness: m.roughness ?? 1,
          opacity: m.opacity ?? 1,
          wireframe: !!m.wireframe,
          transparent: (m.opacity ?? 1) < 1,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = mesh.receiveShadow = true;
        apply(mesh);
        mesh.userData.kind = 'Prop';
        const entity = new Entity(mesh);
        applySolid(entity);
        await this._attachSounds(entity, d.sounds);
        return entity;
      }
      default:
        console.warn('[Tiny3] scene load: unknown entity type', d.type);
        return null;
    }
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
        const buffer = await this._audioLoader.loadAsync(s.url || s.name);
        this.engine.addSound(entity, buffer, {
          name: s.name,
          type: s.type || 'positional',
          volume: s.volume ?? 1,
          loop: !!s.loop,
          autoplay: !!s.autoplay,
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
