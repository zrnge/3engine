import * as THREE from 'three';
import { escapeHtml } from '../ui.js';
import { generatorOf, regenerate } from '../generators/generated.js';
import { PAINTS, baseHeightAt, sculptGrid, paintGrid, normalizeTerrain } from '../generators/terrain.js';
import { encodeBytes, encodeInt16, sampleGrid } from '../grid-codec.js';

/**
 * Sculpt & paint — brushes for a selected terrain, in the Inspector:
 *
 *   Raise · Lower     the ground up or down under the brush
 *   Smooth            bumps and ridges evened out
 *   Flatten           to the height where the stroke began (a building plot, a road)
 *   Paint             grass, dark grass, dirt, a path, mud, flowers, rock, sand or snow — or Erase
 *
 * Drag on the terrain with the left button (the right still pans, the wheel
 * zooms). A ring shows the brush. Each stroke is one undo step, saved with the
 * terrain as two small grids (generators/terrain.js: sculpt, paint) — the land
 * itself is still made from its few settings.
 */

export const BRUSH_TOOLS = ['off', 'raise', 'lower', 'smooth', 'flatten', 'paint'];
const TOOL_LABELS = { off: 'Off', raise: '⬆ Raise', lower: '⬇ Lower', smooth: '≈ Smooth', flatten: '▭ Flatten', paint: '🖌 Paint' };

/** The brush's settings, kept between selections. */
export function brushState(editor) {
  editor.terrainBrush ??= { tool: 'off', paint: 'dirt', size: 6, strength: 0.5 };
  return editor.terrainBrush;
}

/** Its block in the terrain's Inspector section. */
export function brushPanelHtml(editor) {
  const b = brushState(editor);
  return `<div class="brush-panel">
    <div class="gen-group">Sculpt &amp; paint</div>
    <div class="brush-tools">${BRUSH_TOOLS.map((t) => `<button class="tbtn${b.tool === t ? ' active' : ''}" data-brush-tool="${t}">${TOOL_LABELS[t]}</button>`).join('')}</div>
    ${b.tool === 'paint' ? `<div class="prop-row"><label>Paint</label><select data-brush="paint">${[...PAINTS, 'erase'].map((p) =>
      `<option value="${p}" ${p === b.paint ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}</select></div>` : ''}
    <div class="prop-row"><label title="The brush's radius, in metres">Size (m)</label>
      <input type="range" data-brush="size" min="0.5" max="60" step="0.5" value="${b.size}" /><span class="val">${b.size}</span></div>
    <div class="prop-row"><label title="How much each moment of the stroke does">Strength</label>
      <input type="range" data-brush="strength" min="0.05" max="1" step="0.05" value="${b.strength}" /><span class="val">${b.strength}</span></div>
    ${b.tool !== 'off' ? '<div class="gp-hint">Drag on the terrain. Right-drag pans, the wheel zooms; Off to select and move again.</div>' : ''}
  </div>`;
}

export function wireBrushPanel(editor, root) {
  const b = brushState(editor);
  for (const el of root?.querySelectorAll('[data-brush-tool]') || []) {
    el.addEventListener('click', () => { b.tool = el.dataset.brushTool; editor._renderInspector(); });
  }
  for (const el of root?.querySelectorAll('[data-brush]') || []) {
    const key = el.dataset.brush;
    el.addEventListener('input', () => {
      b[key] = el.type === 'range' ? Number(el.value) : el.value;
      const val = el.parentElement.querySelector('.val');
      if (val) val.textContent = String(b[key]);
    });
  }
}

// ---------------------------------------------------------------- in the view

const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();
const _inv = new THREE.Matrix4();
const _local = new THREE.Vector3();

/** The terrain the brush works on: the one selected, if the brush is on. */
function target(editor) {
  const b = brushState(editor);
  const e = editor.selected;
  if (b.tool === 'off' || !e || editor.engine.playing) return null;
  return generatorOf(e.object3D)?.type === 'terrain' ? e : null;
}

/** Brushes in the view: the ring that follows the mouse, strokes on the selected terrain. */
export function installTerrainBrush(editor) {
  const engine = editor.engine;
  const canvas = engine.renderer.domElement;
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos(i / 64 * Math.PI * 2), 0, Math.sin(i / 64 * Math.PI * 2)))),
    new THREE.LineBasicMaterial({ color: 0xffd040, depthTest: false, transparent: true }),
  );
  ring.renderOrder = 1001;
  ring.visible = false;
  ring.userData.editorOnly = true;
  engine.scene.add(ring);

  let stroke = null;
  let lastEvent = null;

  /** Where the mouse meets the selected terrain's ground: its world point and its terrain-local point. */
  const hitAt = (e, entity) => {
    const r = canvas.getBoundingClientRect();
    _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, engine.camera);
    const grounds = entity.object3D.children.filter((c) => c.name === 'Ground');
    const hit = _ray.intersectObjects(grounds, false)[0];
    if (!hit) return null;
    _inv.copy(entity.object3D.matrixWorld).invert();
    _local.copy(hit.point).applyMatrix4(_inv);
    return { point: hit.point.clone(), x: _local.x, z: _local.z };
  };

  const showRing = (hit, entity) => {
    if (!hit) { ring.visible = false; return; }
    const s = entity.object3D.getWorldScale(new THREE.Vector3());
    const r = brushState(editor).size;
    ring.visible = true;
    ring.position.copy(hit.point).add(new THREE.Vector3(0, 0.15, 0));
    ring.scale.set(r * s.x, 1, r * s.z);
    ring.updateMatrixWorld();
  };

  const onMove = (e) => {
    lastEvent = e;
    const entity = stroke?.entity ?? target(editor);
    if (!entity) { ring.visible = false; return; }
    showRing(hitAt(e, entity), entity);
  };

  const onDown = (e) => {
    if (e.button !== 0 || e.target !== canvas) return;
    const entity = target(editor);
    if (!entity) return;
    const hit = hitAt(e, entity);
    if (!hit) return;
    // the brush takes this press: not a selection, nor the gizmo, nor an orbit
    e.preventDefault();
    e.stopImmediatePropagation();
    stroke = beginStroke(entity, hit);
    lastEvent = e;
    let last = performance.now();
    const tick = () => {
      if (!stroke) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const h = lastEvent ? hitAt(lastEvent, entity) : null;
      if (h) {
        applyBrush(stroke, brushState(editor), h.x, h.z, dt);
        regenerate(entity.object3D, generatorOf(entity.object3D).params);
        showRing(h, entity);
      }
      stroke.frame = requestAnimationFrame(tick);
    };
    tick();
  };

  const onUp = () => {
    if (!stroke) return;
    cancelAnimationFrame(stroke.frame);
    const done = stroke;
    stroke = null;
    endStroke(editor, done);
  };

  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  return { ring };
}

// ---------------------------------------------------------------- strokes

/** The terrain's sculpting and painting as grids to work on, at its detail (what was saved, resampled). */
function beginStroke(entity, hit) {
  const o = entity.object3D;
  const p = normalizeTerrain(generatorOf(o).params);
  const n = p.detail + 1;
  const sculpt = new Int16Array(n * n);
  const saved = sculptGrid(p);
  const layer = new Uint8Array(n * n);
  const weight = new Uint8Array(n * n);
  const painted = paintGrid(p);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (saved) sculpt[k] = saved.n === n ? saved.values[k] : Math.round(sampleGrid(saved.values, saved.n, i / (n - 1), j / (n - 1)));
      if (painted) {
        const g = Math.round((j / (n - 1)) * (painted.n - 1)) * painted.n + Math.round((i / (n - 1)) * (painted.n - 1));
        layer[k] = painted.layer[g];
        weight[k] = painted.weight[g];
      }
    }
  }
  const half = p.size / 2;
  const cell = p.size / (n - 1);
  // the land's own height at each point: what smoothing and flattening work against
  const base = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) base[j * n + i] = baseHeightAt(p, -half + i * cell, -half + j * cell);
  const flatAt = Math.round((hit.z + half) / cell) * n + Math.round((hit.x + half) / cell);
  const live = { sculpt: { n, values: sculpt }, paint: { n, layer, weight } };
  o.userData.liveGrids = live;
  return {
    entity, p, n, half, cell, base, live,
    before: { ...generatorOf(o).params },
    level: base[flatAt] + sculpt[flatAt] / 100, // flatten: to where the stroke began
  };
}

/** One moment of a stroke at (x, z), terrain-local metres. */
export function applyBrush(stroke, brush, x, z, dt) {
  const { n, half, cell, base, live } = stroke;
  const s = live.sculpt.values;
  const r = Math.max(0.25, brush.size);
  const i0 = Math.max(0, Math.floor((x - r + half) / cell));
  const i1 = Math.min(n - 1, Math.ceil((x + r + half) / cell));
  const j0 = Math.max(0, Math.floor((z - r + half) / cell));
  const j1 = Math.min(n - 1, Math.ceil((z + r + half) / cell));
  const k = brush.strength * dt;
  const total = (q) => base[q] + s[q] / 100;
  const paintIndex = PAINTS.indexOf(brush.paint) + 1; // 0: erase
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(-half + i * cell - x, -half + j * cell - z);
      if (d > r) continue;
      const f = (1 - (d / r) ** 2) ** 2; // soft edge
      const q = j * n + i;
      if (brush.tool === 'raise' || brush.tool === 'lower') {
        const metres = (brush.tool === 'raise' ? 1 : -1) * k * f * Math.max(1, r * 0.6);
        s[q] = clamp16(s[q] + metres * 100);
      } else if (brush.tool === 'smooth') {
        let sum = 0;
        let count = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const a = i + di;
            const b = j + dj;
            if (a < 0 || b < 0 || a >= n || b >= n) continue;
            sum += total(b * n + a);
            count++;
          }
        }
        const want = sum / count - base[q];
        s[q] = clamp16(s[q] + (want * 100 - s[q]) * Math.min(1, k * f * 8));
      } else if (brush.tool === 'flatten') {
        const want = stroke.level - base[q];
        s[q] = clamp16(s[q] + (want * 100 - s[q]) * Math.min(1, k * f * 6));
      } else if (brush.tool === 'paint') {
        const { layer, weight } = live.paint;
        const amount = Math.round(k * f * 4 * 255);
        if (!amount) continue;
        if (!paintIndex || layer[q] !== paintIndex) {
          // another paint (or erasing): fades out first, then the new one fades in
          const left = weight[q] - amount;
          if (left > 0) weight[q] = left;
          else { layer[q] = paintIndex; weight[q] = paintIndex ? Math.min(255, -left) : 0; }
        } else {
          weight[q] = Math.min(255, weight[q] + amount);
        }
      }
    }
  }
}

const clamp16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));

/** The stroke into the terrain's settings (encoded), its collider measured again, one undo step. */
function endStroke(editor, stroke) {
  const { entity, live, n, before } = stroke;
  const o = entity.object3D;
  delete o.userData.liveGrids;
  const anySculpt = live.sculpt.values.some((v) => v !== 0);
  const anyPaint = live.paint.weight.some((v) => v !== 0);
  const after = {
    ...generatorOf(o).params,
    sculpt: anySculpt ? { n, data: encodeInt16(live.sculpt.values) } : null,
    paint: anyPaint ? { n, layer: encodeBytes(live.paint.layer), weight: encodeBytes(live.paint.weight) } : null,
  };
  const apply = (v) => {
    regenerate(o, v);
    if (entity.rigidBody) {
      editor.engine.physics.unregister(entity);
      editor.engine.physics.register(entity);
    }
  };
  apply(after);
  editor._recordValue(entity, 'generator', before, { ...generatorOf(o).params }, apply, `terrain: ${brushState(editor).tool}`);
}
