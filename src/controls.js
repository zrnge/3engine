import * as THREE from 'three';
import { RigidBody } from './physics.js';
import { ACTIONS as RULE_ACTIONS, withDefaults, conditionsPass, normalizeConditions, runAction, actsPerFrame } from './rules.js';
import { AnimationPlayer } from './animation.js';
import { matchesWho } from './groups.js';
import { movementFeel, jumpKind, jumpNow } from './components.js';
import { yawOf, setYaw, turnYaw, wrapAngle } from './heading.js';

/**
 * Controls — what the player presses, and what that does.
 *
 * Nothing about input is hardcoded. A scene carries a list of controls, each one
 * plain data the Controls panel edits and the serializer saves:
 *
 *   { inputs: [{ type: 'key', code: 'KeyW' },        // any of these triggers it
 *              { type: 'mouse', button: 'left' },
 *              { type: 'screen', label: '▲' }],      // an on-screen touch button
 *     target: 'player',                              // or any object's name
 *     action: { type: 'move', direction: 'forward', speed: 8, relative: 'world', face: true } }
 *
 * Continuous actions (move, turn) run every frame an input is held; everything
 * else runs once per press.
 */

export const INPUT_TYPES = {
  key: { label: 'Key or pad', icon: '⌨' },
  mouse: { label: 'Mouse', icon: '🖱' },
  screen: { label: 'Screen button', icon: '▣' },
};

/** Index = MouseEvent.button. */
export const MOUSE_BUTTONS = ['left', 'middle', 'right'];

const DIRECTIONS = ['forward', 'back', 'left', 'right'];
/** [right, forward] components of each direction. */
const DIRECTION_AXES = { forward: [0, 1], back: [0, -1], left: [-1, 0], right: [1, 0] };

/** Game actions borrowed from the rule builder — same names, same fields. */
const GAME_ACTION_TYPES = [
  'rotate', 'scale', 'recoil', 'playAnimation', 'stopAnimation', 'shakeCamera',
  'changeVariable', 'setVariable', 'playSound', 'stopSound', 'playMusic', 'stopMusic', 'spawn', 'setVisible',
  'destroy', 'damage', 'attack', 'win', 'lose', 'restart', 'goToLevel', 'showMessage', 'log',
  'showScreen', 'startDialogue', // I for the inventory, M for a map, Tab for a menu
];

export const CONTROL_ACTIONS = {
  move: {
    label: 'Move',
    group: 'Movement',
    continuous: true,
    hint: 'While held. Objects without a physics body slide directly; the player gets a Dynamic body so it falls and collides.',
    props: {
      direction: { type: 'select', options: DIRECTIONS, default: 'forward', label: 'Direction' },
      speed: { type: 'number', default: 8, min: 0, max: 100, step: 0.5, label: 'Speed' },
      relative: { type: 'select', options: ['world', 'camera', 'self'], default: 'world', label: 'Relative to' },
      face: { type: 'boolean', default: true, label: 'Face movement' },
    },
  },
  turn: {
    label: 'Turn',
    group: 'Movement',
    continuous: true,
    hint: 'While held. Pair with Move relative to "self" for tank-style controls.',
    props: {
      direction: { type: 'select', options: ['left', 'right'], default: 'left', label: 'Direction' },
      speed: { type: 'number', default: 180, min: 0, max: 1440, step: 5, label: 'Degrees/s' },
    },
  },
  sprint: {
    label: 'Sprint',
    group: 'Movement',
    continuous: true,
    hint: 'While held, the target moves faster (× Speed) — bind it to Shift, say. An Animator switches to its running clip at its "Run from" speed, and head bob follows the pace. "Widen view" opens the field of view a little while sprinting.',
    props: {
      multiplier: { type: 'number', default: 1.8, min: 1, max: 5, step: 0.05, label: 'Speed ×' },
      fovBoost: { type: 'number', default: 0, min: 0, max: 30, step: 1, label: 'Widen view (°)' },
    },
  },
  crouch: {
    label: 'Crouch',
    group: 'Movement',
    continuous: true,
    hint: 'Its body lower (from its feet), so it fits under low things, and slower; a first-person view lowers too. '
      + 'It stands up again only where there is room over its head. Held, or pressed on and off. '
      + 'A clip, if chosen, plays while crouched (a crouch walk).',
    props: {
      press: { type: 'select', options: ['hold', 'press on/off'], default: 'hold', label: 'Press' },
      height: { type: 'number', default: 0.55, min: 0.2, max: 1, step: 0.05, label: 'Height (× standing)' },
      speed: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.05, label: 'Speed ×' },
      clip: { type: 'clip', default: '', label: 'Clip while crouched' },
    },
  },
  jump: {
    label: 'Jump',
    group: 'Movement',
    hint: 'Only while standing on something. Plays the chosen sound, if any.',
    props: {
      strength: { type: 'number', default: 9, min: 0, max: 60, step: 0.5, label: 'Strength' },
      sound: { type: 'sound', default: '', label: 'Sound' },
    },
  },
  interact: {
    label: 'Interact',
    group: 'Interact',
    hint: 'Runs the "Someone interacts with me" rules of the nearest object in range, or the one under the pointer. Range 0 = any distance.',
    props: {
      pick: { type: 'select', options: ['nearest', 'pointed'], default: 'nearest', label: 'Which object' },
      range: { type: 'number', default: 3, min: 0, max: 1000, step: 0.5, label: 'Range' },
    },
  },
  aim: {
    label: 'Aim',
    group: 'Aim & shoot',
    continuous: true,
    hint: 'Aim down the sights, or over the shoulder. While held (or press on, press off): the view zooms in and the mouse slows; '
      + 'a gun held in view moves to its aiming place (Inspector → Held in view → Aiming); a follow camera moves in over the shoulder '
      + 'and the target turns to face where it aims. Optionally a clip plays (raising the gun) and stays on its last frame until you stop aiming.',
    props: {
      press: { type: 'select', options: ['while held', 'press on/off'], default: 'while held', label: 'Aims' },
      zoom: { type: 'number', default: 20, min: 0, max: 55, step: 1, label: 'Zoom in (°)' },
      lookSpeed: { type: 'number', default: 0.6, min: 0.05, max: 2, step: 0.05, label: 'Mouse speed ×' },
      moveSpeed: { type: 'number', default: 0.6, min: 0, max: 2, step: 0.05, label: 'Move speed ×' },
      time: { type: 'number', default: 0.15, min: 0, max: 2, step: 0.01, label: 'Takes (s)' },
      closer: { type: 'number', default: 0.55, min: 0.1, max: 1, step: 0.05, label: 'Follow camera distance ×' },
      shoulder: { type: 'number', default: 0.5, min: -3, max: 3, step: 0.05, label: 'Over the shoulder (m)' },
      face: { type: 'boolean', default: true, label: 'Turn to face the aim' },
      crosshair: { type: 'select', options: ['keep', 'hide'], default: 'keep', label: 'Crosshair while aiming' },
      sprint: { type: 'boolean', default: false, label: 'Can sprint while aiming' },
      clip: { type: 'clip', default: '', label: 'Animation' },
      target: { type: 'text', default: 'self', label: 'Animation on' },
    },
  },
  shoot: {
    label: 'Shoot prefab',
    group: 'Aim & shoot',
    hint: 'Spawns a prefab and launches it. Save a prefab in the Asset Browser first. Shots vanish after Lifetime seconds. '
      + '"Aim with": the way the shooter faces; the camera — where the middle of the screen (a crosshair) points, up and down too; '
      + 'or the pointer — towards where the mouse points or the screen is tapped (top-down games). "Shots per second" above 0 keeps firing while held.',
    props: {
      prefab: { type: 'text', default: '', label: 'Prefab' },
      speed: { type: 'number', default: 20, min: 0, max: 500, step: 1, label: 'Speed' },
      lifetime: { type: 'number', default: 4, min: 0, max: 120, step: 0.5, label: 'Lifetime' },
      aim: { type: 'select', options: ['facing', 'camera', 'pointer'], default: 'facing', label: 'Aim with' },
      rate: { type: 'number', default: 0, min: 0, max: 30, step: 0.5, label: 'Shots per second (held)' },
      counts: {
        type: 'select', options: ['a shot', 'something thrown'], default: 'a shot', label: 'Counts as',
        hint: 'What it is to what it hits ("Something hits me", With): a bullet, an arrow, a rocket — or a ball, a grenade, a rock.',
      },
      loud: { type: 'number', default: 25, min: 0, max: 1000, step: 1, label: 'Heard within (m)', hint: 'Senses and Enemy AI within this hear it (0: silent — a thrown stone, an arrow)' },
      sound: { type: 'sound', default: '', label: 'Sound' },
    },
  },
  hitscan: {
    label: 'Shoot (instant hit)',
    group: 'Aim & shoot',
    hint: 'Hits straight away, like a bullet: takes Damage off the Health of what it hits and runs its "I\'m shot" rules. '
      + '"Aim with": the camera — the middle of the screen, where a crosshair is; the pointer — whatever the mouse is on (or the screen is tapped), '
      + 'within Range of the shooter; or the way the shooter faces. "Can hit": anything, the player, a group (set Groups on objects in the Inspector) '
      + 'or one object — anything else stops the shot like a wall, unless "Goes through everything else". "Also hits within" is a blast: '
      + 'what it can hit that close to where the shot lands is hit too. "Impact" is a prefab put where it lands (sparks, a mark). '
      + '"Shots per second" above 0 keeps firing while held.',
    props: {
      aim: { type: 'select', options: ['camera', 'pointer', 'facing'], default: 'camera', label: 'Aim with' },
      range: { type: 'number', default: 100, min: 1, max: 5000, step: 1, label: 'Range (m)' },
      hits: { type: 'who', default: 'any', label: 'Can hit' },
      through: { type: 'boolean', default: false, label: 'Goes through everything else' },
      splash: { type: 'number', default: 0, min: 0, max: 100, step: 0.5, label: 'Also hits within (m)' },
      damage: { type: 'number', default: 1, min: 0, max: 10000, step: 1, label: 'Damage' },
      push: { type: 'number', default: 0, min: 0, max: 100, step: 0.5, label: 'Push (m/s)' },
      rate: { type: 'number', default: 0, min: 0, max: 30, step: 0.5, label: 'Shots per second (held)' },
      impact: { type: 'text', default: '', label: 'Impact prefab' },
      impactLife: { type: 'number', default: 2, min: 0, max: 60, step: 0.5, label: 'Impact lasts (s)' },
      loud: { type: 'number', default: 30, min: 0, max: 1000, step: 1, label: 'Heard within (m)', hint: 'Senses and Enemy AI within this hear the shot (0: silent, a silencer)' },
      sound: { type: 'sound', default: '', label: 'Sound' },
    },
  },
};

for (const type of GAME_ACTION_TYPES) {
  const def = RULE_ACTIONS[type];
  const group = type.endsWith('Animation') ? 'Animation' : type === 'recoil' || type === 'attack' ? 'Aim & shoot'
    : type === 'rotate' || type === 'scale' ? 'Movement' : 'Game';
  if (def) CONTROL_ACTIONS[type] = { label: def.label, group, props: def.props, rule: true };
}
CONTROL_ACTIONS.playAnimation.hint = 'Plays one of the target\'s clips. "once" plays it through and goes back to its movement animation; '
  + '"loop" keeps going until a Stop animation; "while held" loops only while this input is held; '
  + '"while held, once" plays through and stays on its last frame until let go.';
CONTROL_ACTIONS.recoil.hint = 'Put it on the same input as a shot: the view jumps up (and a little sideways, at random) and a gun held in view kicks back, '
  + 'then settles. "Settles in" 0 leaves the aim where the kick put it, so a burst climbs. Each camera\'s view is kicked, first person or follow.';

export const ACTION_GROUPS = ['Movement', 'Interact', 'Aim & shoot', 'Animation', 'Game'];

// ---------------------------------------------------------------- data helpers

export function blankInput(type) {
  if (type === 'mouse') return { type: 'mouse', button: 'left' };
  if (type === 'screen') return { type: 'screen', label: 'A' };
  return { type: 'key', code: 'KeyE' };
}

/** A new control for the "+ Add control" button: E interacts. */
export function blankControl() {
  return normalizeControl({
    inputs: [{ type: 'key', code: 'KeyE' }],
    target: 'player',
    action: { type: 'interact' },
  });
}

/** Fill in defaults and drop anything unrecognisable, so old or hand-edited data is safe. */
export function normalizeControl(raw = {}) {
  const type = CONTROL_ACTIONS[raw?.action?.type] ? raw.action.type : 'interact';
  const inputs = (Array.isArray(raw?.inputs) ? raw.inputs : [])
    .filter((i) => i && INPUT_TYPES[i.type])
    .map((i) => ({ ...blankInput(i.type), ...i }));
  const out = {
    inputs,
    target: typeof raw?.target === 'string' && raw.target ? raw.target : 'player',
    action: withDefaults(CONTROL_ACTIONS[type].props, { ...(raw?.action || {}), type }),
  };
  // "Only if": the conditions it needs (the rules' own — rules.js), each joined to the
  // one before by AND / OR, maybe NOT (an older all / any is turned into joins)
  const only = normalizeConditions(raw?.if, raw?.match);
  if (only.length) out.if = only;
  // more to do (+ Do): rule actions, each joined to the ones before — see STEP_JOINS
  const more = (Array.isArray(raw?.more) ? raw.more : []).map(normalizeStep).filter(Boolean);
  if (more.length) out.more = more;
  branchesOf(raw, out);
  return out;
}

/**
 * An Only if's own Do's: `yes` — what happens when its conditions hold, `no` —
 * when they don't ("if ammo > 0, shoot; if not, say so"). Each is any rule
 * action, maybe a few seconds later (After). On a control and on each further Do.
 */
export const BRANCHES = Object.freeze(['yes', 'no']);

/** A Do under an Only if, cleaned: its action, and how long after (s), if at all. */
export function normalizeBranchDo(raw) {
  const type = raw?.action?.type;
  if (!RULE_ACTIONS[type]) return null;
  const out = { action: withDefaults(RULE_ACTIONS[type].props, { ...raw.action, type }) };
  const after = Number(raw.after);
  if (after > 0) out.after = Math.min(600, after);
  return out;
}

function branchesOf(raw, out) {
  for (const k of BRANCHES) {
    const list = (Array.isArray(raw?.[k]) ? raw[k] : []).map(normalizeBranchDo).filter(Boolean);
    if (list.length) out[k] = list;
  }
}

/**
 * How a control's further Do's join the ones before them:
 *   and   also, at the same moment
 *   then  also, after a wait (After, in seconds — THENs add up)
 *   or    otherwise: only if nothing before it happened — its own Do, then its
 *         ANDs and THENs (like "else if"). With no Only if of its own, it is a
 *         plain "else".
 * Each can have its own Only if. The control's first Do is its own action, and
 * its Only if the control's.
 */
export const STEP_JOINS = Object.freeze(['and', 'then', 'or']);

/** A further Do, cleaned: its join, its wait, its conditions, its action (any rule action). */
export function normalizeStep(raw) {
  const type = raw?.action?.type;
  if (!RULE_ACTIONS[type]) return null;
  const step = {
    join: STEP_JOINS.includes(raw.join) ? raw.join : 'and',
    action: withDefaults(RULE_ACTIONS[type].props, { ...raw.action, type }),
  };
  if (step.join === 'then') step.after = Math.min(600, Math.max(0, Number(raw.after ?? 0.5) || 0));
  const only = normalizeConditions(raw.if);
  if (only.length) step.if = only;
  branchesOf(raw, step);
  return step;
}

function moveControl(direction, keys, label, { speed = 8, face = true } = {}) {
  return {
    inputs: [...keys.map((code) => ({ type: 'key', code })), { type: 'screen', label }],
    target: 'player',
    action: { type: 'move', direction, speed, relative: 'world', face },
  };
}

/**
 * What a new scene starts with: WASD / arrows, Space to jump; a gamepad's left
 * stick and D-pad, A to jump; and on a touch screen a joystick and a Jump button.
 */
export function defaultControls() {
  return [
    moveControl('forward', ['KeyW', 'ArrowUp', 'PadLStickUp', 'PadUp'], '▲'),
    moveControl('back', ['KeyS', 'ArrowDown', 'PadLStickDown', 'PadDown'], '▼'),
    moveControl('left', ['KeyA', 'ArrowLeft', 'PadLStickLeft', 'PadLeft'], '◀'),
    moveControl('right', ['KeyD', 'ArrowRight', 'PadLStickRight', 'PadRight'], '▶'),
    {
      inputs: [{ type: 'key', code: 'Space' }, { type: 'key', code: 'PadA' }, { type: 'screen', label: 'Jump' }],
      target: 'player',
      action: { type: 'jump', strength: 9 },
    },
  ].map(normalizeControl);
}

/**
 * Scenes saved before controls existed stored a fixed key map on the player:
 * { controls: { forward: ['KeyW'], ... }, speed, jumpVelocity, rotateToMovement }.
 */
export function controlsFromLegacy(player) {
  const map = player?.controls;
  const hasKeys = map && typeof map === 'object' &&
    Object.values(map).some((codes) => Array.isArray(codes) && codes.length);
  if (!hasKeys) return defaultControls();

  const speed = Number(player.speed) || 8;
  const strength = Number(player.jumpVelocity) || 9;
  const face = player.rotateToMovement !== false;
  const keys = (name) => (Array.isArray(map[name]) ? map[name] : []);

  const out = [
    moveControl('forward', keys('forward'), '▲', { speed, face }),
    moveControl('back', keys('back'), '▼', { speed, face }),
    moveControl('left', keys('left'), '◀', { speed, face }),
    moveControl('right', keys('right'), '▶', { speed, face }),
    {
      inputs: [...keys('jump').map((code) => ({ type: 'key', code })), { type: 'screen', label: 'Jump' }],
      target: 'player',
      action: { type: 'jump', strength },
    },
  ];
  if (keys('fire').length) {
    out.push({
      inputs: keys('fire').map((code) => ({ type: 'key', code })),
      target: 'player',
      action: { type: 'playSound', trigger: 'fire' },
    });
  }
  return out.map(normalizeControl);
}

// ---------------------------------------------------------------- labels

const KEY_NAMES = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Escape: 'Esc',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  ShiftLeft: 'Shift', ShiftRight: 'Right Shift', ControlLeft: 'Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: 'Alt', AltRight: 'Right Alt',
  // gamepad (standard layout, Xbox names)
  PadA: 'Pad A', PadB: 'Pad B', PadX: 'Pad X', PadY: 'Pad Y', PadLB: 'Pad LB', PadRB: 'Pad RB',
  PadLT: 'Pad LT', PadRT: 'Pad RT', PadBack: 'Pad Back', PadStart: 'Pad Start',
  PadLS: 'Left stick press', PadRS: 'Right stick press',
  PadUp: 'Pad ↑', PadDown: 'Pad ↓', PadLeft: 'Pad ←', PadRight: 'Pad →',
  PadLStickUp: 'Left stick ↑', PadLStickDown: 'Left stick ↓', PadLStickLeft: 'Left stick ←', PadLStickRight: 'Left stick →',
  PadRStickUp: 'Right stick ↑', PadRStickDown: 'Right stick ↓', PadRStickLeft: 'Right stick ←', PadRStickRight: 'Right stick →',
};

/** A gamepad's button or stick, not a key on the keyboard. */
export const isPadCode = (code) => /^Pad[A-Z]/.test(String(code || ''));

export function keyLabel(code) {
  if (!code) return '—';
  return KEY_NAMES[code] ?? String(code).replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
}

export function inputLabel(input) {
  if (input.type === 'key') return keyLabel(input.code);
  if (input.type === 'mouse') return `${input.button[0].toUpperCase()}${input.button.slice(1)} click`;
  if (input.type === 'screen') return `[${input.label}]`;
  return '?';
}

/** What a control does, in a few words — as a car takes it, if `vehicle` (W the throttle, Space the handbrake). */
export function describeAction(action, { vehicle = false } = {}) {
  if (vehicle) {
    const car = { forward: 'throttle', back: 'brake / reverse', left: 'steer left', right: 'steer right' };
    if (action.type === 'move' && car[action.direction]) return car[action.direction];
    if (action.type === 'turn') return `steer ${action.direction}`;
    if (action.type === 'jump') return 'handbrake';
  }
  if (action.type === 'move' || action.type === 'turn') return `${action.type} ${action.direction}`;
  return (CONTROL_ACTIONS[action.type]?.label || action.type).toLowerCase();
}

/**
 * "W/↑ move forward · Space jump" — for an exported game's help line (keyboard and
 * mouse: a pad's names would crowd it). `vehicle`: the player is a car.
 */
export function controlsHint(list, { vehicle = false } = {}) {
  return (list || []).map((c) => {
    const keys = c.inputs.filter((i) => i.type !== 'screen' && !(i.type === 'key' && isPadCode(i.code))).map(inputLabel);
    return keys.length ? `${keys.join('/')} ${describeAction(c.action, { vehicle })}` : null;
  }).filter(Boolean).join(' · ');
}

/** The id an on-screen button reports through Input's virtual buttons. */
export const screenInputId = (controlIndex, inputIndex) => `screen:${controlIndex}:${inputIndex}`;

// ---------------------------------------------------------------- runtime

const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _box = new THREE.Box3();
const _CENTER = new THREE.Vector2(0, 0); // the middle of the screen, where a crosshair sits

/**
 * ControlRuntime — reads the inputs every Play-mode frame and performs the
 * actions. Owned by Gameplay; acts on the world through the gameplay `api`.
 */
export class ControlRuntime {
  constructor(engine, gameplay = null) {
    this.engine = engine;
    this.gameplay = gameplay;
    this.list = defaultControls();
    this.prompt = null;        // { key, text, entity } while something can be interacted with
    this._projectiles = [];    // { entity, life }
    this._failed = new Set();  // control indices that threw, so one bad control can't spam
    this._held = new Set();    // "while held" animation controls currently held
    this._aimOn = new Set();   // "press on/off" aim controls switched on
    this._nextShot = new Map(); // control index -> game time it may fire again (held fire)
    this.aiming = null;        // { target, action } while an Aim control is on
    this.lastShot = null;      // { from, to, hit } — the last instant-hit shot, for tests and debugging
    this._ray = new THREE.Raycaster();
    this._ray.params.Line.threshold = 0.05;
    this._ray.params.Points.threshold = 0.05;
  }

  load(list) {
    this.list = (Array.isArray(list) ? list : []).map(normalizeControl);
    this.reset();
  }

  toJSON() { return JSON.parse(JSON.stringify(this.list)); }

  /** Drop per-run state (not the controls themselves). */
  reset() {
    this.prompt = null;
    this._fpsFacing = null;
    this._projectiles = [];
    this._failed.clear();
    this._held?.clear();
    this._aimOn?.clear();
    this._nextShot?.clear();
    this.aiming = null;
    this.lastShot = null;
    this.engine.cameraRig?.resetAim?.();
  }

  start() { this.reset(); }

  /** Is any of this control's inputs active? Held for continuous actions, pressed otherwise. */
  isActive(control, ci, continuous) {
    const input = this.engine.input;
    if (!input) return false;
    return control.inputs.some((inp, ii) => {
      if (inp.type === 'key') return continuous ? input.isDown(inp.code) : input.wasPressed(inp.code);
      if (inp.type === 'mouse') {
        const button = Math.max(0, MOUSE_BUTTONS.indexOf(inp.button));
        if (continuous) return input.mouseDown(button);
        // A tap, not a press, so dragging to orbit the camera never fires. With
        // the mouse captured (first person) nothing drags: act on the press, as
        // a trigger should, not on the release.
        return input.pointerLocked ? input.mouseClicked(button) : input.mouseTapped(button);
      }
      if (inp.type === 'screen') {
        const id = screenInputId(ci, ii);
        return continuous ? !!input.virtualDown?.(id) : !!input.virtualPressed?.(id);
      }
      return false;
    });
  }

  /**
   * How far a control is pushed, 0..1: a key, a button or a mouse button all
   * the way; a gamepad stick or trigger, or the touch joystick, part way — so a
   * stick tilted a little walks slowly.
   */
  amount(control, ci) {
    const input = this.engine.input;
    if (!input) return 0;
    let best = 0;
    control.inputs.forEach((inp, ii) => {
      let v = 0;
      if (inp.type === 'key') v = input.value ? input.value(inp.code) : (input.isDown(inp.code) ? 1 : 0);
      else if (inp.type === 'mouse') v = input.mouseDown(Math.max(0, MOUSE_BUTTONS.indexOf(inp.button))) ? 1 : 0;
      else if (inp.type === 'screen') {
        const id = screenInputId(ci, ii);
        v = input.virtualValue ? input.virtualValue(id) : (input.virtualDown?.(id) ? 1 : 0);
      }
      if (v > best) best = v;
    });
    return best;
  }

  /** First person: the player looks where the camera looks. */
  get _firstPerson() { return this.engine.cameraRig?.mode === 'fps'; }

  /**
   * The player steers by the camera: first person, or a follow camera the mouse
   * turns. "Forward" is then where the camera faces, not a fixed direction.
   */
  get _cameraSteers() {
    const rig = this.engine.cameraRig;
    return rig?.mode === 'fps' || (rig?.mode === 'follow' && !!rig.followMouse);
  }

  update(dt, time, api) {
    if (!this.engine.input) return;
    this.prompt = null;
    if (this._firstPerson && this.engine.playerEntity?.object3D && !this.engine.playerEntity.vehicle) {
      const o = this.engine.playerEntity.object3D;
      const rig = this.engine.cameraRig;
      // turned since last frame by something else — a rule's Turn, Face towards: the view
      // turns with it (its facing is where it looks, and is set from the camera just below)
      if (this._fpsFacing?.o === o) rig.yaw += wrapAngle(yawOf(o) - this._fpsFacing.yaw);
      // facing is local +Z; the camera looks along -Z of its yaw. "Turn the view" is the view's
      // own turn from the body — a model built looking down -Z (first-person arms) wants 180 —
      // so the body keeps that turn from the view, not the view's own heading.
      setYaw(o, rig.yaw + Math.PI - THREE.MathUtils.degToRad(Number(rig.fpsTurn) || 0));
      this._fpsFacing = { o, yaw: yawOf(o) };
    } else {
      this._fpsFacing = null;
    }
    const moves = new Map(); // target -> { x, z, speed, face, f, r } (f / r: as pressed, for a car)
    const handbrakes = new Set(); // cars whose Jump is held: the handbrake
    const sprints = new Map(); // target -> { multiplier, fovBoost } while a Sprint input is held
    const crouches = new Map(); // target -> { height, speed, clip, key } while a Crouch input is on
    let aiming = null; // the first Aim control that is on: { target, action }

    this.list.forEach((control, ci) => {
      if (this._failed.has(ci)) return;
      const def = CONTROL_ACTIONS[control.action.type];
      if (!def) return;
      const target = api.resolveTarget(control.target || 'player', null, null);
      if (!target || target.alive === false || !target.object3D) return;
      const type = control.action.type;
      // its Only if's own Do's and its further Do's: which of them happen is decided now, at
      // the press, as things stand — and they are done after its own Do (a last round taken
      // by "ammo − 1" used to leave the shot itself with none, so it never went)
      const later = [];
      try {
        if (control.yes || control.no) this._controlBranches(control, ci, target, dt, time, api, later);
        if (control.more?.length) this._more(control, ci, target, dt, time, api, later); // its further Do's (+ Do)
        // "Only when": pressed (or held, for what acts while held), its conditions must hold
        // too — as its target sees them — or it is as if it weren't pressed
        if (control.if?.length && this.isActive(control, ci, this._whileHeld(control))
          && !conditionsPass(control.if, control.match, this._conditionContext(target, time))) {
          if (type === 'move') this._collectMove(moves, control, ci, target, false); // still brakes
          return;
        }
        if (type === 'move') {
          this._collectMove(moves, control, ci, target);
          return;
        }
        // a car (vehicle.js): Turn steers, Jump held is the handbrake
        if (target.vehicle && (type === 'turn' || type === 'jump')) {
          if (!this.isActive(control, ci, true)) return;
          if (type === 'jump') { handbrakes.add(target); return; }
          let move = moves.get(target);
          if (!move) moves.set(target, (move = { x: 0, z: 0, speed: 0, face: false, f: 0, r: 0 }));
          move.r += control.action.direction === 'right' ? 1 : -1;
          return;
        }
        if (type === 'sprint') {
          if (!this.isActive(control, ci, true)) return;
          const s = sprints.get(target) ?? { multiplier: 1, fovBoost: 0 };
          s.multiplier = Math.max(s.multiplier, Number(control.action.multiplier) || 1);
          s.fovBoost = Math.max(s.fovBoost, Number(control.action.fovBoost) || 0);
          sprints.set(target, s);
          return;
        }
        if (type === 'crouch') {
          const a = control.action;
          const on = a.press === 'press on/off' ? this._toggled(control, ci) : this.isActive(control, ci, true);
          if (on && !crouches.has(target)) crouches.set(target, { height: Number(a.height) || 0.55, speed: Number(a.speed ?? 0.5), clip: a.clip, key: `crouch:${ci}` });
          return;
        }
        if (type === 'aim') {
          const on = this._aimActive(control, ci);
          if (on && !aiming) aiming = { target, action: control.action };
          const a = control.action;
          const clipOn = api.resolveTarget(a.target || 'self', target, null) ?? target;
          this._holdClip(`aim:${ci}`, clipOn, a.clip, on, { loop: false });
          return;
        }
        if (type === 'playAnimation' && control.action.mode?.startsWith('while held')) {
          this._holdAnimation(control, ci, target, api);
          return;
        }
        if ((type === 'shoot' || type === 'hitscan') && Number(control.action.rate) > 0) {
          this._autoFire(control, ci, target, dt, time, api);
          return;
        }
        if (type === 'interact' && control.action.pick !== 'pointed') {
          this._updatePrompt(control, target);
        }
        if (type === 'jump') this._shortHop(control, ci, target);
        if (this.isActive(control, ci, this._whileHeld(control))) { // a turn per second: while held
          this._perform(control, target, dt, time, api);
        }
      } catch (err) {
        this._failed.add(ci);
        console.error(`[Tiny3 controls] control #${ci + 1} (${control.action.type}) failed:`, err);
      } finally {
        try {
          for (const run of later) run();
        } catch (err) {
          this._failed.add(ci);
          console.error(`[Tiny3 controls] control #${ci + 1}: a further Do failed:`, err);
        }
      }
    });

    this.aiming = aiming;
    this._applyAim(aiming);
    this._applyCrouch(crouches);

    let widen = 0;
    for (const target of handbrakes) if (!moves.has(target)) moves.set(target, { x: 0, z: 0, speed: 0, face: false, f: 0, r: 0 });
    for (const [target, move] of moves) {
      // a car takes the keys as pedals and a wheel: forward the throttle, back the brake
      // (then reverse), left and right the steering — as pressed, whatever the camera
      if (target.vehicle) {
        target.vehicle.setInput(move.f, move.r, handbrakes.has(target));
        continue;
      }
      const moving = Math.hypot(move.x, move.z) > 1e-6;
      const aimsHere = aiming?.target === target;
      // sprinting: faster, only while actually moving — and not while aiming, unless the Aim allows it
      const s = sprints.get(target);
      if (s && moving && (!aimsHere || aiming.action.sprint)) {
        move.speed *= s.multiplier;
        if (target === this.engine.playerEntity) widen = s.fovBoost;
      }
      const low = target.crouched ? this._crouchedAs.get(target) : null;
      if (low) move.speed *= Math.max(0, Number.isFinite(low.speed) ? low.speed : 0.5);
      if (aimsHere) {
        const slow = Number(aiming.action.moveSpeed);
        move.speed *= Number.isFinite(slow) ? Math.max(0, slow) : 1;
        if (this._facesAim(aiming)) move.face = false; // strafes: it faces the aim, not the way it walks
      }
      this._applyMove(target, move, dt);
    }
    // driving: the view widens with the speed (the Vehicle's "Wider view at speed")
    const car = this.engine.playerEntity?.vehicle;
    this.engine.cameraRig?.setFovBoost?.(car ? car.fovBoost : widen);
    this._updateProjectiles(dt, api);
  }

  // ---- crouching

  /** A press on/off control: on after one press, off after the next. */
  _toggled(control, ci) {
    this._on ??= new Set();
    if (this.isActive(control, ci, false)) {
      if (this._on.has(ci)) this._on.delete(ci);
      else this._on.add(ci);
    }
    return this._on.has(ci);
  }

  /**
   * Down to each crouching target's height, and those let go back up — once
   * there is room over their heads. Each frame, so a character kept down by a
   * low pipe stands as it walks out from under it.
   */
  _applyCrouch(crouches) {
    this._crouchedAs ??= new Map(); // target -> its crouch (kept while it is still down)
    const physics = this.engine.physics;
    for (const [target, c] of crouches) this._crouchedAs.set(target, c);
    for (const [target, c] of [...this._crouchedAs]) {
      const want = crouches.has(target) ? c.height : 1;
      const share = physics?.setHeight && target.rigidBody ? physics.setHeight(target, want) : want;
      const down = share < 0.999;
      target.crouched = down;
      // the eyes lower with it (cameras.js)
      const full = target.rigidBody?.standing?.full;
      const tall = full && !full.isEmpty() ? (full.max.y - full.min.y) * Math.abs(target.object3D.scale.y) : 1.8;
      target.object3D.userData.eyeDrop = down ? (1 - share) * tall : 0;
      this._holdClip(c.key, target, c.clip, down, { loop: true });
      if (!down) this._crouchedAs.delete(target);
    }
  }

  // ---- aiming

  /** Is this Aim control on? Held, or switched on and off by presses. */
  _aimActive(control, ci) {
    if (control.action.press !== 'press on/off') return this.isActive(control, ci, true);
    if (this.isActive(control, ci, false)) {
      if (this._aimOn.has(ci)) this._aimOn.delete(ci);
      else this._aimOn.add(ci);
    }
    return this._aimOn.has(ci);
  }

  /** Third person: while aiming, the target turns to where the camera looks. */
  _facesAim(aiming) {
    return !!aiming?.action.face && this.engine.cameraRig?.mode === 'follow' && aiming.target === this.engine.playerEntity;
  }

  _applyAim(aiming) {
    const rig = this.engine.cameraRig;
    // the camera aims for the player only; aiming something else still slows it and plays its clip
    const forCamera = aiming && aiming.target === this.engine.playerEntity ? aiming.action : null;
    rig?.setAim?.(forCamera && {
      zoom: Number(forCamera.zoom) || 0,
      look: Number(forCamera.lookSpeed) || 1,
      closer: Number(forCamera.closer) || 1,
      shoulder: Number(forCamera.shoulder) || 0,
      time: Number(forCamera.time) || 0,
      hideCrosshair: forCamera.crosshair === 'hide',
    });
    if (this._facesAim(aiming) && this.engine.camera) {
      this.engine.camera.getWorldDirection(_dir);
      if (Math.hypot(_dir.x, _dir.z) > 1e-4) setYaw(aiming.target.object3D, Math.atan2(_dir.x, _dir.z));
    }
  }

  // ---- movement

  /** Does it act while its input is held (moving, sprinting, rapid fire…), not just on the press? */
  _whileHeld(control) {
    const a = control.action;
    const def = CONTROL_ACTIONS[a.type];
    return !!def?.continuous || a.type === 'sprint' || (a.type === 'aim' && a.press !== 'press on/off')
      || (a.type === 'rotate' && a.how === 'per second') || (a.type === 'scale' && a.how === 'times per second')
      || (a.type === 'playAnimation' && !!a.mode?.startsWith('while held'))
      || ((a.type === 'shoot' || a.type === 'hitscan') && Number(a.rate) > 0);
  }

  /**
   * A control's further Do's (STEP_JOINS), in order. Each group — a Do and the
   * ANDs and THENs after it — happens when its first Do does; an OR group is
   * tried only if none before it happened. A Do acts when the control is
   * pressed, or each frame it's held if it acts a little each frame (a Move, a
   * turn per second).
   */
  _more(control, ci, target, dt, time, api, later = null) {
    const pressed = this.isActive(control, ci, false);
    const held = pressed || this.isActive(control, ci, true);
    if (!held) return;
    const ctx = this._conditionContext(target, time);
    const holds = (list, now) => !list?.length || conditionsPass(list, 'all', ctx, { dry: !now });
    // the first group's first Do is the control's own action: does it happen now? (its
    // cooldown, if any, is started by the control itself — asked here without starting it)
    let group = holds(control.if, false);
    let any = group;
    let wait = 0;
    const input = { pressed, held };
    const step_ = (st, wait) => (later ? later.push(() => this._step(st, target, wait, dt, time, api)) : this._step(st, target, wait, dt, time, api));
    for (const step of control.more) {
      const now = actsPerFrame(step.action) ? held : pressed;
      if (step.join === 'or') {
        wait = 0;
        if (any) { group = false; continue; } // something before it happened: not tried
        group = holds(step.if, now);
        if (group) any = true;
        if (group && now) step_(step, 0);
        this._branch(group ? step.yes : step.no, input, target, 0, dt, time, api, later);
        continue;
      }
      if (step.join === 'then') wait += step.after ?? 0;
      if (!group) continue;
      const ok = holds(step.if, now);
      if (ok && now) step_(step, wait);
      this._branch(ok ? step.yes : step.no, input, target, wait, dt, time, api, later);
    }
  }

  /**
   * A control's Only if's own Do's: "if yes" when it is pressed and its
   * conditions hold, "if not" when they don't. Asked without starting a
   * cooldown — the control's own action does that.
   */
  _controlBranches(control, ci, target, dt, time, api, later = null) {
    const pressed = this.isActive(control, ci, false);
    const held = pressed || this.isActive(control, ci, true);
    if (!held) return;
    const ok = !control.if?.length || conditionsPass(control.if, control.match, this._conditionContext(target, time), { dry: true });
    this._branch(ok ? control.yes : control.no, { pressed, held }, target, 0, dt, time, api, later);
  }

  /** Do an Only if's yes (or no) Do's: once a press — or each frame held, for what acts a little each frame. */
  _branch(list, { pressed, held }, target, wait, dt, time, api, later = null) {
    for (const sub of list || []) {
      if (!(actsPerFrame(sub.action) ? held : pressed)) continue;
      const run = () => this._step(sub, target, wait + (sub.after || 0), dt, time, api);
      if (later) later.push(run);
      else run();
    }
  }

  /** Do one of a control's further Do's — now, or after `wait` seconds. */
  _step(step, target, wait, dt, time, api) {
    const run = () => runAction(RULE_ACTIONS[step.action.type], {
      action: step.action, vars: this.engine.variables, entity: target, other: null, engine: this.engine, api, time, dt,
    });
    if (wait > 0 && api.after) api.after(wait, run);
    else run();
  }

  /** What a control's conditions see: its target is "me". */
  _conditionContext(target, time) {
    return { vars: this.engine.variables, entity: target, other: null, engine: this.engine, time };
  }

  _collectMove(moves, control, ci, target, allowed = true) {
    let move = moves.get(target);
    if (!move) moves.set(target, (move = { x: 0, z: 0, speed: 0, face: false, f: 0, r: 0 }));
    if (!allowed) return; // "Only when" says no: registered, so it brakes
    const amount = this.amount(control, ci); // a stick part way: slower
    if (!(amount > 0)) return; // still registered, so it brakes
    const action = control.action;
    const [r, f] = DIRECTION_AXES[action.direction] ?? DIRECTION_AXES.forward;
    move.f += f * amount; // as pressed (a car's pedals and steering)
    move.r += r * amount;
    // in first person (or with a mouse-turned follow camera), "forward" is where you look
    const firstPerson = this._firstPerson && target === this.engine.playerEntity;
    const steers = this._cameraSteers && target === this.engine.playerEntity;
    const relative = steers && action.relative === 'world' ? 'camera' : action.relative;
    const { fx, fz } = this._forward(relative, target);
    // right = forward × up = (-fz, fx)
    move.x += (f * fx - r * fz) * amount;
    move.z += (f * fz + r * fx) * amount;
    move.speed = Math.max(move.speed, Number(action.speed) || 0);
    if (action.face && relative !== 'self' && !firstPerson) move.face = true;
  }

  /** The horizontal "forward" direction for a move, as a unit (fx, fz). */
  _forward(relative, target) {
    if (relative === 'camera' && this.engine.camera) {
      this.engine.camera.getWorldDirection(_dir);
      const len = Math.hypot(_dir.x, _dir.z);
      if (len > 1e-4) return { fx: _dir.x / len, fz: _dir.z / len };
    } else if (relative === 'self') {
      const ry = yawOf(target.object3D);
      return { fx: Math.sin(ry), fz: Math.cos(ry) };
    }
    return { fx: 0, fz: -1 }; // world forward is -Z, into the default view
  }

  /** The target's rigid body. The player gets a dynamic one if it has none. */
  _bodyFor(target) {
    if (target.rigidBody) return target.rigidBody;
    if (target !== this.engine.playerEntity) return null;
    target.rigidBody = new RigidBody({ type: 'dynamic', mass: 70, friction: 0.1, gravity: -24, shape: 'capsule' });
    this.engine.physics?.register(target);
    return target.rigidBody;
  }

  /**
   * Movement feel's "Let go early: lower jump": the jump key let go while still
   * rising halves the rise — a tap hops, a hold leaps.
   */
  _shortHop(control, ci, target) {
    const feel = movementFeel(this.engine, target);
    const body = target.rigidBody;
    const s = feel?.state;
    if (!feel?.props.shortHop || !body || !s?.jumping || s.cut || s.jumpControl !== ci) return;
    if (this.isActive(control, ci, true) || body.velocity.y <= 0) return;
    body.velocity.y *= 0.5;
    s.cut = true;
  }

  _applyMove(target, move, dt) {
    const len = Math.hypot(move.x, move.z);
    const dx = len > 1e-6 ? move.x / len : 0;
    const dz = len > 1e-6 ? move.z / len : 0;
    // keys add up to more than 1 (W and D): full speed; a stick tilted halfway: half speed
    const speed = move.speed * Math.min(1, len);
    const body = this._bodyFor(target);
    // how quickly it gets going and stops, and how much it steers in the air:
    // its Movement feel, or the defaults (a sixth of a second, a quarter of one)
    const feel = movementFeel(this.engine, target)?.props;
    const accelTime = feel ? Math.max(0, Number(feel.accelTime) || 0) : 1 / 6;
    const brakeTime = feel ? Math.max(0, Number(feel.brakeTime) || 0) : 0.25;
    const air = feel && body && !body.grounded ? Math.min(1, Math.max(0, Number(feel.airControl) || 0)) : 1;

    if (!body || body.type !== 'dynamic') {
      // no physics to push: slide it directly
      if (!len) return;
      target.object3D.position.x += dx * speed * dt;
      target.object3D.position.z += dz * speed * dt;
      if (move.face) setYaw(target.object3D, Math.atan2(dx, dz));
      return;
    }

    if (len > 1e-6) {
      // no time to speed up (0): at full speed at once
      const accel = (accelTime > 0 ? (move.speed / accelTime) * dt : move.speed * 2) * air;
      body.velocity.x += dx * accel;
      body.velocity.z += dz * accel;
      const hs = Math.hypot(body.velocity.x, body.velocity.z);
      if (hs > speed) {
        const k = speed / hs;
        body.velocity.x *= k;
        body.velocity.z *= k;
      }
      if (move.face && air > 0) setYaw(target.object3D, Math.atan2(dx, dz));
    } else {
      // brake when nothing is held, so it doesn't slide on (in the air, only as much as it can steer)
      const brake = Math.min(1, (brakeTime > 0 ? 3 / brakeTime : Infinity) * dt) * air;
      body.velocity.x *= 1 - brake;
      body.velocity.z *= 1 - brake;
      if (Math.abs(body.velocity.x) < 0.01) body.velocity.x = 0;
      if (Math.abs(body.velocity.z) < 0.01) body.velocity.z = 0;
    }
  }

  // ---- animation held down (aiming, blocking, charging…)

  /**
   * A "while held" Play animation: loops the clip as long as any of the
   * control's inputs is held, and hands back to movement when let go. Asked
   * for every frame, so a one-off clip that briefly took over (a shot fired
   * while aiming) gives way to the held one again when it ends.
   */
  _holdAnimation(control, ci, target, api) {
    const action = control.action;
    const on = api.resolveTarget(action.target || 'self', target, null) ?? target;
    this._holdClip(ci, on, action.clip, this.isActive(control, ci, true), {
      loop: action.mode !== 'while held, once', speed: action.speed, interrupt: !!action.interrupt, sound: action.sound,
    });
  }

  /**
   * Keep `clip` playing on `on` while `held`; let it go when not. Not looping,
   * it plays through once and stays on its last frame — and if a shot took over
   * for a moment, it comes back already there rather than raising the gun again.
   */
  _holdClip(key, on, clip, held, { loop = true, speed = 1, interrupt = false, sound = '' } = {}) {
    if (!on?.object3D || !clip) return;
    if (held) {
      const player = AnimationPlayer.for(this.engine, on.object3D);
      const first = !this._held.has(key);
      this._held.add(key);
      // "Cut off others" cuts in when first pressed — not every frame, which cut every shot short
      const started = player.play(clip, { mode: 'hold', loop, atEnd: !first, speed, interrupt: interrupt && first });
      if (first && started && sound) this.engine.playSound?.(on, sound);
    } else if (this._held.delete(key)) {
      AnimationPlayer.for(this.engine, on.object3D).release(clip);
    }
  }

  // ---- one-shot and other actions

  _perform(control, target, dt, time, api) {
    const action = control.action;
    const def = CONTROL_ACTIONS[action.type];
    switch (action.type) {
      case 'turn': {
        const sign = action.direction === 'right' ? -1 : 1;
        turnYaw(target.object3D, sign * THREE.MathUtils.degToRad(Number(action.speed) || 0) * dt);
        return;
      }
      case 'jump': {
        const body = this._bodyFor(target);
        if (!body || body.type !== 'dynamic') return;
        // its Movement feel, if it has one: coyote time, a jump pressed early, jumps in the air
        const feel = movementFeel(this.engine, target);
        const jump = { strength: action.strength, sound: action.sound, ci: this.list.indexOf(control) };
        const kind = jumpKind(body, feel);
        if (kind) jumpNow(this.engine, target, body, jump, feel?.state, kind);
        else if (feel && Number(feel.props.buffer) > 0) feel.state.buffered = { ...jump, at: time };
        return;
      }
      case 'interact': {
        const found = action.pick === 'pointed'
          ? this._pointed(target, action)
          : this._nearest(target, action);
        if (found) this.gameplay?.rules.interact(found, target, api, time);
        return;
      }
      case 'shoot':
        this._shoot(target, action, api);
        return;
      case 'hitscan':
        this._hitscan(target, action, api, time);
        return;
      default:
        if (def.rule) {
          runAction(RULE_ACTIONS[action.type], {
            action, vars: this.engine.variables, entity: target, other: null,
            engine: this.engine, api, time, dt,
          });
        }
    }
  }

  _inRange(target, candidate, range) {
    if (!(range > 0)) return 0;
    target.object3D.getWorldPosition(_pos);
    _box.setFromObject(candidate.object3D);
    const d = _box.isEmpty()
      ? candidate.object3D.getWorldPosition(_dir).distanceTo(_pos)
      : _box.distanceToPoint(_pos);
    return d <= range ? d : -1;
  }

  _candidates(target) {
    const rules = this.gameplay?.rules;
    if (!rules) return [];
    return rules.interactables(target).filter((e) => e !== target && e.alive !== false && e.object3D);
  }

  /** The closest object in range that has an interact rule, or null. */
  _nearest(target, action) {
    let best = null;
    let bestD = Infinity;
    for (const c of this._candidates(target)) {
      const d = this._inRange(target, c, Number(action.range));
      if (d >= 0 && d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  /** The object under the mouse / last tap, if it has an interact rule and is in range. */
  _pointed(target, action) {
    const camera = this.engine.camera;
    const ndc = this.engine.input?.mouseNDC;
    if (!camera || !ndc) return null;
    const candidates = this._candidates(target);
    if (!candidates.length) return null;
    this._ray.setFromCamera(ndc, camera);
    const hits = this._ray.intersectObjects(candidates.map((c) => c.object3D), true);
    for (const hit of hits) {
      const owner = candidates.find((c) => {
        let n = hit.object;
        while (n) { if (n === c.object3D) return true; n = n.parent; }
        return false;
      });
      if (owner && this._inRange(target, owner, Number(action.range)) >= 0) return owner;
    }
    return null;
  }

  _updatePrompt(control, target) {
    if (this.prompt) return; // the first interact control wins
    // no "E  Open" for a door its conditions won't open (just asked: no cooldown started)
    if (control.if?.length && !conditionsPass(control.if, control.match,
      this._conditionContext(target, this.engine.time ?? 0), { dry: true })) return;
    const found = this._nearest(target, control.action);
    if (!found) return;
    const key = control.inputs.map(inputLabel)[0] || '';
    this.prompt = { key, text: this.gameplay.rules.interactPrompt(found), entity: found };
  }

  /** "Shots per second" above 0: fire while held, no faster than that. */
  _autoFire(control, ci, target, dt, time, api) {
    const held = this.isActive(control, ci, true) || this.isActive(control, ci, false);
    if (!held) return;
    const next = this._nextShot.get(ci) ?? -Infinity;
    if (time < next) return;
    this._nextShot.set(ci, time + 1 / Number(control.action.rate));
    this._perform(control, target, dt, time, api);
  }

  _shoot(target, action, api) {
    if (!action.prefab) return;
    const { origin, dir } = this._aimRay(target, action.aim, Number(action.speed) * Number(action.lifetime) || 100);
    const ry = Math.atan2(dir.x, dir.z);
    const shot = api.spawn(action.prefab, { x: origin.x + dir.x * 1.2, y: origin.y + dir.y * 1.2, z: origin.z + dir.z * 1.2 });
    if (!shot) return;
    shot.object3D.rotation.y = ry;
    if (action.sound) this.engine.playSound?.(target, action.sound);
    this._noise(target, action, action.counts === 'something thrown' ? 'a noise' : 'a shot');
    let body = shot.rigidBody;
    if (!body) {
      // a plain prefab still needs to fly: a weightless body with no drag
      body = shot.rigidBody = new RigidBody({ type: 'dynamic', mass: 1, friction: 0, gravity: 0 });
      this.engine.physics?.register(shot);
    }
    if (body.type === 'dynamic') {
      const speed = Number(action.speed) || 0;
      // aimed up or down (the camera), it flies that way; straight ahead, it keeps its own fall
      body.velocity.set(dir.x * speed, dir.y ? dir.y * speed : body.velocity.y, dir.z * speed);
    }
    if (Number(action.lifetime) > 0) this._projectiles.push({ entity: shot, life: Number(action.lifetime) });
    // what it hits is hit by a shot (or something thrown), fired by the shooter
    shot.launchedBy = { by: target, kind: action.counts === 'something thrown' ? 'something thrown' : 'a shot', until: Infinity };
  }

  /**
   * Where a shot starts and which way it goes (a unit vector):
   *   facing  — straight ahead the way the shooter faces, level
   *   camera  — at whatever is in the middle of the screen (a crosshair's spot),
   *             up and down too: from the eye in first person, else from the shooter
   *   pointer — towards where the mouse points (or the screen was last tapped), level
   */
  _aimRay(target, aim, range = 100) {
    const o = target.object3D;
    const camera = this.engine.camera;
    const origin = o.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3();
    if (aim === 'camera' && camera) {
      camera.updateMatrixWorld();
      if (this._firstPerson && target === this.engine.playerEntity) {
        camera.getWorldPosition(origin);
        return { origin, dir: camera.getWorldDirection(dir) };
      }
      this._centerOf(o, origin);
      this._ray.setFromCamera(_CENTER, camera);
      // look for the aimed-at thing from level with the shooter on: not a wall behind it, between it and the camera
      const { ray } = this._ray;
      const start = ray.at(Math.max(0, _pos.subVectors(origin, ray.origin).dot(ray.direction)), new THREE.Vector3());
      const along = ray.direction.clone();
      const point = this._castFrom(start, along, range, target)?.point ?? start.addScaledVector(along, range);
      dir.subVectors(point, origin);
      if (dir.lengthSq() > 1e-8) return { origin, dir: dir.normalize() };
    } else if (aim === 'pointer' && camera) {
      camera.updateMatrixWorld();
      const input = this.engine.input;
      this._ray.setFromCamera(input?.pointerLocked ? _CENTER : (input?.mouseNDC ?? _CENTER), camera);
      const hit = this._castFrom(this._ray.ray.origin, this._ray.ray.direction, 10000, target);
      // level with the shooter: where the pointer is over it, or where its ray crosses the shooter's height
      const point = hit?.point ?? this._ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -origin.y), new THREE.Vector3());
      if (point) {
        dir.set(point.x - origin.x, 0, point.z - origin.z);
        if (dir.lengthSq() > 1e-8) {
          dir.normalize();
          setYaw(o, Math.atan2(dir.x, dir.z)); // turns to shoot where you point
          return { origin, dir };
        }
      }
    }
    const ry = yawOf(o);
    return { origin, dir: dir.set(Math.sin(ry), 0, Math.cos(ry)) };
  }

  /** The middle of an object's bounds (its chest, near enough), or its origin. */
  _centerOf(object3D, out) {
    _box.setFromObject(object3D);
    return _box.isEmpty() ? object3D.getWorldPosition(out) : _box.getCenter(out);
  }

  /**
   * The first thing a shot from `origin` along `dir` meets within `range`:
   * { entity, point, distance }. Not the shooter, nothing hidden, no trigger
   * zones, no shots in flight — and in first person nothing held in view.
   * With `accept`, something it rejects is `blocked: true` (a wall in the
   * way) — or, `through`, passed by as if not there.
   */
  _castFrom(origin, dir, range, shooter, { accept = null, through = false } = {}) {
    const fps = this._firstPerson;
    const self = shooter?.object3D;
    const flying = new Set(this._projectiles.map((p) => p.entity));
    const within = (n, root) => { for (; n; n = n.parent) if (n === root) return true; return false; };
    const owners = new Map();
    for (const e of this.engine.entities || []) {
      if (!e.object3D || e === shooter || e.alive === false || e.object3D.isLight) continue;
      if (e.rigidBody?.isTrigger || flying.has(e) || (fps && e.viewModel)) continue;
      if (self && within(e.object3D, self)) continue; // what it carries (a gun parented to it)
      owners.set(e.object3D, e);
    }
    if (!owners.size) return null;
    this._ray.set(origin, _dir.copy(dir).normalize());
    this._ray.near = 0;
    this._ray.far = range;
    for (const hit of this._ray.intersectObjects([...owners.keys()], true)) {
      if (self && within(hit.object, self)) continue; // itself, reached through what it is parented to
      let n = hit.object;
      let entity = null;
      let hidden = false;
      while (n) {
        if (n.visible === false) hidden = true;
        if (owners.has(n)) { entity = owners.get(n); break; }
        n = n.parent;
      }
      if (entity && !hidden && entity.object3D.visible !== false) {
        const found = { entity, point: hit.point.clone(), distance: hit.distance };
        if (!accept || accept(entity)) return found;
        if (!through) return { ...found, blocked: true };
      }
    }
    return null;
  }

  /**
   * An instant-hit shot. What it can hit ("Can hit": anything, the player, a
   * group, one object) takes its damage, runs its "I'm shot" rules and is
   * pushed; anything else stops it like a wall, or is passed through. A blast
   * ("Also hits within") hits what it can hit that close to where it lands.
   */
  /** A shot heard by Senses within its "Heard within". */
  _noise(shooter, action, kind) {
    const loud = Number(action.loud ?? 30);
    if (loud > 0 && shooter?.object3D) this.gameplay?.makeNoise(shooter.object3D.getWorldPosition(new THREE.Vector3()), { loud, kind, by: shooter });
  }

  _hitscan(shooter, action, api, time) {
    const range = Number(action.range) || 100;
    const accept = (e) => matchesWho(action.hits || 'any', e, this.engine);
    const opts = { accept, through: !!action.through };
    let origin;
    let dir;
    let hit;
    if (action.aim === 'pointer' && this.engine.camera) {
      // whatever the mouse is on — as long as it is within range of the shooter
      ({ origin, dir, hit } = this._pointedShot(shooter, range, opts));
    } else {
      ({ origin, dir } = this._aimRay(shooter, action.aim, range));
      hit = this._castFrom(origin, dir, range, shooter, opts);
    }
    if (action.sound) this.engine.playSound?.(shooter, action.sound);
    this._noise(shooter, action, 'a shot');
    const lands = hit?.point ?? null;
    this.lastShot = {
      from: origin.toArray(), to: (lands ?? origin.clone().addScaledVector(dir, range)).toArray(),
      hit: hit && !hit.blocked ? hit.entity.object3D.name : null,
      blockedBy: hit?.blocked ? hit.entity.object3D.name : null,
      splashed: [],
    };
    if (!hit) return;
    const struck = [];
    if (!hit.blocked) struck.push(hit.entity);
    const splash = Number(action.splash) || 0;
    if (splash > 0) {
      for (const e of this.engine.entities || []) {
        if (e === shooter || struck.includes(e) || e.alive === false || !e.object3D || e.object3D.isLight || !accept(e)) continue;
        _box.setFromObject(e.object3D);
        const d = _box.isEmpty() ? e.object3D.getWorldPosition(_pos).distanceTo(lands) : _box.distanceToPoint(lands);
        if (d <= splash) {
          struck.push(e);
          this.lastShot.splashed.push(e.object3D.name);
        }
      }
    }
    for (const e of struck) {
      if (Number(action.damage) > 0) api.damage(e, Number(action.damage), shooter);
      this.gameplay?.rules.shot(e, shooter, api, time);
      // ...and "Something hits me (with a shot)": along the shot, or out from the blast
      const toMe = e === hit.entity ? dir.clone() : e.object3D.getWorldPosition(new THREE.Vector3()).sub(lands);
      this.gameplay?.rules.hit(e, { other: shooter, by: shooter, kind: 'a shot', speed: null, toMe }, api, time);
      const body = e.rigidBody;
      if (Number(action.push) > 0 && body?.type === 'dynamic') {
        // straight along the shot, or out from the blast
        const away = e === hit.entity ? dir : e.object3D.getWorldPosition(_pos).sub(lands).setY(0).normalize();
        body.velocity.addScaledVector(away, Number(action.push));
      }
    }
    if (action.impact) {
      const mark = api.spawn(action.impact, { x: lands.x, y: lands.y, z: lands.z });
      if (mark && Number(action.impactLife) > 0) this._projectiles.push({ entity: mark, life: Number(action.impactLife) });
    }
  }

  /** "Aim with: pointer" for an instant hit: what is under the mouse (or the last tap), within range of the shooter. */
  _pointedShot(shooter, range, opts) {
    const camera = this.engine.camera;
    const input = this.engine.input;
    camera.updateMatrixWorld();
    this._ray.setFromCamera(input?.pointerLocked ? _CENTER : (input?.mouseNDC ?? _CENTER), camera);
    const from = this._centerOf(shooter.object3D, new THREE.Vector3());
    const look = this._ray.ray.direction.clone();
    const hit = this._castFrom(this._ray.ray.origin.clone(), look, 10000, shooter, opts);
    const dir = (hit ? hit.point.clone().sub(from) : look).normalize();
    if (Math.hypot(dir.x, dir.z) > 1e-4) setYaw(shooter.object3D, Math.atan2(dir.x, dir.z)); // turns to it
    if (hit && hit.point.distanceTo(from) > range) return { origin: from, dir, hit: null }; // out of range
    return { origin: from, dir, hit };
  }

  _updateProjectiles(dt, api) {
    if (!this._projectiles.length) return;
    this._projectiles = this._projectiles.filter((p) => {
      if (p.entity.alive === false) return false;
      p.life -= dt;
      if (p.life > 0) return true;
      api.destroy(p.entity);
      return false;
    });
  }
}
