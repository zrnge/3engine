import {
  materialSpec, applyMaterialSpec, normalizeSpec, withTexture, withMadeTexture,
  classifyTexture, importTextureFile, countUsers, cloneMaterial, TEXTURE_SLOTS,
} from './materials.js';
import { PATTERNS, TEX_SIZES, normalizeTexParams } from './texgen.js';
import { escapeHtml } from './ui.js';
import { pickFolder } from './file-drop.js';
import {
  readModelMaterials, modelMaterialSpec, modelSlotImage, imageData, isModelFile, ktx2ToPng,
} from './gltf-material.js';

/**
 * The Color & Texture panel.
 *
 *   Material   [Own ▾ | library materials]      Save to library… / Make unique
 *   Surface    colour/tint · metalness · roughness · opacity · transparency · glow
 *   Textures   [Load set…] [Make… ▾] [max 2048 ▾]
 *              one row per slot: base colour, normal, roughness, metalness, AO,
 *              packed ORM, glow, opacity mask — each Load / ×
 *              Every Load takes pictures, or a .glb / .gltf model: its material
 *              (Load set, or dropped on the panel) or that slot's picture from it.
 *              A model with several materials offers them to pick from.
 *   Maker      pattern, colours, scale, gap, variation, bumps, resolution, 🎲
 *   Placement  tiling · offset · rotation · tile by size · edges · smooth/pixelated
 *
 * Every edit is one undo step: the whole material description before and after.
 */

const MAX_SIZES = [512, 1024, 2048, 4096];
const MAX_PREF = 'tiny3.maxTextureSize';
const _reports = new WeakMap(); // material -> what "Load set" put where
const _choices = new WeakMap(); // material -> { model, slot, thumbs }: a model's materials to pick from
const _folders = new WeakMap(); // material -> { name, slot }: a .gltf whose pictures are in its folder
const PICK_ACCEPT = 'image/*,.glb,.gltf,.bin';
const isImageFile = (f) => /^image\//.test(f.type || '') || /\.(png|jpe?g|webp|avif|gif|bmp)$/i.test(f.name || '');

/** Put away a model's materials offered to pick from (and the thumbnails made for them). */
function closeChooser(m) {
  const choice = _choices.get(m);
  if (!choice) return;
  for (const url of choice.thumbs) if (url) URL.revokeObjectURL(url);
  _choices.delete(m);
}

function chooserHtml({ model, slot, thumbs }) {
  const what = slot ? ` — for its ${TEXTURE_SLOTS[slot].label.toLowerCase()} picture` : '';
  return `<div class="tex-choose">
    <div class="tex-choose-head"><span>Materials in <b>${escapeHtml(model.name)}</b>${what}. Pick one:</span>
      <button class="gp-x" data-act="choose-cancel" title="Close">×</button></div>
    ${model.materials.map((mat, i) => `<button class="tex-choice" data-choose="${i}" title="Use ${escapeHtml(mat.name)}">
      <span class="tex-thumb" style="background-color:${mat.settings.color}${thumbs[i] ? `;background-image:url('${thumbs[i]}')` : ''}"></span>
      <span class="tex-choice-name">${escapeHtml(mat.name)}</span>
      <small>${mat.textures ? `${mat.textures} picture${mat.textures === 1 ? '' : 's'}` : 'colour only'}</small>
    </button>`).join('')}
  </div>`;
}

function maxSize() {
  try {
    const v = Number(localStorage.getItem(MAX_PREF));
    return MAX_SIZES.includes(v) ? v : 2048;
  } catch (_) { return 2048; }
}

const pct = (v) => `${Math.round(Number(v) * 100)}%`;
const FORMAT = {
  metalness: (v) => Number(v).toFixed(2),
  roughness: (v) => Number(v).toFixed(2),
  opacity: (v) => Number(v).toFixed(2),
  alphaCutoff: (v) => Number(v).toFixed(2),
  emissiveIntensity: (v) => `${Number(v).toFixed(1)}×`,
  normalStrength: (v) => `${Number(v).toFixed(2)}×`,
  aoIntensity: (v) => `${Number(v).toFixed(2)}×`,
  'uv.rotation': (v) => `${Math.round(v)}°`,
  scale: (v) => `${v}`,
  gap: pct,
  variation: pct,
  bump: (v) => `${Number(v).toFixed(2)}×`,
};
const fmt = (key, v) => (FORMAT[key] ? FORMAT[key](v) : String(v));

function range(path, label, min, max, step, value, { id = '', attr = 'data-mf', title = '' } = {}) {
  return `<div class="prop-row"><label title="${escapeHtml(title || label)}">${label}</label>
    <input type="range" ${id ? `id="${id}"` : ''} ${attr}="${path}" min="${min}" max="${max}" step="${step}" value="${value}" />
    <span class="val" data-mv="${path}">${fmt(path, value)}</span></div>`;
}
const opt = (value, label, current) =>
  `<option value="${escapeHtml(value)}" ${String(value) === String(current) ? 'selected' : ''}>${escapeHtml(label)}</option>`;

function slotRow(slot, spec, m) {
  const def = TEXTURE_SLOTS[slot];
  const src = spec.maps[slot] ?? null;
  const embedded = slot !== 'orm' && m[slot] && !m[slot].userData.source && !m[slot].userData.assetId;
  const filled = !!(src || embedded);
  const name = src ? src.name : (embedded ? '(from the model)' : '—');
  const info = src?.procedural
    ? `made here · ${src.procedural.size}px`
    : src?.size ? `${src.size[0]}×${src.size[1]}${src.resizedFrom ? ` · resized from ${src.resizedFrom[0]}×${src.resizedFrom[1]}` : ''}` : '';
  const ids = slot === 'map' ? ['id="insp-tex-load"', 'id="insp-tex-clear"'] : ['', ''];
  let extra = '';
  if (filled && slot === 'normalMap') {
    extra = `<div class="tex-sub">
      ${range('normalStrength', 'Strength', 0, 3, 0.05, spec.normalStrength)}
      <label class="check-row" title="Normal maps made for DirectX / Unreal have green flipped"><input type="checkbox" data-mf="flipGreen" ${spec.flipGreen ? 'checked' : ''}/> DirectX style (flip green)</label>
    </div>`;
  }
  if (filled && (slot === 'aoMap' || slot === 'orm')) {
    extra = `<div class="tex-sub">${range('aoIntensity', 'AO strength', 0, 3, 0.05, spec.aoIntensity)}</div>`;
  }
  return `
    <div class="tex-slot${filled ? ' filled' : ''}" title="${escapeHtml(def.hint || '')}">
      <span class="tex-label">${def.label}</span>
      <span class="tex-name" title="${escapeHtml(name)}">${escapeHtml(name)}${info ? `<small>${escapeHtml(info)}</small>` : ''}</span>
      <button class="tbtn tex-btn" ${ids[0]} data-slot-load="${slot}" title="A picture — or a .glb / .gltf model, for its ${escapeHtml(def.label.toLowerCase())} picture">Load</button>
      <button class="gp-x" ${ids[1]} data-slot-clear="${slot}" ${filled ? '' : 'disabled'} title="Remove">×</button>
    </div>${extra}`;
}

function makerHtml(p) {
  const patterns = Object.entries(PATTERNS).map(([k, d]) => opt(k, d.label, p.pattern)).join('');
  const sizes = TEX_SIZES.map((s) => opt(s, `${s}px${s <= 128 ? ' (pixel art)' : ''}`, p.size)).join('');
  return `
    <div class="tex-maker">
      <div class="prop-row"><label>Pattern</label><select data-tg="pattern">${patterns}</select></div>
      <div class="prop-row"><label>Colours</label><span class="tex-colors">
        <input type="color" data-tg="colorA" value="${p.colorA}" title="Main colour" />
        <input type="color" data-tg="colorB" value="${p.colorB}" title="Second colour — mortar, grout, lines, grain" />
        <button class="tbtn tex-btn" data-act="reseed" title="Same settings, different randomness">🎲</button>
      </span></div>
      ${range('scale', 'Count', 1, 32, 1, p.scale, { attr: 'data-tg', title: 'How many squares / bricks / planks across' })}
      ${range('gap', 'Gap', 0, 0.4, 0.01, p.gap, { attr: 'data-tg', title: 'Mortar, grout or line width' })}
      ${range('variation', 'Variation', 0, 1, 0.01, p.variation, { attr: 'data-tg', title: 'How much each brick / tile differs' })}
      ${range('bump', 'Bumps', 0, 2, 0.05, p.bump, { attr: 'data-tg', title: 'Depth of the normal map (0 = flat)' })}
      <div class="prop-row"><label>Resolution</label><select data-tg="size">${sizes}</select></div>
    </div>`;
}

/** The whole panel for one mesh's material. */
export function materialPanelHtml(editor, mesh) {
  const m = mesh.material;
  if (!m || !m.isMeshStandardMaterial) {
    return '<div class="empty">This model uses its own material type; change it in a 3D tool.</div>';
  }
  const spec = materialSpec(m);
  const lib = editor.engine.materialLibrary;
  const names = lib ? [...lib.keys()] : [];
  const users = spec.library ? countUsers(editor.engine.scene, m) : 0;
  const hasTex = !!m.map;
  const anyTex = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap'].some((s) => m[s]);
  const made = spec.maps.map?.procedural;
  const report = _reports.get(m);
  const choice = _choices.get(m);

  return `<div class="mat-panel">
    <div class="prop-row"><label title="Save a material once, use it on many objects">Material</label>
      <select data-act="library">${opt('', 'Own (this object only)', spec.library || '')}${names.map((n) => opt(n, n, spec.library || '')).join('')}</select></div>
    ${spec.library
      ? `<div class="mat-note">Shared by ${users} object${users === 1 ? '' : 's'} — changes apply to all.
          <button class="tbtn tex-btn" data-act="unlink">Make unique</button></div>`
      : '<div class="mat-note"><button class="tbtn tex-btn" data-act="save-lib">Save to library…</button></div>'}

    <h4 class="insp-h">Surface</h4>
    <div class="prop-row"><label title="${hasTex ? 'Multiplies the texture — white shows it as-is' : ''}">${hasTex ? 'Tint' : 'Color'}</label>
      <input type="color" id="insp-mcolor" data-mf="color" value="${spec.color}" /></div>
    ${range('metalness', m.metalnessMap ? 'Metal ×' : 'Metalness', 0, 1, 0.01, spec.metalness, { id: 'insp-metal', title: m.metalnessMap ? 'Multiplies the metalness map' : '' })}
    ${range('roughness', m.roughnessMap ? 'Rough ×' : 'Roughness', 0, 1, 0.01, spec.roughness, { id: 'insp-rough', title: m.roughnessMap ? 'Multiplies the roughness map' : '' })}
    ${range('opacity', 'Opacity', 0, 1, 0.01, spec.opacity, { id: 'insp-opacity' })}
    <div class="prop-row"><label title="Cutout: hard edges from the alpha (leaves, fences). Blend: see-through (glass, water).">Transparency</label>
      <select data-mf="alphaMode">${opt('auto', 'Auto (by opacity)', spec.alphaMode)}${opt('cutout', 'Cutout — hard edges', spec.alphaMode)}${opt('blend', 'Blend — glass', spec.alphaMode)}</select></div>
    ${spec.alphaMode === 'cutout' ? range('alphaCutoff', 'Cutoff', 0.01, 0.99, 0.01, spec.alphaCutoff) : ''}
    <div class="prop-row"><label title="Emissive: the surface gives off its own light">Glow</label>
      <input type="color" data-mf="emissive" value="${spec.emissive}" /></div>
    ${range('emissiveIntensity', 'Glow ×', 0, 10, 0.1, spec.emissiveIntensity)}
    <label class="check-row"><input type="checkbox" id="insp-wire" data-mf="wireframe" ${spec.wireframe ? 'checked' : ''}/> Wireframe</label>

    <h4 class="insp-h">Textures</h4>
    <div class="tex-tools">
      <button class="tbtn tex-btn" data-act="load-set" title="Pick several images at once — each goes to the right slot by its file name (_normal, _rough, _ao…). Or pick a .glb / .gltf model (a .gltf with its files) to use its material: every picture and setting. You can also drop either onto this panel.">Load set…</button>
      <select data-act="make" title="Texture maker: a seamless texture with no image file">
        <option value="">Make…</option>${Object.entries(PATTERNS).map(([k, d]) => opt(k, d.label, '')).join('')}</select>
      <select data-act="max-size" title="Bigger images are resized to this, in powers of two">
        ${MAX_SIZES.map((s) => opt(s, `max ${s}`, maxSize())).join('')}</select>
    </div>
    ${choice ? chooserHtml(choice) : ''}
    ${_folders.has(m) ? `<div class="tex-choose"><div class="tex-choose-head"><span><b>${escapeHtml(_folders.get(m).name)}</b> keeps its
      pictures in its folder.</span><button class="gp-x" data-act="folder-cancel" title="Close">×</button></div>
      <button class="tbtn tex-btn" data-act="pick-folder" title="Choose the folder the model is in — its pictures are found inside, textures/ subfolders too">Choose its folder…</button></div>` : ''}
    ${report ? `<div class="tex-report">${escapeHtml(report.join('\n'))}</div>` : ''}
    <span id="insp-texname" hidden>${escapeHtml(hasTex ? (m.map.name || 'custom') : 'none')}</span>
    ${Object.keys(TEXTURE_SLOTS).map((slot) => slotRow(slot, spec, m)).join('')}
    ${made ? makerHtml(made) : ''}

    ${anyTex ? `
    <h4 class="insp-h">Placement</h4>
    <div class="vec-row"><label title="How many times the texture repeats">Tiling</label>
      <input type="number" data-mf="uv.repeat.0" min="0.01" step="0.1" value="${spec.uv.repeat[0]}" title="Across (U)" />
      <input type="number" data-mf="uv.repeat.1" min="0.01" step="0.1" value="${spec.uv.repeat[1]}" title="Up (V)" /><span></span></div>
    <div class="vec-row"><label title="Slide the texture">Offset</label>
      <input type="number" data-mf="uv.offset.0" step="0.05" value="${spec.uv.offset[0]}" />
      <input type="number" data-mf="uv.offset.1" step="0.05" value="${spec.uv.offset[1]}" /><span></span></div>
    ${range('uv.rotation', 'Rotation', -180, 180, 1, spec.uv.rotation)}
    <label class="check-row" title="Repeat by real size, so scaling the object adds more tiles instead of stretching them">
      <input type="checkbox" data-mf="uv.worldScale" ${spec.uv.worldScale ? 'checked' : ''}/> Tile by size (no stretching)</label>
    ${spec.uv.worldScale ? `<div class="prop-row"><label title="Metres covered by one repeat">Tile size</label>
      <input type="number" data-mf="uv.tileSize" min="0.05" step="0.05" value="${spec.uv.tileSize}" /><span class="val">m</span></div>` : ''}
    <div class="prop-row"><label title="What happens past the edge of the image">Edges</label>
      <select data-mf="uv.wrap">${opt('repeat', 'Repeat', spec.uv.wrap)}${opt('mirror', 'Mirror', spec.uv.wrap)}${opt('clamp', 'Stretch edge pixels', spec.uv.wrap)}</select></div>
    <div class="prop-row"><label title="Smooth: filtered and sharp at angles. Pixelated: crisp pixels for pixel art.">Look</label>
      <select data-mf="uv.filter">${opt('smooth', 'Smooth', spec.uv.filter)}${opt('pixel', 'Pixelated', spec.uv.filter)}</select></div>` : ''}
  </div>`;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}

/** Ask for pictures — or a model (a .gltf comes with its .bin and pictures, so several at once). */
function pickFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = PICK_ACCEPT;
    input.multiple = true;
    input.addEventListener('change', () => resolve([...(input.files || [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** Wire the panel rendered by materialPanelHtml. */
export function wireMaterialPanel(editor, mesh) {
  const root = editor.materialEl;
  const m = mesh.material;
  if (!root || !m || !m.isMeshStandardMaterial) return;
  const rerender = () => editor._renderMaterial(editor.selected);
  const lib = editor.engine.materialLibrary;
  const history = editor.history;

  const record = (label, before, after, target = m) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const go = (s) => {
      applyMaterialSpec(target, s).then(rerender);
      rerender();
    };
    history?.push({ label, undo: () => go(before), redo: () => go(after) });
  };
  const commit = async (label, next) => {
    const before = materialSpec(m);
    await applyMaterialSpec(m, normalizeSpec(next));
    record(label, before, materialSpec(m));
    rerender();
  };

  // ---- plain fields: sliders apply live, one undo step per drag
  root.querySelectorAll('[data-mf]').forEach((el) => {
    const path = el.dataset.mf;
    const read = () => {
      if (el.type === 'checkbox') return el.checked;
      if (el.type === 'range' || el.type === 'number') return Number(el.value);
      return el.value;
    };
    const set = () => {
      const s = materialSpec(m);
      setPath(s, path, read());
      applyMaterialSpec(m, s);
      const out = root.querySelector(`[data-mv="${path}"]`);
      if (out) out.textContent = fmt(path, read());
    };
    if (el.type === 'range' || el.type === 'color') {
      el.addEventListener('input', () => {
        if (!el._before) el._before = materialSpec(m);
        set();
      });
    }
    el.addEventListener('change', () => {
      const before = el._before || materialSpec(m);
      el._before = null;
      set();
      record(`material ${path}`, before, materialSpec(m));
      if (el.tagName === 'SELECT' || el.type === 'checkbox') rerender();
    });
  });

  // ---- one texture into one slot
  root.querySelectorAll('[data-slot-load]').forEach((btn) => btn.addEventListener('click', async () => {
    const slot = btn.dataset.slotLoad;
    const files = await pickFiles();
    if (files.some((f) => isModelFile(f.name))) { await fromModel(files, slot); return; }
    const file = files.find(isImageFile);
    if (!file) return;
    try {
      const src = await importTextureFile(file, maxSize());
      const { directX } = classifyTexture(file.name);
      await commit(`load ${TEXTURE_SLOTS[slot].label}`, withTexture(materialSpec(m), slot, src, { directX }));
    } catch (err) {
      console.error('[Tiny3] texture import failed:', err);
    }
  }));
  root.querySelectorAll('[data-slot-clear]').forEach((btn) => btn.addEventListener('click', () => {
    const slot = btn.dataset.slotClear;
    commit(`remove ${TEXTURE_SLOTS[slot].label}`, withTexture(materialSpec(m), slot, null));
  }));

  // ---- a model's material: every picture and setting of it, or one slot's picture
  const importImage = (data) => importTextureFile(new File([data.bytes], data.name, { type: data.type }), maxSize());
  const decodeKtx2 = (data) => ktx2ToPng(data, editor.engine.renderer, maxSize());
  const say = (lines) => { _reports.set(m, lines); rerender(); };

  const useModelMaterial = async (model, index, slot) => {
    closeChooser(m);
    const mat = model.materials[index];
    try {
      if (slot) {
        const { data, why } = modelSlotImage(model, index, slot);
        if (!data) { say([`${model.name}: ${why}.`]); return; }
        const picture = data.type === 'image/ktx2' ? await decodeKtx2(data) : data;
        const src = await importImage(picture);
        _reports.set(m, [`${TEXTURE_SLOTS[slot].label} ← ${picture.name} (from "${mat.name}" in ${model.name})`]);
        await commit(`load ${TEXTURE_SLOTS[slot].label}`, withTexture(materialSpec(m), slot, src));
        return;
      }
      const { spec, lines } = await modelMaterialSpec(model, index, { importImage, decodeKtx2 });
      const current = materialSpec(m);
      if (current.library) spec.library = current.library; // a shared material stays shared
      _reports.set(m, [`"${mat.name}" from ${model.name}:`, ...lines]);
      await commit(`material from ${model.name}`, spec);
    } catch (err) {
      console.error('[Tiny3] material from model failed:', err);
      say([`${model.name} → failed: ${err.message}`]);
    }
  };

  const fromModel = async (files, slot = null, prefer = null) => {
    let model;
    _folders.delete(m);
    try {
      model = await readModelMaterials(files, { prefer });
    } catch (err) {
      // its pictures are in a folder beside it: offer to choose that folder
      const name = files.map((f) => f.file ?? f).find((f) => isModelFile(f.name))?.name;
      if (err.needsFolder && name) _folders.set(m, { name, slot });
      say([`Could not read the model. ${err.message}`]);
      return;
    }
    if (!model) return;
    if (!model.materials.length) { say([`${model.name} has no materials in it — only shapes.`]); return; }
    if (model.materials.length === 1) { await useModelMaterial(model, 0, slot); return; }
    // several: offer them, each with its colour picture as a thumbnail
    const thumbs = model.materials.map((mat) => {
      const ref = mat.maps.map;
      const data = ref && ref.image !== undefined ? imageData(model.gltf, ref.image) : null;
      return data && data.type !== 'image/ktx2' ? URL.createObjectURL(new Blob([data.bytes], { type: data.type })) : null;
    });
    closeChooser(m);
    _choices.set(m, { model, slot, thumbs });
    _reports.delete(m);
    rerender();
  };

  root.querySelectorAll('[data-choose]').forEach((btn) => btn.addEventListener('click', () => {
    const choice = _choices.get(m);
    if (choice) useModelMaterial(choice.model, Number(btn.dataset.choose), choice.slot);
  }));
  root.querySelector('[data-act="pick-folder"]')?.addEventListener('click', async () => {
    const wanted = _folders.get(m);
    const files = await pickFolder();
    if (files.length && wanted) await fromModel(files, wanted.slot, wanted.name);
  });
  root.querySelector('[data-act="folder-cancel"]')?.addEventListener('click', () => {
    _folders.delete(m);
    rerender();
  });
  root.querySelector('[data-act="choose-cancel"]')?.addEventListener('click', () => {
    closeChooser(m);
    rerender();
  });

  // ---- a whole texture set, sorted by file name
  const loadImageSet = async (files) => {
    if (!files.length) return;
    let spec = materialSpec(m);
    const lines = [];
    for (const file of files) {
      const { slot, directX } = classifyTexture(file.name);
      const target = slot || (!spec.maps.map ? 'map' : null);
      if (!target || target === 'height') {
        lines.push(`${file.name} → skipped${target === 'height' ? ' (height maps are not supported yet)' : ' (unknown kind — load it into a slot)'}`);
        continue;
      }
      try {
        spec = withTexture(spec, target, await importTextureFile(file, maxSize()), { directX });
        lines.push(`${file.name} → ${TEXTURE_SLOTS[target].label}${directX && target === 'normalMap' ? ' (DirectX)' : ''}`);
      } catch (err) {
        lines.push(`${file.name} → failed: ${err.message}`);
      }
    }
    _reports.set(m, lines);
    await commit('load texture set', spec);
  };
  root.querySelector('[data-act="load-set"]')?.addEventListener('click', async () => {
    const files = await pickFiles();
    if (files.some((f) => isModelFile(f.name))) await fromModel(files);
    else if (files.length) await loadImageSet(files.filter(isImageFile));
  });
  // files dropped on the panel (see game.js): a model's material, or a set of pictures
  root.onFiles = (entries) => {
    const files = entries.map((e) => e.file ?? e);
    if (files.some((f) => isModelFile(f.name))) return fromModel(entries);
    const images = files.filter(isImageFile);
    return images.length ? loadImageSet(images) : say(['Drop pictures, or a .glb / .gltf model, here.']);
  };

  // ---- texture maker
  root.querySelector('[data-act="make"]')?.addEventListener('change', (e) => {
    const pattern = e.target.value;
    e.target.value = '';
    if (!pattern) return;
    const params = normalizeTexParams({ pattern, seed: 1 + Math.floor(Math.random() * 2147483645) });
    commit(`make ${PATTERNS[pattern].label}`, withMadeTexture(materialSpec(m), params));
  });
  const remake = (label, patch) => {
    const spec = materialSpec(m);
    const current = spec.maps.map?.procedural;
    if (!current) return;
    commit(label, withMadeTexture(spec, { ...current, ...patch }));
  };
  root.querySelectorAll('[data-tg]').forEach((el) => {
    const key = el.dataset.tg;
    if (el.type === 'range') {
      el.addEventListener('input', () => {
        const out = root.querySelector(`[data-mv="${key}"]`);
        if (out) out.textContent = fmt(key, el.value);
      });
    }
    el.addEventListener('change', () => {
      const value = el.type === 'range' || key === 'size' ? Number(el.value) : el.value;
      remake('tweak texture', { [key]: value });
    });
  });
  root.querySelector('[data-act="reseed"]')?.addEventListener('click', () =>
    remake('vary texture', { seed: 1 + Math.floor(Math.random() * 2147483645) }));

  root.querySelector('[data-act="max-size"]')?.addEventListener('change', (e) => {
    try { localStorage.setItem(MAX_PREF, e.target.value); } catch (_) { /* private mode */ }
  });

  // ---- material library
  root.querySelector('[data-act="save-lib"]')?.addEventListener('click', () => {
    if (!lib) return;
    const base = mesh.parent?.name || editor.selected?.object3D?.name || 'Material';
    const name = (prompt('Name for this material (other objects can then use it):', `${base} material`) || '').trim();
    if (!name) return;
    if (lib.has(name) && lib.get(name) !== m) { alert(`There is already a material called "${name}".`); return; }
    const link = () => {
      m.userData.t3 = { ...(m.userData.t3 || {}), library: name };
      lib.set(name, m);
      rerender();
    };
    const unlinkIt = () => {
      if (lib.get(name) === m) lib.delete(name);
      if (m.userData.t3) delete m.userData.t3.library;
      rerender();
    };
    link();
    history?.push({ label: 'save material', undo: unlinkIt, redo: link });
  });

  root.querySelector('[data-act="library"]')?.addEventListener('change', (e) => {
    const name = e.target.value;
    const prev = mesh.material;
    let next;
    if (name) {
      next = lib?.get(name);
      if (!next || next === prev) return;
    } else {
      next = cloneMaterial(prev); // its own copy, with its own textures
    }
    mesh.material = next;
    history?.push({
      label: name ? 'use library material' : 'make material unique',
      undo: () => { mesh.material = prev; rerender(); },
      redo: () => { mesh.material = next; rerender(); },
    });
    rerender();
  });
  root.querySelector('[data-act="unlink"]')?.addEventListener('click', () => {
    const select = root.querySelector('[data-act="library"]');
    select.value = '';
    select.dispatchEvent(new Event('change'));
  });
}
