import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Entity } from './entity.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

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
    this._raycaster = new THREE.Raycaster();
    this._gizmoMode = 'translate';
    this.statusPrefix = ''; // e.g. '▶ PLAYING · ' while in play mode
    this._texLoader = new THREE.TextureLoader();
    this._audioLoader = new THREE.AudioLoader();
    this._dragStart = null; // transform snapshot for undoing gizmo drags

    // --- transform gizmo ---
    this.gizmo = new TransformControls(engine.camera, engine.renderer.domElement);
    engine.scene.add(this.gizmo);
    this.gizmo.addEventListener('objectChange', () => this._syncInspector());
    // don't let the orbit camera fight the gizmo while dragging its handles
    this.gizmo.addEventListener('dragging-changed', (e) => {
      if (engine.cameraRig) engine.cameraRig.enabled = !e.value;
      if (e.value) this._dragStart = this._snapshot();       // drag began
      else this._recordTransform();                          // drag ended
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

  select(entity) {
    this.selected = entity;
    this._clearLightHelper();
    if (entity) {
      this.gizmo.attach(entity.object3D);
      if (entity.object3D.isLight) {
        this._helper.visible = false;
        this._makeLightHelper(entity.object3D);
      } else {
        this._helper.visible = true;
        this._helper.setFromObject(entity.object3D);
      }
    } else {
      this.gizmo.detach();
      this._helper.visible = false;
    }
    this._renderHierarchy();
    this._renderInspector();
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

  _applySnapshot(o, snap) {
    o.position.copy(snap.position);
    o.rotation.copy(snap.rotation);
    o.scale.copy(snap.scale);
    this._helper.setFromObject(o);
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
        if (entity && entity !== this.selected) this.select(entity);
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
    const entity = this.selected;
    if (!entity) return;
    this.select(null);
    this._cleanupEntityMedia(entity);
    if (typeof entity.destroy === 'function') entity.destroy(this.engine);
    else this.engine.remove(entity);
    this.unregister(entity);
    this._recordAddRemove(entity, false); // undoable delete
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
      if (entity === this.selected) li.classList.add('selected');
      const kind = entity.object3D.userData.kind || entity.constructor.name;
      li.innerHTML = `<span class="ico">${this._icon(kind)}</span><span class="nm">${this._name(entity)}</span>`;
      li.addEventListener('click', () => this.select(entity));
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

    // name
    this.inspectorEl.querySelector('#insp-name').addEventListener('input', (e) => {
      o.name = e.target.value;
      this._renderHierarchy();
    });

    // numeric vectors
    const vecs = [
      ['pos', o.position, 1],
      ['rot', o.rotation, RAD],
    ];
    if (!isLight) vecs.push(['scl', o.scale, 1]);
    for (const [key, target, conv] of vecs) {
      for (const axis of ['x', 'y', 'z']) {
        const field = this.inspectorEl.querySelector(`#insp-${key}-${axis}`);
        field.addEventListener('input', () => {
          const v = parseFloat(field.value);
          if (Number.isFinite(v)) {
            target[axis] = v * conv;
            this._helper.setFromObject(o);
            this.gizmo.updateMatrixWorld?.();
          }
        });
      }
    }

    const solidCheck = this.inspectorEl.querySelector('#insp-solid');
    if (solidCheck) {
      solidCheck.addEventListener('change', () => {
        sel.solid = solidCheck.checked;
        this._updateSolidHelper(sel);
      });
    }
    this._updateSolidHelper(sel);

    if (isLight) this._wireLightSection(o);
    if (mesh) this._wireMaterialSection(mesh);
    this._wireAnimationSection(sel);
    this._wireAudioSection(sel);

    this.inspectorEl.querySelector('#insp-del').addEventListener('click', () => this.deleteSelected());
    this.inspectorEl.querySelector('#insp-dup').addEventListener('click', () => {
      const clone = o.clone(true);
      clone.position.x += 1.5;
      clone.name = (o.name || 'Object') + ' copy';
      const entity = new Entity(clone);
      entity.solid = sel.solid;
      entity.object3D.userData.kind = o.userData.kind;
      this.engine.add(entity);
      this.register(entity);
      this._recordAddRemove(entity, true); // undoable duplicate
      this.select(entity);
    });
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
    this.inspectorEl.querySelector('#insp-lcolor').addEventListener('input', (e) => {
      light.color.set(e.target.value);
    });
    const slider = this.inspectorEl.querySelector('#insp-lintensity');
    slider.addEventListener('input', () => {
      light.intensity = parseFloat(slider.value);
      this.inspectorEl.querySelector('#insp-lintensity-v').textContent = light.intensity.toFixed(2);
    });
    const shadow = this.inspectorEl.querySelector('#insp-shadow');
    if (shadow) shadow.addEventListener('change', () => { light.castShadow = shadow.checked; });
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

    q('#insp-mcolor').addEventListener('input', (e) => m.color.set(e.target.value));

    const slider = (id, prop, apply) => {
      const el = q(`#insp-${id}`);
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        apply(v);
        q(`#insp-${id}-v`).textContent = v.toFixed(2);
      });
    };
    slider('metal', 'metalness', (v) => { m.metalness = v; });
    slider('rough', 'roughness', (v) => { m.roughness = v; });
    slider('opacity', 'opacity', (v) => {
      m.opacity = v;
      m.transparent = v < 1;
      m.needsUpdate = true;
    });

    q('#insp-wire').addEventListener('change', (e) => { m.wireframe = e.target.checked; });

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
          if (m.map) m.map.dispose();
          m.map = tex;
          m.needsUpdate = true;
          URL.revokeObjectURL(url);
          q('#insp-texname').textContent = file.name;
          q('#insp-tex-clear').disabled = false;
        });
      });
      picker.click();
    });

    q('#insp-tex-clear').addEventListener('click', () => {
      if (m.map) { m.map.dispose(); m.map = null; m.needsUpdate = true; }
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
      q(`#insp-aud-name-${i}`).addEventListener('input', (e) => { r.name = e.target.value; });

      // type
      q(`#insp-aud-type-${i}`).addEventListener('change', (e) => {
        this._changeSoundType(r, e.target.value);
        this._renderInspector();
      });

      // trigger
      q(`#insp-aud-trig-${i}`).addEventListener('change', (e) => { r.trigger = e.target.value || null; });

      // play/stop
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
      vol.addEventListener('input', () => {
        r.volume = parseFloat(vol.value);
        r.audio.setVolume(r.volume);
        q(`#insp-aud-vol-v-${i}`).textContent = r.volume.toFixed(2);
      });

      // distance
      const dist = q(`#insp-aud-dist-${i}`);
      dist.addEventListener('input', () => {
        r.refDistance = parseInt(dist.value, 10);
        if (r.type === 'positional') r.audio.setRefDistance(r.refDistance);
        q(`#insp-aud-dist-v-${i}`).textContent = String(r.refDistance);
      });

      // loop
      q(`#insp-aud-loop-${i}`).addEventListener('change', (e) => {
        r.loop = e.target.checked;
        r.audio.setLoop(r.loop);
      });

      // autoplay
      q(`#insp-aud-auto-${i}`).addEventListener('change', (e) => {
        r.autoplay = e.target.checked;
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
    const sel = this.selected ? ` · selected: <b>${this._name(this.selected)}</b>` : '';
    this.statusEl.innerHTML = `${this.statusPrefix}${cam} cam · ${this._gizmoMode} gizmo${sel}`;
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
