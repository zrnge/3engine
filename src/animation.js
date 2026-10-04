import * as THREE from 'three';
import { restoreRig, applyRig } from './ik.js';

/**
 * Animation — one player per model for all of its clips.
 *
 * A model's clips are whatever its file brought (see loader.js); nothing here
 * expects any particular clip or name. Everything that animates a model goes
 * through its one player, so they take turns instead of fighting:
 *
 *   - movement (the Animator component) sets the BASE clip: whichever clips the
 *     game maker picked for standing, walking, running and jumping;
 *   - an ACTION clip ("Play animation" from a control or a rule — whatever
 *     key, button or event the game maker bound it to) plays over the base,
 *     once, looped, or while an input is held, and then hands back to movement;
 *   - the Inspector's preview plays any clip on its own.
 *
 * The engine advances every player each frame (engine.mixers).
 */

/**
 * A clip by name: exact first (ignoring case), then the first whose name
 * starts with it, then the first that contains it. -1 if none.
 */
export function clipIndex(clips, name) {
  if (typeof name === 'number') return name >= 0 && name < (clips?.length ?? 0) ? name : -1;
  const n = String(name ?? '').trim().toLowerCase();
  if (!n || !clips?.length) return -1;
  const names = clips.map((c) => (c.name || '').toLowerCase());
  let i = names.indexOf(n);
  if (i === -1) i = names.findIndex((x) => x.startsWith(n));
  if (i === -1) i = names.findIndex((x) => x.includes(n));
  return i;
}

/** The names of an object's clips, in the order its file listed them. */
export function clipNames(object3D) {
  return (object3D?.userData?.animations || []).map((c, i) => c.name || `clip ${i + 1}`);
}

// ---------------------------------------------------------------- more clips for a model
// A model's file may hold one animation, or none: Mixamo and many stores ship
// one animation per file, and many exporters put every move into one long
// "Take 001". So a model's clips can also come from other files, and a long
// clip can be cut into named parts. Both are saved on the model as data
// (`animationFiles`, `clipCuts`) and rebuilt on load — see
// AssetLoader.applyAnimationExtras.

/** `base`, or "base 2", "base 3"… — whichever is not taken yet. */
export function uniqueClipName(taken, base) {
  const name = String(base || 'clip').trim() || 'clip';
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`)) n++;
  return `${name} ${n}`;
}

/**
 * A clip from another file, for this model: the tracks that move parts this
 * model has — matched by name, as files exported from the same rig (every
 * Mixamo file, say) share bone names. Null unless most of what it moves
 * (`minShare`) is here: two different rigs can share a name or two ("Body"),
 * and a clip that moves only those would be nonsense on this model.
 */
export function retargetClip(clip, root, name = clip.name, { minShare = 0.5 } = {}) {
  const parts = new Map(); // node name -> found in this model?
  const tracks = clip.tracks.filter((track) => {
    let nodeName;
    try { ({ nodeName } = THREE.PropertyBinding.parseTrackName(track.name)); } catch { return false; }
    if (!parts.has(nodeName)) parts.set(nodeName, !!THREE.PropertyBinding.findNode(root, nodeName));
    return parts.get(nodeName);
  }).map((t) => t.clone());
  const found = [...parts.values()].filter(Boolean).length;
  if (!tracks.length || found < parts.size * minShare) return null;
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

/**
 * Part of a clip, from `start` to `end` seconds, starting at 0. Its first and
 * last poses are sampled exactly at the cut, so it begins and ends where asked
 * even between keyframes. Null for an empty range.
 */
export function cutClip(clip, name, start, end) {
  const s = Math.max(0, Math.min(Number(start), Number(end)));
  const e = Math.min(clip.duration, Math.max(Number(start), Number(end)));
  if (!(e - s > 1e-3)) return null;
  const tracks = clip.tracks.map((track) => {
    const size = track.getValueSize();
    const sample = track.createInterpolant();
    const times = [0];
    const values = [...sample.evaluate(s)];
    for (let i = 0; i < track.times.length; i++) {
      const t = track.times[i];
      if (t > s + 1e-6 && t < e - 1e-6) {
        times.push(t - s);
        for (let k = 0; k < size; k++) values.push(track.values[i * size + k]);
      }
    }
    times.push(e - s);
    values.push(...sample.evaluate(e));
    return new track.constructor(track.name, times, values, track.getInterpolation());
  });
  return new THREE.AnimationClip(name, e - s, tracks);
}

/**
 * A model's whole clip list: its own file's, then those from other files, then
 * the parts cut from any of them. Each carries where it came from (`tiny3`),
 * so the Inspector can offer to remove the ones that were added.
 */
export function composeClips(own, added = [], cuts = [], taken = new Set([...own, ...added].map((c) => c.name))) {
  const out = [...own, ...added];
  cuts.forEach((cut, index) => {
    const from = out.find((c) => c.name === cut.from);
    const part = from && cutClip(from, uniqueClipName(taken, cut.name), cut.start, cut.end);
    if (!part) return;
    taken.add(part.name);
    part.tiny3 = { kind: 'cut', index };
    out.push(part);
  });
  return out;
}

export class AnimationPlayer {
  /** The player for a model, made on first use and registered with the engine. */
  static for(engine, object3D) {
    const list = engine.mixers || (engine.mixers = []);
    let rec = list.find((m) => m.root === object3D);
    if (!(rec instanceof AnimationPlayer)) {
      if (rec) { // an old-style record for this model (from before players): replace it
        rec.mixer?.stopAllAction();
        list.splice(list.indexOf(rec), 1);
      }
      rec = new AnimationPlayer(object3D);
      list.push(rec);
    }
    return rec;
  }

  constructor(root) {
    this.root = root;
    this.mixer = new THREE.AnimationMixer(root);
    this.speed = 1;          // the engine multiplies its dt by this
    this.actions = {};       // clip index -> AnimationAction
    this.base = -1;          // movement clip
    this.action = null;      // { index, mode, done } — an action clip over the base
    this.layer = null;       // { index, action } — a one-off clip added on top of a held one
    this.current = null;     // what is showing (the engine's editor autoplay reads this)
    this._onFinished = (e) => this._finished(e);
    this.mixer.addEventListener('finished', this._onFinished);
  }

  get clips() { return this.root.userData.animations || []; }

  /** Before its clips pose it this frame: what its rig moved last frame, put back (ik.js). */
  beforeUpdate() { restoreRig(this); }

  /** After: feet on the ground, a head that turns, a clip that moves it — as its Animator asked (this.rig). */
  afterUpdate(dt) { applyRig(this, dt); }

  /** The name of what is showing now, or '' — for tests and the Inspector. */
  get playing() {
    const i = this.action ? this.action.index : this.blend ? (this._blendTop ?? -1) : this.base;
    return i >= 0 ? (this.clips[i]?.name || '') : '';
  }

  _get(i) {
    return this.actions[i] || (this.actions[i] = this.mixer.clipAction(this.clips[i]));
  }

  /**
   * Hold a clip still at a moment, for finding where a move starts or ends
   * (the Inspector's cut form). Anything else playing stops.
   */
  pose(name, time) {
    const i = clipIndex(this.clips, name);
    if (i < 0) return false;
    this._stopPreview();
    for (const [k, a] of Object.entries(this.actions)) if (Number(k) !== i) a.stop();
    const a = this._get(i);
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.play();
    a.paused = true;
    a.time = Math.min(Math.max(0, Number(time) || 0), this.clips[i].duration);
    this.mixer.update(0);
    this.action = { index: i, mode: 'pose' };
    this.current = i;
    return true;
  }

  /** Loop part of a clip, to check a cut before making it. */
  previewPart(name, start, end) {
    const i = clipIndex(this.clips, name);
    const part = i >= 0 ? cutClip(this.clips[i], '(preview)', start, end) : null;
    if (!part) return false;
    this.mixer.stopAllAction();
    this._stopPreview();
    this._preview = this.mixer.clipAction(part);
    this._preview.setLoop(THREE.LoopRepeat, Infinity).play();
    this.action = { index: -1, mode: 'preview' };
    this.current = null;
    return true;
  }

  _stopPreview() {
    if (!this._preview) return;
    this._preview.stop();
    this.mixer.uncacheClip(this._preview.getClip());
    this._preview = null;
  }

  _show(i, { loop, fade, speed = 1 }) {
    this._stopPreview();
    const next = this._get(i);
    const prev = this.current !== null && this.current !== i ? this.actions[this.current] : null;
    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(speed);
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !loop;
    if (this.blend) {
      // movement is a mix (setMoveBlend): it fades itself down while this plays; this fades in over it
      next.play();
      if (fade > 0) next.fadeIn(fade);
      this.current = i;
      return;
    }
    if (prev && fade > 0) next.crossFadeFrom(prev, fade, false).play();
    else {
      prev?.stop();
      next.play();
    }
    this.current = i;
  }

  /**
   * The movement clip (looped). If an action clip is playing, it takes over
   * once that one ends.
   */
  setBase(name, { fade = 0.2 } = {}) {
    if (this.blend) this._endBlend(fade); // was a mix of clips: one clip again
    const i = clipIndex(this.clips, name);
    if (i === this.base) return;
    this.base = i;
    if (this.action) return; // an action clip is showing: it hands over when done
    if (i >= 0) this._show(i, { loop: true, fade });
    else this._toBase(fade); // no movement clip any more: let the old one fade
  }

  /**
   * Play an action clip over movement.
   *   mode 'once' — plays through, then back to movement
   *   mode 'loop' — keeps looping until stop()
   *   mode 'hold' — loops while an input is held (the control calls release());
   *                 with `loop: false` it plays through and stays on its last
   *                 frame instead (raising a gun to aim), and `atEnd` starts it
   *                 there (still held after a shot took over for a moment)
   * A different action already playing is let finish unless `interrupt` is set;
   * the same one restarts (firing again). A one-off clip while another is held
   * (a shot while aiming) plays on top of it — its movement added to the held
   * pose — so the gun stays up; "Cut off others" swaps them instead.
   * @returns {boolean} whether it started
   */
  play(name, { mode = 'once', speed = 1, fade = 0.1, interrupt = false, loop = true, atEnd = false } = {}) {
    const i = clipIndex(this.clips, name);
    if (i < 0) return false;
    if (this.action && this.action.index !== i && !interrupt && this.action.mode === 'once') return false;
    if (mode === 'once' && !interrupt && this.action?.mode === 'hold' && this.action.index !== i) {
      return this._layer(i, Number(speed) || 1);
    }
    if (this.actions[i]?.paused) this.actions[i].paused = false; // held still by pose()
    if (mode === 'hold' && this.action?.index === i && this.action.mode === 'hold') return true; // still held
    this.action = { index: i, mode };
    const loops = mode === 'loop' || (mode === 'hold' && loop);
    this._show(i, { loop: loops, fade, speed: Number(speed) || 1 });
    if (mode === 'hold' && !loop && atEnd) this.actions[i].time = this.clips[i].duration;
    return true;
  }

  /**
   * Play a clip once over whatever is showing, as a change from its own first
   * frame: a hip-fire clip's kick, added to the aiming pose.
   */
  _layer(i, speed) {
    const clip = this.clips[i];
    const cache = this._additive ?? (this._additive = new Map());
    let add = cache.get(clip);
    if (!add) {
      add = THREE.AnimationUtils.makeClipAdditive(clip.clone());
      add.name = clip.name;
      cache.set(clip, add);
    }
    const a = this.mixer.clipAction(add, undefined, THREE.AdditiveAnimationBlendMode);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = false;
    a.setEffectiveTimeScale(speed);
    a.setEffectiveWeight(1);
    a.play();
    this.layer = { index: i, action: a };
    return true;
  }

  /** The name of a clip playing on top of a held one (a shot while aiming), or ''. */
  get layered() {
    return this.layer ? (this.clips[this.layer.index]?.name || '') : '';
  }

  /** Let go of a held clip: back to movement. */
  release(name) {
    const i = clipIndex(this.clips, name);
    if (this.action && this.action.index === i && this.action.mode === 'hold') this._toBase();
  }

  /** Stop an action clip (or whatever action is playing): back to movement. */
  stop(name = null) {
    const any = name === null || name === '';
    if (this.layer && (any || clipIndex(this.clips, name) === this.layer.index)) {
      this.layer.action.stop();
      this.layer = null;
    }
    if (!this.action) return;
    if (name !== null && name !== '' && clipIndex(this.clips, name) !== this.action.index) return;
    this._toBase();
  }

  /**
   * Movement as a mix of clips, by how fast it goes — a 1D blend: standing,
   * walking, running, each with a weight, eased as speed changes. Walking and
   * running are kept in step (the same moment of their stride) and, with
   * `match`, played as fast as it really moves, so feet don't slide:
   * `walkSpeed` is the speed the walking clip was made for, and `runSpeed`
   * where running starts (blended across a band round it: 0.8× to 1.1×), the
   * running clip played at its own pace from there. `air`
   * (in the air, with an air clip) plays that alone. An action clip over it
   * fades the mix down, and it comes back when the action ends.
   * Call every frame with the frame's `dt`.
   */
  setMoveBlend({ idle = '', walk = '', run = '', air = '', speed = 0, walkSpeed = 2, runSpeed = 6, match = true, fade = 0.2, inAir = false } = {}, dt = 0) {
    if (!this.blend) {
      // a single clip was showing: it fades out as the mix comes in
      if (this.current !== null && !this.action) this.actions[this.current]?.fadeOut(fade);
      this.blend = { weights: new Map(), master: this.action ? 0 : 1 };
      this.base = -2;
    }
    const b = this.blend;
    const ids = { idle: clipIndex(this.clips, idle), walk: clipIndex(this.clips, walk), run: clipIndex(this.clips, run), air: clipIndex(this.clips, air) };
    const want = new Map();
    const add = (i, w) => { if (i >= 0 && w > 1e-4) want.set(i, (want.get(i) || 0) + w); };
    const s = Math.max(0, Number(speed) || 0);
    const ws = Math.max(0.1, Number(walkSpeed) || 2);
    const rs = Math.max(ws + 0.1, Number(runSpeed) || 6);
    if (inAir && ids.air >= 0) add(ids.air, 1);
    else {
      const still = 1 - Math.min(1, s / Math.max(0.05, ws * 0.35)); // out of standing quickly
      let u = Math.min(1, Math.max(0, (s - rs * 0.8) / (rs * 0.3))); // walking → running, round "run from"
      if (ids.walk < 0) u = ids.run >= 0 ? 1 : 0;
      if (ids.run < 0) u = 0;
      const moving = ids.walk >= 0 || ids.run >= 0;
      add(ids.idle >= 0 || !moving ? ids.idle : ids.walk >= 0 ? ids.walk : ids.run, moving ? still : 1);
      if (moving) {
        add(ids.walk, (1 - still) * (1 - u));
        add(ids.run, (1 - still) * u);
      }
    }
    // eased: each weight moves toward what this speed wants, all the way within `fade` seconds
    const step = fade > 0 && dt > 0 ? dt / fade : 1;
    const toward = (from, to) => (Math.abs(to - from) <= step ? to : from + Math.sign(to - from) * step);
    b.master = toward(b.master, this.action ? 0 : 1);
    for (const i of new Set([...b.weights.keys(), ...want.keys()])) {
      const w = toward(b.weights.get(i) ?? 0, want.get(i) ?? 0);
      const a = this._get(i);
      if (w < 1e-3 && !want.has(i)) {
        b.weights.delete(i);
        if (!(this.action && this.action.index === i)) a.stop();
        continue;
      }
      b.weights.set(i, w);
      if (!a.isRunning() && !(this.action && this.action.index === i)) {
        a.reset();
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.play();
      }
      if (!(this.action && this.action.index === i)) a.setEffectiveWeight(w * b.master);
    }
    // how fast each plays: as fast as it moves (within reason), walking and running in step
    const scaleW = match && s > 0.05 ? Math.min(2.5, Math.max(0.4, s / ws)) : 1;
    const scaleR = match && s > 0.05 ? Math.min(2.5, Math.max(0.4, s / rs)) : 1;
    const wi = ids.walk;
    const ri = ids.run;
    const ww = b.weights.get(wi) ?? 0;
    const rw = b.weights.get(ri) ?? 0;
    if (wi >= 0 && ri >= 0 && ww > 0 && rw > 0 && wi !== ri) {
      const dW = this.clips[wi].duration || 1;
      const dR = this.clips[ri].duration || 1;
      const t = rw / (ww + rw);
      const rate = (scaleW / dW) * (1 - t) + (scaleR / dR) * t; // strides a second, between the two
      const aw = this._get(wi);
      const ar = this._get(ri);
      aw.setEffectiveTimeScale(rate * dW);
      ar.setEffectiveTimeScale(rate * dR);
      // the one less shown follows the other's stride
      if (t < 0.5) ar.time = ((aw.time % dW) / dW) * dR;
      else aw.time = ((ar.time % dR) / dR) * dW;
    } else {
      if (wi >= 0 && ww > 0) this._get(wi).setEffectiveTimeScale(scaleW);
      if (ri >= 0 && rw > 0) this._get(ri).setEffectiveTimeScale(scaleR);
    }
    // what it is mostly showing — or, while easing there, what it is going to (the Inspector, tests)
    let top = null;
    let best = 0;
    for (const [i, w] of want) if (w > best) { best = w; top = i; }
    if (!this.action) this.current = top;
    this._blendTop = top;
  }

  /** The mix's weights now, by clip name (tests, the Inspector). */
  get blendWeights() {
    const out = {};
    for (const [i, w] of this.blend?.weights || []) out[this.clips[i]?.name ?? i] = +(w * this.blend.master).toFixed(3);
    return out;
  }

  _endBlend(fade = 0.2) {
    for (const i of this.blend.weights.keys()) {
      const a = this.actions[i];
      if (a && !(this.action && this.action.index === i)) a.fadeOut(fade);
    }
    this.blend = null;
    this.base = -1;
    this.current = null;
  }

  _finished(e) {
    if (this.layer?.action === e.action) this.layer = null;
    if (this.action && this.actions[this.action.index] === e.action && this.action.mode === 'once') {
      this._toBase();
    }
  }

  _toBase(fade = 0.15) {
    this._stopPreview();
    if (this.blend) {
      // back to the mix: the action fades out, the mix (eased by setMoveBlend) comes back up
      const was = this.action ? this.actions[this.action.index] : null;
      if (was && !this.blend.weights.has(this.action.index)) was.fadeOut(fade);
      this.action = null;
      this.current = this._blendTop ?? null;
      return;
    }
    this.action = null;
    if (this.base >= 0) this._show(this.base, { loop: true, fade });
    else {
      if (this.current !== null) this.actions[this.current]?.fadeOut(fade);
      this.current = null;
    }
  }

  /** Stop everything and forget movement and actions (Play stopped, component removed). */
  reset() {
    this._stopPreview();
    this.mixer.stopAllAction();
    this.blend = null;
    this.base = -1;
    this.action = null;
    this.current = null;
    this.layer = null;
  }

  dispose(engine) {
    this.reset();
    this.mixer.removeEventListener('finished', this._onFinished);
    this.mixer.uncacheRoot(this.root); // its actions and bindings, which hold on to the model
    const list = engine?.mixers;
    const i = list ? list.indexOf(this) : -1;
    if (i !== -1) list.splice(i, 1);
  }
}

/**
 * An object left the game: stop and drop the animation players of it and of
 * everything inside it. (A destroyed enemy's player stayed in the engine's list,
 * updated every frame for the rest of the game.)
 */
export function releaseAnimations(engine, root) {
  const inside = (node) => { for (let n = node; n; n = n.parent) if (n === root) return true; return false; };
  for (const player of [...(engine?.mixers || [])]) {
    if (!inside(player.root)) continue;
    if (typeof player.dispose === 'function') {
      player.dispose(engine);
    } else {
      player.mixer?.stopAllAction();
      player.mixer?.uncacheRoot?.(player.root);
      engine.mixers.splice(engine.mixers.indexOf(player), 1);
    }
  }
}
