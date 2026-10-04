/**
 * Browser smoke test — boots the real editor and plays a real game.
 *
 * The unit suite cannot cover the editor: it needs WebGL, a DOM, and a user.
 * This catches the class of bug that only appears in a live page — a button that
 * keeps keyboard focus and swallows the jump key, an object that falls out of
 * the world while you are editing it. Both were found this way.
 *
 * Not part of `npm test`: it needs a server and a real browser.
 *
 *   npm run serve          # in another terminal
 *   npm run test:browser
 *
 * Drives whatever Chrome/Edge is installed (`channel`), so no browser download
 * is required. Set TINY3_URL or TINY3_CHANNEL to override.
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// a 1x1 PNG, enough to exercise the real file-picker texture path
const ONE_PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const TEX_PNG = join(tmpdir(), 'tiny3-smoke-texture.png');

const URL = process.env.TINY3_URL || 'http://localhost:8000/index.html';
const CHANNEL = process.env.TINY3_CHANNEL || 'chrome';

const checks = [];
/**
 * Play / Stop, as a user does it: with the mouse captured for looking around, it
 * first has to be given back (Esc) before the toolbar can be clicked.
 */
const clickPlay = async () => {
  await page.evaluate(() => document.exitPointerLock?.());
  await page.click('#btn-play');
};
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** A minimal but genuinely playable scene: ground, player, a scripted prop, light. */
const SCENE = {
  version: 1,
  camera: { mode: 'follow', target: 1, fov: 60 },
  player: {
    enabled: true, speed: 8, jumpVelocity: 9, target: 1,
    controls: {
      forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'],
      right: ['KeyD'], jump: ['Space'], fire: ['KeyF'],
    },
  },
  entities: [
    {
      type: 'primitive', primitive: 'box', name: 'Ground', parent: -1,
      position: [0, -1, 0], rotation: [0, 0, 0], scale: [20, 0.7, 20],
      rigidBody: { type: 'static', mass: 1, restitution: 0, friction: 0.5 },
    },
    {
      type: 'primitive', primitive: 'box', name: 'Player', parent: -1,
      position: [0, 3, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      rigidBody: { type: 'dynamic', mass: 70, restitution: 0, friction: 0.1 },
    },
    {
      type: 'primitive', primitive: 'torus', name: 'Spinner', parent: -1,
      position: [4, 1, -3], rotation: [0, 0, 0], scale: [1, 1, 1],
      behavior: 'entity.rotation.y += delta * 3;',
    },
    {
      type: 'light', lightType: 'ambient', name: 'Ambient', parent: -1,
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      color: '#ffffff', intensity: 1,
    },
  ],
};

// audio may start without a click, so the level probes below measure real output
const browser = await chromium.launch({ channel: CHANNEL, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));

await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// ---- boot ----
const boot = await page.evaluate(() => ({
  engine: !!window.__engine,
  canvas: !!document.querySelector('canvas'),
}));
check('editor boots with a canvas and engine', boot.engine && boot.canvas, JSON.stringify(boot));

// ---- editing does not run gameplay ----
await page.click('[data-add="box"]');
await page.waitForTimeout(700);
const edit = await page.evaluate(() => {
  const box = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Box');
  return { y: +box.object3D.position.y.toFixed(2), body: box.rigidBody?.type ?? null };
});
check('a new object stays put while editing', edit.y > 0 && edit.body === null, JSON.stringify(edit));

// ---- camera navigation ----
// Orbit: left-drag · Pan: right-drag · Zoom: scroll, pinch, double-click a model.
// A left press that moves under 4px is a click (selects); more is a drag (orbits).
const readRig = () => page.evaluate(() => {
  const r = window.__engine.cameraRig;
  return {
    lookAt: r.lookAt.toArray(),
    theta: r.theta,
    distance: r.distance,
    cursor: window.__engine.renderer.domElement.style.cursor,
  };
});
const pivotMoved = (a, b) => Math.hypot(
  b.lookAt[0] - a.lookAt[0], b.lookAt[1] - a.lookAt[1], b.lookAt[2] - a.lookAt[2]);
const selectedName = () => page.evaluate(() =>
  window.__tiny3.editor.selected?.object3D?.name ?? null);
const screenOf = (name) => page.evaluate((n) => {
  const e = window.__tiny3.editor.selectables.find((x) => x.object3D.name === n);
  const rect = window.__engine.renderer.domElement.getBoundingClientRect();
  const p = e.object3D.position.clone().project(window.__engine.camera);
  return {
    x: rect.left + ((p.x + 1) / 2) * rect.width,
    y: rect.top + ((1 - p.y) / 2) * rect.height,
  };
}, name);
const SKY = { x: 800, y: 170 }; // empty canvas above the scene, clear of every panel

// frame the box in the middle of the view, with nothing selected
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  const r = window.__engine.cameraRig;
  ed.select(null);
  r.lookAt.copy(ed.selectables.find((e) => e.object3D.name === 'Box').object3D.position);
  r.distance = 10;
  r.orbitLockTarget = false;
});
await page.waitForTimeout(150);
const box = await screenOf('Box');

let before = await readRig();
await page.mouse.move(SKY.x, SKY.y);
await page.mouse.down({ button: 'left' });
await page.mouse.move(SKY.x + 120, SKY.y, { steps: 6 });
const midOrbit = await readRig();
await page.mouse.up({ button: 'left' });
let after = await readRig();
check('left-drag orbits without panning',
  Math.abs(after.theta - before.theta) > 0.1 && pivotMoved(before, after) < 1e-6,
  `theta moved ${(after.theta - before.theta).toFixed(2)}`);
check('orbiting does not show the grab cursor', midOrbit.cursor !== 'grabbing', midOrbit.cursor);
check('the cursor resets when the drag ends', after.cursor === '', `"${after.cursor}"`);

// the pivot is the box, so it is still dead centre after that orbit
before = await readRig();
await page.mouse.move(box.x, box.y);
await page.mouse.down({ button: 'left' });
await page.mouse.move(box.x + 100, box.y, { steps: 6 });
await page.mouse.up({ button: 'left' });
after = await readRig();
const selAfterDrag = await selectedName();
check('a left-drag that starts on a model orbits instead of selecting it',
  selAfterDrag === null && Math.abs(after.theta - before.theta) > 0.1, `selected=${selAfterDrag}`);

await page.mouse.click(box.x, box.y);
await page.waitForTimeout(100);
const selAfterClick = await selectedName();
check('a click without dragging still selects', selAfterClick === 'Box', `selected=${selAfterClick}`);

await page.mouse.click(SKY.x, SKY.y);
await page.waitForTimeout(100);
const selAfterSky = await selectedName();
check('clicking empty space deselects', selAfterSky === null, `selected=${selAfterSky}`);

before = await readRig();
await page.mouse.move(box.x, box.y + 150);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(150);
after = await readRig();
check('scrolling zooms in', after.distance < before.distance * 0.8,
  `distance ${before.distance.toFixed(1)} -> ${after.distance.toFixed(1)}`);

// move the pivot off the box so the double-click glide has somewhere to go
await page.evaluate(() => {
  const r = window.__engine.cameraRig;
  r.lookAt.x += 5;
  r.distance = 16;
});
await page.waitForTimeout(150);
const offCentre = await screenOf('Box');
before = await readRig();
await page.mouse.dblclick(offCentre.x, offCentre.y);
await page.waitForTimeout(700);
after = await readRig();
const boxPos = await page.evaluate(() => window.__tiny3.editor.selectables
  .find((e) => e.object3D.name === 'Box').object3D.position.toArray());
const pivotGap = Math.hypot(
  after.lookAt[0] - boxPos[0], after.lookAt[1] - boxPos[1], after.lookAt[2] - boxPos[2]);
// the hit point is on the box's surface, so within ~1 unit of its centre
check('double-clicking a model glides onto it and zooms in',
  pivotGap < 1.2 && after.distance < before.distance * 0.7,
  `pivot ${pivotGap.toFixed(2)} from the box, distance ${before.distance.toFixed(1)} -> ${after.distance.toFixed(1)}`);
await page.evaluate(() => window.__tiny3.editor.select(null));

before = await readRig();
await page.mouse.move(700, 450);
await page.mouse.down({ button: 'right' });
await page.mouse.move(900, 450, { steps: 8 });   // 200px right
const midPan = await readRig();
await page.mouse.up({ button: 'right' });
after = await readRig();
const panned = pivotMoved(before, after);
// The original pan managed ~0.3 units across an entire screen; this floor
// catches that bug returning and an accidental reset of the speed multiplier.
check('right-drag pans the view briskly', panned > 5, `${panned.toFixed(2)} units for 200px`);
check('panning shows the grab cursor', midPan.cursor === 'grabbing', midPan.cursor);

// The hand tool and Space+drag pan with the left button — for trackpads, where
// holding a right-button drag is awkward.
const handPan = async () => {
  const before = await readRig();
  await page.mouse.move(700, 450);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(900, 450, { steps: 8 });
  const cursor = (await readRig()).cursor;
  await page.mouse.up({ button: 'left' });
  const after = await readRig();
  return {
    moved: Math.hypot(after.lookAt[0] - before.lookAt[0], after.lookAt[2] - before.lookAt[2]),
    cursor,
  };
};

await page.click('#btn-pan');
const toolPan = await handPan();
check('the hand tool pans on left-drag', toolPan.moved > 5, `${toolPan.moved.toFixed(2)} units`);
check('the hand tool shows the grab cursor', toolPan.cursor === 'grabbing', toolPan.cursor);
check('the gizmo stands down while the hand tool is on',
  await page.evaluate(() => window.__tiny3.editor.gizmo.enabled === false));

await page.click('.gizmo-btn[data-mode="translate"]');
const offPan = await handPan();
check('picking a transform tool releases the hand tool', offPan.moved < 0.01,
  `${offPan.moved.toFixed(2)} units`);

await page.keyboard.down('Space');
const spacePan = await handPan();
await page.keyboard.up('Space');
check('Space + left-drag pans', spacePan.moved > 5, `${spacePan.moved.toFixed(2)} units`);

// panning must not drag the selected object — the gizmo owns the left button only
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  ed.select(ed.selectables[0]);
  window.__panProbe = ed.selectables[0].object3D.position.clone();
});
await page.mouse.move(700, 450);
await page.mouse.down({ button: 'right' });
await page.mouse.move(850, 520, { steps: 6 });
await page.mouse.up({ button: 'right' });
const objMoved = await page.evaluate(() =>
  !window.__tiny3.editor.selectables[0].object3D.position.equals(window.__panProbe));
check('panning never drags the selected object', objMoved === false);
await page.evaluate(() => window.__tiny3.editor.select(null));

// ---- touch, through Chrome's real touch pipeline (CDP), not synthetic events ----
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
const touches = (type, points) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1 })),
});
async function touchDrag(from, to, steps = 8) {
  await touches('touchStart', from);
  for (let s = 1; s <= steps; s++) {
    await touches('touchMove', from.map(([x, y], i) => [
      x + ((to[i][0] - x) * s) / steps,
      y + ((to[i][1] - y) * s) / steps,
    ]));
  }
  await touches('touchEnd', []);
  await page.waitForTimeout(80);
}

before = await readRig();
await touchDrag([[700, 250]], [[820, 250]]);
after = await readRig();
check('one-finger drag orbits',
  Math.abs(after.theta - before.theta) > 0.1 && pivotMoved(before, after) < 1e-6,
  `theta moved ${(after.theta - before.theta).toFixed(2)}`);

before = await readRig();
await touchDrag([[700, 250], [900, 250]], [[800, 250], [1000, 250]]);
after = await readRig();
check('two-finger drag pans without zooming',
  pivotMoved(before, after) > 1 && Math.abs(after.distance - before.distance) < 0.01,
  `pivot moved ${pivotMoved(before, after).toFixed(2)}, distance ${before.distance.toFixed(2)} -> ${after.distance.toFixed(2)}`);

before = await readRig();
await touchDrag([[760, 300], [840, 300]], [[620, 300], [980, 300]]);
after = await readRig();
check('pinching out zooms in', after.distance < before.distance * 0.6,
  `distance ${before.distance.toFixed(1)} -> ${after.distance.toFixed(1)}`);

// a tap must still select, via the browser's compatibility mouse events
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  const r = window.__engine.cameraRig;
  ed.select(null);
  r.lookAt.copy(ed.selectables.find((e) => e.object3D.name === 'Box').object3D.position);
  r.distance = 10;
});
await page.waitForTimeout(150);
const tapAt = await screenOf('Box');
await touches('touchStart', [[tapAt.x, tapAt.y]]);
await touches('touchEnd', []);
await page.waitForTimeout(250);
const selAfterTap = await selectedName();
check('a one-finger tap selects', selAfterTap === 'Box', `selected=${selAfterTap}`);

await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
await page.evaluate(() => window.__tiny3.editor.select(null));

// ---- a texture replaces the colour instead of being tinted by it ----
writeFileSync(TEX_PNG, Buffer.from(ONE_PX_PNG, 'base64'));
const readBoxMat = () => page.evaluate(() => {
  const m = window.__tiny3.editor.selectables
    .find((e) => e.object3D.name === 'Box').object3D.material;
  return {
    color: m.color.getHexString(),
    map: m.map?.name ?? null,
    asset: m.map?.userData?.assetId ?? null,
  };
});
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  const b = ed.selectables.find((e) => e.object3D.name === 'Box');
  b.object3D.material.color.set('#e0601a');
  ed.select(b);
});
const chooser = page.waitForEvent('filechooser');
await page.click('#insp-tex-load');
await (await chooser).setFiles(TEX_PNG);
await page.waitForFunction(() => !!window.__tiny3.editor.selectables
  .find((e) => e.object3D.name === 'Box').object3D.material.map, null, { timeout: 5000 });
let boxMat = await readBoxMat();
const tintLabel = await page.evaluate(() => document.querySelector('#insp-mcolor')
  ?.closest('.prop-row')?.querySelector('label')?.textContent);
check('loading a texture shows it untinted',
  boxMat.color === 'ffffff' && boxMat.map === 'tiny3-smoke-texture.png', JSON.stringify(boxMat));
check('the colour picker becomes a tint while textured', tintLabel === 'Tint', tintLabel);

await page.evaluate(() => document.getElementById('btn-play').click());
await page.waitForTimeout(500);
await page.evaluate(() => document.getElementById('btn-play').click());
await page.waitForTimeout(1500);
boxMat = await readBoxMat();
check('the texture survives Play -> Stop', !!boxMat.asset && boxMat.color === 'ffffff',
  JSON.stringify(boxMat));

await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  ed.select(ed.selectables.find((e) => e.object3D.name === 'Box'));
});
await page.click('#insp-tex-clear');
await page.waitForTimeout(150);
boxMat = await readBoxMat();
check('clearing the texture brings the original colour back',
  boxMat.map === null && boxMat.color === 'e0601a', JSON.stringify(boxMat));

// ---- materials: texture maker, placement, library — measured in real pixels ----
await page.evaluate(() => {
  document.querySelector('[data-add="box"]').click(); // adds and selects a box
  window.__tiny3.editor.selected.object3D.name = 'TexProbe';
  const make = document.querySelector('#material-body [data-act="make"]');
  make.value = 'bricks';
  make.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(500);
await page.evaluate(() => {
  const tiling = document.querySelector('#material-body [data-mf="uv.repeat.0"]');
  tiling.value = '3';
  tiling.dispatchEvent(new Event('change', { bubbles: true }));
});
const probeSpec = () => page.evaluate(async () => {
  const { materialSpec } = await import('/src/materials.js');
  const m = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'TexProbe').object3D.material;
  const s = materialSpec(m);
  return { pattern: s.maps.map?.procedural?.pattern, normal: s.maps.normalMap?.output, repeat: s.uv.repeat };
});
const made2 = await probeSpec();
const panel2 = await page.evaluate(() => ({
  maker: !!document.querySelector('#material-body .tex-maker'),
  filled: [...document.querySelectorAll('#material-body .tex-slot.filled .tex-label')].map((n) => n.textContent),
}));
check('the texture maker adds bricks with their normal map, and tiling edits apply',
  made2.pattern === 'bricks' && made2.normal === 'normal' && made2.repeat[0] === 3 && panel2.maker
  && panel2.filled.join() === 'Base colour,Normal', JSON.stringify({ ...made2, ...panel2 }));

await page.evaluate(() => document.getElementById('btn-play').click());
await page.waitForTimeout(500);
await page.evaluate(() => document.getElementById('btn-play').click());
await page.waitForTimeout(1500);
const kept2 = await probeSpec();
check('a made texture and its placement survive Play -> Stop', JSON.stringify(kept2) === JSON.stringify(made2),
  JSON.stringify(kept2));

/** Put a spec on the probe, look straight at its front face, and read a line of pixels across it. */
const scanProbe = (spec, scale = [1, 1, 1], distance = 2.4, rowY = 0, sideLight = false) => page.evaluate(async ({ spec, scale, distance, rowY, sideLight }) => {
  const { applyMaterialSpec, materialReady, updateWorldUVs } = await import('/src/materials.js');
  const THREE = await import('three');
  const eng = window.__engine;
  const ed = window.__tiny3.editor;
  ed.select(null); // no gizmo or outline over the face
  const probe = ed.selectables.find((e) => e.object3D.name === 'TexProbe').object3D;
  probe.position.set(40, 3, 40);
  probe.rotation.set(0, 0, 0);
  probe.scale.set(...scale);
  probe.updateMatrixWorld(true);
  await applyMaterialSpec(probe.material, spec);
  await materialReady(probe.material);
  updateWorldUVs(eng.scene);
  // light raking across the face — how bumps are seen in any engine
  let rake = null;
  if (sideLight) {
    rake = new THREE.DirectionalLight(0xffffff, 4);
    rake.position.set(45, 3, 41.5);
    rake.target.position.set(40, 3, 40);
    eng.scene.add(rake, rake.target);
  }
  eng.cameraRig.enabled = false;
  const face = 40 + 0.75 * scale[2];
  eng.camera.position.set(40, 3, face + distance);
  eng.camera.lookAt(40, 3, 40);
  eng.camera.updateMatrixWorld(true);
  eng.renderer.render(eng.scene, eng.camera); // upload textures
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  eng.camera.position.set(40, 3, face + distance);
  eng.camera.lookAt(40, 3, 40);
  eng.camera.updateMatrixWorld(true);
  eng.renderer.render(eng.scene, eng.camera);
  const src = eng.renderer.domElement;
  const copy = document.createElement('canvas');
  copy.width = src.width;
  copy.height = src.height;
  const ctx = copy.getContext('2d');
  ctx.drawImage(src, 0, 0); // same task as the render, so the buffer is intact
  if (rake) eng.scene.remove(rake, rake.target);
  const half = 0.75 * scale[0] * 0.95;
  const p = eng.camera.position.clone();
  const lum = [];
  for (let i = 0; i < 400; i++) {
    p.set(40 - half + (2 * half * i) / 399, 3 + rowY, face + 0.001).project(eng.camera);
    const [R, G, B] = ctx.getImageData(Math.round(((p.x + 1) / 2) * src.width),
      Math.round(((1 - p.y) / 2) * src.height), 1, 1).data;
    lum.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
  }
  return lum;
}, { spec, scale, distance, rowY, sideLight });
const scanStats = (lum) => {
  const lo = Math.min(...lum);
  const hi = Math.max(...lum);
  const mid = (lo + hi) / 2;
  let transitions = 0;
  for (let i = 1; i < lum.length; i++) if ((lum[i] > mid) !== (lum[i - 1] > mid)) transitions++;
  const band = lum.filter((x) => x > lo + (hi - lo) * 0.2 && x < lo + (hi - lo) * 0.8).length;
  return { lo: Math.round(lo), hi: Math.round(hi), transitions, band };
};
const EMPTY_MAPS = { normalMap: null, roughnessMap: null, metalnessMap: null, aoMap: null, orm: null, emissiveMap: null, alphaMap: null };
const checkerSpec = (uv = {}, tex = {}) => ({
  color: '#ffffff', roughness: 1, metalness: 0,
  maps: { ...EMPTY_MAPS, map: { name: 'checker', procedural: { pattern: 'checker', scale: 8, size: 512, variation: 0, bump: 0, colorA: '#f0f0f0', colorB: '#202020', ...tex } } },
  uv: { repeat: [1, 1], ...uv },
});

const tile1 = scanStats(await scanProbe(checkerSpec()));
const tile4 = scanStats(await scanProbe(checkerSpec({ repeat: [4, 4] })));
check('tiling ×4 really repeats the texture four times across the face',
  tile1.transitions >= 6 && tile1.transitions <= 9 && tile4.transitions >= 26 && tile4.transitions <= 34,
  `×1: ${tile1.transitions} edges · ×4: ${tile4.transitions} edges`);

const smoothPx = scanStats(await scanProbe(checkerSpec({ filter: 'smooth' }, { size: 64 })));
const crispPx = scanStats(await scanProbe(checkerSpec({ filter: 'pixel' }, { size: 64 })));
check('Pixelated shows crisp texels where Smooth blends them',
  smoothPx.band >= 15 && crispPx.band <= smoothPx.band / 2,
  `blended samples — smooth ${smoothPx.band}, pixelated ${crispPx.band}`);

// a plain grey surface, with and without a bumpy normal map, lit from the side
const bumpSpec = (bump) => ({
  color: '#bbbbbb', roughness: 0.8,
  maps: { ...EMPTY_MAPS, map: null,
    normalMap: bump ? { name: 'n', output: 'normal', procedural: { pattern: 'noise', scale: 8, size: 512, bump: 2, seed: 4 } } : null },
});
const flatLum = await scanProbe(bumpSpec(false), [1, 1, 1], 2.4, 0.09, true);
const bumpyLum = await scanProbe(bumpSpec(true), [1, 1, 1], 2.4, 0.09, true);
const lightDiff = flatLum.reduce((sum, v, i) => sum + Math.abs(v - bumpyLum[i]), 0) / flatLum.length;
check('a normal map changes how light falls on the surface', lightDiff > 2.5,
  `mean brightness change ${lightDiff.toFixed(1)}/255`);

const stretched = scanStats(await scanProbe(checkerSpec(), [4, 1, 1], 4.5));
const bySize = scanStats(await scanProbe(checkerSpec({ worldScale: true, tileSize: 1.5 }), [4, 1, 1], 4.5));
check('"Tile by size" adds tiles when an object is scaled instead of stretching them',
  stretched.transitions <= 9 && bySize.transitions >= 26 && bySize.transitions <= 34,
  `4× wide box — stretched: ${stretched.transitions} edges · tile by size: ${bySize.transitions}`);
await page.evaluate(() => { window.__engine.cameraRig.enabled = true; });

// ---- the material library: save once, use on many objects ----
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  ed.select(ed.selectables.find((e) => e.object3D.name === 'TexProbe'));
});
page.once('dialog', (d) => d.accept('Probe bricks'));
await page.evaluate(() => document.querySelector('#material-body [data-act="save-lib"]').click());
const shared = await page.evaluate(() => {
  document.querySelector('[data-add="box"]').click();
  const ed = window.__tiny3.editor;
  const second = ed.selected;
  second.object3D.name = 'TexProbe2';
  const pick = document.querySelector('#material-body [data-act="library"]');
  pick.value = 'Probe bricks';
  pick.dispatchEvent(new Event('change', { bubbles: true }));
  const probe = ed.selectables.find((e) => e.object3D.name === 'TexProbe');
  return {
    same: second.object3D.material === probe.object3D.material,
    note: document.querySelector('#material-body .mat-note')?.textContent.replace(/\s+/g, ' ').trim(),
  };
});
check('a library material is one shared material across objects',
  shared.same && /Shared by 2 objects/.test(shared.note || ''), JSON.stringify(shared));
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  for (const name of ['TexProbe', 'TexProbe2']) {
    const e = ed.selectables.find((x) => x.object3D.name === name);
    if (e) ed.removeEntity(e, { record: false });
  }
  ed.select(null);
});
await page.evaluate(() => window.__tiny3.editor.select(null));

// ---- duplicate / copy-paste keep everything, and a copy is its own object ----
// REGRESSION: duplicate shared the material (recolouring the copy recoloured the
// original), dropped components, rules, body and sounds — and threw outright on
// an object with a 3D sound
const dup = await page.evaluate(async () => {
  const { presetSfx } = await import('/src/sfx.js');
  const eng = window.__engine;
  const ed = window.__tiny3.editor;
  document.querySelector('[data-add="box"]').click();
  const src = ed.selected;
  src.object3D.name = 'DupSource';
  src.object3D.material.color.set('#ff0000');
  eng.addSound(src, null, { name: 'ding', synth: presetSfx('coin', 2) });
  eng.gameplay.components.add(src, 'rotator', { speed: 45 });
  const [copy] = await ed.duplicateSelection();
  ed.select(src);
  ed.copySelection();
  const [pasted] = await ed.pasteSelection();
  await new Promise((r) => setTimeout(r, 100));
  copy.object3D.material.color.set('#00ff00');
  const info = (e) => ({
    name: e.object3D.name,
    sounds: eng.sounds.filter((s) => s.entity === e).map((s) => s.name),
    components: eng.gameplay.components.listFor(e).map((c) => c.type),
  });
  const out = {
    copy: info(copy), pasted: info(pasted),
    ownMaterial: copy.object3D.material !== src.object3D.material,
    originalColor: src.object3D.material.color.getHexString(),
  };
  for (const e of [src, copy, pasted]) ed.removeEntity(e, { record: false });
  ed.select(null);
  return out;
});
check('Duplicate and Paste copy sounds, components and material — and the copy is its own',
  dup.copy.name === 'DupSource copy' && dup.ownMaterial && dup.originalColor === 'ff0000'
  && dup.copy.sounds.join() === 'ding' && dup.copy.components.join() === 'rotator'
  && dup.pasted.sounds.join() === 'ding' && dup.pasted.components.join() === 'rotator',
  JSON.stringify(dup));

// ---- parenting: a child stays where it is through everything the editor does ----
// REGRESSION: a child was saved relative to its parent but rebuilt as if that were
// a place in the world, so every save, Play -> Stop and level switch moved it.
// Duplicate and Paste dropped a copy at its offset from the parent, off the parent.
// Undoing a delete brought a parent back without its children, and any object back
// without its components, rules and sounds.
const kartState = (name) => page.evaluate(async (name) => {
  const THREE = await import('three');
  const eng = window.__engine;
  const e = window.__tiny3.editor.selectables.find((x) => x.object3D.name === name && (name !== 'Paste' || !x.parent));
  if (!e) return null;
  return {
    at: e.object3D.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2)),
    parent: e.parent?.object3D.name ?? null,
    alive: e.alive !== false,
    components: eng.gameplay.components.listFor(e).length,
    rules: eng.gameplay.rules.listFor(e).length,
    sounds: eng.sounds.filter((s) => s.entity === e).length,
  };
}, name);
const near = (a, b, dx = 0) => !!a && !!b && Math.abs(a[0] - b[0] - dx) < 0.02
  && Math.abs(a[1] - b[1]) < 0.02 && Math.abs(a[2] - b[2]) < 0.02;
await page.evaluate(async () => {
  const { presetSfx } = await import('/src/sfx.js');
  const ed = window.__tiny3.editor;
  const eng = window.__engine;
  const add = (name, x) => {
    document.querySelector('[data-add="box"]').click();
    const e = ed.selected;
    e.object3D.name = name;
    e.object3D.position.set(x, 1, -8);
    return e;
  };
  const kart = add('Kart', 10);
  kart.object3D.rotation.y = Math.PI / 2;
  const wheel = add('Kart wheel', 12);
  wheel.setParent(kart, eng);
  eng.gameplay.components.add(wheel, 'rotator', { speed: 90 });
  eng.gameplay.rules.setFor(wheel, [{ when: { type: 'start' }, if: [], do: [] }]);
  await eng.audio.addFromSettings(wheel, { name: 'squeak', synth: presetSfx('click', 1), type: 'positional' });
  ed.select(null);
});
const wheel0 = await kartState('Kart wheel');
await clickPlay();
await page.waitForTimeout(600);
await clickPlay();
await page.waitForTimeout(1200);
const wheelStopped = await kartState('Kart wheel');
check('a child stays exactly where it was through Play -> Stop, still on its parent',
  near(wheelStopped?.at, wheel0.at) && wheelStopped.parent === 'Kart', JSON.stringify({ wheel0, wheelStopped }));

await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  ed.select(ed.selectables.find((e) => e.object3D.name === 'Kart wheel'));
});
await page.click('#insp-dup');
await page.waitForTimeout(400);
const wheelDup = await kartState('Kart wheel copy');
const pastedWheel = await page.evaluate(async () => {
  const THREE = await import('three');
  const ed = window.__tiny3.editor;
  ed.select(ed.selectables.find((e) => e.object3D.name === 'Kart wheel'));
  ed.copySelection();
  const [p] = await ed.pasteSelection();
  const out = { at: p.object3D.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2)), parent: p.parent?.object3D.name ?? null };
  ed._removeTree(ed._captureTree([p]));
  return out;
});
check('Duplicate puts the copy right beside a child, on the same parent; Paste beside it in the world',
  near(wheelDup?.at, wheel0.at, 1.5) && wheelDup.parent === 'Kart'
  && near(pastedWheel.at, wheel0.at, 1.5) && pastedWheel.parent === null,
  JSON.stringify({ wheel0: wheel0.at, wheelDup, pastedWheel }));

// delete the kart (its wheels go with it), then undo, redo, undo
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  ed.select(ed.selectables.find((e) => e.object3D.name === 'Kart'));
});
await page.click('#insp-del');
await page.waitForTimeout(200);
const kartGone = await page.evaluate(() => window.__tiny3.editor.selectables.filter((e) => /^Kart/.test(e.object3D.name)).length);
await page.click('#btn-undo');
await page.waitForTimeout(400);
const wheelBack = await kartState('Kart wheel');
const dupBack = await kartState('Kart wheel copy');
await page.click('#btn-redo');
await page.waitForTimeout(200);
const kartGoneAgain = await page.evaluate(() => window.__tiny3.editor.selectables.filter((e) => /^Kart/.test(e.object3D.name)).length);
await page.click('#btn-undo');
await page.waitForTimeout(400);
const wheelBackAgain = await kartState('Kart wheel');
check('deleting a parent takes its children; Undo brings the whole family back, in place',
  kartGone === 0 && kartGoneAgain === 0 && wheelBack?.parent === 'Kart' && dupBack?.parent === 'Kart'
  && near(wheelBack.at, wheel0.at) && near(wheelBackAgain?.at, wheel0.at) && wheelBackAgain.parent === 'Kart',
  JSON.stringify({ kartGone, wheelBack, dupBack, kartGoneAgain, wheelBackAgain }));
check('...with every component, rule and sound, and alive (controls and rules can reach it)',
  wheelBackAgain?.components === 1 && wheelBackAgain.rules === 1 && wheelBackAgain.sounds === 1 && wheelBackAgain.alive,
  JSON.stringify(wheelBackAgain));
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  ed._removeTree(ed._captureTree([ed.selectables.find((e) => e.object3D.name === 'Kart')]));
  ed.select(null);
});

// ---- one panel per job: docked, collapsible, floatable ----
const panelTitles = await page.evaluate(() => [...document.querySelectorAll('.dock > .panel')]
  .map((p) => p.querySelector('h3')?.textContent.trim()));
const wantedPanels = ['Levels', 'Hierarchy', 'Shape', 'Color & Texture', 'Lighting', 'Asset Browser',
  'Inspector', 'Audio', 'Camera', 'Controls', 'Game'];
check('every section has its own panel',
  wantedPanels.every((t) => panelTitles.includes(t)), panelTitles.join(' · '));

const isCollapsed = (id) => page.evaluate((i) =>
  document.getElementById(i).classList.contains('collapsed'), id);
const camStart = await isCollapsed('camera-panel');
await page.click('#camera-panel > h3');
const camToggled = await isCollapsed('camera-panel');
await page.click('#camera-panel > h3');
const camBack = await isCollapsed('camera-panel');
check('clicking a panel header collapses and expands it',
  camToggled !== camStart && camBack === camStart);

await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  ed.select(ed.selectables.find((e) => e.object3D.name === 'Box'));
});
const shapeShows = await page.evaluate(() => {
  const x = document.querySelector('#shape-body #insp-pos-x');
  const box = window.__tiny3.editor.selected.object3D;
  return !!x && Math.abs(parseFloat(x.value) - box.position.x) < 0.01;
});
check('the Shape panel shows the selected object\'s transform', shapeShows);
check('the Color & Texture panel shows the selected object\'s surface',
  await page.evaluate(() => !!document.querySelector('#material-body #insp-mcolor')));

const fieldsPastEdge = await page.evaluate(() => {
  const panel = document.getElementById('inspector').getBoundingClientRect();
  return [...document.querySelectorAll('#inspector-body input, #inspector-body select')]
    .filter((el) => el.offsetParent && el.getBoundingClientRect().right > panel.right + 1)
    .map((el) => el.id || el.type);
});
check('every inspector field fits inside its panel', fieldsPastEdge.length === 0,
  fieldsPastEdge.join(', '));

await page.click('#lighting-panel [data-light="point"]');
await page.waitForTimeout(150);
const lightEdit = await page.evaluate(() => {
  const slider = document.querySelector('#light-list input[type="range"]');
  slider.value = '42';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  const light = window.__tiny3.editor.selectables.find((e) => e.object3D.isPointLight).object3D;
  return { cards: document.querySelectorAll('#light-list .light-card').length, intensity: light.intensity };
});
check('the Lighting panel lists lights and edits them in place',
  lightEdit.cards === 1 && lightEdit.intensity === 42, JSON.stringify(lightEdit));

const audioLevels = await page.evaluate(() => {
  const set = (el, prop, value, type) => { el[prop] = value; el.dispatchEvent(new Event(type, { bubbles: true })); };
  const vol = document.getElementById('aud-volume');
  const mute = document.getElementById('aud-mute');
  const level = () => window.__engine.listener.getMasterVolume();
  set(vol, 'value', '0.5', 'input');
  const half = level();
  set(mute, 'checked', true, 'change');
  const muted = level();
  set(mute, 'checked', false, 'change');
  set(vol, 'value', '1', 'input');
  return { half, muted, restored: level() };
});
// REGRESSION: mute wrote a property nobody reads, so it never silenced anything
check('master volume and mute really change the output level',
  Math.abs(audioLevels.half - 0.5) < 1e-6 && audioLevels.muted === 0 && audioLevels.restored === 1,
  JSON.stringify(audioLevels));

// ---- sound maker: sound without any file ----
const made = await page.evaluate(() => {
  document.querySelector('[data-add="box"]').click(); // adds and selects a box
  const add = document.getElementById('insp-aud-add');
  add.value = 'coin';
  add.dispatchEvent(new Event('change', { bubbles: true }));
  const eng = window.__engine;
  const rec = eng.sounds.find((s) => s.entity === window.__tiny3.editor.selected);
  return {
    made: !!rec, preset: rec?.synth?.preset, duration: +(rec?.buffer?.duration ?? 0).toFixed(2),
    previewing: rec ? eng.audio.isPlaying(rec) : false,
    cards: document.querySelectorAll('#audio-body .snd-card').length,
  };
});
check('the sound maker adds a coin sound with no file, and previews it',
  made.made && made.preset === 'coin' && made.duration > 0.2 && made.previewing && made.cards === 1,
  JSON.stringify(made));

// the real signal at the master output while it plays three times in a row
const heard = await page.evaluate(async () => {
  const eng = window.__engine;
  const ctx = eng.listener.context;
  await ctx.resume();
  const probe = ctx.createAnalyser();
  probe.fftSize = 2048;
  eng.listener.getInput().connect(probe);
  const rec = eng.sounds.find((s) => s.synth?.preset === 'coin');
  const box = rec.entity;
  eng.audio.update(rec, { type: 'global' }); // not distance-dependent, for a fair reading
  eng.audio.stopAll(); // the preview from adding it may still be ringing
  for (let i = 0; i < 3; i++) eng.playSound(box, rec.name);
  const layered = [...eng.audio._voices].filter((v) => v.rec === rec).length;
  await new Promise((r) => setTimeout(r, 90));
  const samples = new Float32Array(probe.fftSize);
  probe.getFloatTimeDomainData(samples);
  eng.listener.getInput().disconnect(probe);
  return { layered, peak: +samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0).toFixed(3) };
});
check('a made sound really reaches the speakers, and repeats layer instead of cutting off',
  heard.peak > 0.02 && heard.layered === 3, JSON.stringify(heard));

// a space (reverb): the same sound goes on ringing long after it has finished
const echo = await page.evaluate(async () => {
  const eng = window.__engine;
  const ctx = eng.listener.context;
  await ctx.resume();
  const probe = ctx.createAnalyser();
  probe.fftSize = 2048;
  eng.listener.getInput().connect(probe);
  const rec = eng.sounds.find((s) => s.synth?.preset === 'coin');
  eng.audio.update(rec, { type: 'global' });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // how loud it still is 600ms after a sound that lasts a fraction of that
  const tail = async (space) => {
    eng.audio.stopAll();
    eng.audio.setMix({ space, spaceAmount: 1 });
    await wait(150);
    eng.playSound(rec.entity, rec.name);
    await wait(600);
    const s = new Float32Array(probe.fftSize);
    probe.getFloatTimeDomainData(s);
    return +Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length).toFixed(5);
  };
  const outdoors = await tail('none');
  const cave = await tail('cave');
  eng.listener.getInput().disconnect(probe);
  eng.audio.setMix({ space: 'none', spaceAmount: 0.4 });
  return { outdoors, cave, soundLasts: +rec.buffer.duration.toFixed(2), select: !!document.getElementById('aud-space') };
});
check('in a cave a sound goes on ringing after it ends; outdoors it stops dead',
  echo.soundLasts < 0.5 && echo.cave > 0.002 && echo.cave > echo.outdoors * 5 && echo.select,
  JSON.stringify(echo));

const lightHeader = await page.locator('#lighting-panel > h3').boundingBox();
const lightingWasCollapsed = await isCollapsed('lighting-panel');
await page.mouse.move(lightHeader.x + 30, lightHeader.y + lightHeader.height / 2);
await page.mouse.down();
await page.mouse.move(lightHeader.x + 450, lightHeader.y + 120, { steps: 8 });
await page.mouse.up();
const floated = await page.evaluate(() =>
  document.getElementById('lighting-panel').classList.contains('floating'));
const dragDidNotCollapse = (await isCollapsed('lighting-panel')) === lightingWasCollapsed;
await page.dblclick('#lighting-panel > h3');
const redocked = await page.evaluate(() =>
  !document.getElementById('lighting-panel').classList.contains('floating'));
check('a panel drags out to float, and double-click docks it again',
  floated && dragDidNotCollapse && redocked, JSON.stringify({ floated, dragDidNotCollapse, redocked }));

// expand the whole right dock so it overflows, then scroll it with the wheel
const rightCollapsed = await page.evaluate(() =>
  [...document.querySelectorAll('#dock-right > .panel.collapsed')].map((p) => p.id));
for (const id of rightCollapsed) await page.click(`#${id} > h3`);
const camBox = await page.locator('#camera-panel').boundingBox();
await page.mouse.move(camBox.x + camBox.width / 2, camBox.y + 12);
await page.mouse.wheel(0, 600);
await page.waitForTimeout(200);
const dockState = await page.evaluate(() => {
  const d = document.getElementById('dock-right');
  return { scrollTop: d.scrollTop, takesPointer: d.classList.contains('overflowing') };
});
check('an overflowing dock scrolls, and takes the pointer so its scrollbar works',
  dockState.scrollTop > 0 && dockState.takesPointer, JSON.stringify(dockState));
for (const id of rightCollapsed) await page.click(`#${id} > h3`);
await page.evaluate(() => window.__tiny3.editor.select(null));
await page.waitForTimeout(200);
const spareDockBlocks = await page.evaluate(() =>
  document.getElementById('dock-right').classList.contains('overflowing'));
check('a dock with room to spare lets clicks through to the 3D view', spareDockBlocks === false);

// ---- natural lighting: read real pixels, not settings ----
check('shadows are switched on in the renderer',
  await page.evaluate(() => window.__engine.renderer.shadowMap.enabled === true));

await page.evaluate(() => window.__tiny3.serializer.deserialize({
  version: 1,
  camera: { mode: 'orbit', target: -1, fov: 60 },
  player: { enabled: true, target: -1, controls: {} },
  variables: {},
  environment: { enabled: true, preset: 'custom', time: 8, azimuth: 90, clouds: 0, exposure: 1, shadows: true, softness: 0.3, fog: 0 },
  entities: [
    { type: 'primitive', primitive: 'box', name: 'Ground', parent: -1,
      position: [0, -0.5, 0], rotation: [0, 0, 0], scale: [16, 0.6667, 16],
      material: { color: '#b0a090', metalness: 0, roughness: 1, opacity: 1 } },
    { type: 'primitive', primitive: 'sphere', name: 'Ball', parent: -1,
      position: [0, 1.6, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      material: { color: '#4dd0a6', metalness: 0, roughness: 0.6, opacity: 1 } },
  ],
}));
await page.waitForTimeout(400);

// look at the ball from the side facing away from the sun
await page.evaluate(() => {
  const eng = window.__engine;
  const sun = eng.environment.sunDirection;
  const r = eng.cameraRig;
  window.__tiny3.editor.select(null);
  r.setMode('orbit', { target: null });
  r.theta = Math.atan2(-sun.x, -sun.z);
  r.phi = 1.2;
  r.distance = 7;
  r.lookAt.set(0, 1, 0);
  r.orbitLockTarget = false;
});
await page.waitForTimeout(250);

/** Render once and read the brightness (0-255) at world points. */
const brightnessAt = (points) => page.evaluate((pts) => {
  const eng = window.__engine;
  eng.environment.refit();
  eng.environment.update(0);
  eng.renderer.render(eng.scene, eng.camera);
  const src = eng.renderer.domElement;
  const copy = document.createElement('canvas');
  copy.width = src.width;
  copy.height = src.height;
  const ctx = copy.getContext('2d');
  ctx.drawImage(src, 0, 0); // same task as the render, so the buffer is intact
  return pts.map(([x, y, z]) => {
    const v = eng.camera.position.clone().set(x, y, z).project(eng.camera);
    const px = Math.round(((v.x + 1) / 2) * src.width);
    const py = Math.round(((1 - v.y) / 2) * src.height);
    const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
    return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  });
}, points);

const probes = await page.evaluate(() => {
  const eng = window.__engine;
  const sun = eng.environment.sunDirection;
  const hx = -sun.x; const hz = -sun.z; const hl = Math.hypot(hx, hz);
  const toCam = [hx / hl, hz / hl];
  // a point on the ball facing the camera, i.e. facing away from the sun
  const n = [toCam[0], -0.25, toCam[1]];
  const nl = Math.hypot(...n);
  const darkSide = [n[0] / nl * 0.88, 1.6 + (n[1] / nl) * 0.88, n[2] / nl * 0.88];
  // where the ball's shadow falls on the ground, and a sunlit patch beside it
  const k = 1.6 / sun.y;
  const shadow = [-sun.x * k, 0.001, -sun.z * k];
  const lit = [shadow[0] - toCam[1] * 2.5, 0.001, shadow[2] + toCam[0] * 2.5];
  return { darkSide, shadow, lit };
});

const [darkSideLit, shadowLum, litLum] = await brightnessAt([probes.darkSide, probes.shadow, probes.lit]);
check('the side facing away from the sun is lit by the sky, not black', darkSideLit > 25,
  `brightness ${darkSideLit}/255`);
check('the sun casts a visible shadow on the ground', shadowLum < litLum * 0.8,
  `shadow ${shadowLum} vs sunlit ground ${litLum}`);

// the measurement itself: with the environment off, that side really is black
await page.evaluate(() => window.__engine.environment.applyPreset('off'));
const [darkSideOff] = await brightnessAt([probes.darkSide]);
check('with the environment off, that same side goes black (so the probe is honest)',
  darkSideOff < 8, `brightness ${darkSideOff}/255`);

await page.click('#lighting-panel [data-env-preset="golden"]');
const golden = await page.evaluate(() => ({
  preset: window.__engine.environment.settings.preset,
  time: Number(document.getElementById('env-time').value),
  active: document.querySelector('[data-env-preset="golden"]').classList.contains('active'),
}));
check('a lighting preset applies and the panel shows it',
  golden.preset === 'golden' && Math.abs(golden.time - 17.6) < 0.01 && golden.active,
  JSON.stringify(golden));

await page.evaluate(() => document.getElementById('btn-play').click());
await page.waitForTimeout(500);
await page.evaluate(() => document.getElementById('btn-play').click());
await page.waitForTimeout(1200);
const keptPreset = await page.evaluate(() => window.__engine.environment.settings.preset);
check('the lighting survives Play -> Stop', keptPreset === 'golden', `preset ${keptPreset}`);

// ---- load a playable scene ----
await page.evaluate((scene) => window.__tiny3.serializer.deserialize(scene), SCENE);
await page.waitForTimeout(500);
const names = await page.evaluate(() =>
  window.__tiny3.editor.selectables.map((e) => e.object3D.name));
check('scene loads every entity', names.length === 4, names.join(', '));

// ---- play ----
await clickPlay();
await page.waitForTimeout(900);

const focus = await page.evaluate(() => document.activeElement?.tagName);
check('keyboard focus moves to the viewport on Play', focus === 'CANVAS', `active=${focus}`);

const landed = await page.evaluate(() => {
  const p = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Player');
  return { y: +p.object3D.position.y.toFixed(2), grounded: p.rigidBody.grounded };
});
check('player falls and lands on the ground', landed.grounded, JSON.stringify(landed));

// ---- walk ----
await page.evaluate(() => {
  window.__z = window.__tiny3.editor.selectables
    .find((e) => e.object3D.name === 'Player').object3D.position.z;
});
await page.keyboard.down('w');
await page.waitForTimeout(800);
await page.keyboard.up('w');
const moved = await page.evaluate(() => {
  const p = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Player');
  return +(p.object3D.position.z - window.__z).toFixed(2);
});
check('holding W drives the control target', moved < -1, `moved ${moved} on Z`);

// ---- jump (and the game must still be running afterwards) ----
await page.keyboard.press('Space');
await page.waitForTimeout(120);
const jump = await page.evaluate(() => {
  const p = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Player');
  return { vy: +p.rigidBody.velocity.y.toFixed(2), playing: window.__tiny3.isPlaying() };
});
check('Space jumps instead of re-triggering the Play button', jump.vy > 1 && jump.playing,
  JSON.stringify(jump));

// ---- behavior scripts ----
const spin = await page.evaluate(() => {
  const t = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Spinner');
  return { rotY: +t.object3D.rotation.y.toFixed(2), failed: window.__engine.behaviors[0]?.failed };
});
check('behavior scripts run during Play', spin.rotY > 0.5 && spin.failed === false,
  JSON.stringify(spin));

// ---- stop reverts ----
await clickPlay();
await page.waitForTimeout(1200);
const afterStop = await page.evaluate(() => window.__tiny3.editor.selectables.length);
check('Stop restores the scene', afterStop === 4, `${afterStop} entities`);
await page.waitForTimeout(200);

// ---- controls: nothing hardcoded — every input is an editable control ----
// SCENE uses the old fixed key map; loading it must turn it into controls.
const legacy = await page.evaluate(() => ({
  count: window.__engine.gameplay.controls.list.length,
  cards: document.querySelectorAll('#control-list .ctl-card').length,
  fire: window.__engine.gameplay.controls.list.some((c) => c.action.type === 'playSound'),
}));
check('an old scene\'s key map loads as editable controls',
  legacy.count === 6 && legacy.cards === 6 && legacy.fire, JSON.stringify(legacy));

await page.evaluate(() => document.getElementById('ctl-add-control').click());
const added = await page.evaluate(() => ({
  last: window.__engine.gameplay.controls.list.at(-1),
  cards: document.querySelectorAll('#control-list .ctl-card').length,
}));
check('+ Add control adds a control card (E → Interact)',
  added.cards === 7 && added.last.action.type === 'interact' && added.last.inputs[0].code === 'KeyE',
  JSON.stringify(added.last));

// rebind it: click the key chip, press G — which must not also switch the gizmo
const gizmoBefore = await page.evaluate(() => window.__tiny3.editor.gizmo.mode);
await page.evaluate(() => document.querySelector('#control-list [data-key-bind="6:0"]').click());
await page.keyboard.press('g');
const rebound = await page.evaluate(() => ({
  code: window.__engine.gameplay.controls.list[6].inputs[0].code,
  chip: document.querySelector('#control-list [data-key-bind="6:0"]').textContent,
  gizmo: window.__tiny3.editor.gizmo.mode,
}));
check('a control\'s key rebinds from its chip, and the key is not also a shortcut',
  rebound.code === 'KeyG' && rebound.chip === 'G' && rebound.gizmo === gizmoBefore, JSON.stringify(rebound));
await page.keyboard.press('Control+z');
const undone = await page.evaluate(() => window.__engine.gameplay.controls.list[6].inputs[0].code);
check('undo reverts a rebind', undone === 'KeyE', undone);

// something to interact with, right next to where the player lands
await page.evaluate(() => {
  const eng = window.__engine;
  const spinner = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Spinner');
  spinner.object3D.position.set(1.8, 0, 0);
  eng.gameplay.rules.setFor(spinner, [{
    when: { type: 'interact', who: 'player', prompt: 'Talk' }, if: [],
    do: [{ type: 'setVariable', name: 'talked', value: 1 }],
  }]);
});
await clickPlay();
await page.waitForTimeout(900);
const onScreen = await page.evaluate(() => ({
  joystick: !!document.querySelector('.t3-stick'),
  buttons: [...document.querySelectorAll('.t3-actions .t3-touch-btn')].map((b) => b.textContent),
  prompt: document.querySelector('.t3-prompt.show')?.textContent,
}));
check('Play shows an on-screen joystick and buttons', onScreen.joystick && onScreen.buttons.includes('Jump'),
  JSON.stringify(onScreen));
check('standing by an interactable object shows its prompt', onScreen.prompt === 'ETalk', onScreen.prompt);
await page.keyboard.press('e');
await page.waitForTimeout(100);
check('pressing the interact key runs the object\'s interact rule',
  await page.evaluate(() => window.__engine.variables.get('talked', 0) === 1));

// push the on-screen joystick up with the real mouse: it must be draggable and drive the player
const stickBox = await page.locator('.t3-stick').boundingBox();
const zBefore = await page.evaluate(() => window.__tiny3.editor.selectables
  .find((e) => e.object3D.name === 'Player').object3D.position.z);
const stickX = stickBox.x + stickBox.width / 2;
const stickY = stickBox.y + stickBox.height / 2;
await page.mouse.move(stickX, stickY);
await page.mouse.down();
await page.mouse.move(stickX, stickY - 60, { steps: 4 });
await page.waitForTimeout(700);
await page.mouse.up();
const zAfter = await page.evaluate(() => window.__tiny3.editor.selectables
  .find((e) => e.object3D.name === 'Player').object3D.position.z);
check('pushing the on-screen joystick up drives the player', zAfter - zBefore < -1,
  `moved ${(zAfter - zBefore).toFixed(2)} on Z`);
await page.screenshot({ path: process.env.TINY3_CONTROLS_SHOT || 'smoke-controls.png' });

await clickPlay();
await page.waitForTimeout(1200);
check('Stop removes the on-screen buttons', await page.evaluate(() => !document.querySelector('.t3-touch')));

// ---- components and rules, built through the inspector ----
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  const eng = window.__engine;
  eng.variables.define('score', 0);

  // a trigger coin that adds to score and disappears
  const coin = ed.selectables.find((e) => e.object3D.name === 'Spinner');
  coin.rigidBody = new (Object.getPrototypeOf(
    ed.selectables.find((e) => e.object3D.name === 'Ground').rigidBody
  ).constructor)({ type: 'static', isTrigger: true });
  eng.physics.register(coin);
  coin.object3D.position.set(0, 0.5, -4);
  eng.gameplay.components.add(coin, 'collectible', { variable: 'score', amount: 5, who: 'player' });

  // a rule that wins the game once score reaches 5
  const ground = ed.selectables.find((e) => e.object3D.name === 'Ground');
  eng.gameplay.rules.setFor(ground, [{
    when: { type: 'variable', name: 'score', op: '>=', value: 5 },
    if: [],
    do: [{ type: 'win', message: 'Collected!' }],
  }]);
});

// the inspector must be able to render what we just built
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  ed.select(ed.selectables.find((e) => e.object3D.name === 'Spinner'));
});
await page.waitForTimeout(300);
const inspector = await page.evaluate(() => ({
  hasComponents: !!document.querySelector('#cmp-add'),
  cards: [...document.querySelectorAll('#inspector-body .gp-title')].map((n) => n.textContent),
  hasRuleButton: !!document.querySelector('#rule-add'),
  trigger: document.querySelector('#insp-rb-trigger')?.checked,
}));
check('inspector renders components and the rule builder',
  inspector.hasComponents && inspector.hasRuleButton && inspector.cards.includes('Collectible'),
  JSON.stringify(inspector));

// ---- sounds by name, scene ambience, and nothing playing while editing ----
await page.evaluate(async () => {
  const { presetSfx } = await import('/src/sfx.js');
  const eng = window.__engine;
  const coin = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Spinner');
  eng.addSound(coin, null, { name: 'coin', synth: presetSfx('coin', 4) });
  eng.gameplay.components.listFor(coin)[0].props.sound = 'coin'; // the Collectible's sound
  // scene ambience, through the Audio panel's scene section
  const add = document.getElementById('scn-aud-add');
  add.value = 'wind';
  add.dispatchEvent(new Event('change', { bubbles: true }));
  window.__played = [];
  const play = eng.audio._play.bind(eng.audio);
  eng.audio._play = (rec, opts) => { window.__played.push(rec.name); return play(rec, opts); };
});
const editing = await page.evaluate(() => {
  const eng = window.__engine;
  const wind = eng.sounds.find((s) => s.name === 'wind');
  return { scene: wind?.entity === null, autoplay: wind?.autoplay, playing: wind ? eng.audio.isPlaying(wind) : null,
    card: !!document.querySelector('#scene-audio .snd-card') };
});
check('scene ambience is added from the Audio panel and stays quiet while editing',
  editing.scene && editing.autoplay && editing.playing === false && editing.card, JSON.stringify(editing));

// ---- play it: walk into the coin, score, win ----
await clickPlay();
await page.waitForTimeout(700);
await page.keyboard.down('w');
await page.waitForTimeout(1400);
await page.keyboard.up('w');
await page.waitForTimeout(400);

const played = await page.evaluate(() => ({
  score: window.__engine.variables.get('score'),
  outcome: window.__engine.gameplay.outcome,
  coinGone: !window.__tiny3.editor.selectables.some((e) => e.object3D.name === 'Spinner'),
  hudText: document.querySelector('.t3-hud')?.textContent?.replace(/\s+/g, ' ').trim(),
  bannerShown: document.querySelector('#outcome')?.classList.contains('show'),
}));
check('walking into a trigger runs its component', played.score === 5 && played.coinGone,
  JSON.stringify({ score: played.score, coinGone: played.coinGone }));
check('the HUD shows live variables', /score/i.test(played.hudText || ''), played.hudText);
check('a variable rule fires and wins the game',
  played.outcome?.result === 'win' && played.bannerShown, JSON.stringify(played.outcome));
const playSounds = await page.evaluate(() => {
  const eng = window.__engine;
  const wind = eng.sounds.find((s) => s.name === 'wind');
  return { played: window.__played, windPlaying: wind ? eng.audio.isPlaying(wind) : null };
});
check('Play starts the ambience, and collecting plays the coin sound by name',
  playSounds.windPlaying && playSounds.played.includes('coin'), JSON.stringify(playSounds));

await page.screenshot({ path: process.env.TINY3_SHOT || 'smoke.png' });

// ---- stopping restores the scene, including the collected coin ----
await clickPlay();
await page.waitForTimeout(1200);
const restored = await page.evaluate(() => ({
  count: window.__tiny3.editor.selectables.length,
  hasCoin: window.__tiny3.editor.selectables.some((e) => e.object3D.name === 'Spinner'),
  score: window.__engine.variables.get('score'),
}));
check('Stop restores a collected object and resets variables',
  restored.hasCoin && restored.score === 0, JSON.stringify(restored));
// REGRESSION: restoring the scene re-added autoplay sounds, which started
// playing at once — music came back on in the editor after every Stop
const afterStopAudio = await page.evaluate(() => {
  const eng = window.__engine;
  const wind = eng.sounds.find((s) => s.name === 'wind');
  return { exists: !!wind, synth: wind?.synth?.preset, playing: wind ? eng.audio.isPlaying(wind) : null,
    anyPlaying: eng.sounds.some((s) => eng.audio.isPlaying(s)) };
});
check('Stop silences everything, and ambience does not restart in the editor',
  afterStopAudio.exists && afterStopAudio.synth === 'wind' && !afterStopAudio.anyPlaying, JSON.stringify(afterStopAudio));

// ---- levels: a second room, moving between them in play, the score carried over ----
const lv0 = await page.evaluate(() => ({
  names: window.__tiny3.project.names(),
  rows: document.querySelectorAll('#level-list .lvl-row').length,
}));
check('the Levels panel lists the game\'s level', lv0.names.length === 1 && lv0.rows === 1, JSON.stringify(lv0));
await page.evaluate(() => document.getElementById('level-add').click());
await page.waitForTimeout(700);
const lv1 = await page.evaluate(() => {
  const input = document.querySelector('#level-list .lvl-row.current .lvl-name');
  input.value = 'Boss room';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('[data-add="box"]').click();
  window.__tiny3.editor.selected.object3D.name = 'BossBox';
  const p = window.__tiny3.project;
  return { names: p.names(), current: p.current, objects: window.__tiny3.editor.selectables.map((e) => e.object3D.name) };
});
check('+ Add level opens a new, empty level to build in',
  lv1.names.join() === 'Level 1,Boss room' && lv1.current === 1 && lv1.objects.join() === 'BossBox', JSON.stringify(lv1));

await page.evaluate(() => document.querySelector('#level-list .lvl-row[data-i="0"] .lvl-name')
  .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
await page.waitForTimeout(900);
const lvBack = await page.evaluate(() => ({
  current: window.__tiny3.project.current,
  objects: window.__tiny3.editor.selectables.map((e) => e.object3D.name),
  highlighted: document.querySelector('#level-list .lvl-row.current .lvl-name')?.value,
}));
check('switching levels keeps each level\'s own objects',
  lvBack.current === 0 && lvBack.objects.includes('Spinner') && !lvBack.objects.includes('BossBox')
  && lvBack.highlighted === 'Level 1', JSON.stringify(lvBack));

// a rule in level 1: press N to add 3 to the score and go to the boss room
await page.evaluate(() => {
  const eng = window.__engine;
  const ground = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Ground');
  eng.gameplay.rules.setFor(ground, [...eng.gameplay.rules.listFor(ground), {
    when: { type: 'key', code: 'KeyN', mode: 'pressed' },
    if: [],
    do: [{ type: 'changeVariable', name: 'score', by: 3 }, { type: 'goToLevel', level: 'Boss room' }],
  }]);
});
await clickPlay();
await page.waitForTimeout(700);
await page.keyboard.press('n');
await page.waitForTimeout(1300);
const inBoss = await page.evaluate(() => ({
  active: window.__tiny3.project.active,
  objects: window.__tiny3.editor.selectables.map((e) => e.object3D.name),
  score: window.__engine.variables.get('score'),
  banner: document.querySelector('.t3-announce')?.textContent,
  playing: window.__tiny3.isPlaying(),
}));
check('"Go to level" moves to the other level in play, and the score carries over',
  inBoss.active === 1 && inBoss.objects.join() === 'BossBox' && inBoss.score === 3
  && inBoss.banner === 'Boss room' && inBoss.playing, JSON.stringify(inBoss));
await clickPlay();
await page.waitForTimeout(1500);
const bossStop = await page.evaluate(() => ({
  current: window.__tiny3.project.current,
  active: window.__tiny3.project.active,
  objects: window.__tiny3.editor.selectables.map((e) => e.object3D.name),
  score: window.__engine.variables.get('score'),
}));
// ---- first person: chosen from the toolbar; W walks where you look ----
// the crosshair, chosen in the Game panel: a cross with a dot
await page.evaluate(() => {
  const style = document.querySelector('#ui-crosshair [data-xh="style"]');
  style.value = 'cross + dot';
  style.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.evaluate(() => document.querySelector('.cam-btn[data-mode="fps"]').click());
// editing in first person: a click must not capture the cursor; dragging looks round
await page.mouse.click(700, 450);
await page.waitForTimeout(200);
const editYaw = await page.evaluate(() => window.__engine.cameraRig.yaw);
await page.mouse.move(700, 450);
await page.mouse.down();
for (let i = 1; i <= 6; i++) { await page.mouse.move(700 + i * 20, 450); await page.waitForTimeout(15); }
await page.mouse.up();
const editingFps = await page.evaluate((yaw) => ({
  captured: !!document.pointerLockElement,
  turned: +(window.__engine.cameraRig.yaw - yaw).toFixed(3),
}), editYaw);
check('editing in first person keeps the cursor free — a click does not capture it — and dragging looks round',
  !editingFps.captured && Math.abs(editingFps.turned) > 0.1, JSON.stringify(editingFps));
await clickPlay();
await page.waitForTimeout(800);
// REGRESSION: the mouse was never captured (asked of `window`), so moving it
// could not look around in first person, in Play or in an exported game
const captured = await page.evaluate(() => {
  const svg = document.querySelector('.t3-crosshair svg');
  const box = svg?.getBoundingClientRect();
  return {
    by: document.pointerLockElement?.tagName ?? null,
    crosshair: svg ? { lines: svg.querySelectorAll('line').length, circles: svg.querySelectorAll('circle').length,
      dx: Math.round(box.left + box.width / 2 - innerWidth / 2), dy: Math.round(box.top + box.height / 2 - innerHeight / 2) } : null,
    yaw: window.__engine.cameraRig.yaw,
    playing: window.__tiny3.isPlaying(),
  };
});
for (let i = 1; i <= 8; i++) { await page.mouse.move(700 + i * 25, 450); await page.waitForTimeout(20); }
await page.waitForTimeout(150);
const lookedRound = await page.evaluate((yaw) => +(window.__engine.cameraRig.yaw - yaw).toFixed(3), captured.yaw);
check('Play in first person captures the mouse at once: moving it looks around, with the chosen crosshair dead centre',
  captured.playing && captured.by === 'CANVAS' && Math.abs(lookedRound) > 0.1
  && captured.crosshair?.lines === 8 && captured.crosshair.circles === 2 // outline + colour: 4 lines and a dot each
  && Math.abs(captured.crosshair.dx) <= 1 && Math.abs(captured.crosshair.dy) <= 1,
  JSON.stringify({ ...captured, lookedRound }));
const fpsStart = await page.evaluate(() => {
  const rig = window.__engine.cameraRig;
  rig.yaw = -Math.PI / 2; // look down +X
  const p = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Player').object3D;
  window.__fpsFrom = p.position.clone();
  return { mode: rig.mode };
});
await page.keyboard.down('w');
await page.waitForTimeout(700);
await page.keyboard.up('w');
const fps = await page.evaluate(() => {
  const eng = window.__engine;
  const p = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Player').object3D;
  return {
    mode: eng.cameraRig.mode,
    dx: +(p.position.x - window.__fpsFrom.x).toFixed(2),
    dz: +(p.position.z - window.__fpsFrom.z).toFixed(2),
    eyeAbovePlayer: +(eng.camera.position.y - p.position.y).toFixed(2),
  };
});
await clickPlay();
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('.cam-btn[data-mode="follow"]').click());
check('First person: from the player\'s eyes, W walks where the camera looks',
  // the direction, not a fixed sideways distance: the first frame may still use
  // the camera's previous heading, so the drift varied run to run (0.26–0.56)
  fpsStart.mode === 'fps' && fps.mode === 'fps' && fps.dx > 1 && Math.abs(fps.dz) / fps.dx < 0.15
  && Math.abs(fps.eyeAbovePlayer - 1.1) < 0.05, JSON.stringify(fps));

check('Stop comes back to the level being edited, as it was',
  bossStop.current === 0 && bossStop.active === 0 && bossStop.objects.includes('Spinner') && bossStop.score === 0,
  JSON.stringify(bossStop));

// ---- cameras: each one's own settings, from its own tab, used in Play ----
// REGRESSION: first-person eye height and mouse speed and the fly speeds were
// fixed in code; the follow camera couldn't go over the shoulder or be turned
// by the mouse; several panel sliders never saved.
if (await page.evaluate(() => document.getElementById('camera-panel').classList.contains('collapsed'))) {
  await page.click('#camera-panel > h3');
}
const camTabs = await page.evaluate(() => [...document.querySelectorAll('#cam-tabs .cam-tab')].map((b) => b.textContent.trim()));
/** Drag a Camera panel slider to a value, the way a user would (input while dragging, change on release). */
const camSlider = (tab, key, value) => page.evaluate(({ tab, key, value }) => {
  document.querySelector(`[data-cam-tab="${tab}"]`).click();
  const el = document.querySelector(`#cam-settings [data-cam="${key}"]`);
  if (el.type === 'checkbox') el.checked = value;
  else el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return document.querySelector(`#cam-settings [data-cam-v="${key}"]`)?.textContent ?? String(el.checked);
}, { tab, key, value });
const fpsTabRows = await page.evaluate(() => {
  document.querySelector('[data-cam-tab="fps"]').click();
  return [...document.querySelectorAll('#cam-settings .prop-row label, #cam-settings .check-row')].map((l) => l.textContent.trim());
});
const eyeShown = await camSlider('fps', 'eyeHeight', 1.6);
await page.evaluate(() => document.getElementById('btn-undo').click());
const eyeUndone = await page.evaluate(() => window.__engine.cameraRig.eyeHeight);
await page.evaluate(() => document.getElementById('btn-redo').click());
check('the Camera panel has a tab per camera, each with its own settings, and changes undo',
  camTabs.map((t) => t.replace(' ▶', '')).join() === 'Orbit,Follow,First person,Fly'
  && fpsTabRows.includes('Eye height') && fpsTabRows.includes('Mouse speed') && !fpsTabRows.includes('Distance')
  && eyeShown === '1.60' && eyeUndone === 1.1,
  JSON.stringify({ camTabs, fpsTabRows, eyeShown, eyeUndone }));

// first person, at the eye height just set
await page.evaluate(() => document.querySelector('.cam-btn[data-mode="fps"]').click());
await clickPlay();
await page.waitForTimeout(800);
const eyeInPlay = await page.evaluate(() => {
  const p = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Player').object3D;
  return +(window.__engine.camera.position.y - p.position.y).toFixed(2);
});
await clickPlay();
await page.waitForTimeout(1500);

// follow: 9 behind, 2 up, 1 to the side (walls may not pull it in for this measurement)
await camSlider('follow', 'followOffset', 9);
await camSlider('follow', 'followHeight', 2);
await camSlider('follow', 'followLookUp', 0);
await camSlider('follow', 'followSide', 1);
await camSlider('follow', 'followAvoidWalls', false);
await page.evaluate(() => document.querySelector('.cam-btn[data-mode="follow"]').click());
await clickPlay();
await page.waitForTimeout(1500);
const followInPlay = await page.evaluate(() => {
  const p = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Player').object3D;
  const c = window.__engine.camera.position;
  return { across: +Math.hypot(c.x - p.position.x, c.z - p.position.z).toFixed(2), up: +(c.y - p.position.y).toFixed(2),
    mode: window.__engine.cameraRig.mode };
});
await clickPlay();
await page.waitForTimeout(1500);
const savedCamera = await page.evaluate(() => window.__tiny3.serializer.serialize().camera.settings);
check('Play uses them: first person at the set eye height; follow at the set distance, height and side — and they save',
  Math.abs(eyeInPlay - 1.6) < 0.05 && followInPlay.mode === 'follow'
  && Math.abs(followInPlay.across - Math.hypot(9, 1)) < 0.25 && Math.abs(followInPlay.up - 2) < 0.25
  && savedCamera.eyeHeight === 1.6 && savedCamera.followOffset === 9 && savedCamera.followSide === 1
  && savedCamera.followAvoidWalls === false,
  JSON.stringify({ eyeInPlay, followInPlay, saved: { eye: savedCamera.eyeHeight, side: savedCamera.followSide } }));
// head bob, set in the First person tab: the eye rises and falls with each step
await camSlider('fps', 'eyeHeight', 1.1);
await camSlider('fps', 'headBob', 0.06);
await camSlider('fps', 'bobStep', 1.2);
await page.evaluate(() => document.querySelector('.cam-btn[data-mode="fps"]').click());
await clickPlay();
await page.waitForTimeout(700);
const bobHeights = async (walk) => {
  if (walk) await page.keyboard.down('w');
  const ys = [];
  for (let i = 0; i < 24; i++) {
    ys.push(await page.evaluate(() => {
      const p = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Player').object3D;
      return window.__engine.camera.position.y - p.position.y;
    }));
    await page.waitForTimeout(40);
  }
  if (walk) await page.keyboard.up('w');
  return +(Math.max(...ys) - Math.min(...ys)).toFixed(3);
};
const standingBob = await bobHeights(false);
const walkingBob = await bobHeights(true);
await clickPlay();
await page.waitForTimeout(1500);
check('head bob: set in the First person tab, the view rises and falls with each step, and stays still standing',
  walkingBob > 0.06 && walkingBob < 0.14 && standingBob < 0.01, JSON.stringify({ standingBob, walkingBob }));

// back to how the rest of this run expects the camera
await page.evaluate(async () => {
  const { applyCameraSettings, CAMERA_DEFAULTS } = await import('/src/cameras.js');
  applyCameraSettings(window.__engine.cameraRig, CAMERA_DEFAULTS);
});

// ---- live prefabs: edit one copy, apply, every copy in every level follows ----
const prefabState = () => page.evaluate(() => {
  const ed = window.__tiny3.editor;
  const crates = ed.selectables.filter((e) => e.prefab === 'Crate');
  return {
    library: window.__engine.prefabs.names(),
    list: [...document.querySelectorAll('#asset-list li')].map((li) => `${li.querySelector('.nm')?.textContent}:${li.querySelector('.cnt')?.textContent}`),
    crates: crates.map((e) => ({
      color: e.object3D.material.color.getHexString(),
      scale: +e.object3D.scale.x.toFixed(2),
      x: +e.object3D.position.x.toFixed(2),
    })),
    box: document.querySelector('#insp-prefab .prefab-box')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
  };
});
page.once('dialog', (d) => d.accept('Crate'));
await page.evaluate(() => {
  document.querySelector('[data-add="box"]').click();
  const sel = window.__tiny3.editor.selected;
  sel.object3D.name = 'Crate';
  sel.object3D.position.set(-6, 0.75, 6);
  sel.object3D.material.color.set('#aa7744');
  document.getElementById('btn-save-prefab').click();
});
await page.waitForTimeout(300);
const pf0 = await prefabState();
check('💾 Prefab saves the object into the game, and it becomes the first linked copy',
  pf0.library.join() === 'Crate' && pf0.list.join() === 'Crate:1' && /Copy of Crate/.test(pf0.box || ''),
  JSON.stringify(pf0));

// two more copies from the asset list, and one in the other level
for (let i = 0; i < 2; i++) {
  await page.evaluate(() => document.querySelector('#asset-list li .nm').click());
  await page.waitForTimeout(300);
  await page.evaluate((i) => { window.__tiny3.editor.selected.object3D.position.set(-3 + i * 2, 0.75, 6); }, i);
}
await page.evaluate(() => document.querySelector('#level-list .lvl-row[data-i="1"] .lvl-name')
  .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
await page.waitForTimeout(900);
await page.evaluate(() => document.querySelector('#asset-list li .nm').click());
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('#level-list .lvl-row[data-i="0"] .lvl-name')
  .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
await page.waitForTimeout(900);
const pf1 = await prefabState();
check('placed copies are linked, and the list counts them across levels',
  pf1.crates.length === 3 && pf1.list.join() === 'Crate:4', JSON.stringify(pf1));

// the last copy gets bigger: that is its own change, shown in the Prefab box
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  const crates = ed.selectables.filter((e) => e.prefab === 'Crate');
  ed.select(crates[2]);
  crates[2].object3D.scale.setScalar(2);
  ed.refreshPrefabStatus();
});
const pfBig = await prefabState();
check('a copy\'s own change shows as an override in the Inspector',
  /Changed on this copy only: Size/.test(pfBig.box || ''), pfBig.box);

// recolour the first copy and apply it to all
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  const first = ed.selectables.find((e) => e.prefab === 'Crate');
  ed.select(first);
  first.object3D.material.color.set('#2255ff');
  ed.refreshPrefabStatus();
});
await page.evaluate(() => document.querySelector('#insp-prefab button[data-prefab="apply"]:not([data-part])').click());
await page.waitForTimeout(600);
const pf2 = await prefabState();
const bossCrate = await page.evaluate(() => window.__tiny3.project.levels[1].data.entities
  .find((d) => d.prefab === 'Crate')?.material?.color);
check('Apply to all recolours every copy, and the bigger one stays bigger',
  pf2.crates.length === 3 && pf2.crates.every((c) => c.color === '2255ff')
  && pf2.crates.map((c) => c.scale).join() === '1,1,2' && pf2.crates.map((c) => c.x).join() === '-6,-3,-1',
  JSON.stringify(pf2.crates));
check('...including the copy in the other level', bossCrate === '#2255ff', bossCrate);

await page.evaluate(() => document.getElementById('btn-undo').click());
await page.waitForTimeout(600);
const pfUndo = await prefabState();
await page.evaluate(() => document.getElementById('btn-redo').click());
await page.waitForTimeout(600);
const pfRedo = await prefabState();
check('undo puts the prefab and every copy back; redo applies it again',
  pfUndo.crates.every((c) => c.color === 'aa7744') && pfRedo.crates.every((c) => c.color === '2255ff'),
  JSON.stringify({ undo: pfUndo.crates.map((c) => c.color), redo: pfRedo.crates.map((c) => c.color) }));

// Revert on the bigger copy: back to the prefab's size
await page.evaluate(() => {
  const ed = window.__tiny3.editor;
  ed.select(ed.selectables.filter((e) => e.prefab === 'Crate')[2]);
});
await page.evaluate(() => document.querySelector('#insp-prefab button[data-prefab="revert"]:not([data-part])').click());
await page.waitForTimeout(600);
const pf3 = await prefabState();
check('Revert throws away a copy\'s own change',
  pf3.crates.map((c) => c.scale).join() === '1,1,1' && /Matches the prefab/.test(pf3.box || ''), JSON.stringify(pf3));

// a rule that spawns one in play: K drops a crate (the export below checks it too)
await page.evaluate(() => {
  const eng = window.__engine;
  const ground = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Ground');
  eng.gameplay.rules.setFor(ground, [...eng.gameplay.rules.listFor(ground), {
    when: { type: 'key', code: 'KeyK', mode: 'pressed' }, if: [],
    do: [{ type: 'spawn', prefab: 'Crate', at: 'origin' }],
  }]);
});
await clickPlay();
await page.waitForTimeout(600);
await page.keyboard.press('k');
await page.waitForTimeout(300);
const spawnedInPlay = await page.evaluate(() => window.__tiny3.editor.selectables.filter((e) => e.prefab === 'Crate').length);
await clickPlay();
await page.waitForTimeout(1200);
const afterSpawnStop = await prefabState();
check('"Spawn prefab" builds a linked copy in play; Stop takes it away again',
  spawnedInPlay === 4 && afterSpawnStop.crates.length === 3, `${spawnedInPlay} in play, ${afterSpawnStop.crates.length} after`);

// ---- export: one file that runs on its own, even straight off the disk ----
// REGRESSION: the export loaded ./lib and ./src from next to itself, so opened
// from Downloads the browser blocked every script and the game was black.
const glbChooser = page.waitForEvent('filechooser');
await page.evaluate(() => document.getElementById('btn-load-glb').click());
await (await glbChooser).setFiles(join(process.cwd(), 'assets', 'duck.glb'));
await page.waitForFunction(() => window.__tiny3.editor.selectables
  .some((e) => e.object3D.name === 'duck.glb'), null, { timeout: 8000 });

// a made texture on the ground, to prove materials ship in the exported game
await page.evaluate(async () => {
  const { applyMaterialSpec, withMadeTexture, materialSpec } = await import('/src/materials.js');
  const ground = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Ground').object3D;
  const spec = withMadeTexture(materialSpec(ground.material), { pattern: 'tiles', size: 256 });
  spec.uv.repeat = [6, 6];
  await applyMaterialSpec(ground.material, spec);
});
const download = page.waitForEvent('download', { timeout: 30000 });
// Export opens a choice: one file, or a website — this checks the one file
await page.evaluate(() => {
  document.getElementById('btn-export').click();
  document.querySelector('#export-dialog [data-export="file"]').click();
});
const exportedPath = join(tmpdir(), 'tiny3-smoke-export.html');
await (await download).saveAs(exportedPath);

const game = await browser.newPage({ viewport: { width: 1100, height: 650 } });
const gameErrors = [];
game.on('pageerror', (e) => gameErrors.push(`pageerror: ${e.message}`));
game.on('console', (m) => { if (m.type() === 'error') gameErrors.push(m.text()); });
await game.goto(pathToFileURL(exportedPath).href);
await game.waitForFunction(() => !!window.__tiny3Game, null, { timeout: 20000 }).catch(() => {});
await game.waitForTimeout(800);
const exportedGame = await game.evaluate(() => {
  const g = window.__tiny3Game;
  if (!g) return { booted: false, text: document.body.innerText.slice(0, 200) };
  const { engine } = g;
  engine.renderer.render(engine.scene, engine.camera);
  const src = engine.renderer.domElement;
  const copy = document.createElement('canvas');
  copy.width = src.width;
  copy.height = src.height;
  const ctx = copy.getContext('2d');
  ctx.drawImage(src, 0, 0);
  // brightest of a few points across the middle of the view
  let brightest = 0;
  for (const fx of [0.3, 0.5, 0.7]) {
    const [r, gg, b] = ctx.getImageData(Math.round(src.width * fx), Math.round(src.height * 0.55), 1, 1).data;
    brightest = Math.max(brightest, Math.round(0.2126 * r + 0.7152 * gg + 0.0722 * b));
  }
  return {
    booted: true,
    names: engine.entities.map((e) => e.object3D.name),
    lit: engine.environment.enabled,
    brightest,
    touchButtons: document.querySelectorAll('.t3-touch-btn:not(.t3-mute)').length,
    joystick: !!document.querySelector('.t3-stick'),
    hud: document.querySelector('.t3-hud')?.textContent,
    hint: document.getElementById('hint')?.textContent,
    sounds: engine.sounds.map((s) => `${s.name}${s.synth ? ':made' : ''}`),
    crates: engine.entities.filter((e) => e.prefab === 'Crate').length,
    ground: (() => {
      const m = engine.scene.getObjectByName('Ground')?.material;
      return m ? { made: m.map?.userData?.source?.procedural?.pattern, normal: !!m.normalMap, repeat: m.map?.repeat?.toArray() } : null;
    })(),
    mute: (() => {
      const btn = document.querySelector('.t3-mute');
      if (!btn) return null;
      const before = engine.listener.getMasterVolume();
      btn.click();
      const muted = engine.listener.getMasterVolume();
      btn.click();
      return { before, muted, after: engine.listener.getMasterVolume(), icon: btn.textContent };
    })(),
  };
});
// prefabs travel in the export: K (a rule) spawns a crate
await game.keyboard.press('k');
await game.waitForTimeout(300);
const exportedCrates = await game.evaluate(() => window.__tiny3Game?.engine.entities.filter((e) => e.prefab === 'Crate').length);
check('an exported game can spawn prefabs (spawners, Spawn rules and Shoot used to do nothing there)',
  exportedGame.crates === 3 && exportedCrates === 4, `${exportedGame.crates} placed, ${exportedCrates} after K`);
// the exported game has both levels: N (the rule) takes it to the boss room
await game.keyboard.press('n');
await game.waitForTimeout(1500);
const exportedLevels = await game.evaluate(() => {
  const g = window.__tiny3Game;
  return g ? {
    levels: g.project.names(),
    active: g.project.active,
    names: g.engine.entities.map((e) => e.object3D.name),
    score: g.engine.variables.get('score'),
  } : null;
});
// the pause menu: Esc freezes the game; Restart level puts the level back as it began
await game.evaluate(() => window.__tiny3Game.engine.variables.set('score', 10));
await game.keyboard.press('Escape');
await game.waitForTimeout(200);
const paused = await game.evaluate(() => {
  const { engine } = window.__tiny3Game;
  return {
    open: !!document.querySelector('.t3-pause'), paused: engine.paused, time: engine.time,
    level: document.querySelector('.t3-pause-level')?.textContent,
    buttons: [...document.querySelectorAll('.t3-pause button')].map((b) => b.textContent),
  };
});
await game.waitForTimeout(400);
const stillFrozen = await game.evaluate(() => window.__tiny3Game.engine.time);
await game.click('.t3-pause [data-act="level"]');
await game.waitForTimeout(1200);
const restarted = await game.evaluate(() => {
  const { engine, project } = window.__tiny3Game;
  return { open: !!document.querySelector('.t3-pause'), paused: engine.paused, active: project.active, score: engine.variables.get('score') };
});
await game.click('.t3-pause-btn'); // the ⏸ for touch screens
await game.waitForTimeout(200);
const byButton = await game.evaluate(() => !!document.querySelector('.t3-pause'));
await game.keyboard.press('Escape');
await game.waitForTimeout(200);
const resumed = await game.evaluate(() => ({ open: !!document.querySelector('.t3-pause'), paused: window.__tiny3Game.engine.paused }));
check('Esc pauses an exported game in a menu, and the game really stops',
  paused.open && paused.paused && paused.level === 'Boss room' && stillFrozen === paused.time
  && paused.buttons.join() === 'Resume,Restart level,Restart game', JSON.stringify({ ...paused, stillFrozen }));
check('Restart level starts the level again, with the score it began with',
  !restarted.open && !restarted.paused && restarted.active === 1 && restarted.score === 3, JSON.stringify(restarted));
check('the ⏸ button pauses too, and Esc resumes', byButton && !resumed.open && !resumed.paused,
  JSON.stringify({ byButton, resumed }));
await game.close();
check('the exported game carries every level and moves between them',
  exportedLevels?.levels.join() === 'Level 1,Boss room' && exportedLevels.active === 1
  && exportedLevels.names.includes('BossBox') && !exportedLevels.names.includes('Spinner') && exportedLevels.score === 3,
  JSON.stringify(exportedLevels));
check('an exported game runs straight off the disk', exportedGame.booted && gameErrors.length === 0,
  exportedGame.booted
    ? `${gameErrors.length} errors ${gameErrors.slice(0, 2).join(' | ')}`
    : exportedGame.text);
check('the exported game brings its imported models', !!exportedGame.names?.includes('duck.glb'),
  JSON.stringify(exportedGame.names));
check('the exported game is lit, not a black screen',
  exportedGame.lit && exportedGame.brightest > 25, `brightest ${exportedGame.brightest}/255`);
check('the exported game shows the variables on screen', /score\s*0/i.test(exportedGame.hud || ''),
  exportedGame.hud);
check('the exported game carries made textures, normal maps and tiling',
  exportedGame.ground?.made === 'tiles' && exportedGame.ground.normal && exportedGame.ground.repeat?.[0] === 6,
  JSON.stringify(exportedGame.ground));
check('the exported game carries its made sounds and scene ambience',
  (exportedGame.sounds || []).includes('coin:made') && exportedGame.sounds.includes('wind:made'),
  JSON.stringify(exportedGame.sounds));
check('the exported game has a working mute button',
  exportedGame.mute?.before === 1 && exportedGame.mute.muted === 0 && exportedGame.mute.after === 1,
  JSON.stringify(exportedGame.mute));
check('the exported game has the scene\'s joystick and touch buttons and describes its own keys',
  exportedGame.joystick && exportedGame.touchButtons >= 2
    && /W move forward/.test(exportedGame.hint || '') && /E interact/.test(exportedGame.hint || ''),
  `joystick ${exportedGame.joystick} · ${exportedGame.touchButtons} buttons · "${exportedGame.hint}"`);

// ---- a saved game file carries its own files, and opens in a browser that never saw them ----
// REGRESSION: Save named models, imported textures and sounds by an id in this
// browser's storage only — opened anywhere else, the duck was silently missing
const duckId = await page.evaluate(() => window.__tiny3.editor.selectables
  .find((e) => e.object3D.name === 'duck.glb')?.object3D.userData.assetId);
const saveDownload = page.waitForEvent('download', { timeout: 30000 });
await page.click('#btn-save');
const saved = await saveDownload;
const savedPath = join(tmpdir(), 'tiny3-smoke-save.tiny3');
await saved.saveAs(savedPath);
// a .tiny3: game.json and its files as the files they are (game-file.js) — no base64
const { readZip } = await import('../../src/zip.js');
const savedEntries = await readZip(new Blob([readFileSync(savedPath)]));
const savedGame = JSON.parse(new TextDecoder().decode(savedEntries.find((e) => e.path === 'game.json')?.data ?? new Uint8Array()));
const duckFile = savedEntries.find((e) => e.path.startsWith(`assets/${duckId}`));
check('Save puts the game\'s models, textures and sounds inside the file — as files, in one .tiny3',
  saved.suggestedFilename().endsWith('.tiny3') && !!duckId && duckFile?.data.length > 1000 && !savedGame.assets
  && savedGame.assetFiles?.some((a) => a.id === duckId),
  JSON.stringify({ name: saved.suggestedFilename(), duckId, files: savedEntries.map((e) => `${e.path}:${e.data.length}`) }));

const elsewhere = await browser.newPage({ viewport: { width: 1400, height: 900 } }); // its own, empty storage
const elsewhereErrors = [];
elsewhere.on('pageerror', (e) => elsewhereErrors.push(e.message));
await elsewhere.goto(URL, { waitUntil: 'networkidle' });
await elsewhere.waitForTimeout(1200);
const emptyBefore = await elsewhere.evaluate(async () => {
  const { assetStore } = await import('/src/assets-db.js');
  return (await assetStore.list()).length;
});
const opener = elsewhere.waitForEvent('filechooser');
await elsewhere.click('#btn-load');
await (await opener).setFiles(savedPath);
await elsewhere.waitForFunction(() => window.__tiny3.editor.selectables.some((e) => e.object3D.name === 'duck.glb'),
  null, { timeout: 15000 }).catch(() => {});
const openedElsewhere = await elsewhere.evaluate(() => {
  const duck = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'duck.glb');
  let meshes = 0;
  duck?.object3D.traverse((n) => { if (n.isMesh) meshes++; });
  return { duck: !!duck, meshes, levels: window.__tiny3.project.names() };
});
await elsewhere.close();
check('...and it opens with its duck in a browser whose storage has never seen it',
  emptyBefore === 0 && openedElsewhere.duck && openedElsewhere.meshes > 0
  && openedElsewhere.levels.join() === 'Level 1,Boss room' && elsewhereErrors.length === 0,
  JSON.stringify({ emptyBefore, openedElsewhere, elsewhereErrors }));

// ---- cleaning up: what nothing needs goes; what Undo could bring back stays ----
await page.evaluate(async () => {
  const { assetStore } = await import('/src/assets-db.js');
  await assetStore.put(new File([new Uint8Array(3000).fill(7)], 'orphan.bin'));
  const ed = window.__tiny3.editor;
  ed.select(ed.selectables.find((e) => e.object3D.name === 'duck.glb'));
  ed.deleteSelected(); // the duck's file is now used only by what Undo can bring back
});
await page.hover('#asset-browser > h3');
await page.waitForTimeout(500);
const storageLine = await page.evaluate(() => ({
  text: document.getElementById('asset-storage-text').textContent,
  enabled: !document.getElementById('btn-clean-assets').disabled,
}));
page.once('dialog', (d) => d.accept());
await page.evaluate(() => document.getElementById('btn-clean-assets').click());
await page.waitForTimeout(800);
const afterClean = await page.evaluate(async (duckId) => {
  const { assetStore } = await import('/src/assets-db.js');
  const names = (await assetStore.list()).map((m) => m.name);
  return { orphan: names.includes('orphan.bin'), duck: !!(await assetStore.get(duckId)), text: document.getElementById('asset-storage-text').textContent };
}, duckId);
await page.click('#btn-undo'); // the duck comes back — and its file is still there to save
await page.waitForTimeout(400);
const duckBack = await page.evaluate(() => window.__tiny3.editor.selectables.some((e) => e.object3D.name === 'duck.glb'));
check('Remove unused clears what nothing needs, and spares what Undo could bring back',
  storageLine.enabled && /unused/.test(storageLine.text) && !afterClean.orphan && afterClean.duck && duckBack
  && !/unused/.test(afterClean.text),
  JSON.stringify({ storageLine, afterClean, duckBack }));

// ---- templates: each opens as a game that actually plays ----
const shotDir = process.env.TINY3_SHOT_DIR;
await page.evaluate(() => document.getElementById('btn-new').click());
const tplCards = await page.evaluate(() =>
  [...document.querySelectorAll('#tpl-grid .tpl-card .tpl-name')].map((n) => n.textContent));
check('New opens a chooser: an empty game or a template',
  tplCards.join() === 'Empty,3D Platformer,Top-Down Collector,First-Person Explorer,Car Racing,AK Arena,Night Watch,Wild Valley,Hollow House', tplCards.join(' · '));
await page.evaluate(() => document.getElementById('new-cancel').click());

const openTemplate = async (id) => {
  await page.evaluate(() => document.getElementById('btn-new').click());
  await page.waitForSelector('#new-dialog:not([hidden])');
  await page.evaluate((i) => document.querySelector(`#tpl-grid [data-template="${i}"]`).click(), id);
  await page.waitForFunction(() => window.__tiny3.editor.selectables.some((e) => e.object3D.name === 'Player'),
    null, { timeout: 10000 });
  await page.waitForTimeout(600);
};
const playerState = () => page.evaluate(() => {
  const p = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Player');
  const r = (v) => +v.toFixed(2);
  return p ? { x: r(p.object3D.position.x), y: r(p.object3D.position.y), z: r(p.object3D.position.z),
    grounded: !!p.rigidBody?.grounded } : null;
});
const teleport = (name, offset = [0, 0, 0]) => page.evaluate(({ name, offset }) => {
  const ed = window.__tiny3.editor;
  const p = ed.selectables.find((e) => e.object3D.name === 'Player');
  const t = ed.selectables.find((e) => e.object3D.name === name);
  p.object3D.position.copy(t.object3D.position).add({ x: offset[0], y: offset[1], z: offset[2] });
  p.rigidBody.velocity.set(0, 0, 0);
}, { name, offset });
const gameState = () => page.evaluate(() => ({
  active: window.__tiny3.project.active,
  vars: { ...window.__engine.variables.values },
  outcome: window.__engine.gameplay.outcome,
  banner: document.querySelector('.t3-announce')?.textContent,
  prompt: document.querySelector('.t3-prompt.show')?.textContent,
  message: document.querySelector('.t3-message')?.textContent,
  hearts: document.querySelector('.t3-hud .t3-hearts')?.textContent,
  heartsLost: document.querySelector('.t3-hud .t3-hearts em')?.textContent,
  bars: document.querySelectorAll('.t3-hud .t3-bar').length,
  names: window.__tiny3.editor.selectables.map((e) => e.object3D.name),
}));

// 3D Platformer: land, run, the ring to level 2, the water costs a life
await openTemplate('platformer');
const plat = await page.evaluate(() => ({
  levels: window.__tiny3.project.names(), vars: window.__engine.variables.toJSON(),
  objects: window.__tiny3.editor.selectables.length,
}));
check('the 3D Platformer opens with its two levels, coins and lives',
  plat.levels.join() === 'Meadow,Sunset Heights' && plat.vars.lives === 3 && plat.objects > 15, JSON.stringify(plat));
await clickPlay();
await page.waitForTimeout(1500);
const platLanded = await playerState();
const platUI = await gameState();
check('Platformer: a start message, and lives shown as hearts',
  platUI.message === 'Reach the golden ring!' && platUI.hearts === '♥♥♥' && platUI.heartsLost === '',
  JSON.stringify({ message: platUI.message, hearts: platUI.hearts }));
await page.keyboard.down('w');
await page.waitForTimeout(350);
const platPose = await page.evaluate(() => {
  const p = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Player');
  const pose = window.__engine.poses.get(p.object3D);
  return pose ? { lean: +pose.lean.toFixed(3), sy: +pose.sy.toFixed(3) } : null;
});
await page.waitForTimeout(50);
await page.keyboard.up('w');
check('Platformer: the player leans into its run (Animator)', platPose?.lean > 0.05, JSON.stringify(platPose));
await page.waitForTimeout(200);
const platRan = await playerState();
if (shotDir) await page.screenshot({ path: join(shotDir, 'tpl-platformer.png') });
check('Platformer: the player lands on the island and W runs into the screen',
  platLanded.grounded && Math.abs(platLanded.y - 0.5) < 0.1 && platRan.z < platLanded.z - 1,
  JSON.stringify({ platLanded, platRan }));
// a real slope: start at the foot of the ramp and walk right, up onto the lookout
await teleport('Ramp', [-2.6, 0.4, 0]);
await page.waitForTimeout(500);
await page.keyboard.down('d');
await page.waitForTimeout(900);
await page.keyboard.up('d');
await page.waitForTimeout(500);
const onLookout = await playerState();
check('Platformer: walking right climbs the ramp onto the lookout',
  onLookout.x > 9 && onLookout.x < 12 && onLookout.y > 1.85 && onLookout.grounded, JSON.stringify(onLookout));
await teleport('Goal ring');
await page.waitForTimeout(1600);
const platNext = await gameState();
check('Platformer: the golden ring leads to the next level',
  platNext.active === 1 && platNext.banner === 'Sunset Heights', JSON.stringify({ active: platNext.active, banner: platNext.banner }));
await teleport('Water', [0, 0.5, 0]);
await page.waitForTimeout(1600);
const platFell = await gameState();
const platBack = await playerState();
check('Platformer: falling in the water costs a life (one heart empties) and restarts the level',
  platFell.vars.lives === 2 && platFell.active === 1 && platBack.z > -1 && platBack.y > -1 && platFell.heartsLost === '♥',
  JSON.stringify({ lives: platFell.vars.lives, active: platFell.active, player: platBack, hearts: platFell.hearts }));
await clickPlay();
await page.waitForTimeout(1500);

// Top-Down Collector: the clock runs, slimes chase, the last gem wins
await openTemplate('collector');
await clickPlay();
await page.waitForTimeout(1200);
const slimeGap = () => page.evaluate(() => {
  const ed = window.__tiny3.editor;
  const p = ed.selectables.find((e) => e.object3D.name === 'Player').object3D.position;
  return +ed.selectables.find((e) => e.object3D.name === 'Slime 1').object3D.position.distanceTo(p).toFixed(2);
});
const col1 = { ...(await gameState()), gap: await slimeGap() };
await page.waitForTimeout(1500);
const col2 = { ...(await gameState()), gap: await slimeGap() };
if (shotDir) await page.screenshot({ path: join(shotDir, 'tpl-collector.png') });
const gemCount = col1.names.filter((n) => /^Gem \d+$/.test(n)).length;
check('Collector: 12 gems, the clock counts down and the slimes chase you',
  gemCount === 12 && col1.vars.health === 3 && col2.vars.time < col1.vars.time && col2.gap < col1.gap,
  JSON.stringify({ gemCount, time: [col1.vars.time, col2.vars.time], gap: [col1.gap, col2.gap] }));
check('Collector: health and gems show as bars', col1.bars === 2, `${col1.bars} bars`);
await page.evaluate(() => window.__engine.variables.set('gems', 11));
await teleport('Gem 1');
await page.waitForTimeout(800);
const colWon = await gameState();
check('Collector: picking up the last gem wins',
  colWon.vars.gems === 12 && colWon.outcome?.result === 'win' && colWon.outcome.message === 'All gems collected!',
  JSON.stringify({ gems: colWon.vars.gems, outcome: colWon.outcome }));
await clickPlay();
await page.waitForTimeout(1500);

// First-Person Explorer: plays in first person, the lever opens the door, relics + portal win
await openTemplate('explorer');
const exp0 = await page.evaluate(() => ({
  mode: window.__engine.cameraRig.mode, playMode: window.__engine.cameraRig.playMode,
  panel: document.getElementById('cam-play-mode').value,
}));
check('Explorer opens in an editing view, set to play in first person',
  exp0.mode === 'orbit' && exp0.playMode === 'fps' && exp0.panel === 'fps', JSON.stringify(exp0));
const expSpace = await page.evaluate(() => ({
  space: window.__engine.audio.mix.space,
  amount: window.__engine.audio.mix.spaceAmount,
  built: !!window.__engine.audio.reverb?.buffer,
  panel: document.getElementById('aud-space').value,
}));
check('the Temple sounds like stone: its space is set, built and shown in the Audio panel',
  expSpace.space === 'hall' && expSpace.built && expSpace.panel === 'hall' && expSpace.amount === 0.45,
  JSON.stringify(expSpace));
await clickPlay();
await page.waitForTimeout(1200);
const exp1 = await page.evaluate(() => {
  const eng = window.__engine;
  const p = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'Player').object3D;
  const look = eng.camera.getWorldDirection(eng.camera.position.clone());
  return { mode: eng.cameraRig.mode, eye: +(eng.camera.position.y - p.position.y).toFixed(2),
    lookUpDown: +look.y.toFixed(2), gridHidden: eng.grid.visible === false,
    hud: document.querySelector('.t3-hud')?.textContent.replace(/\s+/g, ' ').trim(),
    hint: document.querySelector('.t3-announce')?.textContent };
});
if (shotDir) await page.screenshot({ path: join(shotDir, 'tpl-explorer.png') });
check('Explorer: Play switches to first person, from the player\'s eyes, looking ahead',
  exp1.mode === 'fps' && Math.abs(exp1.eye - 1.1) < 0.05 && Math.abs(exp1.lookUpDown) < 0.1
  && /Click to look around/.test(exp1.hint || ''), JSON.stringify(exp1));
check('Play hides the editor grid, and the HUD hides _private variables',
  exp1.gridHidden && /^relics\s*0$/.test(exp1.hud || ''), JSON.stringify({ grid: exp1.gridHidden, hud: exp1.hud }));
await teleport('Lever base', [0, 0.5, -1.3]);
await page.waitForTimeout(600);
const expNear = await gameState();
await page.keyboard.press('e');
await page.waitForTimeout(400);
const expOpened = await gameState();
check('Explorer: by the lever the prompt shows, and E opens the door',
  expNear.prompt === 'EPull the lever' && expNear.names.includes('Door') && !expOpened.names.includes('Door'),
  JSON.stringify({ prompt: expNear.prompt, doorAfter: expOpened.names.includes('Door') }));
await page.evaluate(() => window.__engine.variables.set('relics', 3));
await teleport('Exit portal');
await page.waitForTimeout(800);
const expWon = await gameState();
check('Explorer: with three relics the portal wins', expWon.outcome?.result === 'win', JSON.stringify(expWon.outcome));
await clickPlay();
await page.waitForTimeout(1500);
check('Stop brings the editing view back', await page.evaluate(() => window.__engine.cameraRig.mode === 'orbit'));

// ---- AK Arena: a template made from model files, brought into the game as if imported
await openTemplate('shooter');
await page.waitForFunction(() => window.__engine.entities.filter((e) => e.object3D.userData.assetId && e.object3D.children.length).length === 5,
  null, { timeout: 90000 });
const sh0 = await page.evaluate(() => ({
  stored: window.__engine.entities.filter((e) => e.object3D.userData.assetId).map((e) => e.object3D.name),
  held: !!window.__engine.entities.find((e) => e.object3D.name === 'AK74u')?.viewModel,
}));
check('AK Arena opens with its models in the game\'s own store (they save and export with it), the AK held in view',
  sh0.stored.length === 5 && sh0.held && sh0.stored.includes('Robot 4'), JSON.stringify(sh0));
await clickPlay();
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const e = window.__engine.entities.find((x) => x.object3D.name === 'Robot 1');
  const p = e.object3D.position.clone();
  p.y += 1;
  const d = p.sub(window.__engine.camera.position);
  window.__engine.cameraRig.yaw = Math.atan2(-d.x, -d.z);
  window.__engine.cameraRig.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
});
await page.waitForTimeout(100);
const shAt = await page.evaluate(() => { const b = window.__engine.renderer.domElement.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });
await page.mouse.click(...shAt);
await page.waitForTimeout(300);
const sh1 = await page.evaluate(() => {
  const e = window.__engine.entities.find((x) => x.object3D.name === 'Robot 1');
  return { ammo: window.__engine.variables.get('ammo'), robot: window.__engine.gameplay.components.listFor(e).find((c) => c.type === 'health').state.current,
    hud: document.querySelector('.t3-touch .t3-hud')?.textContent.replace(/\s+/g, ' ').trim() };
});
if (shotDir) await page.screenshot({ path: join(shotDir, 'tpl-shooter.png') });
check('AK Arena: a click shoots — one round fewer, the robot one bullet down', sh1.ammo === 29 && sh1.robot === 2 && /Ammo\s*29/.test(sh1.hud), JSON.stringify(sh1));
await clickPlay();
await page.waitForTimeout(800);

// the title screen: set up in the Game panel, shown on Play when asked; the game waits for a key
await page.evaluate(() => {
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set('ui-title-on', true);
  set('ui-title-text', 'Temple Run');
  set('ui-title-prompt', 'Click to begin');
  set('ui-title-editor', true);
});
await clickPlay();
await page.waitForTimeout(600);
const titleUp = await page.evaluate(() => ({
  title: document.querySelector('.t3-title h1')?.textContent,
  prompt: document.querySelector('.t3-title .t3-press')?.textContent,
  paused: window.__engine.paused,
}));
if (shotDir) await page.screenshot({ path: join(shotDir, 'title-screen.png') });
await page.keyboard.press('x');
await page.waitForTimeout(300);
const titleGone = await page.evaluate(() => ({ gone: !document.querySelector('.t3-title'), paused: window.__engine.paused }));
check('A title screen shows on Play, and the game waits for a key',
  titleUp.title === 'Temple Run' && titleUp.prompt === 'Click to begin' && titleUp.paused && titleGone.gone && !titleGone.paused,
  JSON.stringify({ titleUp, titleGone }));
await clickPlay();
await page.waitForTimeout(1500);

// REGRESSION: "New" called editor.removeEntity, which did not exist, so it
// threw on any scene with an object in it
await page.evaluate(() => document.getElementById('btn-new').click());
await page.evaluate(() => document.querySelector('#tpl-grid [data-template="empty"]').click());
await page.waitForTimeout(400);
const fresh = await page.evaluate(() => ({
  objects: window.__tiny3.editor.selectables.length,
  controls: window.__engine.gameplay.controls.list.length,
  sounds: window.__engine.sounds.length,
  materials: window.__engine.materialLibrary.size,
  levels: window.__tiny3.project.levels.length,
}));
check('New empties the game: one level, no objects, sounds or saved materials; default controls',
  fresh.objects === 0 && fresh.sounds === 0 && fresh.materials === 0 && fresh.controls === 5 && fresh.levels === 1,
  JSON.stringify(fresh));

// ---- animated models: any clip on anything you press; first-person arms; third person ----
// Nothing assumes a clip's name or what it is for: the test picks and binds
// them the way a game maker would. REGRESSION: rigged characters stood frozen
// (their skin followed the file's own, never-animated bones), and a key or a
// click could not play a clip at all.
await page.evaluate(async () => {
  const { RigidBody } = await import('/src/physics.js');
  document.querySelector('[data-add="box"]').click();
  const f = window.__tiny3.editor.selected;
  f.object3D.name = 'Range floor';
  f.object3D.scale.set(40, 1, 40);
  f.object3D.position.set(0, -0.75, 0); // its top at 0
  f.rigidBody = new RigidBody({ type: 'static' });
  window.__engine.physics.register(f);
});
const importModel = async (file) => {
  const picker = page.waitForEvent('filechooser');
  await page.evaluate(() => document.getElementById('btn-load-glb').click());
  await (await picker).setFiles(join(process.cwd(), 'assets', file));
  await page.waitForFunction((f) => window.__tiny3.editor.selectables.some((e) => e.object3D.name === f), file, { timeout: 10000 });
  await page.evaluate((f) => {
    const ed = window.__tiny3.editor;
    ed.select(ed.selectables.find((e) => e.object3D.name === f));
  }, file);
  await page.waitForTimeout(200);
};
const pickClip = async (label, clip) => {
  const id = await page.evaluate((label) => [...document.querySelectorAll('.gp-card .prop-row')]
    .find((r) => r.querySelector('label')?.textContent === label)?.querySelector('select')?.id, label);
  await page.selectOption(`#${id}`, clip);
};
const bindClip = async (clip, press) => {
  await page.evaluate((clip) => [...document.querySelectorAll('.anim-list li')]
    .find((l) => l.querySelector('.anim-name').textContent === clip).querySelector('[data-anim-bind]').click(), clip);
  await page.waitForSelector('.anim-capture');
  await press();
  await page.waitForTimeout(200);
};
const clipShowing = (name) => page.evaluate((name) => {
  const e = window.__tiny3.editor.selectables.find((x) => x.object3D.name === name);
  return window.__engine.mixers.find((m) => m.root === e?.object3D)?.playing ?? null;
}, name);

await importModel('blaster.glb');
const blasterClips = await page.evaluate(() => [...document.querySelectorAll('.anim-list .anim-name')].map((n) => n.textContent));
await page.click('#anim-as-arms');
await page.waitForTimeout(200);
await pickClip('Standing', 'Idle');
await pickClip('Walking', 'Walk');
// its default clip, while editing: "Plays on its own" shows the Animator's standing clip
const defaultShown = await page.evaluate(() => document.getElementById('anim-default')?.value);
await page.click('#anim-default-edit');
await page.waitForTimeout(400);
const loopingWhileEditing = await clipShowing('blaster.glb');
await page.click('#anim-default-edit');
await page.waitForTimeout(400);
const afterUntick = await clipShowing('blaster.glb');
check('a model plays its default clip on its own — in the editor too, when asked — and stops when not',
  defaultShown === 'Idle' && loopingWhileEditing === 'Idle' && !afterUntick, // nothing playing (or no player at all)
  JSON.stringify({ defaultShown, loopingWhileEditing, afterUntick }));
await bindClip('Shoot', async () => {
  const b = await page.locator('.anim-capture').boundingBox();
  await page.mouse.click(b.x + 30, b.y + 30);
});
await bindClip('Reload', () => page.keyboard.press('r'));
// a shooter wants a crosshair — games have none until they choose one
const noCrosshairYet = await page.evaluate(() => window.__engine.ui.crosshair.style);
await page.evaluate(() => {
  const style = document.querySelector('#ui-crosshair [data-xh="style"]');
  style.value = 'dot';
  style.dispatchEvent(new Event('change', { bubbles: true }));
});
const blasterSetup = await page.evaluate(() => {
  const e = window.__tiny3.editor.selected;
  return {
    selected: e?.object3D.name,
    held: !!e?.viewModel, playMode: window.__engine.cameraRig.playMode,
    bindings: window.__engine.gameplay.controls.list.filter((c) => c.action.type === 'playAnimation')
      .map((c) => `${c.inputs[0].type === 'mouse' ? 'mouse ' + c.inputs[0].button : c.inputs[0].code}:${c.action.clip}`),
    chips: [...document.querySelectorAll('.anim-chip')].map((c) => c.textContent.replace('×', '')),
    gizmo: window.__tiny3.editor.gizmoMode,
  };
});
check('a model lists its own clips; binding one is pressing what should play it (the editor\'s own keys stay quiet)',
  blasterClips.join() === 'Idle,Walk,Shoot,Reload' && blasterSetup.selected === 'blaster.glb' && blasterSetup.held
  && blasterSetup.playMode === 'fps' && blasterSetup.bindings.join() === 'mouse left:Shoot,KeyR:Reload'
  && blasterSetup.chips.join() === 'Mouse left,R' && blasterSetup.gizmo === 'translate' && noCrosshairYet === 'none',
  JSON.stringify({ blasterClips, blasterSetup, noCrosshairYet }));

// more clips: another file of moves for the same rig (and one for a different rig),
// then a part cut out of a clip — as when a model's file holds one animation
const extraPicker = page.waitForEvent('filechooser');
await page.click('#anim-add-files');
await (await extraPicker).setFiles([join(process.cwd(), 'assets', 'blaster-inspect.glb'), join(process.cwd(), 'assets', 'robot.glb')]);
await page.waitForFunction(() => document.querySelector('.anim-note'), null, { timeout: 10000 });
const afterAdd = await page.evaluate(() => ({
  note: document.querySelector('.anim-note').textContent,
  clips: [...document.querySelectorAll('.anim-list .anim-name')].map((n) => n.textContent),
}));
await page.evaluate(() => [...document.querySelectorAll('.anim-list li')]
  .find((l) => l.querySelector('.anim-name')?.textContent === 'Reload').querySelector('[data-anim-cut]').click());
await page.fill('#anim-cut-name', 'Reload hold');
await page.fill('#anim-cut-from', '0.3');
await page.fill('#anim-cut-to', '1.1');
await page.click('#anim-cut-ok');
await page.waitForTimeout(300);
const afterCut = await page.evaluate(() => {
  const e = window.__tiny3.editor.selectables.find((x) => x.object3D.name === 'blaster.glb');
  const saved = window.__tiny3.serializer.entityRecord(e);
  return {
    clips: e.object3D.userData.animations.map((c) => `${c.name}:${c.duration.toFixed(1)}`),
    savedFiles: (saved.animationFiles || []).map((f) => f.name), savedCuts: saved.clipCuts,
  };
});
check('clips from other files join the model (a different rig\'s are refused, saying why); a long clip can be cut into parts',
  afterAdd.clips.join() === 'Idle,Walk,Shoot,Reload,blaster-inspect'
  && /blaster-inspect\.glb: 1 clip added/.test(afterAdd.note) && /robot\.glb: its clips move a skeleton this model doesn't have/.test(afterAdd.note)
  && afterCut.clips.includes('Reload hold:0.8') && afterCut.savedFiles.join() === 'blaster-inspect.glb,robot.glb'
  && afterCut.savedCuts?.[0]?.from === 'Reload',
  JSON.stringify({ afterAdd, afterCut }));

await clickPlay();
await page.waitForTimeout(900);
// held in view: drawn in front of the camera even with a wall right in front of it
const heldPixels = await page.evaluate(async () => {
  const THREE = await import('three');
  const eng = window.__engine;
  const gun = window.__tiny3.editor.selectables.find((e) => e.object3D.name === 'blaster.glb');
  const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 0.05), new THREE.MeshBasicMaterial({ color: 0x777777 }));
  const dir = eng.camera.getWorldDirection(new THREE.Vector3());
  wall.position.copy(eng.camera.position).addScaledVector(dir, 0.3);
  wall.lookAt(eng.camera.position);
  eng.scene.add(wall);
  const src = eng.renderer.domElement;
  const sample = () => {
    const { renderWithViewModels } = window.__tiny3ViewModel;
    renderWithViewModels(eng.renderer, eng.scene, eng.camera, eng.entities, true);
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    // the lower right, where a held gun sits
    const d = ctx.getImageData(Math.round(src.width * 0.55), Math.round(src.height * 0.6),
      Math.round(src.width * 0.4), Math.round(src.height * 0.35)).data;
    let off = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 119) + Math.abs(d[i + 1] - 119) + Math.abs(d[i + 2] - 119) > 30) off++;
    return off / (d.length / 4);
  };
  window.__tiny3ViewModel = await import('/src/view-model.js');
  const vm = gun.viewModel;
  delete gun.viewModel;
  const wallOnly = sample();
  gun.viewModel = vm;
  const withGun = sample();
  eng.scene.remove(wall);
  return { wallOnly: +wallOnly.toFixed(3), withGun: +withGun.toFixed(3) };
});
check('a held gun is drawn in front of the camera — even with a wall right in front of it',
  heldPixels.wallOnly < 0.02 && heldPixels.withGun > 0.05, JSON.stringify(heldPixels));

const idleFirst = await clipShowing('blaster.glb');
await page.mouse.click(700, 450);
await page.waitForTimeout(80);
const onClick = await clipShowing('blaster.glb');
await page.waitForTimeout(600);
const afterShot = await clipShowing('blaster.glb');
await page.keyboard.press('r');
await page.waitForTimeout(150);
const onR = await clipShowing('blaster.glb');
await page.mouse.click(700, 450);
await page.waitForTimeout(100);
const midReload = await clipShowing('blaster.glb');
await page.waitForTimeout(1600);
await page.keyboard.down('w');
await page.waitForTimeout(500);
const onW = await clipShowing('blaster.glb');
await page.keyboard.up('w');
check('first person: the click plays its clip and goes back, R reloads, a shot can\'t cut the reload short, walking animates',
  idleFirst === 'Idle' && onClick === 'Shoot' && afterShot === 'Idle' && onR === 'Reload' && midReload === 'Reload' && onW === 'Walk',
  JSON.stringify({ idleFirst, onClick, afterShot, onR, midReload, onW }));
await clickPlay();
await page.waitForTimeout(1200);

// the same game, exported: held in view and bound clips come with it
const animatedExport = join(tmpdir(), 'tiny3-smoke-animated.html');
writeFileSync(animatedExport, await page.evaluate(() => window.__tiny3.exporter.buildGame()));
const shooter = await browser.newPage({ viewport: { width: 1100, height: 650 } });
const shooterErrors = [];
shooter.on('pageerror', (e) => shooterErrors.push(e.message));
await shooter.goto(pathToFileURL(animatedExport).href);
await shooter.waitForFunction(() => !!window.__tiny3Game, null, { timeout: 20000 }).catch(() => {});
await shooter.waitForTimeout(800);
const shooterClip = () => shooter.evaluate(() => {
  const { engine } = window.__tiny3Game;
  const gun = engine.entities.find((e) => e.object3D.name === 'blaster.glb');
  return { mode: engine.cameraRig.mode, held: !!gun?.viewModel, playing: engine.mixers.find((m) => m.root === gun?.object3D)?.playing ?? null,
    clips: (gun?.object3D.userData.animations || []).map((c) => c.name),
    crosshair: !!document.querySelector('.t3-crosshair svg') };
});
const shooterIdle = await shooterClip();
await shooter.mouse.click(550, 325);
await shooter.waitForTimeout(80);
const shooterFired = await shooterClip();
await shooter.close();
check('...and exported, it plays the same: held in view, a crosshair, click to shoot, with its added and cut clips',
  shooterIdle.mode === 'fps' && shooterIdle.held && shooterIdle.crosshair && shooterIdle.playing === 'Idle' && shooterFired.playing === 'Shoot'
  && shooterIdle.clips.join() === 'Idle,Walk,Shoot,Reload,blaster-inspect,Reload hold'
  && shooterErrors.length === 0, JSON.stringify({ shooterIdle, shooterFired, shooterErrors }));

// third person: a rigged robot becomes the player
await importModel('robot.glb');
await page.evaluate(() => window.__tiny3.editor.selected.object3D.scale.setScalar(0.5));
await page.click('#anim-as-player');
await page.waitForTimeout(200);
await pickClip('Standing', 'Idle');
await pickClip('Walking', 'Walking');
await pickClip('Running', 'Running');
await pickClip('In the air', 'Jump');
await bindClip('Wave', () => page.keyboard.press('g'));
await clickPlay();
await page.waitForTimeout(1500);
const robotState = () => page.evaluate(async () => {
  const THREE = await import('three');
  const e = window.__tiny3.editor.selectables.find((x) => x.object3D.name === 'robot.glb');
  let hand = null;
  e.object3D.traverse((n) => { if (n.isSkinnedMesh && !hand) hand = n; });
  const v = hand.getVertexPosition(0, new THREE.Vector3()).applyMatrix4(hand.matrixWorld);
  const box = new THREE.Box3().setFromObject(e.object3D, true);
  return {
    playing: window.__engine.mixers.find((m) => m.root === e.object3D)?.playing, mode: window.__engine.cameraRig.mode,
    feet: +box.min.y.toFixed(2), grounded: !!e.rigidBody?.grounded,
    hand: v.sub(e.object3D.position).toArray().map((x) => +x.toFixed(3)), // relative to the robot
  };
});
const robotStill = await robotState();
await page.keyboard.down('w');
await page.waitForTimeout(700);
const robotRunning = await robotState();
await page.keyboard.up('w');
await page.waitForTimeout(600);
await page.keyboard.press('g');
await page.waitForTimeout(300);
const robotWaving = await robotState();
await page.waitForTimeout(2500);
const robotBack = await robotState();
await page.keyboard.press('Space');
await page.waitForTimeout(150);
const robotJumping = await robotState();
await clickPlay();
await page.waitForTimeout(1200);
check('third person: a rigged robot stands on the floor, runs, waves on the key bound to it, and jumps — its skin moving with it',
  robotStill.playing === 'Idle' && robotStill.mode === 'follow' && robotStill.grounded && Math.abs(robotStill.feet) < 0.06
  && robotRunning.playing === 'Running' && robotWaving.playing === 'Wave' && robotBack.playing === 'Idle'
  && robotJumping.playing === 'Jump' && robotWaving.hand.join() !== robotStill.hand.join(),
  JSON.stringify({ robotStill, robotRunning, robotWaving, robotBack, robotJumping }));

// sprint: a control like any other — here Shift, held — speeds the player up; its Animator runs past "Run from"
await page.evaluate(() => {
  const { gameplay } = window.__engine;
  const robot = window.__tiny3.editor.selectables.find((x) => x.object3D.name === 'robot.glb');
  gameplay.components.listFor(robot).find((c) => c.type === 'animator').props.runSpeed = 11;
  gameplay.controls.load([...gameplay.controls.toJSON(),
    { inputs: [{ type: 'key', code: 'ShiftLeft' }], target: 'player', action: { type: 'sprint', multiplier: 2, fovBoost: 12 } }]);
});
await clickPlay();
await page.waitForTimeout(1500);
const sprintState = () => page.evaluate(() => {
  const e = window.__tiny3.editor.selectables.find((x) => x.object3D.name === 'robot.glb');
  const rig = window.__engine.cameraRig;
  const v = e.rigidBody.velocity;
  return { speed: +Math.hypot(v.x, v.z).toFixed(2), playing: window.__engine.mixers.find((m) => m.root === e.object3D)?.playing,
    fovOver: +(rig.camera.fov - rig.fovFor()).toFixed(2) };
});
await page.keyboard.down('w');
await page.waitForTimeout(600);
const walking = await sprintState();
await page.keyboard.down('Shift');
await page.waitForTimeout(600);
const sprinting = await sprintState();
await page.keyboard.up('Shift');
await page.waitForTimeout(700);
const walkingAgain = await sprintState();
await page.keyboard.up('w');
await clickPlay();
await page.waitForTimeout(1200);
check('sprint: holding its key (Shift here) doubles the pace, the Animator switches to running and the view widens — let go and it all eases back',
  walking.playing === 'Walking' && sprinting.playing === 'Running' && walkingAgain.playing === 'Walking'
  && sprinting.speed > walking.speed * 1.7 && Math.abs(walkingAgain.speed - walking.speed) < 1
  && walking.fovOver === 0 && sprinting.fovOver > 10 && walkingAgain.fovOver < 0.5,
  JSON.stringify({ walking, sprinting, walkingAgain }));

// aiming: the held gun gets an aiming place of its own, set with the same sliders
const aimTab = await page.evaluate(async () => {
  const ed = window.__tiny3.editor;
  const gun = ed.selectables.find((x) => x.object3D.name === 'blaster.glb');
  ed.select(gun);
  await new Promise((r) => setTimeout(r, 50));
  const normalRight = +document.querySelector('#vm-0').value;
  document.querySelector('[data-vm-pose="aim"]').click();
  await new Promise((r) => setTimeout(r, 50));
  const aimRight = +document.querySelector('#vm-0').value;
  const slider = document.querySelector('#vm-1'); // Up
  slider.value = '-0.05';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  const moved = { up: gun.viewModel.aim?.position[1], hipUp: gun.viewModel.position[1], preview: window.__engine.cameraRig.previewAim };
  return { normalRight, aimRight, moved };
});
await page.keyboard.press('Control+z');
const aimUndone = await page.evaluate(() => {
  const gun = window.__tiny3.editor.selectables.find((x) => x.object3D.name === 'blaster.glb');
  document.querySelector('[data-vm-pose="normal"]')?.click();
  return { up: gun.viewModel.aim?.position[1] ?? null };
});
await page.waitForTimeout(100);
const previewOff = await page.evaluate(() => window.__engine.cameraRig.previewAim);
check('held in view has an Aiming tab: its sliders move the aiming place (shown in the preview), not the usual one; undo puts it back',
  aimTab.aimRight < aimTab.normalRight && aimTab.moved.up === -0.05 && aimTab.moved.hipUp !== -0.05 && aimTab.moved.preview === true
  && aimUndone.up !== -0.05 && previewOff === false, JSON.stringify({ aimTab, aimUndone, previewOff }));

// nothing aims until a game adds an Aim control: here the right mouse button — with an instant-hit
// shot and recoil on F, and a pillar in front of the player that counts the hits it takes
await page.evaluate(async () => {
  const { RigidBody } = await import('/src/physics.js');
  const { gameplay, cameraRig } = window.__engine;
  const ed = window.__tiny3.editor;
  const robot = ed.selectables.find((x) => x.object3D.name === 'robot.glb');
  // an over-the-shoulder follow camera (earlier checks left it top-down)
  Object.assign(cameraRig, { followLockY: false, followOffset: 5, followHeight: 1.8, followLookUp: 1.4, followSide: 0,
    followAvoidWalls: false, followLerp: 12, rotateWithTarget: true, followMouse: false });
  document.querySelector('[data-add="box"]').click();
  const pillar = ed.selected;
  pillar.object3D.name = 'Pillar';
  const ry = robot.object3D.rotation.y;
  pillar.object3D.position.set(robot.object3D.position.x + Math.sin(ry) * 3, 1.5, robot.object3D.position.z + Math.cos(ry) * 3);
  pillar.object3D.scale.set(3, 3, 0.5);
  pillar.object3D.rotation.y = ry;
  pillar.rigidBody = new RigidBody({ type: 'static' }); // solid: the robot can't walk through it
  window.__engine.physics.register(pillar);
  gameplay.components.add(pillar, 'health', { max: 3, atZero: 'hide' }); // three hits and it's gone
  gameplay.rules.setFor(pillar, [{ when: { type: 'shot', who: 'player' }, if: [], do: [{ type: 'changeVariable', name: 'hits', by: 1 }] }]);
  ed._renderInspector();
  // its group, typed in the Inspector
  const groups = document.querySelector('#insp-groups');
  groups.value = 'Targets';
  groups.dispatchEvent(new Event('change', { bubbles: true }));
  gameplay.controls.load([...gameplay.controls.toJSON(),
    { inputs: [{ type: 'mouse', button: 'right' }], target: 'player', action: { type: 'aim', closer: 0.5, crosshair: 'hide' } },
    { inputs: [{ type: 'key', code: 'KeyF' }, { type: 'mouse', button: 'left' }], target: 'player', action: { type: 'hitscan', aim: 'camera', hits: 'group:Targets' } },
    { inputs: [{ type: 'key', code: 'KeyF' }, { type: 'mouse', button: 'left' }], target: 'player', action: { type: 'recoil', up: 3, recover: 0.6 } },
  ]);
});
const groupPick = await page.evaluate(() => {
  const pillar = window.__tiny3.editor.selectables.find((x) => x.object3D.name === 'Pillar');
  window.__tiny3.editor.onControlsChanged?.(); // the Controls panel draws its cards again
  const n = window.__engine.gameplay.controls.list.findIndex((c) => c.action.type === 'hitscan');
  const pick = document.querySelector(`#ctl-${n}-hits`);
  const saved = window.__tiny3.serializer.entityRecord(pillar);
  window.__tiny3.editor.select(null);
  return {
    groups: pillar.groups, saved: saved.groups,
    choice: pick ? pick.value : null, offered: pick ? [...pick.options].map((o) => o.textContent.trim()) : null,
  };
});
check('an object\'s Groups are set in the Inspector and saved; a shot\'s "Can hit" picks a group from a list',
  groupPick.groups?.join() === 'Targets' && groupPick.saved?.join() === 'Targets'
  && groupPick.choice === 'group:Targets' && groupPick.offered.includes('Targets') && groupPick.offered.includes('Anything'),
  JSON.stringify(groupPick));
const aimState = () => page.evaluate(() => {
  const eng = window.__engine;
  const rig = eng.cameraRig;
  const robot = window.__tiny3.editor.selectables.find((x) => x.object3D.name === 'robot.glb');
  const gun = window.__tiny3.editor.selectables.find((x) => x.object3D.name === 'blaster.glb');
  const dir = rig.camera.getWorldDirection(rig.camera.position.clone());
  return {
    mode: rig.mode, fov: +rig.camera.fov.toFixed(1), blend: +rig.aimBlend.toFixed(2), kick: +rig.gunKick.toFixed(3),
    dist: +rig.camera.position.distanceTo(robot.object3D.position).toFixed(2), lookY: +dir.y.toFixed(3),
    hits: eng.variables.get('hits', 0), shot: eng.gameplay.controls.lastShot?.hit ?? null, fired: !!eng.gameplay.controls.lastShot,
    crosshair: !!document.querySelector('.t3-crosshair svg'),
    gunClip: eng.mixers.find((m) => m.root === gun?.object3D)?.playing ?? null,
    robotY: +robot.object3D.position.y.toFixed(2),
    pillar: (() => {
      const p = window.__tiny3.editor.selectables.find((x) => x.object3D.name === 'Pillar');
      return p ? { shown: p.object3D.visible, solid: !!eng.physics.bodyFor(p) } : null;
    })(),
  };
});
await clickPlay();
await page.waitForTimeout(1200);
await page.mouse.move(700, 450);
const tpsIdle = await aimState();
await page.mouse.down({ button: 'right' });
await page.waitForTimeout(700);
const tpsAiming = await aimState();
await page.keyboard.press('f');
await page.waitForTimeout(50);
const tpsFired = await aimState();
await page.waitForTimeout(300);
for (let i = 0; i < 2; i++) { await page.keyboard.press('f'); await page.waitForTimeout(120); }
const tpsDown = await aimState();
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(700);
const tpsAfter = await aimState();
await clickPlay();
await page.waitForTimeout(1200);
check('third person: holding Aim zooms in and pulls the camera in over the shoulder; a shot while aiming hits the pillar in the middle of the view (its "I\'m shot" rule counts it), recoil kicks the view up; letting go puts it all back',
  tpsIdle.mode === 'follow' && tpsIdle.blend === 0 && tpsAiming.blend === 1 && tpsAiming.fov < tpsIdle.fov - 15
  && tpsAiming.dist < tpsIdle.dist * 0.8 && tpsFired.shot === 'Pillar' && tpsFired.hits === 1 && tpsFired.lookY > tpsAiming.lookY + 0.01
  && tpsAfter.blend === 0 && Math.abs(tpsAfter.fov - tpsIdle.fov) < 0.5 && Math.abs(tpsIdle.robotY) < 0.2,
  JSON.stringify({ tpsIdle, tpsAiming, tpsFired, tpsAfter }));
check('what a hit does: the pillar (Health 3, "When it runs out: hide") is gone after its third hit — out of sight and out of the way',
  tpsFired.pillar?.shown === true && tpsFired.pillar?.solid === true && tpsDown.hits === 3 && tpsDown.pillar?.shown === false && tpsDown.pillar?.solid === false,
  JSON.stringify({ fired: tpsFired.pillar, down: tpsDown }));

// first person, the gun held in view: aiming hides the crosshair (the sights take over), and a click still fires
await page.evaluate(() => { window.__engine.cameraRig.playMode = 'fps'; });
await clickPlay();
await page.waitForTimeout(1200);
const fpsIdle = await aimState();
await page.mouse.down({ button: 'right' });
await page.waitForTimeout(600);
const fpsAiming = await aimState();
await page.mouse.down();
await page.waitForTimeout(40);
await page.mouse.up();
await page.waitForTimeout(40);
const fpsFired = await aimState();
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(600);
const fpsAfter = await aimState();
await clickPlay();
await page.waitForTimeout(1200);
check('first person: aiming hides the crosshair and zooms; clicking while aiming fires — the shot, its clip and the gun\'s kick — and letting go brings the crosshair back',
  fpsIdle.mode === 'fps' && fpsIdle.crosshair && !fpsAiming.crosshair && fpsAiming.blend === 1 && fpsAiming.fov < fpsIdle.fov - 15
  && fpsFired.fired && fpsFired.gunClip === 'Shoot' && fpsFired.kick > 0 && fpsAfter.crosshair && fpsAfter.blend === 0,
  JSON.stringify({ fpsIdle, fpsAiming, fpsFired, fpsAfter }));

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
