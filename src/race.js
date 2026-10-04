import * as THREE from 'three';
import { groupsOf } from './groups.js';

/**
 * A race: laps round checkpoints, in order, against the clock and the other
 * cars. The Race component sits on the start / finish line; the checkpoints
 * are objects in a group ("Checkpoints"), in name order round the track —
 * gates, markers, empty objects: reaching one is being inside its box (a
 * little bigger than it, or 16 m round an empty marker).
 *
 *   countdown   3, 2, 1, GO! — every car held still until GO
 *   racing      each car must reach its next checkpoint; the line after the
 *               last is a lap. Positions are by laps, checkpoints, and how far
 *               along the way to the next one.
 *   done        the player finished: 1st… and the game won (in the top places)
 *               or lost
 *
 * The player's car writes the race into variables the HUD shows and rules can
 * use: lap, position, raceTime, bestLap. The other cars are driven by the
 * race: along the checkpoints, looking ahead, braking for the corners, put
 * back on the track if they get stuck.
 */

export const RACE_DEFAULTS = {
  checkpoints: 'Checkpoints', // a group (in name order) or names split by commas
  laps: 3,
  countdown: 3,               // seconds of 3-2-1 (0: straight off)
  racers: 'every car',        // or a group of cars
  skill: 90,                  // % of their top speed the other cars drive at
  catchUp: true,              // the others ease off when far ahead, push when behind
  winPlaces: 1,               // finishing in the top N wins (0: finishing is enough)
  resetKey: 'R',              // back to the last checkpoint
  showNext: true,             // an arrow over the player's next checkpoint
  messages: true,             // "Lap 2 / 3", "Final lap!", "Best lap"
};
export const RESET_KEYS = { R: 'KeyR', T: 'KeyT', Backspace: 'Backspace', none: null };

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** 83.4 seconds → "1:23.4". */
export const formatTime = (seconds) => {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

/** Objects in a group (name order), or named (split by commas). */
function objectsFrom(engine, spec) {
  const text = String(spec || '').trim();
  if (!text) return [];
  const inGroup = (engine.entities || [])
    .filter((e) => groupsOf(e).some((g) => g.toLowerCase() === text.toLowerCase()))
    .sort((a, b) => (a.object3D.name || '').localeCompare(b.object3D.name || '', undefined, { numeric: true }));
  if (inGroup.length) return inGroup;
  const names = text.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  return names.map((n) => (engine.entities || []).find((e) => (e.object3D.name || '').toLowerCase() === n)).filter(Boolean);
}

/** Where an object counts as reached: its box, a little bigger — or 16 m round an empty marker. */
function zoneOf(o) {
  o.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(o);
  const size = box.isEmpty() ? null : box.getSize(new THREE.Vector3());
  if (!size || Math.max(size.x, size.z) < 2) {
    const c = o.getWorldPosition(new THREE.Vector3());
    return new THREE.Box3(c.clone().add(new THREE.Vector3(-8, -4, -8)), c.clone().add(new THREE.Vector3(8, 6, 8)));
  }
  return box.expandByVector(new THREE.Vector3(1.5, 4, 1.5));
}

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

export class Race {
  constructor(engine, finish, settings = {}) {
    this.engine = engine;
    this.finish = finish;
    this.phase = 'waiting';
    this.racers = [];
    this.results = [];
    this.configure(settings);
  }

  configure(settings = {}) {
    const s = { ...RACE_DEFAULTS, ...settings };
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    this.settings = s;
    this.laps = Math.max(1, Math.round(num(s.laps, 3)));
    this.countdown = Math.max(0, Math.round(num(s.countdown, 3)));
    this.skill = THREE.MathUtils.clamp(num(s.skill, 90), 10, 150) / 100;
    this.winPlaces = Math.max(0, Math.round(num(s.winPlaces, 1)));
    this.resetCode = s.resetKey in RESET_KEYS ? RESET_KEYS[s.resetKey] : 'KeyR';
  }

  /** Who races, and round what: from the scene as it is when the race starts. */
  _setUp(time) {
    const cars = String(this.settings.racers || '').trim().toLowerCase() === 'every car'
      ? (this.engine.entities || []).filter((e) => e.vehicle)
      : objectsFrom(this.engine, this.settings.racers).filter((e) => e.vehicle);
    this.points = [this.finish.object3D, ...objectsFrom(this.engine, this.settings.checkpoints)
      .filter((e) => e !== this.finish).map((e) => e.object3D)];
    this.zones = this.points.map(zoneOf);
    this.centers = this.zones.map((z) => z.getCenter(new THREE.Vector3()));
    const first = this.points.length > 1 ? 1 : 0;
    this.racers = cars.map((entity) => ({
      entity, next: first, last: 0, lap: 0, passed: 0, lapStart: time, bestLap: null,
      finished: null, stuck: 0, away: false,
    }));
    this.startedAt = time + this.countdown;
    this.phase = this.countdown > 0 ? 'countdown' : 'racing';
    this._counted = this.countdown + 1;
    if (this.phase === 'racing') this._go(time);
  }

  /** The racer the player is driving, if any. */
  get player() { return this.racers.find((r) => r.entity === this.engine.playerEntity) ?? null; }

  /** Every frame. */
  update(dt, time, api) {
    if (this.phase === 'waiting') this._setUp(time);
    if (!this.racers.length) return;
    if (this.phase === 'countdown') {
      for (const r of this.racers) r.entity.vehicle?.setInput(0, 0, true); // held on the line
      const left = Math.ceil(this.startedAt - time);
      if (left < this._counted && left > 0) {
        this._counted = left;
        this._say(String(left), 0.9, 'middle');
        this._beep(660, 0.15);
      }
      if (time >= this.startedAt) this._go(time);
      this._variables(time);
      return;
    }
    for (const r of this.racers) this._reach(r, time, api);
    if (this.phase !== 'racing' && this.phase !== 'done') return;
    const player = this.player;
    for (const r of this.racers) {
      if (r === player) continue;
      if (r.finished !== null) { r.entity.vehicle?.setInput(0, 0, false); continue; } // done: coast to a stop
      this._drive(r, dt);
    }
    this._resets(dt, player);
    this._variables(time);
    this._arrow(time);
  }

  _go(time) {
    this.phase = 'racing';
    for (const r of this.racers) r.lapStart = time;
    this.startedAt = time;
    this._say('GO!', 1.2, 'middle');
    this._beep(1320, 0.45);
  }

  /** Has it reached its next checkpoint? A lap, a finish. */
  _reach(r, time, api) {
    if (r.finished !== null) return;
    const p = r.entity.object3D.position;
    const zone = this.zones[r.next];
    if (this.points.length === 1) { // only the line: a lap is leaving it and coming back
      if (!zone.containsPoint(p)) { if (zone.distanceToPoint(p) > 20) r.away = true; return; }
      if (!r.away) return;
      r.away = false;
    } else if (!zone.containsPoint(p)) {
      return;
    }
    r.passed++;
    r.last = r.next;
    r.next = (r.next + 1) % this.points.length;
    if (r.last !== 0) return;
    // over the line: a lap
    r.lap++;
    const lapTime = time - r.lapStart;
    r.lapStart = time;
    const best = r.bestLap === null || lapTime < r.bestLap;
    if (best) r.bestLap = lapTime;
    const isPlayer = r === this.player;
    if (r.lap >= this.laps) {
      r.finished = time - this.startedAt;
      this.results.push(r);
      if (isPlayer) this._finish(r, api);
      return;
    }
    if (!isPlayer) return;
    if (r.lap === this.laps - 1) this._say(best && r.lap > 1 ? `Final lap! Best lap ${formatTime(lapTime)}` : 'Final lap!', 2);
    else this._say(`Lap ${r.lap + 1} / ${this.laps}${best && r.lap > 1 ? ` — best lap ${formatTime(lapTime)}` : ''}`, 2);
  }

  _finish(r, api) {
    this.phase = 'done';
    const place = this.results.indexOf(r) + 1;
    const text = `You finished ${ordinal(place)}! ${formatTime(r.finished)}`;
    const won = this.winPlaces === 0 || place <= this.winPlaces;
    this.engine.variables?.set('position', place);
    api?.finish?.(won ? 'win' : 'lose', text);
    if (!api?.finish) this._say(text, 4, 'middle');
  }

  /** How far round the race it is: laps, checkpoints, and the way to the next one. */
  progress(r) {
    if (r.finished !== null) return 1e6 - r.finished; // finished: by when
    const from = this.centers[r.last];
    const to = this.centers[r.next];
    const way = from.distanceTo(to) || 1;
    const along = 1 - Math.min(1, r.entity.object3D.position.distanceTo(to) / way);
    return r.passed + Math.max(0, along);
  }

  /** 1st, 2nd … for each racer (1-based). */
  positions() {
    const order = [...this.racers].sort((a, b) => this.progress(b) - this.progress(a));
    return new Map(order.map((r, i) => [r, i + 1]));
  }

  /**
   * A car the race drives: at the next checkpoint, turning in early towards
   * the one after it; slowing for the corner there in time to take it.
   */
  _drive(r, dt) {
    const rig = r.entity.vehicle;
    if (!rig) return;
    const pos = r.entity.object3D.position;
    const target = this.centers[r.next];
    const after = this.centers[(r.next + 1) % this.points.length];
    const dist = Math.hypot(target.x - pos.x, target.z - pos.z);
    // the corner at the next checkpoint: how sharply the track turns there
    _p.set(target.x - pos.x, 0, target.z - pos.z).normalize();
    _q.set(after.x - target.x, 0, after.z - target.z).normalize();
    const turn = Math.acos(THREE.MathUtils.clamp(_p.dot(_q), -1, 1)); // 0 straight on … π back
    let fast = rig.top * this.skill;
    // catching up: ease off when far ahead of the player, push when behind
    const player = this.player;
    if (this.settings.catchUp !== false && player) {
      const gap = this.progress(r) - this.progress(player);
      fast *= THREE.MathUtils.clamp(1 - 0.08 * gap, 0.75, 1.15);
    }
    const corner = fast * (1 - 0.8 * (turn / Math.PI) ** 0.8);
    const braking = (rig.speed * rig.speed - corner * corner) / (2 * rig.brake * 0.7);
    const speed = dist < braking + 6 ? corner : fast;
    // turn in early: aim part way towards the checkpoint after — but always somewhere
    // inside this one (aimed past it, a car came in from the side and went round it)
    const look = Math.max(10, Math.abs(rig.speed) * 1.2);
    const k = dist < look ? 0.35 * (1 - dist / look) : 0;
    _p.copy(target).lerp(after, k);
    this.zones[r.next].clampPoint(_p, _p);
    rig.steerTowards(_p, speed);
  }

  /** The reset key puts the player back at its last checkpoint; a stuck car is put back too. */
  _resets(dt, player) {
    const input = this.engine.input;
    if (player && this.resetCode && input?.wasPressed?.(this.resetCode) && player.finished === null) this.resetRacer(player);
    for (const r of this.racers) {
      if (r === player || r.finished !== null || !r.entity.vehicle) continue;
      r.stuck = Math.abs(r.entity.vehicle.speed) < 1 ? r.stuck + dt : 0;
      if (r.stuck > 3) this.resetRacer(r);
    }
  }

  /** Back on the track at its last checkpoint, facing the next, standing still. */
  resetRacer(r) {
    const o = r.entity.object3D;
    const at = this.centers[r.last];
    const to = this.centers[r.next];
    const body = r.entity.rigidBody;
    // the ground there
    const hit = this.engine.physics?.raycast?.(new THREE.Vector3(at.x, at.y + 10, at.z), new THREE.Vector3(0, -1, 0), 60, {
      skip: (e, b) => e === r.entity || b.isTrigger || b.type === 'dynamic',
    });
    o.position.set(at.x, (hit ? hit.point.y : at.y) + 0.5, at.z);
    const front = r.entity.vehicle?.forwardLocal ?? new THREE.Vector3(0, 0, 1);
    const heading = Math.atan2(to.x - at.x, to.z - at.z) - Math.atan2(front.x, front.z);
    o.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    if (body) {
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
    }
    for (const w of r.entity.vehicle?.wheels ?? []) w.springLen = null;
    r.stuck = 0;
  }

  /** The player's race, where the HUD and rules see it. */
  _variables(time) {
    const vars = this.engine.variables;
    const r = this.player;
    if (!vars || !r) return;
    vars.set('lap', Math.min(this.laps, r.lap + 1));
    if (r.finished === null) vars.set('position', this.positions().get(r));
    const run = this.phase === 'countdown' ? 0 : (r.finished ?? time - this.startedAt);
    vars.set('raceTime', Math.round(run * 10) / 10);
    if (r.bestLap !== null) vars.set('bestLap', Math.round(r.bestLap * 10) / 10);
  }

  /** A bobbing arrow over the player's next checkpoint. */
  _arrow(time) {
    const r = this.player;
    const show = this.settings.showNext !== false && r && r.finished === null && this.engine.scene;
    if (!show) { if (this.arrow) this.arrow.visible = false; return; }
    if (!this.arrow) {
      this.arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.9, 2, 16).rotateX(Math.PI), // pointing down
        new THREE.MeshStandardMaterial({ color: 0xffd54f, emissive: 0xffb300, emissiveIntensity: 0.8 }),
      );
      this.arrow.name = '__raceArrow';
      this.engine.scene.add(this.arrow);
    }
    const zone = this.zones[r.next];
    const c = this.centers[r.next];
    this.arrow.visible = true;
    this.arrow.position.set(c.x, zone.max.y + 1.2 + Math.sin(time * 3) * 0.3, c.z);
    this.arrow.rotation.y = time * 2;
  }

  _say(text, seconds = 2, where = 'top') {
    if (this.settings.messages === false && !/^(\d|GO)/.test(text)) return;
    this.engine.onMessage?.(text, { seconds, where });
  }

  /** A start beep, through the game's Effects channel. */
  _beep(freq, seconds) {
    const audio = this.engine.audio;
    const ctx = audio?.context;
    if (!ctx?.createOscillator || !audio.buses?.effects) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + seconds);
    osc.connect(gain).connect(audio.buses.effects);
    osc.start(now);
    osc.stop(now + seconds + 0.05);
    osc.onended = () => gain.disconnect();
  }

  dispose() {
    if (this.arrow) {
      this.arrow.parent?.remove(this.arrow);
      this.arrow.geometry.dispose();
      this.arrow.material.dispose();
      this.arrow = null;
    }
  }
}
