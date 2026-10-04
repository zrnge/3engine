import * as THREE from 'three';
import { IDLE_RPM, REDLINE_RPM } from './vehicle.js';

/**
 * A car's sounds, made as it drives — no sound files needed:
 *
 *   engine  a four-cylinder's note: its firing frequency follows the revs
 *           (vehicle.js: through the gears), brighter and louder on the throttle
 *   tyres   a screech when they slide (drifting, the handbrake, a hard corner)
 *   crash   a thump and a clank, as hard as the hit
 *
 * Heard from where the car is (3D), through the game's Effects volume. Each
 * level is set every frame and set to fade out a moment later: when frames
 * stop coming (the game paused) the car falls silent by itself.
 */

const _noise = new WeakMap(); // context -> a second of noise, shared by every car
const _crash = new WeakMap(); // context -> the crash sound

function noiseBuffer(ctx) {
  if (!_noise.has(ctx)) {
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 16807) % 2147483647;
      d[i] = (seed / 2147483647) * 2 - 1;
    }
    _noise.set(ctx, buf);
  }
  return _noise.get(ctx);
}

/** Half a second: a low thump, a burst of crunch, and a metal clank. */
function crashBuffer(ctx) {
  if (!_crash.has(ctx)) {
    const rate = ctx.sampleRate;
    const n = Math.floor(rate * 0.6);
    const buf = ctx.createBuffer(1, n, rate);
    const d = buf.getChannelData(0);
    let seed = 777;
    let low = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      seed = (seed * 16807) % 2147483647;
      const white = (seed / 2147483647) * 2 - 1;
      low += (white - low) * 0.08; // the crunch: noise, darkened
      const thump = Math.sin(2 * Math.PI * (70 - 35 * Math.min(1, t / 0.3)) * t) * Math.exp(-t * 9);
      const crunch = low * 2.2 * Math.exp(-t * 7);
      const clank = (Math.sin(2 * Math.PI * 310 * t) + 0.7 * Math.sin(2 * Math.PI * 523 * t)
        + 0.5 * Math.sin(2 * Math.PI * 797 * t)) * 0.25 * Math.exp(-t * 16);
      d[i] = Math.max(-1, Math.min(1, thump * 0.9 + crunch + clank));
    }
    _crash.set(ctx, buf);
  }
  return _crash.get(ctx);
}

/** A buzzy engine note: falling harmonics, the odd ones and every third a little stronger. */
function engineWave(ctx) {
  const n = 28;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    imag[i] = (1 / i ** 0.85) * (i % 3 === 0 ? 1.35 : 1) * (i % 2 ? 1 : 0.65);
  }
  return ctx.createPeriodicWave(real, imag);
}

export class VehicleAudio {
  /** `engine`: the game engine (its audio and listener); `rig`: the car (vehicle.js). */
  constructor(engine, rig) {
    const audio = engine.audio;
    const ctx = audio?.context;
    this.ok = !!(ctx && engine.listener && typeof ctx.createOscillator === 'function' && typeof ctx.createPeriodicWave === 'function');
    if (!this.ok) return;
    this.ctx = ctx;
    // where it is heard from: the car
    this.out = new THREE.PositionalAudio(engine.listener);
    this.out.name = '__carSound';
    this.out.setRefDistance(6);
    rig.o.add(this.out);
    this.out.gain.disconnect();
    this.out.gain.connect(audio.buses.effects);
    this.mix = ctx.createGain();

    // the engine: its note, a sub-octave, and a little rasp, through a tone control
    this.osc = ctx.createOscillator();
    this.osc.setPeriodicWave(engineWave(ctx));
    this.sub = ctx.createOscillator();
    this.sub.type = 'square';
    const subGain = ctx.createGain();
    subGain.gain.value = 0.3;
    this.rasp = ctx.createBufferSource();
    this.rasp.buffer = noiseBuffer(ctx);
    this.rasp.loop = true;
    this.raspBand = ctx.createBiquadFilter();
    this.raspBand.type = 'bandpass';
    this.raspBand.Q.value = 2;
    const raspGain = ctx.createGain();
    raspGain.gain.value = 0.25;
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.Q.value = 0.7;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.osc.connect(this.tone);
    this.sub.connect(subGain).connect(this.tone);
    this.rasp.connect(this.raspBand).connect(raspGain).connect(this.tone);
    this.tone.connect(this.engineGain).connect(this.mix);

    // the tyres: noise, rung through two narrow bands — a screech
    this.skid = ctx.createBufferSource();
    this.skid.buffer = noiseBuffer(ctx);
    this.skid.loop = true;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    for (const [f, q] of [[1750, 6], [2650, 8]]) {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = f;
      band.Q.value = q;
      this.skid.connect(band).connect(this.skidGain);
    }
    this.skidGain.connect(this.mix);

    this.out.setNodeSource(this.mix);
    const at = ctx.currentTime;
    this.osc.start(at);
    this.sub.start(at);
    this.rasp.start(at, Math.random());
    this.skid.start(at, Math.random());
  }

  /** Set a level now, and a fade to silence shortly after (undone by the next frame). */
  _hold(param, value, now, smooth = 0.04) {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
    else param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, smooth);
    param.setTargetAtTime(0, now + 0.3, 0.08);
  }

  /** Every frame: follow the car's revs, throttle and sliding. */
  update(rig) {
    if (!this.ok) return;
    const now = this.ctx.currentTime;
    const fire = (rig.rpm / 60) * 2; // a four-cylinder fires twice a turn
    this.osc.frequency.setTargetAtTime(fire, now, 0.03);
    this.sub.frequency.setTargetAtTime(fire / 2, now, 0.03);
    this.raspBand.frequency.setTargetAtTime(fire * 3, now, 0.05);
    this.tone.frequency.setTargetAtTime(250 + fire * 5 + 2200 * rig.load, now, 0.05);
    const revs = (rig.rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM);
    // a car nobody drives is switched off (a car park of them doesn't drone)
    const running = rig.engineOn !== false ? 1 : 0;
    this._hold(this.engineGain.gain, running * rig.engineVolume * (0.16 + 0.26 * rig.load + 0.18 * revs), now, running ? 0.04 : 0.3);
    const sliding = rig.grounded ? Math.min(1, Math.max(0, (rig.slip - 2.5) / 6)) : 0;
    this._hold(this.skidGain.gain, rig.tyreVolume * sliding * 0.55, now, 0.06);
  }

  /** A crash: 0 a knock … 1 a smash. */
  crash(strength = 0.5) {
    if (!this.ok) return;
    const s = Math.min(1, Math.max(0, strength));
    const src = this.ctx.createBufferSource();
    src.buffer = crashBuffer(this.ctx);
    src.playbackRate.value = 0.85 + Math.random() * 0.3 - s * 0.1; // harder: a little deeper
    const gain = this.ctx.createGain();
    gain.gain.value = 0.25 + 0.75 * s;
    src.connect(gain).connect(this.mix);
    src.start();
    src.onended = () => gain.disconnect();
  }

  /** Silence it for good (play stops, the car is removed). */
  dispose() {
    if (!this.ok) return;
    for (const node of [this.osc, this.sub, this.rasp, this.skid]) {
      try { node.stop(); } catch { /* already stopped */ }
    }
    try { this.mix.disconnect(); } catch { /* gone */ }
    this.out.parent?.remove(this.out);
    try { this.out.gain.disconnect(); } catch { /* gone */ }
    this.ok = false;
  }
}
