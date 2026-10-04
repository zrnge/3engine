// How fast the physics is, measured: tumbling crates, walking characters among static
// objects, and raycasts. Run:  npm run bench   (or: npm run bench -- crates300 rays1000)
//
// Each scene runs at 60 steps a second of game time; the time is what a step
// costs this machine (ms), averaged — 16.6 ms is a whole frame at 60 fps, and the
// game needs room for drawing too.
import * as THREE from 'three';
import { PhysicsWorld, RigidBody } from '../src/physics.js';

const DT = 1 / 60;

function body(physics, { size = [1, 1, 1], at = [0, 0, 0], ...opts }) {
  const o = new THREE.Mesh(new THREE.BoxGeometry(...size));
  o.position.set(...at);
  o.updateMatrixWorld(true);
  const e = { object3D: o, rigidBody: new RigidBody(opts) };
  physics.register(e);
  return e;
}

/** Time `fn` per call (ms), over `frames` calls after `warm` unmeasured ones. */
function time(fn, { frames = 120, warm = 30 } = {}) {
  for (let i = 0; i < warm; i++) fn(i);
  const t = performance.now();
  for (let i = 0; i < frames; i++) fn(warm + i);
  return (performance.now() - t) / frames;
}

let seed = 1;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

/** N crates that tumble, in stacks of four, dropped onto a floor — while they fall, land and settle. */
function crates(n) {
  seed = 1;
  const physics = new PhysicsWorld();
  body(physics, { size: [400, 1, 400], at: [0, -0.5, 0], type: 'static' });
  const columns = Math.ceil(n / 4);
  const side = Math.ceil(Math.sqrt(columns));
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / 4);
    const x = (c % side) * 1.6 - side * 0.8;
    const z = Math.floor(c / side) * 1.6 - side * 0.8;
    body(physics, { at: [x + (rand() - 0.5) * 0.2, 0.6 + (i % 4) * 1.05, z], type: 'dynamic', tumbles: true, mass: 10 });
  }
  return time(() => physics.step(DT), { frames: 180, warm: 10 }); // three seconds: falling, landing, settling
}

/** N characters walking about among `statics` still objects. */
function characters(n, statics = 500) {
  seed = 2;
  const physics = new PhysicsWorld();
  body(physics, { size: [400, 1, 400], at: [0, -0.5, 0], type: 'static' });
  for (let i = 0; i < statics; i++) {
    const s = 0.5 + rand() * 2;
    body(physics, { size: [s, s, s], at: [(rand() - 0.5) * 180, s / 2, (rand() - 0.5) * 180], type: 'static' });
  }
  const walkers = [];
  for (let i = 0; i < n; i++) {
    walkers.push(body(physics, { size: [0.6, 1.8, 0.6], at: [(rand() - 0.5) * 170, 0.9, (rand() - 0.5) * 170],
      type: 'dynamic', shape: 'capsule', mass: 70, friction: 0.1, gravity: -24 }));
  }
  const heading = walkers.map(() => rand() * Math.PI * 2);
  return time((f) => {
    walkers.forEach((w, i) => {
      if (f % 90 === 0) heading[i] = rand() * Math.PI * 2; // a new way, now and then
      w.rigidBody.velocity.x = Math.sin(heading[i]) * 4;
      w.rigidBody.velocity.z = Math.cos(heading[i]) * 4;
    });
    physics.step(DT);
  }, { frames: 180, warm: 20 });
}

/** One raycast (a shot, a camera keeping out of a wall) among `n` bodies. */
function rays(n) {
  seed = 3;
  const physics = new PhysicsWorld();
  body(physics, { size: [400, 1, 400], at: [0, -0.5, 0], type: 'static' });
  for (let i = 0; i < n; i++) {
    const s = 0.5 + rand() * 2;
    const dynamic = i % 3 === 0;
    body(physics, { size: [s, s, s], at: [(rand() - 0.5) * 180, s / 2 + (dynamic ? 0.01 : 0), (rand() - 0.5) * 180],
      type: dynamic ? 'dynamic' : 'static' });
  }
  physics.step(DT);
  const from = new THREE.Vector3();
  const dir = new THREE.Vector3();
  return time(() => {
    from.set((rand() - 0.5) * 180, 1 + rand() * 3, (rand() - 0.5) * 180);
    dir.set(rand() - 0.5, -0.1, rand() - 0.5).normalize();
    physics.raycast(from, dir, 60);
  }, { frames: 2000, warm: 200 });
}

const SCENES = {
  crates100: ['100 tumbling crates', () => crates(100)],
  crates300: ['300 tumbling crates', () => crates(300)],
  crates1000: ['1000 tumbling crates', () => crates(1000)],
  walkers100: ['100 characters + 500 static objects', () => characters(100)],
  walkers500: ['500 characters + 500 static objects', () => characters(500)],
  rays600: ['one raycast, about 600 bodies', () => rays(600)],
  rays1000: ['one raycast, about 1000 bodies', () => rays(1000)],
};

const wanted = process.argv.slice(2).filter((a) => SCENES[a]);
const out = [];
for (const [key, [label, run]] of Object.entries(SCENES)) {
  if (wanted.length && !wanted.includes(key)) continue;
  const ms = run();
  out.push({ scene: label, ms: +ms.toFixed(key.startsWith('rays') ? 3 : 2) });
  console.log(`${label.padEnd(40)} ${ms.toFixed(key.startsWith('rays') ? 3 : 2).padStart(8)} ms${key.startsWith('rays') ? '' : (ms > 16.6 ? '   over a frame' : '')}`);
}
if (process.env.BENCH_JSON) console.log(JSON.stringify(out));
