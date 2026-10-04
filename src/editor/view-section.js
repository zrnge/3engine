import { fitViewModel, normalizeViewModel, startingAim } from '../view-model.js';

/**
 * The Inspector's "Held in view" section: where a first-person object (arms, a
 * gun, a torch) sits in front of the camera. Any object can be held; the
 * sliders move it live, so "Preview in first person" shows the result while
 * you drag them.
 *
 * Two places: Normal, and Aiming — where it goes while an Aim control is on
 * (up to the eye, down the sights). The same sliders edit whichever tab is
 * chosen, and choosing Aiming shows it there in the preview.
 *
 * Mixed into ObjectEditor.prototype (see ../editor.js), so `this` is the editor.
 */

const SLIDERS = [
  // [label, setting, axis, min, max, step, sign] — "Forward" is distance in front
  // of the eye, which is -z in the camera's own space
  ['Right', 'position', 0, -1.5, 1.5, 0.01, 1],
  ['Up', 'position', 1, -1.5, 1.5, 0.01, 1],
  ['Forward', 'position', 2, -0.5, 3, 0.01, -1],
  ['Turn', 'rotation', 1, -180, 180, 1, 1],
  ['Tilt', 'rotation', 0, -180, 180, 1, 1],
  ['Roll', 'rotation', 2, -180, 180, 1, 1],
];
const shown = (pose, key, i, sign) => +(sign * pose[key][i]).toFixed(3);
/** Which place the sliders edit: 'normal' or 'aim' (the editor remembers it across objects). */
const poseTab = (editor) => (editor._vmPose === 'aim' ? 'aim' : 'normal');
/** The aiming place shown and edited: its own, or where it would start. */
const aimOf = (entity) => entity.viewModel.aim ?? startingAim(entity.object3D, entity.viewModel);

export const viewSectionMethods = {
  _viewSection(entity) {
    const o = entity.object3D;
    if (o.isLight) return '';
    const vm = entity.viewModel;
    if (!vm) {
      return `<label class="check-row" title="First person: draw it in front of the camera — arms, a gun, a torch">
        <input type="checkbox" id="vm-on" /> Hold in first-person view</label>`;
    }
    const aiming = poseTab(this) === 'aim';
    const pose = aiming ? aimOf(entity) : vm;
    const rows = SLIDERS.map(([label, key, i, min, max, step, sign], n) => `
      <div class="prop-row"><label>${label}</label>
        <input type="range" id="vm-${n}" min="${min}" max="${max}" step="${step}" value="${shown(pose, key, i, sign)}" />
        <span class="val" id="vm-${n}-v">${shown(pose, key, i, sign)}</span></div>`).join('');
    const tab = (id, label, title) => `<button class="tbtn cam-tab${poseTab(this) === id ? ' active' : ''}"
      data-vm-pose="${id}" title="${title}">${label}</button>`;
    return `
      <h4 class="insp-h">Held in view</h4>
      <label class="check-row"><input type="checkbox" id="vm-on" checked /> Hold in first-person view</label>
      <div class="cam-tabs">${tab('normal', 'Normal', 'Where it is held')}${tab('aim', 'Aiming', 'Where it goes while an Aim control is on — up to the eye, down the sights')}</div>
      ${aiming ? '<div class="hint">While aiming (add an <b>Aim</b> control in Controls). Line the sights up with the middle of the view.</div>' : ''}
      ${rows}
      <div class="prop-row"><label>Size</label>
        <input type="number" id="vm-scale" min="0.001" step="0.01" value="${vm.scale}" /></div>
      <div class="insp-row wrap" style="margin:4px 0 8px">
        <button class="tbtn" id="vm-preview" title="See it as the player will — press 1 for the editing view again">👁 Preview in first person</button>
        ${aiming
    ? '<button class="tbtn" id="vm-aim-reset" title="Put the aiming place back to its starting point">↺ Reset aiming</button>'
    : '<button class="tbtn" id="vm-fit" title="Size and place it again from scratch">↺ Fit</button>'}
      </div>`;
  },

  _wireViewSection(entity) {
    const on = this._q('#vm-on');
    if (!on) return;
    // undo keeps copies: the sliders change the live setting in place as they move
    const copy = (v) => (v ? JSON.parse(JSON.stringify(v)) : null);
    let before = copy(entity.viewModel);
    const set = (vm, label, record = true) => {
      const was = before;
      const now = vm ? normalizeViewModel(vm) : null;
      const kept = copy(now);
      const apply = (v) => {
        if (v) entity.viewModel = copy(v);
        else delete entity.viewModel;
        this._renderInspector();
      };
      if (record) this.history?.push({ label, undo: () => apply(was), redo: () => apply(kept) });
      before = kept;
      if (now) entity.viewModel = now;
      else delete entity.viewModel;
    };

    on.addEventListener('change', () => {
      set(on.checked ? fitViewModel(entity.object3D) : null, on.checked ? 'hold in view' : 'stop holding in view');
      this._renderInspector();
    });
    if (!entity.viewModel) return;

    for (const id of ['normal', 'aim']) {
      this._q(`[data-vm-pose="${id}"]`)?.addEventListener('click', () => {
        this._vmPose = id; // the editor's view shows it there (see editor.update)
        this._renderInspector();
      });
    }
    const aiming = poseTab(this) === 'aim';
    // the place the sliders move: the aiming one is made on the first change
    const pose = () => (aiming ? (entity.viewModel.aim ??= aimOf(entity)) : entity.viewModel);
    SLIDERS.forEach(([, key, i, , , , sign], n) => {
      const el = this._q(`#vm-${n}`);
      const out = this._q(`#vm-${n}-v`);
      el?.addEventListener('input', () => {
        pose()[key][i] = Number(el.value) * sign; // live: drawn next frame
        out.textContent = el.value;
      });
      el?.addEventListener('change', () => set(entity.viewModel, aiming ? 'move aiming place' : 'move held object'));
    });
    const scale = this._q('#vm-scale');
    scale?.addEventListener('change', () => {
      set({ ...entity.viewModel, scale: Number(scale.value) }, 'resize held object');
    });
    this._q('#vm-fit')?.addEventListener('click', () => {
      set(fitViewModel(entity.object3D), 'fit held object');
      this._renderInspector();
    });
    this._q('#vm-aim-reset')?.addEventListener('click', () => {
      const { aim, ...rest } = entity.viewModel;
      set({ ...rest, aim: startingAim(entity.object3D, rest) }, 'reset aiming place');
      this._renderInspector();
    });
    this._q('#vm-preview')?.addEventListener('click', () => this.onPreviewFirstPerson?.());
  },
};
