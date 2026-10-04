import * as THREE from 'three';
import { ComponentRuntime } from './components.js';
import { RuleRuntime, turnBy } from './rules.js';
import { ScreenRuntime } from './screens.js';
import { goLimp, clearRagdolls } from './ragdoll.js';
import { tidyRotation, yawOf } from './heading.js';
import { turnAround, scaleAround, forgetBounds } from './pivot.js';
import { ControlRuntime } from './controls.js';
import { GROUP_PREFIX, inGroup, matchesWho } from './groups.js';
import {
  saveKey, readSave, writeSave, removeSave, captureState, applyState, levelStart, poseOf, setPose, setHealth,
} from './saves.js';

const ease = (t) => t * t * (3 - 2 * t); // in and out
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _attackBox = new THREE.Box3();
const _attackPos = new THREE.Vector3();
const near = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) < 1e-6;

/**
 * Gameplay — the runtime that ties components, rules and variables together and
 * gives them one shared vocabulary for acting on the world.
 *
 * Components and rules never touch the engine directly; they go through the `api`
 * built here. That keeps them testable, and means "destroy this object" behaves
 * the same whether a rule or a component asked for it.
 */
export class Gameplay {
  constructor(engine) {
    this.engine = engine;
    this.components = new ComponentRuntime(engine);
    this.rules = new RuleRuntime(engine);
    this.controls = new ControlRuntime(engine, this); // keys, mouse and touch -> actions
    this.outcome = null;     // { result: 'win'|'lose', message } once the game ends
    this.onFinish = null;     // host hook, e.g. to show a banner
    this.onRestart = null;
    this.spawnPrefab = null;  // host supplies: (name, position) => Entity | null
    this.onGoToLevel = null;  // host supplies: async (target) => loads the level and starts it
    this.levelName = null;    // host supplies: () => the playing level's name (a save keeps it)
    this.checkpoint = null;   // where the player respawns: { level, p, q, s } (setCheckpoint)
    this._levelStart = new Map(); // each level object as the level began (saves.js levelStart)
    this._playerStart = null;
    this._pendingLoad = null; // a Load game waiting for its level to load
    this.loading = false;     // a level change is under way: gameplay waits for it
    this._timers = [];        // { left, fn } — actions waiting their turn ("After (s)")
    this._moves = [];         // { entity, from, to, t, seconds } — objects sliding somewhere
    this._turns = [];         // objects turning: to a rotation, or by an angle about an axis
    this._sizes = [];         // { entity, from, to, t, seconds } — objects growing or shrinking
    this.noises = [];         // { id, at, loud, kind, by, about, time } — heard by Senses (ai.js) for a moment
    this.screens = new ScreenRuntime(engine); // the game's screens and dialogue up now
    this.noiseId = 0;
    this.api = this._buildApi();
  }

  _buildApi() {
    const engine = this;
    return {
      /** Find a THREE.Object3D by name, or the player, for follow-style props. */
      findObject: (name) => {
        if (!name) return null;
        if (name === 'player') return engine.engine.playerEntity?.object3D ?? null;
        const index = engine.engine.entityIndex;
        const match = index ? index.named(name)[0] : engine.engine.entities.find(
          (e) => (e.object3D?.name || '').toLowerCase() === String(name).toLowerCase()
        );
        return match?.object3D ?? null;
      },

      /**
       * The one object a selector means: me, other, the player — or, of a
       * group or a name several objects share, the nearest (to `near`, or me).
       */
      resolveTarget: (selector, self, other, near = self) => engine.resolveAll(selector, self, other, near)[0] ?? null,
      /** Every object a selector means: a group's members, or all that share a name — nearest first. */
      resolveAll: (selector, self, other, near = self) => engine.resolveAll(selector, self, other, near),

      destroy: (entity) => engine.destroy(entity),
      damage: (entity, amount, source = null) => engine.damage(entity, amount, source),
      sendEvent: (name, to, sender, after, other) => engine.sendEvent(name, to, sender, after, other),
      setState: (entity, state) => engine.setState(entity, state),
      attack: (attacker, opts) => engine.attack(attacker, opts),
      /** Something hits `entity` — its "Something hits me" rules ({ other, by, kind: 'a shot'…, speed, toMe }). */
      hit: (entity, opts, time = engine.engine.time ?? 0) => engine.rules.hit(entity, opts, engine.api, time),
      makeNoise: (at, opts) => engine.makeNoise(at, opts),
      /** A character gone limp (ragdoll.js); `push` flings it (a vector, m/s). */
      ragdoll: (entity, opts) => goLimp(engine.engine, entity, opts),
      showScreen: (name) => engine.screens.show(name),
      hideScreen: (name) => engine.screens.hide(name),
      toggleScreen: (name) => engine.screens.toggle(name),
      startDialogue: (name) => engine.screens.startDialogue(name),
      hide: (entity) => engine.hide(entity),
      after: (seconds, fn) => engine.after(seconds, fn),
      moveTo: (entity, to, seconds) => engine.moveTo(entity, to, seconds),
      turn: (entity, how, seconds) => engine.turn(entity, how, seconds),
      resize: (entity, to, seconds, pivot) => engine.resize(entity, to, seconds, pivot),
      sizeGoal: (entity) => engine.sizeGoal(entity),
      spawn: (prefab, position) => engine.spawn(prefab, position),
      finish: (result, message) => engine.finish(result, message),
      restart: () => engine.restart(),
      goToLevel: (target) => engine.goToLevel(target),
      vars: () => engine.engine.variables,
      saveGame: (slot) => engine.saveGame(slot),
      loadGame: (slot) => engine.loadGame(slot),
      deleteSave: (slot) => engine.deleteSave(slot),
      hasSave: (slot) => engine.hasSave(slot),
      setCheckpoint: (at) => engine.setCheckpoint(at),
      respawn: (entity, opts) => engine.respawn(entity, opts),
    };
  }

  /** See api.resolveAll: the objects a selector means, nearest to `near` first. */
  resolveAll(selector, self, other, near = self) {
    if (!selector || selector === 'self') return self ? [self] : [];
    if (selector === 'other') return other ? [other] : [];
    const player = this.engine.playerEntity;
    if (selector === 'player') return player ? [player] : [];
    const s = String(selector);
    const lower = s.toLowerCase();
    const group = lower.startsWith(GROUP_PREFIX) ? s.slice(GROUP_PREFIX.length) : null;
    // lights too, named or in a group: a lamp a rule switches off, one that flickers. Straight from
    // the index (entity-index.js) — not by looking through every object each time
    const index = this.engine.entityIndex;
    const found = index
      ? (group !== null ? index.grouped(group) : index.named(s)).filter((e) => e.object3D)
      : (this.engine.entities || []).filter((e) => e.alive !== false && e.object3D
        && (group !== null ? inGroup(e, group) : (e.object3D.name || '').toLowerCase() === lower));
    const from = near?.object3D?.position;
    if (from && found.length > 1) {
      const d = new Map(found.map((e) => [e, e.object3D.position.distanceToSquared(from)]));
      found.sort((a, b) => d.get(a) - d.get(b));
    }
    return found;
  }

  // ---- saves and checkpoints (saves.js)

  /** This game's name, for its saves: two games on one website keep theirs apart. */
  _saveKey(slot) { return saveKey(this.engine.ui?.game?.name, slot); }

  saveGame(slot) {
    const record = captureState(this.engine, { level: this.levelName?.() ?? '', start: this._levelStart, checkpoint: this.checkpoint });
    return writeSave(this._saveKey(slot), record);
  }

  hasSave(slot) { return !!readSave(this._saveKey(slot)); }

  deleteSave(slot) { removeSave(this._saveKey(slot)); }

  /**
   * Back to a saved game: its level loaded afresh (so what has gone since comes
   * back), then the save's changes made — see start(). No host to load levels
   * (a test): made in place.
   */
  loadGame(slot) {
    const record = readSave(this._saveKey(slot));
    if (!record) return false;
    if (typeof this.onGoToLevel === 'function' && record.level) {
      this._pendingLoad = record;
      if (this.goToLevel(record.level)) return true;
      this._pendingLoad = null;
      return false;
    }
    applyState(this.engine, record);
    return true;
  }

  /**
   * Where the player comes back to: where it stands now, or at `at` (a
   * checkpoint flag, a trigger zone), standing on its bottom.
   */
  setCheckpoint(at = null) {
    const player = this.engine.playerEntity;
    if (!player?.object3D) return;
    const o = player.object3D;
    const pose = poseOf(o);
    if (at?.object3D && at !== player) {
      const box = new THREE.Box3().setFromObject(at.object3D);
      const mine = new THREE.Box3().setFromObject(o);
      if (!box.isEmpty()) {
        const c = box.getCenter(new THREE.Vector3());
        const lift = mine.isEmpty() ? 0 : o.position.y - mine.min.y; // from its feet to its origin
        pose.p = [c.x, box.min.y + lift + 0.05, c.z];
      }
    }
    this.checkpoint = { level: this.levelName?.() ?? '', ...pose };
  }

  /**
   * Back to life, back where it belongs: the player to its checkpoint (or where
   * it began the level), anything else to where it began. Its health full again.
   */
  respawn(entity = null, { heal = true } = {}) {
    const player = this.engine.playerEntity;
    const e = entity ?? player;
    if (!e?.object3D) return;
    let pose = null;
    if (e === player) pose = this.checkpoint && (!this.checkpoint.level || this.checkpoint.level === (this.levelName?.() ?? '')) ? this.checkpoint : this._playerStart;
    else if (Number.isInteger(e.levelKey)) pose = this._levelStart?.get(e.levelKey);
    if (pose) setPose(e, pose);
    if (e.object3D.visible === false) {
      e.object3D.visible = true;
      if (e.rigidBody) this.engine.physics.register(e);
    }
    if (heal) setHealth(this.engine, e);
    if (e.rigidBody) e.rigidBody.grounded = false;
  }

  /** Remove an entity from the running game (components and rules go with it). */
  destroy(entity) {
    if (!entity || entity.alive === false) return;
    this.components.clearEntity(entity);
    this.rules.clearEntity(entity);
    if (typeof entity.destroy === 'function') entity.destroy(this.engine);
    else this.engine.remove(entity);
  }

  /**
   * Subtract from an entity's Health component. No Health means nothing
   * happens. Its "I'm hurt" rules run — and "My health runs out" ones when it
   * reaches 0. `source` is who did it (a shooter, a Damager), when known.
   */
  damage(entity, amount, source = null) {
    const health = this.components.listFor(entity).find((c) => c.type === 'health');
    if (!health) return false;
    if (health.state.current === undefined) health.state.current = health.props.max;
    const before = health.state.current;
    health.state.current = Math.max(0, before - Number(amount || 0));
    if (health.props.mirrorTo) {
      this.engine.variables.set(health.props.mirrorTo, health.state.current);
    }
    if (health.state.current < before) {
      const time = this.engine.time ?? 0;
      entity.lastHurtBy = source; // (a ragdoll is flung away from it)
      // hurt from out of sight: it knows where from (an Enemy AI goes to look)
      if (entity.senses && source?.object3D && source !== entity && entity.senses.sees !== source) {
        entity.senses.heard = { at: source.object3D.getWorldPosition(new THREE.Vector3()), time, kind: 'a hit', by: source };
      }
      this.rules.on('hurt', entity, source, this.api, time);
      if (health.state.current <= 0) this.rules.on('healthOut', entity, source, this.api, time);
    }
    return true;
  }

  /**
   * A Hit / attack (melee): what `attacker` reaches — in front of it, within
   * `reach` and `arc` degrees (in first person, where the player looks), or
   * what the pointer is on — is hit: its "Something hits me (with an attack)"
   * rules run, it takes `damage`, and is knocked back `push` m/s. The nearest
   * one, or `all` of them. Returns what was hit.
   */
  attack(attacker, { aim = 'in front', reach = 2, arc = 90, all = false, hits = 'any', damage = 1, push = 3, sound = '' } = {}) {
    const o = attacker?.object3D;
    if (!o) return [];
    const engine = this.engine;
    const centre = (e) => {
      _attackBox.setFromObject(e.object3D);
      return _attackBox.isEmpty() ? e.object3D.getWorldPosition(new THREE.Vector3()) : _attackBox.getCenter(new THREE.Vector3());
    };
    const from = centre(attacker);
    _attackBox.setFromObject(o);
    const feet = _attackBox.isEmpty() ? from.y : _attackBox.min.y;
    const head = _attackBox.isEmpty() ? from.y : _attackBox.max.y;
    const within = (n, root) => { for (; n; n = n.parent) if (n === root) return true; return false; };
    // at its own height: not the ground it stands on, nor what is high over its head
    const level = (e) => {
      _attackBox.setFromObject(e.object3D);
      return _attackBox.isEmpty() || (_attackBox.max.y > feet + 0.1 && _attackBox.min.y < head);
    };
    // hidden things aren't hit — but the player is there even with its body not drawn (first person)
    const can = (e) => e !== attacker && e.alive !== false && e.object3D?.parent && (e.object3D.visible !== false || e === engine.playerEntity)
      && !e.object3D.isLight && !within(e.object3D, o) && !e.viewModel && level(e)
      && (!hits || hits === 'any' || matchesWho(hits, e, engine));
    const near = (e) => {
      _attackBox.setFromObject(e.object3D);
      return _attackBox.isEmpty() ? e.object3D.getWorldPosition(_attackPos).distanceTo(from) : _attackBox.distanceToPoint(from);
    };
    let struck = [];
    if (aim === 'pointer') {
      const e = this.rules.pick();
      if (e && can(e) && near(e) <= reach) struck = [e];
    } else {
      // the way it faces — or, the player in first person, where the view looks
      const fwd = new THREE.Vector3();
      if (engine.cameraRig?.mode === 'fps' && attacker === engine.playerEntity && engine.camera) engine.camera.getWorldDirection(fwd);
      else fwd.set(Math.sin(yawOf(o)), 0, Math.cos(yawOf(o)));
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, 1);
      fwd.normalize();
      const half = THREE.MathUtils.degToRad(Math.min(360, Math.max(1, Number(arc) || 90)) / 2);
      const found = [];
      for (const e of engine.entities || []) {
        if (!can(e)) continue;
        const d = near(e);
        if (d > reach) continue;
        const to = centre(e).sub(from).setY(0);
        // touching it, or within the arc in front
        if (d > 0.05 && to.lengthSq() > 1e-6 && to.normalize().angleTo(fwd) > half + 1e-6) continue;
        found.push([d, e]);
      }
      found.sort((a, b) => a[0] - b[0]);
      struck = (all ? found : found.slice(0, 1)).map(([, e]) => e);
    }
    if (sound) engine.playSound?.(attacker, sound);
    const time = engine.time ?? 0;
    for (const e of struck) {
      const toMe = centre(e).sub(from);
      if (Number(damage) > 0) this.damage(e, Number(damage), attacker);
      this.rules.hit(e, { other: attacker, by: attacker, kind: 'an attack', speed: null, toMe }, this.api, time);
      const body = e.rigidBody;
      if (Number(push) > 0 && body?.type === 'dynamic') {
        toMe.setY(0);
        if (toMe.lengthSq() < 1e-8) toMe.set(0, 0, 1);
        toMe.normalize().setY(0.25).normalize();
        body.velocity.addScaledVector(toMe, Number(push));
        if (toMe.y > 0) body.grounded = false;
      }
    }
    this.lastAttack = { by: o.name, hit: struck.map((e) => e.object3D.name) };
    return struck;
  }

  /**
   * Send the event `name` from `sender` to `to` — anything ("any": every object
   * listening for it), an object, a group, the player, self — now, or after
   * `after` seconds (a timer: an event sent to itself later).
   */
  sendEvent(name, to = 'any', sender = null, after = 0, other = null) {
    const deliver = () => {
      const targets = !to || to === 'any'
        ? (this.engine.entities || []).filter((e) => e.alive !== false)
        : this.resolveAll(to, sender, other);
      return this.rules.receive(name, targets, sender, this.api, this.engine.time ?? 0);
    };
    if (Number(after) > 0) this.after(Number(after), deliver);
    else deliver();
  }

  /**
   * A noise at `at`, heard by what has Senses within `loud` metres: a shot, an
   * alert, a Make a noise. `about` is where it tells them to look (an alert:
   * where the one who shouted saw someone) — `at` if not given.
   */
  makeNoise(at, { loud = 15, kind = 'a noise', by = null, about = null } = {}) {
    if (!at || !(Number(loud) > 0)) return;
    this.noises.push({
      id: ++this.noiseId, at: new THREE.Vector3(at.x, at.y, at.z), loud: Number(loud), kind, by,
      about: about ? new THREE.Vector3(about.x, about.y, about.z) : null, time: this.engine.time ?? 0,
    });
  }

  /** What `entity` is doing now — patrolling, chasing, open: its "I enter a state" rules run when it changes. */
  setState(entity, state) {
    if (!entity || entity.state === state) return;
    entity.state = state;
    this.rules.enteredState(entity, state, this.api, this.engine.time ?? 0);
  }

  /** Out of sight and out of the way: hidden, and no longer bumped into or hit. */
  hide(entity) {
    if (!entity?.object3D) return;
    entity.object3D.visible = false;
    this.engine.physics?.unregister(entity);
  }

  /** Run `fn` after `seconds` of play (a death animation, then gone). */
  after(seconds, fn) {
    const s = Number(seconds) || 0;
    if (s <= 0) { fn(); return; }
    this._timers.push({ left: s, fn });
  }

  /**
   * Move an object to `to` ({ x, y, z }): straight there, or sliding over
   * `seconds`. A falling body is stopped, so it arrives where it was sent.
   * Sent again where it is already going (a rule run every frame, a held key),
   * it carries on — starting over, it would never get there.
   */
  moveTo(entity, to, seconds = 0) {
    const o = entity?.object3D;
    if (!o || !to) return;
    const s = Number(seconds) || 0;
    if (s > 0 && this._moves.some((m) => m.entity === entity && near(m.to, to))) return;
    this._moves = this._moves.filter((m) => m.entity !== entity); // a new move replaces one under way
    if (entity.rigidBody) entity.rigidBody.velocity?.set?.(0, 0, 0);
    if (s <= 0) o.position.set(to.x, to.y, to.z);
    else this._moves.push({ entity, from: o.position.clone(), to: { ...to }, t: 0, seconds: s });
  }

  /**
   * Turn an object: `to` a rotation (a quaternion — the short way round), or
   * `by` an `angle` (radians) about an `axis`, its own or the `world`'s. At once,
   * or eased over `seconds`. Turns by stack — a door clicked twice swings twice
   * as far — and a whole turn is a whole turn; a turn to replaces what is under
   * way, unless it is to where that one goes already.
   */
  turn(entity, { to = null, axis = null, angle = 0, world = false, pivot = null } = {}, seconds = 0) {
    const o = entity?.object3D;
    if (!o || (!to && !axis)) return;
    const s = Number(seconds) || 0;
    if (to && s > 0 && this._turns.some((m) => m.entity === entity && m.to && m.to.angleTo(to) < 1e-6)) return;
    // a new "to" wins over every turn under way; a new "by" over a "to"
    this._turns = this._turns.filter((m) => m.entity !== entity || (!to && !m.to));
    entity.rigidBody?.angularVelocity?.set?.(0, 0, 0);
    if (s <= 0) {
      if (to) { turnAround(o, to, pivot?.()); tidyRotation(o); } else turnBy(o, axis, angle, world, pivot?.());
      return;
    }
    // `pivot`: where it turns about, asked each frame (a moon's planet moves) — or its origin
    this._turns.push(to
      ? { entity, to: to.clone(), from: o.quaternion.clone(), pivot, t: 0, seconds: s }
      : { entity, axis: axis.clone(), angle, world, pivot, done: 0, t: 0, seconds: s });
  }

  /** Scale an object to `to` ({ x, y, z }): at once, or eased over `seconds` — from its origin, or `pivot()`. */
  resize(entity, to, seconds = 0, pivot = null) {
    const o = entity?.object3D;
    if (!o || !to) return;
    const s = Number(seconds) || 0;
    if (s > 0 && this._sizes.some((m) => m.entity === entity && near(m.to, to))) return; // on its way there already
    this._sizes = this._sizes.filter((m) => m.entity !== entity); // a new one takes over from where it is
    const goal = new THREE.Vector3(to.x, to.y, to.z);
    if (s <= 0) scaleAround(o, goal, pivot?.());
    else this._sizes.push({ entity, from: o.scale.clone(), to: goal, pivot, t: 0, seconds: s });
  }

  /** Where a resize under way will leave an object's scale — or its scale now. */
  sizeGoal(entity) {
    const m = this._sizes.find((r) => r.entity === entity);
    return (m ? m.to : entity.object3D.scale).clone();
  }

  _tick(dt) {
    if (this._timers.length) {
      const due = [];
      this._timers = this._timers.filter((t) => ((t.left -= dt) > 0 ? true : (due.push(t), false)));
      for (const t of due) {
        try { t.fn(); } catch (err) { console.error('[Tiny3] a timed action failed:', err); }
      }
    }
    this._moves = this._moves.filter((m) => {
      if (m.entity.alive === false) return false;
      m.t = Math.min(1, m.t + dt / m.seconds);
      const k = ease(m.t);
      const p = m.entity.object3D.position;
      p.set(m.from.x + (m.to.x - m.from.x) * k, m.from.y + (m.to.y - m.from.y) * k, m.from.z + (m.to.z - m.from.z) * k);
      if (m.entity.rigidBody) m.entity.rigidBody.velocity?.set?.(0, 0, 0);
      return m.t < 1;
    });
    this._turns = this._turns.filter((m) => {
      if (m.entity.alive === false) return false;
      m.t = Math.min(1, m.t + dt / m.seconds);
      const k = ease(m.t);
      const o = m.entity.object3D;
      if (m.to) { turnAround(o, _q.slerpQuaternions(m.from, m.to, k), m.pivot?.()); tidyRotation(o); } else {
        turnBy(o, m.axis, m.angle * (k - m.done), m.world, m.pivot?.()); // this frame's share: turns under way add up
        m.done = k;
      }
      m.entity.rigidBody?.angularVelocity?.set?.(0, 0, 0);
      return m.t < 1;
    });
    this._sizes = this._sizes.filter((m) => {
      if (m.entity.alive === false) return false;
      m.t = Math.min(1, m.t + dt / m.seconds);
      scaleAround(m.entity.object3D, _s.lerpVectors(m.from, m.to, ease(m.t)), m.pivot?.());
      return m.t < 1;
    });
  }

  /** Create a prefab instance. The editor/host wires `spawnPrefab`. */
  spawn(prefab, position) {
    if (typeof this.spawnPrefab !== 'function' || !prefab) return null;
    // the host places it (a model arrives later, and must still land here)
    const entity = this.spawnPrefab(prefab, position);
    if (entity && position) {
      entity.object3D.position.set(position.x, position.y, position.z);
    }
    return entity;
  }

  finish(result, message) {
    if (this.outcome) return; // first one wins; don't let a later rule overwrite it
    this.outcome = { result, message };
    this.onFinish?.(this.outcome);
  }

  restart() { this.onRestart?.(); }

  /**
   * Move to another level ('next', a name, 'this'…). It happens after the
   * current frame — rules and components are mid-loop right now — and
   * gameplay pauses until the new level has loaded.
   */
  goToLevel(target) {
    if (this.loading || this.outcome || typeof this.onGoToLevel !== 'function') return false;
    this.loading = true;
    const hook = this.onGoToLevel;
    Promise.resolve()
      .then(() => hook(String(target ?? 'next')))
      .catch((err) => console.error('[Tiny3] could not change level:', err))
      .finally(() => { this.loading = false; });
    return true;
  }

  /**
   * Called when play begins: reset state and run every start hook.
   * `keepVariables` is for arriving in a new level: the score carries over.
   */
  start({ keepVariables = false } = {}) {
    this.outcome = null;
    this._timers = [];
    this._moves = [];
    this._turns = [];
    this._sizes = [];
    forgetBounds(); // pivots on objects measured afresh
    this.startedAt = this.engine.time ?? 0; // "Play has run for" counts from here
    this._moved = new Set();
    this._movedBefore = new Set();
    this.engine.poses?.clear();
    // every object back to no state of its own (a Set state in a start rule gives it one), nothing sensed
    for (const e of this.engine.entities || []) { delete e.state; delete e.senses; }
    this.noises = [];
    this.engine.coverClaims?.clear();
    this.screens.reset(); // no menu or dialogue left up from before
    clearRagdolls(this.engine); // no character left limp from before
    this.engine.modules?.reset(); // script modules run afresh: their counters back to the start
    // a clip left looping by the editor's preview must not carry into the game
    for (const m of this.engine.mixers || []) m.reset?.();
    if (!keepVariables) this.engine.variables.reset();
    this.engine.physics.resetContacts();
    // the level as it begins: what a save compares with, and where things respawn
    this._levelStart = levelStart(this.engine);
    const player = this.engine.playerEntity;
    this._playerStart = player?.object3D ? poseOf(player.object3D) : null;
    this.checkpoint = null;
    this.controls.start();
    this.components.start(this.api);
    this.rules.start(this.api);
    // a Load game: its level has just loaded — now it is made as it was saved
    const load = this._pendingLoad;
    this._pendingLoad = null;
    if (load) applyState(this.engine, load);
  }

  /** One frame. Physics must have stepped already so contacts are current. */
  update(dt, time) {
    if (this.loading) return; // the next level is on its way
    const contacts = this.engine.physics.events;
    const P = this.engine.profiler; // the editor's Profiler, while it's open
    P?.begin('components');
    for (const contact of contacts) {
      this.components.dispatchContact(contact, time, this.api);
    }
    P?.end('components');
    P?.begin('controls');
    this.controls.update(dt, time, this.api);
    P?.end('controls');
    P?.begin('components');
    this.components.update(dt, time, this.api, P);
    P?.end('components');
    P?.begin('rules');
    this.rules.update(dt, time, contacts, this.api);
    P?.end('rules');
    // a noise is heard the moment it is made: kept long enough for every listener's next look
    if (this.noises.length) this.noises = this.noises.filter((n) => time - n.time < 0.5);
    this._brakeRuleMoves();
    this._tick(dt);
  }

  /** A rule's Move sets a body's speed each frame it runs: the frame it doesn't, it stops (as a let-go key does). */
  markMoved(entity) { (this._moved ??= new Set()).add(entity); }

  _brakeRuleMoves() {
    const before = this._movedBefore ?? new Set();
    const now = this._moved ?? new Set();
    for (const e of before) {
      if (now.has(e)) continue;
      const v = e.rigidBody?.velocity;
      if (v) { v.x = 0; v.z = 0; }
    }
    this._movedBefore = now;
    this._moved = new Set();
  }

  /** Drop everything — used when a scene is wiped or reloaded. The loader sets the controls. */
  clear() {
    this.screens.reset();
    clearRagdolls(this.engine);
    this.components.clear();
    this.rules.clear();
    this.controls.reset();
    this.engine.poses?.clear();
    this.outcome = null;
    this._timers = [];
    this._moves = [];
    this._turns = [];
    this._sizes = [];
  }
}
