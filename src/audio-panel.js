import { AudioLoader } from 'three';
import { SFX_PRESETS, WAVES, presetSfx, varySfx, normalizeSfx } from './sfx.js';
import { SOUND_BUSES, soundSettings } from './sound.js';
import { assetStore } from './assets-db.js';
import { escapeHtml } from './ui.js';

/**
 * Sound cards — one per sound, for an object (the Audio panel's lower half) or
 * for the scene itself (music and ambience, entity = null).
 *
 *   [coin            ] ▶ ×
 *   🎛 Coin  made here          🎲 Vary  Tweak
 *   Heard    From this object (3D)
 *   Channel  Effects
 *   Volume ─────o──   Vary pitch ──o────
 *   ☐ Loop  ☑ Overlap  ☐ On start
 *
 * Every change is undoable. The name is the handle: rules, controls and
 * components play a sound by its name.
 */

const BUS_LABELS = { effects: 'Effects', music: 'Music', ambience: 'Ambience' };
const _tweaking = new WeakSet(); // sounds whose sound-maker controls are open
const _loader = new AudioLoader();

const pct = (v) => `${Math.round(Number(v) * 100)}%`;
const FORMAT = {
  volume: pct,
  pitchVary: (v) => (Number(v) > 0 ? `±${Math.round(v * 100)}%` : 'off'),
  refDistance: (v) => `${v}m`,
  freq: (v) => `${Math.round(v)}`,
  freqEnd: (v) => `${Math.round(v)}`,
  length: (v) => `${Number(v).toFixed(2)}s`,
  lowpass: pct,
  vibrato: pct,
};

/** Keep the "sound name" suggestions (a <datalist>) in step with the scene. */
export function refreshSoundNames(engine) {
  if (typeof document === 'undefined') return;
  let list = document.getElementById('t3-sound-names');
  if (!list) {
    list = document.createElement('datalist');
    list.id = 't3-sound-names';
    document.body.appendChild(list);
  }
  list.innerHTML = engine.audio.names()
    .map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
}

function uniqueName(engine, base) {
  const taken = new Set(engine.audio.names().map((n) => n.toLowerCase()));
  let name = base;
  let i = 2;
  while (taken.has(name.toLowerCase())) name = `${base}${i++}`;
  return name;
}

function rangeRow(p, i, field, label, min, max, step, value, attr = 'data-f', title = label) {
  const id = `${p}-${i}-${field}`;
  return `<div class="prop-row"><label title="${escapeHtml(title)}">${label}</label>
    <input type="range" id="${id}" ${attr}="${field}" data-i="${i}" min="${min}" max="${max}" step="${step}" value="${value}" />
    <span class="val" id="${id}-v">${FORMAT[field](value)}</span></div>`;
}

function synthLength(s) { return s.loop ? s.sustain : s.attack + s.sustain + s.decay; }

function synthHtml(s, i, p) {
  const waves = WAVES.map((w) => `<option value="${w}" ${w === s.wave ? 'selected' : ''}>${w}</option>`).join('');
  const len = synthLength(s);
  return `
    <div class="snd-synth">
      <div class="prop-row"><label>Wave</label><select data-synth="wave" data-i="${i}">${waves}</select></div>
      ${rangeRow(p, i, 'freq', 'Pitch', 40, 3000, 1, Math.round(s.freq), 'data-synth', 'Starting pitch (Hz)')}
      ${s.loop ? '' : rangeRow(p, i, 'freqEnd', 'Slide to', 40, 3000, 1, Math.round(s.freqEnd), 'data-synth', 'Pitch at the end (Hz)')}
      ${rangeRow(p, i, 'length', 'Length', s.loop ? 1 : 0.02, s.loop ? 8 : 2, 0.01, len.toFixed(2), 'data-synth')}
      ${rangeRow(p, i, 'lowpass', 'Brightness', 0.02, 1, 0.01, s.lowpass, 'data-synth', 'Low = muffled, high = sharp')}
      ${rangeRow(p, i, 'vibrato', 'Wobble', 0, 0.3, 0.01, s.vibrato, 'data-synth', 'Pitch wobble')}
    </div>`;
}

function synthPatch(s, field, raw) {
  const next = { ...s };
  if (field === 'wave') next.wave = raw;
  else if (field === 'length') {
    const v = Number(raw);
    if (s.loop) next.sustain = v;
    else {
      const k = v / (synthLength(s) || 1);
      next.attack = s.attack * k;
      next.sustain = s.sustain * k;
      next.decay = s.decay * k;
    }
  } else next[field] = Number(raw);
  return normalizeSfx(next);
}

function cardHtml(engine, r, i, p, onObject) {
  const playing = engine.audio.isPlaying(r);
  const source = r.synth
    ? `<span>🎛 ${escapeHtml(SFX_PRESETS[r.synth.preset]?.label || 'Custom')}</span><span class="snd-dim">made here</span>
       <button class="tbtn snd-mini" data-snd-act="vary" data-i="${i}" title="Same kind of sound, a bit different">🎲 Vary</button>
       <button class="tbtn snd-mini" data-snd-act="tweak" data-i="${i}">${_tweaking.has(r) ? 'Done' : 'Tweak'}</button>`
    : '<span>📁</span><span class="snd-dim">audio file</span>';
  const opt = (value, label, current) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;
  return `
    <div class="snd-card${playing ? ' playing' : ''}">
      <div class="snd-head">
        <input class="snd-name" data-f="name" data-i="${i}" value="${escapeHtml(r.name)}" spellcheck="false"
          title="Its name — rules, controls and components play it by name" />
        <button class="tbtn snd-mini" data-snd-act="play" data-i="${i}" title="Preview">${playing ? '⏹' : '▶'}</button>
        <button class="gp-x" data-snd-act="del" data-i="${i}" title="Delete sound">×</button>
      </div>
      <div class="snd-source">${source}</div>
      ${r.synth && _tweaking.has(r) ? synthHtml(r.synth, i, p) : ''}
      ${onObject ? `<div class="prop-row"><label>Heard</label><select data-f="type" data-i="${i}">
        ${opt('positional', 'From this object (3D)', r.type)}${opt('global', 'Everywhere', r.type)}</select></div>` : ''}
      <div class="prop-row"><label title="Which mixer volume controls it">Channel</label><select data-f="bus" data-i="${i}">
        ${SOUND_BUSES.map((b) => opt(b, BUS_LABELS[b], r.bus)).join('')}</select></div>
      ${rangeRow(p, i, 'volume', 'Volume', 0, 1, 0.01, r.volume)}
      ${rangeRow(p, i, 'pitchVary', 'Vary pitch', 0, 0.5, 0.01, r.pitchVary, 'data-f', 'Each play is a little higher or lower, so repeats sound natural')}
      ${r.type === 'positional' ? rangeRow(p, i, 'refDistance', 'Heard within', 1, 50, 1, r.refDistance, 'data-f', 'Full volume within this distance, fading beyond it') : ''}
      <div class="snd-checks">
        <label class="check-row" title="Repeats until stopped"><input type="checkbox" data-f="loop" data-i="${i}" ${r.loop ? 'checked' : ''}/> Loop</label>
        <label class="check-row" title="Plays over itself instead of restarting"><input type="checkbox" data-f="overlap" data-i="${i}" ${r.overlap ? 'checked' : ''} ${r.loop ? 'disabled' : ''}/> Overlap</label>
        <label class="check-row" title="Starts when Play starts"><input type="checkbox" data-f="autoplay" data-i="${i}" ${r.autoplay ? 'checked' : ''}/> On start</label>
      </div>
    </div>`;
}

/** The cards plus the "Add" chooser, as HTML. */
export function soundCardsHtml(engine, entity, prefix) {
  const onObject = !!entity;
  const list = engine.audio.sounds.filter((s) => s.entity === (entity ?? null));
  const presets = (group) => Object.entries(SFX_PRESETS)
    .filter(([, d]) => d.group === group)
    .map(([k, d]) => `<option value="${k}">${escapeHtml(d.label)}</option>`).join('');
  const empty = onObject ? 'No sounds on this object.' : 'No music or ambience yet.';
  return `
    ${list.map((r, i) => cardHtml(engine, r, i, prefix, onObject)).join('') || `<div class="empty">${empty}</div>`}
    <div class="prop-row snd-add"><label>Add</label>
      <select id="${prefix}-add">
        <option value="">choose…</option>
        <optgroup label="Sound maker">${presets('effect')}</optgroup>
        <optgroup label="Ambience loops">${presets('ambience')}</optgroup>
        <optgroup label="Your own"><option value="file">📁 Audio file…</option></optgroup>
      </select>
    </div>`;
}

/** Wire the cards rendered by soundCardsHtml into `root`. */
export function wireSoundCards({ engine, history, root, entity = null, prefix, rerender, onChange = () => {} }) {
  const audio = engine.audio;
  const list = () => audio.sounds.filter((s) => s.entity === entity);
  const recOf = (el) => list()[Number(el.dataset.i)];
  const pick = (rec, fields) => {
    const all = soundSettings(rec);
    return Object.fromEntries(fields.map((f) => [f, all[f]]));
  };
  const push = (label, undo, redo) => {
    history?.push({
      label,
      undo: () => { undo(); rerender(); onChange(); },
      redo: () => { redo(); rerender(); onChange(); },
    });
    onChange();
  };
  const record = (rec, label, before) => {
    const after = pick(rec, Object.keys(before));
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    push(label, () => audio.update(rec, before), () => audio.update(rec, after));
  };
  const change = (rec, label, patch, { redraw = true } = {}) => {
    const before = pick(rec, Object.keys(patch));
    audio.update(rec, patch);
    record(rec, label, before);
    if (redraw) rerender();
  };
  const preview = (rec) => {
    const on = audio.preview(rec);
    rerender();
    // put the ▶ back once a one-shot has finished
    if (on && !rec.loop && rec.buffer?.duration) {
      setTimeout(() => { if (root.isConnected) rerender(); }, rec.buffer.duration * 1000 + 80);
    }
  };
  const added = (rec) => {
    push(`add sound ${rec.name}`, () => audio.remove(rec), () => audio.restore(rec));
    if (!rec.loop) preview(rec);
    else rerender();
  };

  const importFile = () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'audio/*';
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0];
      if (!file) return;
      try {
        // persist first, so the clip survives save / reload / Play -> Stop
        const meta = await assetStore.put(file, { kind: 'audio' });
        const buffer = await _loader.loadAsync(await assetStore.objectURL(meta.id));
        const scene = !entity;
        added(audio.add(entity, buffer, {
          name: uniqueName(engine, file.name.replace(/\.[^.]+$/, '') || 'sound'),
          assetId: meta.id,
          type: scene ? 'global' : 'positional',
          bus: scene ? 'music' : 'effects',
          loop: scene, autoplay: scene, overlap: !scene,
        }));
      } catch (err) {
        console.error('[Tiny3] sound import failed:', err);
      }
    });
    picker.click();
  };

  root.querySelector(`#${prefix}-add`)?.addEventListener('change', (e) => {
    const value = e.target.value;
    e.target.value = '';
    if (!value) return;
    if (value === 'file') { importFile(); return; }
    const ambience = SFX_PRESETS[value]?.group === 'ambience';
    added(audio.add(entity, null, {
      name: uniqueName(engine, value),
      synth: presetSfx(value),
      type: entity && !ambience ? 'positional' : 'global',
      bus: ambience ? 'ambience' : 'effects',
      loop: ambience, autoplay: ambience, overlap: !ambience,
    }));
  });

  root.querySelectorAll('[data-snd-act]').forEach((btn) => btn.addEventListener('click', () => {
    const rec = recOf(btn);
    if (!rec) return;
    switch (btn.dataset.sndAct) {
      case 'play': preview(rec); break;
      case 'del': {
        const index = audio.sounds.indexOf(rec);
        audio.remove(rec);
        push(`delete sound ${rec.name}`, () => audio.restore(rec, index), () => audio.remove(rec));
        rerender();
        break;
      }
      case 'vary':
        change(rec, 'vary sound', { synth: varySfx(rec.synth) }, { redraw: false });
        preview(rec);
        break;
      case 'tweak':
        if (_tweaking.has(rec)) _tweaking.delete(rec); else _tweaking.add(rec);
        rerender();
        break;
      default:
    }
  }));

  root.querySelectorAll('[data-f]').forEach((el) => {
    const field = el.dataset.f;
    if (el.type === 'range') {
      el.addEventListener('input', () => {
        const rec = recOf(el);
        if (!rec) return;
        if (el._before === undefined) el._before = pick(rec, [field]);
        audio.update(rec, { [field]: Number(el.value) });
        const readout = root.querySelector(`#${CSS.escape(el.id)}-v`);
        if (readout) readout.textContent = FORMAT[field](el.value);
      });
      el.addEventListener('change', () => {
        const rec = recOf(el);
        if (!rec) return;
        const before = el._before ?? pick(rec, [field]);
        el._before = undefined;
        audio.update(rec, { [field]: Number(el.value) });
        record(rec, `sound ${field}`, before);
      });
      return;
    }
    el.addEventListener('change', () => {
      const rec = recOf(el);
      if (!rec) return;
      if (field === 'name') {
        const name = el.value.trim();
        if (!name) { el.value = rec.name; return; }
        change(rec, 'rename sound', { name }, { redraw: false });
        refreshSoundNames(engine);
        return;
      }
      const value = el.type === 'checkbox' ? el.checked : el.value;
      change(rec, `sound ${field}`, { [field]: value });
    });
  });

  root.querySelectorAll('[data-synth]').forEach((el) => {
    const field = el.dataset.synth;
    if (el.type === 'range') {
      el.addEventListener('input', () => {
        const readout = root.querySelector(`#${CSS.escape(el.id)}-v`);
        if (readout) readout.textContent = FORMAT[field](el.value);
      });
    }
    el.addEventListener('change', () => {
      const rec = recOf(el);
      if (!rec?.synth) return;
      change(rec, `tweak ${field}`, { synth: synthPatch(rec.synth, field, el.value) }, { redraw: false });
      if (!rec.loop) preview(rec);
    });
  });

  refreshSoundNames(engine);
}
