import { soundSettings } from '../sound.js';
import { assetIdsIn } from '../asset-refs.js';

/**
 * Undo/redo: transform snapshots and the small "record this change" helpers
 * every panel uses. Each pushes one step onto `this.history`.
 *
 * Mixed into ObjectEditor.prototype (see ../editor.js), so `this` is the editor.
 */
export const undoMethods = {
  /** Snapshot the selected object's transform (position/rotation/scale). */
  _snapshot() {
    const o = this.selected?.object3D;
    if (!o) return null;
    return {
      position: o.position.clone(),
      rotation: o.rotation.clone(),
      scale: o.scale.clone(),
    };
  },

  _snapshotMulti() {
    const map = new Map();
    for (const e of this.selectedSet) {
      const o = e.object3D;
      map.set(e, { position: o.position.clone(), rotation: o.rotation.clone(), scale: o.scale.clone() });
    }
    return map;
  },

  _applySnapshot(o, snap) {
    o.position.copy(snap.position);
    o.rotation.copy(snap.rotation);
    o.scale.copy(snap.scale);
    this._helper.setFromObject(o);
    this._syncInspector();
    this._updateSolidHelper(this.selected);
  },

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
  },

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
  },

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
  },

  /** Record an add/remove so it can be undone/redone. */
  recordAdd(entity) { this._recordAddRemove(entity, true); },

  recordRemove(entity) { this._recordAddRemove(entity, false); },

  /** Record an add/remove so it can be undone/redone. */
  _recordAddRemove(entity, added) {
    if (!this.history) return;
    // captured when it is taken away, so undo brings back what was really there
    let saved = null;
    const add = () => {
      if (saved) this._restoreTree(saved);
      else {
        this.engine.add(entity);
        this.register(entity);
        if (entity.behavior) this.engine.addBehavior(entity, entity.behavior);
      }
    };
    const remove = () => {
      saved = this._captureTree([entity]);
      this._removeTree(saved);
    };
    this.history.push({
      label: added ? 'add' : 'delete',
      undo: added ? remove : add,
      redo: added ? add : remove,
    });
  },

  /**
   * Everything deleting takes away, for the objects given and all their
   * children: each one's parent, components, rules and sounds. Parents come
   * before their children, so restoring in order rebuilds the family.
   *
   * (Undo used to bring back a deleted object bare — no components, rules or
   * sounds — and a deleted car came back without its wheels.)
   */
  _captureTree(entities) {
    const picked = new Set(entities);
    const hasPickedAncestor = (e) => {
      for (let p = e.parent; p; p = p.parent) if (picked.has(p)) return true;
      return false;
    };
    const gameplay = this.engine.gameplay;
    const list = [];
    const visit = (e) => {
      list.push({
        entity: e,
        parent: e.parent,
        components: gameplay?.components.serializeFor(e) ?? null,
        rules: gameplay?.rules.serializeFor(e) ?? null,
        sounds: (this.engine.sounds || []).filter((s) => s.entity === e).map(soundSettings),
      });
      for (const child of [...e.children]) visit(child);
    };
    for (const e of entities) if (!hasPickedAncestor(e)) visit(e);
    return list;
  },

  /** Take a captured family out of the scene, children first. */
  _removeTree(list) {
    // Undo can bring these back, so a cleanup must not delete their files
    // (see assetIdsInUse). Kept for the session; spares a little extra at worst.
    this._graveyard ??= new Set();
    for (const rec of list) this._graveyard.add(rec);
    for (const { entity } of [...list].reverse()) {
      if (this.selected === entity || this.selectedSet.has(entity)) this.select(null);
      this._cleanupEntityMedia(entity);
      if (typeof entity.destroy === 'function') entity.destroy(this.engine);
      else this.engine.remove(entity);
      this.unregister(entity);
    }
  },

  /** Put a captured family back exactly as it was, parents first. */
  _restoreTree(list) {
    const gameplay = this.engine.gameplay;
    for (const rec of list) {
      const e = rec.entity;
      this._graveyard?.delete(rec);
      e.alive = true; // or controls and rules would treat it as destroyed
      this.engine.add(e);
      // each one was left where it stood in the world; rejoining keeps that
      this.register(e, rec.parent && this.selectables.includes(rec.parent) ? rec.parent : null);
      if (e.behavior) this.engine.addBehavior(e, e.behavior);
      if (gameplay) {
        gameplay.components.clearEntity(e);
        for (const c of rec.components || []) gameplay.components.add(e, c.type, c.props);
        if (rec.rules?.length) gameplay.rules.setFor(e, JSON.parse(JSON.stringify(rec.rules)));
      }
      for (const s of rec.sounds) {
        this.engine.audio?.addFromSettings(e, s)
          .catch((err) => console.warn('[Tiny3] could not restore sound:', s.name, err));
      }
      this._updateSolidHelper(e);
    }
    this._renderHierarchy();
  },

  /**
   * Stored files the editor itself still holds on to, beyond the open game:
   * what Undo could bring back, and what is on the clipboards.
   */
  assetIdsInUse() {
    const held = [this._clipboard ? JSON.parse(this._clipboard) : null, this._propsClipboard];
    for (const rec of this._graveyard || []) {
      held.push(this.serializer?.entityRecord(rec.entity) ?? null, rec.sounds);
    }
    return assetIdsIn(held);
  },

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
  },

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
  },

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
  },

  /** A material's texture state: the map, the colour, and the colour it replaced. */
  _textureSnapshot(m) {
    return { map: m.map || null, color: m.color.getHex(), baseColor: m.userData.baseColor };
  },

  /**
   * Record a texture load/clear. The colour is part of the command because
   * adding a texture whitens the colour and clearing it restores the original,
   * so undo has to put both back together. (Textures are not disposed here:
   * the history may still bring them back.)
   */
  _recordMap(mesh, before, after, label = 'texture') {
    if (!this.history) return;
    const self = this;
    const m = mesh.material;
    const apply = (s) => {
      m.map = s.map;
      m.color.setHex(s.color);
      if (s.baseColor === undefined) delete m.userData.baseColor;
      else m.userData.baseColor = s.baseColor;
      m.needsUpdate = true;
      self._renderInspector?.();
    };
    this.history.push({ label, undo: () => apply(before), redo: () => apply(after) });
  },

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
  },

  /** Start the undo history afresh, optionally with one step in it. */
  _historyReset(step) {
    if (!this.history) return;
    this.history.clear();
    if (step) this.history.push(step);
  },
};
