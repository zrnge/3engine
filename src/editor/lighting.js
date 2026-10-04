import { escapeHtml } from '../ui.js';
import { isProbe } from '../probes.js';

/**
 * The Lighting panel: every light in the scene, with its colour, strength and shadows.
 *
 * Mixed into ObjectEditor.prototype (see ../editor.js), so `this` is the editor.
 */
export const lightingMethods = {
  /**
   * The Lighting panel: every light in the scene with its colour, intensity
   * and shadows, editable without selecting it first. (Light settings used to
   * appear only in the inspector of a selected light, so a scene's lighting
   * could never be seen or balanced as a whole.)
   */
  _renderLighting() {
    const el = this.lightListEl;
    if (!el) return;
    const lights = this.selectables.filter((e) => e.object3D.isLight);
    const probes = this.selectables.filter((e) => isProbe(e.object3D));
    if (!lights.length && !probes.length) {
      el.innerHTML = '<div class="empty">No extra lights. The environment lights the scene; add lights for lamps, torches and highlights — and a probe round a room, so it is lit and reflected by itself, not the sky.</div>';
      return;
    }

    el.innerHTML = lights.map((entity, i) => {
      const l = entity.object3D;
      // point and spot lights use physical units: a default point light is 30,
      // which the old 0–8 slider could not even represent
      const max = (l.isPointLight || l.isSpotLight) ? 200 : 10;
      const shadowRow = l.shadow
        ? `<label class="check-row"><input type="checkbox" id="light-${i}-shadow" ${l.castShadow ? 'checked' : ''}/> Cast shadows</label>`
        : '';
      return `
        <div class="light-card${this.selectedSet.has(entity) ? ' selected' : ''}">
          <div class="light-head">
            <button class="light-name" data-light-select="${i}" title="Select this light">${escapeHtml(this._name(entity))}</button>
            <input type="color" id="light-${i}-color" value="#${l.color.getHexString()}" title="Light colour" />
          </div>
          <div class="prop-row"><label>Intensity</label>
            <input type="range" id="light-${i}-int" min="0" max="${max}" step="${max / 200}" value="${l.intensity}" />
            <span class="val" id="light-${i}-int-v">${l.intensity.toFixed(1)}</span></div>
          ${shadowRow}
        </div>`;
    }).join('') + probes.map((entity, i) => {
      const p = entity.object3D.userData.probe;
      return `
        <div class="light-card${this.selectedSet.has(entity) ? ' selected' : ''}">
          <div class="light-head">
            <button class="light-name" data-probe-select="${i}" title="Select this probe — scale it to fit the room">◎ ${escapeHtml(this._name(entity))}</button>
            <button class="tbtn" data-probe-capture="${i}" title="Capture it again: after moving walls, lamps or furniture">Capture again</button>
          </div>
          <div class="prop-row" title="How strongly the room's light and reflections show on what is inside the box"><label>Strength</label>
            <input type="range" id="probe-${i}-int" min="0" max="3" step="0.05" value="${p.intensity}" />
            <span class="val" id="probe-${i}-int-v">${Number(p.intensity).toFixed(2)}</span></div>
        </div>`;
    }).join('');

    probes.forEach((entity, i) => {
      const p = entity.object3D.userData.probe;
      const q = (s) => el.querySelector(s);
      q(`[data-probe-select="${i}"]`).addEventListener('click', () => this.select(entity));
      q(`[data-probe-capture="${i}"]`).addEventListener('click', () => this.engine.probes?.invalidate());
      const slider = q(`#probe-${i}-int`);
      const readout = q(`#probe-${i}-int-v`);
      let before = p.intensity;
      slider.addEventListener('input', () => {
        p.intensity = parseFloat(slider.value);
        readout.textContent = p.intensity.toFixed(2);
      });
      slider.addEventListener('change', () => {
        this._recordValue(p, 'intensity', before, p.intensity, (v) => { p.intensity = v; }, 'probe strength');
        before = p.intensity;
      });
    });

    lights.forEach((entity, i) => {
      const l = entity.object3D;
      const q = (s) => el.querySelector(s);
      q(`[data-light-select="${i}"]`).addEventListener('click', () => this.select(entity));

      const color = q(`#light-${i}-color`);
      let colorBefore = color.value;
      color.addEventListener('input', () => l.color.set(color.value));
      color.addEventListener('change', () => {
        this._recordColor(l, 'color', colorBefore, color.value, 'light color');
        colorBefore = color.value;
      });

      const slider = q(`#light-${i}-int`);
      const readout = q(`#light-${i}-int-v`);
      let intensityBefore = l.intensity;
      slider.addEventListener('input', () => {
        l.intensity = parseFloat(slider.value);
        readout.textContent = l.intensity.toFixed(1);
      });
      slider.addEventListener('change', () => {
        this._recordValue(l, 'intensity', intensityBefore, l.intensity,
          (v) => { l.intensity = v; }, 'light intensity');
        intensityBefore = l.intensity;
      });

      const shadow = q(`#light-${i}-shadow`);
      shadow?.addEventListener('change', () => {
        const before = !shadow.checked;
        l.castShadow = shadow.checked;
        this._recordValue(l, 'castShadow', before, l.castShadow,
          (v) => { l.castShadow = v; }, 'shadows');
      });
    });
  },
};
