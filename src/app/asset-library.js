import * as THREE from 'three';
import { escapeHtml } from '../editor.js';
import { assetStore } from '../assets-db.js';
import { assetUses } from '../asset-refs.js';
import { showNotice } from '../ui.js';
import { convertModel, CONVERTIBLE } from '../model-import.js';
import { shrinkGlb, formatSize } from '../asset-compress.js';

/**
 * The asset library — everything a game can use, in the Asset Browser:
 *
 *   Models      imported (.glb, .gltf, .obj, .fbx, .stl), with a picture of each
 *   Animations  clips from other files
 *   Textures    pictures put on surfaces
 *   Sounds      sound files
 *   Built-in    the engine's own models (assets/library.json)
 *
 * Search by name, filter by kind; each shows its size and how many times the
 * game uses it. Click a model to place it, a texture to put it on the selected
 * object, a sound to hear it; rename one, or delete one nothing uses.
 *
 * And how models are imported: textures made no bigger than a size, opaque
 * ones stored as JPEG (asset-compress.js); .obj, .fbx and .stl made into .glb
 * (model-import.js). Those settings are this browser's, not the game's.
 */

const SETTINGS_KEY = 't3.importSettings';
const THUMBS_KEY = 't3.builtinThumbs';
const KINDS = { model: 'Models', animation: 'Animations', texture: 'Textures', audio: 'Sounds' };
const ICONS = { model: '🧊', animation: '🏃', texture: '🖼', audio: '🔊' };

/** How models are imported (this browser's choice): { maxTexture: 0 (as they are) | 1024 | 2048 | 4096, jpeg }. */
export function importSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { maxTexture: [0, 1024, 2048, 4096].includes(s.maxTexture) ? s.maxTexture : 2048, jpeg: s.jpeg !== false };
  } catch {
    return { maxTexture: 2048, jpeg: true };
  }
}
function saveImportSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
}

// ---------------------------------------------------------------- pictures

/** A small picture of a model, drawn with the editor's renderer, as a data URL. */
export function modelThumb(renderer, root, environment = null, size = 128) {
  const scene = new THREE.Scene();
  scene.environment = environment;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  scene.add(root);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return null;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const camera = new THREE.PerspectiveCamera(35, 1, sphere.radius * 0.05, sphere.radius * 20);
  const dir = new THREE.Vector3(1, 0.7, 1.4).normalize();
  camera.position.copy(sphere.center).addScaledVector(dir, sphere.radius / Math.sin(THREE.MathUtils.degToRad(35 / 2)) * 1.05);
  camera.lookAt(sphere.center);
  const target = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
  const before = renderer.getRenderTarget();
  const clear = renderer.getClearColor(new THREE.Color());
  const alpha = renderer.getClearAlpha();
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);
  const px = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(target, 0, 0, size, size, px);
  renderer.setRenderTarget(before);
  renderer.setClearColor(clear, alpha);
  target.dispose();
  scene.remove(root);
  // into a canvas, the right way up
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) img.data.set(px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/webp', 0.85);
}

/** A small picture of a picture. */
async function imageThumb(blob, size = 96) {
  const bitmap = await createImageBitmap(blob);
  const s = size / Math.max(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * s));
  canvas.height = Math.max(1, Math.round(bitmap.height * s));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/webp', 0.85);
}

// ---------------------------------------------------------------- the panel

export function wireAssetLibrary(app) {
  const { engine, editor, assets } = app;
  const listEl = document.getElementById('library-list');
  const searchEl = document.getElementById('library-search');
  const kindsEl = document.getElementById('library-kinds');
  if (!listEl) return;

  // ---- importing: other formats into .glb, and textures made smaller
  assets.convertModel = convertModel;
  assets.convertible = CONVERTIBLE;
  assets.shrinkModel = async (file) => {
    const s = importSettings();
    if (!s.maxTexture && !s.jpeg) return null;
    const r = await shrinkGlb(await file.arrayBuffer(), { maxSize: s.maxTexture || 16384, jpeg: s.jpeg });
    return r.images ? { file: new File([r.bytes], file.name, { type: 'model/gltf-binary' }), images: r.images } : null;
  };
  const maxEl = document.getElementById('import-max-texture');
  const jpegEl = document.getElementById('import-jpeg');
  const s0 = importSettings();
  if (maxEl) maxEl.value = String(s0.maxTexture);
  if (jpegEl) jpegEl.checked = s0.jpeg;
  const keep = () => saveImportSettings({ maxTexture: Number(maxEl?.value) || 0, jpeg: !!jpegEl?.checked });
  maxEl?.addEventListener('change', keep);
  jpegEl?.addEventListener('change', keep);

  let kind = 'all';
  let builtin = [];
  let thumbing = false;
  const builtinThumbs = (() => { try { return JSON.parse(localStorage.getItem(THUMBS_KEY) || '{}'); } catch { return {}; } })();

  fetch('assets/library.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
    builtin = (j?.models || []).filter((m) => typeof m.url === 'string');
    render();
  }).catch(() => {});

  /** Every stored file the library shows (not the game's icon), with how many times the game uses it. */
  async function entries() {
    const uses = app.project ? assetUses(app.project.toJSON()) : new Map(); // every level and prefab of the game
    const stored = (await assetStore.list())
      .filter((m) => KINDS[m.kind])
      .map((m) => ({ ...m, uses: uses.get(m.id) || 0 }));
    const fromEngine = builtin.map((b) => ({ id: `builtin:${b.url}`, url: b.url, name: b.name, kind: 'builtin', tags: b.tags || [], thumb: builtinThumbs[b.url] }));
    return [...stored, ...fromEngine];
  }

  function card(a) {
    const icon = a.kind === 'builtin' ? '🧊' : ICONS[a.kind];
    const pic = a.thumb ? `<img src="${a.thumb}" alt="" loading="lazy">` : `<span class="lib-ico">${icon}</span>`;
    const used = a.kind === 'builtin' ? '<span class="lib-tag">built-in</span>'
      : `<span class="lib-uses${a.uses ? '' : ' none'}" title="${a.uses ? `Used ${a.uses} time${a.uses === 1 ? '' : 's'} in this game` : 'Not used in this game'}">${a.uses ? `×${a.uses}` : 'unused'}</span>`;
    const title = a.kind === 'model' || a.kind === 'builtin' ? 'Click to place it in front of the view'
      : a.kind === 'texture' ? 'Click to put it on the selected object' : a.kind === 'audio' ? 'Click to hear it' : '';
    return `<div class="lib-card" data-asset="${escapeHtml(a.id)}" title="${escapeHtml(title)}">
      <div class="lib-pic">${pic}</div>
      <div class="lib-name">${escapeHtml(a.name.replace(/\.(glb|gltf|png|jpe?g|webp|ogg|mp3|wav)$/i, ''))}</div>
      <div class="lib-meta">${a.size ? formatSize(a.size) : ''} ${used}</div>
      ${a.kind === 'builtin' ? '' : `<div class="lib-actions"><button class="gp-x" data-rename title="Rename">✎</button>${a.uses ? '' : '<button class="gp-x" data-delete title="Delete it (nothing uses it)">×</button>'}</div>`}
    </div>`;
  }

  let shown = [];
  async function render() {
    const all = await entries();
    const q = (searchEl?.value || '').trim().toLowerCase();
    shown = all.filter((a) => (kind === 'all' || a.kind === kind)
      && (!q || a.name.toLowerCase().includes(q) || (a.tags || []).some((t) => t.includes(q))));
    const counts = { all: all.length };
    for (const a of all) counts[a.kind] = (counts[a.kind] || 0) + 1;
    if (kindsEl) {
      kindsEl.innerHTML = [['all', 'All'], ...Object.entries(KINDS), ['builtin', 'Built-in']]
        .filter(([k]) => k === 'all' || counts[k])
        .map(([k, label]) => `<button class="tbtn${k === kind ? ' active' : ''}" data-kind="${k}">${label} <small>${counts[k] || 0}</small></button>`).join('');
    }
    listEl.innerHTML = shown.length ? shown.map(card).join('')
      : `<div class="empty">${all.length ? 'Nothing matches.' : 'Nothing here yet. Import a model (.glb, .gltf, .obj, .fbx, .stl), or drop one on the view.'}</div>`;
    makeThumbs(shown);
  }

  /** Pictures for what has none yet: a model drawn, a texture shrunk. One at a time, after the list shows. */
  async function makeThumbs(list) {
    // only once the library is on screen: an editor starting with it folded away loads no models for it
    if (thumbing || !listEl.getClientRects().length) return;
    thumbing = true;
    try {
      for (const a of list) {
        if (a.thumb) continue;
        let thumb = null;
        if (a.kind === 'model' || a.kind === 'builtin') {
          const root = a.kind === 'builtin' ? await assets.load(a.url) : await assets.loadFromStore(a.id);
          thumb = modelThumb(engine.renderer, root, engine.scene.environment);
        } else if (a.kind === 'texture') {
          const rec = await assetStore.get(a.id);
          if (rec) thumb = await imageThumb(new Blob([rec.data], { type: rec.mime }));
        }
        if (!thumb) continue;
        a.thumb = thumb;
        if (a.kind === 'builtin') {
          builtinThumbs[a.url] = thumb;
          try { localStorage.setItem(THUMBS_KEY, JSON.stringify(builtinThumbs)); } catch { /* full: drawn again next time */ }
        } else {
          await assetStore.update(a.id, { thumb });
        }
        const img = listEl.querySelector(`[data-asset="${CSS.escape(a.id)}"] .lib-pic`);
        if (img) img.innerHTML = `<img src="${thumb}" alt="">`;
      }
    } catch (err) {
      console.warn('[Tiny3] a library picture could not be made:', err);
    } finally {
      thumbing = false;
    }
  }

  /** Use one: place a model, put a texture on the selected object, hear a sound. */
  async function use(a) {
    if (app.isPlaying()) { showNotice('Stop the game first.', { kind: 'warn' }); return; }
    if (a.kind === 'model') {
      const root = await assets.loadFromStore(a.id, { name: a.name.replace(/\.glb$/i, '') });
      app.addImported([root]);
    } else if (a.kind === 'builtin') {
      // into this game's own files, as if imported: an exported game carries it
      const bytes = await (await fetch(a.url)).arrayBuffer();
      const meta = await assetStore.put(new File([bytes], a.url.split('/').pop(), { type: 'model/gltf-binary' }), { kind: 'model' });
      if (!meta.thumb && a.thumb) await assetStore.update(meta.id, { thumb: a.thumb, name: a.name });
      const root = await assets.loadFromStore(meta.id, { name: a.name });
      app.addImported([root]);
    } else if (a.kind === 'texture') {
      const take = editor.materialEl?.onFiles;
      if (!editor.selected || !take) { showNotice('Select an object first: the texture goes on its surface.', { kind: 'warn' }); return; }
      const rec = await assetStore.get(a.id);
      await take([new File([rec.data], a.name, { type: rec.mime })]);
    } else if (a.kind === 'audio') {
      const url = await assetStore.objectURL(a.id);
      new window.Audio(url).play().catch(() => {});
    }
    render();
  }

  listEl.addEventListener('click', async (e) => {
    const cardEl = e.target.closest('[data-asset]');
    if (!cardEl) return;
    const a = shown.find((x) => x.id === cardEl.dataset.asset);
    if (!a) return;
    if (e.target.closest('[data-rename]')) {
      const name = prompt('Name:', a.name);
      if (name && name.trim()) { await assetStore.update(a.id, { name: name.trim() }); render(); }
      return;
    }
    if (e.target.closest('[data-delete]')) {
      if (a.uses) return;
      if (!confirm(`Delete "${a.name}" from this browser? Nothing in this game uses it.`)) return;
      await assetStore.delete(a.id);
      render();
      app.refreshStorage?.();
      return;
    }
    use(a).catch((err) => showNotice(`Could not use ${a.name}: ${err.message}`, { kind: 'error' }));
  });
  kindsEl?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    kind = b.dataset.kind;
    render();
  });
  searchEl?.addEventListener('input', () => render());
  document.getElementById('btn-library-import')?.addEventListener('click', () => app.importModel());
  // the panel's tabs: the library, the game's prefabs
  for (const b of document.querySelectorAll('[data-asset-tab]')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('[data-asset-tab]')) x.classList.toggle('active', x === b);
      for (const p of document.querySelectorAll('[data-asset-page]')) p.hidden = p.dataset.assetPage !== b.dataset.assetTab;
      if (b.dataset.assetTab === 'library') render();
    });
  }
  document.getElementById('asset-browser')?.addEventListener('pointerenter', () => render());
  render();
  Object.assign(app, { renderLibrary: render });
}

/** What an import did, said once: converted, made smaller, textures it couldn't find. */
export function importNotes(notes = []) {
  for (const n of notes) {
    const parts = [];
    if (/\.(obj|fbx|stl)$/i.test(n.name)) parts.push('made into a .glb');
    if (n.images) parts.push(`${n.images} texture${n.images === 1 ? '' : 's'} made smaller: ${formatSize(n.before)} → ${formatSize(n.after)}`);
    if (n.missing?.length) parts.push(`not found (drop them with it): ${n.missing.slice(0, 4).join(', ')}${n.missing.length > 4 ? '…' : ''}`);
    if (parts.length) showNotice(`${n.name}: ${parts.join(' · ')}`, { kind: n.missing?.length ? 'warn' : 'info', seconds: 8 });
  }
}
