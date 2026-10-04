import * as THREE from 'three';
import { materialPanelHtml, wireMaterialPanel } from '../materials-panel.js';
import { modelParts, partHandle } from '../model-parts.js';
import { firstMesh } from '../factories.js';
import { escapeHtml, showNotice } from '../ui.js';
import { componentsSection, wireComponentsSection, rulesSection, wireRulesSection } from '../inspector-gameplay.js';
import { showPivots } from '../pivot-markers.js';
import { showSenses } from '../sense-markers.js';
import { showPhysicsParts } from '../physics-parts.js';
import { DEG, RAD } from './shared.js';
import { groupsOf, normalizeGroups, allGroups } from '../groups.js';
import { RigidBody } from '../physics.js';
import { GENERATORS, generatorOf } from '../generators/generated.js';

/** The fields where rules, components and controls name an object (or who may set them off). */
const OBJECT_FIELDS = new Set(['target', 'object', 'who', 'hits', 'at', 'of', 'what', 'pivotObject']);

/**
 * Point every object-naming field under `value` that says `was` (lower case)
 * at `to` instead. Returns whether anything changed.
 */
export function renameIn(value, was, to) {
  if (!value || typeof value !== 'object') return false;
  let changed = false;
  for (const [key, v] of Object.entries(value)) {
    if (OBJECT_FIELDS.has(key) && typeof v === 'string' && v.trim().toLowerCase() === was) {
      value[key] = to;
      changed = true;
    } else if (v && typeof v === 'object' && renameIn(v, was, to)) {
      changed = true;
    }
  }
  return changed;
}

/** An imported model (not a shape the editor made). */
export const isModel = (entity) => !!(entity?.object3D?.userData.assetId || entity?.object3D?.userData.assetUrl);

/**
 * A number for a Shape field: 3 decimals with trailing zeros trimmed. A small
 * scale keeps its significant digits — a model in millimetres (0.0004) showed
 * as 0. (Only scale: a position of 1e-17 is float noise, and shows as 0.)
 */
export function fieldNumber(n, key = '') {
  if (key === 'scl' && n !== 0 && Math.abs(n) < 0.01) return String(Number(n.toPrecision(3)));
  return n.toFixed(3).replace(/\.?0+$/, '');
}

/**
 * The object panels: Inspector (name, parent, and each section in turn), Shape
 * (position / rotation / scale), Color & Texture and Audio.
 *
 * Mixed into ObjectEditor.prototype (see ../editor.js), so `this` is the editor.
 */
export const inspectorMethods = {
  /**
   * Render every object-editing panel for the current selection: Inspector
   * (identity, physics, components, rules, script, animation), Shape
   * (transform), Color & Texture, Audio, and the scene-wide Lighting list.
   */
  _renderInspector() {
    const sel = this.selected;
    showPivots(this, sel); // where its rules turn and scale it about, drawn in the view
    showSenses(this, sel); // how far and how wide it sees, what it notices and hears
    showPhysicsParts(this, sel); // its parts' own boxes and zones, and those left out
    this._renderShape(sel);
    this._renderMaterial(sel);
    this._renderAudio(sel);
    this._renderLighting();

    if (!this.inspectorEl) return;
    if (!sel) {
      this.inspectorEl.innerHTML = '<div class="empty">Select an object in the scene or hierarchy.</div>';
      return;
    }

    const o = sel.object3D;

    this.inspectorEl.innerHTML = `
      <div class="body">
        <input class="obj-name" id="insp-name" value="${escapeHtml(this._name(sel))}" spellcheck="false" />
        <div id="insp-prefab">${this._prefabSectionHtml(sel)}</div>
        <div class="prop-row"><label>Parent</label><select id="insp-parent">${this._parentOptions(sel)}</select></div>
        <div class="prop-row"><label title="Groups it belongs to, split by commas — what a shot can hit, who a Damager hurts and who sets off a rule can be a whole group">Groups</label>
          <input type="text" id="insp-groups" list="t3-group-names" spellcheck="false" placeholder="e.g. Enemies, Targets"
            value="${escapeHtml(groupsOf(sel).join(', '))}" /></div>
        <datalist id="t3-group-names">${allGroups(this.engine.entities).map((g) => `<option value="${escapeHtml(g)}"></option>`).join('')}</datalist>
        ${this._generatorSection(sel)}
        ${this._solidRowHtml(sel)}
        ${this._flattenRowHtml(sel)}
        ${this._physicsSection(sel)}
        ${componentsSection(this, sel)}
        ${rulesSection(this, sel)}
        ${this._behaviorSection(sel)}
        ${this._animationSection(sel)}
        ${this._viewSection(sel)}
        <div class="insp-row">
          <button class="tbtn" id="insp-dup">Duplicate</button>
          <button class="tbtn danger" id="insp-del">Delete</button>
        </div>
        <div class="insp-row" style="margin-top:6px">
          <button class="tbtn" id="insp-copy-props" title="Copy material/transform/light/etc properties">Copy props</button>
          <button class="tbtn" id="insp-paste-props" title="Paste copied properties onto selection">Paste props</button>
        </div>
      </div>`;

    // name: shown as you type; on change, what points at it by name follows (one undo step)
    const nameField = this._q('#insp-name');
    let nameBefore = o.name;
    nameField.addEventListener('focus', () => { nameBefore = o.name; });
    nameField.addEventListener('input', (e) => {
      o.name = e.target.value;
      this._renderHierarchy();
    });
    const commitName = () => {
      if (o.name === nameBefore) return;
      const from = nameBefore;
      const to = o.name;
      nameBefore = to;
      const refs = this._renameReferences(sel, from, to);
      const show = (name, step) => {
        o.name = name;
        step();
        this._renderHierarchy();
        this._renderInspector();
        this.onControlsChanged?.();
      };
      this.history?.push({ label: 'rename', undo: () => show(from, refs.undo), redo: () => show(to, refs.redo) });
      if (refs.count) {
        this.onControlsChanged?.();
        showNotice(`Renamed "${from}" to "${to}" — and ${refs.count} rule${refs.count === 1 ? '' : 's'}, `
          + 'control or component that pointed at it, so they still do.', { seconds: 6 });
      }
    };
    nameField.addEventListener('change', commitName);
    nameField.addEventListener('blur', commitName);

    // parent dropdown
    const parentSel = this._q('#insp-parent');
    if (parentSel) {
      let parentBefore = sel.parent;
      parentSel.addEventListener('change', () => {
        const idx = parseInt(parentSel.value, 10);
        const newParent = Number.isInteger(idx) ? this.selectables[idx] : null;
        if (!newParent || newParent === sel || this._isDescendant(sel, newParent)) return;
        this._setParentWithHistory(sel, newParent);
        parentBefore = newParent;
      });
    }

    // groups: "Enemies, Targets" — what shots, damagers and rules can pick as a whole
    const groupsField = this._q('#insp-groups');
    groupsField?.addEventListener('change', () => {
      const before = [...groupsOf(sel)];
      const after = normalizeGroups(groupsField.value);
      if (before.join('\n') === after.join('\n')) return;
      const apply = (v) => {
        if (v.length) sel.groups = [...v];
        else delete sel.groups;
        this._renderInspector();
      };
      this._recordValue(sel, 'groups', before, after, apply, 'change groups');
      apply(after);
    });

    // Solid: a static body — the object's real shape for a model — so the player
    // can stand on it and can't walk through it. (It used to only draw a red box;
    // nothing collided with it.)
    this._q('#insp-solid')?.addEventListener('change', (e) => {
      const before = sel.rigidBody ?? null;
      let after = before;
      if (e.target.checked) {
        after = before ?? new RigidBody({ shape: isModel(sel) ? 'mesh' : 'auto' });
        after.isTrigger = false;
      } else if (before?.type === 'static') {
        after = null; // not solid: nothing to bump into
      }
      const apply = (body) => {
        if (body) body.isTrigger = false;
        sel.rigidBody = body;
        if (body) this.engine.physics.register(sel);
        else this.engine.physics.unregister(sel);
        this._updateSolidHelper(sel);
        this._renderInspector();
      };
      this._recordValue(sel, 'rigidBody', before, after, apply, after ? 'make solid' : 'make not solid');
      apply(after);
    });
    this._updateSolidHelper(sel);

    // the ground kept out of it: a terrain under it levelled to its base
    this._q('#insp-flatten')?.addEventListener('change', (e) => {
      const before = !!sel.flattenGround;
      const after = e.target.checked;
      const apply = (v) => {
        if (v) sel.flattenGround = true;
        else delete sel.flattenGround;
      };
      this._recordValue(sel, 'flattenGround', before, after, apply, after ? 'flatten the ground under it' : 'leave the ground under it');
      apply(after);
    });

    this._wirePrefabSection(sel);
    this._wireGeneratorSection(sel);
    this._wirePhysicsSection(sel);
    wireComponentsSection(this, sel);
    wireRulesSection(this, sel);
    this._wireBehaviorSection(sel);
    this._wireAnimationSection(sel);
    this._wireViewSection(sel);

    this._q('#insp-del').addEventListener('click', () => this.deleteSelected());
    this._q('#insp-dup').addEventListener('click', () => this.duplicateSelection());
    this._q('#insp-copy-props').addEventListener('click', () => this.copyProperties());
    this._q('#insp-paste-props').addEventListener('click', () => this.pasteProperties());
  },

  /** Find an element in any of the editor's panels (ids are unique across them). */
  _q(selector) {
    for (const root of [this.inspectorEl, this.shapeEl, this.materialEl, this.audioEl, this.lightListEl]) {
      const el = root?.querySelector(selector);
      if (el) return el;
    }
    return null;
  },

  /** Shape panel: position / rotation / scale of the selection, typed in place. */
  _renderShape(sel) {
    if (!this.shapeEl) return;
    if (!sel) {
      this.shapeEl.innerHTML = '<div class="empty">Select an object to move, rotate or scale it.</div>';
      return;
    }
    const o = sel.object3D;
    const isLight = !!o.isLight;
    this.shapeEl.innerHTML = `
      ${this._vecRow('pos', 'Position', o.position)}
      ${this._vecRow('rot', 'Rotation°', { x: o.rotation.x * DEG, y: o.rotation.y * DEG, z: o.rotation.z * DEG })}
      ${isLight ? '' : this._vecRow('scl', 'Scale', o.scale)}`;

    // numeric vectors — record on change/blur per axis
    const vecs = [['pos', o.position, 1], ['rot', o.rotation, RAD]];
    if (!isLight) vecs.push(['scl', o.scale, 1]);
    for (const [key, target, conv] of vecs) {
      for (const axis of ['x', 'y', 'z']) {
        const field = this.shapeEl.querySelector(`#insp-${key}-${axis}`);
        let axisBefore = target[axis];
        field.addEventListener('focus', () => { axisBefore = target[axis]; });
        field.addEventListener('input', () => {
          const raw = field.value;
          if (raw === '' || raw === '-' || raw === '.') return; // allow partial typing
          const v = parseFloat(raw);
          if (Number.isFinite(v)) {
            target[axis] = v * conv;
            this._helper.setFromObject(o);
            this.gizmo.updateMatrixWorld?.();
          }
        });
        const commitAxis = () => {
          const after = target.clone();
          const before = target.clone();
          before[axis] = axisBefore;
          if (!before.equals(after)) this._recordVector(target, before, after, `${key}.${axis}`);
          axisBefore = target[axis];
        };
        field.addEventListener('change', commitAxis);
        field.addEventListener('blur', commitAxis);
      }
    }
  },

  /**
   * Color & Texture panel: the selection's surface — for a model with several
   * materials, the one part chosen in "Part" (or clicked in the view).
   */
  _renderMaterial(sel) {
    if (!this.materialEl) return;
    this.materialEl.onFiles = null; // what a drop on the panel does: set again below when there is a surface
    const gen = sel && generatorOf(sel.object3D);
    if (gen) { // made from settings: its colours are among them
      this.materialEl.innerHTML = `<div class="empty">Its colours are in its ${escapeHtml(GENERATORS[gen.type]?.label ?? '')} settings, in the Inspector.</div>`;
      return;
    }
    const parts = sel ? modelParts(sel.object3D) : [];
    if (!parts.length) {
      this.materialEl.innerHTML = sel
        ? '<div class="empty">This object has no surface to colour.</div>'
        : '<div class="empty">Select an object to change its colour or texture.</div>';
      return;
    }
    const chosen = parts.find((p) => p.index === this._partOf(sel)) ?? parts[0];
    const handle = partHandle(chosen);
    const picker = parts.length > 1 ? `
      <div class="prop-row"><label title="This model has several materials: pick the one to change — or click that part of the model in the view">Part</label>
        <select id="insp-part">${parts.map((p) => `<option value="${p.index}" ${p === chosen ? 'selected' : ''}>`
          + `${p.index + 1} · ${escapeHtml(p.name)}${p.meshes.length > 1 ? ` (${p.meshes.length} meshes)` : ''}</option>`).join('')}</select></div>` : '';
    this.materialEl.innerHTML = picker + this._materialSection(handle);
    this._wireMaterialSection(handle);
    this.materialEl.querySelector('#insp-part')?.addEventListener('change', (e) => {
      this._choosePart(sel, Number(e.target.value));
      this._renderMaterial(sel);
    });
  },

  /**
   * "Flatten the ground under it": shown once the level has a terrain — not on
   * a terrain itself, nor a light.
   */
  _flattenRowHtml(sel) {
    if (sel.object3D.isLight || generatorOf(sel.object3D)?.type === 'terrain') return '';
    if (!this.engine.entities.some((e) => generatorOf(e.object3D)?.type === 'terrain')) return '';
    return `<label class="check-row" title="A terrain under it is levelled to its base, and eases back round it: the ground stays out of a house, a camp, a road">
      <input type="checkbox" id="insp-flatten" ${sel.flattenGround ? 'checked' : ''}/> Flatten the ground under it</label>`;
  },

  /**
   * "Solid" — the plain way to say "has a body that blocks". Ticked means the
   * object has a body that isn't a trigger. One that moves by physics (dynamic,
   * kinematic) is always solid: set it in Physics.
   */
  _solidRowHtml(sel) {
    const body = sel.rigidBody;
    const solid = !!body && !body.isTrigger;
    const moving = !!body && body.type !== 'static';
    const title = moving
      ? 'It moves by physics, so it is always solid — see Physics below'
      : 'Blocks the player, who can also stand on it. A model collides as its real shape (its rooms, stairs, hills).';
    return `<label class="check-row" title="${title}"><input type="checkbox" id="insp-solid" ${solid ? 'checked' : ''} ${moving ? 'disabled' : ''}/> Solid (blocks player)</label>`;
  },

  /**
   * An object was renamed from `from` to `to`: rules, components, controls and
   * prefabs that point at it by name ("Destroy object: Door", a Follower's
   * target) are changed to the new name — they used to go quietly dead. Not if
   * another object still has the old name: they may mean that one.
   * Returns { count, undo, redo } for the rename's undo step.
   */
  _renameReferences(entity, from, to) {
    const none = { count: 0, undo() {}, redo() {} };
    const was = String(from ?? '').trim().toLowerCase();
    if (!was || !String(to ?? '').trim()) return none;
    if (this.selectables.some((e) => e !== entity && (e.object3D.name || '').trim().toLowerCase() === was)) return none;
    const gameplay = this.engine.gameplay;
    const steps = []; // { apply(before or after) }
    let count = 0;
    const clone = (v) => JSON.parse(JSON.stringify(v));

    for (const rec of gameplay?.rules.rules || []) {
      const before = clone(rec.rule);
      if (!renameIn(rec.rule, was, to)) continue;
      const after = clone(rec.rule);
      steps.push((side) => { rec.rule = clone(side ? after : before); });
      count++;
    }
    for (const c of gameplay?.components.instances || []) {
      const before = { ...c.props };
      if (!renameIn(c.props, was, to)) continue;
      const after = { ...c.props };
      steps.push((side) => { c.props = { ...(side ? after : before) }; });
      count++;
    }
    const controls = gameplay?.controls;
    if (controls) {
      const before = controls.toJSON();
      const list = controls.toJSON();
      const n = list.filter((control) => renameIn(control, was, to)).length;
      if (n) {
        controls.load(list);
        const after = controls.toJSON();
        steps.push((side) => controls.load(clone(side ? after : before)));
        count += n;
      }
    }
    // what a body passes through (Physics)
    for (const e of this.selectables) {
      const body = e.rigidBody;
      if (!Array.isArray(body?.ignores) || !body.ignores.some((s) => String(s).trim().toLowerCase() === was)) continue;
      const before = [...body.ignores];
      const after = body.ignores.map((s) => (String(s).trim().toLowerCase() === was ? to : s));
      body.ignores = after;
      steps.push((side) => { body.ignores = [...(side ? after : before)]; });
      count++;
    }
    const lib = this.engine.prefabs;
    for (const name of lib?.names() || []) {
      const before = lib.get(name);
      const after = lib.get(name);
      const n = [...(after.rules || []), ...(after.components || [])].filter((x) => renameIn(x, was, to)).length;
      if (!n) continue;
      lib.set(name, after);
      steps.push((side) => lib.set(name, side ? after : before));
      count += n;
    }
    return {
      count,
      undo: () => steps.forEach((step) => step(false)),
      redo: () => steps.forEach((step) => step(true)),
    };
  },

  /** Which part of a model the Color & Texture panel shows (0 until another is chosen). */
  _partOf(entity) { return this._parts?.get(entity) ?? 0; },

  /** Outline one node of a model in the view for a moment (the Physics section's parts). */
  _flashPartNode(node) {
    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) return;
    this._partFlash?.removeFromParent();
    const flash = new THREE.Box3Helper(box, 0x39c5cf);
    flash.name = '__partFlash';
    this.engine.scene.add(flash);
    this._partFlash = flash;
    setTimeout(() => {
      flash.removeFromParent();
      flash.geometry.dispose();
      flash.material.dispose();
    }, 900);
  },

  /** Show part `index` of a model in the panel, and outline it in the view for a moment. */
  _choosePart(entity, index) {
    (this._parts ??= new WeakMap()).set(entity, index);
    const part = modelParts(entity.object3D).find((p) => p.index === index);
    if (!part || modelParts(entity.object3D).length < 2) return;
    const box = new THREE.Box3();
    for (const mesh of part.meshes) box.expandByObject(mesh);
    this._partFlash?.removeFromParent();
    const flash = new THREE.Box3Helper(box, 0xf6a435);
    flash.name = '__partFlash';
    this.engine.scene.add(flash);
    this._partFlash = flash;
    setTimeout(() => {
      flash.removeFromParent();
      flash.geometry.dispose();
      flash.material.dispose();
    }, 900);
  },

  /** Audio panel, lower half: the sounds attached to the selection. */
  _renderAudio(sel) {
    if (!this.audioEl) return;
    if (!sel) {
      this.audioEl.innerHTML = '<div class="empty">Select an object to attach sounds to it.</div>';
      return;
    }
    this.audioEl.innerHTML = this._audioSection(sel);
    this._wireAudioSection(sel);
  },

  _vecRow(key, label, v) {
    const f = (n) => fieldNumber(n, key);
    return `
      <div class="vec-row">
        <label>${label}</label>
        <input id="insp-${key}-x" type="number" step="0.001" value="${f(v.x)}" />
        <input id="insp-${key}-y" type="number" step="0.001" value="${f(v.y)}" />
        <input id="insp-${key}-z" type="number" step="0.001" value="${f(v.z)}" />
      </div>`;
  },

  _parentOptions(sel) {
    let html = '<option value="">(none / scene root)</option>';
    for (let i = 0; i < this.selectables.length; i++) {
      const e = this.selectables[i];
      if (e === sel) continue;
      if (this._isDescendant(sel, e)) continue; // can't parent to own descendant
      const name = this._name(e) || `Object ${i}`;
      const selected = e === sel.parent ? ' selected' : '';
      html += `<option value="${i}"${selected}>${escapeHtml(name)}</option>`;
    }
    return html;
  },

  _firstMesh(root) { return firstMesh(root); },

  // The Color & Texture panel lives in materials-panel.js: every PBR texture
  // slot, placement, the texture maker and the material library.
  _materialSection(mesh) { return materialPanelHtml(this, mesh); },

  _wireMaterialSection(mesh) { wireMaterialPanel(this, mesh); },

  /** Refresh inspector numbers without rebuilding the DOM (used while dragging). */
  _syncInspector() {
    const sel = this.selected;
    if (!sel || this._typingInPanel()) return;
    const o = sel.object3D;
    const set = (key, axis, val) => {
      const el = this._q(`#insp-${key}-${axis}`);
      if (el) el.value = fieldNumber(val, key);
    };
    for (const a of ['x', 'y', 'z']) {
      set('pos', a, o.position[a]);
      set('rot', a, o.rotation[a] * DEG);
      set('scl', a, o.scale[a]);
    }
  },

  _typingInPanel() {
    const a = document.activeElement;
    if (!a || (a.tagName !== 'INPUT' && a.tagName !== 'TEXTAREA')) return false;
    // any text/number field in any editor panel counts
    return !!a.closest('.panel') && a.type !== 'range' && a.type !== 'checkbox' && a.type !== 'color';
  },
};
