import { CAMERA_SETTINGS, FOV_KEY } from './cameras.js';
import { escapeHtml } from './ui.js';

/**
 * The Camera panel's settings: a tab per camera — Orbit, Follow, First person,
 * Fly — each showing only what that camera uses. The rows are drawn from
 * CAMERA_SETTINGS, so a setting added there appears here, saves and undoes
 * with no work in this file.
 *
 * Sliders act live: in the view through that camera you see a change as you
 * drag. "View through this camera" switches the editor's view to it.
 */

const decimals = (step) => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
const show = (v, step) => Number(v).toFixed(decimals(step));

export function wireCameraPanel({ rig, history = null, tabsEl, bodyEl, onChange = () => {}, onPreview = () => {} }) {
  let tab = rig.playMode || rig.mode || 'orbit';
  let fields = [];

  /** Set one setting, keeping the view in step (a field of view shows at once). */
  const apply = (key, value) => {
    rig[key] = value;
    if (key === FOV_KEY[rig.mode]) rig.setFov(value);
  };

  function render() {
    if (!CAMERA_SETTINGS[tab]) tab = 'orbit';
    tabsEl.innerHTML = Object.entries(CAMERA_SETTINGS).map(([mode, def]) => `
      <button class="tbtn cam-tab${mode === tab ? ' active' : ''}" data-cam-tab="${mode}"
        title="${mode === rig.playMode ? 'The camera the game plays with' : `${def.label} settings`}">${
        escapeHtml(def.label)}${mode === rig.playMode ? ' ▶' : ''}</button>`).join('');
    const def = CAMERA_SETTINGS[tab];
    fields = def.fields;
    bodyEl.innerHTML = `<div class="cam-hint">${escapeHtml(def.hint)}</div>${fields.map((f) => (f.type === 'boolean'
      ? `<label class="check-row"><input type="checkbox" data-cam="${f.key}" ${rig[f.key] ? 'checked' : ''}/> ${escapeHtml(f.label)}</label>`
      : `<div class="prop-row"><label title="${escapeHtml(f.tip ?? f.label)}">${escapeHtml(f.label)}</label>
          <input type="range" data-cam="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${rig[f.key]}" />
          <span class="val" data-cam-v="${f.key}">${show(rig[f.key], f.step)}</span></div>`)).join('')}
      <div class="insp-row"><button class="tbtn" id="cam-view" ${rig.mode === tab ? 'disabled' : ''}
        title="Switch the editor's view to this camera, to see the settings as you change them">👁 View through this camera</button></div>`;

    tabsEl.querySelectorAll('[data-cam-tab]').forEach((b) => b.addEventListener('click', () => {
      tab = b.dataset.camTab;
      render();
    }));
    bodyEl.querySelector('#cam-view')?.addEventListener('click', () => {
      onPreview(tab);
      render();
    });
    for (const el of bodyEl.querySelectorAll('[data-cam]')) {
      const f = fields.find((x) => x.key === el.dataset.cam);
      let before = rig[f.key];
      const read = () => (f.type === 'boolean' ? el.checked : Number(el.value));
      el.addEventListener('input', () => {
        if (f.type === 'boolean') return;
        apply(f.key, read());
        bodyEl.querySelector(`[data-cam-v="${f.key}"]`).textContent = show(read(), f.step);
      });
      el.addEventListener('change', () => {
        const after = read();
        apply(f.key, after);
        if (after !== before) {
          const was = before;
          history?.push({
            label: `camera: ${f.label.toLowerCase()}`,
            undo: () => { apply(f.key, was); render(); onChange(); },
            redo: () => { apply(f.key, after); render(); onChange(); },
          });
        }
        before = after;
        onChange();
      });
    }
  }

  /**
   * Values the camera changes by itself (scroll to zoom, a pan leaving the
   * target) shown as they change — but never under a field being dragged.
   */
  function syncLive() {
    for (const el of bodyEl.querySelectorAll('[data-cam]')) {
      if (el === document.activeElement) continue;
      const f = fields.find((x) => x.key === el.dataset.cam);
      if (!f) continue;
      if (f.type === 'boolean') {
        if (el.checked !== !!rig[f.key]) el.checked = !!rig[f.key];
      } else if (Math.abs(Number(el.value) - rig[f.key]) > f.step / 2) {
        el.value = rig[f.key];
        bodyEl.querySelector(`[data-cam-v="${f.key}"]`).textContent = show(rig[f.key], f.step);
      }
    }
  }

  render();
  return {
    render,
    syncLive,
    /** Show a camera's settings (the view just switched to it). */
    showTab(mode) {
      if (!CAMERA_SETTINGS[mode]) return;
      tab = mode;
      render();
    },
    get tab() { return tab; },
  };
}
