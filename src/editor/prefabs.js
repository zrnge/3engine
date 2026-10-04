import { escapeHtml } from '../ui.js';
import { PREFAB_PARTS, PART_NAMES, overridesOf, mergeFromPrefab, canonical } from '../prefabs.js';

/**
 * Live prefabs in the editor: save, place, apply to all copies, revert, unlink,
 * and the Inspector's Prefab box. The linking rules themselves are in ../prefabs.js.
 *
 * The library is the project's (engine.prefabs); building and saving go
 * through the scene serializer, which the host wires in as `this.serializer`,
 * so the editor and an exported game build a prefab the same way.
 *
 * Mixed into ObjectEditor.prototype (see ../editor.js), so `this` is the editor.
 */
export const prefabMethods = {
  listPrefabs() { return this.engine.prefabs.names(); },

  /**
   * Save an object (default: the selection) as a new prefab and link it, so it
   * becomes the first copy. Returns the name used — made unique if taken — or
   * null for something that can't be a prefab (the player).
   */
  saveAsPrefab(name, entity = this._primarySelection()) {
    if (!entity || !this.serializer) return null;
    const rec = this.serializer.prefabRecord(entity);
    if (!rec) return null;
    const lib = this.engine.prefabs;
    const finalName = lib.uniqueName(String(name || '').trim() || entity.object3D.name || 'Prefab');
    entity.prefab = finalName; // linked first, so the list's copy count includes it
    // everything under it is part of the prefab now: every copy has them
    const mark = (e) => { for (const c of e.children) { c.prefabChild = true; mark(c); } };
    mark(entity);
    lib.set(finalName, rec);
    if (this.selected === entity) this._renderInspector();
    return finalName;
  },

  /**
   * Delete a prefab. Its copies — in every level — stay, as ordinary objects.
   */
  deletePrefab(name) {
    const lib = this.engine.prefabs;
    const before = lib.get(name);
    if (!before) return false;
    lib.delete(name);
    for (const e of this.selectables) if (e.prefab === name) delete e.prefab;
    this.project?.updatePrefabCopies(name, before, null);
    this._renderInspector();
    return true;
  },

  /** Place a copy of a prefab in the scene (undoable) and select it. */
  async instantiatePrefab(name) {
    try {
      const entity = await this.serializer?.placePrefab(name);
      if (!entity) return null;
      this._recordAddRemove(entity, true);
      this.select(entity);
      return entity;
    } catch (err) {
      console.warn('[Tiny3] failed to place prefab', name, err);
      return null;
    }
  },

  /**
   * Spawn a prefab during gameplay, where there is no frame to await in.
   * Primitives, coins and lights come back at once; a model arrives at
   * `position` a moment later and this returns null ("not spawned yet").
   */
  instantiatePrefabSync(name, position = null) {
    return this.serializer?.spawnPrefab(name, position) ?? null;
  },

  /**
   * How a linked copy stands against its prefab:
   *   { name, missing, overrides: ['look', ...], copies }  — or null if not linked.
   */
  prefabStatus(entity) {
    const name = entity?.prefab;
    if (!name || !this.serializer) return null;
    const rec = this.engine.prefabs.get(name);
    if (!rec) return { name, missing: true, overrides: [], copies: 0 };
    const d = this.serializer.entityRecord(entity);
    const copies = this.selectables.filter((e) => e.prefab === name).length
      + (this.project?.savedCopies(name) ?? 0);
    return { name, missing: false, overrides: d ? overridesOf(d, rec) : [], copies };
  },

  /**
   * Make the prefab match this copy — every part, or only `parts` — and bring
   * every other copy, in every level, up to date. One undo step.
   */
  async applyToPrefab(entity, parts = null) {
    const name = entity?.prefab;
    const before = name ? this.engine.prefabs.get(name) : null;
    const mine = before ? this.serializer.prefabRecord(entity) : null;
    if (!mine) return 0;
    // the prefab keeps its own placing height and facing
    const keep = parts ? PART_NAMES.filter((p) => !parts.includes(p)) : [];
    const after = mergeFromPrefab(before, mine, keep);
    // its child objects go into the prefab: they are the prefab's from now on
    // (or this copy would be rebuilt with a second set of the ones added to it)
    if (!keep.includes('children')) {
      const mark = (e) => { for (const c of e.children) { c.prefabChild = true; mark(c); } };
      mark(entity);
    }
    const n = await this._setPrefab(name, before, after);
    this._historyReset({
      label: 'apply to prefab',
      undo: () => this._setPrefab(name, after, before),
      redo: () => this._setPrefab(name, before, after),
    });
    return n;
  },

  /** Throw away this copy's own changes — all, or only `parts` — and match the prefab again. */
  async revertToPrefab(entity, parts = null) {
    const status = this.prefabStatus(entity);
    if (!status || status.missing) return null;
    const keep = parts ? status.overrides.filter((p) => !parts.includes(p)) : [];
    const d = this.serializer.entityRecord(entity);
    const made = await this._replaceEntity(entity, mergeFromPrefab(d, this.engine.prefabs.get(status.name), keep));
    this._historyReset(null); // older steps point at the object that was replaced
    return made;
  },

  /** Cut the link: the copy stays as it is, an ordinary object from now on. */
  unlinkPrefab(entity) {
    const before = entity?.prefab;
    if (!before) return;
    delete entity.prefab;
    this._recordValue(entity, 'prefab', before, undefined, (v) => {
      if (v) entity.prefab = v;
      else delete entity.prefab;
    }, 'unlink prefab');
    this._renderInspector();
  },

  /**
   * The prefab changed from `before` to `after`: store it, update the saved
   * levels, and rebuild the copies in this level that differ from it now.
   */
  async _setPrefab(name, before, after) {
    this.engine.prefabs.set(name, after);
    let n = this.project?.updatePrefabCopies(name, before, after) ?? 0;
    for (const e of [...this.selectables]) {
      if (e.prefab !== name) continue;
      const d = this.serializer.entityRecord(e);
      if (!d) continue;
      const merged = mergeFromPrefab(d, after, overridesOf(d, before));
      if (canonical(merged) === canonical(d)) continue;
      await this._replaceEntity(e, merged);
      n++;
    }
    this._renderInspector();
    return n;
  },

  /**
   * Swap an object for one rebuilt from `d`, in the same place in the
   * hierarchy: same parent, still the player, still what the camera follows,
   * still selected. Its prefab's child objects are rebuilt from `d.children`;
   * children added to this copy alone stay.
   */
  async _replaceEntity(old, d) {
    const made = await this.serializer._buildEntity({ ...d, parent: -1, children: undefined });
    if (!made) return null;
    const index = this.selectables.indexOf(old);
    const parent = old.parent;
    const children = old.children.filter((c) => !c.prefabChild);
    const fromPrefab = old.children.filter((c) => c.prefabChild);
    const wasSelected = this.selected === old;
    const o = old.object3D;

    for (const c of fromPrefab) this._removeTree(this._captureTree([c])); // made again below
    for (const c of children) c.setParent(null, this.engine); // keep them when the old one goes
    this.engine.add(made);
    if (parent) {
      made.setParent(parent, this.engine);
      // d holds its place under the parent, not in the world
      made.object3D.position.copy(o.position);
      made.object3D.rotation.copy(o.rotation);
      if (d.scale) made.object3D.scale.set(...d.scale);
    }
    for (const c of children) c.setParent(made, this.engine);
    if (this.engine.player?.target === old) this.engine.player.target = made;
    const rig = this.engine.cameraRig;
    if (rig?.target === o) rig.setTarget(made.object3D);

    if (wasSelected) this.select(null);
    this._cleanupEntityMedia(old);
    if (typeof old.destroy === 'function') old.destroy(this.engine);
    else this.engine.remove(old);
    this.unregister(old);
    if (!this.selectables.includes(made)) {
      this.selectables.splice(index === -1 ? this.selectables.length : index, 0, made);
    }
    await this.serializer.addChildrenAsync(made, d.children);
    this._renderHierarchy();
    if (wasSelected) this.select(made);
    return made;
  },

  /** The Prefab box: which prefab this copy follows and what it has changed. */
  _prefabSectionHtml(sel) {
    const s = this.prefabStatus(sel);
    if (!s) {
      // one of a prefab's child objects: its changes are applied from the copy it belongs to
      let owner = sel?.prefabChild ? sel.parent : null;
      while (owner && !owner.prefab) owner = owner.prefabChild ? owner.parent : null;
      return owner ? `<div class="prefab-box"><div class="prefab-head">◆ Part of <b>${escapeHtml(owner.object3D.name)}</b>,
        a copy of <b>${escapeHtml(owner.prefab)}</b></div>
        <div class="prefab-note">Change it here, then select ${escapeHtml(owner.object3D.name)} and <b>Apply</b> to change every copy.</div></div>` : '';
    }
    const name = escapeHtml(s.name);
    if (s.missing) {
      return `<div class="prefab-box missing">
        <div class="prefab-head">◆ Its prefab <b>${name}</b> was deleted</div>
        <div class="insp-row"><button class="tbtn" data-prefab="unlink">Make it an ordinary object</button></div>
      </div>`;
    }
    const others = s.copies - 1;
    const rows = s.overrides.map((part) => `
      <li><span>${escapeHtml(PREFAB_PARTS[part].label)}</span>
        <button class="tbtn mini" data-prefab="apply" data-part="${part}" title="Give every copy this">Apply</button>
        <button class="tbtn mini" data-prefab="revert" data-part="${part}" title="Go back to the prefab's">Revert</button></li>`).join('');
    const changed = s.overrides.length > 0;
    return `<div class="prefab-box${changed ? ' changed' : ''}">
      <div class="prefab-head">◆ Copy of <b>${name}</b>
        <span class="prefab-count">${others > 0 ? `· ${others} other cop${others === 1 ? 'y' : 'ies'}` : '· the only copy'}</span></div>
      ${changed
        ? `<div class="prefab-note">Changed on this copy only:</div><ul class="prefab-parts">${rows}</ul>`
        : '<div class="prefab-note">Matches the prefab. Change this copy, then <b>Apply</b> to change them all.</div>'}
      <div class="insp-row">
        <button class="tbtn" data-prefab="apply" ${changed ? '' : 'disabled'} title="Make the prefab — and every copy — like this one">Apply to all</button>
        <button class="tbtn" data-prefab="revert" ${changed ? '' : 'disabled'} title="Undo this copy's own changes">Revert</button>
        <button class="tbtn" data-prefab="unlink" title="Keep this object but stop it following the prefab">Unlink</button>
      </div>
    </div>`;
  },

  _wirePrefabSection(sel) {
    const box = this._q('#insp-prefab');
    if (!box || box.dataset.wired) return;
    box.dataset.wired = '1'; // the box is redrawn in place; one listener serves every redraw
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-prefab]');
      const entity = this.selected;
      if (!btn || btn.disabled || !entity) return;
      const part = btn.dataset.part ? [btn.dataset.part] : null;
      btn.disabled = true;
      try {
        if (btn.dataset.prefab === 'apply') await this.applyToPrefab(entity, part);
        else if (btn.dataset.prefab === 'revert') await this.revertToPrefab(entity, part);
        else this.unlinkPrefab(entity);
      } finally {
        this.onPrefabsChanged?.();
      }
    });
  },

  /** Redraw just the Prefab box — after any edit, since an edit can make or clear an override. */
  refreshPrefabStatus() {
    const box = this._q('#insp-prefab');
    if (!box || !this.selected) return;
    const html = this._prefabSectionHtml(this.selected);
    if (box.innerHTML !== html) box.innerHTML = html;
  },
};
