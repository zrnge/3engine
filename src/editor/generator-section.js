import * as THREE from 'three';
import { escapeHtml } from '../ui.js';
import { GENERATORS, generatorOf, regenerate } from '../generators/generated.js';
import { RigidBody } from '../physics.js';
import { brushPanelHtml, wireBrushPanel } from './terrain-brush.js';

/**
 * The Inspector's section for an object made from settings — a terrain, a
 * building: its generator's fields, grouped (Land, Water, Colours · Size,
 * Door, Windows, Roof…). Sliders remake it live as they move; letting go is
 * one undo step, and its physics are measured again.
 */
export const generatorSectionMethods = {
  _generatorSection(entity) {
    const gen = generatorOf(entity.object3D);
    const def = gen && GENERATORS[gen.type];
    if (!def) return '';
    const p = gen.params;
    const rows = def.fields.map((fd) => {
      if (fd.group) return `<div class="gen-group">${escapeHtml(fd.group)}</div>`;
      const id = `gen-${fd.key}`;
      const tip = fd.hint ? ` title="${escapeHtml(fd.hint)}"` : '';
      const v = p[fd.key];
      let input;
      if (fd.type === 'select') {
        input = `<select id="${id}" data-gen="${fd.key}">${fd.options.map((o) => `<option value="${o}" ${String(o) === String(v) ? 'selected' : ''}>${
          escapeHtml(fd.labels?.[o] ?? String(o))}</option>`).join('')}</select>`;
      } else if (fd.type === 'boolean') {
        return `<label class="check-row"${tip}><input type="checkbox" id="${id}" data-gen="${fd.key}" ${v ? 'checked' : ''}/> ${escapeHtml(fd.label)}</label>`;
      } else if (fd.type === 'color') {
        input = `<input type="color" id="${id}" data-gen="${fd.key}" value="${v}" />`;
      } else if (fd.type === 'number') {
        input = `<input type="number" id="${id}" data-gen="${fd.key}" min="${fd.min}" max="${fd.max}" step="${fd.step}" value="${v}" />`
          + (fd.dice ? `<button class="tbtn gen-dice" data-gen-dice="${fd.key}" title="Pick another">🎲</button>` : '');
      } else {
        input = `<input type="range" id="${id}" data-gen="${fd.key}" min="${fd.min}" max="${fd.max}" step="${fd.step}" value="${v}" />
          <span class="val">${+Number(v).toFixed(2)}</span>`;
      }
      return `<div class="prop-row"><label${tip}>${escapeHtml(fd.label)}</label>${input}</div>`;
    }).join('');
    return `<div class="gen-section">
      <h4 class="insp-h" title="Made from these settings — change them and it is made again">${def.icon} ${escapeHtml(def.label)}</h4>
      ${gen.type === 'terrain' ? brushPanelHtml(this) : ''}
      ${rows}</div>`;
  },

  _wireGeneratorSection(entity) {
    const o = entity.object3D;
    const gen = generatorOf(o);
    const def = gen && GENERATORS[gen.type];
    if (!def) return;
    if (gen.type === 'terrain') wireBrushPanel(this, this.inspectorEl);
    const read = (el) => {
      const fd = def.fields.find((x) => x.key === el.dataset.gen);
      if (fd.type === 'boolean') return el.checked;
      if (fd.type === 'color' || (fd.type === 'select' && typeof fd.options[0] === 'string')) return el.value;
      return Number(el.value);
    };
    // its settings as they are now (before a slider moved): what undo goes back to
    let before = { ...gen.params };
    const remake = (params) => regenerate(o, params);
    const commit = (after, label) => {
      const was = before;
      const now = { ...generatorOf(o).params, ...after };
      const apply = (v) => {
        remake(v);
        // a scatter's trees made solid (or not): its collider comes, or goes
        if (def.wantsBody) {
          const want = def.wantsBody(generatorOf(o).params);
          if (want && !entity.rigidBody) entity.rigidBody = new RigidBody({ type: 'static', shape: 'mesh' });
          else if (!want && entity.rigidBody) { this.engine.physics.unregister(entity); entity.rigidBody = null; }
        }
        if (entity.rigidBody) {
          this.engine.physics.unregister(entity);
          this.engine.physics.register(entity);
        }
        this._updateSolidHelper?.(entity);
      };
      apply(now);
      before = { ...generatorOf(o).params };
      this._recordValue(entity, 'generator', was, before, apply, label);
      this._renderInspector();
      // grown round the camera (a mountain under it, a bigger house): stand back to see it
      const cam = this.engine.camera?.position;
      if (cam && new THREE.Box3().setFromObject(o).expandByScalar(0.5).containsPoint(cam)) this.onFrameObject?.(entity);
    };
    let frame = 0;
    for (const el of this.inspectorEl?.querySelectorAll('[data-gen]') || []) {
      const key = el.dataset.gen;
      // dragging: made again as it moves (at most once a frame), its body measured when let go
      el.addEventListener('input', () => {
        if (el.type !== 'range' && el.type !== 'color') return;
        const val = el.parentElement.querySelector('.val');
        if (val) val.textContent = String(+Number(el.value).toFixed(2));
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => remake({ ...generatorOf(o).params, [key]: read(el) }));
      });
      el.addEventListener('change', () => {
        let next = { ...before, [key]: read(el) };
        if (def.onChange) next = def.onChange(next, key);
        commit(next, `${def.label.toLowerCase()}: ${key}`);
      });
    }
    for (const b of this.inspectorEl?.querySelectorAll('[data-gen-dice]') || []) {
      b.addEventListener('click', () => commit({ ...before, [b.dataset.genDice]: 1 + Math.floor(Math.random() * 9999) }, `${def.label.toLowerCase()}: another`));
    }
  },
};
