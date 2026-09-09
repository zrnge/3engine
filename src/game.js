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

// ---- camera rig: 1 orbit · 2 follow · 3 fps · 4 free ----
const rig = new CameraRig(engine.camera, engine.renderer.domElement);
engine.cameraRig = rig;

// ---- editor: click-select, drag to move, R rotate, [ ] scale, Del delete ----
const editor = new ObjectEditor(engine, document.getElementById('info'));

// ---- player ----
const player = engine.add(new Player());
rig.setMode('orbit', { target: player.object3D });

// ---- starter objects ----
const assets = new AssetLoader();

class Prop extends Entity {
  constructor(object3D) {
    super(object3D);
    this.halfSize = new THREE.Vector3(0.5, 0.5, 0.5);
  }
}

function addProp(object3D, name) {
  object3D.name = name;
  return editor.register(engine.add(new Prop(object3D)));
}

// a few primitives to play with
const box = new THREE.Mesh(
  new THREE.BoxGeometry(1.5, 1.5, 1.5),
  new THREE.MeshStandardMaterial({ color: 0x539bf5 })
);
box.position.set(4, 0.75, -3);
addProp(box, 'Blue Box');

const cone = new THREE.Mesh(
  new THREE.ConeGeometry(0.9, 2, 24),
  new THREE.MeshStandardMaterial({ color: 0xf6a435 })
);
cone.position.set(-4, 1, 2);
addProp(cone, 'Cone');

const coins = [];
for (let i = 0; i < 4; i++) {
  const [x, z] = Coin.randomPosition();
  coins.push(editor.register(engine.add(new Coin(x, z))));
}

// sample GLB model (Khronos Duck, CC-BY) — replace with your own in /assets
assets.load('./assets/duck.glb', { scale: 0.05, position: [-2, 0, -4], name: 'Duck' })
  .then((duck) => addProp(duck, 'Duck'))
  .catch((err) => console.warn('[Tiny3] duck.glb failed to load:', err));

// debug handle
window.__engine = engine;

// ---- per-frame logic ----
engine.onUpdate = (dt, eng) => {
  // camera switching
  if (input.wasPressed('Digit1')) { rig.setMode('orbit', { target: player.object3D }); input.exitPointerLock(); }
  if (input.wasPressed('Digit2')) { rig.setMode('follow', { target: player.object3D }); input.exitPointerLock(); }
  if (input.wasPressed('Digit3')) { rig.setMode('fps', { target: player.object3D }); input.requestPointerLock(); }
  if (input.wasPressed('Digit4')) { rig.setMode('free'); input.requestPointerLock(); }

  // L — load a GLB model from disk and place it in the scene
  if (input.wasPressed('KeyL')) {
    assets.pickAndLoad({ position: [0, 0, 0] }).then((obj) => {
      if (obj) addProp(obj, obj.name);
    });
  }

  rig.update(dt, input);
  editor.update(dt);

  input.endFrame();
};

engine.start();
