import * as THREE from 'three';
import { Engine } from './engine.js';
import { CameraRig } from './cameras.js';
import { AssetLoader } from './loader.js';
import { ObjectEditor } from './editor.js';
import { Entity } from './entity.js';
import { Player } from './player.js';
import { Coin } from './enemy.js';

// ---- engine ----
const engine = new Engine({ background: 0x0b0e14 });
const { scene, input } = engine;

// ---- lights & ground ----
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
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
  if (mode === 'orbit') { rig.setMode('orbit', { target: player.object3D }); input.exitPointerLock(); }
  if (mode === 'follow') { rig.setMode('follow', { target: player.object3D }); input.exitPointerLock(); }
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
document.getElementById('btn-load-glb').addEventListener('click', () => {
  assets.pickAndLoad({ position: [0, 0, 0] }).then((obj) => {
    if (obj) editor.select(addProp(obj, obj.name));
  });
});

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

  input.endFrame();
};

engine.start();
