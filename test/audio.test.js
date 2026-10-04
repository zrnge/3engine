// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { SoundSystem, soundSettings, MIX_DEFAULTS } from '../src/sound.js';
import {
  renderSfx, normalizeSfx, presetSfx, varySfx, sfxBuffer, sfxLength, SFX_PRESETS,
} from '../src/sfx.js';
import { impulseBuffer } from '../src/reverb.js';
import { ACTIONS } from '../src/rules.js';
import { COMPONENTS } from '../src/components.js';

// ------------------------------------------------------------ a fake Web Audio

function param(v = 1) {
  return {
    value: v,
    setValueAtTime(x) { this.value = x; return this; },
    linearRampToValueAtTime(x) { this.value = x; return this; },
    setTargetAtTime(x) { this.value = x; return this; },
    cancelScheduledValues() { return this; },
  };
}
function node(extra = {}) {
  return {
    connections: [],
    connect(n) { this.connections.push(n); return n; },
    disconnect() { this.connections = []; },
    ...extra,
  };
}
function fakeContext() {
  const ctx = {
    currentTime: 0, sampleRate: 8000, state: 'running', sources: [],
    destination: node(),
    listener: {
      positionX: param(0), positionY: param(0), positionZ: param(0),
      forwardX: param(0), forwardY: param(0), forwardZ: param(-1),
      upX: param(0), upY: param(1), upZ: param(0), setPosition() {}, setOrientation() {},
    },
    resume: vi.fn(),
    createGain: () => node({ gain: param(1) }),
    createDynamicsCompressor: () => node({
      threshold: param(0), knee: param(0), ratio: param(1), attack: param(0), release: param(0),
    }),
    createPanner: () => node({
      panningModel: '', refDistance: 1,
      positionX: param(), positionY: param(), positionZ: param(),
      orientationX: param(), orientationY: param(), orientationZ: param(),
      setPosition() {}, setOrientation() {},
    }),
    createBufferSource() {
      const s = node({
        buffer: null, loop: false, playbackRate: param(1), detune: param(0),
        started: false, stopped: false, onended: null,
        start() { this.started = true; },
        stop() { this.stopped = true; },
      });
      ctx.sources.push(s);
      return s;
    },
    createConvolver: () => node({ buffer: null, normalize: true }),
    createBuffer: (channels, length, sampleRate) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels, length, sampleRate, duration: length / sampleRate,
        getChannelData: (ch = 0) => data[ch],
      };
    },
  };
  return ctx;
}

let ctx;
let audio;
const buf = () => ({ duration: 0.5, length: 4000, sampleRate: 8000, numberOfChannels: 1, getChannelData: () => new Float32Array(4000) });
const thing = (name = 'Thing') => ({ object3D: Object.assign(new THREE.Object3D(), { name }) });

beforeEach(() => {
  ctx = fakeContext();
  THREE.AudioContext.setContext(ctx);
  audio = new SoundSystem(new THREE.AudioListener());
});
afterEach(() => vi.useRealTimers());

// ------------------------------------------------------------ the sound maker

describe('sound maker', () => {
  it('every preset makes a real, non-silent sound of the right length', () => {
    for (const name of Object.keys(SFX_PRESETS)) {
      const p = presetSfx(name, 5);
      const data = renderSfx(p, 8000);
      expect(data.length, name).toBe(Math.round(sfxLength(p) * 8000));
      const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      expect(peak, name).toBeGreaterThan(0.05);
      expect(peak, name).toBeLessThanOrEqual(p.volume + 1e-6);
    }
  });

  it('the same settings always make the same sound; a new seed changes noise', () => {
    const a = renderSfx(presetSfx('explosion', 11), 8000);
    const b = renderSfx({ ...presetSfx('explosion', 11) }, 8000);
    const c = renderSfx(presetSfx('explosion', 12), 8000);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it('ambience loops join up without a click', () => {
    for (const name of ['wind', 'rain', 'hum']) {
      const data = renderSfx(presetSfx(name, 3), 8000);
      const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      expect(Math.abs(data[0] - data[data.length - 1]), name).toBeLessThan(peak * 0.2);
    }
  });

  it('🎲 Vary makes the same kind of sound, a bit different, repeatably', () => {
    const coin = presetSfx('coin', 1);
    const v1 = varySfx(coin, 99);
    expect(v1).toEqual(varySfx(coin, 99));
    expect(v1.freq).not.toBe(coin.freq);
    expect(v1.wave).toBe(coin.wave);
    expect(Math.abs(v1.freq / coin.freq - 1)).toBeLessThanOrEqual(0.25);
    expect(varySfx(presetSfx('wind', 1), 5).loop).toBe(true);
  });

  it('clamps nonsense into something safe', () => {
    const p = normalizeSfx({ wave: 'kazoo', freq: 1e9, volume: 7, sustain: -3, decay: 0, attack: 0 });
    expect(p.wave).toBe('square');
    expect(p.freq).toBe(8000);
    expect(p.volume).toBe(1);
    expect(sfxLength(p)).toBeGreaterThan(0);
    expect(normalizeSfx({ loop: true, freq: 100, freqEnd: 900 }).freqEnd).toBe(100);
  });

  it('makes an AudioBuffer with a context, and a buffer-shaped stand-in without one', () => {
    const p = presetSfx('click', 2);
    const real = sfxBuffer(ctx, p);
    expect(real.getChannelData(0)).toEqual(renderSfx(p, 8000));
    const standIn = sfxBuffer(null, p);
    expect(standIn.duration).toBeCloseTo(sfxLength(p), 2);
  });
});

// ------------------------------------------------------------ the sound system

describe('SoundSystem', () => {
  it('routes every sound through its channel, and the mixer sets the levels', () => {
    const music = audio.add(null, buf(), { name: 'theme', bus: 'music' });
    expect(music.audio.gain.connections).toEqual([audio.buses.music]);
    audio.setMix({ music: 0.3, master: 0.5 });
    expect(audio.buses.music.gain.value).toBe(0.3);
    expect(audio.listener.getMasterVolume()).toBe(0.5);
    audio.setMuted(true);
    expect(audio.listener.getMasterVolume()).toBe(0);
    audio.setMuted(false);
    expect(audio.listener.getMasterVolume()).toBe(0.5);
    expect(audio.mixJSON()).toEqual({ ...MIX_DEFAULTS, music: 0.3, master: 0.5 });
  });

  it('every channel goes through a limiter, so many sounds at once do not distort', () => {
    // effects and ambience also feed the space's echo (see "spaces" below)
    for (const bus of Object.values(audio.buses)) expect(bus.connections[0]).toBe(audio.limiter);
    expect(audio.buses.music.connections).toEqual([audio.limiter]);
    expect(audio.limiter.connections).toEqual([audio.listener.getInput()]);
    expect(audio.limiter.threshold.value).toBeLessThan(0);
  });

  it('adding a sound never starts it — autoplay waits for Play', () => {
    const rec = audio.add(null, buf(), { name: 'theme', loop: true, autoplay: true });
    expect(audio.isPlaying(rec)).toBe(false);
    audio.startAutoplay();
    expect(audio.isPlaying(rec)).toBe(true);
  });

  it('overlapping sounds layer instead of cutting each other off', () => {
    const e = thing();
    const rec = audio.add(e, buf(), { name: 'shot' });
    expect(rec.overlap).toBe(true);
    audio.play(e, 'shot');
    audio.play(e, 'shot');
    const voices = ctx.sources.filter((s) => s.started && !s.stopped);
    expect(voices).toHaveLength(2);
    expect(voices[0].connections[0]).toBe(rec.audio.getOutput()); // same volume and 3D position
    expect(rec.audio.isPlaying).toBe(false);
  });

  it('caps the overlap so a held key cannot pile up hundreds of voices', () => {
    const rec = audio.add(null, buf(), { name: 'tick' });
    for (let i = 0; i < 20; i++) audio.play(null, 'tick');
    expect([...audio._voices].filter((v) => v.rec === rec)).toHaveLength(8);
  });

  it('without overlap a sound restarts; a loop never restarts', () => {
    const one = audio.add(null, buf(), { name: 'one', overlap: false });
    audio.play(null, 'one');
    const first = one.audio.source;
    audio.play(null, 'one');
    expect(first.stopped).toBe(true);
    expect(one.audio.isPlaying).toBe(true);

    const bed = audio.add(null, buf(), { name: 'bed', loop: true });
    audio.play(null, 'bed');
    const source = bed.audio.source;
    audio.play(null, 'bed');
    expect(bed.audio.source).toBe(source);
  });

  it('varies the pitch of each play within the range', () => {
    const rec = audio.add(null, buf(), { name: 'step', pitchVary: 0.2 });
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(1);
    audio.play(null, 'step');
    rnd.mockReturnValue(0);
    audio.play(null, 'step');
    rnd.mockRestore();
    const rates = ctx.sources.map((s) => s.playbackRate.value);
    expect(rates[0]).toBeCloseTo(1.2, 6);
    expect(rates[1]).toBeCloseTo(0.8, 6);
    expect(rec.pitchVary).toBe(0.2);
  });

  it('finds sounds by name: own first, with or without extension, then legacy tags, then the scene', () => {
    const hero = thing('Hero');
    const other = thing('Other');
    const jump = audio.add(hero, buf(), { name: 'Jump.wav' });
    const tagged = audio.add(hero, buf(), { name: 'pew', trigger: 'fire' });
    const theme = audio.add(null, buf(), { name: 'theme' });
    const far = audio.add(other, buf(), { name: 'bell' });
    expect(audio.find(hero, 'jump')).toEqual([jump]);
    expect(audio.find(hero, 'JUMP.WAV')).toEqual([jump]);
    expect(audio.find(hero, 'fire')).toEqual([tagged]);
    expect(audio.find(hero, 'theme')).toEqual([theme]);
    expect(audio.find(hero, 'bell')).toEqual([far]);
    expect(audio.find(hero, '')).toEqual([jump, tagged]);
    expect(audio.find(hero, 'nothing')).toEqual([]);
  });

  it('Play music fades the old track out and the new one in', () => {
    vi.useFakeTimers();
    const a = audio.add(null, buf(), { name: 'calm', bus: 'music', loop: true });
    const b = audio.add(null, buf(), { name: 'boss', bus: 'music', loop: true });
    audio.playMusic('calm', 0);
    expect(a.audio.isPlaying).toBe(true);

    audio.playMusic('boss', 1);
    expect(b.audio.isPlaying).toBe(true);
    expect(a.audio.gain.gain.value).toBe(0); // ramping down...
    expect(a.audio.isPlaying).toBe(true);    // ...still audible during the fade
    vi.advanceTimersByTime(1000);
    expect(a.audio.isPlaying).toBe(false);
    expect(a.audio.gain.gain.value).toBe(a.volume); // ready for next time

    audio.stopMusic(0);
    expect(b.audio.isPlaying).toBe(false);
  });

  it('changing how a sound is heard rebuilds it in place', () => {
    const e = thing();
    const rec = audio.add(e, buf(), { name: 'hum', loop: true });
    expect(rec.type).toBe('positional');
    expect(e.object3D.children).toContain(rec.audio);
    audio.update(rec, { type: 'global', bus: 'ambience', volume: 0.4 });
    expect(e.object3D.children).toHaveLength(0);
    expect(rec.audio.getOutput()).toBe(rec.audio.gain);
    expect(rec.audio.gain.connections).toEqual([audio.buses.ambience]);
    expect(rec.volume).toBe(0.4);
  });

  it('re-makes a sound-maker sound when its settings change', () => {
    const rec = audio.add(null, null, { name: 'zap', synth: presetSfx('shoot', 1) });
    const before = rec.buffer.length;
    audio.update(rec, { synth: { ...rec.synth, sustain: 1 } });
    expect(rec.buffer.length).toBeGreaterThan(before);
    expect(rec.synth.sustain).toBe(1);
  });

  it('delete and undo put the very same sound back', () => {
    const e = thing();
    const a = audio.add(e, buf(), { name: 'a' });
    const b = audio.add(e, buf(), { name: 'b' });
    audio.remove(a);
    expect(audio.sounds).toEqual([b]);
    expect(e.object3D.children).not.toContain(a.audio);
    audio.restore(a, 0);
    expect(audio.sounds).toEqual([a, b]);
    expect(e.object3D.children).toContain(a.audio);
  });

  it('stop everything silences overlapping voices too', () => {
    audio.add(null, buf(), { name: 'x' });
    const bed = audio.add(null, buf(), { name: 'bed', loop: true });
    audio.play(null, 'x');
    audio.play(null, 'bed');
    audio.stopAll();
    expect(audio._voices.size).toBe(0);
    expect(bed.audio.isPlaying).toBe(false);
  });

  it('removing an object lets its overlapping sound finish — a collected coin still dings', () => {
    const coin = thing('Coin');
    const rec = audio.add(coin, buf(), { name: 'ding' });
    audio.play(coin, 'ding');
    audio.clearEntity(coin);
    expect(ctx.sources[0].stopped).toBe(false);
    expect(audio.sounds).not.toContain(rec);
  });

  it('re-creates a made sound from its saved settings — for copies and prefabs', async () => {
    const original = audio.add(thing(), null, { name: 'zap', synth: presetSfx('shoot', 3), pitchVary: 0.2, bus: 'effects' });
    const copyOf = thing('Copy');
    const copy = await audio.addFromSettings(copyOf, soundSettings(original));
    expect(copy).not.toBe(original);
    expect(copy.entity).toBe(copyOf);
    expect(soundSettings(copy)).toEqual(soundSettings(original));
    expect(copy.buffer.length).toBe(original.buffer.length);
    expect(await audio.addFromSettings(copyOf, { name: 'lost' })).toBeNull(); // no file, not made
  });

  it('old scenes: "ambient" becomes an everywhere sound on the ambience channel', () => {
    const rec = audio.add(thing(), buf(), { type: 'ambient' });
    expect(rec.type).toBe('global');
    expect(rec.bus).toBe('ambience');
    expect(JSON.parse(JSON.stringify(soundSettings(rec)))).toEqual(soundSettings(rec));
  });
});

// ------------------------------------------------------------ gameplay hooks

describe('sounds in rules and components', () => {
  const engine = () => ({ playSound: vi.fn(), stopSound: vi.fn(), playMusic: vi.fn(), stopMusic: vi.fn() });
  const api = { resolveTarget: (sel, self, other) => (sel === 'other' ? other : self) };

  it('rules play and stop sounds by name, and switch music', () => {
    const eng = engine();
    const me = { object3D: {} };
    const them = { object3D: {} };
    ACTIONS.playSound.run({ action: { sound: 'coin', target: 'other' }, entity: me, other: them, engine: eng, api });
    expect(eng.playSound).toHaveBeenCalledWith(them, 'coin');
    ACTIONS.playSound.run({ action: { trigger: 'fire' }, entity: me, engine: eng, api }); // an old rule
    expect(eng.playSound).toHaveBeenLastCalledWith(me, 'fire');
    ACTIONS.stopSound.run({ action: { sound: 'alarm', target: 'self' }, entity: me, engine: eng, api });
    expect(eng.stopSound).toHaveBeenCalledWith(me, 'alarm');
    ACTIONS.playMusic.run({ action: { sound: 'boss', fade: 2 }, engine: eng });
    expect(eng.playMusic).toHaveBeenCalledWith('boss', 2);
    ACTIONS.stopMusic.run({ action: { fade: 0.5 }, engine: eng });
    expect(eng.stopMusic).toHaveBeenCalledWith(0.5);
  });

  it('a collectible plays its sound by name; a damager plays its hit sound', () => {
    const eng = { ...engine(), playerEntity: null };
    const coin = { object3D: {} };
    const vars = { change: vi.fn() };
    COMPONENTS.collectible.onTrigger({
      entity: coin, props: { variable: '', amount: 1, who: 'any', destroy: false, sound: 'ding' },
      state: {}, vars, engine: eng, api: { destroy() {} },
    }, { object3D: {} });
    expect(eng.playSound).toHaveBeenCalledWith(coin, 'ding');

    const spikes = { object3D: {} };
    COMPONENTS.damager.onTrigger({
      entity: spikes, props: { amount: 1, who: 'any', cooldown: 0, sound: 'ouch' },
      state: {}, engine: eng, api: { damage() {} }, time: 1,
    }, { object3D: {} });
    expect(eng.playSound).toHaveBeenLastCalledWith(spikes, 'ouch');
  });
});

describe("the player's own volume", () => {
  it("scales the game's mix, and survives a new level's mix", () => {
    audio.setMix({ music: 0.8 });
    audio.setPlayerVolume('music', 0.5);
    expect(audio.buses.music.gain.value).toBeCloseTo(0.4, 6);
    audio.setMix({ ...MIX_DEFAULTS, music: 0.6 }); // the next level loads its own mix
    expect(audio.buses.music.gain.value).toBeCloseTo(0.3, 6);
    audio.setPlayerVolume('nonsense', 0);
    audio.setPlayerVolume('effects', 7); // clamped
    expect(audio.playerMix.effects).toBe(1);
  });
});

// ------------------------------------------------------------ the room it sounds like

describe('spaces (reverb)', () => {
  it('makes an echo that fades, after a gap, and is the same every time', () => {
    expect(impulseBuffer(ctx, 'none')).toBeNull();
    expect(impulseBuffer(ctx, 'nonsense')).toBeNull(); // unknown = no space
    const cave = impulseBuffer(ctx, 'cave');
    const room = impulseBuffer(ctx, 'room');
    expect(cave.length).toBeGreaterThan(room.length * 4); // a cave rings on
    expect(cave.numberOfChannels).toBe(2);

    const data = cave.getChannelData(0);
    expect(data[0]).toBe(0); // the walls are far off: silence first
    const loudness = (from, to) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / (to - from));
    };
    const early = loudness(Math.floor(data.length * 0.1), Math.floor(data.length * 0.2));
    const late = loudness(Math.floor(data.length * 0.8), Math.floor(data.length * 0.9));
    expect(early).toBeGreaterThan(0);
    expect(late).toBeLessThan(early * 0.5); // it dies away
    expect(cave.getChannelData(1)[1000]).not.toBe(data[1000]); // two channels: width
    expect(impulseBuffer(ctx, 'cave').getChannelData(0)[1000]).toBe(data[1000]); // same space, same sound
  });

  it('is off until a scene asks for one, and rides on effects and ambience but not music', () => {
    expect(audio.mix.space).toBe('none');
    expect(audio.reverbSend.gain.value).toBe(0);
    expect(audio.buses.effects.connections).toContain(audio.reverbSend);
    expect(audio.buses.ambience.connections).toContain(audio.reverbSend);
    expect(audio.buses.music.connections).not.toContain(audio.reverbSend);

    audio.setMix({ space: 'hall', spaceAmount: 0.6 });
    expect(audio.reverb.buffer).toBeTruthy();
    expect(audio.reverbSend.gain.value).toBeCloseTo(0.6, 6);

    audio.setMix({ spaceAmount: 0.2 });
    expect(audio.reverbSend.gain.value).toBeCloseTo(0.2, 6);

    audio.setMix({ space: 'none' }); // outdoors again: nothing to hear
    expect(audio.reverbSend.gain.value).toBe(0);
  });

  it('travels with the scene, and building the echo is not repeated needlessly', () => {
    audio.setMix({ space: 'cathedral', spaceAmount: 0.5 });
    expect(audio.mixJSON()).toMatchObject({ space: 'cathedral', spaceAmount: 0.5, master: 1 });
    const built = audio.reverb.buffer;
    audio.setMix({ space: 'cathedral' });
    expect(audio.reverb.buffer).toBe(built); // same space: not rebuilt
    audio.setMix({ space: 'room' });
    expect(audio.reverb.buffer).not.toBe(built);
  });
});

describe('sounds of an object that leaves the game', () => {
  it('go with it: a looping hum stops and is dropped at once', () => {
    const drone = thing('Drone');
    const hum = audio.add(drone, buf(), { name: 'hum', loop: true });
    audio._play(hum);
    audio.retire(drone);
    expect(audio.sounds).not.toContain(hum);
  });

  it('one still ringing out is let finish first, then dropped', () => {
    vi.useFakeTimers();
    const coin = thing('Coin');
    const chime = audio.add(coin, buf(), { name: 'chime', overlap: false });
    audio._play(chime);
    audio.retire(coin);
    expect(audio.sounds).toContain(chime); // still sounding
    expect(chime.audio.isPlaying).toBe(true);
    vi.advanceTimersByTime(700); // its 0.5 s, and a little
    expect(audio.sounds).not.toContain(chime);
  });

  it('other objects\' sounds and the scene\'s music are untouched', () => {
    const coin = thing('Coin');
    const other = audio.add(thing('Door'), buf(), { name: 'creak' });
    const music = audio.add(null, buf(), { name: 'theme', bus: 'music' });
    audio.add(coin, buf(), { name: 'chime' });
    audio.retire(coin);
    expect(audio.sounds).toEqual([other, music]);
  });
});
