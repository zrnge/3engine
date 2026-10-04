import * as THREE from 'three';
import { Entity } from './entity.js';

/**
 * Light probes — what a room looks like from inside it, for what is in it.
 *
 * Without one, everything takes its reflections and its soft light from the
 * sky: a room's walls, a kitchen's pans and the player who walks in all shine
 * blue-white with a sky they can't see. A probe is a box you place round a
 * room (its size is its scale). Captured from its middle — six views, the
 * lamps, the walls, the sky through the windows — the picture lights and is
 * reflected by everything inside the box instead. What moves (the player, a
 * thrown box) takes the probe of wherever it is.
 *
 * Captured when the level loads, when a probe is placed, moved or changed,
 * and when the sky changes; nothing is stored but the box and its strength.
 */

const MARKER = 'probeMarker';
const CUBE_SIZE = 128;
const EDGE = 0.5; // m round a probe's box still inside it

/** A probe: its box (scale) drawn as lines, a mirror ball at its middle — both only while editing. */
export function makeProbe({ name = 'Light probe', intensity = 1 } = {}) {
  const group = new THREE.Group();
  group.name = name;
  group.userData.kind = 'Probe';
  group.userData.probe = { intensity };
  group.scale.set(8, 4, 8);
  const box = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.7 }),
  );
  box.userData[MARKER] = true;
  box.raycast = () => {}; // clicked: the ball, not the whole room
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 24, 16),
    new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.05 }),
  );
  ball.userData[MARKER] = true;
  ball.userData.probeBall = true;
  // the ball stays the same size however big the box is
  ball.onBeforeRender = () => {
    const s = group.scale;
    ball.scale.set(0.45 / (s.x || 1), 0.45 / (s.y || 1), 0.45 / (s.z || 1));
    ball.updateMatrixWorld();
  };
  ball.castShadow = false;
  group.add(box, ball);
  return new Entity(group);
}

export const isProbe = (o) => !!o?.userData?.probe;

const _inv = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _box = new THREE.Box3();

export class Probes {
  constructor(engine) {
    this.engine = engine;
    this.dirty = true;
    this._pmrem = null;
    this._captures = new Map();   // probe object → { target (PMREM), texture }
    this._given = new Map();      // material → what it had before a probe was given to it
    this._moving = 0;             // seconds to the next look at what moves
  }

  /** Capture again before the next frame (a probe moved, the sky changed, a level loaded). */
  invalidate({ soon = false } = {}) {
    if (soon) this._settle = Math.max(this._settle ?? 0, 0.3); // still changing (a slider dragged): once it stops
    else this.dirty = true;
  }

  get list() {
    return (this.engine.entities || []).filter((e) => isProbe(e.object3D) && e.object3D.parent);
  }

  /** Once a frame, before drawing: captures when needed; what moves keeps the probe of where it is. */
  update(dt = 0) {
    const probes = this.list;
    const playing = !!this.engine.playing;
    // the box and the ball are the editor's: not in the game
    for (const p of probes) for (const c of p.object3D.children) if (c.userData[MARKER]) c.visible = !playing;
    if (!playing) {
      // a probe placed, moved, sized or made stronger: captured again once it has stopped moving
      const sig = probes.map((p) => {
        const o = p.object3D;
        return `${o.matrixWorld.elements.map((v) => v.toFixed(3)).join(',')}|${o.userData.probe.intensity}`;
      }).join(';');
      if (sig !== this._sig) {
        this._sig = sig;
        this._settle = 0.3;
      }
    }
    // a lamp switched on or off, dimmed, recoloured (the lights die in a horror game): what the probes saw changed
    if (probes.length) {
      let lights = '';
      for (const e of this.engine.entities || []) {
        const l = e.object3D;
        if (l?.isLight && !l.isAmbientLight) lights += `${l.visible && !!l.parent ? 1 : 0}${l.intensity.toFixed(2)}${l.color.getHexString()};`;
      }
      if (this._lights !== undefined && lights !== this._lights) this._settle = Math.max(this._settle ?? 0, 0.1);
      this._lights = lights;
    }
    if (this._settle > 0) {
      this._settle -= dt;
      if (this._settle <= 0) this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.capture(probes);
      this.assign(probes);
      return;
    }
    if (!probes.length || !this.engine.playing) return;
    this._moving -= dt;
    if (this._moving > 0) return;
    this._moving = 0.25;
    for (const e of this.engine.entities || []) {
      const body = e.rigidBody;
      const moves = e === this.engine.playerEntity || body?.type === 'dynamic' || body?.type === 'kinematic';
      if (moves) this._give(e.object3D, probes);
    }
  }

  /** The six views from each probe's middle, as an environment picture. */
  capture(probes = this.list) {
    const { renderer, scene } = this.engine;
    for (const [o, c] of this._captures) {
      if (!probes.some((p) => p.object3D === o)) { c.target.dispose(); this._captures.delete(o); }
    }
    if (!probes.length || !renderer?.getContext) return;
    this._pmrem ??= new THREE.PMREMGenerator(renderer);
    const cube = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, { type: THREE.HalfFloatType });
    const camera = new THREE.CubeCamera(0.05, 1000, cube);
    // what it must not see: the probes' own boxes and balls, held guns, the editor's helpers
    const hidden = [];
    scene.traverse((n) => {
      if (n.visible && (n.userData[MARKER] || n.userData.isHelper || n.isTransformControls || n.type === 'GridHelper')) {
        hidden.push(n);
        n.visible = false;
      }
    });
    // what it sees is lit without anything a probe gave: as the scene is lit by itself
    const given = this._undoGiven();
    for (const p of probes) {
      const o = p.object3D;
      o.updateMatrixWorld(true);
      o.getWorldPosition(camera.position);
      camera.update(renderer, scene);
      const target = this._pmrem.fromCubemap(cube.texture);
      this._captures.get(o)?.target.dispose();
      this._captures.set(o, { target, texture: target.texture });
    }
    given(); // (assign gives them again, from the new pictures)
    for (const n of hidden) n.visible = true;
    cube.dispose();
    // each probe's ball shows what it caught
    for (const p of probes) {
      const ball = p.object3D.children.find((c) => c.userData.probeBall);
      const tex = this._captures.get(p.object3D)?.texture;
      if (ball && tex && ball.material.envMap !== tex) { ball.material.envMap = tex; ball.material.needsUpdate = true; }
    }
  }

  /** Every mesh inside a probe's box takes that probe's picture (the smallest box, where they overlap). */
  assign(probes = this.list) {
    this._undoGiven()();
    this._given.clear();
    if (!probes.length) return;
    for (const e of this.engine.entities || []) {
      if (isProbe(e.object3D)) continue;
      this._give(e.object3D, probes);
    }
  }

  /** The probe whose box `point` is in — the smallest — or null. */
  probeAt(point, probes = this.list) {
    let best = null;
    let bestSize = Infinity;
    for (const p of probes) {
      const o = p.object3D;
      _p.copy(point).applyMatrix4(_inv.copy(o.matrixWorld).invert());
      // half a metre's grace: a box drawn to a room's size takes its walls, whose middles are on its edge
      const s = o.scale;
      if (Math.abs(_p.x) > 0.5 + EDGE / Math.abs(s.x || 1) || Math.abs(_p.y) > 0.5 + EDGE / Math.abs(s.y || 1)
        || Math.abs(_p.z) > 0.5 + EDGE / Math.abs(s.z || 1)) continue;
      const size = Math.abs(o.scale.x * o.scale.y * o.scale.z);
      if (size < bestSize) { best = p; bestSize = size; }
    }
    return best;
  }

  /** An object's meshes take the probe of where each is (or the sky again, outside every probe). */
  _give(root, probes) {
    root.traverse((n) => {
      if (!n.isMesh || n.userData[MARKER]) return;
      _box.setFromObject(n);
      if (_box.isEmpty()) return;
      const probe = this.probeAt(_box.getCenter(_p), probes);
      const capture = probe ? this._captures.get(probe.object3D) : null;
      const intensity = probe?.object3D.userData.probe.intensity ?? 1;
      for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
        if (!m || !('envMap' in m)) continue;
        if (!this._given.has(m)) {
          if (!capture) continue; // outside every probe: as it was
          this._given.set(m, { envMap: m.envMap, envMapIntensity: m.envMapIntensity });
        }
        const before = this._given.get(m);
        const map = capture ? capture.texture : before.envMap;
        const strength = capture ? intensity : before.envMapIntensity;
        if (m.envMap !== map) { m.envMap = map; m.needsUpdate = true; }
        m.envMapIntensity = strength;
      }
    });
  }

  /** Take back what probes gave; returns what gives it again. */
  _undoGiven() {
    const now = [...this._given].map(([m]) => [m, m.envMap, m.envMapIntensity]);
    for (const [m, before] of this._given) {
      if (m.envMap !== before.envMap) { m.envMap = before.envMap; m.needsUpdate = true; }
      m.envMapIntensity = before.envMapIntensity;
    }
    return () => {
      for (const [m, map, strength] of now) {
        if (m.envMap !== map) { m.envMap = map; m.needsUpdate = true; }
        m.envMapIntensity = strength;
      }
    };
  }

  dispose() {
    this._undoGiven();
    this._given.clear();
    for (const c of this._captures.values()) c.target.dispose();
    this._captures.clear();
    this._pmrem?.dispose();
    this._pmrem = null;
  }
}
