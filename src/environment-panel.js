/**
 * The Environment section of the Lighting panel: presets, time of day, sun
 * direction, clouds, exposure, shadow softness and fog. Every change is
 * undoable, and the panel re-reads the environment whenever a scene loads.
 */

const signed = (v) => (Math.abs(v) < 0.005 ? '0' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`);

const clockTime = (t) => {
  const hours = Math.floor(t) % 24;
  const minutes = Math.round((t - Math.floor(t)) * 60) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

// [element id, setting, how to show the value]
const SLIDERS = [
  ['env-time', 'time', clockTime],
  ['env-azimuth', 'azimuth', (v) => `${Math.round(v)}°`],
  ['env-clouds', 'clouds', (v) => `${Math.round(v * 100)}%`],
  ['env-exposure', 'exposure', (v) => v.toFixed(2)],
  ['env-softness', 'softness', (v) => `${Math.round(v * 100)}%`],
  ['env-fog', 'fog', (v) => (v > 0 ? `${Math.round(v)}` : 'off')],
  ['env-shadow-range', 'shadowRange', (v) => (v > 0 ? `${Math.round(v)} m` : 'automatic')],
  ['env-bloom-strength', 'bloomStrength', (v) => v.toFixed(2)],
  ['env-bloom-threshold', 'bloomThreshold', (v) => `${Math.round(v * 100)}%`],
  ['env-bloom-radius', 'bloomRadius', (v) => `${Math.round(v * 100)}%`],
  ['env-draw-distance', 'drawDistance', (v) => (v > 0 ? `${Math.round(v)} m` : 'no limit')],
  ['env-lamp-shadows', 'lampShadows', (v) => (v > 0 ? `${v} at once` : 'none')],
  ['env-ao-strength', 'aoStrength', (v) => `${Math.round(v * 100)}%`],
  ['env-ao-radius', 'aoRadius', (v) => `${v.toFixed(2)} m`],
  ['env-dof-distance', 'dofDistance', (v) => `${v} m`],
  ['env-dof-blur', 'dofBlur', (v) => `${Math.round(v * 100)}%`],
  ['env-contrast', 'contrast', signed],
  ['env-saturation', 'saturation', signed],
  ['env-warmth', 'warmth', signed],
  ['env-vignette', 'vignette', (v) => (v > 0 ? `${Math.round(v * 100)}%` : 'off')],
  ['env-grain', 'grain', (v) => (v > 0 ? `${Math.round(v * 100)}%` : 'off')],
];

// bloom works with the environment off too; its sliders only while it is on
const BLOOM = ['bloomStrength', 'bloomThreshold', 'bloomRadius'];
// the picture's effects work whatever the sky; each one's own sliders while it is on
const AO = ['aoStrength', 'aoRadius'];
const DOF = ['dofDistance', 'dofBlur'];
const ALWAYS = ['drawDistance', 'lampShadows', 'contrast', 'saturation', 'warmth', 'vignette', 'grain'];
/** Whether a slider can be moved now. */
function usable(key, s) {
  if (ALWAYS.includes(key)) return true;
  if (BLOOM.includes(key)) return s.bloom;
  if (AO.includes(key)) return s.ao;
  if (key === 'dofDistance') return s.dof && s.dofFocus === 'a distance';
  if (DOF.includes(key)) return s.dof;
  return s.enabled && !(s.studio && key === 'time');
}

export function wireEnvironmentPanel(env, { history = null, onChange = null } = {}) {
  const byId = (id) => document.getElementById(id);

  const record = (label, before) => {
    const after = env.toJSON();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    history?.push({
      label,
      undo: () => { env.load(before); refresh(); onChange?.(); },
      redo: () => { env.load(after); refresh(); onChange?.(); },
    });
  };

  function refresh() {
    const s = env.settings;
    for (const [id, key, show] of SLIDERS) {
      const el = byId(id);
      if (!el) continue;
      el.value = s[key];
      const readout = byId(`${id}-v`);
      if (readout) readout.textContent = show(Number(s[key]));
      // studio lighting ignores the clock, and nothing applies while switched off
      el.disabled = !usable(key, s);
    }
    const quality = byId('env-shadow-quality');
    if (quality) {
      quality.value = s.shadowQuality;
      quality.disabled = !s.enabled || !s.shadows;
    }
    const bloom = byId('env-bloom');
    if (bloom) bloom.checked = s.bloom;
    const ao = byId('env-ao');
    if (ao) ao.checked = s.ao;
    const dof = byId('env-dof');
    if (dof) dof.checked = s.dof;
    const focus = byId('env-dof-focus');
    if (focus) { focus.value = s.dofFocus; focus.disabled = !s.dof; }
    const copies = byId('env-instancing');
    if (copies) copies.checked = s.instancing;
    const shadows = byId('env-shadows');
    if (shadows) {
      shadows.checked = s.shadows;
      shadows.disabled = !s.enabled;
    }
    const current = s.enabled ? s.preset : 'off';
    document.querySelectorAll('[data-env-preset]').forEach((b) =>
      b.classList.toggle('active', b.dataset.envPreset === current));
  }

  for (const [id, key, show] of SLIDERS) {
    const el = byId(id);
    if (!el) continue;
    let before = null;
    el.addEventListener('input', () => {
      if (!before) before = env.toJSON();
      env.set({ [key]: Number(el.value) });
      const readout = byId(`${id}-v`);
      if (readout) readout.textContent = show(Number(el.value));
      document.querySelectorAll('[data-env-preset]').forEach((b) =>
        b.classList.toggle('active', b.dataset.envPreset === env.settings.preset));
      onChange?.();
    });
    el.addEventListener('change', () => {
      if (before) record(`lighting ${key}`, before);
      before = null;
    });
  }

  byId('env-shadows')?.addEventListener('change', (e) => {
    const before = env.toJSON();
    env.set({ shadows: e.target.checked });
    record('sun shadows', before);
    refresh();
    onChange?.();
  });
  byId('env-shadow-quality')?.addEventListener('change', (e) => {
    const before = env.toJSON();
    env.set({ shadowQuality: e.target.value });
    record('shadow detail', before);
    onChange?.();
  });
  byId('env-instancing')?.addEventListener('change', (e) => {
    const before = env.toJSON();
    env.set({ instancing: e.target.checked });
    record('draw copies together', before);
    onChange?.();
  });
  // ambient occlusion, depth of field: on or off, and where depth of field focuses
  for (const [id, key, label] of [['env-ao', 'ao', 'ambient occlusion'], ['env-dof', 'dof', 'depth of field']]) {
    byId(id)?.addEventListener('change', (e) => {
      const before = env.toJSON();
      env.set({ [key]: e.target.checked });
      record(label, before);
      refresh();
      onChange?.();
    });
  }
  byId('env-dof-focus')?.addEventListener('change', (e) => {
    const before = env.toJSON();
    env.set({ dofFocus: e.target.value });
    record('focus', before);
    refresh();
    onChange?.();
  });
  byId('env-bloom')?.addEventListener('change', (e) => {
    const before = env.toJSON();
    env.set({ bloom: e.target.checked });
    record('bloom', before);
    refresh();
    onChange?.();
  });

  document.querySelectorAll('[data-env-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const before = env.toJSON();
      env.applyPreset(button.dataset.envPreset);
      record(`lighting preset ${button.dataset.envPreset}`, before);
      refresh();
      onChange?.();
    });
  });

  refresh();
  return { refresh };
}
