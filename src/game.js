import * as THREE from 'three';
import { Engine, TINY3_VERSION } from './engine.js';
import { CameraRig } from './cameras.js';
import { AssetLoader } from './loader.js';
import { isTyping } from './input.js';
import { ObjectEditor } from './editor.js';
import { makeDraggable, makeResizable, makeDockPanel, showNotice } from './ui.js';
import { History } from './history.js';
import { SceneSerializer } from './scene.js';
import { Player } from './player.js';
import { GameExporter } from './export.js';
import { wireEnvironmentPanel } from './environment-panel.js';
import { wireControlsPanel } from './controls-panel.js';
import { countScripts } from './script-trust.js';
import { wireCameraPanel } from './camera-panel.js';
import { Project } from './project.js';
import { legacyPrefab } from './prefabs.js';
import { assetStore, savedGames } from './assets-db.js';
import { wireLevelsPanel } from './levels-panel.js';
import { normalizeUI } from './game-ui.js';
import { i18n, t, collectTexts } from './i18n.js';
import { wireLanguagesPanel } from './languages-panel.js';
import { wireObjects } from './app/objects.js';
import { wireAssetBrowser } from './app/asset-browser.js';
import { wireAssetLibrary } from './app/asset-library.js';
import { wireNewGame } from './app/new-game.js';
import { wireAudioMixer } from './app/audio-mixer.js';
import { wireGamePanel } from './app/game-panel.js';
import { wireScreensPanel } from './app/screens-panel.js';
import { installTerrainBrush } from './editor/terrain-brush.js';
import { wireFiles } from './app/files.js';
import { wirePlayMode } from './app/play-mode.js';
import { wireToolsDrawer } from './app/tools-drawer.js';

// ---- engine ----
const engine = new Engine({ background: 0x0b0e14 });
const { scene, input } = engine;

// no default lights, ground, or starter objects — user builds the scene from scratch

// ---- camera rig: 1 orbit · 2 follow · 4 free ----
const rig = new CameraRig(engine.camera, engine.renderer.domElement);
rig.enabled = true;
engine.cameraRig = rig;

// ---- asset loading (shared by the editor, serializer and toolbar) ----
// the renderer lets KTX2-compressed textures pick a format this GPU can show
const assets = new AssetLoader({ renderer: engine.renderer });

// ---- editor: gizmo + hierarchy + inspector ----
const history = new History({ limit: 100 });
const editor = new ObjectEditor(engine, {
  listEl: document.getElementById('scene-list'),
  inspectorEl: document.getElementById('inspector-body'),
  shapeEl: document.getElementById('shape-body'),
  materialEl: document.getElementById('material-body'),
  audioEl: document.getElementById('audio-body'),
  lightListEl: document.getElementById('light-list'),
  statusEl: document.getElementById('status-text'),
  history,
  assets,
  onModeChange: (mode) => {
    document.querySelectorAll('.gizmo-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === mode));
  },
});

// ---- player controller (invisible by default; user selects a target) ----
const player = engine.add(new Player()); // hidden: it only stands in (player.js)
engine.player = player; // "player" in controls, rules and components means player.target
// do not register the player or default lights in the hierarchy — user adds their own objects
// what the player can do is the scene's controls — see the Controls panel below
rig.setMode('orbit');

/**
 * What the editor's parts share (src/app/*.js): the engine, the editor, the history… and
 * what each part offers the others, put here as it is wired (app.markDirty, app.enterPlay…).
 */
const app = { engine, scene, input, rig, assets, history, editor, player, viewport: engine.renderer.domElement };
Object.assign(app, { setCamMode, setPanTool, focusViewport, refreshHistoryButtons, refreshCamTargets, refreshControlTargets });

// no starter props, coins, or sample models — user builds the scene from scratch

// debug handle
window.__engine = engine;
window.__tiny3Version = TINY3_VERSION;
console.log(
  `%c Tiny3 ${TINY3_VERSION} `,
  'background:#4dd0a6;color:#0b0e14;font-weight:700;border-radius:3px',
  '— if this version looks old, hard-reload with Ctrl+Shift+R'
);

// ---- keyboard focus belongs to the game, not to the last button clicked ----
// A clicked <button> keeps focus, and the browser activates a focused button on
// Space/Enter. Space is the default jump key, so pressing it during Play used to
// re-trigger the Play button and stop the game. Drop focus after every click and
// hand it back to the canvas.
const viewport = engine.renderer.domElement;
viewport.tabIndex = -1;
viewport.style.outline = 'none';

function focusViewport() {
  try { viewport.focus({ preventScroll: true }); } catch (_) { viewport.focus(); }
}

document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('button') : null;
  if (btn) {
    btn.blur();
    // don't steal focus from a field the user is filling in
    if (!document.activeElement || document.activeElement === document.body) focusViewport();
  }
});

// browsers block audio until a user gesture — unlock the AudioContext once
const _unlock = () => { engine.unlockAudio(); };
window.addEventListener('pointerdown', _unlock, { once: false });
window.addEventListener('keydown', _unlock, { once: false });

{
  const el = document.getElementById('build-version');
  if (el) el.textContent = `v${TINY3_VERSION}`;
}

// ---- keep the panels clear of the toolbar, however many rows it wraps to ----
{
  const toolbar = document.getElementById('toolbar');
  const syncToolbarHeight = () => {
    const h = Math.round(toolbar.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--toolbar-h', `${h}px`);
  };
  // the left dock ends above the status bar, whatever height that wraps to
  const status = document.getElementById('status');
  const syncStatusHeight = () => {
    const h = Math.round(status.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--status-h', `${h + 18}px`);
  };
  syncToolbarHeight();
  syncStatusHeight();
  // the toolbar wraps to two or three rows on a narrow window; panels follow it
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncToolbarHeight).observe(toolbar);
    new ResizeObserver(syncStatusHeight).observe(status);
  }
  window.addEventListener('resize', () => { syncToolbarHeight(); syncStatusHeight(); });
}

// ---- draggable + resizable panels ----
document.querySelectorAll('.panel').forEach((p) => {
  makeDraggable(p);
  makeResizable(p, { minWidth: 180, minHeight: 80 });
});
// one panel per job, docked in two columns; each collapses from its header
document.querySelectorAll('.dock > .panel').forEach((p) => makeDockPanel(p));
editor._renderInspector(); // fill every panel's empty state and the light list

// ---- natural lighting: sun, sky, shadows and fog, in the Lighting panel ----
const envPanel = app.envPanel = wireEnvironmentPanel(engine.environment, { history, onChange: () => app.markDirty() });

// A dock takes the pointer only while its panels overflow it — then its
// scrollbar has to be draggable. Otherwise its empty space passes clicks
// through to the 3D view.
for (const dock of document.querySelectorAll('.dock')) {
  const sync = () => dock.classList.toggle('overflowing', dock.scrollHeight > dock.clientHeight + 1);
  sync();
  if (typeof ResizeObserver !== 'undefined') {
    const watch = new ResizeObserver(sync);
    watch.observe(dock);
    for (const panel of dock.children) watch.observe(panel); // collapse, re-render
  }
}

wireAssetBrowser(app); // src/app/asset-browser.js

// ---- toolbar wiring ----
let cameraPanel = null; // the Camera panel's per-camera settings (wired further down)

function setCamMode(mode) {
  // follow and first person use the camera target, or the player's
  rig.fallbackTarget = engine.playerEntity?.object3D ?? null;
  rig.setMode(mode, { target: rig.target });
  // Choosing a view never captures the mouse: while editing it stays free for
  // the panels and toolbar (first person and fly look round by dragging). Only
  // Play captures it, for cameras that look with the mouse.
  // (body.playing: Play adds it to the page)
  if (!document.body.classList.contains('playing') || !rig.wantsPointerLock()) input.exitPointerLock();
  document.querySelectorAll('.cam-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === mode));
  cameraPanel?.showTab(mode); // its settings, ready to adjust
}

// ---- hand tool: left-drag pans, and the gizmo stands down while it is on ----
const panBtn = document.getElementById('btn-pan');

function setPanTool(on) {
  rig.setPanTool(on);
  panBtn?.classList.toggle('active', on);
  // the gizmo grabs the left button too — it has to yield while panning
  editor.gizmo.enabled = !on;
}

panBtn?.addEventListener('click', () => setPanTool(!rig.panTool));

// ---- double-click a model to glide the camera onto it and zoom in ----
{
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const canvas = engine.renderer.domElement;
  canvas.addEventListener('dblclick', (e) => {
    if (rig.mode !== 'orbit') return;
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    ray.setFromCamera(ndc, engine.camera);
    const roots = editor.selectables
      .filter((ent) => !ent.object3D.isLight && ent.object3D.visible)
      .map((ent) => ent.object3D);
    const hit = ray.intersectObjects(roots, true)[0];
    if (hit) rig.focusOn(hit.point); // empty space: nothing to focus on
  });
}

document.querySelectorAll('.gizmo-btn').forEach((b) =>
  b.addEventListener('click', () => {
    setPanTool(false); // picking a transform tool leaves the hand tool
    editor.setGizmoMode(b.dataset.mode);
  }));
document.querySelectorAll('.cam-btn').forEach((b) =>
  b.addEventListener('click', () => setCamMode(b.dataset.mode)));
wireObjects(app); // src/app/objects.js
wireAssetLibrary(app); // src/app/asset-library.js: the library, and how models are imported

// ---- Reset View button ----
document.getElementById('btn-reset-view').addEventListener('click', () => {
  rig.setMode('orbit');
  rig.target = null;
  rig.setTarget(null);
  rig.orbitHeight = 8;
  rig.orbitAngle = 0;
  rig.orbitRadius = 12;
  rig.followOffset = 6;
  rig.followHeight = 3;
  rig.camera.position.set(0, 8, 12);
  rig.camera.lookAt(0, 0, 0);
  rig.update(0, input);
  document.querySelectorAll('.cam-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === 'orbit'));
});

wireNewGame(app); // src/app/new-game.js

// ---- camera panel: tie the camera to any object ----
const camTargetSel = document.getElementById('cam-target');

function refreshCamTargets() {
  const current = rig.target;
  camTargetSel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(none)';
  camTargetSel.appendChild(none);
  editor.selectables.forEach((e, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = e.object3D.name || e.constructor.name;
    camTargetSel.appendChild(opt);
  });
  const idx = editor.selectables.findIndex((e) => e.object3D === current);
  camTargetSel.value = idx === -1 ? '' : String(idx);
}

function recordValue(target, prop, before, after, apply, label = 'camera') {
  if (before === after) return;
  history.push({
    label,
    undo() { apply(before); },
    redo() { apply(after); },
  });
}

// Each camera's own settings (Orbit / Follow / First person / Fly), drawn from
// CAMERA_SETTINGS. They used to be one list of follow-camera sliders — several
// never saved, and "Smooth" set a per-second rate to fractions of one.
cameraPanel = wireCameraPanel({
  rig, history,
  tabsEl: document.getElementById('cam-tabs'),
  bodyEl: document.getElementById('cam-settings'),
  onChange: () => app.markDirty(),
  onPreview: (mode) => setCamMode(mode),
});
rig.physics = engine.physics; // the follow camera keeps out of walls

// "When playing": the game's own camera, independent of the view you edit in
const camPlayModeSel = document.getElementById('cam-play-mode');
camPlayModeSel?.addEventListener('change', () => {
  const before = rig.playMode;
  const after = camPlayModeSel.value || null;
  rig.playMode = after;
  recordValue(rig, 'playMode', before, after, (v) => {
    rig.playMode = v;
    camPlayModeSel.value = v || '';
    cameraPanel.render();
  }, 'camera when playing');
  if (after) cameraPanel.showTab(after); // its settings are the ones that matter now
  else cameraPanel.render();
  app.markDirty();
});



// snapping controls
function bindSnap(id, type) {
  const el = document.getElementById(id);
  const val = document.getElementById(`${id}-v`);
  if (!el) return;
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    editor.setSnap(type, v);
    if (val) val.textContent = v <= 0 ? 'off' : String(v);
  });
}
bindSnap('snap-trans', 'translate');
bindSnap('snap-rot', 'rotate');
bindSnap('snap-scl', 'scale');

// gizmo sensitivity slider
{
  const el = document.getElementById('gizmo-sens');
  const val = document.getElementById('gizmo-sens-v');
  if (el) {
    el.addEventListener('input', () => {
      editor.setGizmoSensitivity(el.value);
      if (val) val.textContent = editor.gizmoSensitivity.toFixed(2);
    });
  }
}

// camera target dropdown
{
  let camTargetBefore = rig.target;
  camTargetSel.addEventListener('focus', () => { camTargetBefore = rig.target; });
  camTargetSel.addEventListener('change', () => {
    const i = parseInt(camTargetSel.value, 10);
    const entity = Number.isInteger(i) ? editor.selectables[i] : null;
    const after = entity ? entity.object3D : null;
    recordValue(rig, 'target', camTargetBefore, after, (v) => {
      rig.setTarget(v);
      const idx = v ? editor.selectables.findIndex((e) => e.object3D === v) : -1;
      camTargetSel.value = idx === -1 ? '' : String(idx);
    }, 'camera target');
    rig.setTarget(after);
    camTargetBefore = after;
  });
}

// ---- controls panel: which object is the player, and every control ----
// Nothing is hardcoded: each control is an input (key / mouse / on-screen
// button) and an action (move, jump, interact, shoot, change a variable…).
const ctlTargetSel = document.getElementById('ctl-target');

const controlsPanel = app.controlsPanel = wireControlsPanel({
  engine, editor, history,
  listEl: document.getElementById('control-list'),
  addBtn: document.getElementById('ctl-add-control'),
  onChange: () => app.markDirty(),
});

function refreshControlTargets() {
  const current = player.target;
  ctlTargetSel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(none)';
  ctlTargetSel.appendChild(none);
  editor.selectables.forEach((e, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = e.object3D.name || e.constructor.name;
    ctlTargetSel.appendChild(opt);
  });

  let idx = editor.selectables.findIndex((e) => e === current);
  if (idx === -1) {
    // Only auto-bind to an object actually named "Player". This used to fall back
    // to index 0, so the first object you added silently became the player —
    // and then got a rigid body and fell out of the world on Play.
    idx = editor.selectables.findIndex((e) => (e.object3D.name || '').toLowerCase() === 'player');
    player.target = idx === -1 ? null : editor.selectables[idx];
  }
  ctlTargetSel.value = idx === -1 ? '' : String(idx);
  controlsPanel.render(); // its "Who" dropdowns list every object by name
}

// which object is the player (undoable)
{
  let ctlTargetBefore = player.target;
  ctlTargetSel.addEventListener('focus', () => { ctlTargetBefore = player.target; });
  ctlTargetSel.addEventListener('change', () => {
    const i = parseInt(ctlTargetSel.value, 10);
    const entity = Number.isInteger(i) ? editor.selectables[i] : null;
    const after = entity || null;
    recordValue(player, 'target', ctlTargetBefore, after, (v) => {
      player.target = v;
      const idx = v ? editor.selectables.findIndex((e) => e === v) : -1;
      ctlTargetSel.value = idx === -1 ? '' : String(idx);
      refreshControlTargets();
    }, 'player target');
    player.target = after;
    ctlTargetBefore = after;
    refreshControlTargets();
  });
}

wireAudioMixer(app); // src/app/audio-mixer.js

wireGamePanel(app); // src/app/game-panel.js
wireScreensPanel(app); // src/app/screens-panel.js
installTerrainBrush(editor); // sculpt & paint a selected terrain (src/editor/terrain-brush.js)
// ---- languages (Game panel): set up once the project exists (below) ----
let languagesPanel = null;


// ---- scene save/load + undo/redo ----
const serializer = app.serializer = new SceneSerializer(engine, editor, rig, player, assets);

// ---- levels: the game is a list of them; one is in the editor at a time ----
const project = app.project = new Project(serializer);

// ---- languages (Game panel): the game played in several, its texts translated (i18n.js) ----
languagesPanel = app.languagesPanel = wireLanguagesPanel({
  get: () => engine.ui.languages,
  set: (next, label) => {
    const before = engine.ui.languages;
    const apply = (v) => {
      engine.ui = normalizeUI({ ...engine.ui, languages: v });
      languagesPanel.refresh();
      app.markDirty();
    };
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    history.push({ label, undo: () => apply(before), redo: () => apply(next) });
    apply(next);
  },
  texts: () => collectTexts(project.toJSON(), engine.ui),
});

// prefabs are built by the serializer and shared by every level of the project
editor.serializer = serializer;
editor.project = project;
// a level just loaded: controls and variables were re-applied after it, so refresh again
project.onLoaded = () => window.dispatchEvent(new CustomEvent('tiny3:player-loaded'));
const levelsPanel = app.levelsPanel = wireLevelsPanel({
  project,
  listEl: document.getElementById('level-list'),
  addBtn: document.getElementById('level-add'),
  open: async (index) => {
    await project.open(index);
    history.clear(); // undo does not reach across levels
    refreshHistoryButtons();
  },
  onChange: () => app.markDirty(),
});

wireFiles(app); // src/app/files.js

const undoBtn = document.getElementById('btn-undo');
const redoBtn = document.getElementById('btn-redo');
function refreshHistoryButtons() {
  undoBtn.disabled = !history.canUndo;
  redoBtn.disabled = !history.canRedo;
}
history.onChange = () => { refreshHistoryButtons(); app.markDirty(); app.refreshPrefabStatusSoon(); };
undoBtn.addEventListener('click', () => history.undo());
redoBtn.addEventListener('click', () => history.redo());
document.getElementById('btn-copy').addEventListener('click', () => editor.copySelection());
document.getElementById('btn-paste').addEventListener('click', () => editor.pasteSelection());
// refresh asset browser after paste so any newly pasted objects can be saved as prefabs
const origPasteSelection = editor.pasteSelection.bind(editor);
editor.pasteSelection = async function () {
  const result = await origPasteSelection();
  app.renderAssetBrowser();
  return result;
};
document.getElementById('btn-save').addEventListener('click', () => app.saveProjectSafely());
const exporter = new GameExporter(serializer, project); // every level goes in the game
// Export: one file, a website (.zip), or a website straight into a folder
const exportDialog = document.getElementById('export-dialog');
const canWriteFolders = typeof window.showDirectoryPicker === 'function';
{
  const folderCard = exportDialog?.querySelector('[data-export="folder"]');
  if (folderCard && !canWriteFolders) {
    folderCard.disabled = true;
    document.getElementById('export-folder-note').textContent = 'Needs Chrome or Edge — use the .zip here';
  }
}
document.getElementById('btn-export')?.addEventListener('click', () => {
  exportDialog.hidden = false;
  exportDialog.querySelector('[data-export]')?.focus();
});
const closeExportDialog = () => { exportDialog.hidden = true; };
document.getElementById('export-cancel')?.addEventListener('click', closeExportDialog);
window.addEventListener('keydown', (e) => {
  if (!exportDialog.hidden && e.code === 'Escape') closeExportDialog();
});
exportDialog?.addEventListener('click', async (e) => {
  if (e.target === exportDialog) { closeExportDialog(); return; } // the backdrop
  const card = e.target.closest?.('[data-export]');
  if (!card || card.disabled) return;
  closeExportDialog();
  const button = document.getElementById('btn-export');
  const label = button.innerHTML;
  // packing Three.js, the engine and every file takes a moment
  button.disabled = true;
  button.textContent = '⏳ Exporting…';
  try {
    const kind = card.dataset.export;
    if (kind === 'file') await exporter.exportToFile();
    else if (kind === 'zip') {
      await exporter.exportSiteZip();
      showNotice('Unzip it onto your web host — for GitHub Pages, into the repository, then turn Pages on '
        + '(Settings → Pages). index.html is the game.', { seconds: 15 });
    } else {
      const folder = await exporter.exportSiteToFolder();
      if (folder) showNotice(`The game is in "${folder}": open index.html there on a web host (GitHub Pages), not by double-click.`, { seconds: 15 });
    }
  } catch (err) {
    console.error('[Tiny3] export failed:', err);
    showNotice(`Export failed: ${err.message}`, { kind: 'error', seconds: 0, actions: [{ label: 'OK' }] });
  } finally {
    button.disabled = false;
    button.innerHTML = label;
  }
});
document.getElementById('btn-load').addEventListener('click', app.loadProjectFile);
refreshHistoryButtons();

wirePlayMode(app); // src/app/play-mode.js
wireToolsDrawer(app); // src/app/tools-drawer.js: Logic graph, Debugger, Profiler, Modules

// debug/test handle
window.__tiny3 = {
  enterPlay: app.enterPlay, exitPlay: app.exitPlay, isPlaying: app.isPlaying, markDirty: app.markDirty,
  serializer, editor, exporter, project, tools: app.tools,
};

// keyboard shortcuts for undo/redo/save/load and copy/paste/duplicate
window.addEventListener('keydown', (e) => {
  if (app.isPlaying()) return; // editing shortcuts are locked while playing
  if (!(e.ctrlKey || e.metaKey)) return;
  // save and open work from anywhere
  if (e.code === 'KeyS') { e.preventDefault(); app.saveProjectSafely(); return; }
  if (e.code === 'KeyO') { e.preventDefault(); app.loadProjectFile(); return; }
  // In a field, undo, copy and paste are the text's own. They used to be taken
  // over: Ctrl+V pasted an object into the scene instead of the text, and
  // Ctrl+Z could not undo typing in the script box.
  if (isTyping()) {
    if (e.code === 'KeyD') e.preventDefault(); // not the browser's bookmark dialog
    return;
  }
  if (e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); history.undo(); }
  else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { e.preventDefault(); history.redo(); }
  else if (e.code === 'KeyC') { e.preventDefault(); editor.copySelection(); }
  else if (e.code === 'KeyV') { e.preventDefault(); editor.pasteSelection(); }
  else if (e.code === 'KeyD') { e.preventDefault(); editor.duplicateSelection(); }
});

// when a scene is loaded, refresh the panels to match
window.addEventListener('tiny3:player-loaded', () => {
  refreshCamTargets();
  refreshControlTargets(); // also re-renders the scene's controls
  if (camPlayModeSel) camPlayModeSel.value = rig.playMode || '';
  // a loaded game brings its own camera settings (the panel used to keep showing the old ones)
  cameraPanel.showTab(rig.playMode || rig.mode);
  app.syncTitleUI(); // a loaded game brings its own title screen and HUD styles
  document.querySelectorAll('.cam-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === rig.mode));
  app.syncMixUI();             // a loaded scene brings its own mix...
  app.renderSceneAudio();      // ...and its own music and ambience
  app.renderVariables(); // a loaded scene brings its own variables
  app.renderScreensPanel?.(); // ...its own screens and dialogues
  envPanel.refresh(); // ...and its own lighting
});

// ---- per-frame logic ----
let _controlNames = '';
engine.onUpdate = (dt, eng) => {
  // single-key shortcuts are ignored while typing into a field: a "3" typed into
  // a position switched to first person, and an "l" opened the file picker
  if (!app.isPlaying() && !isTyping()) {
    // H toggles the hand tool; 1–4 pick the camera
    if (input.wasPressed('KeyH')) setPanTool(!rig.panTool);
    if (input.wasPressed('Digit1')) setCamMode('orbit');
    if (input.wasPressed('Digit2')) setCamMode('follow');
    if (input.wasPressed('Digit3')) setCamMode('fps');
    if (input.wasPressed('Digit4')) setCamMode('free');

    // L — load a GLB model from disk
    if (input.wasPressed('KeyL')) app.importModel();
  }

  if (!app.isPlaying()) editor.update(dt); // selection, gizmo, delete — edit-mode only

  if (rig.enabled !== false) rig.update(dt, input);

  // keep the camera-target dropdown in sync with the hierarchy
  if (camTargetSel.options.length !== editor.selectables.length + 1) refreshCamTargets();
  // scrolling zooms and panning releases the target: show what the camera did by itself
  cameraPanel.syncLive();
  // keep the controls panel's object lists in step with the hierarchy — adds,
  // deletes and renames (not during play, when spawns come and go)
  if (!app.isPlaying()) {
    const names = editor.selectables.map((e) => e.object3D.name).join('\n');
    if (names !== _controlNames) {
      _controlNames = names;
      refreshControlTargets();
    }
  }
  // fall back to the hidden default player if the chosen one was deleted
  if (player.target && !editor.selectables.includes(player.target)) {
    player.target = null;
    refreshControlTargets();
  }
  if (app.isPlaying()) app.overlay.update(); // the "E  Open door" prompt
  // input.endFrame() is now driven by the engine so it also runs while paused
};

refreshCamTargets();
refreshControlTargets();

/**
 * Prefabs used to be kept in this browser, outside any game — lost with a new
 * browser and missing from saved files and exports. Move them into the open
 * project, once.
 */
function adoptLegacyPrefabs() {
  let old;
  try {
    old = JSON.parse(localStorage.getItem(ObjectEditor.LEGACY_PREFAB_KEY) || 'null');
  } catch { old = null; }
  if (!old || typeof old !== 'object') return;
  let moved = 0;
  for (const [name, rec] of Object.entries(old)) {
    const converted = legacyPrefab(rec);
    if (!converted || engine.prefabs.has(name)) continue;
    engine.prefabs.set(name, converted);
    moved++;
  }
  try { localStorage.removeItem(ObjectEditor.LEGACY_PREFAB_KEY); } catch { /* storage blocked */ }
  if (moved) {
    console.log(`[Tiny3] moved ${moved} prefab(s) into the game`);
    app.markDirty();
  }
}

// restore the last autosaved scene (if any) so a refresh loses nothing, then add the runtime ground collider
(async () => {
  try {
    // the browser's database — or, saved by an older version, localStorage
    let saved = await savedGames.get('autosave').catch(() => null);
    const fromLocalStorage = !saved && !!(saved = localStorage.getItem(app.AUTOSAVE_KEY));
    if (saved) {
      // every level — or, from before levels existed, the one scene
      const restored = JSON.parse(saved);
      await project.load(restored);
      history.clear();
      refreshHistoryButtons();
      levelsPanel.render();
      if (restored.scriptsOff) app.askAboutScripts(countScripts(restored)); // opened from a file, never trusted
      console.log('[Tiny3] restored autosaved game');
      if (fromLocalStorage) { // moved into the database, where it has room to grow
        await savedGames.put('autosave', saved);
        localStorage.removeItem(app.AUTOSAVE_KEY);
      }
    }
  } catch (err) {
    console.warn('[Tiny3] autosave restore failed:', err);
  }
  adoptLegacyPrefabs();

  engine.start();
  // Quietly clear out files nothing has needed for a month. Only at startup,
  // when there is no undo history or clipboard that could still want one.
  try {
    const { removed, bytes } = await assetStore.prune(app.assetsWanted(), { unusedFor: app.UNUSED_FOR });
    if (removed) console.log(`[Tiny3] removed ${removed} unused file(s), ${app.formatBytes(bytes)}`);
  } catch (err) {
    console.warn('[Tiny3] asset cleanup failed:', err);
  }
  app.refreshStorage();
})();
