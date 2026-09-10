import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Entity } from './entity.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

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

function primitiveKind(geo) {
  if (!geo) return null;
  if (geo.type === 'BoxGeometry') return 'box';
  if (geo.type === 'SphereGeometry') return 'sphere';
  if (geo.type === 'ConeGeometry') return 'cone';
  if (geo.type === 'CylinderGeometry') return 'cylinder';
  if (geo.type === 'TorusGeometry') return 'torus';
  return null;
}

/**
 * ObjectEditor — scene editing with a real transform gizmo.
 *
 * Features:
 *   - click an object in the viewport (or hierarchy) to select it
 *   - translate / rotate / scale gizmo (TransformControls), modes G / R / S
 *   - numeric inspector: name, position, rotation (deg), scale — all editable
 *   - light inspector: color, intensity, cast-shadow (for Light entities)
 *   - material inspector: color, metalness, roughness, opacity, wireframe,
 *     texture load / clear (for Mesh entities)
 *   - hierarchy panel listing every registered object; click to select
 *   - delete with Del or the inspector button
 *
 *   const editor = new ObjectEditor(engine, {
 *     listEl, inspectorEl, statusEl,
 *     onModeChange(mode) {},        // update toolbar button states
 *   });
 *   editor.register(entity);        // entity: { object3D, ... }
 *   editor.update(dt);              // call every frame
 *   editor.setGizmoMode('rotate');  // 'translate' | 'rotate' | 'scale'
 */
export class ObjectEditor {
  constructor(engine, { listEl = null, inspectorEl = null, statusEl = null, onModeChange = null, history = null } = {}) {
    this.engine = engine;
    this.listEl = listEl;
    this.inspectorEl = inspectorEl;
    this.statusEl = statusEl;
    this.onModeChange = onModeChange;
    this.history = history; // optional History instance for undo/redo

    this.selectables = [];
    this.selected = null;
    this.selectedSet = new Set(); // multi-select
    this._raycaster = new THREE.Raycaster();
    this._gizmoMode = 'translate';
    this.statusPrefix = ''; // e.g. '▶ PLAYING · ' while in play mode
    this._texLoader = new THREE.TextureLoader();
    this._audioLoader = new THREE.AudioLoader();
    this._dragStart = null; // transform snapshot for undoing gizmo drags
    this._dragStartMulti = null; // Map entity -> snapshot for multi-select gizmo drags
    this._clipboard = null; // JSON string for copy/paste
    this.snap = { translate: 0, rotate: 0, scale: 0 }; // 0 = off

    // --- transform gizmo ---
    this.gizmo = new TransformControls(engine.camera, engine.renderer.domElement);
    engine.scene.add(this.gizmo);
    this.gizmo.addEventListener('objectChange', () => this._syncInspector());
    // don't let the orbit camera fight the gizmo while dragging its handles
    this.gizmo.addEventListener('dragging-changed', (e) => {
      if (engine.cameraRig) engine.cameraRig.enabled = !e.value;
      if (e.value) {
        if (this.selectedSet.size > 1) this._dragStartMulti = this._snapshotMulti();
        else this._dragStart = this._snapshot();
      } else {
        if (this.selectedSet.size > 1) this._recordTransformMulti();
        else this._recordTransform();
      }
    });

    // apply snapping while dragging
    this.gizmo.addEventListener('change', () => {
      if (!this.gizmo.dragging) return;
      const primary = this._primarySelection();
      if (!primary) return;
      this._applySnap(primary.object3D);
      this._syncMultiToPrimary(primary);
      this._helper.setFromObject(primary.object3D);
      this._syncInspector();
    });

    // --- selection highlight ---
    this._helper = new THREE.BoxHelper(new THREE.Object3D(), 0x4dd0a6);
    this._helper.visible = false;
    engine.scene.add(this._helper);
    // dedicated helper for lights (icon + cone/sphere instead of a bare box)
    this._lightHelper = null;
  }

  // ---------- registry ----------

  register(entity) {
    if (!this.selectables.includes(entity)) {
      this.selectables.push(entity);
      this._renderHierarchy();
    }
    return entity;
  }

  unregister(entity) {
    const i = this.selectables.indexOf(entity);
    if (i !== -1) this.selectables.splice(i, 1);
    if (this.selected === entity) this.select(null);
    this._renderHierarchy();
  }

  // ---------- selection ----------

  select(entity, { additive = false, keepGizmo = false } = {}) {
    if (!entity) {
      this.selected = null;
      this.selectedSet.clear();
    } else if (additive) {
      if (this.selectedSet.has(entity)) {
        this.selectedSet.delete(entity);
      } else {
        this.selectedSet.add(entity);
      }
      this.selected = entity;
    } else {
      this.selectedSet.clear();
      this.selectedSet.add(entity);
      this.selected = entity;
    }

    this._clearLightHelper();
    const primary = this._primarySelection();
    if (primary) {
      if (!keepGizmo) this.gizmo.attach(primary.object3D);
      if (primary.object3D.isLight) {
        this._helper.visible = false;
        this._makeLightHelper(primary.object3D);
      } else {
        this._helper.visible = true;
        this._helper.setFromObject(primary.object3D);
      }
    } else {
      this.gizmo.detach();
      this._helper.visible = false;
    }
    this._renderHierarchy();
    this._renderInspector();
  }

  /** The entity that drives the gizmo and inspector. */
  _primarySelection() {
    return this.selected && this.selectedSet.has(this.selected) ? this.selected
      : this.selectedSet.values().next().value || null;
  }

  _clearLightHelper() {
    if (this._lightHelper) {
      this.engine.scene.remove(this._lightHelper);
      this._lightHelper.dispose?.();
      this._lightHelper = null;
    }
  }

  /** Build a small, readable helper for a light: a colored icon sphere + direction cone. */
  _makeLightHelper(light) {
    const group = new THREE.Group();
    group.name = '__lightHelper';
    const color = light.color ? light.color.getHex() : 0xffffff;

    if (light.isDirectionalLight || light.isSpotLight) {
      // direction cone pointing from the light toward its target
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.25, 0.6, 12),
        new THREE.MeshBasicMaterial({ color, wireframe: true })
      );
      cone.position.set(0, -0.4, 0);
      cone.rotation.x = Math.PI; // point down the -Y axis (toward target)
      group.add(cone);
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.8, 8),
        new THREE.MeshBasicMaterial({ color, wireframe: true })
      );
      shaft.position.set(0, 0.3, 0);
      group.add(shaft);
    } else {
      // point / ambient: a small glowing sphere
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 16, 12),
        new THREE.MeshBasicMaterial({ color, wireframe: true })
      );
      group.add(sphere);
    }

    group.position.copy(light.position);
    // orient directional/spot cones toward their target if one exists
    if ((light.isDirectionalLight || light.isSpotLight) && light.target) {
      group.lookAt(light.target.position);
    }
    this._lightHelper = group;
    this.engine.scene.add(group);
  }

  setGizmoMode(mode) {
    if (!['translate', 'rotate', 'scale'].includes(mode)) return;
    this._gizmoMode = mode;
    this.gizmo.setMode(mode);
    if (typeof this.onModeChange === 'function') this.onModeChange(mode);
    // refresh immediately so the toolbar/status update even if the next frame is delayed
    this._renderStatus();
  }

  get gizmoMode() { return this._gizmoMode; }

  // ---------- undo/redo helpers ----------

  /** Snapshot the selected object's transform (position/rotation/scale). */
  _snapshot() {
    const o = this.selected?.object3D;
    if (!o) return null;
    return {
      position: o.position.clone(),
      rotation: o.rotation.clone(),
      scale: o.scale.clone(),
    };
  }

  _snapshotMulti() {
    const map = new Map();
    for (const e of this.selectedSet) {
      const o = e.object3D;
      map.set(e, { position: o.position.clone(), rotation: o.rotation.clone(), scale: o.scale.clone() });
    }
    return map;
  }

  _applySnapshot(o, snap) {
    o.position.copy(snap.position);
    o.rotation.copy(snap.rotation);
    o.scale.copy(snap.scale);
    this._helper.setFromObject(o);
    this._syncInspector();
    this._updateSolidHelper(this.selected);
  }

  _applySnapshotMulti(map) {
    for (const [e, snap] of map) {
      const o = e.object3D;
      o.position.copy(snap.position);
      o.rotation.copy(snap.rotation);
      o.scale.copy(snap.scale);
      this._updateSolidHelper(e);
    }
    const primary = this._primarySelection();
    if (primary) this._helper.setFromObject(primary.object3D);
    this._syncInspector();
  }

  /** After a gizmo drag ends, record the before/after transform for undo. */
  _recordTransform() {
    const before = this._dragStart;
    this._dragStart = null;
    const o = this.selected?.object3D;
    if (!before || !o || !this.history) return;
    const after = this._snapshot();
    // ignore no-op drags (clicked a handle but didn't move)
    if (before.position.equals(after.position) &&
        before.rotation.equals(after.rotation) &&
        before.scale.equals(after.scale)) return;
    const self = this;
    this.history.push({
      label: 'transform',
      undo() { self._applySnapshot(o, before); },
      redo() { self._applySnapshot(o, after); },
    });
  }

  _recordTransformMulti() {
    const before = this._dragStartMulti;
    this._dragStartMulti = null;
    if (!before || !this.history) return;
    const after = this._snapshotMulti();
    let changed = false;
    for (const [e, b] of before) {
      const a = after.get(e);
      if (!a || !b.position.equals(a.position) || !b.rotation.equals(a.rotation) || !b.scale.equals(a.scale)) {
        changed = true; break;
      }
    }
    if (!changed) return;
    const self = this;
    this.history.push({
      label: 'transform multi',
      undo() { self._applySnapshotMulti(before); },
      redo() { self._applySnapshotMulti(after); },
    });
  }

  _applySnap(o) {
    const snap = (v, step) => step > 0 ? Math.round(v / step) * step : v;
    if (this.snap.translate > 0 && this._gizmoMode === 'translate') {
      o.position.x = snap(o.position.x, this.snap.translate);
      o.position.y = snap(o.position.y, this.snap.translate);
      o.position.z = snap(o.position.z, this.snap.translate);
    }
    if (this.snap.rotate > 0 && this._gizmoMode === 'rotate') {
      const step = this.snap.rotate * RAD;
      o.rotation.x = snap(o.rotation.x, step);
      o.rotation.y = snap(o.rotation.y, step);
      o.rotation.z = snap(o.rotation.z, step);
    }
    if (this.snap.scale > 0 && this._gizmoMode === 'scale') {
      o.scale.x = snap(o.scale.x, this.snap.scale);
      o.scale.y = snap(o.scale.y, this.snap.scale);
      o.scale.z = snap(o.scale.z, this.snap.scale);
    }
  }

  /** When multiple objects are selected, the gizmo drives the primary; copy the same delta to the rest. */
  _syncMultiToPrimary(primary) {
    if (this.selectedSet.size <= 1) return;
    const base = this._dragStartMulti?.get(primary);
    if (!base) return;
    const o = primary.object3D;
    const dp = new THREE.Vector3().subVectors(o.position, base.position);
    const dr = new THREE.Vector3(o.rotation.x - base.rotation.x, o.rotation.y - base.rotation.y, o.rotation.z - base.rotation.z);
    const ds = new THREE.Vector3().subVectors(o.scale, base.scale);
    for (const e of this.selectedSet) {
      if (e === primary) continue;
      const snap = this._dragStartMulti.get(e);
      if (!snap) continue;
      const t = e.object3D;
      t.position.copy(snap.position).add(dp);
      t.rotation.set(snap.rotation.x + dr.x, snap.rotation.y + dr.y, snap.rotation.z + dr.z);
      t.scale.copy(snap.scale).add(ds);
      this._updateSolidHelper(e);
    }
  }

  /** Record an add/remove so it can be undone/redone. */
  recordAdd(entity) { this._recordAddRemove(entity, true); }
  recordRemove(entity) { this._recordAddRemove(entity, false); }

  /** Record an add/remove so it can be undone/redone. */
  _recordAddRemove(entity, added) {
    if (!this.history) return;
    const self = this;
    const add = () => { self.engine.add(entity); self.register(entity); };
    const remove = () => {
      if (self.selected === entity) self.select(null);
      if (typeof entity.destroy === 'function') entity.destroy(self.engine);
      else self.engine.remove(entity);
      self.unregister(entity);
    };
    this.history.push({
      label: added ? 'add' : 'delete',
      undo: added ? remove : add,
      redo: added ? add : remove,
    });
  }

  // ---------- generic property undo helpers ----------

  /**
   * Record a single-value property change command.
   *   target: object to mutate
   *   prop:   property name
   *   before: previous value (primitive clone)
   *   after:  new value
   *   apply:  optional function(value) to apply the value
   */
  _recordValue(target, prop, before, after, apply = null, label = 'edit') {
    if (!this.history || before === after) return;
    const self = this;
    const doApply = (v) => {
      if (apply) apply(v);
      else target[prop] = v;
      self._renderInspector?.();
      self._renderHierarchy?.();
    };
    this.history.push({
      label,
      undo() { doApply(before); },
      redo() { doApply(after); },
    });
  }

  /**
   * Record a THREE.Color property change command.
   */
  _recordColor(target, prop, beforeHex, afterHex, label = 'color') {
    if (!this.history || beforeHex === afterHex) return;
    const self = this;
    this.history.push({
      label,
      undo() { target[prop].set(beforeHex); self._renderInspector?.(); },
      redo() { target[prop].set(afterHex); self._renderInspector?.(); },
    });
  }

  /**
   * Record a Vector3 component change command.
   */
  _recordVector(target, beforeVec, afterVec, label = 'transform') {
    if (!this.history || beforeVec.equals(afterVec)) return;
    const self = this;
    this.history.push({
      label,
      undo() { target.copy(beforeVec); self._helper.setFromObject(self.selected?.object3D); self._syncInspector?.(); },
      redo() { target.copy(afterVec); self._helper.setFromObject(self.selected?.object3D); self._syncInspector?.(); },
    });
  }

  /**
   * Record a material map (texture) change command.
   */
  _recordMap(mesh, beforeMap, afterMap, label = 'texture') {
    if (!this.history) return;
    const self = this;
    const m = mesh.material;
    this.history.push({
      label,
      undo() {
        if (m.map && m.map !== beforeMap) m.map.dispose();
        m.map = beforeMap || null;
        m.needsUpdate = true;
        self._renderInspector?.();
      },
      redo() {
        if (m.map && m.map !== afterMap) m.map.dispose();
        m.map = afterMap || null;
        m.needsUpdate = true;
        self._renderInspector?.();
      },
    });
  }

  /**
   * Record a sound property change command.
   */
  _recordSound(rec, prop, before, after, apply = null, label = 'sound') {
    if (!this.history || before === after) return;
    const self = this;
    const doApply = (v) => {
      rec[prop] = v;
      if (apply) apply(v);
      self._renderInspector?.();
    };
    this.history.push({
      label,
      undo() { doApply(before); },
      redo() { doApply(after); },
    });
  }

  // ---------- per-frame ----------

  update(_dt) {
    const { input, camera } = this.engine;

    // click to select (only when the gizmo isn't being dragged)
    if (input.mouseClicked(0) && !this.gizmo.dragging) {
      this._raycaster.setFromCamera(input.mouseNDC, camera);
      const roots = this.selectables
        .filter((e) => !e.object3D.isLight) // lights are selected via the hierarchy
        .map((e) => e.object3D);
      const hit = this._raycaster.intersectObjects(roots, true)[0];
      if (hit) {
        const entity = this.selectables.find((e) => {
          let node = hit.object;
          while (node) { if (node === e.object3D) return true; node = node.parent; }
          return false;
        });
        if (entity) {
          const additive = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
          this.select(entity, { additive });
        }
      } else if (this.selected) {
        this.select(null);
      }
    }

    // gizmo mode hotkeys — but not while typing in a panel field
    if (!this._typingInPanel()) {
      if (input.wasPressed('KeyG')) this.setGizmoMode('translate');
      if (input.wasPressed('KeyR')) this.setGizmoMode('rotate');
      if (input.wasPressed('KeyS')) this.setGizmoMode('scale');
    }

    // delete selection
    const sel = this.selected;
    if (sel && (input.wasPressed('Delete') || input.wasPressed('Backspace')) && !this._typingInPanel()) {
      this.deleteSelected();
      return;
    }

    if (sel) {
      this._helper.setFromObject(sel.object3D);
      // keep inspector numbers live while dragging the gizmo
      if (this.gizmo.dragging) this._syncInspector();
    }

    this._renderStatus();
  }

  deleteSelected() {
    const targets = this.selectedSet.size > 0 ? [...this.selectedSet] : (this.selected ? [this.selected] : []);
    if (!targets.length) return;
    this.select(null);
    const self = this;
    this.history.push({
      label: targets.length > 1 ? 'delete multi' : 'delete',
      undo() {
        for (const e of targets) {
          self.engine.add(e);
          self.register(e);
        }
        self.select(targets[0]);
      },
      redo() {
        for (const e of targets) {
          self._cleanupEntityMedia(e);
          if (typeof e.destroy === 'function') e.destroy(self.engine);
          else self.engine.remove(e);
          self.unregister(e);
        }
      },
    });
    for (const e of targets) {
      this._cleanupEntityMedia(e);
      if (typeof e.destroy === 'function') e.destroy(this.engine);
      else this.engine.remove(e);
      this.unregister(e);
    }
  }

  /** Copy the current selection to a JSON clipboard. */
  copySelection() {
    const targets = this.selectedSet.size > 0 ? [...this.selectedSet] : (this.selected ? [this.selected] : []);
    if (!targets.length) return false;
    const records = targets.map((e) => this._serializeForClipboard(e));
    this._clipboard = JSON.stringify(records);
    return true;
  }

  /** Paste the clipboard, creating new entities offset slightly from the originals. */
  pasteSelection() {
    if (!this._clipboard) return null;
    const records = JSON.parse(this._clipboard);
    const created = [];
    for (const rec of records) {
      const entity = this._deserializeFromClipboard(rec);
      if (entity) {
        this.engine.add(entity);
        this.register(entity);
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
  }

  /** Duplicate the current selection (supports multi-select). */
  duplicateSelection() {
    const targets = this.selectedSet.size > 0 ? [...this.selectedSet] : (this.selected ? [this.selected] : []);
    const created = [];
    for (const sel of targets) {
      const o = sel.object3D;
      const clone = o.clone(true);
      clone.position.x += 1.5;
      clone.name = (o.name || 'Object') + ' copy';
      const entity = new Entity(clone);
      entity.solid = sel.solid;
      entity.object3D.userData.kind = o.userData.kind;
      this.engine.add(entity);
      this.register(entity);
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
  }

  _serializeForClipboard(entity) {
    const o = entity.object3D;
    const rec = {
      name: o.name,
      position: { x: o.position.x, y: o.position.y, z: o.position.z },
      rotation: { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z },
      scale: { x: o.scale.x, y: o.scale.y, z: o.scale.z },
      solid: entity.solid,
      kind: o.userData.kind,
    };
    if (o.isLight) {
      rec.light = {
        type: o.isDirectionalLight ? 'directional' : o.isPointLight ? 'point' : o.isSpotLight ? 'spot' : 'ambient',
        color: '#' + o.color.getHexString(),
        intensity: o.intensity,
        castShadow: !!o.castShadow,
      };
    }
    const mesh = this._firstMesh(o);
    if (mesh && mesh.material && mesh.material.isMeshStandardMaterial) {
      const m = mesh.material;
      rec.material = {
        color: '#' + m.color.getHexString(),
        metalness: m.metalness,
        roughness: m.roughness,
        opacity: m.opacity,
        wireframe: !!m.wireframe,
      };
    }
    if (o.userData.assetUrl) rec.assetUrl = o.userData.assetUrl;
    if (o.geometry && !rec.assetUrl) {
      const kind = primitiveKind(o.geometry);
      if (kind) rec.primitive = kind;
    }
    return rec;
  }

  _deserializeFromClipboard(rec) {
    let object3D;
    if (rec.light) {
      const light = LIGHT_TYPES[rec.light.type](rec.light);
      light.castShadow = !!rec.light.castShadow;
      object3D = light;
    } else if (rec.assetUrl) {
      // GLB paste: can't load synchronously; skip
      return null;
    } else if (rec.primitive) {
      const geo = (PRIMITIVE_GEOS[rec.primitive] || PRIMITIVE_GEOS.box)();
      const m = rec.material || {};
      const mat = new THREE.MeshStandardMaterial({
        color: m.color || 0x539bf5,
        metalness: m.metalness ?? 0,
        roughness: m.roughness ?? 1,
        opacity: m.opacity ?? 1,
        wireframe: !!m.wireframe,
        transparent: (m.opacity ?? 1) < 1,
      });
      object3D = new THREE.Mesh(geo, mat);
      object3D.castShadow = object3D.receiveShadow = true;
    } else {
      return null;
    }
    object3D.name = rec.name;
    object3D.position.set(rec.position.x + 1.5, rec.position.y, rec.position.z);
    object3D.rotation.set(rec.rotation.x, rec.rotation.y, rec.rotation.z);
    object3D.scale.set(rec.scale.x, rec.scale.y, rec.scale.z);
    object3D.userData.kind = rec.kind || 'Prop';
    const entity = new Entity(object3D);
    entity.solid = !!rec.solid;
    return entity;
  }

  setSnap(type, value) {
    this.snap[type] = value;
    this._renderStatus();
  }

  /** Stop + drop any animation mixer / positional audio bound to an entity. */
  _cleanupEntityMedia(entity) {
    const mi = this.engine.mixers.findIndex((m) => m.root === entity.object3D);
    if (mi !== -1) {
      this.engine.mixers[mi].mixer.stopAllAction();
      this.engine.mixers.splice(mi, 1);
    }
    this._clearSound(entity);
    this._clearSolidHelper(entity);
  }

  /** Show/hide a red wireframe box around solid entities. */
  _updateSolidHelper(entity) {
    this._clearSolidHelper(entity);
    if (!entity.solid) return;
    const helper = new THREE.BoxHelper(entity.object3D, 0xff3333);
    helper.name = '__solidHelper';
    entity.object3D.userData.__solidHelper = helper;
    this.engine.scene.add(helper);
    helper.update();
    // keep helper in sync while selected/transformed
    const tick = () => {
      if (!helper.parent) return;
      if (entity.solid && entity.object3D.userData.__solidHelper === helper) {
        helper.update();
        requestAnimationFrame(tick);
      } else {
        this.engine.scene.remove(helper);
      }
    };
    tick();
  }

  _clearSolidHelper(entity) {
    const helper = entity.object3D.userData.__solidHelper;
    if (helper) {
      this.engine.scene.remove(helper);
      delete entity.object3D.userData.__solidHelper;
    }
  }

  // ---------- hierarchy panel ----------

  _renderHierarchy() {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    for (const entity of this.selectables) {
      const li = document.createElement('li');
      if (this.selectedSet.has(entity)) li.classList.add('selected');
      const kind = entity.object3D.userData.kind || entity.constructor.name;
      li.innerHTML = `<span class="ico">${this._icon(kind)}</span><span class="nm">${this._name(entity)}</span>`;
      li.addEventListener('click', (e) => {
        const additive = e.shiftKey;
        this.select(entity, { additive });
      });
      this.listEl.appendChild(li);
    }
  }

  _icon(kind) {
    switch (kind) {
      case 'Player': return '●';
      case 'Coin': return '◉';
      case 'Prop': return '■';
      case 'Light': return '☀';
      default: return '◆';
    }
  }

  _name(entity) {
    return entity.object3D.name || entity.constructor.name;
  }

  // ---------- inspector panel ----------

  _renderInspector() {
    if (!this.inspectorEl) return;
    const sel = this.selected;
    if (!sel) {
      this.inspectorEl.innerHTML = '<div class="empty">Select an object in the scene or hierarchy.</div>';
      return;
    }

    const o = sel.object3D;
    const isLight = !!o.isLight;
    const mesh = this._firstMesh(o);

    this.inspectorEl.innerHTML = `
      <div class="body">
        <input class="obj-name" id="insp-name" value="${this._name(sel)}" spellcheck="false" />
        ${this._vecRow('pos', 'Position', o.position)}
        ${this._vecRow('rot', 'Rotation°', { x: o.rotation.x * DEG, y: o.rotation.y * DEG, z: o.rotation.z * DEG })}
        ${isLight ? '' : this._vecRow('scl', 'Scale', o.scale)}
        <label class="check-row"><input type="checkbox" id="insp-solid" ${sel.solid ? 'checked' : ''}/> Solid (blocks player)</label>
        ${isLight ? this._lightSection(o) : ''}
        ${mesh ? this._materialSection(mesh) : ''}
        ${this._animationSection(sel)}
        ${this._audioSection(sel)}
        <div class="insp-row">
          <button class="tbtn" id="insp-dup">Duplicate</button>
          <button class="tbtn danger" id="insp-del">Delete</button>
        </div>
      </div>`;

    // name (record on change/blur)
    const nameField = this.inspectorEl.querySelector('#insp-name');
    let nameBefore = o.name;
    nameField.addEventListener('focus', () => { nameBefore = o.name; });
    nameField.addEventListener('input', (e) => {
      o.name = e.target.value;
      this._renderHierarchy();
    });
    nameField.addEventListener('change', () => {
      this._recordValue(o, 'name', nameBefore, o.name, (v) => { o.name = v; this._renderHierarchy(); }, 'rename');
      nameBefore = o.name;
    });
    nameField.addEventListener('blur', () => {
      if (o.name !== nameBefore) {
        this._recordValue(o, 'name', nameBefore, o.name, (v) => { o.name = v; this._renderHierarchy(); }, 'rename');
        nameBefore = o.name;
      }
    });

    // numeric vectors — record on change/blur per axis
    const vecs = [
      ['pos', o.position, 1],
      ['rot', o.rotation, RAD],
    ];
    if (!isLight) vecs.push(['scl', o.scale, 1]);
    for (const [key, target, conv] of vecs) {
      for (const axis of ['x', 'y', 'z']) {
        const field = this.inspectorEl.querySelector(`#insp-${key}-${axis}`);
        let axisBefore = target[axis];
        field.addEventListener('focus', () => { axisBefore = target[axis]; });
        field.addEventListener('input', () => {
          const v = parseFloat(field.value);
          if (Number.isFinite(v)) {
            target[axis] = v * conv;
            this._helper.setFromObject(o);
            this.gizmo.updateMatrixWorld?.();
          }
        });
        field.addEventListener('change', () => {
          const after = target.clone();
          target[axis] = axisBefore;
          const before = target.clone();
          target.copy(after);
          this._recordVector(target, before, after, `${key}.${axis}`);
          axisBefore = target[axis];
        });
      }
    }

    const solidCheck = this.inspectorEl.querySelector('#insp-solid');
    if (solidCheck) {
      let solidBefore = !!sel.solid;
      solidCheck.addEventListener('change', () => {
        const after = solidCheck.checked;
        this._recordValue(sel, 'solid', solidBefore, after, (v) => {
          sel.solid = v;
          this._updateSolidHelper(sel);
        }, 'solid');
        sel.solid = after;
        this._updateSolidHelper(sel);
        solidBefore = after;
      });
    }
    this._updateSolidHelper(sel);

    if (isLight) this._wireLightSection(o);
    if (mesh) this._wireMaterialSection(mesh);
    this._wireAnimationSection(sel);
    this._wireAudioSection(sel);

    this.inspectorEl.querySelector('#insp-del').addEventListener('click', () => this.deleteSelected());
    this.inspectorEl.querySelector('#insp-dup').addEventListener('click', () => this.duplicateSelection());
  }

  _vecRow(key, label, v) {
    const f = (n) => (Math.round(n * 100) / 100).toString();
    return `
      <div class="vec-row">
        <label>${label}</label>
        <input id="insp-${key}-x" type="number" step="0.1" value="${f(v.x)}" />
        <input id="insp-${key}-y" type="number" step="0.1" value="${f(v.y)}" />
        <input id="insp-${key}-z" type="number" step="0.1" value="${f(v.z)}" />
      </div>`;
  }

  // ---------- lights ----------

  _lightSection(light) {
    const shadowRow = light.shadow
      ? `<label class="check-row"><input type="checkbox" id="insp-shadow" ${light.castShadow ? 'checked' : ''}/> Cast shadows</label>`
      : '';
    return `
      <h4 class="insp-h">Light</h4>
      <div class="prop-row"><label>Color</label>
        <input type="color" id="insp-lcolor" value="#${light.color.getHexString()}" /></div>
      <div class="prop-row"><label>Intensity</label>
        <input type="range" id="insp-lintensity" min="0" max="8" step="0.05" value="${light.intensity}" />
        <span class="val" id="insp-lintensity-v">${light.intensity.toFixed(2)}</span></div>
      ${shadowRow}`;
  }

  _wireLightSection(light) {
    const q = (s) => this.inspectorEl.querySelector(s);

    // color
    const colorBefore = '#' + light.color.getHexString();
    let colorCurrent = colorBefore;
    q('#insp-lcolor').addEventListener('input', (e) => {
      light.color.set(e.target.value);
      colorCurrent = e.target.value;
    });
    q('#insp-lcolor').addEventListener('change', () => {
      this._recordColor(light, 'color', colorBefore, colorCurrent, 'light color');
    });

    // intensity
    const slider = q('#insp-lintensity');
    let intensityBefore = light.intensity;
    slider.addEventListener('input', () => {
      light.intensity = parseFloat(slider.value);
      q('#insp-lintensity-v').textContent = light.intensity.toFixed(2);
    });
    slider.addEventListener('change', () => {
      this._recordValue(light, 'intensity', intensityBefore, light.intensity, (v) => {
        light.intensity = v;
        q('#insp-lintensity').value = v;
        q('#insp-lintensity-v').textContent = v.toFixed(2);
      }, 'light intensity');
      intensityBefore = light.intensity;
    });

    // cast shadows
    const shadow = q('#insp-shadow');
    if (shadow) {
      let shadowBefore = !!light.castShadow;
      shadow.addEventListener('change', () => {
        const after = shadow.checked;
        this._recordValue(light, 'castShadow', shadowBefore, after, (v) => {
          light.castShadow = v;
          shadow.checked = v;
        }, 'shadows');
        light.castShadow = after;
        shadowBefore = after;
      });
    }
  }

  // ---------- materials & textures ----------

  _firstMesh(root) {
    if (root.isMesh) return root;
    let found = null;
    root.traverse?.((n) => { if (!found && n.isMesh) found = n; });
    return found;
  }

  _materialSection(mesh) {
    const m = mesh.material;
    if (!m || !m.isMeshStandardMaterial) {
      return '<h4 class="insp-h">Material</h4><div class="empty">Non-standard material — edit in code.</div>';
    }
    const hasTex = !!m.map;
    return `
      <h4 class="insp-h">Material</h4>
      <div class="prop-row"><label>Color</label>
        <input type="color" id="insp-mcolor" value="#${m.color.getHexString()}" /></div>
      <div class="prop-row"><label>Metalness</label>
        <input type="range" id="insp-metal" min="0" max="1" step="0.01" value="${m.metalness}" />
        <span class="val" id="insp-metal-v">${m.metalness.toFixed(2)}</span></div>
      <div class="prop-row"><label>Roughness</label>
        <input type="range" id="insp-rough" min="0" max="1" step="0.01" value="${m.roughness}" />
        <span class="val" id="insp-rough-v">${m.roughness.toFixed(2)}</span></div>
      <div class="prop-row"><label>Opacity</label>
        <input type="range" id="insp-opacity" min="0" max="1" step="0.01" value="${m.opacity}" />
        <span class="val" id="insp-opacity-v">${m.opacity.toFixed(2)}</span></div>
      <label class="check-row"><input type="checkbox" id="insp-wire" ${m.wireframe ? 'checked' : ''}/> Wireframe</label>
      <h4 class="insp-h">Texture</h4>
      <div class="prop-row"><span class="val" id="insp-texname">${hasTex ? (m.map.name || 'custom') : 'none'}</span></div>
      <div class="insp-row" style="margin-top:4px">
        <button class="tbtn" id="insp-tex-load">Load…</button>
        <button class="tbtn" id="insp-tex-clear" ${hasTex ? '' : 'disabled'}>Clear</button>
      </div>`;
  }

  _wireMaterialSection(mesh) {
    const m = mesh.material;
    if (!m || !m.isMeshStandardMaterial) return;
    const q = (s) => this.inspectorEl.querySelector(s);

    // color
    const mcolorBefore = '#' + m.color.getHexString();
    let mcolorCurrent = mcolorBefore;
    q('#insp-mcolor').addEventListener('input', (e) => {
      m.color.set(e.target.value);
      mcolorCurrent = e.target.value;
    });
    q('#insp-mcolor').addEventListener('change', () => {
      this._recordColor(m, 'color', mcolorBefore, mcolorCurrent, 'material color');
    });

    // numeric sliders (record on change)
    const slider = (id, prop, apply, label) => {
      const el = q(`#insp-${id}`);
      let before = m[prop];
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        apply(v);
        q(`#insp-${id}-v`).textContent = v.toFixed(2);
      });
      el.addEventListener('change', () => {
        const after = m[prop];
        this._recordValue(m, prop, before, after, (v) => {
          apply(v);
          el.value = v;
          q(`#insp-${id}-v`).textContent = v.toFixed(2);
        }, label);
        before = after;
      });
    };
    slider('metal', 'metalness', (v) => { m.metalness = v; }, 'metalness');
    slider('rough', 'roughness', (v) => { m.roughness = v; }, 'roughness');
    slider('opacity', 'opacity', (v) => {
      m.opacity = v;
      m.transparent = v < 1;
      m.needsUpdate = true;
    }, 'opacity');

    // wireframe
    const wireBefore = !!m.wireframe;
    q('#insp-wire').addEventListener('change', (e) => {
      const after = e.target.checked;
      this._recordValue(m, 'wireframe', wireBefore, after, (v) => {
        m.wireframe = v;
        e.target.checked = v;
      }, 'wireframe');
      m.wireframe = after;
    });

    // texture load
    q('#insp-tex-load').addEventListener('click', () => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'image/*';
      picker.addEventListener('change', () => {
        const file = picker.files?.[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        this._texLoader.load(url, (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.name = file.name;
          const oldMap = m.map;
          this._recordMap(mesh, oldMap, tex, 'load texture');
          if (m.map && m.map !== oldMap) m.map.dispose();
          m.map = tex;
          m.needsUpdate = true;
          URL.revokeObjectURL(url);
          q('#insp-texname').textContent = file.name;
          q('#insp-tex-clear').disabled = false;
        });
      });
      picker.click();
    });

    // texture clear
    q('#insp-tex-clear').addEventListener('click', () => {
      if (m.map) {
        const oldMap = m.map;
        this._recordMap(mesh, oldMap, null, 'clear texture');
        m.map.dispose();
        m.map = null;
        m.needsUpdate = true;
      }
      q('#insp-texname').textContent = 'none';
      q('#insp-tex-clear').disabled = true;
    });
  }

  // ---------- animation ----------

  /** Get (or lazily create) the mixer record for an entity. */
  _mixerFor(entity) {
    let rec = this.engine.mixers.find((m) => m.root === entity.object3D);
    if (!rec) {
      const clips = entity.object3D.userData.animations || [];
      rec = {
        root: entity.object3D,
        mixer: new THREE.AnimationMixer(entity.object3D),
        clips,
        actions: {},
        current: null,
        speed: 1,
        loop: true,
      };
      this.engine.mixers.push(rec);
    }
    return rec;
  }

  _animationSection(entity) {
    const clips = entity.object3D.userData.animations || [];
    if (!clips.length) return '';
    const rec = this.engine.mixers.find((m) => m.root === entity.object3D);
    const cur = rec?.current ?? '';
    const opts = ['<option value="">(none)</option>']
      .concat(clips.map((c, i) =>
        `<option value="${i}" ${String(i) === String(cur) ? 'selected' : ''}>${c.name || 'clip ' + i}</option>`))
      .join('');
    return `
      <h4 class="insp-h">Animation</h4>
      <div class="prop-row"><label>Clip</label><select id="insp-anim">${opts}</select></div>
      <div class="prop-row"><label>Speed</label>
        <input type="range" id="insp-anim-speed" min="0" max="3" step="0.05" value="${rec?.speed ?? 1}" />
        <span class="val" id="insp-anim-speed-v">${(rec?.speed ?? 1).toFixed(2)}</span></div>
      <label class="check-row"><input type="checkbox" id="insp-anim-loop" ${rec?.loop !== false ? 'checked' : ''}/> Loop</label>`;
  }

  _wireAnimationSection(entity) {
    const sel = this.inspectorEl.querySelector('#insp-anim');
    if (!sel) return; // no animations on this object
    const rec = this._mixerFor(entity);
    const q = (s) => this.inspectorEl.querySelector(s);

    const play = (idx) => {
      // stop current
      if (rec.current !== null && rec.actions[rec.current]) {
        rec.actions[rec.current].fadeOut(0.15);
      }
      if (idx === '' || idx === null) { rec.current = null; return; }
      const i = Number(idx);
      let action = rec.actions[i];
      if (!action) {
        action = rec.mixer.clipAction(rec.clips[i]);
        rec.actions[i] = action;
      }
      action.reset();
      action.setLoop(rec.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.clampWhenFinished = !rec.loop;
      action.fadeIn(0.15).play();
      rec.current = i;
    };

    sel.addEventListener('change', () => play(sel.value));

    const speed = q('#insp-anim-speed');
    speed.addEventListener('input', () => {
      rec.speed = parseFloat(speed.value);
      q('#insp-anim-speed-v').textContent = rec.speed.toFixed(2);
    });

    q('#insp-anim-loop').addEventListener('change', (e) => {
      rec.loop = e.target.checked;
      const a = rec.current !== null ? rec.actions[rec.current] : null;
      if (a) {
        a.setLoop(rec.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        a.clampWhenFinished = !rec.loop;
      }
    });
  }

  // ---------- audio (multiple sounds per entity) ----------

  _audioSection(entity) {
    const list = this.engine.sounds.filter((s) => s.entity === entity);
    let html = '<h4 class="insp-h">Audio</h4>';
    if (!list.length) {
      html += '<div class="empty">No sounds attached.</div>';
    }
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      html += `
        <div class="aud-card" data-idx="${i}" style="border:1px solid var(--border); border-radius:6px; padding:6px 8px; margin-bottom:8px;">
          <div class="prop-row" style="grid-template-columns: 1fr auto; gap:6px; margin-bottom:4px;">
            <input class="obj-name" style="margin:0" id="insp-aud-name-${i}" value="${r.name}" spellcheck="false" />
            <button class="tbtn danger" data-aud="del-${i}" style="padding:2px 7px; font-size:12px">×</button>
          </div>
          <div class="prop-row"><label>Type</label>
            <select id="insp-aud-type-${i}">
              <option value="positional" ${r.type === 'positional' ? 'selected' : ''}>Positional</option>
              <option value="ambient" ${r.type === 'ambient' ? 'selected' : ''}>Ambient</option>
              <option value="global" ${r.type === 'global' ? 'selected' : ''}>Global</option>
            </select>
          </div>
          <div class="prop-row"><label>Trigger</label>
            <select id="insp-aud-trig-${i}">
              <option value="" ${!r.trigger ? 'selected' : ''}>— none / always —</option>
              <option value="fire" ${r.trigger === 'fire' ? 'selected' : ''}>Fire action</option>
              <option value="jump" ${r.trigger === 'jump' ? 'selected' : ''}>Jump action</option>
              <option value="spawn" ${r.trigger === 'spawn' ? 'selected' : ''}>On spawn</option>
            </select>
          </div>
          <div class="insp-row" style="margin-top:4px">
            <button class="tbtn" data-aud="play-${i}">${r.audio.isPlaying ? '⏸ Stop' : '▶ Play'}</button>
            <button class="tbtn" data-aud="clr-${i}">Clear</button>
          </div>
          <div class="prop-row"><label>Volume</label>
            <input type="range" id="insp-aud-vol-${i}" min="0" max="1" step="0.01" value="${r.volume}" />
            <span class="val" id="insp-aud-vol-v-${i}">${r.volume.toFixed(2)}</span></div>
          <div class="prop-row"><label>Dist</label>
            <input type="range" id="insp-aud-dist-${i}" min="1" max="50" step="1" value="${r.refDistance}" />
            <span class="val" id="insp-aud-dist-v-${i}">${r.refDistance}</span></div>
          <label class="check-row"><input type="checkbox" id="insp-aud-loop-${i}" ${r.loop ? 'checked' : ''}/> Loop</label>
          <label class="check-row"><input type="checkbox" id="insp-aud-auto-${i}" ${r.autoplay ? 'checked' : ''}/> Autoplay</label>
        </div>`;
    }
    html += `
      <div class="insp-row" style="margin-top:8px">
        <button class="tbtn" id="insp-aud-add">＋ Add sound</button>
      </div>`;
    return html;
  }

  _wireAudioSection(entity) {
    const q = (s) => this.inspectorEl.querySelector(s);
    const list = () => this.engine.sounds.filter((s) => s.entity === entity);

    // Add a new sound slot (file picker -> create record)
    q('#insp-aud-add').addEventListener('click', () => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'audio/*';
      picker.addEventListener('change', () => {
        const file = picker.files?.[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        this._audioLoader.load(url, (buffer) => {
          URL.revokeObjectURL(url);
          this.engine.addSound(entity, buffer, { name: file.name, type: 'positional' });
          this._renderInspector();
        });
      });
      picker.click();
    });

    // per-card wiring
    list().forEach((r, i) => {
      // name
      const nameEl = q(`#insp-aud-name-${i}`);
      let audNameBefore = r.name;
      nameEl.addEventListener('focus', () => { audNameBefore = r.name; });
      nameEl.addEventListener('input', (e) => { r.name = e.target.value; });
      nameEl.addEventListener('change', () => {
        this._recordSound(r, 'name', audNameBefore, r.name, (v) => { r.name = v; }, 'sound name');
        audNameBefore = r.name;
      });

      // type
      const typeBefore = r.type;
      q(`#insp-aud-type-${i}`).addEventListener('change', (e) => {
        const after = e.target.value;
        this._recordSound(r, 'type', typeBefore, after, (v) => {
          this._changeSoundType(r, v);
          this._renderInspector();
        }, 'sound type');
        this._changeSoundType(r, after);
      });

      // trigger
      const trigBefore = r.trigger || '';
      q(`#insp-aud-trig-${i}`).addEventListener('change', (e) => {
        const after = e.target.value || null;
        this._recordSound(r, 'trigger', trigBefore, after, (v) => { r.trigger = v || null; }, 'sound trigger');
        r.trigger = after;
      });

      // play/stop (not undoable — it's a preview)
      q(`[data-aud="play-${i}"]`).addEventListener('click', () => {
        this.engine.unlockAudio();
        if (r.audio.isPlaying) r.audio.stop(); else r.audio.play();
        this._renderInspector();
      });

      // clear this sound
      q(`[data-aud="clr-${i}"]`).addEventListener('click', () => {
        this.engine.removeSound(r);
        this._renderInspector();
      });

      // delete this sound
      q(`[data-aud="del-${i}"]`).addEventListener('click', () => {
        this.engine.removeSound(r);
        this._renderInspector();
      });

      // volume
      const vol = q(`#insp-aud-vol-${i}`);
      let volBefore = r.volume;
      vol.addEventListener('input', () => {
        r.volume = parseFloat(vol.value);
        r.audio.setVolume(r.volume);
        q(`#insp-aud-vol-v-${i}`).textContent = r.volume.toFixed(2);
      });
      vol.addEventListener('change', () => {
        this._recordSound(r, 'volume', volBefore, r.volume, (v) => {
          r.volume = v;
          r.audio.setVolume(v);
          q(`#insp-aud-vol-${i}`).value = v;
          q(`#insp-aud-vol-v-${i}`).textContent = v.toFixed(2);
        }, 'sound volume');
        volBefore = r.volume;
      });

      // distance
      const dist = q(`#insp-aud-dist-${i}`);
      let distBefore = r.refDistance;
      dist.addEventListener('input', () => {
        r.refDistance = parseInt(dist.value, 10);
        if (r.type === 'positional') r.audio.setRefDistance(r.refDistance);
        q(`#insp-aud-dist-v-${i}`).textContent = String(r.refDistance);
      });
      dist.addEventListener('change', () => {
        this._recordSound(r, 'refDistance', distBefore, r.refDistance, (v) => {
          r.refDistance = v;
          if (r.type === 'positional') r.audio.setRefDistance(v);
          q(`#insp-aud-dist-${i}`).value = v;
          q(`#insp-aud-dist-v-${i}`).textContent = String(v);
        }, 'sound distance');
        distBefore = r.refDistance;
      });

      // loop
      const loopBefore = !!r.loop;
      q(`#insp-aud-loop-${i}`).addEventListener('change', (e) => {
        const after = e.target.checked;
        this._recordSound(r, 'loop', loopBefore, after, (v) => {
          r.loop = v;
          r.audio.setLoop(v);
          e.target.checked = v;
        }, 'sound loop');
        r.loop = after;
        r.audio.setLoop(after);
      });

      // autoplay
      const autoBefore = !!r.autoplay;
      q(`#insp-aud-auto-${i}`).addEventListener('change', (e) => {
        const after = e.target.checked;
        this._recordSound(r, 'autoplay', autoBefore, after, (v) => { r.autoplay = v; e.target.checked = v; }, 'sound autoplay');
        r.autoplay = after;
      });
    });
  }

  _changeSoundType(rec, newType) {
    const wasPlaying = rec.audio.isPlaying;
    const currentTime = rec.audio.context.currentTime;
    if (rec.audio.isPlaying) rec.audio.stop();

    // detach old audio node
    if (rec.type === 'positional') {
      rec.entity.object3D.remove(rec.audio);
    }
    rec.audio.disconnect?.();

    // build new audio node of the requested type, preserving buffer + settings
    let audio;
    if (newType === 'positional') {
      audio = new THREE.PositionalAudio(this.engine.listener);
      audio.setRefDistance(rec.refDistance);
      rec.entity.object3D.add(audio);
    } else {
      audio = new THREE.Audio(this.engine.listener);
    }
    audio.setBuffer(rec.audio.buffer);
    audio.setVolume(rec.volume);
    audio.setLoop(rec.loop);
    rec.type = newType;
    rec.audio = audio;

    if (wasPlaying && newType !== 'positional') audio.play(currentTime);
  }

  _clearSound(entity) {
    this.engine.clearEntitySounds(entity);
  }

  /** Refresh inspector numbers without rebuilding the DOM (used while dragging). */
  _syncInspector() {
    const sel = this.selected;
    if (!sel || !this.inspectorEl || this._typingInPanel()) return;
    const o = sel.object3D;
    const set = (key, axis, val) => {
      const el = this.inspectorEl.querySelector(`#insp-${key}-${axis}`);
      if (el) el.value = (Math.round(val * 100) / 100).toString();
    };
    for (const a of ['x', 'y', 'z']) {
      set('pos', a, o.position[a]);
      set('rot', a, o.rotation[a] * DEG);
      set('scl', a, o.scale[a]);
    }
  }

  _typingInPanel() {
    const a = document.activeElement;
    if (!a || (a.tagName !== 'INPUT' && a.tagName !== 'TEXTAREA')) return false;
    // any text/number field in any editor panel counts
    return !!a.closest('.panel') && a.type !== 'range' && a.type !== 'checkbox' && a.type !== 'color';
  }

  _renderStatus() {
    if (!this.statusEl) return;
    const cam = this.engine.cameraRig ? this.engine.cameraRig.mode : 'orbit';
    const count = this.selectedSet.size;
    const sel = count > 1 ? ` · selected: <b>${count} objects</b>`
      : this.selected ? ` · selected: <b>${this._name(this.selected)}</b>`
      : '';
    const snap = [];
    if (this.snap.translate > 0) snap.push(`grid ${this.snap.translate}`);
    if (this.snap.rotate > 0) snap.push(`angle ${this.snap.rotate}°`);
    if (this.snap.scale > 0) snap.push(`scale ${this.snap.scale}`);
    const snapText = snap.length ? ` · snap: ${snap.join(', ')}` : '';
    this.statusEl.innerHTML = `${this.statusPrefix}${cam} cam · ${this._gizmoMode} gizmo${sel}${snapText}`;
  }
}

/**
 * LightEntity — wraps a THREE.Light so it can live in the engine's entity
 * list and appear in the hierarchy. Ambient/hemisphere lights have no
 * position to drag; directional/point/spot do.
 */
export class LightEntity {
  constructor(light, name) {
    this.object3D = light;
    light.name = name;
    light.userData.kind = 'Light';
  }
  // lights need no per-frame update; destroy removes them from the scene
  destroy(engine) { engine.scene.remove(this.object3D); }
}
