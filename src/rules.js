import * as THREE from 'three';
import { compare, COMPARE_OPS } from './variables.js';
import { valueOf, formatText, run as runExpr, truthy, varScope, problemIn } from './expr.js';
import { AnimationPlayer } from './animation.js';
import { matchesWho } from './groups.js';
import { canSee, NOISE_KINDS, SENSE_DEFAULTS } from './ai.js';
import { pushFrom } from './components.js';
import { turnYaw, tidyRotation, yawOf } from './heading.js';
import { pivotProps, pivotPoint, pivotOffset, turnAround, scaleAround } from './pivot.js';

/**
 * Rules — "When <something happens>, if <condition>, do <these things>."
 *
 * This is the layer that lets someone build a game without writing code. A rule
 * belongs to an object and is stored as plain data, so the inspector can render
 * it as three dropdowns and the serializer can save it:
 *
 *   { when: { type: 'triggerEnter', who: 'player' },
 *     if:   [{ type: 'variable', name: 'keys', op: '>=', value: 1 },
 *            { type: 'onGround', who: 'player', join: 'or', not: true }],  // … OR NOT on the ground
 *     do:   [{ type: 'changeVariable', name: 'score', by: 10 },
 *            { type: 'destroy', target: 'self' }],
 *     else: [{ type: 'showMessage', text: 'Locked' }] }   // when the conditions don't hold
 *
 * Between each condition and the one before it: AND or OR (`join`), and each
 * may be turned round (`not`) — AND, OR, AND NOT, OR NOT. AND binds first:
 * "A and B or C" is (A and B) or C. The conditions are shared with the
 * controls ("Only if", controls.js): see conditionsPass.
 */

const MOUSE = ['left', 'middle', 'right']; // DOM button numbers 0, 1, 2

/** Event types a rule can listen for, with the props the UI should offer. *//**
 * Where on me it happened: anywhere (''), or at one of my parts with an own box
 * or trigger zone of its own (a model's door zone, a target's bullseye — see
 * physics-parts.js).
 */
const AT_PART = Object.freeze({ type: 'part', default: '', label: 'At part' });
/** Which side of me something came from ("Something hits me"): as I face. */
export const HIT_FROM = ['anywhere', 'above', 'below', 'the front', 'behind', 'a side'];
/**
 * What hit me ("Something hits me"):
 *   a shot            — an instant-hit shot, or a prefab fired by Shoot prefab
 *   something thrown  — a prefab Shoot prefab "throws", or an object a Push / launch sent flying
 *   a vehicle         — a car (or any vehicle) driven into me
 *   an attack         — a Hit / attack: a punch, a sword, a kick (a key, a click, a screen button, a rule)
 *   a moving object   — anything else moving into me: a falling crate, a rolling ball, a closing door, someone walking
 */
export const HIT_WITH = ['anything', 'a shot', 'something thrown', 'a vehicle', 'an attack', 'a moving object'];
/** How long something launched by Push / launch counts as thrown (s). */
const THROWN_FOR = 3;
/** The same thing hitting me again sooner than this (s) is the same hit (touching on and off). */
const REHIT_AFTER = 0.25;


export const EVENTS = {
  start: { label: 'Play starts', props: {} },
  update: {
    label: 'Every N seconds (0: every frame)',
    props: { every: { type: 'number', default: 1, min: 0, max: 600, step: 0.1, label: 'Seconds' } },
  },
  key: {
    label: 'Key / pad button',
    props: {
      code: { type: 'key', default: 'Space', label: 'Key' },
      mode: { type: 'select', options: ['pressed', 'held', 'released'], default: 'pressed', label: 'When it is' },
    },
  },
  mouse: {
    label: 'Mouse button',
    // anywhere on the screen; "I'm clicked" is for clicking an object
    props: {
      button: { type: 'select', options: MOUSE, default: 'left', label: 'Button' },
      mode: { type: 'select', options: ['pressed', 'held', 'released'], default: 'pressed', label: 'When it is' },
    },
  },
  clicked: {
    label: 'I\'m clicked / tapped',
    // the object under the pointer (or the middle of the view, the mouse captured); "other" is the player
    props: { button: { type: 'select', options: MOUSE, default: 'left', label: 'Button' } },
  },
  triggerEnter: {
    label: 'Something enters me',
    props: { who: { type: 'who', default: 'player', label: 'Who' }, part: AT_PART },
  },
  triggerExit: {
    label: 'Something leaves me',
    props: { who: { type: 'who', default: 'player', label: 'Who' }, part: AT_PART },
  },
  collision: {
    label: 'I bump into something',
    props: { who: { type: 'who', default: 'any', label: 'What' }, part: AT_PART },
  },
  hitBy: {
    label: 'Something hits me',
    // it moves into me — thrown, falling, running, driven, swung — not me into it
    // (that is "I bump into something"); "other" is what hit me
    props: {
      with: {
        type: 'select', options: HIT_WITH, default: 'anything', label: 'With',
        hint: 'A shot (an instant hit, or a fired prefab) · something thrown (a prefab thrown with Shoot prefab, or launched by Push / launch) · '
          + 'a vehicle driven into me · an attack (the Hit / attack action: on a key, a click, a screen button, or in a rule) · '
          + 'a moving object (anything else moving into me: a falling crate, a closing door, someone running).',
      },
      who: { type: 'who', default: 'any', label: 'What', hint: 'The thing that hit me: the bullet or rock, the car, the one who punched.' },
      by: { type: 'who', default: 'any', label: 'Done by', hint: 'Who did it: the shooter, the thrower, the attacker, the driver (the car itself), or what moved by itself.' },
      harder: {
        type: 'number', default: 1, min: 0, max: 300, step: 0.5, label: 'Harder than (m/s)',
        hint: 'How fast it came at me. 0: any touch it moves into. A walk is about 5, a sprint 8, a thrown ball 10–20. '
          + 'An instant-hit shot and an attack always count (they have no speed).',
      },
      from: {
        type: 'select', options: HIT_FROM, default: 'anywhere', label: 'From',
        hint: 'Which side of me it came from, as I face: above (landed on, stomped), below, the front, behind, a side.',
      },
      speedTo: {
        type: 'text', default: '', label: 'Its speed into variable',
        hint: 'Optional: a variable set to how fast it hit (m/s) before the actions run — damage by how hard, a louder thump.',
      },
      part: AT_PART,
    },
  },
  interact: {
    label: 'Someone interacts with me',
    props: {
      who: { type: 'who', default: 'player', label: 'Who' },
      prompt: { type: 'text', default: 'Interact', label: 'Prompt' },
    },
  },
  shot: {
    label: 'I\'m shot',
    // by an instant-hit shot (the "Shoot (instant hit)" control); "other" is the shooter
    props: { who: { type: 'who', default: 'player', label: 'By' } },
  },
  hurt: {
    label: 'I\'m hurt (lose health)',
    // any damage to my Health: a shot, a Damager, a Damage action; "other" is who did it, when known
    props: { who: { type: 'who', default: 'any', label: 'By' } },
  },
  crash: {
    label: 'I crash (a vehicle)',
    // a car hitting a wall, another car, the ground after a jump; "other" is what it hit
    props: {
      who: { type: 'who', default: 'any', label: 'Into' },
      harder: { type: 'number', default: 20, min: 0, max: 500, step: 5, label: 'Harder than (km/h)' },
    },
  },
  healthOut: {
    label: 'My health runs out',
    // the damage that takes my Health to 0; "other" is who did it, when known
    props: { who: { type: 'who', default: 'any', label: 'By' } },
  },
  variable: {
    label: 'Variable becomes',
    props: {
      name: { type: 'text', default: 'score', label: 'Variable' },
      op: { type: 'select', options: COMPARE_OPS, default: '>=', label: 'Is' },
      value: { type: 'text', default: '10', label: 'Value', hint: 'A number, true / false, text (with {an expression} in it), a list [a, b] — or = and an expression: =score + 10, =len(inventory)' },
    },
  },
  event: {
    label: 'I receive an event',
    // sent by a Send event action — another object's, or its own (later: a timer); "other" is who sent it
    props: { name: { type: 'text', default: 'alarm', label: 'Event', hint: 'Any name: what a Send event action calls it' } },
  },
  stateEnter: {
    label: 'I enter a state',
    // a Set state action changed its state to this one (patrolling, chasing, open, on fire…)
    props: { state: { type: 'text', default: 'chasing', label: 'State' } },
  },
  uiButton: {
    label: 'A button is pressed (on a screen)',
    // a button on one of the game's screens (Screens panel); empty: any screen, any button
    props: {
      screen: { type: 'screen', default: '', label: 'Screen' },
      button: { type: 'text', default: '', label: 'Button', hint: 'Its label, as on the screen — empty: any of its buttons' },
    },
  },
  uiPick: {
    label: 'An item is picked (on a screen)',
    // a tile of a list on a screen clicked (an inventory): its value is in the list's "Picked into" variable
    props: {
      screen: { type: 'screen', default: '', label: 'Screen' },
      list: { type: 'text', default: 'inventory', label: 'List', hint: 'The variable the list shows — empty: any list' },
    },
  },
  dialogueEnd: {
    label: 'A dialogue ends',
    props: { dialogue: { type: 'dialogue', default: '', label: 'Dialogue' } },
  },
  jointBreaks: {
    label: 'A joint breaks',
    // one of its Joints pulled harder than its "Breaks at": "other" is what it was joined to
    props: { who: { type: 'who', default: 'any', label: 'Joined to' } },
  },
  sees: {
    label: 'I see someone',
    // its Senses (or an Enemy AI's) catch sight of who it looks for; "other" is who
    props: { who: { type: 'who', default: 'player', label: 'Who' } },
  },
  losesSight: {
    label: 'I lose sight of someone',
    // out of its view, behind a wall, too far; "other" is who
    props: { who: { type: 'who', default: 'player', label: 'Who' } },
  },
  hears: {
    label: 'I hear something',
    // a noise within as far as it is loud (a shot, an alert, Make a noise), footsteps, or a hit from out of sight; "other" made it
    props: {
      kind: { type: 'select', options: ['anything', ...NOISE_KINDS], default: 'anything', label: 'What' },
      who: { type: 'who', default: 'any', label: 'Made by' },
    },
  },
};

/** Actions a rule can perform. */
export const ACTIONS = {
  setVariable: {
    label: 'Set variable',
    props: {
      name: { type: 'text', default: 'score', label: 'Variable' },
      value: { type: 'text', default: '0', label: 'To', hint: 'A number, true / false, text (with {an expression} in it), a list [a, b] — or = and an expression: =score + 10, =len(inventory)' },
    },
    run({ action, vars }) { vars.set(action.name, valueOf(action.value, varScope(vars))); },
  },
  changeVariable: {
    label: 'Change variable by',
    props: {
      name: { type: 'text', default: 'score', label: 'Variable' },
      by: { type: 'text', default: '1', label: 'By', hint: 'A number (−1 to take one away) — or =an expression. A list: this is added to it; text: added at its end' },
    },
    run({ action, vars }) {
      const by = valueOf(action.by, varScope(vars));
      const now = vars.get(action.name, 0);
      if (Array.isArray(now)) vars.set(action.name, [...now, by]);
      else if (typeof now === 'string' && typeof by === 'string') vars.set(action.name, now + by);
      else vars.change(action.name, by);
    },
  },
  listAdd: {
    label: 'Add to a list',
    // an inventory, a quest log, the keys found: a variable holding a list
    props: {
      name: { type: 'text', default: 'inventory', label: 'List' },
      value: { type: 'text', default: 'key', label: 'Add', hint: 'A number, true / false, text (with {an expression} in it), a list [a, b] — or = and an expression: =score + 10, =len(inventory)' },
      where: { type: 'select', options: ['at the end', 'at the start'], default: 'at the end', label: 'Where' },
      unique: { type: 'boolean', default: false, label: 'Not if it is there already' },
    },
    run({ action, vars }) {
      const v = valueOf(action.value, varScope(vars));
      const list = listOf(vars.get(action.name, []));
      if (action.unique && list.some((x) => JSON.stringify(x) === JSON.stringify(v))) return;
      vars.set(action.name, action.where === 'at the start' ? [v, ...list] : [...list, v]);
    },
  },
  listRemove: {
    label: 'Remove from a list',
    props: {
      name: { type: 'text', default: 'inventory', label: 'List' },
      which: { type: 'select', options: ['this value', 'every one of this value', 'the first', 'the last', 'everything'], default: 'this value', label: 'Remove', redraw: true },
      value: { type: 'text', default: 'key', label: 'Value', hint: 'A number, true / false, text (with {an expression} in it), a list [a, b] — or = and an expression: =score + 10, =len(inventory)', showIf: { which: ['this value', 'every one of this value'] } },
    },
    run({ action, vars }) {
      const list = listOf(vars.get(action.name, []));
      const v = valueOf(action.value, varScope(vars));
      const same = (x) => JSON.stringify(x) === JSON.stringify(v);
      let next = list;
      if (action.which === 'the first') next = list.slice(1);
      else if (action.which === 'the last') next = list.slice(0, -1);
      else if (action.which === 'everything') next = [];
      else if (action.which === 'every one of this value') next = list.filter((x) => !same(x));
      else {
        const i = list.findIndex(same);
        next = i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
      }
      vars.set(action.name, next);
    },
  },
  setField: {
    label: 'Set a field of a record',
    // a record: a variable holding named values — quest = {stage: 2, giver: "Gran"}
    props: {
      name: { type: 'text', default: 'quest', label: 'Record' },
      field: { type: 'text', default: 'stage', label: 'Field' },
      value: { type: 'text', default: '1', label: 'To', hint: 'A number, true / false, text (with {an expression} in it), a list [a, b] — or = and an expression: =score + 10, =len(inventory)' },
    },
    run({ action, vars }) {
      const now = vars.get(action.name, {});
      const record = now && typeof now === 'object' && !Array.isArray(now) ? now : {};
      vars.set(action.name, { ...record, [String(action.field)]: valueOf(action.value, varScope(vars)) });
    },
  },
  wait: {
    label: 'Wait',
    // the actions after it in this rule happen this much later (Waits add up): a sequence, a cutscene
    props: { seconds: { type: 'number', default: 1, min: 0, max: 600, step: 0.1, label: 'Seconds' } },
    run() {}, // done by the rule itself (RuleRuntime._run)
  },
  sendEvent: {
    label: 'Send event',
    // to objects with an "I receive an event" rule: now, or after a while (a timer)
    props: {
      name: { type: 'text', default: 'alarm', label: 'Event' },
      to: { type: 'who', withSelf: true, default: 'any', label: 'To', hint: 'anything: every object listening for it · an object, a group, the player · self: a timer of its own' },
      after: { type: 'number', default: 0, min: 0, max: 600, step: 0.1, label: 'After (s)' },
    },
    run({ action, entity, other, api }) {
      api.sendEvent?.(String(action.name || ''), action.to || 'any', entity, Number(action.after) || 0, other);
    },
  },
  setState: {
    label: 'Set state',
    // what it is doing now — patrolling, chasing, open, burning: its rules can ask (State is) and hear it (I enter a state)
    props: {
      target: { type: 'target', default: 'self', label: 'Which' },
      state: { type: 'text', default: 'chasing', label: 'State' },
    },
    run({ action, entity, other, api }) {
      const t = api.resolveTarget(action.target, entity, other);
      if (t) api.setState?.(t, String(action.state ?? ''));
    },
  },
  destroy: {
    label: 'Destroy object',
    props: {
      target: { type: 'target', default: 'self', label: 'Which' },
      after: { type: 'number', default: 0, min: 0, max: 60, step: 0.1, label: 'After (s)' },
    },
    // "After" leaves time for a last animation or sound
    run({ action, entity, other, api }) {
      const victim = api.resolveTarget(action.target, entity, other);
      if (!victim) return;
      if (Number(action.after) > 0 && api.after) api.after(action.after, () => api.destroy(victim));
      else api.destroy(victim);
    },
  },
  moveObject: {
    label: 'Move object',
    props: {
      target: { type: 'target', default: 'self', label: 'Which' },
      how: { type: 'select', options: ['by', 'to', 'to object'], default: 'by', label: 'Move' },
      x: { type: 'number', default: 0, step: 0.5, label: 'X' },
      y: { type: 'number', default: 0, step: 0.5, label: 'Y' },
      z: { type: 'number', default: 0, step: 0.5, label: 'Z' },
      object: { type: 'object', default: '', label: 'To object', showIf: { how: ['to object'] } },
      seconds: { type: 'number', default: 0, min: 0, max: 60, step: 0.1, label: 'Over (s)' },
      // which point of it arrives there: its origin, or its bottom (it stands on the spot), a corner…
      ...pivotProps({ label: 'Arrives by', only: { how: ['to', 'to object'] }, object: false, at: { y: 'bottom' } }),
    },
    /**
     * "by" X/Y/Z from where it is (knocked back, a door sliding up), "to" a
     * spot in the level (back to the start), or "to object" — where another
     * object is (a respawn point). Straight there, or sliding over "Over (s)".
     */
    run({ action, entity, other, api }) {
      const t = api.resolveTarget(action.target, entity, other);
      if (!t?.object3D) return;
      const p = t.object3D.position;
      const n = (v) => Number(v) || 0;
      let to = null;
      if (action.how === 'to') to = { x: n(action.x), y: n(action.y), z: n(action.z) };
      else if (action.how === 'to object') {
        const at = api.resolveTarget(action.object, entity, other);
        if (at?.object3D) to = { x: at.object3D.position.x, y: at.object3D.position.y, z: at.object3D.position.z };
      } else to = { x: p.x + n(action.x), y: p.y + n(action.y), z: p.z + n(action.z) };
      if (!to) return;
      const off = action.how !== 'by' ? pivotOffset(t, action) : null; // that point of it arrives, not its origin
      if (off) to = { x: to.x - off.x, y: to.y - off.y, z: to.z - off.z };
      if (api.moveTo) api.moveTo(t, to, action.seconds);
      else p.set(to.x, to.y, to.z);
    },
  },
  spawn: {
    label: 'Spawn prefab',
    props: {
      prefab: { type: 'text', default: '', label: 'Prefab' },
      at: { type: 'select', options: ['self', 'origin'], default: 'self', label: 'At' },
    },
    run({ action, entity, api }) {
      const p = action.at === 'origin' ? { x: 0, y: 0, z: 0 } : entity.object3D.position;
      api.spawn(action.prefab, { x: p.x, y: p.y, z: p.z });
    },
  },
  setVisible: {
    label: 'Show / hide object',
    props: {
      target: { type: 'target', default: 'self', label: 'Which' },
      visible: { type: 'boolean', default: false, label: 'Visible' },
    },
    run({ action, entity, other, api }) {
      const t = api.resolveTarget(action.target, entity, other);
      if (t) t.object3D.visible = !!action.visible;
    },
  },
  playSound: {
    label: 'Play sound',
    props: {
      sound: { type: 'sound', default: '', label: 'Sound' },
      target: { type: 'target', default: 'self', label: 'On' },
    },
    run({ action, entity, other, engine, api }) {
      const on = api?.resolveTarget(action.target, entity, other) ?? entity;
      // rules saved before sounds had names used a trigger tag instead
      const name = action.sound || action.trigger || '';
      if (engine.playSound) engine.playSound(on, name);
      else engine.playEntitySounds?.(on, { trigger: name || null });
    },
  },
  playAnimation: {
    label: 'Play animation',
    props: {
      clip: { type: 'clip', default: '', label: 'Clip' },
      target: { type: 'target', default: 'self', label: 'On' },
      mode: { type: 'select', options: ['once', 'loop', 'while held', 'while held, once'], default: 'once', label: 'Play' },
      speed: { type: 'number', default: 1, min: 0.05, max: 10, step: 0.05, label: 'Speed' },
      interrupt: { type: 'boolean', default: false, label: 'Cut off others' },
      sound: { type: 'sound', default: '', label: 'With sound' },
    },
    /**
     * Any of the model's clips, over its movement animation. "once" plays it
     * through and goes back; "loop" keeps going until Stop animation; "while
     * held" (a control) loops only as long as its input is held, and "while
     * held, once" plays through and stays on its last frame until let go
     * (raising a gun to aim). Another action clip still playing is let finish
     * unless "Cut off others" is ticked.
     */
    run({ action, entity, other, engine, api }) {
      const on = api?.resolveTarget(action.target, entity, other) ?? entity;
      if (!on?.object3D || !action.clip) return;
      // a rule has nothing to hold
      const mode = { 'while held': 'loop', 'while held, once': 'once' }[action.mode] ?? action.mode;
      const started = AnimationPlayer.for(engine, on.object3D).play(action.clip, {
        mode, speed: action.speed, interrupt: !!action.interrupt,
      });
      if (started && action.sound) engine.playSound?.(on, action.sound);
    },
  },
  stopAnimation: {
    label: 'Stop animation',
    props: {
      clip: { type: 'clip', default: '', label: 'Clip (empty = any)' },
      target: { type: 'target', default: 'self', label: 'On' },
    },
    run({ action, entity, other, engine, api }) {
      const on = api?.resolveTarget(action.target, entity, other) ?? entity;
      if (!on?.object3D) return;
      engine.mixers?.find((m) => m.root === on.object3D)?.stop?.(action.clip || null);
    },
  },
  shakeCamera: {
    label: 'Shake camera',
    props: {
      strength: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.05, label: 'Strength' },
      seconds: { type: 'number', default: 0.35, min: 0.05, max: 3, step: 0.05, label: 'For (s)' },
    },
    // a hit, a shot, an explosion; each camera's "Shake strength" scales it (0 = never)
    run({ action, engine }) { engine.cameraRig?.shake?.(action.strength, action.seconds); },
  },
  recoil: {
    label: 'Recoil (kick the view)',
    props: {
      up: { type: 'number', default: 1.5, min: 0, max: 20, step: 0.1, label: 'Up (°)' },
      side: { type: 'number', default: 0.5, min: 0, max: 10, step: 0.1, label: 'Sideways, up to (°)' },
      back: { type: 'number', default: 0.03, min: 0, max: 0.3, step: 0.005, label: 'Gun kicks back (m)' },
      recover: { type: 'number', default: 0.2, min: 0, max: 3, step: 0.05, label: 'Settles in (s), 0 = stays' },
    },
    // a shot's kick: the view jumps up (and a little sideways), a held gun jumps back
    run({ action, engine }) { engine.cameraRig?.kick?.(action); },
  },
  stopSound: {
    label: 'Stop sound',
    props: {
      sound: { type: 'sound', default: '', label: 'Sound' },
      target: { type: 'target', default: 'self', label: 'On' },
    },
    run({ action, entity, other, engine, api }) {
      const on = api?.resolveTarget(action.target, entity, other) ?? entity;
      engine.stopSound?.(on, action.sound || '');
    },
  },
  playMusic: {
    label: 'Play music',
    props: {
      sound: { type: 'sound', default: '', label: 'Music' },
      fade: { type: 'number', default: 1, min: 0, max: 10, step: 0.1, label: 'Fade (s)' },
    },
    run({ action, engine }) { engine.playMusic?.(action.sound, Number(action.fade) || 0); },
  },
  stopMusic: {
    label: 'Stop music',
    props: { fade: { type: 'number', default: 1, min: 0, max: 10, step: 0.1, label: 'Fade (s)' } },
    run({ action, engine }) { engine.stopMusic?.(Number(action.fade) || 0); },
  },
  damage: {
    label: 'Damage object',
    props: {
      target: { type: 'target', default: 'other', label: 'Which' },
      amount: { type: 'number', default: 1, min: 0, step: 1, label: 'Amount' },
    },
    run({ action, entity, other, api }) {
      const t = api.resolveTarget(action.target, entity, other);
      if (t) api.damage(t, action.amount, entity);
    },
  },
  attack: {
    label: 'Hit / attack (melee)',
    // a punch, a sword, a kick: what is in front within reach (or what is clicked) is hit —
    // its "Something hits me (with an attack)" rules run, it loses health and is knocked back
    props: {
      aim: {
        type: 'select', options: ['in front', 'pointer'], default: 'in front', label: 'Hits',
        hint: 'In front: what is within reach, the way it faces (in first person, where you look). Pointer: what the mouse is on, or the screen is tapped — if within reach.',
      },
      reach: { type: 'number', default: 2, min: 0.1, max: 50, step: 0.1, label: 'Reach (m)' },
      arc: { type: 'number', default: 90, min: 1, max: 360, step: 5, label: 'Wide (°)', showIf: { aim: 'in front' } },
      all: { type: 'boolean', default: false, label: 'Every one in reach (a sweep)', hint: 'Off: only the nearest.' },
      hits: { type: 'who', default: 'any', label: 'Can hit' },
      damage: { type: 'number', default: 1, min: 0, max: 10000, step: 1, label: 'Damage' },
      push: { type: 'number', default: 3, min: 0, max: 100, step: 0.5, label: 'Knock back (m/s)' },
      sound: { type: 'sound', default: '', label: 'Sound' },
    },
    run({ action, entity, api }) {
      api.attack?.(entity, action);
    },
  },
  win: {
    label: 'Win the game',
    props: { message: { type: 'text', default: 'You win!', label: 'Message' } },
    run({ action, api }) { api.finish('win', action.message); },
  },
  lose: {
    label: 'Lose the game',
    props: { message: { type: 'text', default: 'Game over', label: 'Message' } },
    run({ action, api }) { api.finish('lose', action.message); },
  },
  restart: {
    label: 'Restart game',
    props: {},
    run({ api }) { api.restart(); },
  },
  showMessage: {
    label: 'Show message',
    props: {
      text: { type: 'text', default: 'Hello!', label: 'Text' },
      seconds: { type: 'number', default: 3, min: 0, max: 60, step: 0.5, label: 'Seconds' },
      where: { type: 'select', options: ['middle', 'top', 'bottom'], default: 'middle', label: 'Where' },
    },
    run({ action, engine, vars }) {
      // {an expression} in it, worked out: "Coins: {coins}"
      engine.onMessage?.(formatText(String(action.text ?? ''), varScope(vars)), { seconds: Number(action.seconds) || 0, where: action.where });
    },
  },
  goToLevel: {
    label: 'Go to level',
    props: { level: { type: 'level', default: 'next', label: 'Level' } },
    run({ action, api }) { api.goToLevel?.(action.level); },
  },
  move: {
    label: 'Move (while it runs)',
    // run every frame (a held key, "every 0 seconds"): it moves; a car gets its pedals and wheel
    props: {
      target: { type: 'target', default: 'self', label: 'Which' },
      direction: { type: 'select', options: ['forward', 'back', 'left', 'right', 'up', 'down'], default: 'forward', label: 'Direction' },
      relative: { type: 'select', options: ['self', 'world', 'camera'], default: 'self', label: 'Relative to' },
      speed: { type: 'number', default: 5, min: 0, max: 200, step: 0.5, label: 'Speed (m/s)' },
    },
    run({ action, entity, other, api, engine, dt }) {
      const t = api.resolveTarget(action.target, entity, other);
      if (t?.object3D) moveNow(t, action, engine, dt);
    },
  },
  push: {
    label: 'Push / launch',
    // once: a jump pad, a knock-back, a cannon — added to how it is already moving
    props: {
      target: { type: 'target', default: 'self', label: 'Which' },
      direction: {
        type: 'select', options: ['up', 'forward', 'back', 'left', 'right', 'away from other', 'towards other'],
        default: 'up', label: 'Direction',
      },
      relative: { type: 'select', options: ['self', 'world', 'camera'], default: 'self', label: 'Relative to' },
      strength: { type: 'number', default: 12, min: 0, max: 500, step: 0.5, label: 'Strength (m/s)' },
    },
    run({ action, entity, other, api, engine }) {
      const t = api.resolveTarget(action.target, entity, other);
      const body = t?.rigidBody;
      if (!body || body.type !== 'dynamic') return;
      const d = action.direction;
      if (d === 'away from other' || d === 'towards other') {
        if (!other?.object3D) return;
        _v.subVectors(t.object3D.position, other.object3D.position).setY(0);
        if (_v.lengthSq() < 1e-8) _v.set(0, 0, 1);
        _v.normalize().multiplyScalar(d === 'away from other' ? 1 : -1).setY(0.35).normalize();
      } else {
        directionOf(action, t, engine, _v);
      }
      body.velocity.addScaledVector(_v, Number(action.strength) || 0);
      if (_v.y > 0.3) body.grounded = false;
      // something else sent flying (a kick, a throw): what it hits is hit by "something thrown", by me
      if (t !== entity) t.launchedBy = { by: entity, kind: 'something thrown', until: (engine?.time ?? 0) + THROWN_FOR };
    },
  },
  jump: {
    label: 'Jump',
    props: {
      target: { type: 'target', default: 'self', label: 'Which' },
      strength: { type: 'number', default: 9, min: 0, max: 100, step: 0.5, label: 'Strength' },
      ground: { type: 'boolean', default: true, label: 'Only from the ground' },
    },
    run({ action, entity, other, api }) {
      const t = api.resolveTarget(action.target, entity, other);
      const body = t?.rigidBody;
      if (!body || body.type !== 'dynamic' || (action.ground !== false && !body.grounded)) return;
      body.velocity.y = Number(action.strength) || 0;
      body.grounded = false;
    },
  },
  turn: {
    label: 'Turn',
    // left or right, about the up axis — the player in first person turns the view with it (controls.js)
    props: {
      target: { type: 'target', default: 'self', label: 'Which' },
      degrees: { type: 'number', default: 90, min: -3600, max: 3600, step: 5, label: 'Degrees (+ left, − right)' },
      how: {
        type: 'select', options: ['by', 'per second'], default: 'by', label: 'How',
        hint: 'by: turns it that far · per second: keeps turning while the rule runs (every 0 seconds, a held key)',
      },
      seconds: { type: 'number', default: 0, min: 0, max: 60, step: 0.1, label: 'Over (s)', showIf: { how: ['by'] } },
      ...pivotProps({ at: { x: 'left' } }), // a door: about its hinge side
    },
    run({ action, entity, other, api, dt }) {
      const t = api.resolveTarget(action.target, entity, other);
      if (!t?.object3D) return;
      const angle = THREE.MathUtils.degToRad(Number(action.degrees) || 0) * (action.how === 'per second' ? (dt ?? 0) : 1);
      const pivot = pivotOf(t, action, api, entity, other);
      if (action.how !== 'per second' && Number(action.seconds) > 0 && api.turn) {
        api.turn(t, { axis: _up.clone(), angle, world: true, pivot }, action.seconds);
      } else if (pivot) turnBy(t.object3D, _up, angle, true, pivot());
      else turnYaw(t.object3D, angle);
    },
  },
  face: {
    label: 'Face towards',
    props: {
      target: { type: 'target', default: 'self', label: 'Which' },
      at: { type: 'object', default: 'player', label: 'Towards' },
    },
    run({ action, entity, other, api }) {
      const t = api.resolveTarget(action.target, entity, other);
      const at = api.resolveTarget(action.at, entity, other);
      if (!t?.object3D || !at?.object3D || at === t) return;
      const o = t.object3D;
      const dx = at.object3D.position.x - o.position.x;
      const dz = at.object3D.position.z - o.position.z;
      if (Math.hypot(dx, dz) < 1e-6) return;
      const f = o.userData.forward || [0, 0, 1]; // its own front (a car's may not be +Z)
      o.quaternion.setFromAxisAngle(_up, Math.atan2(dx, dz) - Math.atan2(f[0], f[2]));
      tidyRotation(o);
    },
  },
  rotate: {
    label: 'Rotate',
    // a door swinging open (over a second), a lever, a coin spinning ("per second", set off every frame)
    props: {
      target: { type: 'target', default: 'self', label: 'Which' },
      how: {
        type: 'select', options: ['by', 'to', 'per second'], default: 'by', label: 'How',
        hint: 'by: turns it that much more · to: turns it to exactly that (its Rotation in the Inspector) · '
          + 'per second: keeps turning while the rule runs (every 0 seconds, a held key)',
      },
      x: { type: 'number', default: 0, min: -36000, max: 36000, step: 5, label: 'X (°)', hint: 'Tips it forward or back', redraw: true },
      y: { type: 'number', default: 90, min: -36000, max: 36000, step: 5, label: 'Y (°)', hint: 'Turns it left (+) or right (−)', redraw: true },
      z: { type: 'number', default: 0, min: -36000, max: 36000, step: 5, label: 'Z (°)', hint: 'Rolls it sideways', redraw: true },
      relative: {
        type: 'select', options: ['self', 'world'], default: 'self', label: 'Relative to',
        hint: 'self: about its own axes, as it is turned now · world: about the level\'s', showIf: { how: ['by', 'per second'] }, redraw: true,
      },
      seconds: { type: 'number', default: 0, min: 0, max: 60, step: 0.1, label: 'Over (s)', showIf: { how: ['by', 'to'] } },
      ...pivotProps({ at: { x: 'left' } }), // a door: about its hinge side
    },
    /**
     * "to" X/Y/Z: that rotation, the short way round. "by" and "per second": about
     * the axis X, Y and Z point along, as far as they are long — one of them is
     * about that axis; a whole turn (360) is a whole turn, and turns stack.
     */
    run({ action, entity, other, api, dt }) {
      const t = api.resolveTarget(action.target, entity, other);
      const o = t?.object3D;
      if (!o) return;
      const [x, y, z] = [action.x, action.y, action.z].map((v) => THREE.MathUtils.degToRad(Number(v) || 0));
      const pivot = pivotOf(t, action, api, entity, other);
      if (action.how === 'to') {
        const to = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, o.rotation.order));
        if (api.turn) api.turn(t, { to, pivot }, action.seconds);
        else { turnAround(o, to, pivot?.()); tidyRotation(o); }
        return;
      }
      const axis = new THREE.Vector3(x, y, z);
      const angle = axis.length() * (action.how === 'per second' ? (dt ?? 0) : 1);
      if (angle < 1e-9) return;
      axis.normalize();
      const world = action.relative === 'world';
      if (action.how === 'by' && Number(action.seconds) > 0 && api.turn) api.turn(t, { axis, angle, world, pivot }, action.seconds);
      else turnBy(o, axis, angle, world, pivot?.());
    },
  },
  scale: {
    label: 'Scale',
    // a power-up grows, a hit enemy shrinks away (to 0 over a second, then Destroy), squash and stretch
    props: {
      target: { type: 'target', default: 'self', label: 'Which' },
      how: {
        type: 'select', options: ['times', 'to', 'by', 'times per second'], default: 'times', label: 'How',
        hint: 'times: 2 is twice as big, 0.5 half · to: that size (1: as it was made) · by: adds to its size (− shrinks) · '
          + 'times per second: grows (above 1) or shrinks (below 1) while the rule runs (every 0 seconds, a held key)',
      },
      even: { type: 'boolean', default: true, label: 'Same every way' },
      amount: { type: 'number', default: 2, min: -1000, max: 1000, step: 0.1, label: 'Amount', showIf: { even: [true] } },
      x: { type: 'number', default: 1, min: -1000, max: 1000, step: 0.1, label: 'X', hint: 'Width', showIf: { even: [false] } },
      y: { type: 'number', default: 1, min: -1000, max: 1000, step: 0.1, label: 'Y', hint: 'Height', showIf: { even: [false] } },
      z: { type: 'number', default: 1, min: -1000, max: 1000, step: 0.1, label: 'Z', hint: 'Depth', showIf: { even: [false] } },
      seconds: { type: 'number', default: 0, min: 0, max: 60, step: 0.1, label: 'Over (s)', showIf: { how: ['times', 'to', 'by'] } },
      ...pivotProps({ at: { y: 'bottom' } }), // a pillar: up from its bottom
    },
    /** Its collider grows and shrinks with it. Never below a thousandth: it would have no size at all. */
    run({ action, entity, other, api, dt }) {
      const t = api.resolveTarget(action.target, entity, other);
      const o = t?.object3D;
      if (!o) return;
      const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
      const k = action.even === false
        ? [num(action.x, 1), num(action.y, 1), num(action.z, 1)]
        : [0, 0, 0].fill(num(action.amount, 1));
      const s = o.scale;
      const pivot = pivotOf(t, action, api, entity, other);
      if (action.how === 'times per second') {
        const f = dt ?? 0;
        const next = new THREE.Vector3(sizeOf(s.x * Math.max(0, k[0]) ** f), sizeOf(s.y * Math.max(0, k[1]) ** f), sizeOf(s.z * Math.max(0, k[2]) ** f));
        scaleAround(o, next, pivot?.());
        return;
      }
      const from = api.sizeGoal?.(t) ?? s.clone(); // from where a resize under way will leave it: two doublings are four times
      const to = new THREE.Vector3(...['x', 'y', 'z'].map((a, i) => sizeOf(
        action.how === 'to' ? k[i] : action.how === 'by' ? from[a] + k[i] : from[a] * k[i],
      )));
      if (api.resize) api.resize(t, to, action.seconds, pivot);
      else scaleAround(o, to, pivot?.());
    },
  },
  stop: {
    label: 'Stop moving',
    props: { target: { type: 'target', default: 'self', label: 'Which' } },
    run({ action, entity, other, api }) {
      const t = api.resolveTarget(action.target, entity, other);
      if (!t) return;
      t.vehicle?.setInput(0, 0, true);
      if (t.rigidBody) {
        t.rigidBody.velocity.set(0, 0, 0);
        t.rigidBody.angularVelocity?.set(0, 0, 0);
      }
    },
  },
  saveGame: {
    label: 'Save game',
    // a save point, the end of a level — Load game comes back here (saves.js)
    props: { slot: { type: 'text', default: 'save', label: 'Slot', hint: 'Its name: a game can keep several (save, slot 2…)' } },
    run({ action, api }) { api.saveGame?.(action.slot); },
  },
  loadGame: {
    label: 'Load game',
    // back to the saved level, as it was: its variables, where the player stood, what was gone
    props: { slot: { type: 'text', default: 'save', label: 'Slot' } },
    run({ action, api }) { api.loadGame?.(action.slot); },
  },
  deleteSave: {
    label: 'Delete saved game',
    props: { slot: { type: 'text', default: 'save', label: 'Slot' } },
    run({ action, api }) { api.deleteSave?.(action.slot); },
  },
  checkpoint: {
    label: 'Set checkpoint',
    // a flag the player walks through: "When the player enters me — Set checkpoint (here)"
    props: {
      at: {
        type: 'select', options: ['here', 'where the player is'], default: 'here', label: 'At',
        hint: 'here: on this object (the player stands on its bottom) · where the player is: just there',
      },
    },
    run({ action, entity, api }) { api.setCheckpoint?.(action.at === 'here' ? entity : null); },
  },
  respawn: {
    label: 'Respawn',
    // the player back at its checkpoint (or where it began the level); anything else, where it began
    props: {
      target: { type: 'target', default: 'player', label: 'Which' },
      heal: { type: 'boolean', default: true, label: 'Health full again' },
    },
    run({ action, entity, other, api }) {
      const t = api.resolveTarget(action.target, entity, other);
      if (t) api.respawn?.(t, { heal: action.heal !== false });
    },
  },
  showScreen: {
    label: 'Show / hide a screen',
    // one of the game's screens (Screens panel): a menu, an inventory, a map, a shop
    props: {
      screen: { type: 'screen', withAll: true, default: '', label: 'Screen' },
      how: { type: 'select', options: ['show', 'hide', 'show or hide (toggle)'], default: 'show', label: 'How' },
    },
    run({ action, api }) {
      if (action.how === 'hide') api.hideScreen?.(action.screen || 'all');
      else if (action.how === 'show or hide (toggle)') api.toggleScreen?.(action.screen);
      else api.showScreen?.(action.screen);
    },
  },
  startDialogue: {
    label: 'Start a dialogue',
    // talking to someone: an "I'm interacted with" rule on them, say
    props: { dialogue: { type: 'dialogue', default: '', label: 'Dialogue' } },
    run({ action, api }) { api.startDialogue?.(action.dialogue); },
  },
  ragdoll: {
    label: 'Go limp (ragdoll)',
    // a character falls as a ragdoll: its limbs under physics, its clips stopped; anything else just tumbles
    props: {
      target: { type: 'target', default: 'self', label: 'Which' },
      push: { type: 'number', default: 3, min: 0, max: 100, step: 0.5, label: 'Flung (m/s)', hint: 'Away from what set the rule off (a shot, a blast); 0: it just drops' },
    },
    run({ action, entity, other, api }) {
      for (const t of api.resolveAll(action.target || 'self', entity, other)) {
        api.ragdoll?.(t, { push: pushFrom(t, other, Number(action.push) || 0) });
      }
    },
  },
  makeNoise: {
    label: 'Make a noise',
    // heard by what has Senses (or an Enemy AI) within as far as it is loud: a thrown bottle, an alarm bell, a door slammed
    props: {
      loud: { type: 'number', default: 15, min: 0, max: 1000, step: 1, label: 'Heard within (m)' },
      kind: { type: 'select', options: NOISE_KINDS, default: 'a noise', label: 'As' },
      target: { type: 'target', default: 'self', label: 'Where' },
    },
    run({ action, entity, other, api }) {
      const at = api.resolveTarget(action.target || 'self', entity, other) ?? entity;
      api.makeNoise?.(at.object3D.getWorldPosition(new THREE.Vector3()), { loud: Number(action.loud) || 0, kind: action.kind || 'a noise', by: entity });
    },
  },
  log: {
    label: 'Log a message',
    props: { message: { type: 'text', default: 'hello', label: 'Message' } },
    run({ action, entity }) {
      console.log('[rule]', entity.object3D?.name, action.message);
    },
  },
};

const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
/** A variable's value as a list (a single value is a list of one; nothing, none). */
const listOf = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' || v === 0 ? [] : [v]);
export { problemIn };
const _turn = new THREE.Quaternion();

/** Turn an object by `angle` (radians) about `axis`: its own (as it is turned now), or the world's. */
export function turnBy(o, axis, angle, world = false, pivot = null) {
  _turn.setFromAxisAngle(axis, angle);
  const q = o.quaternion.clone();
  if (world) q.premultiply(_turn);
  else q.multiply(_turn);
  turnAround(o, q, pivot); // about its pivot: that stays put, the rest swings round it
  tidyRotation(o);
}

/**
 * An action's pivot, asked for when needed (each frame of a turn under way:
 * a moon's planet may move) — or null: its origin.
 */
function pivotOf(t, action, api, entity, other) {
  if (!action.pivot || action.pivot === 'its origin') return null;
  return () => pivotPoint(t, action, (name) => api.resolveTarget(name, entity, other));
}

/**
 * Perform an action on each object its "Which" means: one, every member of a
 * group, or every object that shares a name (three are called "Box": all
 * three). Anything else it names — "To object", "Towards" — is the one nearest
 * to each.
 */
export function runAction(def, args) {
  const { action, api, entity, other } = args;
  const sel = action?.target;
  if (!def.props?.target || !api?.resolveAll || !sel || sel === 'self' || sel === 'other' || sel === 'player') {
    def.run(args);
    return;
  }
  for (const each of api.resolveAll(sel, entity, other)) {
    const scoped = { ...api, resolveTarget: (s, self, o, near) => (s === sel ? each : api.resolveTarget(s, self, o, near ?? each)) };
    def.run({ ...args, api: scoped });
  }
}

/** Does this action act a little each frame it runs — so its rule must keep running for it to go far? */
export function actsPerFrame(action) {
  const how = action?.how;
  return action?.type === 'move' || ((action?.type === 'turn' || action?.type === 'rotate') && how === 'per second')
    || (action?.type === 'scale' && how === 'times per second');
}

/** Does this event set its rule off frame after frame (every N seconds, a key or button held)? */
export function keepsRunning(when) {
  return when?.type === 'update' || ((when?.type === 'key' || when?.type === 'mouse') && when.mode === 'held');
}

/** A size that is still a size: never 0 (nothing to hit, nothing to see), nor negative, nor huge. */
export const sizeOf = (v) => Math.min(10000, Math.max(0.001, Number(v) || 0));

/**
 * Is a field worth showing, given the others? `showIf`: { field: [the values
 * it shows for] } — "Over (s)" only for what can take time, say.
 */
export function fieldShown(schema, values = {}) {
  if (!schema?.showIf) return true;
  return Object.entries(schema.showIf).every(([name, allowed]) => allowed.includes(values?.[name]));
}

/**
 * Does changing field `name` show or hide others, or move something drawn in
 * the view (a pivot: `redraw`)? Then the form is drawn again.
 */
export function drivesFields(schemaProps, name) {
  if (schemaProps?.[name]?.redraw) return true;
  return Object.values(schemaProps || {}).some((s) => s?.showIf && name in s.showIf);
}

/**
 * Which way a Move or Push goes: up / down, or forward / back / left / right
 * along the ground as seen from the object itself (its front), the world
 * (forward is -Z, into the default view) or the camera.
 */
function directionOf(action, t, engine, out) {
  const d = action.direction;
  if (d === 'up') return out.set(0, 1, 0);
  if (d === 'down') return out.set(0, -1, 0);
  let fx = 0;
  let fz = -1;
  if (action.relative === 'camera' && engine?.camera) {
    engine.camera.getWorldDirection(out);
    fx = out.x;
    fz = out.z;
  } else if (action.relative !== 'world') {
    const f = t.object3D.userData.forward || [0, 0, 1];
    out.set(f[0], f[1], f[2]).applyQuaternion(t.object3D.quaternion);
    fx = out.x;
    fz = out.z;
  }
  const len = Math.hypot(fx, fz) || 1;
  fx /= len;
  fz /= len;
  const [r, f] = { forward: [0, 1], back: [0, -1], left: [-1, 0], right: [1, 0] }[d] ?? [0, 1];
  return out.set(f * fx - r * fz, 0, f * fz + r * fx); // right = forward × up
}

/** One frame of a Move: a car's pedals, a body's speed (braked when it stops — gameplay.js), or a slide. */
function moveNow(t, action, engine, dt = 1 / 60) {
  const speed = Number(action.speed) || 0;
  if (t.vehicle) {
    const pedals = { forward: [1, 0], back: [-1, 0], left: [0, -1], right: [0, 1] }[action.direction];
    if (pedals) t.vehicle.setInput(pedals[0], pedals[1], false);
    return;
  }
  const d = directionOf(action, t, engine, _v);
  const body = t.rigidBody;
  if (body?.type === 'dynamic') {
    if (action.direction === 'up' || action.direction === 'down') body.velocity.y = d.y * speed;
    else {
      body.velocity.x = d.x * speed;
      body.velocity.z = d.z * speed;
    }
    engine?.gameplay?.markMoved?.(t);
    return;
  }
  t.object3D.position.addScaledVector(d, speed * dt);
}

/**
 * Who a condition is about: me (the object the rule or control is on), the
 * player, "other" (what set the rule off), a group — any of it — or an
 * object by name.
 */
export function subjectsOf(selector, { entity = null, other = null, engine = null } = {}) {
  if (!selector || selector === 'self') return entity ? [entity] : [];
  if (selector === 'other') return other ? [other] : [];
  if (selector === 'player') return engine?.playerEntity ? [engine.playerEntity] : [];
  return (engine?.entities || []).filter((e) => e.alive !== false && e.object3D && matchesWho(selector, e, engine));
}

const _speeds = new WeakMap(); // something with no body: where it was, when, and how fast it went

/** How fast it moves (m/s): its body's speed, a car's, or measured from where it was. */
function speedOf(e, engine) {
  if (e.vehicle) return Math.abs(e.vehicle.speed);
  const body = e.rigidBody;
  if (body?.type === 'dynamic') return body.velocity.length();
  const p = e.object3D.position;
  const t = engine?.time ?? 0;
  const last = _speeds.get(e);
  if (!last) {
    _speeds.set(e, { x: p.x, y: p.y, z: p.z, t, speed: 0 });
    return 0;
  }
  if (t > last.t) {
    last.speed = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) / (t - last.t);
    Object.assign(last, { x: p.x, y: p.y, z: p.z, t });
  }
  return last.speed;
}

const CAMERA_MODES = { orbit: 'orbit', follow: 'follow', 'first person': 'fps', fly: 'free' };
const subject = (d = 'self', label = 'Who') => ({ type: 'subject', default: d, label });

/** Conditions that gate a rule — and a control ("Only when"). Each can be turned round (not). */
export const CONDITIONS = {
  variable: {
    label: 'Variable is',
    props: {
      name: { type: 'text', default: 'score', label: 'Variable' },
      op: { type: 'select', options: COMPARE_OPS, default: '>=', label: 'Is' },
      value: { type: 'text', default: '1', label: 'Value', hint: 'A number, true / false, text (with {an expression} in it), a list [a, b] — or = and an expression: =score + 10, =len(inventory)' },
    },
    test({ condition, vars }) {
      return compare(vars.get(condition.name, 0), condition.op, valueOf(condition.value, varScope(vars)));
    },
  },
  expression: {
    label: 'Expression is true',
    props: { expr: { type: 'text', default: 'coins >= 10 and not dead', label: 'Expression', hint: 'Anything that works out true: score * 2 > best, contains(inventory, "key"), state == "open"' } },
    test({ condition, vars, entity }) {
      return truthy(runExpr(String(condition.expr || '0'), varScope(vars, { state: entity?.state ?? '' })));
    },
  },
  listContains: {
    label: 'List contains',
    props: {
      name: { type: 'text', default: 'inventory', label: 'List' },
      value: { type: 'text', default: 'key', label: 'Value', hint: 'A number, true / false, text (with {an expression} in it), a list [a, b] — or = and an expression: =score + 10, =len(inventory)' },
    },
    test({ condition, vars }) {
      const v = valueOf(condition.value, varScope(vars));
      return listOf(vars.get(condition.name, [])).some((x) => JSON.stringify(x) === JSON.stringify(v));
    },
  },
  state: {
    label: 'State is',
    props: {
      who: { type: 'subject', default: 'self', label: 'Whose' },
      state: { type: 'text', default: 'chasing', label: 'State' },
    },
    test(ctx) {
      const want = String(ctx.condition.state ?? '').toLowerCase();
      return subjectsOf(ctx.condition.who, ctx).some((e) => String(e.state ?? '').toLowerCase() === want);
    },
  },
  health: {
    label: 'My health is',
    props: {
      op: { type: 'select', options: COMPARE_OPS, default: '<=', label: 'Is' },
      value: { type: 'number', default: 0, step: 1, label: 'Value' },
    },
    // the Health of the object the rule is on (no Health counts as 0)
    test({ condition, entity, engine }) {
      const h = engine?.gameplay?.components.listFor(entity).find((c) => c.type === 'health');
      const now = h ? (h.state.current ?? h.props.max) : 0;
      return compare(now, condition.op, condition.value);
    },
  },
  compareVariables: {
    label: 'Variable is (another variable)',
    props: {
      name: { type: 'text', default: 'health', label: 'Variable' },
      op: { type: 'select', options: COMPARE_OPS, default: '<', label: 'Is' },
      other: { type: 'text', default: 'maxHealth', label: 'Than variable' },
    },
    test({ condition, vars }) {
      return compare(vars.get(condition.name, 0), condition.op, vars.get(condition.other, 0));
    },
  },
  keyHeld: {
    label: 'Key / pad button is held',
    props: { code: { type: 'key', default: 'ShiftLeft', label: 'Key' } },
    test({ condition, engine }) { return !!engine?.input?.isDown(condition.code); },
  },
  mouseHeld: {
    label: 'Mouse button is held',
    props: { button: { type: 'select', options: MOUSE, default: 'left', label: 'Button' } },
    test({ condition, engine }) { return !!engine?.input?.mouseDown(Math.max(0, MOUSE.indexOf(condition.button))); },
  },
  onGround: {
    label: 'Is on the ground',
    props: { who: subject() },
    test(ctx) {
      return subjectsOf(ctx.condition.who, ctx).some((e) => !!e.rigidBody?.grounded || e.vehicle?.grounded > 0);
    },
  },
  moving: {
    label: 'Is moving faster than',
    props: { who: subject(), speed: { type: 'number', default: 0.5, min: 0, max: 500, step: 0.1, label: 'Speed (m/s)' } },
    test(ctx) {
      const s = Number(ctx.condition.speed) || 0;
      return subjectsOf(ctx.condition.who, ctx).some((e) => speedOf(e, ctx.engine) > s);
    },
  },
  screenOpen: {
    label: 'A screen is up',
    props: { screen: { type: 'screen', withAll: true, default: '', label: 'Screen', hint: 'Any: any of them' } },
    test({ condition, engine }) {
      const s = engine.gameplay?.screens;
      if (!s) return false;
      const name = String(condition.screen ?? '').trim();
      return !name || name === 'all' ? s.open.length > 0 : s.isOpen(name);
    },
  },
  talking: {
    label: 'A dialogue is under way',
    props: {},
    test({ engine }) { return !!engine.gameplay?.screens?.talking; },
  },
  canSee: {
    label: 'I can see',
    // with its Senses (or the usual ones: 15 m, 120°), not through walls
    props: { who: { type: 'who', default: 'player', label: 'Who' } },
    test({ condition, entity, engine }) {
      const who = condition.who || 'player';
      const senses = entity?.senses;
      if (senses?.props) return !!senses.sees && (who === 'any' || matches(who, senses.sees, engine));
      const them = engine.gameplay?.resolveAll(who === 'any' ? 'player' : who, entity, null) || [];
      return them.slice(0, 4).some((t) => canSee(engine, entity, t, SENSE_DEFAULTS));
    },
  },
  heard: {
    label: 'I heard something',
    props: {
      kind: { type: 'select', options: ['anything', ...NOISE_KINDS], default: 'anything', label: 'What' },
      within: { type: 'number', default: 3, min: 0, max: 600, step: 0.5, label: 'In the last (s)' },
    },
    test({ condition, entity, time }) {
      const h = entity?.senses?.heard;
      if (!h || (time ?? 0) - h.time > (Number(condition.within) || 0)) return false;
      return !condition.kind || condition.kind === 'anything' || condition.kind === h.kind;
    },
  },
  near: {
    label: 'Is near',
    props: {
      who: subject(),
      of: subject('player', 'Near'),
      distance: { type: 'number', default: 3, min: 0, max: 10000, step: 0.5, label: 'Within (m)' },
    },
    test(ctx) {
      const d = Number(ctx.condition.distance) || 0;
      const them = subjectsOf(ctx.condition.of, ctx);
      return subjectsOf(ctx.condition.who, ctx).some((a) => them.some((b) => b !== a
        && a.object3D.getWorldPosition(_v).distanceTo(b.object3D.getWorldPosition(new THREE.Vector3())) <= d));
    },
  },
  touching: {
    label: 'Is touching',
    props: { who: subject(), what: { type: 'who', default: 'any', label: 'What' } },
    test(ctx) {
      const physics = ctx.engine?.physics;
      if (!physics?.touching) return false;
      return subjectsOf(ctx.condition.who, ctx)
        .some((e) => physics.touching(e).some((o) => matchesWho(ctx.condition.what, o, ctx.engine)));
    },
  },
  shown: {
    label: 'Is shown',
    props: { who: subject() },
    test(ctx) { return subjectsOf(ctx.condition.who, ctx).some((e) => e.object3D.visible !== false); },
  },
  exists: {
    label: 'Exists (any left)',
    props: { who: subject('group:Enemies') },
    test(ctx) { return subjectsOf(ctx.condition.who, ctx).length > 0; },
  },
  count: {
    label: 'How many there are',
    props: {
      who: subject('group:Enemies'),
      op: { type: 'select', options: COMPARE_OPS, default: '<=', label: 'Is' },
      value: { type: 'number', default: 0, step: 1, label: 'Number' },
    },
    test(ctx) { return compare(subjectsOf(ctx.condition.who, ctx).length, ctx.condition.op, ctx.condition.value); },
  },
  chance: {
    label: 'Random chance',
    props: { percent: { type: 'number', default: 50, min: 0, max: 100, step: 1, label: 'Chance (%)' } },
    test({ condition }) { return Math.random() * 100 < (Number(condition.percent) || 0); },
  },
  cooldown: {
    label: 'Not more often than every',
    // lets it through, then not again for this long (see conditionsPass)
    props: { seconds: { type: 'number', default: 1, min: 0, max: 3600, step: 0.1, label: 'Seconds' } },
    cooldown: true,
    test() { return true; }, // (it keeps time in conditionsPass)
  },
  driving: {
    label: 'The player is driving',
    props: {},
    test({ engine }) { return !!engine?.playerEntity?.vehicle; },
  },
  camera: {
    label: 'The camera is',
    props: { mode: { type: 'select', options: Object.keys(CAMERA_MODES), default: 'first person', label: 'Mode' } },
    test({ condition, engine }) { return engine?.cameraRig?.mode === CAMERA_MODES[condition.mode]; },
  },
  saved: {
    label: 'A saved game exists',
    // a title's "Continue", a Load game only when there's something to load
    props: { slot: { type: 'text', default: 'save', label: 'Slot' } },
    test: ({ engine, condition }) => !!engine?.gameplay?.hasSave(condition.slot),
  },
  playTime: {
    label: 'Play has run for',
    props: {
      op: { type: 'select', options: COMPARE_OPS, default: '>=', label: 'Is' },
      seconds: { type: 'number', default: 10, min: 0, step: 1, label: 'Seconds' },
    },
    test({ condition, engine, time }) {
      const since = (time ?? 0) - (engine?.gameplay?.startedAt ?? 0);
      return compare(since, condition.op, condition.seconds);
    },
  },
};

const _cooldowns = new WeakMap(); // cooldown condition -> when it last let things through

/** How a condition joins the one before it: its own `join`, or — saved before there was one — the list's all / any. */
export const joinOf = (condition, match = 'all') => (condition?.join === 'or' || condition?.join === 'and'
  ? condition.join : (match === 'any' ? 'or' : 'and'));

/**
 * Do these conditions hold? Each joins the one before it with AND or OR, and
 * each may be turned round (`not`): AND, OR, AND NOT, OR NOT. AND binds first,
 * as in "A and B or C and not D" = (A and B) or (C and not D): every OR starts
 * a new group, and it holds when all of some group do. (`match`: lists saved
 * before each had its own join — 'all' is AND throughout, 'any' OR.) A cooldown
 * holds everything back until its time is up — however it is joined — and
 * restarts only when the rest let things through (`dry`: just asking, as a
 * prompt does, without starting it).
 *   ctx: { vars, entity, other, engine, time }
 */
export function conditionsPass(list, match = 'all', ctx = {}, { dry = false } = {}) {
  if (!Array.isArray(list) || !list.length) return true;
  const groups = [[]];
  const limits = [];
  for (const condition of list) {
    const def = CONDITIONS[condition?.type];
    if (!def) continue;
    if (def.cooldown) { limits.push(condition); continue; }
    if (groups[groups.length - 1].length && joinOf(condition, match) === 'or') groups.push([]);
    groups[groups.length - 1].push(condition);
  }
  const holds = (c) => {
    const ok = !!CONDITIONS[c.type].test({ ...ctx, condition: c });
    return c.not ? !ok : ok;
  };
  let pass = !groups[0].length || groups.some((g) => g.every(holds));
  const now = ctx.time ?? 0;
  for (const c of limits) {
    const last = _cooldowns.get(c);
    if (last !== undefined && now - last < (Number(c.seconds) || 0)) pass = false;
  }
  if (pass && !dry) for (const c of limits) _cooldowns.set(c, now);
  return pass;
}

/**
 * A condition list as saved: known types, their fields filled in, `not` and
 * `join` kept — and a list saved as all / any (`match`) given its joins.
 */
export function normalizeConditions(list, match = null) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && CONDITIONS[c.type])
    .map((c, i) => {
      const out = { ...withDefaults(CONDITIONS[c.type].props, c) };
      delete out.join;
      delete out.not;
      if (i > 0) {
        const join = c.join === 'or' || c.join === 'and' ? c.join : (match === 'any' ? 'or' : null);
        if (join) out.join = join;
      }
      if (c.not) out.not = true;
      return out;
    });
}

/** A blank rule, for the "+ Rule" button. */
export function blankRule() {
  return {
    when: { type: 'triggerEnter', who: 'player' },
    if: [],
    do: [{ type: 'changeVariable', name: 'score', by: 1 }],
  };
}

/** Fill in any missing props for an event/action/condition from its schema. */
export function withDefaults(schemaProps, data = {}) {
  const out = { ...data };
  for (const [name, schema] of Object.entries(schemaProps || {})) {
    if (out[name] === undefined) out[name] = schema.default;
  }
  return out;
}

/** Does an entity match a `who` selector? */
const matches = matchesWho; // any, the player, a group, or a name — see groups.js

/**
 * RuleRuntime — evaluates every rule in the scene once per frame.
 */

const _toMe = new THREE.Vector3();
const _closing = new THREE.Vector3();
/**
 * Did the other one of a new touch hit `self` — move into it — and how? Its
 * speed towards me (closing, m/s) and the side of me it came from, as I face.
 * Null when it wasn't coming my way (I walked into it, or it was standing still).
 */
/** "What" / "Done by": anything takes even no one in particular; else as matches(). */
const matchesOrAny = (who, entity, engine) => !who || who === 'any' || (!!entity && matches(who, entity, engine));

export function hitOn(contact, self) {
  if (!contact.normal || !contact.va || !contact.vb) return null;
  const mine = contact.a === self;
  // the normal is a's way out of b: from b towards a
  _toMe.copy(contact.normal).multiplyScalar(mine ? 1 : -1);
  const vOther = mine ? contact.vb : contact.va;
  const vSelf = mine ? contact.va : contact.vb;
  if (vOther.dot(_toMe) <= 0.05) return null; // it wasn't moving into me
  const speed = _closing.subVectors(vOther, vSelf).dot(_toMe);
  if (speed <= 0) return null;
  return { speed, toMe: _toMe.clone(), from: hitSide(self, _toMe) };
}

/** The side of `self` a hit going `toMe` (the way it travelled) came from, as it faces. */
export function hitSide(self, toMe) {
  // where it came from: the other way to where it was going
  const fx = -toMe.x;
  const fy = -toMe.y;
  const fz = -toMe.z;
  const len = Math.hypot(fx, fy, fz) || 1;
  if (fy / len > 0.6) return 'above';
  if (fy / len < -0.6) return 'below';
  const yaw = self?.object3D ? yawOf(self.object3D) : 0; // facing is local +Z
  const h = Math.hypot(fx, fz) || 1;
  const ahead = (fx * Math.sin(yaw) + fz * Math.cos(yaw)) / h;
  return ahead > Math.SQRT1_2 ? 'the front' : ahead < -Math.SQRT1_2 ? 'behind' : 'a side';
}

/**
 * What kind of thing moved into me, and who is behind it: a vehicle (driven
 * into me), a shot or a throw (fired or launched by someone), or just a
 * moving object (itself).
 */
export function moverOf(other, time = 0) {
  if (other?.vehicle) return { kind: 'a vehicle', by: other };
  const l = other?.launchedBy;
  if (l && time <= l.until) return { kind: l.kind, by: l.by ?? other };
  return { kind: 'a moving object', by: other };
}
export class RuleRuntime {
  constructor(engine) {
    this.engine = engine;
    this.rules = []; // { entity, rule, state }
  }

  add(entity, rule) {
    const record = { entity, rule, state: {} };
    this.rules.push(record);
    return record;
  }

  setFor(entity, rules = []) {
    this.clearEntity(entity);
    return rules.map((r) => this.add(entity, r));
  }

  clearEntity(entity) {
    this.rules = this.rules.filter((r) => r.entity !== entity);
  }

  clear() { this.rules.length = 0; }

  listFor(entity) {
    return this.rules.filter((r) => r.entity === entity).map((r) => r.rule);
  }

  serializeFor(entity) {
    const list = this.listFor(entity);
    return list.length ? JSON.parse(JSON.stringify(list)) : undefined;
  }

  /** Reset per-run state and fire every `start` rule. */
  start(api) {
    for (const r of this.rules) r.state = {};
    this._lastHits = null; // who hit what last, for "one hit is one hit"
    this._fire((rec) => rec.rule.when?.type === 'start', { api, time: 0 });
  }

  /**
   * Run one frame: timed rules, key rules, variable watches, then contacts.
   * @param {Array} contacts physics events from PhysicsWorld.events
   */
  update(dt, time, contacts, api) {
    const { input } = this.engine;
    this._dt = dt;

    for (const rec of this.rules) {
      const when = rec.rule.when;
      if (!when) continue;

      if (when.type === 'update') {
        const every = Number(when.every) || 0;
        // "every N seconds" fires after the first N seconds, not immediately
        rec.state.since = (rec.state.since ?? 0) + dt;
        if (rec.state.since >= every) {
          const since = rec.state.since; // what "per second" is of: the time since it last ran
          rec.state.since = 0;
          this._run(rec, { api, time, dt: since });
        }
      } else if (when.type === 'key' && input) {
        const down = when.mode === 'held' ? input.isDown(when.code)
          : when.mode === 'released' ? !!input.wasReleased?.(when.code)
            : input.wasPressed(when.code);
        if (down) this._run(rec, { api, time });
      } else if (when.type === 'mouse' && input) {
        const b = Math.max(0, MOUSE.indexOf(when.button));
        // pressed: a click, not the start of a drag that turns the camera
        const on = when.mode === 'held' ? input.mouseDown(b)
          : when.mode === 'released' ? input.mouseReleased?.(b)
            : (input.pointerLocked ? input.mouseClicked?.(b) : input.mouseTapped?.(b));
        if (on) this._run(rec, { api, time });
      } else if (when.type === 'variable') {
        const vars = this.engine.variables;
        const now = compare(vars.get(when.name, 0), when.op, valueOf(when.value, varScope(vars)));
        // edge-triggered: fire when the test becomes true, not every frame it stays true
        if (now && !rec.state.wasTrue) this._run(rec, { api, time });
        rec.state.wasTrue = now;
      }
    }

    this._clicks(time, api);
    for (const contact of contacts || []) this._dispatchContact(contact, time, api);
  }

  /** "I'm clicked / tapped": the object under the pointer, when a button is clicked. */
  _clicks(time, api) {
    const { input } = this.engine;
    if (!input || !this.engine.camera) return;
    const recs = this.rules.filter((r) => r.rule.when?.type === 'clicked');
    if (!recs.length) return;
    for (const button of new Set(recs.map((r) => r.rule.when.button || 'left'))) {
      const b = Math.max(0, MOUSE.indexOf(button));
      if (!(input.pointerLocked ? input.mouseClicked?.(b) : input.mouseTapped?.(b))) continue;
      const hit = this.pick();
      if (!hit) continue;
      for (const rec of recs) {
        if (rec.entity === hit && (rec.rule.when.button || 'left') === button) {
          this._run(rec, { api, time, other: this.engine.playerEntity ?? null });
        }
      }
    }
  }

  /**
   * The object under the pointer — or at the middle of the view, the mouse
   * captured — the nearest one in front: a wall hides what is behind it. A part
   * (a car's wheel) counts as its object.
   */
  pick() {
    const { input, camera } = this.engine;
    if (!input || !camera) return null;
    const ndc = input.pointerLocked ? { x: 0, y: 0 } : (input.mouseNDC || { x: 0, y: 0 });
    this._ray ??= new THREE.Raycaster();
    this._ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const roots = (this.engine.entities || [])
      .filter((e) => e.alive !== false && e.object3D?.parent && e.object3D.visible !== false);
    const owner = new Map(roots.map((e) => [e.object3D, e]));
    for (const hit of this._ray.intersectObjects(roots.map((e) => e.object3D), true)) {
      for (let n = hit.object; n; n = n.parent) {
        if (!n.visible) break; // a hidden part isn't there to click
        if (owner.has(n)) return owner.get(n);
      }
    }
    return null;
  }

  _dispatchContact(contact, time, api) {
    const pairs = [[contact.a, contact.b, contact.aPart], [contact.b, contact.a, contact.bPart]];
    for (const [self, other, part] of pairs) {
      // moved into me: "Something hits me", with what and by whom
      if (contact.type === 'collisionEnter' && this.rules.some((r) => r.entity === self && r.rule.when?.type === 'hitBy')) {
        const h = hitOn(contact, self);
        // one hit is one hit: pressed against me, touching on and off, it doesn't count again and again
        const now = this.engine.time ?? time;
        const seen = (this._lastHits ??= new WeakMap()).get(self) ?? new WeakMap();
        this._lastHits.set(self, seen);
        const last = seen.get(other);
        if (h) seen.set(other, now);
        if (h && !(last !== undefined && now - last >= 0 && now - last < REHIT_AFTER)) {
          this.hit(self, { other, ...moverOf(other, now), speed: h.speed, toMe: h.toMe, part }, api, time);
        }
      }
      for (const rec of this.rules) {
        if (rec.entity !== self) continue;
        const when = rec.rule.when;
        if (!when) continue;
        const wants =
          (when.type === 'triggerEnter' && contact.type === 'triggerEnter') ||
          (when.type === 'triggerExit' && contact.type === 'triggerExit') ||
          (when.type === 'collision' && contact.type === 'collisionEnter');
        if (!wants) continue;
        if (when.part && when.part !== part) continue; // at one of my parts only (physics-parts.js)
        if (!matches(when.who, other, this.engine)) continue;
        this._run(rec, { api, time, other });
      }
    }
  }

  /**
   * `entity` was hit: run its "Something hits me" rules that want this hit.
   *   other  — what hit it (the bullet, the rock, the car; the shooter or attacker for an instant hit)
   *   by     — who did it (the shooter, thrower, attacker, driver — or the thing itself)
   *   kind   — one of HIT_WITH (not 'anything')
   *   speed  — how fast it came (m/s), or null (an instant hit, an attack: always hard enough)
   *   toMe   — the way it was going, for which side it came from
   *   part   — the part of a model it hit, if one of its own (physics-parts.js)
   */
  hit(entity, { other = null, by = other, kind = 'a moving object', speed = null, toMe = null, part = null } = {}, api, time = 0) {
    let ran = false;
    const from = toMe ? hitSide(entity, toMe) : null;
    for (const rec of this.rules) {
      if (rec.entity !== entity || rec.rule.when?.type !== 'hitBy') continue;
      const when = rec.rule.when;
      if (when.with && when.with !== 'anything' && when.with !== kind) continue;
      if (when.part && when.part !== part) continue;
      if (!matchesOrAny(when.who, other, this.engine)) continue;
      if (!matchesOrAny(when.by, by, this.engine)) continue;
      if (speed !== null && (speed <= 0 || speed < (Number(when.harder) || 0))) continue;
      if (when.from && when.from !== 'anywhere' && from !== when.from) continue;
      if (when.speedTo) this.engine.variables?.set(String(when.speedTo).trim(), speed === null ? 0 : Math.round(speed * 10) / 10);
      if (this._run(rec, { api, time, other })) ran = true;
    }
    return ran;
  }

  /** Entities with an "interacts with me" rule that `other` is allowed to trigger. */
  interactables(other) {
    const out = [];
    for (const rec of this.rules) {
      if (rec.rule.when?.type !== 'interact' || out.includes(rec.entity)) continue;
      if (matches(rec.rule.when.who, other, this.engine)) out.push(rec.entity);
    }
    return out;
  }

  /** The prompt text shown when `entity` can be interacted with. */
  interactPrompt(entity) {
    const rec = this.rules.find((r) => r.entity === entity && r.rule.when?.type === 'interact');
    return rec?.rule.when.prompt || 'Interact';
  }

  /** `other` interacted with `entity`: run its interact rules. */
  interact(entity, other, api, time = 0) {
    let ran = false;
    for (const rec of this.rules) {
      if (rec.entity !== entity || rec.rule.when?.type !== 'interact') continue;
      if (!matches(rec.rule.when.who, other, this.engine)) continue;
      if (this._run(rec, { api, time, other })) ran = true;
    }
    return ran;
  }

  /** Vehicle `entity` crashed into `other`, its speed changing by `kmh`: its "I crash" rules, if hard enough. */
  crashed(entity, other, kmh, api, time = 0) {
    let ran = false;
    for (const rec of this.rules) {
      if (rec.entity !== entity || rec.rule.when?.type !== 'crash') continue;
      if (kmh < (Number(rec.rule.when.harder) || 0)) continue;
      const who = rec.rule.when.who;
      if (!(!who || who === 'any' || matches(who, other, this.engine))) continue;
      if (this._run(rec, { api, time, other })) ran = true;
    }
    return ran;
  }

  /** `shooter` hit `entity` with an instant-hit shot: run its "I'm shot" rules. */
  shot(entity, shooter, api, time = 0) { return this.on('shot', entity, shooter, api, time); }

  /**
   * Something happened to `entity` ('shot', 'hurt', 'healthOut'), done by
   * `other` if known: run its rules for that event whose "By" matches. "By:
   * anything" also takes something done by no one in particular.
   */
  on(type, entity, other, api, time = 0, accept = null) {
    let ran = false;
    for (const rec of this.rules) {
      if (rec.entity !== entity || rec.rule.when?.type !== type) continue;
      if (accept && !accept(rec.rule.when)) continue;
      const who = rec.rule.when.who;
      if (!(!who || who === 'any' || matches(who, other, this.engine))) continue;
      if (this._run(rec, { api, time, other })) ran = true;
    }
    return ran;
  }

  /** Every rule of an event that belongs to no object in particular (a screen's button, a dialogue's end) that `accept`s it. */
  fireAll(type, accept, api, time = 0) {
    let ran = 0;
    for (const rec of [...this.rules]) {
      if (rec.rule.when?.type !== type) continue;
      if (accept && !accept(rec.rule.when)) continue;
      if (this._run(rec, { api, time })) ran++;
    }
    return ran;
  }

  _fire(predicate, ctx) {
    for (const rec of this.rules) {
      if (predicate(rec)) this._run(rec, ctx);
    }
  }

  /** Check conditions, then perform every action. */
  _run(rec, { api, time, other = null, dt = null }) {
    if (rec.failed) return false;
    const vars = this.engine.variables;
    try {
      // If: its conditions (joined by and / or, each maybe turned round) — then Do, or Else
      const pass = conditionsPass(rec.rule.if, rec.rule.match, { vars, entity: rec.entity, other, engine: this.engine, time });
      this.engine.onRuleRun?.(rec, pass, other); // the Debugger's trace and breakpoints, the Logic graph lighting up
      let delay = 0; // a Wait: what follows it, this much later (they add up)
      for (const action of (pass ? rec.rule.do : rec.rule.else) || []) {
        const def = ACTIONS[action.type];
        if (!def) {
          console.warn('[Tiny3 rules] unknown action:', action.type);
          continue;
        }
        if (action.type === 'wait') { delay += Math.max(0, Number(action.seconds) || 0); continue; }
        const go = () => runAction(def, {
          action, vars, entity: rec.entity, other,
          engine: this.engine, api, time: this.engine.time ?? time, dt: dt ?? this._dt ?? 1 / 60,
        });
        if (delay > 0 && api?.after) {
          api.after(delay, () => {
            if (rec.failed || rec.entity.alive === false) return; // gone meanwhile: the rest of it goes too
            try { go(); } catch (err) { this._fail(rec, err); }
          });
        } else go();
      }
      return pass;
    } catch (err) {
      this._fail(rec, err);
      return false;
    }
  }

  _fail(rec, err) {
    rec.failed = true;
    this.engine.onRuleFail?.(rec, err);
    console.error(`[Tiny3 rule] on "${rec.entity.object3D?.name}" failed:`, err);
  }

  /** `sender` sent the event `name` to `targets`: run their "I receive an event" rules for it. */
  receive(name, targets, sender, api, time = 0) {
    const want = String(name).toLowerCase();
    this.engine.onEventSent?.(name, sender, targets);
    const to = new Set(targets);
    let ran = 0;
    for (const rec of [...this.rules]) {
      if (rec.rule.when?.type !== 'event' || !to.has(rec.entity)) continue;
      if (String(rec.rule.when.name ?? '').toLowerCase() !== want) continue;
      if (this._run(rec, { api, time, other: sender ?? null })) ran++;
    }
    return ran;
  }

  /** `entity` just entered the state `state`: run its "I enter a state" rules for it. */
  enteredState(entity, state, api, time = 0) {
    const want = String(state).toLowerCase();
    for (const rec of [...this.rules]) {
      if (rec.entity !== entity || rec.rule.when?.type !== 'stateEnter') continue;
      if (String(rec.rule.when.state ?? '').toLowerCase() === want) this._run(rec, { api, time });
    }
  }
}
