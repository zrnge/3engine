import * as THREE from 'three';
import { saveFields, loadFields } from '../entity-fields.js';
import { GENERATORS, makeGenerated, generatorOf } from '../generators/generated.js';
import { materialSpec, applyMaterialSpec, createMaterial } from '../materials.js';
import { soundSettings } from '../sound.js';
import { Entity } from '../entity.js';
import { RigidBody } from '../physics.js';
import { PRIMITIVE_GEOS, LIGHT_TYPES, primitiveKind, lightKind } from '../factories.js';
import { modelMaterialRecord, adoptModelMaterials } from '../model-parts.js';

/**
 * Copy, paste, duplicate and copy/paste properties. A copy is rebuilt from a
 * full record — its own material, body, script, components, rules and sounds.
 *
 * Mixed into ObjectEditor.prototype (see ../editor.js), so `this` is the editor.
 */
export const clipboardMethods = {
  /**
   * The selection without anything whose parent (or grandparent…) is selected
   * too: that one comes along with it, as one of its children.
   */
  _selectionRoots() {
    const targets = this.selectedSet.size > 0 ? [...this.selectedSet] : (this.selected ? [this.selected] : []);
    const picked = new Set(targets);
    return targets.filter((e) => { for (let p = e.parent; p; p = p.parent) if (picked.has(p)) return false; return true; });
  },

  /** Its child objects, built under a pasted or duplicated copy (a car's wheels come with it). */
  async _copyChildren(entity, rec) {
    if (rec.children?.length) await this.serializer?.addChildrenAsync(entity, rec.children, { prefabChild: false });
  },

  /** Copy the current selection to a JSON clipboard. */
  copySelection() {
    const targets = this._selectionRoots();
    if (!targets.length) return false;
    const records = targets.map((e) => this._serializeForClipboard(e));
    this._clipboard = JSON.stringify(records);
    return true;
  },

  /** Paste the clipboard, creating new entities offset slightly from the originals. */
  async pasteSelection() {
    if (!this._clipboard) return null;
    const records = JSON.parse(this._clipboard);
    const created = [];
    for (const rec of records) {
      const entity = await this._deserializeFromClipboard(rec);
      if (entity) {
        this._applyExtras(entity, rec); // body, script, components, rules, sounds
        this.engine.add(entity);
        this.register(entity);
        await this._copyChildren(entity, rec);
        this._recordAddRemove(entity, true);
        created.push(entity);
      }
    }
    if (created.length) {
      this.select(null);
      for (const e of created) this.selectedSet.add(e);
      this.selected = created[0];
      this._renderHierarchy();
      this._renderInspector();
    }
    return created;
  },

  /**
   * Duplicate the current selection (supports multi-select). Each copy is
   * rebuilt from a full record — its own material, sounds, body, script,
   * components and rules. (It used to clone the Three.js object, which shared
   * the material — recolouring the copy recoloured the original — dropped
   * everything else, and threw on any object with a 3D sound.)
   */
  async duplicateSelection() {
    const targets = this._selectionRoots();
    const created = [];
    for (const sel of targets) {
      const rec = this._serializeForClipboard(sel);
      rec.name = `${rec.name || 'Object'} copy`;
      const entity = await this._deserializeFromClipboard(rec);
      if (!entity) continue;
      this._applyExtras(entity, rec);
      this.engine.add(entity);
      // a duplicated wheel stays on the car (it is built where the original
      // stands in the world, and joining the parent keeps that place)
      this.register(entity, sel.parent);
      await this._copyChildren(entity, rec);
      this._recordAddRemove(entity, true);
      created.push(entity);
    }
    if (created.length) {
      this.select(null);
      for (const e of created) this.selectedSet.add(e);
      this.selected = created[0];
      this._renderHierarchy();
      this._renderInspector();
    }
    return created;
  },

  /**
   * Everything about an object, where it stands — what copy, paste and
   * duplicate carry. Its place is its place in the world: a child's own
   * numbers are relative to its parent, and the copy is built at the top of
   * the scene. (A copied wheel used to land wherever its offset from the car
   * happened to point in the world.)
   */
  _serializeForClipboard(entity) {
    const o = entity.object3D;
    o.updateWorldMatrix(true, false);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    o.matrixWorld.decompose(p, q, s);
    const r = new THREE.Euler().setFromQuaternion(q, o.rotation.order);
    return {
      ...this._serializeForPrefab(entity),
      position: { x: p.x, y: p.y, z: p.z },
      rotation: { x: r.x, y: r.y, z: r.z },
      scale: { x: s.x, y: s.y, z: s.z },
      prefab: entity.prefab, // a copy of a linked copy stays linked
      // its child objects, each where it stands on it (and whether its prefab brought it)
      children: this.serializer?.childRecords(entity, { all: true, keepFlags: true }),
    };
  },

  /** True when a record needs an async asset load to rebuild. */
  _needsAsset(rec) { return !!(rec.assetId || rec.assetUrl); },

  /**
   * Rebuild a light or primitive record. Synchronous, so runtime spawning can
   * use it inside a frame; returns null for anything asset-backed.
   */
  _buildSimpleEntity(rec) {
    let object3D;
    if (rec.light) {
      const light = LIGHT_TYPES[rec.light.type](rec.light);
      light.castShadow = !!rec.light.castShadow;
      object3D = light;
    } else if (rec.generator && GENERATORS[rec.generator]) {
      object3D = makeGenerated(rec.generator, rec.params || {}); // a terrain, a building: made again from its settings
    } else if (rec.primitive) {
      const geo = (PRIMITIVE_GEOS[rec.primitive] || PRIMITIVE_GEOS.box)();
      // images arrive a moment later; the object itself exists straight away.
      // A library material comes back as the shared one.
      const mat = createMaterial({ color: '#539bf5', ...(rec.material || {}) },
        { library: this.engine.materialLibrary });
      object3D = new THREE.Mesh(geo, mat);
      object3D.castShadow = object3D.receiveShadow = true;
    } else {
      return null;
    }
    return this._finishEntity(object3D, rec);
  },

  _finishEntity(object3D, rec) {
    object3D.name = rec.name;
    object3D.position.set(rec.position.x + 1.5, rec.position.y, rec.position.z);
    object3D.rotation.set(rec.rotation.x, rec.rotation.y, rec.rotation.z);
    object3D.scale.set(rec.scale.x, rec.scale.y, rec.scale.z);
    object3D.userData.kind = rec.kind || 'Prop';
    const entity = new Entity(object3D);
    entity.solid = !!rec.solid;
    return entity;
  },

  async _deserializeFromClipboard(rec) {
    if (!this._needsAsset(rec)) return this._buildSimpleEntity(rec);

    // imported model — rebuild it from the asset store (this used to just be
    // skipped, so copy/paste and prefabs silently did nothing for GLB models)
    if (!this.assets) {
      console.warn('[Tiny3] no AssetLoader wired into the editor; cannot rebuild a model');
      return null;
    }
    try {
      const object3D = rec.assetId
        ? await this.assets.loadFromStore(rec.assetId, { name: rec.name })
        : await this.assets.load(rec.assetUrl, { name: rec.name });
      if (rec.animationFiles?.length || rec.clipCuts?.length) await this.assets.applyAnimationExtras(object3D, rec);
      // its surfaces as edited here, part by part — a copy owns its materials now,
      // so it no longer gets them by sharing the original's
      await adoptModelMaterials(object3D, rec, this.engine.materialLibrary);
      return this._finishEntity(object3D, rec);
    } catch (err) {
      console.warn('[Tiny3] could not rebuild model:', rec.name, err);
      return null;
    }
  },

  /** Script, body, components, rules and sounds from a record (copy or duplicate). */
  _applyExtras(entity, rec) {
    // a copy of a linked copy is linked too
    if (rec.prefab && this.engine.prefabs.has(rec.prefab)) entity.prefab = rec.prefab;
    // its plain settings, fresh copies (entity-fields.js) — its parts' physics before its body
    loadFields(entity, rec);
    if (rec.behavior) {
      entity.behavior = rec.behavior;
      this.engine.addBehavior(entity, rec.behavior);
    }
    if (rec.rigidBody) {
      entity.rigidBody = new RigidBody(rec.rigidBody);
      this.engine.physics.register(entity);
    }
    const gameplay = this.engine.gameplay;
    if (gameplay) {
      for (const c of rec.components || []) gameplay.components.add(entity, c.type, c.props);
      if (rec.rules?.length) {
        gameplay.rules.setFor(entity, JSON.parse(JSON.stringify(rec.rules)));
      }
    }
    // sounds arrive a moment later (a file has to be decoded); made ones are instant
    for (const s of rec.sounds || []) {
      this.engine.audio?.addFromSettings(entity, s)
        .then(() => { if (this.selected === entity) this._renderAudio(entity); })
        .catch((err) => console.warn('[Tiny3] could not copy sound:', s.name, err));
    }
    return entity;
  },

  _serializeForPrefab(entity) {
    const o = entity.object3D;
    const rec = {
      name: o.name,
      position: { x: 0, y: o.position.y, z: 0 },
      rotation: { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z },
      scale: { x: o.scale.x, y: o.scale.y, z: o.scale.z },
      solid: entity.solid,
      kind: o.userData.kind,
    };
    if (o.isLight) {
      rec.light = {
        type: lightKind(o),
        color: '#' + o.color.getHexString(),
        intensity: o.intensity,
        castShadow: !!o.castShadow,
      };
      if (o.distance !== undefined) rec.light.distance = o.distance;
      if (o.angle !== undefined) rec.light.angle = o.angle;
      if (o.penumbra !== undefined) rec.light.penumbra = o.penumbra;
    }
    const gen = generatorOf(o);
    if (gen) {
      // made from settings (a terrain, a building): its settings make it again
      rec.generator = gen.type;
      rec.params = JSON.parse(JSON.stringify(gen.params));
    } else if (o.userData.assetId || o.userData.assetUrl) {
      Object.assign(rec, modelMaterialRecord(o)); // a model: each part edited here
    } else {
      const mesh = this._firstMesh(o);
      if (mesh && mesh.material && mesh.material.isMeshStandardMaterial) {
        rec.material = materialSpec(mesh.material); // every texture slot and setting, not just the colour
      }
    }
    if (o.userData.assetId) rec.assetId = o.userData.assetId;
    if (o.userData.assetUrl) rec.assetUrl = o.userData.assetUrl;
    // clips from other files and cut parts come with a copy
    if (o.userData.animationFiles) rec.animationFiles = o.userData.animationFiles.map((f) => ({ ...f }));
    if (o.userData.clipCuts) rec.clipCuts = o.userData.clipCuts.map((c) => ({ ...c }));
    if (o.geometry && !rec.assetUrl && !rec.assetId) {
      const kind = primitiveKind(o.geometry);
      if (kind) rec.primitive = kind;
    }
    if (entity.behavior) rec.behavior = entity.behavior;
    Object.assign(rec, saveFields(entity)); // its plain settings (entity-fields.js)
    if (entity.rigidBody) {
      rec.rigidBody = {
        type: entity.rigidBody.type,
        mass: entity.rigidBody.mass,
        restitution: entity.rigidBody.restitution,
        friction: entity.rigidBody.friction,
        isTrigger: entity.rigidBody.isTrigger,
        shape: entity.rigidBody.shape,
        gravity: entity.rigidBody.gravity,
        tumbles: entity.rigidBody.tumbles,
        ignores: [...(entity.rigidBody.ignores || [])],
      };
    }
    // a prefab is only reusable if it brings its behaviour with it
    const gameplay = this.engine.gameplay;
    if (gameplay) {
      const components = gameplay.components.serializeFor(entity);
      const rules = gameplay.rules.serializeFor(entity);
      if (components) rec.components = components;
      if (rules) rec.rules = rules;
    }
    // ...and its sounds (they used to be left behind by copies and prefabs)
    const sounds = (this.engine.sounds || []).filter((s) => s.entity === entity).map(soundSettings);
    if (sounds.length) rec.sounds = sounds;
    return rec;
  },

  copyProperties() {
    const target = this._primarySelection();
    if (!target) return false;
    this._propsClipboard = this._snapshotProperties(target);
    return true;
  },

  pasteProperties() {
    if (!this._propsClipboard) return false;
    const targets = this.selectedSet.size > 0 ? [...this.selectedSet] : (this.selected ? [this.selected] : []);
    if (!targets.length) return false;
    const self = this;
    const befores = targets.map((t) => ({ entity: t, props: this._snapshotProperties(t) }));
    const doApply = (propsList) => {
      for (const { entity, props } of propsList) {
        this._applyProperties(entity, props);
      }
      this._renderInspector();
      this._renderHierarchy();
    };
    if (this.history) {
      this.history.push({
        label: 'paste properties',
        undo() { doApply(befores.map((b) => ({ entity: b.entity, props: b.props }))); },
        redo() { doApply(targets.map((t) => ({ entity: t, props: self._propsClipboard }))); },
      });
    }
    doApply(targets.map((t) => ({ entity: t, props: this._propsClipboard })));
    return true;
  },

  _snapshotProperties(entity) {
    const o = entity.object3D;
    const snap = {
      position: { x: o.position.x, y: o.position.y, z: o.position.z },
      rotation: { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z },
      scale: { x: o.scale.x, y: o.scale.y, z: o.scale.z },
      solid: entity.solid,
    };
    if (o.isLight) {
      snap.light = {
        color: '#' + o.color.getHexString(),
        intensity: o.intensity,
        castShadow: !!o.castShadow,
      };
    }
    const mesh = this._firstMesh(o);
    if (mesh && mesh.material && mesh.material.isMeshStandardMaterial) {
      const m = mesh.material;
      snap.material = materialSpec(m);
    }
    if (entity.rigidBody) {
      snap.rigidBody = {
        type: entity.rigidBody.type,
        mass: entity.rigidBody.mass,
        restitution: entity.rigidBody.restitution,
        friction: entity.rigidBody.friction,
      };
    }
    return snap;
  },

  _applyProperties(entity, props) {
    const o = entity.object3D;
    if (props.position) o.position.set(props.position.x, props.position.y, props.position.z);
    if (props.rotation) o.rotation.set(props.rotation.x, props.rotation.y, props.rotation.z);
    if (props.scale) o.scale.set(props.scale.x, props.scale.y, props.scale.z);
    if (props.solid !== undefined) {
      entity.solid = props.solid;
      this._updateSolidHelper(entity);
    }
    if (props.light && o.isLight) {
      o.color.set(props.light.color);
      o.intensity = props.light.intensity;
      o.castShadow = props.light.castShadow;
    }
    const mesh = this._firstMesh(o);
    if (props.material && mesh && mesh.material && mesh.material.isMeshStandardMaterial) {
      const m = mesh.material;
      // textures and settings too — but which library material it is stays the target's own
      applyMaterialSpec(m, { ...props.material, library: m.userData.t3?.library });
    }
    if (props.rigidBody && entity.rigidBody) {
      entity.rigidBody.type = props.rigidBody.type;
      entity.rigidBody.mass = props.rigidBody.mass;
      entity.rigidBody.restitution = props.rigidBody.restitution;
      entity.rigidBody.friction = props.rigidBody.friction;
      entity.rigidBody.invMass = props.rigidBody.type === 'dynamic' ? 1 / props.rigidBody.mass : 0;
    }
    this._helper.setFromObject(o);
  },
};
