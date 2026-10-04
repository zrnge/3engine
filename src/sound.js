import * as THREE from 'three';
import { sfxBuffer, normalizeSfx } from './sfx.js';
import { impulseBuffer, spaceSettings } from './reverb.js';
import { assetStore } from './assets-db.js';

/**
 * SoundSystem — every sound in the scene, and how it reaches the speakers.
 *
 *   sound (on an object, or the scene itself)
 *     -> its channel: effects | music | ambience   (a mixer volume each)
 *     -> master volume / mute
 *
 * Sounds are found by NAME: a rule says "play coin", a control's jump plays
 * "jump". One-shot sounds can overlap themselves (a fresh voice per play, so
 * rapid fire doesn't cut itself off) and can vary their pitch so repeats don't
 * sound robotic. Nothing here starts playing on its own: Play mode calls
 * startAutoplay(), so autoplay music no longer blares while you edit.
 */

export const SOUND_BUSES = ['effects', 'music', 'ambience'];
/** The buses heard through the scene's space; music comes with its own. */
const REVERB_BUSES = ['effects', 'ambience'];
export const MIX_DEFAULTS = {
  master: 1, effects: 1, music: 1, ambience: 1,
  space: 'none',   // the room the game sounds like (reverb.js)
  spaceAmount: 0.4, // how much of the echo is heard
};
const MAX_VOICES = 8; // overlapping copies of one sound

const unit = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
};
const key = (s) => String(s ?? '').trim().toLowerCase();
const stem = (s) => key(s).replace(/\.[a-z0-9]{2,4}$/, '');

/** The saved form of a sound — also what undo snapshots. */
export function soundSettings(rec) {
  return {
    name: rec.name,
    type: rec.type,
    bus: rec.bus,
    volume: rec.volume,
    loop: rec.loop,
    autoplay: rec.autoplay,
    overlap: rec.overlap,
    pitchVary: rec.pitchVary,
    refDistance: rec.refDistance,
    trigger: rec.trigger,
    assetId: rec.assetId,
    synth: rec.synth ? { ...rec.synth } : null,
  };
}

export class SoundSystem {
  constructor(listener) {
    this.listener = listener;
    this.context = listener.context;
    this.sounds = [];
    this.mix = { ...MIX_DEFAULTS };
    this.muted = false;
    // The player's own volume (a game's pause menu), on top of the mix the game
    // was made with. Kept apart so a new level's mix never resets it.
    this.playerMix = { master: 1, effects: 1, music: 1, ambience: 1 };
    // A gentle limiter before the master: ten coins at once get louder, not
    // distorted (overlapping voices add up past full scale otherwise).
    this.limiter = this.context.createDynamicsCompressor?.() ?? null;
    if (this.limiter) {
      this.limiter.threshold.value = -6;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.25;
      this.limiter.connect(listener.getInput());
    }
    this.buses = {};
    for (const bus of SOUND_BUSES) {
      const gain = this.context.createGain();
      gain.connect(this.limiter ?? listener.getInput());
      this.buses[bus] = gain;
    }
    // The scene's space, heard alongside the dry sound: effects and ambience
    // feed a send, which goes through the echo and back into the master.
    this.reverb = this.context.createConvolver?.() ?? null;
    this.reverbSend = this.context.createGain?.() ?? null;
    if (this.reverb && this.reverbSend) {
      this.reverbSend.gain.value = 0;
      this.reverbSend.connect(this.reverb);
      this.reverb.connect(this.limiter ?? listener.getInput());
      for (const bus of REVERB_BUSES) this.buses[bus].connect(this.reverbSend);
    }
    this._voices = new Set(); // { source, rec } — overlapping one-shots
    this._applyMix();
  }

  /** Browsers keep audio suspended until a click or key press. */
  unlock() {
    if (this.context.state === 'suspended') this.context.resume?.();
  }

  // ---------------------------------------------------------------- mixer

  setMix(mix = {}) {
    for (const k of SOUND_BUSES.concat('master', 'spaceAmount')) {
      if (mix && k in mix) this.mix[k] = unit(mix[k], this.mix[k]);
    }
    if (mix && 'space' in mix) this.setSpace(mix.space);
    this._applyMix();
  }

  /**
   * The room the game sounds like: 'none', 'room', 'hall', 'cave' or
   * 'cathedral' (see reverb.js). Building the echo takes a moment, so it is
   * only rebuilt when the space really changes.
   */
  setSpace(name) {
    const space = spaceSettings(name).name;
    if (space === this.mix.space && this._spaceBuilt === space) return;
    this.mix.space = space;
    this._spaceBuilt = space;
    if (this.reverb) {
      try {
        this.reverb.buffer = impulseBuffer(this.context, space);
      } catch (err) {
        console.warn('[Tiny3] could not build the space:', space, err);
      }
    }
    this._applyMix();
  }

  mixJSON() { return { ...this.mix }; }

  setMuted(muted) {
    this.muted = !!muted;
    this._applyMix();
  }

  /** The player's volume for one channel (0–1): 'master', 'effects', 'music' or 'ambience'. */
  setPlayerVolume(channel, value) {
    if (!(channel in this.playerMix)) return;
    this.playerMix[channel] = unit(value, this.playerMix[channel]);
    this._applyMix();
  }

  _applyMix() {
    const p = this.playerMix;
    this.listener.gain.gain.value = this.muted ? 0 : this.mix.master * p.master;
    for (const bus of SOUND_BUSES) this.buses[bus].gain.value = this.mix[bus] * p[bus];
    if (this.reverbSend) {
      this.reverbSend.gain.value = this.mix.space === 'none' ? 0 : this.mix.spaceAmount;
    }
  }

  // ---------------------------------------------------------------- records

  /**
   * Add a sound to an entity, or to the scene itself when `entity` is null.
   * Pass a decoded `buffer`, or `opts.synth` (sound-maker settings) and no buffer.
   */
  add(entity, buffer, opts = {}) {
    const loop = !!opts.loop;
    const rec = {
      entity: entity ?? null,
      name: String(opts.name || 'sound'),
      // 'ambient' and 'global' used to be two names for the same thing
      type: entity && (opts.type ?? 'positional') === 'positional' ? 'positional' : 'global',
      bus: SOUND_BUSES.includes(opts.bus) ? opts.bus : (opts.type === 'ambient' ? 'ambience' : 'effects'),
      volume: unit(opts.volume, 1),
      loop,
      autoplay: !!opts.autoplay,
      overlap: opts.overlap ?? !loop,
      pitchVary: Math.min(0.5, unit(opts.pitchVary, 0)),
      refDistance: Number(opts.refDistance) > 0 ? Number(opts.refDistance) : 5,
      trigger: opts.trigger || null,
      assetId: opts.assetId || null,
      synth: opts.synth ? normalizeSfx(opts.synth) : null,
      buffer: buffer ?? null,
      audio: null,
    };
    if (!rec.buffer && rec.synth) rec.buffer = sfxBuffer(this.context, rec.synth);
    this._build(rec);
    this.sounds.push(rec);
    return rec;
  }

  /**
   * Re-create a sound from its saved settings (soundSettings) — for copies,
   * pastes and prefabs. Made sounds are re-made; files come from the asset store.
   */
  async addFromSettings(entity, settings) {
    if (!settings) return null;
    let buffer = null;
    if (!settings.synth) {
      if (!settings.assetId) return null;
      const url = await assetStore.objectURL(settings.assetId);
      if (!url) return null;
      buffer = await new THREE.AudioLoader().loadAsync(url);
    }
    return this.add(entity, buffer, settings);
  }

  _build(rec) {
    const audio = rec.type === 'positional'
      ? new THREE.PositionalAudio(this.listener)
      : new THREE.Audio(this.listener);
    if (rec.type === 'positional') {
      audio.setRefDistance(rec.refDistance);
      rec.entity.object3D.add(audio);
    }
    // through its channel instead of straight to the master
    audio.gain.disconnect();
    audio.gain.connect(this.buses[rec.bus]);
    if (rec.buffer) audio.setBuffer(rec.buffer);
    audio.setVolume(rec.volume);
    audio.setLoop(rec.loop);
    rec.audio = audio;
  }

  /**
   * Detach a sound's node. Overlapping voices are left to finish, so a coin
   * that disappears the moment it is collected still makes its sound.
   */
  _teardown(rec) {
    this._halt(rec);
    rec.audio.parent?.remove(rec.audio);
  }

  /** Change a sound's settings. Anything that needs a new node gets one. */
  update(rec, patch = {}) {
    const wasPlaying = !!rec.audio?.isPlaying;
    let rebuild = false;
    if ('name' in patch) rec.name = String(patch.name || 'sound');
    if (patch.synth) {
      rec.synth = normalizeSfx(patch.synth);
      rec.buffer = sfxBuffer(this.context, rec.synth);
      rebuild = true;
    }
    if ('type' in patch) {
      const type = rec.entity && patch.type === 'positional' ? 'positional' : 'global';
      if (type !== rec.type) { rec.type = type; rebuild = true; }
    }
    if ('bus' in patch && SOUND_BUSES.includes(patch.bus) && patch.bus !== rec.bus) {
      rec.bus = patch.bus;
      rebuild = true;
    }
    if ('volume' in patch) rec.volume = unit(patch.volume, rec.volume);
    if ('loop' in patch) rec.loop = !!patch.loop;
    if ('autoplay' in patch) rec.autoplay = !!patch.autoplay;
    if ('overlap' in patch) rec.overlap = !!patch.overlap;
    if ('pitchVary' in patch) rec.pitchVary = Math.min(0.5, unit(patch.pitchVary, rec.pitchVary));
    if ('refDistance' in patch && Number(patch.refDistance) > 0) rec.refDistance = Number(patch.refDistance);
    if ('trigger' in patch) rec.trigger = patch.trigger || null;

    if (rebuild) {
      this._teardown(rec);
      this._build(rec);
      if (wasPlaying && rec.loop) this._play(rec);
    } else {
      rec.audio.setVolume(rec.volume);
      rec.audio.setLoop(rec.loop);
      if (rec.type === 'positional') rec.audio.setRefDistance(rec.refDistance);
    }
  }

  remove(rec) {
    const i = this.sounds.indexOf(rec);
    if (i === -1) return;
    this._teardown(rec);
    this.sounds.splice(i, 1);
  }

  /** Put a removed sound back (undo). */
  restore(rec, index = this.sounds.length) {
    if (this.sounds.includes(rec)) return;
    this._build(rec);
    this.sounds.splice(Math.min(Math.max(0, index), this.sounds.length), 0, rec);
  }

  clearEntity(entity) {
    for (const rec of this.sounds.filter((s) => s.entity === entity)) this.remove(rec);
  }

  /**
   * An object left the game: its sounds go too — but one still ringing out (a
   * collected coin's chime) is let finish first. Overlapping voices finish by
   * themselves whatever happens; only a sound's own node has to be waited for.
   * (Every destroyed object's sounds used to stay in the list for good.)
   */
  retire(entity) {
    for (const rec of this.sounds.filter((s) => s.entity === entity)) {
      if (!rec.loop && rec.audio?.isPlaying && rec.buffer) {
        const rate = rec.audio.playbackRate || 1;
        setTimeout(() => this.remove(rec), (rec.buffer.duration / rate) * 1000 + 100);
      } else {
        this.remove(rec);
      }
    }
  }

  /** Drop every sound — a new or reloaded scene. */
  clear() {
    this.stopAll();
    for (const rec of [...this.sounds]) this.remove(rec);
  }

  names() { return [...new Set(this.sounds.map((s) => s.name))]; }

  // ---------------------------------------------------------------- finding

  /**
   * The sounds a name refers to, from `entity`'s point of view: its own sound by
   * that name (with or without the file extension), then its sounds with that
   * legacy trigger, then a scene sound, then the first sound anywhere by that
   * name. An empty name means all of the entity's own sounds.
   */
  find(entity, name = '') {
    const k = key(name);
    const own = this.sounds.filter((s) => s.entity === (entity ?? null));
    if (!k) return own;
    const named = (s) => key(s.name) === k || stem(s.name) === k;
    const candidates = [
      own.filter(named),
      own.filter((s) => key(s.trigger) === k),
      this.sounds.filter((s) => s.entity === null && named(s)),
    ];
    for (const list of candidates) if (list.length) return list;
    const anywhere = this.sounds.find(named);
    return anywhere ? [anywhere] : [];
  }

  isPlaying(rec) {
    if (rec.audio?.isPlaying) return true;
    for (const v of this._voices) if (v.rec === rec) return true;
    return false;
  }

  // ---------------------------------------------------------------- playing

  play(entity, name = '') {
    const recs = this.find(entity, name);
    for (const rec of recs) this._play(rec);
    return recs.length > 0;
  }

  stop(entity, name = '', fade = 0) {
    const recs = this.find(entity, name);
    for (const rec of recs) this._stop(rec, fade);
    return recs.length > 0;
  }

  /** The old way: an entity's sounds tagged with a trigger ('fire', 'jump'), or all. */
  playByTrigger(entity, trigger = null) {
    const recs = this.sounds.filter((s) => s.entity === entity && (!trigger || s.trigger === trigger));
    for (const rec of recs) this._play(rec);
    return recs.length > 0;
  }

  /** Fade every other music out and this one in. */
  playMusic(name, fade = 1) {
    const rec = this.find(null, name)[0];
    if (!rec) return false;
    for (const other of this.sounds) {
      if (other !== rec && other.bus === 'music' && this.isPlaying(other)) this._stop(other, fade);
    }
    if (rec.audio.isPlaying && !rec._fade) return true;
    return this._play(rec, { fadeIn: fade });
  }

  stopMusic(fade = 1) {
    for (const rec of this.sounds) if (rec.bus === 'music') this._stop(rec, fade);
  }

  /** Play mode starts: everything marked "on start". */
  startAutoplay() {
    for (const rec of this.sounds) if (rec.autoplay) this._play(rec);
  }

  /** The ▶ button: play, or stop if it is already playing. */
  preview(rec) {
    if (this.isPlaying(rec)) {
      this._stop(rec);
      return false;
    }
    return this._play(rec);
  }

  stopAll() {
    for (const v of [...this._voices]) this._endVoice(v);
    for (const rec of this.sounds) this._halt(rec);
  }

  _resetGain(rec) {
    clearTimeout(rec._fade);
    rec._fade = null;
    const gain = rec.audio.gain.gain;
    const t = this.context.currentTime;
    gain.cancelScheduledValues?.(t);
    gain.setValueAtTime?.(rec.volume, t);
  }

  _play(rec, { fadeIn = 0 } = {}) {
    if (!rec.buffer || !this.sounds.includes(rec)) return false;
    this.unlock();
    this._resetGain(rec); // undo a fade-out still in progress
    if (fadeIn > 0) {
      const gain = rec.audio.gain.gain;
      const t = this.context.currentTime;
      gain.setValueAtTime?.(0, t);
      gain.linearRampToValueAtTime?.(rec.volume, t + fadeIn);
    }
    const rate = rec.pitchVary > 0 ? 1 + (Math.random() * 2 - 1) * rec.pitchVary : 1;

    if (rec.loop) {
      if (!rec.audio.isPlaying) {
        rec.audio.setPlaybackRate(rate);
        rec.audio.play();
      }
      return true;
    }
    if (!rec.overlap) {
      if (rec.audio.isPlaying) rec.audio.stop();
      rec.audio.setPlaybackRate(rate);
      rec.audio.play();
      return true;
    }

    // a fresh voice through the same volume / 3D position, so plays overlap
    const source = this.context.createBufferSource();
    source.buffer = rec.buffer;
    source.playbackRate.value = rate;
    source.connect(rec.audio.getOutput());
    const voice = { source, rec };
    source.onended = () => this._voices.delete(voice);
    this._voices.add(voice);
    source.start();
    const mine = [...this._voices].filter((v) => v.rec === rec);
    if (mine.length > MAX_VOICES) this._endVoice(mine[0]);
    return true;
  }

  _endVoice(voice) {
    try { voice.source.stop(); } catch (_) { /* already ended */ }
    voice.source.disconnect?.();
    this._voices.delete(voice);
  }

  /** Stop a sound's main node at once. */
  _halt(rec) {
    clearTimeout(rec._fade);
    rec._fade = null;
    if (rec.audio?.isPlaying) rec.audio.stop();
  }

  _stop(rec, fade = 0) {
    for (const v of [...this._voices]) if (v.rec === rec) this._endVoice(v);
    if (!rec.audio.isPlaying) return;
    if (!(fade > 0)) {
      this._halt(rec);
      return;
    }
    const gain = rec.audio.gain.gain;
    const t = this.context.currentTime;
    gain.cancelScheduledValues?.(t);
    gain.setValueAtTime?.(gain.value, t);
    gain.linearRampToValueAtTime?.(0, t + fade);
    clearTimeout(rec._fade);
    rec._fade = setTimeout(() => {
      rec._fade = null;
      if (rec.audio.isPlaying) rec.audio.stop();
      this._resetGain(rec);
    }, fade * 1000);
  }
}
