import * as THREE from 'three';
import { Engine } from './engine.js';
import { CameraRig } from './cameras.js';
import { AssetLoader } from './loader.js';
import { ObjectEditor, LightEntity } from './editor.js';
import { Entity } from './entity.js';
import { Player } from './player.js';
import { Coin } from './enemy.js';

// ---- engine ----
const engine = new Engine({ background: 0x0b0e14 });
const { scene, input } = engine;

// ---- lights & ground ----
const ambient = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(6, 12, 8);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(30, 30),
  new THREE.MeshStandardMaterial({ color: 0x1a2233 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
scene.add(new THREE.GridHelper(30, 30, 0x2b3a55, 0x22304a));

// ---- camera rig: 1 orbit · 2 follow · 4 free ----
const rig = new CameraRig(engine.camera, engine.renderer.domElement);
rig.enabled = true;
engine.cameraRig = rig;

// ---- editor: gizmo + hierarchy + inspector ----
const editor = new ObjectEditor(engine, {
  listEl: document.getElementById('scene-list'),
  inspectorEl: document.getElementById('inspector-body'),
  statusEl: document.getElementById('status-text'),
  onModeChange: (mode) => {
    document.querySelectorAll('.gizmo-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === mode));
  },
});

// ---- player ----
const player = engine.add(new Player());
player.object3D.userData.kind = 'Player';
editor.register(player);
rig.setMode('orbit', { target: player.object3D });

// ---- lights are editable objects too ----
editor.register(new LightEntity(sun, 'Sun'));
editor.register(new LightEntity(ambient, 'Ambient'));

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
  return addProp(mesh, kind[0].toUpperCase() + kind.slice(1));
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
  editor.select(entity);
  return entity;
}

// a couple of starter props
addPrimitive('box').object3D.position.set(4, 0.75, -3);
addPrimitive('cone').object3D.position.set(-4, 1, 2);

const coins = [];
for (let i = 0; i < 4; i++) {
  const [x, z] = Coin.randomPosition();
  const coin = editor.register(engine.add(new Coin(x, z)));
  coin.object3D.userData.kind = 'Coin';
  coins.push(coin);
}

// sample GLB model (Khronos Duck, CC-BY) — replace with your own in /assets
assets.load('./assets/duck.glb', { scale: 0.05, position: [-2, 0, -4], name: 'Duck' })
  .then((duck) => addProp(duck, 'Duck'))
  .catch((err) => console.warn('[Tiny3] duck.glb failed to load:', err));

// debug handle
window.__engine = engine;

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
    if (obj) editor.select(addProp(obj, obj.name));
  });
});

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

camTargetSel.addEventListener('change', () => {
  const i = parseInt(camTargetSel.value, 10);
  const entity = Number.isInteger(i) ? editor.selectables[i] : null;
  rig.setTarget(entity ? entity.object3D : null);
});

function bindSlider(id, fn) {
  const el = document.getElementById(id);
  const val = document.getElementById(`${id}-v`);
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    fn(v);
    if (val) val.textContent = Number.isInteger(v) ? String(v) : v.toFixed(1);
  });
}

bindSlider('cam-fov', (v) => rig.setFov(v));
bindSlider('cam-offset', (v) => { rig.followOffset = v; });
bindSlider('cam-height', (v) => { rig.followHeight = v; });
bindSlider('cam-lerp', (v) => { rig.followLerp = v; });
document.getElementById('cam-rotate').addEventListener('change', (e) => {
  rig.rotateWithTarget = e.target.checked;
});

// ---- player controls panel: rebindable keys + tuning ----
const BIND_ACTIONS = ['forward', 'back', 'left', 'right', 'jump'];
const bindList = document.getElementById('bind-list');
let listeningBtn = null;

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
      player.controls[action] = [];
      renderBindings();
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
  // keep arrow-key alternates for movement actions; replace everything else
  const keep = action === 'jump' ? [] : (player.controls[action] || []).filter((c) => c.startsWith('Arrow'));
  player.controls[action] = [...keep, e.code];
  listeningBtn.classList.remove('listening');
  listeningBtn = null;
  renderBindings();
}, true);

document.getElementById('ctl-enabled').addEventListener('change', (e) => {
  player.enabled = e.target.checked;
});
bindSlider('ctl-speed', (v) => { player.speed = v; });
bindSlider('ctl-jump', (v) => { player.jumpVelocity = v; });
renderBindings();

// ---- per-frame logic ----
engine.onUpdate = (dt, eng) => {
  // camera hotkeys
  if (input.wasPressed('Digit1')) setCamMode('orbit');
  if (input.wasPressed('Digit2')) setCamMode('follow');
  if (input.wasPressed('Digit4')) setCamMode('free');

  // L — load a GLB model from disk
  if (input.wasPressed('KeyL')) {
    assets.pickAndLoad({ position: [0, 0, 0] }).then((obj) => {
      if (obj) editor.select(addProp(obj, obj.name));
    });
  }

  if (rig.enabled !== false) rig.update(dt, input);
  editor.update(dt);

  // keep the camera-target dropdown in sync with the hierarchy
  if (camTargetSel.options.length !== editor.selectables.length + 1) refreshCamTargets();

  input.endFrame();
};

refreshCamTargets();
engine.start();
