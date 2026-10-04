/**
 * Sound maker — sound effects and ambience made from a handful of numbers
 * instead of audio files.
 *
 *   const params = presetSfx('coin');        // a ready-made coin sound
 *   const other  = varySfx(params);          // same kind of sound, a bit different
 *   const buffer = sfxBuffer(audioContext, params);
 *
 * Only the numbers are saved, so a synthesized sound costs a few bytes in a
 * scene or an exported game, and nobody has to go looking for a file. The same
 * numbers always make the same sound (noise comes from a seeded generator).
 */

export const WAVES = ['square', 'saw', 'triangle', 'sine', 'noise'];

const DEFAULTS = {
  preset: 'custom',
  wave: 'square',
  freq: 440,        // Hz at the start
  freqEnd: 440,     // Hz at the end — slides between them
  attack: 0,        // seconds
  sustain: 0.1,     // seconds (the whole length, for loops)
  decay: 0.2,       // seconds
  volume: 0.6,      // peak, 0..1
  duty: 0.5,        // square wave pulse width
  lowpass: 1,       // 1 = bright ... 0.01 = very muffled
  vibrato: 0,       // pitch wobble depth (fraction)
  vibratoRate: 6,
  tremolo: 0,       // volume wobble depth (0..1) — gusts, pulses
  tremoloRate: 4,
  jump: 1,          // pitch multiplier applied at `jumpAt` — the "ding-DING" of a coin
  jumpAt: 0.1,
  loop: false,      // an ambience bed that repeats seamlessly
  seed: 1,
};

export const SFX_PRESETS = {
  jump: { label: 'Jump', group: 'effect', params: { wave: 'square', freq: 260, freqEnd: 620, sustain: 0.06, decay: 0.18, duty: 0.35, volume: 0.5 } },
  coin: { label: 'Coin', group: 'effect', params: { wave: 'square', freq: 988, freqEnd: 988, sustain: 0.06, decay: 0.3, jump: 1.335, jumpAt: 0.06, volume: 0.45 } },
  shoot: { label: 'Shoot', group: 'effect', params: { wave: 'saw', freq: 1400, freqEnd: 180, sustain: 0.02, decay: 0.22, lowpass: 0.6, volume: 0.45 } },
  hit: { label: 'Hit', group: 'effect', params: { wave: 'noise', freq: 900, freqEnd: 250, sustain: 0.02, decay: 0.16, lowpass: 0.5, volume: 0.6 } },
  explosion: { label: 'Explosion', group: 'effect', params: { wave: 'noise', freq: 240, freqEnd: 40, sustain: 0.12, decay: 0.9, lowpass: 0.25, volume: 0.8 } },
  powerup: { label: 'Power-up', group: 'effect', params: { wave: 'square', freq: 330, freqEnd: 1100, sustain: 0.35, decay: 0.2, vibrato: 0.08, vibratoRate: 14, duty: 0.4, volume: 0.45 } },
  click: { label: 'Click', group: 'effect', params: { wave: 'sine', freq: 1200, freqEnd: 700, sustain: 0, decay: 0.04, volume: 0.5 } },
  footstep: { label: 'Footstep', group: 'effect', params: { wave: 'noise', freq: 500, freqEnd: 120, sustain: 0, decay: 0.09, lowpass: 0.2, volume: 0.5 } },
  wind: { label: 'Wind', group: 'ambience', params: { wave: 'noise', freq: 120, sustain: 4, lowpass: 0.06, tremolo: 0.6, tremoloRate: 0.5, loop: true, volume: 0.5 } },
  rain: { label: 'Rain', group: 'ambience', params: { wave: 'noise', freq: 5000, sustain: 4, lowpass: 0.35, tremolo: 0.08, tremoloRate: 3, loop: true, volume: 0.35 } },
  hum: { label: 'Hum', group: 'ambience', params: { wave: 'triangle', freq: 55, sustain: 4, lowpass: 0.3, vibrato: 0.01, vibratoRate: 0.5, tremolo: 0.2, tremoloRate: 0.25, loop: true, volume: 0.4 } },
};

/** A small, fast, seedable random generator (mulberry32). */
function seeded(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomSeed = () => 1 + Math.floor(Math.random() * 2147483646);

const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** Fill in defaults and clamp everything into a range that can't hurt ears or hang. */
export function normalizeSfx(raw = {}) {
  const p = { ...DEFAULTS, ...(raw || {}) };
  const loop = !!p.loop;
  const out = {
    preset: typeof p.preset === 'string' ? p.preset : 'custom',
    wave: WAVES.includes(p.wave) ? p.wave : 'square',
    freq: clamp(p.freq, 20, 8000, DEFAULTS.freq),
    freqEnd: clamp(p.freqEnd ?? p.freq, 20, 8000, DEFAULTS.freqEnd),
    attack: loop ? 0 : clamp(p.attack, 0, 2, 0),
    sustain: clamp(p.sustain, 0, 8, DEFAULTS.sustain),
    decay: loop ? 0 : clamp(p.decay, 0, 8, DEFAULTS.decay),
    volume: clamp(p.volume, 0, 1, DEFAULTS.volume),
    duty: clamp(p.duty, 0.05, 0.95, 0.5),
    lowpass: clamp(p.lowpass, 0.01, 1, 1),
    vibrato: clamp(p.vibrato, 0, 1, 0),
    vibratoRate: clamp(p.vibratoRate, 0, 40, 6),
    tremolo: clamp(p.tremolo, 0, 1, 0),
    tremoloRate: clamp(p.tremoloRate, 0, 20, 4),
    jump: clamp(p.jump, 0.25, 4, 1),
    jumpAt: clamp(p.jumpAt, 0, 8, 0.1),
    loop,
    seed: Math.floor(clamp(p.seed, 1, 2147483646, 1)),
  };
  if (loop) {
    out.freqEnd = out.freq;        // a slide would jump at the loop point
    out.sustain = Math.max(0.5, out.sustain);
  }
  if (out.attack + out.sustain + out.decay < 0.01) out.decay = 0.01;
  return out;
}

/** Length in seconds. */
export function sfxLength(params) {
  const p = normalizeSfx(params);
  return p.attack + p.sustain + p.decay;
}

/** A preset's sound, ready to use. */
export function presetSfx(name, seed = randomSeed()) {
  const preset = SFX_PRESETS[name] ?? SFX_PRESETS.click;
  return normalizeSfx({ ...preset.params, preset: SFX_PRESETS[name] ? name : 'click', seed });
}

/** The same kind of sound, a little different — the 🎲 button. Deterministic per seed. */
export function varySfx(params, seed = randomSeed()) {
  const p = normalizeSfx(params);
  const r = seeded(seed);
  const j = (v, amount) => v * (1 + (r() * 2 - 1) * amount);
  return normalizeSfx({
    ...p,
    seed,
    freq: j(p.freq, 0.25),
    freqEnd: j(p.freqEnd, 0.25),
    sustain: p.loop ? p.sustain : j(p.sustain, 0.2),
    decay: j(p.decay, 0.2),
    lowpass: j(p.lowpass, 0.15),
    duty: j(p.duty, 0.2),
    vibratoRate: j(p.vibratoRate, 0.2),
  });
}

const _cache = new Map();

/** Render to raw samples (mono, -1..1). Pure — no Web Audio needed. */
export function renderSfx(params, sampleRate = 44100) {
  const p = normalizeSfx(params);
  const key = `${sampleRate}|${JSON.stringify(p)}`;
  const hit = _cache.get(key);
  if (hit) return hit;

  const total = p.attack + p.sustain + p.decay;
  const n = Math.max(1, Math.round(total * sampleRate));
  // loops render a little extra and fold it over the start, so the seam is inaudible
  const fold = p.loop ? Math.min(Math.round(0.25 * sampleRate), Math.floor(n / 4)) : 0;
  const raw = new Float32Array(n + fold);
  const rand = seeded(p.seed);
  const TAU = Math.PI * 2;

  let phase = 0;
  let noise = rand() * 2 - 1;
  let lp = 0;
  for (let i = 0; i < raw.length; i++) {
    const t = i / sampleRate;
    let f = p.freq * Math.pow(p.freqEnd / p.freq, Math.min(1, t / total));
    if (p.jump !== 1 && t >= p.jumpAt) f *= p.jump;
    if (p.vibrato) f *= 1 + p.vibrato * Math.sin(TAU * p.vibratoRate * t);

    phase += f / sampleRate;
    if (phase >= 1) {
      phase -= Math.floor(phase);
      noise = rand() * 2 - 1; // sample-and-hold noise: its pitch follows `f`
    }

    let s;
    switch (p.wave) {
      case 'sine': s = Math.sin(TAU * phase); break;
      case 'saw': s = 2 * phase - 1; break;
      case 'triangle': s = 4 * Math.abs(phase - 0.5) - 1; break;
      case 'noise': s = noise; break;
      default: s = phase < p.duty ? 1 : -1;
    }
    lp += (s - lp) * p.lowpass;

    let env = 1;
    if (!p.loop) {
      if (t < p.attack) env = t / p.attack;
      else if (t >= p.attack + p.sustain) {
        const x = Math.min(1, (t - p.attack - p.sustain) / (p.decay || 1e-9));
        env = (1 - x) * (1 - x);
      }
    }
    if (p.tremolo) env *= 1 - p.tremolo * (0.5 + 0.5 * Math.sin(TAU * p.tremoloRate * t));
    raw[i] = lp * env;
  }

  const out = raw.subarray(0, n).slice();
  for (let i = 0; i < fold; i++) {
    const k = i / fold;
    out[i] = out[i] * k + raw[n + i] * (1 - k);
  }

  // same loudness whatever the filter did: scale the peak to `volume`
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 1e-6) {
    const k = p.volume / peak;
    for (let i = 0; i < n; i++) out[i] *= k;
  }

  if (_cache.size > 48) _cache.delete(_cache.keys().next().value);
  _cache.set(key, out);
  return out;
}

/**
 * An AudioBuffer for these params. Without a Web Audio context (tests, a
 * browser without audio) it returns a buffer-shaped object with the same data.
 */
export function sfxBuffer(context, params) {
  const sampleRate = context?.sampleRate || 44100;
  const data = renderSfx(params, sampleRate);
  if (context && typeof context.createBuffer === 'function') {
    const buffer = context.createBuffer(1, data.length, sampleRate);
    buffer.getChannelData(0).set(data);
    return buffer;
  }
  return {
    numberOfChannels: 1, length: data.length, sampleRate,
    duration: data.length / sampleRate,
    getChannelData: () => data,
  };
}
