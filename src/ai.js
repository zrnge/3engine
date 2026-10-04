/**
 * AI: what an object senses, and an enemy that acts on it.
 *
 * Senses — it sees in a cone in front of it, as far as it looks, never through
 * a wall (a ray to the head and the middle of what it looks for); it notices
 * what is right beside it whichever way it faces; it hears noises (shots,
 * shouts, a Make a noise action — each as far as it is loud) and footsteps;
 * it remembers where it last saw or heard something for a while. What it
 * senses is on `entity.senses`, and its "I see someone", "I lose sight of
 * someone" and "I hear something" rules run.
 *
 * Enemy AI — a state machine on those senses, its states the object's own
 * (Set state, State is, I enter a state):
 *   patrolling / guarding → chasing → attacking → searching → back again,
 *   and taking cover when hurt. Seeing someone first, it calls the others
 *   near it (an alert: a noise they hear, about where it saw them).
 * A rule that sets any other state (stunned, talking, dead) takes it over:
 * it stands still until a rule hands it back (Set state: patrolling).
 */
import * as THREE from 'three';
import { yawOf, setYaw, wrapAngle } from './heading.js';
import { walkTowards, halt, nextStop, patrolPoints, patrolStep } from './walking.js';
import { AnimationPlayer } from './animation.js';

const DEG = Math.PI / 180;
const LOOK_EVERY = 0.1;     // s: each looks ten times a second, not all on the same frame
const MOVING = 0.5;         // m/s: footsteps of anything moving
const RUNNING = 4;          // m/s: footsteps of a runner
const FOOTSTEPS_EVERY = 1;  // s: footsteps heard again is a new "I hear something"
const LOOK_AT_MOST = 4;     // of many it looks for (a group), the nearest few
const REACH_SLACK = 0.6;    // m: once attacking, how far past its reach it keeps attacking
const TURN_RATE = 300 * Math.PI / 180; // rad/s: an enemy turns to look, it doesn't snap round

export const NOISE_KINDS = ['a noise', 'footsteps', 'a shot', 'an alert', 'a hit'];
/** The states an Enemy AI sets itself: any other is a rule's, and it waits for it to end. */
export const AI_STATES = ['patrolling', 'guarding', 'chasing', 'attacking', 'searching', 'taking cover'];

export const SENSE_DEFAULTS = { who: 'player', sight: 15, fov: 120, feel: 1, hears: true, footsteps: 'when running', stepsWithin: 8, memory: 4 };

const SENSE_PROPS = {
  who: { type: 'who', default: 'player', label: 'Looks for' },
  sight: { type: 'number', default: 15, min: 0, max: 500, step: 0.5, label: 'Sees as far as (m)', redraw: true },
  fov: { type: 'number', default: 120, min: 1, max: 360, step: 5, label: 'Field of view (°)', redraw: true },
  feel: { type: 'number', default: 1, min: 0, max: 20, step: 0.1, label: 'Notices within (m), any way', redraw: true },
  hears: { type: 'boolean', default: true, label: 'Hears noises' },
  footsteps: { type: 'select', options: ['when running', 'when moving', 'never'], default: 'when running', label: 'Hears footsteps', redraw: true },
  stepsWithin: { type: 'number', default: 8, min: 0, max: 100, step: 0.5, label: 'Footsteps within (m)', redraw: true, showIf: { footsteps: ['when running', 'when moving'] } },
  memory: { type: 'number', default: 4, min: 0, max: 120, step: 0.5, label: 'Remembers for (s)' },
};

// ---------------------------------------------------------------- seeing

const _box = new THREE.Box3();
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _pos = new THREE.Vector3();

/** Is `e` (a body, a part of one) `who`, or within it? */
function belongs(e, who) {
  if (!e || !who) return false;
  if (e === who || e.owner === who) return true;
  for (let n = e.object3D; n; n = n.parent) if (n === who.object3D) return true;
  return false;
}

/** Where it looks from: near the top of it (its eyes), or where it is. */
export function eyeOf(entity, out = new THREE.Vector3()) {
  const o = entity.object3D;
  _box.setFromObject(o);
  if (_box.isEmpty()) return o.getWorldPosition(out);
  _box.getCenter(out);
  out.y = _box.max.y - Math.min(0.15, (_box.max.y - _box.min.y) * 0.1);
  return out;
}

/** Where it is looked at: its head and its middle. */
function aimPoints(target) {
  _box.setFromObject(target.object3D);
  if (_box.isEmpty()) return [target.object3D.getWorldPosition(_a)];
  _box.getCenter(_b);
  _a.copy(_b);
  _a.y = _box.max.y - (_box.max.y - _box.min.y) * 0.1;
  return [_a, _b];
}

/** Nothing solid between `from` and `to`, but what is `target`'s (null: nothing at all in the way). */
export function clearLine(engine, from, to, viewer, target = null) {
  _dir.subVectors(to, from);
  const dist = _dir.length();
  if (dist < 1e-3 || !engine.physics?.raycast) return true;
  const skip = (e) => belongs(e, viewer) || !!e.viewModel;
  const hit = engine.physics.raycast(from, _dir, dist, { skip });
  return !hit || hit.distance >= dist - 0.05 || (target && belongs(hit.entity, target));
}

/**
 * Can `viewer` see `target`? In its field of view and as far as it sees
 * (or within `feel` of it, any way it faces), with nothing solid between.
 */
export function canSee(engine, viewer, target, { sight = 15, fov = 120, feel = 1 } = {}) {
  const t = target?.object3D;
  if (!t || target === viewer || target.alive === false || !t.parent) return false;
  // hidden (Show or hide, a Health's "hide") is out of sight — but the player is there even when its body isn't
  // drawn (first person, or no model of its own)
  if (t.visible === false && target !== engine.playerEntity) return false;
  if (!(sight > 0) && !(feel > 0)) return false;
  const eye = eyeOf(viewer, _eye);
  const [head, middle = head] = aimPoints(target);
  const flat = Math.hypot(middle.x - eye.x, middle.z - eye.z);
  const near = flat <= (Number(feel) || 0);
  if (!near) {
    if (Math.min(eye.distanceTo(head), eye.distanceTo(middle)) > sight) return false;
    if (fov < 360 && flat > 1e-4) {
      const yaw = yawOf(viewer.object3D);
      const cos = ((middle.x - eye.x) * Math.sin(yaw) + (middle.z - eye.z) * Math.cos(yaw)) / flat;
      if (cos < Math.cos((fov / 2) * DEG)) return false;
    }
  }
  const points = head === middle ? [head] : [head.clone(), middle.clone()];
  return points.some((p) => clearLine(engine, eye, p, viewer, target));
}

/** How fast it moves across the ground: its body's speed, or how far it went since last asked. */
function speedOf(target, memo, dt) {
  const body = target.rigidBody;
  if (body?.type === 'dynamic') return Math.hypot(body.velocity.x, body.velocity.z);
  const p = target.object3D.getWorldPosition(_pos);
  const last = memo.get(target);
  memo.set(target, p.clone());
  return last && dt > 0 ? Math.hypot(p.x - last.x, p.z - last.z) / dt : 0;
}

// ---------------------------------------------------------------- sensing

/**
 * Look and listen (ten times a second): who it sees now, where it last saw
 * someone, the last thing it heard. Runs "I see someone", "I lose sight of
 * someone" and "I hear something" as they happen. Returns entity.senses.
 */
export function sense(ctx, props = SENSE_DEFAULTS, state = ctx.state) {
  const { entity, engine, api, dt, time } = ctx;
  const s = entity.senses ??= { sees: null, lastSeen: null, heard: null, props };
  s.props = props;
  state.lookIn = (state.lookIn ?? Math.random() * LOOK_EVERY) - dt;
  if (state.lookIn > 0) return s;
  const since = Math.max(LOOK_EVERY, LOOK_EVERY - state.lookIn); // time since it last looked
  state.lookIn = LOOK_EVERY;
  const rules = engine.gameplay?.rules;
  const run = (type, other, accept) => rules?.on(type, entity, other, api, time, accept);

  const candidates = (api?.resolveAll(props.who || 'player', entity, null) || [])
    .filter((e) => e !== entity && e.alive !== false && e.object3D?.parent)
    .slice(0, LOOK_AT_MOST);

  // seeing
  let seen = null;
  for (const c of candidates) {
    if (canSee(engine, entity, c, props)) { seen = c; break; }
  }
  const was = s.sees;
  s.sees = seen;
  if (seen) s.lastSeen = { at: seen.object3D.getWorldPosition(new THREE.Vector3()), time, who: seen };
  if (seen && seen !== was) run('sees', seen);
  if (was && seen !== was) run('losesSight', was);

  // hearing: noises made since it last listened, as far as each is loud
  const me = entity.object3D.getWorldPosition(_pos).clone();
  const hear = (heard) => {
    s.heard = heard;
    run('hears', heard.by, (when) => !when.kind || when.kind === 'anything' || when.kind === heard.kind);
  };
  if (props.hears !== false) {
    for (const n of engine.gameplay?.noises || []) {
      if (n.id <= (state.noiseId ?? -1)) continue;
      if (n.by && belongs(n.by, entity)) continue; // its own
      if (me.distanceTo(n.at) > n.loud) continue;
      hear({ at: (n.about ?? n.at).clone(), time, kind: n.kind, by: n.by ?? null });
    }
  }
  state.noiseId = engine.gameplay?.noiseId ?? state.noiseId;
  // footsteps: of those it looks for, near enough and fast enough — and not in sight
  if (props.footsteps !== 'never' && Number(props.stepsWithin) > 0) {
    const memo = state.steps ??= new Map();
    const fast = props.footsteps === 'when moving' ? MOVING : RUNNING;
    for (const c of candidates) {
      const v = speedOf(c, memo, since);
      if (c === seen || v < fast) continue;
      const at = c.object3D.getWorldPosition(new THREE.Vector3());
      if (at.distanceTo(me) > Number(props.stepsWithin)) continue;
      const again = s.heard?.kind === 'footsteps' && s.heard.by === c && time - s.heard.time < FOOTSTEPS_EVERY;
      if (again) s.heard = { ...s.heard, at };
      else hear({ at, time, kind: 'footsteps', by: c });
      break;
    }
  }
  return s;
}

// ---------------------------------------------------------------- the enemy

/** Its Health: { current, max }, or null. */
function healthOf(engine, entity) {
  const h = engine.gameplay?.components.listFor(entity).find((c) => c.type === 'health');
  if (!h) return null;
  return { current: h.state.current ?? h.props.max, max: h.props.max || 1 };
}

/** The nearest free spot of the cover group out of `threat`'s sight (or just the nearest, with no threat known). */
function findCover(ctx, group, threat) {
  const { engine, entity } = ctx;
  const claims = engine.coverClaims ??= new Map();
  const me = entity.object3D.getWorldPosition(new THREE.Vector3());
  const from = threat?.object3D ? eyeOf(threat, new THREE.Vector3()) : null;
  const spots = patrolPoints(ctx, group)
    .filter((p) => !claims.has(p) || claims.get(p) === entity)
    .map((p) => ({ p, at: p.getWorldPosition(new THREE.Vector3()) }))
    .sort((x, y) => x.at.distanceTo(me) - y.at.distanceTo(me));
  for (const { p, at } of spots) {
    if (!from) return p;
    // crouched there: is the way from the threat's eyes blocked?
    const low = at.clone().setY(at.y + 0.6);
    if (!clearLine(engine, from, low, threat, null)) return p;
  }
  return null;
}

function attack(ctx, target) {
  const { engine, entity, props, api, time } = ctx;
  if (props.clip) AnimationPlayer.for(engine, entity.object3D).play(props.clip, { mode: 'once', interrupt: true });
  const damage = Number(props.damage) || 0;
  if (props.attack === 'shoots') {
    if (props.sound) engine.playSound?.(entity, props.sound);
    api.makeNoise?.(entity.object3D.getWorldPosition(new THREE.Vector3()), { loud: 30, kind: 'a shot', by: entity });
    const hits = Math.random() * 100 < Number(props.accuracy ?? 75);
    ctx.state.shots = (ctx.state.shots ?? 0) + 1;
    if (!hits) return;
    if (damage > 0) api.damage(target, damage, entity);
    const toMe = target.object3D.getWorldPosition(new THREE.Vector3()).sub(entity.object3D.getWorldPosition(_pos));
    api.hit?.(target, { other: entity, by: entity, kind: 'a shot', speed: null, toMe }, time);
  } else {
    api.attack?.(entity, {
      aim: 'in front', reach: (Number(props.reach) || 1.5) + REACH_SLACK + 0.2, arc: 120,
      hits: entity.senses?.props?.who || 'player', damage, push: 2, sound: props.sound || '',
    });
  }
}

const ENEMY_PROPS = {
  points: { type: 'text', default: '', label: 'Patrols (a group, or names)', hint: 'Empty: it stands guard where it starts' },
  walk: { type: 'number', default: 1.5, min: 0, max: 30, step: 0.1, label: 'Walks at (m/s)' },
  run: { type: 'number', default: 3.5, min: 0, max: 30, step: 0.1, label: 'Runs at (m/s)' },
  wait: { type: 'number', default: 1, min: 0, max: 60, step: 0.1, label: 'Waits at each point (s)' },
  attack: { type: 'select', options: ['hits', 'shoots', 'nothing'], default: 'hits', label: 'Attacks by', hint: 'Nothing: rules do it (I enter a state: attacking)' },
  reach: { type: 'number', default: 1.5, min: 0, max: 200, step: 0.1, label: 'Attacks within (m)', showIf: { attack: ['hits', 'shoots'] } },
  damage: { type: 'number', default: 1, min: 0, max: 10000, step: 1, label: 'Damage', showIf: { attack: ['hits', 'shoots'] } },
  every: { type: 'number', default: 1, min: 0.05, max: 60, step: 0.05, label: 'Attacks every (s)', showIf: { attack: ['hits', 'shoots'] } },
  accuracy: { type: 'number', default: 75, min: 0, max: 100, step: 5, label: 'Shots that hit (%)', showIf: { attack: ['shoots'] } },
  clip: { type: 'clip', default: '', label: 'Attack animation', showIf: { attack: ['hits', 'shoots'] } },
  sound: { type: 'sound', default: '', label: 'Attack sound', showIf: { attack: ['hits', 'shoots'] } },
  search: { type: 'number', default: 6, min: 0, max: 120, step: 0.5, label: 'Searches for (s)' },
  alert: { type: 'number', default: 15, min: 0, max: 500, step: 1, label: 'Calls others within (m)' },
  cover: { type: 'text', default: '', label: 'Takes cover at (a group)' },
  coverBelow: { type: 'number', default: 50, min: 0, max: 100, step: 5, label: 'Takes cover below health (%)' },
  coverFor: { type: 'number', default: 4, min: 0, max: 120, step: 0.5, label: 'Stays in cover (s)' },
  avoid: { type: 'boolean', default: true, label: 'Find a way round walls' },
};

function enemyUpdate(ctx) {
  const o = ctx.entity.object3D;
  if (!o.parent || ctx.entity.alive === false) return;
  const was = yawOf(o);
  think(ctx);
  // however it was told to face, it turns there at its pace
  const step = TURN_RATE * (ctx.dt || 0);
  const turn = wrapAngle(yawOf(o) - was);
  if (Math.abs(turn) > step) setYaw(o, was + Math.sign(turn) * step);
}

function think(ctx) {
  const { entity, props, state, engine, api, dt, time } = ctx;
  const o = entity.object3D;
  // a rule's state (stunned, talking, dead…): it waits for the rule to hand it back
  if (entity.state && !AI_STATES.includes(entity.state)) { halt(entity); return; }
  const hp = healthOf(engine, entity);
  if (hp && hp.current <= 0) { halt(entity); return; }
  // its senses: a Senses component's, or the usual ones
  state.ownSenses ??= !!engine.gameplay?.components.listFor(entity).some((c) => c.type === 'senses');
  const s = state.ownSenses ? (entity.senses ?? { sees: null }) : sense(ctx, SENSE_DEFAULTS, state.senses ??= {});
  const memory = Number(s.props?.memory ?? SENSE_DEFAULTS.memory);
  const set = (st) => {
    if (entity.state === st) return;
    if (api.setState) api.setState(entity, st); // its "I enter a state" rules run
    else entity.state = st;
  };
  const go = (point, speed) => walkTowards(ctx, props.avoid ? nextStop(ctx, point) : point, speed);
  const here = o.getWorldPosition(new THREE.Vector3());
  state.home ??= { at: here.clone(), yaw: yawOf(o) };
  const target = s.sees;

  // hurt enough: to cover, once each time it is hurt below the mark
  if (!state.cover && props.cover && Number(props.coverBelow) > 0 && hp
    && (hp.current / hp.max) * 100 <= Number(props.coverBelow) && hp.current < (state.coverHp ?? Infinity)) {
    const threat = target ?? s.lastSeen?.who ?? s.heard?.by ?? null;
    const spot = findCover(ctx, props.cover, threat);
    state.coverHp = hp.current;
    if (spot) {
      state.cover = { spot, until: null, threat };
      (engine.coverClaims ??= new Map()).set(spot, entity);
    }
  }
  if (state.cover) {
    set('taking cover');
    const c = state.cover;
    const at = c.spot.getWorldPosition(new THREE.Vector3());
    if (c.until === null) {
      if (Math.hypot(at.x - here.x, at.z - here.z) > 0.4) { go(at, props.run); return; }
      c.until = time + (Number(props.coverFor) || 0);
    }
    halt(entity);
    const threat = target ?? c.threat;
    if (threat?.object3D) { const t = threat.object3D.getWorldPosition(_pos); setYaw(o, Math.atan2(t.x - here.x, t.z - here.z)); }
    if (time >= c.until) {
      engine.coverClaims?.delete(c.spot);
      state.cover = null;
    }
    return;
  }

  if (target) {
    state.search = null;
    const t = target.object3D.getWorldPosition(new THREE.Vector3());
    // first sight: it calls the others near it, about where it saw them
    if (entity.state !== 'chasing' && entity.state !== 'attacking' && Number(props.alert) > 0) {
      api.makeNoise?.(here, { loud: Number(props.alert), kind: 'an alert', by: entity, about: t });
    }
    _box.setFromObject(target.object3D);
    const d = _box.isEmpty() ? Math.hypot(t.x - here.x, t.z - here.z) : Math.max(0, _box.distanceToPoint(here.clone().setY(t.y)));
    // attacking, it keeps at it until they are clearly out of reach (a hit knocks them back a little)
    const reach = Number(props.reach) + (entity.state === 'attacking' ? REACH_SLACK : 0);
    if (props.attack !== 'nothing' && d <= reach) {
      set('attacking');
      halt(entity);
      setYaw(o, Math.atan2(t.x - here.x, t.z - here.z));
      if (time >= (state.nextAttack ?? 0)) {
        state.nextAttack = time + Math.max(0.05, Number(props.every) || 1);
        attack(ctx, target);
      }
    } else {
      set('chasing');
      go(t, props.run);
    }
    return;
  }

  // out of sight: where it last saw them, or what it heard — whichever is newer, and still remembered
  const recent = (m) => (m && time - m.time <= memory ? m : null);
  const lead = [recent(s.lastSeen), recent(s.heard)].filter(Boolean).sort((a, b) => b.time - a.time)[0];
  if (lead && (!state.search || lead.time > state.search.since + 0.5)) {
    state.search = { at: lead.at.clone(), since: lead.time, arrived: null, fast: lead === s.lastSeen || lead.kind === 'an alert' || lead.kind === 'a shot' || lead.kind === 'a hit' };
  }
  if (state.search) {
    set('searching');
    const q = state.search;
    if (q.arrived === null) {
      // there, or as near as it can get (no nearer for a while: near enough)
      const far = Math.hypot(q.at.x - here.x, q.at.z - here.z);
      if (far < (q.best ?? Infinity) - 0.05) { q.best = far; q.stuck = 0; } else q.stuck = (q.stuck ?? 0) + dt;
      if (far > 0.6 && q.stuck < 1.5) { go(q.at, q.fast ? props.run : props.walk); return; }
      q.arrived = time;
      q.yaw = yawOf(o);
    }
    // there: it looks about, then gives up
    halt(entity);
    const t = time - q.arrived;
    setYaw(o, q.yaw + Math.sin(t * 1.6) * 1.2);
    if (t >= (Number(props.search) || 0)) {
      state.search = null;
      s.lastSeen = null;
      s.heard = null;
      state.goal = null;
    }
    return;
  }

  // nothing going on: its round, or its post
  const points = props.points ? patrolPoints(ctx, props.points) : [];
  if (points.length) {
    set('patrolling');
    patrolStep(ctx, points, { speed: props.walk, wait: props.wait, avoid: props.avoid });
    return;
  }
  set('guarding');
  const home = state.home;
  if (Math.hypot(home.at.x - here.x, home.at.z - here.z) > 0.4) { go(home.at, props.walk); return; }
  halt(entity);
  setYaw(o, home.yaw);
}

/** The AI components, part of COMPONENTS. */
export const AI_COMPONENTS = {
  senses: {
    label: 'Senses (sees and hears)',
    hint: 'What it notices: what it looks for (the player, a group, an object) in front of it within its field of view and as far '
      + 'as it sees — never through a wall — and anything right beside it, whichever way it faces. It hears noises (shots, an alert, '
      + 'a Make a noise action) as far as each is loud, and footsteps of what it looks for. It remembers where for a while. '
      + 'Its rules: "I see someone", "I lose sight of someone", "I hear something"; and the conditions "I can see", "I heard something". '
      + 'An Enemy AI on the same object uses these senses (without them, it has the usual ones).',
    props: SENSE_PROPS,
    update(ctx) { sense(ctx, ctx.props); },
    dispose({ entity }) { delete entity.senses; },
  },
  enemyAI: {
    label: 'Enemy AI',
    hint: 'A guard, a monster, a soldier. It patrols its points (or stands guard where it starts), chases what it sees, attacks it '
      + 'within reach (hits, or shoots: a share of its shots hit), and when it loses them, searches where it last saw them or heard '
      + 'something, then goes back. Seeing someone first, it calls the others within "Calls others within" — they come to look. '
      + 'Hurt below "Takes cover below health", it runs to the nearest point of its cover group out of sight, and stays a while. '
      + 'Its state is what it is doing — patrolling, guarding, chasing, attacking, searching, taking cover — for "I enter a state" '
      + 'and "State is" rules. A rule that sets another state (stunned, talking) stops it until a rule sets one of these again. '
      + 'Add Senses to change how it sees and hears.',
    props: ENEMY_PROPS,
    update: enemyUpdate,
    dispose({ engine, entity }) {
      for (const [spot, who] of engine.coverClaims || []) if (who === entity) engine.coverClaims.delete(spot);
    },
  },
};
