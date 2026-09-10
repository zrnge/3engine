import * as THREE from 'three';
import { Engine } from './engine.js';
import { CameraRig } from './cameras.js';
import { AssetLoader } from './loader.js';
import { ObjectEditor, LightEntity } from './editor.js';
import { makeDraggable, makeResizable } from './ui.js?v=4';
import { History } from './history.js';
import { SceneSerializer } from './scene.js';
import { Entity } from './entity.js';
import { Player } from './player.js';
import { Coin } from './enemy.js';
import { RigidBody } from './physics.js';
import { GameExporter } from './export.js';

// ---- engine ----
const engine = new Engine({ background: 0x0b0e14 });
const { scene, input } = engine;

// no default lights, ground, or starter objects — user builds the scene from scratch

// ---- camera rig: 1 orbit · 2 follow · 4 free ----
const rig = new CameraRig(engine.camera, engine.renderer.domElement);
rig.enabled = true;
engine.cameraRig = rig;

// ---- editor: gizmo + hierarchy + inspector ----
const history = new History({ limit: 100 });
const editor = new ObjectEditor(engine, {
  listEl: document.getElementById('scene-list'),
  inspectorEl: document.getElementById('inspector-body'),
  statusEl: document.getElementById('status-text'),
  history,
  onModeChange: (mode) => {
    document.querySelectorAll('.gizmo-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === mode));
  },
});

// ---- player controller (invisible by default; user selects a target) ----
const player = engine.add(new Player());
player.object3D.userData.kind = 'Player';
player.object3D.visible = false;
// do not register the player or default lights in the hierarchy — user adds their own objects

function controlledEntity(p) {
  return p.target || p;
}

player.onFire = (p, eng) => {
  if (muteCheck.checked) return;
  eng.playEntitySounds(controlledEntity(p), { trigger: 'fire' });
};

player.onJump = (p, eng) => {
  if (muteCheck.checked) return;
  eng.playEntitySounds(controlledEntity(p), { trigger: 'jump' });
};
rig.setMode('orbit');

// ---- starter objects ----
const assets = new AssetLoader();

class Prop extends Entity {
  constructor(object3D) {
    super(object3D);
    this.halfSize = new THREE.Vector3(0.5, 0.5, 0.5);
    object3D.userData.kind = 'Prop';
  }
}

function addProp(object3D, name) {
  object3D.name = name;
  return editor.register(engine.add(new Prop(object3D)));
}

const PRIMITIVES = {
  box: () => new THREE.BoxGeometry(1.5, 1.5, 1.5),
  sphere: () => new THREE.SphereGeometry(0.9, 32, 16),
  cone: () => new THREE.ConeGeometry(0.9, 2, 24),
  cylinder: () => new THREE.CylinderGeometry(0.7, 0.7, 1.8, 24),
  torus: () => new THREE.TorusGeometry(0.9, 0.35, 16, 40),
};
const PALETTE = [0x539bf5, 0xf6a435, 0x4dd0a6, 0xf47067, 0xdaaa3f, 0xb083f0];

function addPrimitive(kind) {
  const geo = PRIMITIVES[kind] ? PRIMITIVES[kind]() : PRIMITIVES.box();
  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color }));
  // place in front of the camera so it's immediately visible
  const dir = engine.camera.getWorldDirection(new THREE.Vector3());
  mesh.position.copy(engine.camera.position).addScaledVector(dir, 8);
  mesh.position.y = Math.max(mesh.position.y, 1);
  const entity = addProp(mesh, kind[0].toUpperCase() + kind.slice(1));
  editor.recordAdd(entity); // undoable
  return entity;
}

function addLight(kind) {
  let light;
  const pos = engine.camera.position.clone()
    .addScaledVector(engine.camera.getWorldDirection(new THREE.Vector3()), 6);
  switch (kind) {
    case 'point':
      light = new THREE.PointLight(0xffe0b3, 30, 25);
      light.position.copy(pos);
      break;
    case 'spot': {
      light = new THREE.SpotLight(0xffffff, 60, 30, Math.PI / 6, 0.4);
      light.position.copy(pos);
      light.target.position.set(0, 0, 0);
      scene.add(light.target);
      break;
    }
    case 'ambient':
      light = new THREE.AmbientLight(0xffffff, 0.4);
      break;
    default: // directional
      light = new THREE.DirectionalLight(0xffffff, 1);
      light.position.copy(pos);
  }
  scene.add(light);
  const entity = new LightEntity(light, { point: 'Point Light', spot: 'Spot Light', ambient: 'Ambient Light' }[kind] || 'Directional Light');
  editor.register(entity);
  editor.recordAdd(entity); // undoable
  editor.select(entity);
  return entity;
}

// no starter props, coins, or sample models — user builds the scene from scratch

// debug handle
window.__engine = engine;

// browsers block audio until a user gesture — unlock the AudioContext once
const _unlock = () => { engine.unlockAudio(); };
window.addEventListener('pointerdown', _unlock, { once: false });
window.addEventListener('keydown', _unlock, { once: false });

// ---- draggable + resizable panels ----
document.querySelectorAll('.panel').forEach((p) => {
  makeDraggable(p);
  makeResizable(p, { minWidth: 180, minHeight: 140 });
});

// ---- asset browser: prefabs and reusable assets ----
const assetList = document.getElementById('asset-list');
const btnSavePrefab = document.getElementById('btn-save-prefab');

function renderAssetBrowser() {
  if (!assetList) return;
  const names = editor.listPrefabs();
  assetList.innerHTML = '';
  if (!names.length) {
    assetList.innerHTML = '<li class="empty">No prefabs yet.</li>';
    return;
  }
  for (const name of names) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ico">◆</span><span class="nm">${name}</span><span class="del" title="Delete prefab">×</span>`;
    li.querySelector('.nm').addEventListener('click', () => {
      const created = editor.instantiatePrefab(name);
      if (created) markDirty();
    });
    li.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      editor.deletePrefab(name);
      renderAssetBrowser();
    });
    assetList.appendChild(li);
  }
}

if (btnSavePrefab) {
  btnSavePrefab.addEventListener('click', () => {
    const sel = editor.selected;
    if (!sel) { alert('Select an object first.'); return; }
    const name = prompt('Prefab name:', sel.object3D.name || 'Prefab');
    if (!name) return;
    if (editor.saveAsPrefab(name)) {
      renderAssetBrowser();
      markDirty();
    }
  });
}

renderAssetBrowser();

// ---- toolbar wiring ----
function setCamMode(mode) {
  if (mode === 'orbit') { rig.setMode('orbit', { target: rig.target }); input.exitPointerLock(); }
  if (mode === 'follow') { rig.setMode('follow', { target: rig.target }); input.exitPointerLock(); }
  if (mode === 'free') { rig.setMode('free'); input.requestPointerLock(); }
  document.querySelectorAll('.cam-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === mode));
}

document.querySelectorAll('.gizmo-btn').forEach((b) =>
  b.addEventListener('click', () => editor.setGizmoMode(b.dataset.mode)));
document.querySelectorAll('.cam-btn').forEach((b) =>
  b.addEventListener('click', () => setCamMode(b.dataset.mode)));
document.querySelectorAll('[data-add]').forEach((b) =>
  b.addEventListener('click', () => editor.select(addPrimitive(b.dataset.add))));
document.querySelectorAll('[data-light]').forEach((b) =>
  b.addEventListener('click', () => addLight(b.dataset.light)));
document.getElementById('btn-load-glb').addEventListener('click', () => {
  assets.pickAndLoad({ position: [0, 0, 0] }).then((obj) => {
    if (obj) {
      const entity = addProp(obj, obj.name);
      editor.recordAdd(entity); // undoable
      editor.select(entity);
    }
  });
});

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

// ---- New scene: clear everything and wipe autosave ----
function newScene() {
  if (!confirm('Start a new empty scene? This clears the current scene and autosave.')) return;
  // remove all selectable entities
  for (const e of [...editor.selectables]) {
    editor.removeEntity(e, { record: false });
  }
  editor.select(null);
  editor._renderHierarchy();
  refreshCamTargets();
  refreshControlTargets();
  history.clear();
  refreshHistoryButtons();
  localStorage.removeItem(AUTOSAVE_KEY);
  markDirty();
}
document.getElementById('btn-new').addEventListener('click', newScene);

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

function bindSlider(id, prop, target, apply, label = 'camera') {
  const el = document.getElementById(id);
  const val = document.getElementById(`${id}-v`);
  let before = target[prop];
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    apply(v);
    if (val) val.textContent = Number.isInteger(v) ? String(v) : v.toFixed(1);
  });
  el.addEventListener('change', () => {
    const after = target[prop];
    recordValue(target, prop, before, after, (v) => {
      apply(v);
      el.value = v;
      if (val) val.textContent = Number.isInteger(v) ? String(v) : v.toFixed(1);
    }, label);
    before = after;
  });
}

// FOV slider: record before/after camera.fov (setFov doesn't store on rig)
{
  const fovEl = document.getElementById('cam-fov');
  const fovVal = document.getElementById('cam-fov-v');
  let fovBefore = rig.camera.fov;
  fovEl.addEventListener('input', () => {
    const v = parseFloat(fovEl.value);
    rig.setFov(v);
    fovVal.textContent = String(v);
  });
  fovEl.addEventListener('change', () => {
    const after = rig.camera.fov;
    recordValue(rig.camera, 'fov', fovBefore, after, (v) => {
      rig.setFov(v);
      fovEl.value = v;
      fovVal.textContent = String(v);
    }, 'camera FOV');
    fovBefore = after;
  });
}

bindSlider('cam-offset', 'followOffset', rig, (v) => { rig.followOffset = v; }, 'camera offset');
bindSlider('cam-height', 'followHeight', rig, (v) => { rig.followHeight = v; }, 'camera height');
bindSlider('cam-lookup', 'followLookUp', rig, (v) => { rig.followLookUp = v; }, 'camera look up');
bindSlider('cam-ahead', 'followLookAhead', rig, (v) => { rig.followLookAhead = v; }, 'camera look ahead');
bindSlider('cam-lerp', 'followLerp', rig, (v) => { rig.followLerp = v; }, 'camera lerp');
bindSlider('cam-damp', 'followDamping', rig, (v) => { rig.followDamping = v; }, 'camera damping');
bindSlider('cam-orbit-h', 'orbitHeight', rig, (v) => { rig.orbitHeight = v; }, 'camera orbit height');

function bindCheck(id, target, prop, label = 'camera') {
  const el = document.getElementById(id);
  let before = target[prop];
  el.addEventListener('change', () => {
    const after = el.checked;
    recordValue(target, prop, before, after, (v) => { target[prop] = v; el.checked = v; }, label);
    target[prop] = after;
    before = after;
  });
}

bindCheck('cam-rotate', rig, 'rotateWithTarget', 'camera rotate with target');
bindCheck('cam-lock-y', rig, 'followLockY', 'camera lock Y');
bindCheck('cam-orbit-lock', rig, 'orbitLockTarget', 'camera orbit lock target');

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

// ---- player controls panel: rebindable keys + tuning ----
const BIND_ACTIONS = ['forward', 'back', 'left', 'right', 'jump', 'fire'];
const bindList = document.getElementById('bind-list');
const ctlTargetSel = document.getElementById('ctl-target');
let listeningBtn = null;
let _testOsc = null;
let _testGain = null;

function refreshControlTargets() {
  const current = player.target;
  ctlTargetSel.innerHTML = '';
  editor.selectables.forEach((e, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = e.object3D.name || e.constructor.name;
    ctlTargetSel.appendChild(opt);
  });
  let idx = editor.selectables.findIndex((e) => e === current);
  if (idx === -1) {
    // fall back to entity named 'Player', otherwise the first available entity
    idx = editor.selectables.findIndex((e) => (e.object3D.name || '').toLowerCase() === 'player');
    if (idx === -1) idx = 0;
    player.target = editor.selectables[idx] || null;
  }
  ctlTargetSel.value = String(idx);
}

ctlTargetSel.addEventListener('change', () => {
  const i = parseInt(ctlTargetSel.value, 10);
  const entity = Number.isInteger(i) ? editor.selectables[i] : null;
  player.target = entity || null;
  refreshControlTargets();
});

function prettyCode(code) {
  if (code.startsWith('Arrow')) return code.slice(5) + ' arrow';
  return code.replace(/^Key/, '').replace(/^Digit/, '');
}

function renderBindings() {
  bindList.innerHTML = '';
  for (const action of BIND_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'bind-row';
    const label = document.createElement('label');
    label.textContent = action;
    const btn = document.createElement('button');
    btn.className = 'bind-btn';
    btn.dataset.action = action;
    btn.textContent = (player.controls[action] || []).map(prettyCode).join(' / ') || '—';
    btn.title = 'Click, then press a key to rebind. Right-click to clear.';
    btn.addEventListener('click', () => {
      if (listeningBtn) listeningBtn.classList.remove('listening');
      listeningBtn = btn;
      btn.classList.add('listening');
      btn.textContent = 'press a key…';
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const beforeCodes = (player.controls[action] || []).slice();
      if (beforeCodes.length === 0) return;
      player.controls[action] = [];
      renderBindings();
      recordControlsChange(action, beforeCodes, []);
    });
    row.appendChild(label);
    row.appendChild(btn);
    bindList.appendChild(row);
  }
}

// capture the next keydown while a binding button is "listening"
window.addEventListener('keydown', (e) => {
  if (!listeningBtn) return;
  e.preventDefault();
  const action = listeningBtn.dataset.action;
  const beforeCodes = (player.controls[action] || []).slice();
  // keep arrow-key alternates for movement actions; replace everything else
  const keep = action === 'jump' ? [] : beforeCodes.filter((c) => c.startsWith('Arrow'));
  const afterCodes = [...keep, e.code];
  player.controls[action] = afterCodes;
  listeningBtn.classList.remove('listening');
  listeningBtn = null;
  renderBindings();
  recordControlsChange(action, beforeCodes, afterCodes);
}, true);

document.getElementById('ctl-enabled').addEventListener('change', (e) => {
  const before = player.enabled;
  const after = e.target.checked;
  recordValue(player, 'enabled', before, after, (v) => { player.enabled = v; e.target.checked = v; }, 'player enabled');
  player.enabled = after;
});
bindSlider('ctl-speed', 'speed', player, (v) => { player.speed = v; }, 'player speed');
bindSlider('ctl-jump', 'jumpVelocity', player, (v) => { player.jumpVelocity = v; }, 'player jump');

// player control target dropdown
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
  });
}

// keybinding rebinds — record control map changes
function recordControlsChange(action, beforeCodes, afterCodes) {
  if (JSON.stringify(beforeCodes) === JSON.stringify(afterCodes)) return;
  history.push({
    label: `bind ${action}`,
    undo() { player.controls[action] = beforeCodes.slice(); renderBindings(); },
    redo() { player.controls[action] = afterCodes.slice(); renderBindings(); },
  });
}

// mute toggle (defensive: the controls panel may be absent in a cached/old HTML)
const muteCheck = document.getElementById('aud-mute');
function refreshMute() {
  const muted = muteCheck?.checked ?? false;
  // Three.js AudioListener exposes the master gain node as `.gain`
  if (engine.listener.gain) engine.listener.gain.value = muted ? 0 : 1;
}
if (muteCheck) muteCheck.addEventListener('change', refreshMute);

// test tone buttons
const testBtn = document.getElementById('aud-test');
const stopTestBtn = document.getElementById('aud-stop-test');
function stopTestTone() {
  if (_testOsc) { _testOsc.stop(); _testOsc.disconnect(); _testOsc = null; }
  if (_testGain) { _testGain.disconnect(); _testGain = null; }
  if (testBtn) testBtn.disabled = false;
  if (stopTestBtn) stopTestBtn.disabled = true;
}
function startTestTone() {
  engine.unlockAudio();
  const ctx = engine.listener.context;
  if (!ctx) return;
  if (muteCheck?.checked) return;
  _testGain = ctx.createGain();
  _testGain.gain.value = 0.15;
  _testGain.connect(ctx.destination);
  _testOsc = ctx.createOscillator();
  _testOsc.type = 'sawtooth';
  _testOsc.frequency.value = 220;
  _testOsc.connect(_testGain);
  _testOsc.start();
  // quick "pew" envelope: ramp frequency down
  _testOsc.frequency.setValueAtTime(880, ctx.currentTime);
  _testOsc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.25);
  _testGain.gain.setValueAtTime(0.15, ctx.currentTime);
  _testGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
  _testOsc.stop(ctx.currentTime + 0.28);
  _testOsc.onended = stopTestTone;
  if (testBtn) testBtn.disabled = true;
  if (stopTestBtn) stopTestBtn.disabled = false;
}
if (testBtn) testBtn.addEventListener('click', startTestTone);
if (stopTestBtn) stopTestBtn.addEventListener('click', stopTestTone);

renderBindings();

// ---- scene save/load + undo/redo ----
const serializer = new SceneSerializer(engine, editor, rig, player, assets);

const undoBtn = document.getElementById('btn-undo');
const redoBtn = document.getElementById('btn-redo');
function refreshHistoryButtons() {
  undoBtn.disabled = !history.canUndo;
  redoBtn.disabled = !history.canRedo;
}
history.onChange = () => { refreshHistoryButtons(); markDirty(); };
undoBtn.addEventListener('click', () => history.undo());
redoBtn.addEventListener('click', () => history.redo());
document.getElementById('btn-copy').addEventListener('click', () => editor.copySelection());
document.getElementById('btn-paste').addEventListener('click', () => editor.pasteSelection());
// refresh asset browser after paste so any newly pasted objects can be saved as prefabs
const origPasteSelection = editor.pasteSelection.bind(editor);
editor.pasteSelection = function () {
  const result = origPasteSelection();
  renderAssetBrowser();
  return result;
};
document.getElementById('btn-save').addEventListener('click', () => serializer.saveToFile());
const exporter = new GameExporter(serializer);
document.getElementById('btn-export')?.addEventListener('click', () => exporter.exportToFile());
document.getElementById('btn-load').addEventListener('click', () => {
  serializer.loadFromFile().then((made) => {
    if (made) { history.clear(); refreshCamTargets(); refreshControlTargets(); }
  }).catch(() => {});
});
refreshHistoryButtons();

// ---- play / edit mode ----
// Edit mode: full editor. Play mode: editing is locked and the simulation
// runs; stopping reverts the scene to the exact snapshot taken at Play.
const playBtn = document.getElementById('btn-play');
let playing = false;
let playSnapshot = null;

function enterPlay() {
  if (playing) return;
  playing = true;
  playSnapshot = serializer.serialize();
  editor.select(null);
  player.enabled = true;
  document.body.classList.add('playing');
  playBtn.classList.add('playing');
  playBtn.textContent = '⏹ Stop';
  editor.statusPrefix = '▶ PLAYING · ';
  editor._renderStatus();
  // start ambient/global autoplay sounds
  engine.unlockAudio();
  for (const rec of engine.sounds) {
    if (rec.autoplay && rec.type !== 'positional' && !rec.audio.isPlaying) {
      rec.audio.play();
    }
  }
  // start positional autoplay sounds
  for (const rec of engine.sounds) {
    if (rec.autoplay && rec.type === 'positional' && !rec.audio.isPlaying) {
      rec.audio.play();
    }
  }
}

async function exitPlay() {
  if (!playing) return;
  playing = false;
  document.body.classList.remove('playing');
  playBtn.classList.remove('playing');
  playBtn.textContent = '▶ Play';
  editor.statusPrefix = '';
  const snap = playSnapshot;
  playSnapshot = null;
  engine.stopAllSounds();
  if (snap) {
    await serializer.deserialize(snap); // revert anything the simulation changed
    history.clear();
    refreshHistoryButtons();
    refreshCamTargets();
    refreshControlTargets();
  }
  editor._renderStatus();
}

playBtn.addEventListener('click', () => (playing ? exitPlay() : enterPlay()));
window.addEventListener('keydown', (e) => { if (playing && e.code === 'Escape') exitPlay(); });

// ---- autosave: persist the scene to localStorage shortly after any edit ----
const AUTOSAVE_KEY = 'tiny3.autosave';
const AUTOSAVE_VERSION_KEY = 'tiny3.autosaveVersion';
const AUTOSAVE_VERSION = '3'; // bump to clear old default scenes
let _dirtyTimer = null;

// one-time migration: clear autosaves from older versions so the new empty-scene boot applies
if (localStorage.getItem(AUTOSAVE_VERSION_KEY) !== AUTOSAVE_VERSION) {
  localStorage.removeItem(AUTOSAVE_KEY);
  localStorage.setItem(AUTOSAVE_VERSION_KEY, AUTOSAVE_VERSION);
}

function markDirty() {
  if (playing) return; // play-mode changes are temporary — don't save them
  clearTimeout(_dirtyTimer);
  _dirtyTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializer.serialize()));
    } catch (err) {
      console.warn('[Tiny3] autosave failed:', err);
    }
  }, 1500);
}

// any field edit in any panel (inspector, camera, controls) marks dirty
document.addEventListener('input', () => markDirty(), true);

// debug/test handle
window.__tiny3 = { enterPlay, exitPlay, isPlaying: () => playing, markDirty, serializer, editor, exporter };

// keyboard shortcuts for undo/redo/save/load (not while typing in a field)
window.addEventListener('keydown', (e) => {
  if (playing) return; // editing shortcuts are locked while playing
  const a = document.activeElement;
  const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') &&
    a.type !== 'range' && a.type !== 'checkbox';
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); if (!typing) history.undo(); }
  else if (mod && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) { e.preventDefault(); if (!typing) history.redo(); }
  else if (mod && e.code === 'KeyS') { e.preventDefault(); serializer.saveToFile(); }
  else if (mod && e.code === 'KeyO') {
    e.preventDefault();
    serializer.loadFromFile().then((made) => { if (made) { history.clear(); refreshCamTargets(); refreshControlTargets(); } }).catch(() => {});
  }
  else if (mod && e.code === 'KeyC') { e.preventDefault(); editor.copySelection(); }
  else if (mod && e.code === 'KeyV') { e.preventDefault(); editor.pasteSelection(); }
  else if (mod && e.code === 'KeyD') { e.preventDefault(); editor.duplicateSelection(); }
});

// when a scene is loaded, refresh the player-controls panel to match
window.addEventListener('tiny3:player-loaded', () => {
  document.getElementById('ctl-enabled').checked = player.enabled;
  document.getElementById('ctl-speed').value = player.speed;
  document.getElementById('ctl-speed-v').textContent = player.speed;
  document.getElementById('ctl-jump').value = player.jumpVelocity;
  document.getElementById('ctl-jump-v').textContent = player.jumpVelocity;
  player.onFire = (p, eng) => {
    if (muteCheck.checked) return;
    eng.playEntitySounds(controlledEntity(p), { trigger: 'fire' });
  };
  player.onJump = (p, eng) => {
    if (muteCheck.checked) return;
    eng.playEntitySounds(controlledEntity(p), { trigger: 'jump' });
  };
  renderBindings();
  refreshCamTargets();
  refreshControlTargets();
});

// ---- per-frame logic ----
engine.onUpdate = (dt, eng) => {
  if (!playing) {
    // camera hotkeys
    if (input.wasPressed('Digit1')) setCamMode('orbit');
    if (input.wasPressed('Digit2')) setCamMode('follow');
    if (input.wasPressed('Digit4')) setCamMode('free');

    // L — load a GLB model from disk
    if (input.wasPressed('KeyL')) {
      assets.pickAndLoad({ position: [0, 0, 0] }).then((obj) => {
        if (obj) {
          const entity = addProp(obj, obj.name);
          editor.recordAdd(entity);
          editor.select(entity);
        }
      });
    }

    editor.update(dt); // selection, gizmo, delete — edit-mode only
  }

  if (rig.enabled !== false) rig.update(dt, input);

  // keep the camera-target dropdown in sync with the hierarchy
  if (camTargetSel.options.length !== editor.selectables.length + 1) refreshCamTargets();
  // keep the player-controls target dropdown in sync and fall back if the target was deleted
  if (ctlTargetSel.options.length !== editor.selectables.length) {
    refreshControlTargets();
  } else if (player.target && !editor.selectables.includes(player.target)) {
    player.target = null;
    refreshControlTargets();
  }

  input.endFrame();
};

refreshCamTargets();
refreshControlTargets();

// restore the last autosaved scene (if any) so a refresh loses nothing, then add the runtime ground collider
(async () => {
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      if (data.version === 1) {
        const made = await serializer.deserialize(data);
        if (made && made.length) {
          history.clear();
          refreshHistoryButtons();
          refreshCamTargets();
          console.log('[Tiny3] restored autosaved scene');
        }
      }
    }
  } catch (err) {
    console.warn('[Tiny3] autosave restore failed:', err);
  }

  engine.start();
})();
