/**
 * Tiny3 Exporter — the game, playable without the editor. Two ways:
 *
 *   One file (.html): everything inside it — Three.js, the engine, the levels,
 *   every model, sound and texture. It runs from anywhere: a web server, a
 *   shared drive, or double-clicked straight from Downloads. (It used to load
 *   ./lib and ./src from next to itself, so opened anywhere else the browser
 *   blocked every script and the game was a blank, dark page.)
 *
 *   A website (.zip, or straight into a folder): index.html and the game's
 *   files, for GitHub Pages or any web host — smaller, cached, loaded in
 *   parallel (see buildSite).
 */
import { assetStore } from './assets-db.js';
import { collectModules, bootBundle, BARE } from './bundle.js';
import { assetIdsIn } from './asset-refs.js';
import { DECODERS, decodersNeeded } from './gltf-files.js';
import { makeZip } from './zip.js';

/**
 * The exported game's entry module. Its imports are packed into the bundle,
 * so the paths below are resolved at export time, not when the game runs.
 * It sets the game up exactly as Play mode does, so what you export is what
 * you played.
 */
export const GAME_ENTRY = `import { i18n, t } from './src/i18n.js';
import { assetStore } from './src/assets-db.js';
import { Engine } from './src/engine.js';
import { CameraRig } from './src/cameras.js';
import { AssetLoader } from './src/loader.js';
import { SceneSerializer } from './src/scene.js';
import { Project } from './src/project.js';
import { Player } from './src/player.js';
import { PlayOverlay } from './src/play-overlay.js';
import { controlsHint } from './src/controls.js';
import * as THREE from 'three';

/**
 * The game's data. One file: it is all inside this page. A website: the levels
 * are game.json and every model, texture and sound a file of its own, next to
 * this page — read when it is needed, cached by the browser.
 */
async function gameData() {
  const inPage = document.getElementById('scene-data');
  if (inPage) {
    assetStore.seed(JSON.parse(document.getElementById('asset-data').textContent));
    // ...and the decoders its compressed models need (Draco, KTX2), if any
    const decoderFiles = {};
    for (const [name, b64] of Object.entries(JSON.parse(document.getElementById('decoder-data')?.textContent || '{}'))) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      decoderFiles[name] = URL.createObjectURL(new Blob([bytes]));
    }
    return { scene: JSON.parse(inPage.textContent), decoderFiles };
  }
  const read = async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(path + ': HTTP ' + response.status + ' — is every file of the game uploaded?');
    return response.json();
  };
  const [scene, files] = await Promise.all([read('game.json'), read('assets.json')]);
  assetStore.seedFiles(files);
  return { scene, decoderFiles: null }; // the decoders sit in lib/libs, where the loader looks
}

async function boot() {
  const loading = document.getElementById('loading');
  const { scene, decoderFiles } = await gameData();

  const engine = new Engine({ background: 0x0b0e14 });
  engine.playing = true; // an exported game is always in play mode
  engine.grid.visible = false; // the editor's grid is not part of the game
  const rig = new CameraRig(engine.camera, engine.renderer.domElement);
  engine.cameraRig = rig;
  rig.enabled = true;
  rig.physics = engine.physics; // the follow camera keeps out of walls

  const assets = new AssetLoader({ renderer: engine.renderer, decoderFiles });

  // the smallest editor the serializer needs to rebuild a scene
  const editor = {
    selectables: [],
    selected: null,
    select(e) { this.selected = e; },
    register(e) { if (!this.selectables.includes(e)) this.selectables.push(e); },
    unregister(e) {
      const i = this.selectables.indexOf(e);
      if (i !== -1) this.selectables.splice(i, 1);
    },
    _renderHierarchy() {},
  };

  // the player must exist before the scene loads, so the scene can restore it
  const player = engine.add(new Player());
  engine.player = player;

  const serializer = new SceneSerializer(engine, editor, rig, player, assets);
  // spawners, "Spawn prefab" rules and "Shoot" controls build prefabs here
  engine.gameplay.spawnPrefab = (name, position) => serializer.spawnPrefab(name, position);
  const project = new Project(serializer);
  // the loading screen fills as the models arrive
  serializer.onProgress = (done, total) => {
    const bar = loading?.querySelector('i');
    if (bar) bar.style.width = Math.round((done / Math.max(1, total)) * 100) + '%';
  };
  // every level is in the game's data; it begins at the start level
  await project.load(scene, { at: 'start' });
  // in the player's language (their pick, or their browser's) — before anything is said: see i18n.js
  i18n.load(engine.ui.languages, { game: engine.ui.game?.name || document.title });
  serializer.onProgress = null;
  loading?.remove();

  // Only with the environment switched off and no lights of its own does a
  // level need a fallback light, or it would be black.
  let fallbackLight = null;
  const ensureLight = () => {
    if (fallbackLight) engine.scene.remove(fallbackLight);
    fallbackLight = null;
    if (engine.environment.enabled) return;
    let hasLight = false;
    engine.scene.traverse((n) => { if (n.isLight && n.visible) hasLight = true; });
    if (!hasLight) {
      fallbackLight = new THREE.AmbientLight(0xffffff, 0.4);
      engine.scene.add(fallbackLight);
    }
  };
  ensureLight();

  // the scene's own controls: its keys in the help line, its touch buttons on screen
  const hint = document.getElementById('hint');
  // the player's a car: W the throttle, Space the handbrake; cars to get into: their key
  const comps = engine.gameplay.components;
  const vehicles = comps.instances.filter((c) => c.type === 'vehicle');
  const driving = vehicles.some((c) => c.entity === engine.playerEntity);
  const doors = vehicles.find((c) => c.entity !== engine.playerEntity && (c.props.enterKey ?? 'E') !== 'none');
  let keys = controlsHint(engine.gameplay.controls.list, { vehicle: driving });
  if (doors) keys += (keys ? ' · ' : '') + (doors.props.enterKey ?? 'E') + ' get in / out';
  if (keys) hint.textContent = t('Click to focus') + ' · ' + t('Esc pause') + ' · ' + keys;
  else hint.remove();
  // score & co. on screen; 🔊 and ⏸ top-right (touch screens have no Esc key)
  const overlay = new PlayOverlay(engine, { muteButton: true, hud: true, pauseButton: true });
  overlay.loadVolume(); // the volume this player chose last time
  engine.onMessage = (text, opts) => overlay.message(text, opts); // the Show message action
  // the game's own camera ("When playing"); follow / first person with no target use the player
  const playCamera = () => {
    rig.fallbackTarget = engine.playerEntity?.object3D ?? null;
    if (rig.playMode && rig.playMode !== rig.mode) rig.setMode(rig.playMode, { target: rig.target });
  };
  playCamera();
  // first person: a click takes the mouse for looking around (Esc gives it back)
  engine.renderer.domElement.addEventListener('click', () => {
    if (rig.wantsPointerLock()) engine.input.requestPointerLock();
  });
  if (rig.wantsPointerLock() && hint.isConnected) hint.textContent = t('Click to look around') + ' · ' + (keys || '');

  // browsers keep audio silent until the first click or key press
  const unlock = () => engine.unlockAudio();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  engine.audio.startAutoplay(); // music and ambience marked "on start"

  engine.onUpdate = (dt) => {
    if (rig.enabled !== false) rig.update(dt, engine.input);
    overlay.update();
  };

  // the variables as each level began, so "Restart level" can put them back
  let levelStartValues = null;
  /** Load a level and start playing it; \`values\` replaces the variables first. */
  const enterLevel = async (index, values = null) => {
    engine.stopAllSounds();
    overlay.hide();
    await project.loadLevel(index, { keepValues: true });
    if (values) for (const [name, value] of Object.entries(values)) engine.variables.set(name, value);
    ensureLight();
    engine.player = player;
    playCamera();
    engine.gameplay.start({ keepVariables: true });
    levelStartValues = { ...engine.variables.values };
    overlay.show();
    overlay.announce(project.levels[index].name);
    engine.audio.startAutoplay();
  };

  engine.gameplay.levelName = () => project.levels[project.active]?.name ?? ''; // a saved game keeps it
  // installable (a website with its manifest): offered by a button, when the browser says it can be
  let installPrompt = window.__tiny3InstallPrompt || null;
  const offerInstall = () => overlay.setInstall(installPrompt ? async () => {
    installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') { installPrompt = null; overlay.setInstall(null); }
  } : null);
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; offerInstall(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; overlay.setInstall(null); });
  offerInstall();
  // moving between levels: the score carries over; past the last level, you win
  engine.gameplay.onGoToLevel = async (target) => {
    const index = project.resolve(target);
    if (index < 0) {
      const t = String(target || '').trim().toLowerCase();
      if (!t || t === 'next') engine.gameplay.finish('win', 'You finished the game!');
      return;
    }
    await enterLevel(index);
  };

  // ---- the pause menu: Esc, P, the ⏸ button, losing the mouse, or leaving the tab ----
  let titleUp = false;
  const pause = () => {
    if (titleUp || overlay.pauseOpen || engine.gameplay.loading) return;
    engine.paused = true;
    engine.input.releaseVirtual?.(); // a held on-screen button must not stay held
    engine.input.exitPointerLock();
    overlay.pauseMenu({
      level: project.levels.length > 1 ? project.levels[project.active].name : '',
      keys,
      onResume: () => {
        engine.paused = false;
        if (rig.wantsPointerLock()) engine.input.requestPointerLock(); // the click is the gesture it needs
      },
      onRestartLevel: async () => {
        await enterLevel(project.active, levelStartValues);
        engine.paused = false;
      },
      onRestartGame: () => location.reload(),
    });
  };
  overlay.onPauseButton = pause;
  engine.onPauseKey = pause;
  window.addEventListener('keydown', (e) => { if (e.code === 'Escape') pause(); });
  // first person: Esc goes to the browser (it frees the mouse), so the lost lock is the signal
  document.addEventListener('pointerlockchange', () => {
    // ...unless one of the game's screens or a dialogue took the mouse back, for clicking on it
    if (!document.pointerLockElement && rig.wantsPointerLock() && !engine.paused && !engine.gameplay.screens?.active) pause();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  // winning or losing says so; R (or a Restart rule) plays again from the start
  engine.gameplay.onFinish = ({ result, message }) => {
    overlay.announce(message || (result === 'win' ? 'You win!' : 'Game over'),
      { sub: 'Press R to play again', stay: true });
  };
  engine.gameplay.onRestart = () => location.reload();
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && engine.gameplay.outcome) location.reload();
  });

  engine.gameplay.start(); // start rules, timers and components, as Play does
  levelStartValues = { ...engine.variables.values };
  overlay.show();
  const firstLevelName = () => {
    if (project.levels.length > 1) overlay.announce(project.levels[project.active].name);
  };
  if (engine.ui.title.enabled) {
    // the title screen: the game waits behind it until a key or a click
    engine.paused = true;
    titleUp = true;
    overlay.titleScreen(engine.ui.title).then(() => { titleUp = false; engine.paused = false; firstLevelName(); });
  } else {
    firstLevelName();
  }
  window.__tiny3Game = { engine, player, rig, overlay, project };
  engine.start();
}

boot().catch((err) => {
  console.error('[Tiny3 Game] boot failed:', err);
  document.body.innerHTML = '<pre style="color:#f47067;padding:20px;white-space:pre-wrap">'
    + (err.stack || err.message) + '</pre>';
});
`;

/** The game's name, as a file name: "My Game!" -> "my-game". */
export function fileSlug(name, fallback = 'tiny3-game') {
  const slug = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || fallback;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * What makes a website an app: its name, how it opens (full screen, either
 * way up), its colours and icons.
 */
export function webManifest(name, icons = []) {
  return {
    name,
    short_name: name.length > 12 ? name.slice(0, 12).trim() : name,
    start_url: './',
    scope: './',
    display: 'fullscreen',
    orientation: 'any',
    background_color: '#0b0e14',
    theme_color: '#0b0e14',
    icons: icons.map((i) => ({ src: i.path, sizes: `${i.size}x${i.size}`, type: 'image/png', purpose: 'any maskable' })),
  };
}

/**
 * The service worker: every file of the game kept by the browser the first
 * time it is played, then played from there. Offline too, and quick. A new
 * export is a new cache (`prefix` and when it was made); the old one is
 * dropped. Other games on the same website keep theirs.
 */
export function serviceWorker(prefix, paths) {
  const cache = prefix + Date.now().toString(36);
  const files = ['./', ...paths];
  return `// Tiny3: this game, offline. Made by the export: a new export replaces it.
const CACHE = ${JSON.stringify(cache)};
const FILES = ${JSON.stringify(files)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith(${JSON.stringify(prefix)}) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && new URL(e.request.url).origin === location.origin) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  })));
});
`;
}

/**
 * The app's icons, 192 and 512 pixels: the game's icon image, or its emoji,
 * on the game's dark background with room round it (a phone may round the
 * corners off). None where there's no canvas to draw them (tests).
 */
export async function appIcons(emoji, imageRecord = null) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return [];
  let bitmap = null;
  if (imageRecord?.data && typeof createImageBitmap === 'function') {
    try { bitmap = await createImageBitmap(new Blob([imageRecord.data], { type: imageRecord.mime })); } catch { bitmap = null; }
  }
  const out = [];
  for (const size of [192, 512]) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext?.('2d');
    if (!ctx || typeof canvas.toBlob !== 'function') return [];
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, size, size);
    const inner = size * 0.64; // the safe middle of a rounded icon
    if (bitmap) {
      const k = Math.min(inner / bitmap.width, inner / bitmap.height);
      ctx.drawImage(bitmap, (size - bitmap.width * k) / 2, (size - bitmap.height * k) / 2, bitmap.width * k, bitmap.height * k);
    } else {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${Math.round(inner * 0.85)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
      ctx.fillText(emoji || '🎮', size / 2, size / 2 + size * 0.03);
    }
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) return [];
    out.push({ path: `icon-${size}.png`, size, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  return out;
}

/** An emoji as a browser-tab icon. */
export function emojiIcon(emoji) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='0.9em' font-size='90'>${emoji}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** What goes in <head> and first in <body> of either export: name, icon, styles, loading screen. */
function pageTop(name, iconHref) {
  return {
    head: `<meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(name)}</title>
  <link rel="icon" href="${escapeHtml(iconHref)}" />
  <style>
    html, body { margin: 0; padding: 0; overflow: hidden; background: #0b0e14; }
    canvas { display: block; }
    #hint {
      position: fixed; top: 12px; left: 12px; color: #8b949e;
      font-family: system-ui, sans-serif; font-size: 12px; pointer-events: none;
      background: rgba(13,17,23,0.8); padding: 6px 10px; border-radius: 6px;
      border: 1px solid #30363d;
    }
    #loading {
      position: fixed; inset: 0; z-index: 90; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 16px; background: #0b0e14; color: #e6edf3; font: 600 22px system-ui, sans-serif;
    }
    #loading b { display: block; width: min(320px, 70vw); height: 6px; border-radius: 3px; background: #21262d; overflow: hidden; }
    #loading i { display: block; width: 3%; height: 100%; background: #4dd0a6; transition: width 0.2s; }
    #loading small { color: #8b949e; font-size: 13px; font-weight: 400; }
  </style>`,
    body: `<div id="hint">Click to focus</div>
  <div id="loading">${escapeHtml(name)}<b><i></i></b><small>Loading…</small></div>`,
  };
}

/** Read a project file relative to the editor page (works on GitHub Pages too). */
async function fetchProjectFile(path) {
  const response = await fetch(new URL(path, document.baseURI), { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}

/** The same, as bytes (a decoder's .wasm). */
async function fetchProjectBytes(path) {
  const response = await fetch(new URL(path, document.baseURI), { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const isModelFile = (rec) => rec && (rec.kind === 'model' || rec.kind === 'animation' || /\.(glb|gltf)$/i.test(rec.name || ''));

const EXTENSIONS = {
  'model/gltf-binary': 'glb', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/ktx2': 'ktx2',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a',
};

/** A stored file's name in a website export: readable, and never the same as another's. */
function assetFileName(rec) {
  const [, stem = 'file', ext] = /^(.*?)(?:\.([a-z0-9]{1,5}))?$/i.exec(rec.name || '') || [];
  const type = (ext || EXTENSIONS[rec.mime] || 'bin').toLowerCase();
  return `${fileSlug(stem, 'file')}-${String(rec.id).slice(0, 8)}.${type}`;
}

/** Hand the person a file to save. */
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      a.remove();
      URL.revokeObjectURL(url);
    });
  });
}

/**
 * The decoder files an exported game must carry: only those its models use
 * (a Draco model needs the Draco decoder; KTX2 textures the Basis transcoder).
 * Resolves to { 'draco_decoder.wasm': base64, … } — {} for uncompressed models.
 */
export async function decoderFilesFor(assetIds, { readAsset = (id) => assetStore.get(id), readFile = fetchProjectBytes } = {}) {
  const models = [];
  for (const id of assetIds) {
    const rec = await readAsset(id);
    if (isModelFile(rec) && rec.data) models.push(rec.data);
  }
  const out = {};
  for (const name of decodersNeeded(models)) {
    for (const file of DECODERS[name].files) out[file] = bytesToBase64(await readFile(DECODERS[name].dir + file));
  }
  return out;
}

export class GameExporter {
  constructor(serializer, project = null) {
    this.serializer = serializer;
    this.project = project; // with it, every level goes in the game
  }

  /**
   * Asset ids across a whole project (or a single scene): every level, every
   * prefab (one only spawned during play still needs its files). The same
   * answer saving and cleaning up use — see asset-refs.js.
   */
  _assetIds(data) { return assetIdsIn(data); }

  /** Every asset id a scene refers to: models, textures and sounds. */
  _referencedAssetIds(scene) { return assetIdsIn(scene); }

  /** The game's name and icon (Game panel), with what stands in when they aren't set. */
  _identity() {
    const ui = this.serializer.engine?.ui || {};
    const game = ui.game || {};
    const name = String(game.name || ui.title?.text || '').trim() || 'Tiny3 Game';
    return { name, slug: fileSlug(game.name || ui.title?.text), icon: game.icon || '🎮', iconAsset: game.iconAsset || null };
  }

  /** The complete, self-contained game page as a string. */
  async buildGame() {
    const scene = this.project ? this.project.toJSON() : this.serializer.serialize();

    const ids = this._assetIds(scene);
    const assets = [];
    for (const id of ids) {
      const rec = await assetStore.toBase64(id);
      if (rec) assets.push(rec);
      else console.warn('[Tiny3] export: asset missing from the store:', id);
    }
    const decoders = await decoderFilesFor(ids);
    const { name, icon, iconAsset } = this._identity();
    let iconHref = emojiIcon(icon);
    const image = iconAsset && assets.find((a) => a.id === iconAsset.assetId);
    if (image) iconHref = `data:${image.mime};base64,${image.b64}`;

    const bundle = await collectModules(GAME_ENTRY, { fetchText: fetchProjectFile });
    return this._buildHtml(JSON.stringify(scene), JSON.stringify(assets), JSON.stringify(bundle), JSON.stringify(decoders),
      { name, iconHref });
  }

  /**
   * The game as a website — for GitHub Pages, itch.io or any web host:
   *   index.html   the page (the game's name and icon, a loading screen)
   *   game.js      what starts it; lib/ and src/ — Three.js and the engine, as they are
   *   game.json    every level; assets.json and assets/ — each model, texture and sound a file
   *   lib/libs/…   the decoders its compressed models need, only if any
   * No base64: files are their real size, cached by the browser, and loaded
   * in parallel. (Web pages only: opened by double-click, browsers block the
   * files. For that there is the one-file export.)
   * Resolves to [{ path, data }].
   */
  async buildSite() {
    const scene = this.project ? this.project.toJSON() : this.serializer.serialize();
    const files = [];
    const manifest = [];
    const records = [];
    for (const id of this._assetIds(scene)) {
      const rec = await assetStore.get(id);
      if (!rec) { console.warn('[Tiny3] export: asset missing from the store:', id); continue; }
      records.push(rec);
      const file = `assets/${assetFileName(rec)}`;
      manifest.push({ id: rec.id, name: rec.name, mime: rec.mime, kind: rec.kind, file });
      files.push({ path: file, data: new Uint8Array(rec.data) });
    }
    // the decoders, where the loader looks for them — only those its models use
    const models = records.filter(isModelFile).map((r) => r.data);
    for (const decoder of decodersNeeded(models)) {
      for (const f of DECODERS[decoder].files) files.push({ path: DECODERS[decoder].dir + f, data: await fetchProjectBytes(DECODERS[decoder].dir + f) });
    }
    const bundle = await collectModules(GAME_ENTRY, { fetchText: fetchProjectFile });
    for (const path of bundle.order) {
      files.push({ path: path === bundle.entry ? 'game.js' : path, data: bundle.sources[path] });
    }
    files.push({ path: 'game.json', data: JSON.stringify(scene) });
    files.push({ path: 'assets.json', data: JSON.stringify(manifest) });

    const { name, icon, iconAsset } = this._identity();
    let iconHref = emojiIcon(icon);
    const image = iconAsset && manifest.find((m) => m.id === iconAsset.assetId);
    if (image) iconHref = image.file;
    const imports = Object.fromEntries(Object.entries(BARE).map(([spec, path]) => [spec, `./${path}`]));
    const top = pageTop(name, iconHref);
    // an app: installed to a phone's home screen or a computer's apps, and played offline
    const slug = this._identity().slug;
    const icons = await appIcons(icon, image ? records.find((r) => r.id === iconAsset.assetId) : null);
    for (const i of icons) files.push({ path: i.path, data: i.data });
    files.push({ path: 'manifest.webmanifest', data: JSON.stringify(webManifest(name, icons), null, 2) });
    files.unshift({
      path: 'index.html',
      data: `<!DOCTYPE html>
<html lang="en">
<head>
  ${top.head}
  <link rel="manifest" href="manifest.webmanifest" />
  <meta name="theme-color" content="#0b0e14" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="${escapeHtml(name)}" />
  ${icons.length ? '<link rel="apple-touch-icon" href="icon-192.png" />' : ''}
  <script type="importmap">${JSON.stringify({ imports })}</script>
</head>
<body>
  ${top.body}
  <script>
    // offline: every file kept by the browser the first time (sw.js); installable, when it offers
    addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); window.__tiny3InstallPrompt = e; });
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  </script>
  <script type="module" src="./game.js"></script>
</body>
</html>
`,
    });
    files.push({ path: '.nojekyll', data: '' }); // GitHub Pages: serve every file as it is
    files.push({ path: 'sw.js', data: serviceWorker(`tiny3-${slug}-`, files.map((f) => f.path).filter((p) => p !== '.nojekyll')) });
    return files;
  }

  /** Build the game and download it as a single HTML file. */
  async exportToFile(filename = null) {
    const html = await this.buildGame();
    download(new Blob([html], { type: 'text/html' }), filename || `${this._identity().slug}.html`);
  }

  /** Build the game as a website and download it as a .zip. */
  async exportSiteZip(filename = null) {
    download(await makeZip(await this.buildSite()), filename || `${this._identity().slug}.zip`);
  }

  /**
   * Build the game as a website straight into a folder the person picks — their
   * GitHub Pages repository, say (Chrome and Edge). Resolves to the folder's
   * name, or null if they cancelled.
   */
  async exportSiteToFolder() {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'tiny3-site' });
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      throw err;
    }
    for (const file of await this.buildSite()) {
      const parts = file.path.split('/');
      let folder = dir;
      for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
      const handle = await folder.getFileHandle(parts.at(-1), { create: true });
      const writable = await handle.createWritable();
      await writable.write(file.data);
      await writable.close();
    }
    return dir.name;
  }

  /**
   * The page itself. Scene, assets and code sit in JSON script blocks with `<`
   * escaped, so nothing inside them can close a tag early.
   */
  _buildHtml(sceneJson, assetsJson = '[]', bundleJson = '{}', decodersJson = '{}', { name = 'Tiny3 Game', iconHref = emojiIcon('🎮') } = {}) {
    const safe = (json) => json.replace(/</g, '\\u003c');
    const top = pageTop(name, iconHref);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  ${top.head}
</head>
<body>
  ${top.body}
  <script type="application/json" id="scene-data">${safe(sceneJson)}</script>
  <script type="application/json" id="asset-data">${safe(assetsJson)}</script>
  <script type="application/json" id="decoder-data">${safe(decodersJson)}</script>
  <script type="application/json" id="tiny3-bundle">${safe(bundleJson)}</script>
  <script>
    // Three.js, the engine and this game all travel inside this one file, so it
    // runs from anywhere, including double-clicked straight off the disk.
    (${bootBundle.toString()})(JSON.parse(document.getElementById('tiny3-bundle').textContent))
      .catch(function (err) {
        console.error('[Tiny3 Game] could not start:', err);
        document.body.innerHTML = '<pre style="color:#f47067;padding:20px;white-space:pre-wrap">'
          + String((err && (err.stack || err.message)) || err) + '</pre>';
      });
  </script>
</body>
</html>`;
  }
}
