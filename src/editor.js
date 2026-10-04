import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RAD } from './editor/shared.js';
import { escapeHtml } from './ui.js';
import { undoMethods } from './editor/history.js';
import { clipboardMethods } from './editor/clipboard.js';
import { prefabMethods } from './editor/prefabs.js';
import { hierarchyMethods } from './editor/hierarchy.js';
import { inspectorMethods } from './editor/inspector.js';
import { generatorSectionMethods } from './editor/generator-section.js';
import { physicsSectionMethods } from './editor/physics-section.js';
import { scriptSectionMethods } from './editor/script-section.js';
import { animationSectionMethods } from './editor/animation-section.js';
import { audioSectionMethods } from './editor/audio-section.js';
import { lightingMethods } from './editor/lighting.js';
import { viewSectionMethods } from './editor/view-section.js';

// re-exported so existing callers keep importing them from here
export { escapeHtml };
export { LightEntity } from './light-entity.js';

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
  constructor(engine, {
    listEl = null, inspectorEl = null, statusEl = null,
    shapeEl = null, materialEl = null, audioEl = null, lightListEl = null,
    onModeChange = null, history = null, assets = null,
  } = {}) {
    this.engine = engine;
    this.listEl = listEl;
    this.inspectorEl = inspectorEl;
    // each concern renders into its own panel
    this.shapeEl = shapeEl;         // position / rotation / scale
    this.materialEl = materialEl;   // colour, surface, texture
    this.audioEl = audioEl;         // the selected object's sounds
    this.lightListEl = lightListEl; // every light in the scene
    this.statusEl = statusEl;
    this.onModeChange = onModeChange;
    this.history = history; // optional History instance for undo/redo
    this.assets = assets;   // AssetLoader, needed to paste/instantiate GLB models

    this.selectables = [];
    this.selected = null;
    this.selectedSet = new Set(); // multi-select
    this._collapsed = new Set(); // entity -> collapsed in hierarchy
    this._raycaster = new THREE.Raycaster();
    this._gizmoMode = 'translate';
    this.statusPrefix = ''; // e.g. '▶ PLAYING · ' while in play mode
    this._texLoader = new THREE.TextureLoader();
    this._audioLoader = new THREE.AudioLoader();
    this._dragStart = null; // transform snapshot for undoing gizmo drags
    this._dragStartMulti = null; // Map entity -> snapshot for multi-select gizmo drags
    this._clipboard = null; // JSON string for copy/paste
    this._propsClipboard = null; // property snapshot for copy/paste props
    this.snap = { translate: 0, rotate: 0, scale: 0 }; // 0 = off
    this.gizmoSensitivity = 0.25;
    this._dragStart = null; // transform snapshot for undoing gizmo drags
    this._gizmoBase = null; // transform at drag start
    this._gizmoBaseMulti = null; // Map entity -> transform at drag start

    // --- transform gizmo ---
    this.gizmo = new TransformControls(engine.camera, engine.renderer.domElement);
    this.gizmo.setSize(0.65);
    engine.scene.add(this.gizmo);
    this.gizmo.addEventListener('objectChange', () => this._onGizmoObjectChange());
    // don't let the orbit camera fight the gizmo while dragging its handles
    this.gizmo.addEventListener('dragging-changed', (e) => {
      if (engine.cameraRig) engine.cameraRig.enabled = !e.value;
      if (e.value) {
        if (this.selectedSet.size > 1) {
          this._dragStartMulti = this._snapshotMulti();
          this._gizmoBaseMulti = this._snapshotMulti();
        } else {
          this._dragStart = this._snapshot();
          this._gizmoBase = this._snapshot();
        }
      } else {
        this._gizmoBase = null;
        this._gizmoBaseMulti = null;
        if (this.selectedSet.size > 1) this._recordTransformMulti();
        else this._recordTransform();
      }
    });
    // A press on a gizmo handle is not a scene click. Selection now happens on
    // release, by which time the gizmo has finished — so without this, tapping
    // a handle without moving would raycast past it and select what's behind.
    this._suppressNextTap = false;
    this.gizmo.addEventListener('mouseDown', () => { this._suppressNextTap = true; });

    // --- selection highlight ---
    this._helper = new THREE.BoxHelper(new THREE.Object3D(), 0x4dd0a6);
    this._helper.visible = false;
    engine.scene.add(this._helper);
    // dedicated helper for lights (icon + cone/sphere instead of a bare box)
    this._lightHelper = null;
  }

  // ---------- registry ----------

  register(entity, parent = null) {
    if (!this.selectables.includes(entity)) {
      this.selectables.push(entity);
      if (parent && this.selectables.includes(parent)) {
        entity.setParent(parent, this.engine);
      }
      this._renderHierarchy();
    }
    return entity;
  }

  /** Called every frame the gizmo is being dragged; apply sensitivity + snapping. */
  _onGizmoObjectChange() {
    const primary = this._primarySelection();
    if (!primary) return;
    const o = primary.object3D;

    if (this.selectedSet.size > 1) {
      if (!this._gizmoBaseMulti) return;
      const base = this._gizmoBaseMulti.get(primary);
      if (!base) return;
      this._applySensitivityFromBase(o, base);
      this._applySnap(o);
      this._syncMultiToPrimary(primary);
    } else {
      if (!this._gizmoBase) return;
      this._applySensitivityFromBase(o, this._gizmoBase);
      this._applySnap(o);
    }

    this._helper.setFromObject(o);
    this._syncInspector();
    this._updateSolidHelper(primary);
  }

  _applySensitivityFromBase(o, base) {
    const s = this.gizmoSensitivity;
    if (this._gizmoMode === 'translate') {
      o.position.x = base.position.x + (o.position.x - base.position.x) * s;
      o.position.y = base.position.y + (o.position.y - base.position.y) * s;
      o.position.z = base.position.z + (o.position.z - base.position.z) * s;
    } else if (this._gizmoMode === 'rotate') {
      o.rotation.x = base.rotation.x + (o.rotation.x - base.rotation.x) * s;
      o.rotation.y = base.rotation.y + (o.rotation.y - base.rotation.y) * s;
      o.rotation.z = base.rotation.z + (o.rotation.z - base.rotation.z) * s;
    } else if (this._gizmoMode === 'scale') {
      const dx = o.scale.x - base.scale.x;
      const dy = o.scale.y - base.scale.y;
      const dz = o.scale.z - base.scale.z;
      // keep scale positive: add scaled delta to base, clamp near zero. The floor
      // follows the object's own size — a fixed 0.01 made a model in
      // millimetres (scale 0.001) jump ten times bigger at the first touch.
      const floor = (b) => Math.min(0.01, Math.abs(b) / 10) || 0.01;
      o.scale.x = Math.max(floor(base.scale.x), base.scale.x + dx * s);
      o.scale.y = Math.max(floor(base.scale.y), base.scale.y + dy * s);
      o.scale.z = Math.max(floor(base.scale.z), base.scale.z + dz * s);
    }
  }

  unregister(entity) {
    const i = this.selectables.indexOf(entity);
    if (i !== -1) this.selectables.splice(i, 1);
    if (this.selected === entity) this.select(null);
    // reparent children to scene root
    for (const child of [...entity.children]) {
      child.setParent(null, this.engine);
    }
    if (entity.parent) {
      const idx = entity.parent.children.indexOf(entity);
      if (idx !== -1) entity.parent.children.splice(idx, 1);
      entity.parent = null;
    }
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

  // ---------- per-frame ----------

  update(_dt) {
    const { input, camera } = this.engine;
    // models set to play their default clip while editing (breathing, idling)
    if (!this.engine.playing) this._previewDefaultClips();
    // Held in view → Aiming: the first-person preview shows the held object at its aiming place
    const rig = this.engine.cameraRig;
    if (rig) rig.previewAim = !this.engine.playing && this._vmPose === 'aim' && !!this.selected?.viewModel;

    // Select on a TAP — press and release without dragging. Left-drag orbits the
    // camera, so selecting on press would reselect (or deselect) whatever every
    // orbit happened to start on. The hand tool owns the left button entirely.
    const handPanning = this.engine.cameraRig?.isHandActive?.() === true;
    const tapped = input.mouseTapped(0) && !this._suppressNextTap;
    if (input.mouseReleased(0)) this._suppressNextTap = false;
    if (tapped && !this.gizmo.dragging && !handPanning) {
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
          // the part clicked is the one the Color & Texture panel shows
          if (Number.isInteger(hit.object.userData?.part)) this._choosePart(entity, hit.object.userData.part);
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

    this._refreshSolidHelpers();
    this._renderStatus();
  }

  deleteSelected() {
    const targets = this.selectedSet.size > 0 ? [...this.selectedSet] : (this.selected ? [this.selected] : []);
    if (!targets.length) return;
    this.select(null);
    // deleting takes the children too; undo brings back the whole family,
    // with every component, rule and sound (see _captureTree)
    let saved = this._captureTree(targets);
    this.history?.push({
      label: targets.length > 1 ? 'delete multi' : 'delete',
      undo: () => {
        this._restoreTree(saved);
        this.select(targets[0]);
      },
      redo: () => {
        saved = this._captureTree(targets);
        this._removeTree(saved);
      },
    });
    this._removeTree(saved);
  }

  /**
   * Remove one entity from the scene and the hierarchy. `record: false` skips
   * undo — for wiping a whole scene. ("New scene" called this before it
   * existed, so the New button threw on any scene with an object in it.)
   */
  removeEntity(entity, { record = true } = {}) {
    if (!entity) return;
    if (record) {
      this.select(entity);
      this.deleteSelected();
      return;
    }
    if (this.selected === entity || this.selectedSet.has(entity)) this.select(null);
    this._cleanupEntityMedia(entity);
    if (typeof entity.destroy === 'function') entity.destroy(this.engine);
    else this.engine.remove(entity);
    this.unregister(entity);
  }

  /**
   * Where prefabs were kept before they belonged to the project (see the
   * migration in game.js). The prefab methods are in ./editor/prefabs.js.
   */
  static LEGACY_PREFAB_KEY = 'tiny3.prefabs';

  setSnap(type, value) {
    this.snap[type] = value;
    this._renderStatus();
  }

  setGizmoSensitivity(value) {
    this.gizmoSensitivity = Math.max(0.05, Math.min(1, parseFloat(value) || 0.25));
    this._renderStatus();
  }

  /** Stop + drop any animation mixer / positional audio / behavior bound to an entity. */
  _cleanupEntityMedia(entity) {
    const mi = this.engine.mixers.findIndex((m) => m.root === entity.object3D);
    if (mi !== -1) {
      this.engine.mixers[mi].mixer.stopAllAction();
      this.engine.mixers.splice(mi, 1);
    }
    this._clearSound(entity);
    this._clearSolidHelper(entity);
    this.engine.removeBehavior(entity);
  }

  /**
   * Show/hide a red wireframe box round what blocks the player as a box: a
   * still (static or kinematic) body that isn't a trigger. Not for a mesh
   * body — the model itself is its shape, and a box round it would say the
   * whole of it is solid (a court's open doorway, a room's inside).
   * Reuses the existing helper — this used to allocate a fresh BoxHelper (and
   * start a fresh rAF loop) on every frame of a gizmo drag, disposing none of them.
   */
  _updateSolidHelper(entity) {
    if (!entity) return;
    const body = entity.rigidBody;
    const box = !!body && !body.isTrigger && body.type !== 'dynamic' && body.shape !== 'mesh';
    if (!box) { this._clearSolidHelper(entity); return; }
    const existing = entity.object3D.userData.__solidHelper;
    if (existing) { existing.update(); return; }
    const helper = new THREE.BoxHelper(entity.object3D, 0xff3333);
    helper.name = '__solidHelper';
    entity.object3D.userData.__solidHelper = helper;
    this.engine.scene.add(helper);
    helper.update();
  }

  /** Refresh every live solid outline (called once per frame from update()). */
  _refreshSolidHelpers() {
    for (const e of this.selectables) {
      const helper = e.object3D.userData.__solidHelper;
      if (helper) helper.update();
    }
  }

  _clearSolidHelper(entity) {
    const helper = entity?.object3D?.userData?.__solidHelper;
    if (!helper) return;
    helper.parent?.remove(helper);
    helper.geometry?.dispose();
    helper.material?.dispose();
    delete entity.object3D.userData.__solidHelper;
  }

  _escapeHtml(str) { return escapeHtml(str); }

  _renderStatus() {
    if (!this.statusEl) return;
    const cam = this.engine.cameraRig ? this.engine.cameraRig.mode : 'orbit';
    const count = this.selectedSet.size;
    const sel = count > 1 ? ` · selected: <b>${count} objects</b>`
      : this.selected ? ` · selected: <b>${escapeHtml(this._name(this.selected))}</b>`
      : '';
    const snap = [];
    if (this.snap.translate > 0) snap.push(`grid ${this.snap.translate}`);
    if (this.snap.rotate > 0) snap.push(`angle ${this.snap.rotate}°`);
    if (this.snap.scale > 0) snap.push(`scale ${this.snap.scale}`);
    const sensText = this.gizmoSensitivity !== 1 ? ` · sens ${this.gizmoSensitivity}` : '';
    const snapText = snap.length ? ` · snap: ${snap.join(', ')}` : '';
    const html = `${this.statusPrefix}${cam} cam · ${this._gizmoMode} gizmo${sel}${sensText}${snapText}`;
    // called every frame: only touch the page when it says something new
    if (html !== this._statusHtml) {
      this._statusHtml = html;
      this.statusEl.innerHTML = html;
    }
  }
}

// Each panel and job lives in its own file under ./editor/; their methods are
// the editor's own, so `editor.select()` and `editor.applyToPrefab()` read alike.
Object.assign(ObjectEditor.prototype,
  undoMethods,
  clipboardMethods,
  prefabMethods,
  hierarchyMethods,
  inspectorMethods,
  physicsSectionMethods,
  scriptSectionMethods,
  animationSectionMethods,
  audioSectionMethods,
  lightingMethods,
  viewSectionMethods,
  generatorSectionMethods,
);
