import { defaultControls, normalizeControl } from './controls.js';
import { presetSfx } from './sfx.js';
import { ENV_DEFAULTS, ENV_PRESETS } from './environment.js';
import { PROJECT_TYPE } from './project.js';
import { normalizeTerrain, terrainHeightAt, PAINTS } from './generators/terrain.js';
import { encodeBytes } from './grid-codec.js';

/**
 * Templates — complete little games to start from instead of an empty grid.
 *
 * Each is plain project data (what Save writes), built from the same pieces a
 * user has: primitives with made textures, physics bodies, components, rules,
 * made sounds, controls and variables. Nothing here is special-cased by the
 * engine, so everything in a template can be opened, changed and learnt from.
 *
 * Distances are chosen for the default player: gravity −24 and a jump of 9
 * give about 1.7 m of height and ~6 m of reach at full speed.
 */

const BOX = 1.5; // the box primitive's size: scale = wanted size / 1.5

// ---------------------------------------------------------------- pieces

function prim(primitive, name, position, scale, extra = {}) {
  return {
    type: 'primitive', primitive, name, parent: -1, position,
    rotation: extra.rotation || [0, 0, 0], scale, solid: false,
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'rotation')),
  };
}
const box = (name, pos, [w, h, d], extra) => prim('box', name, pos, [w / BOX, h / BOX, d / BOX], extra);

const solid = (friction = 0.5) => ({ type: 'static', mass: 1, restitution: 0, friction, isTrigger: false });
const trigger = (type = 'static') => ({ type, mass: 1, restitution: 0, friction: 0, isTrigger: true });
const moving = () => ({ type: 'kinematic', mass: 1, restitution: 0, friction: 0.5, isTrigger: false });
const PLAYER_BODY = { type: 'dynamic', mass: 70, restitution: 0, friction: 0.1, isTrigger: false, shape: 'capsule' };

const paint = (color, extra = {}) => ({ color, roughness: 0.8, metalness: 0, ...extra });
const glow = (color, strength = 1) => ({
  color, roughness: 0.35, metalness: 0.3, emissive: color, emissiveIntensity: strength,
});
/** A texture-maker surface that tiles by size, so scaled blocks never stretch it. */
function made(pattern, params = {}, tile = 2, extra = {}) {
  const procedural = { pattern, seed: 7, size: 512, ...params };
  return {
    color: '#ffffff', roughness: 0.9, ...extra,
    maps: {
      map: { name: pattern, procedural },
      normalMap: { name: `${pattern} bumps`, procedural, output: 'normal' },
    },
    uv: { worldScale: true, tileSize: tile },
  };
}

const sfx = (name, preset, extra = {}) => ({
  name, synth: presetSfx(preset, 11), type: 'global', bus: 'effects',
  volume: 0.7, loop: false, autoplay: false, overlap: true, pitchVary: 0.08, ...extra,
});
const ambience = (name, preset, volume) => ({
  name, synth: presetSfx(preset, 5), type: 'global', bus: 'ambience',
  volume, loop: true, autoplay: true, overlap: false,
});

const env = (preset) => ({ ...ENV_DEFAULTS, ...ENV_PRESETS[preset], preset, enabled: true, shadows: true });

/** The player: a box that bobs, leans and squashes as it moves (the Animator). */
function player(position, extra = {}) {
  const { components = [], ...rest } = extra;
  return box('Player', position, [1, 1, 1], {
    material: paint('#4dd0a6', { roughness: 0.5 }), rigidBody: PLAYER_BODY,
    components: [{ type: 'animator', props: { style: 'auto', bounce: 1 } }, ...components],
    ...rest,
  });
}

const say = (text, seconds = 3, where = 'top') => ({ type: 'showMessage', text, seconds, where });
const onStart = (...actions) => [{ when: { type: 'start' }, if: [], do: actions }];

function pickup(primitive, name, position, scale, variable, color, sound) {
  return prim(primitive, name, position, scale, {
    material: glow(color, 0.6),
    rigidBody: trigger(),
    components: [
      { type: 'collectible', props: { variable, amount: 1, who: 'player', destroy: true, sound } },
      { type: 'rotator', props: { axis: 'y', speed: 120 } },
    ],
  });
}

/** WASD / arrows move (relative to the camera), Space jumps with a sound; E to interact if asked. */
function controls({ interact = false } = {}) {
  const list = defaultControls().map((c) => {
    if (c.action.type === 'move') return { ...c, action: { ...c.action, relative: 'camera' } };
    if (c.action.type === 'jump') return { ...c, action: { ...c.action, sound: 'jump' } };
    return c;
  });
  if (interact) {
    list.push(normalizeControl({
      inputs: [{ type: 'key', code: 'KeyE' }, { type: 'screen', label: 'E' }],
      target: 'player',
      action: { type: 'interact', pick: 'nearest', range: 3 },
    }));
  }
  return list;
}

function orbitCamera({ target = null, lookAt = [0, 1, 0], theta = 0, phi = 1.05, distance = 12, playMode = null }) {
  return {
    mode: 'orbit', target, fov: 60,
    followOffset: 6, followHeight: 3, followLerp: 8, followLookUp: 1, rotateWithTarget: true,
    panSpeed: 3.5, theta, phi, distance, lookAt, orbitLockTarget: true, playMode,
  };
}

function scene({ entities, camera, environment, sceneSounds = [], shared, space = null, prefabs = undefined }) {
  const playerIdx = entities.findIndex((e) => e.name === 'Player');
  return {
    version: 1,
    meta: { app: 'Tiny3', template: true },
    camera: { ...camera, target: camera.target === 'player' ? playerIdx : (camera.target ?? -1) },
    player: { target: playerIdx },
    controls: shared.controls,
    variables: shared.variables,
    ui: shared.ui,
    environment,
    sceneSounds,
    // `space` is the room it sounds like: stone halls echo, a meadow does not
    audio: { master: 1, effects: 0.9, music: 1, ambience: 0.8, ...(space || {}) },
    prefabs, // what its rules can spawn
    entities,
  };
}

function project(levels, shared) {
  return {
    type: PROJECT_TYPE, version: 1, start: 0, current: 0, shared,
    levels: levels.map(([name, build]) => ({ name, scene: scene({ ...build(), shared }) })),
  };
}

// ---------------------------------------------------------------- 3D platformer

const GRASS = made('noise', { colorA: '#6b8e4e', colorB: '#4a6b35', scale: 8, bump: 0.5 }, 3);
const PLANKS = made('planks', { scale: 5, bump: 0.6 }, 2);
const STONE = made('tiles', { colorA: '#c7c9cf', colorB: '#8b939e', scale: 4 }, 2);

/** Falling in: lose a life and restart the level — or, on the last life, lose. */
const WATER_RULES = [
  { // checked first, so the rule below cannot drop lives to 1 and then trip this one
    when: { type: 'triggerEnter', who: 'player' },
    if: [{ type: 'variable', name: 'lives', op: '<=', value: 1 }],
    do: [{ type: 'setVariable', name: 'lives', value: 0 }, { type: 'lose', message: 'Out of lives!' }],
  },
  {
    when: { type: 'triggerEnter', who: 'player' },
    if: [{ type: 'variable', name: 'lives', op: '>', value: 1 }],
    do: [
      { type: 'changeVariable', name: 'lives', by: -1 },
      { type: 'playSound', sound: 'splash', target: 'self' },
      { type: 'goToLevel', level: 'this' },
    ],
  },
];

const water = () => box('Water', [0, -7, -15], [90, 2, 90], {
  material: paint('#2f7bbf', { roughness: 0.15, opacity: 0.85, alphaMode: 'blend' }),
  rigidBody: trigger(), rules: WATER_RULES,
});
const coin = (n, pos) => pickup('torus', `Coin ${n}`, pos, [0.3, 0.3, 0.3], 'coins', '#f6c343', 'coin');
const goalRing = (pos) => prim('torus', 'Goal ring', pos, [1, 1, 1], {
  material: glow('#f6c343', 1.2),
  rigidBody: trigger(),
  components: [
    { type: 'levelExit', props: { level: 'next', who: 'player' } },
    { type: 'rotator', props: { axis: 'y', speed: 60 } },
  ],
});
const tree = (n, x, z) => [
  prim('cylinder', `Tree ${n} trunk`, [x, 0.72, z], [0.4, 0.8, 0.4], { material: paint('#6b4a2b'), rigidBody: solid() }),
  prim('cone', `Tree ${n}`, [x, 2.44, z], [1.2, 1, 1.2], { material: paint('#3f7a3a', { roughness: 0.9 }) }),
];
const platformerSounds = () => [
  sfx('coin', 'coin'), sfx('jump', 'jump', { volume: 0.5 }), sfx('splash', 'hit'),
  ambience('wind', 'wind', 0.25),
];

function meadow() {
  return {
    environment: env('day'),
    camera: orbitCamera({ target: 'player', lookAt: [0, 1, 2], phi: 1.05, distance: 12 }),
    sceneSounds: platformerSounds(),
    entities: [
      box('Start island', [0, -1, 0], [10, 2, 10], {
        material: GRASS, rigidBody: solid(), rules: onStart(say('Reach the golden ring!')),
      }),
      ...tree(1, -3.5, 3),
      ...tree(2, 3.5, 2.5),
      // a slope to walk up (20.6°) to a lookout with a coin on it
      box('Ramp', [7.07, 0.563, 0], [4.4, 0.4, 2.5], {
        rotation: [0, 0, Math.atan2(1.5, 4)], material: PLANKS, rigidBody: solid(),
      }),
      box('Lookout', [10.25, 1.2, 0], [2.5, 0.6, 2.5], { material: STONE, rigidBody: solid() }),
      coin(6, [10.25, 2.1, 0]),
      box('Platform 1', [0, 0.4, -8], [3, 0.6, 3], { material: PLANKS, rigidBody: solid() }),
      box('Platform 2', [3, 1.2, -13], [3, 0.6, 3], { material: PLANKS, rigidBody: solid() }),
      box('Moving platform', [0, 1.8, -18], [4, 0.6, 3], {
        material: STONE, rigidBody: moving(),
        components: [{ type: 'mover', props: { axis: 'x', distance: 2, speed: 0.8 } }],
      }),
      box('Platform 4', [0, 2.4, -23], [3, 0.6, 3], { material: PLANKS, rigidBody: solid() }),
      box('Goal island', [0, 2.2, -30], [6, 1, 6], { material: GRASS, rigidBody: solid() }),
      goalRing([0, 4, -30]),
      coin(1, [2, 1, 2]), coin(2, [-2, 1, 2]), coin(3, [0, 1.5, -8]), coin(4, [3, 2.3, -13]), coin(5, [0, 3.5, -23]),
      water(),
      player([0, 1.5, 2]),
    ],
  };
}

function sunsetHeights() {
  return {
    environment: env('golden'),
    camera: orbitCamera({ target: 'player', lookAt: [0, 1, 1], phi: 1.05, distance: 12 }),
    sceneSounds: platformerSounds(),
    entities: [
      box('Start island', [0, -1, 0], [8, 2, 8], {
        material: GRASS, rigidBody: solid(), rules: onStart(say('Last stretch — climb to the ring!')),
      }),
      box('Platform 1', [3, 0.6, -7], [2.5, 0.6, 2.5], { material: PLANKS, rigidBody: solid() }),
      box('Platform 2', [-1, 1.4, -11], [2.5, 0.6, 2.5], { material: PLANKS, rigidBody: solid() }),
      box('Moving platform', [-1, 2, -16], [3.5, 0.6, 2.5], {
        material: STONE, rigidBody: moving(),
        components: [{ type: 'mover', props: { axis: 'x', distance: 2.5, speed: 1 } }],
      }),
      box('Platform 4', [3, 2.8, -20.5], [2.5, 0.6, 2.5], { material: PLANKS, rigidBody: solid() }),
      box('Platform 5', [0, 3.6, -25], [2.5, 0.6, 2.5], { material: PLANKS, rigidBody: solid() }),
      box('Goal island', [0, 3.4, -31], [6, 1, 6], { material: GRASS, rigidBody: solid() }),
      goalRing([0, 5.2, -31]),
      coin(1, [3, 1.8, -7]), coin(2, [-1, 2.6, -11]), coin(3, [3, 4, -20.5]), coin(4, [0, 4.8, -25]), coin(5, [-2, 4.5, -31]),
      water(),
      player([0, 1.5, 1]),
    ],
  };
}

// ---------------------------------------------------------------- top-down collector

function garden() {
  const wall = made('bricks', { colorA: '#8a8f98', colorB: '#5b606a', scale: 6, variation: 0.2 }, 1.5);
  const rock = made('noise', { colorA: '#7d7468', colorB: '#5a5248', scale: 6, bump: 1 }, 1.5);
  const gems = [
    [-12, -12], [0, -12], [12, -12], [-12, 0], [12, 0], [-12, 12],
    [0, 12], [12, 12], [-4, 4], [4, -4], [9, -8], [-9, -8],
  ];
  const slime = (n, [x, z]) => prim('sphere', `Slime ${n}`, [x, 0.45, z], [0.6, 0.45, 0.6], {
    material: paint('#f47067', { roughness: 0.35 }),
    rigidBody: trigger('kinematic'),
    components: [
      { type: 'follower', props: { target: 'player', speed: 2.2, stopAt: 0, turnToFace: true } },
      { type: 'damager', props: { amount: 1, who: 'player', cooldown: 1.2, sound: 'hurt' } },
    ],
  });
  return {
    environment: env('day'),
    camera: orbitCamera({ target: 'player', lookAt: [0, 0, 0], phi: 0.55, distance: 20 }),
    sceneSounds: [sfx('coin', 'coin'), sfx('hurt', 'hit'), sfx('jump', 'jump', { volume: 0.4 })],
    entities: [
      box('Ground', [0, -0.5, 0], [30, 1, 30], {
        material: made('noise', { colorA: '#79a35a', colorB: '#5b8543', scale: 10, bump: 0.4 }, 3),
        rigidBody: solid(),
        components: [{ type: 'timer', props: { variable: 'time', from: 60, direction: 'down', stopAtZero: true } }],
        rules: [
          ...onStart(say('Collect all 12 gems before time runs out!')),
          { when: { type: 'variable', name: 'gems', op: '>=', value: 12 }, if: [], do: [{ type: 'win', message: 'All gems collected!' }] },
          { when: { type: 'variable', name: 'time', op: '<=', value: 0 }, if: [], do: [{ type: 'lose', message: "Time's up!" }] },
          { when: { type: 'variable', name: 'health', op: '<=', value: 0 }, if: [], do: [{ type: 'lose', message: 'The slimes got you!' }] },
        ],
      }),
      box('Wall north', [0, 1, -15.5], [32, 2, 1], { material: wall, rigidBody: solid() }),
      box('Wall south', [0, 1, 15.5], [32, 2, 1], { material: wall, rigidBody: solid() }),
      box('Wall east', [15.5, 1, 0], [1, 2, 30], { material: wall, rigidBody: solid() }),
      box('Wall west', [-15.5, 1, 0], [1, 2, 30], { material: wall, rigidBody: solid() }),
      box('Rock 1', [-6, 0.75, -4], [3, 1.5, 2], { material: rock, rigidBody: solid() }),
      box('Rock 2', [7, 0.75, 5], [2, 1.5, 4], { material: rock, rigidBody: solid() }),
      box('Rock 3', [2, 0.75, -9], [4, 1.5, 1.5], { material: rock, rigidBody: solid() }),
      box('Rock 4', [-8, 0.75, 8], [2.5, 1.5, 2.5], { material: rock, rigidBody: solid() }),
      ...gems.map(([x, z], i) => pickup('sphere', `Gem ${i + 1}`, [x, 0.8, z], [0.3, 0.4, 0.3], 'gems', '#b083f0', 'coin')),
      slime(1, [-12, 6]), slime(2, [12, -6]), slime(3, [0, -13.5]),
      player([0, 1, 0], {
        components: [{ type: 'health', props: { max: 3, destroyAtZero: false, mirrorTo: 'health' } }],
      }),
    ],
  };
}

// ---------------------------------------------------------------- first-person explorer

function temple() {
  const wall = made('bricks', { colorA: '#b89b6a', colorB: '#7d6a4a', scale: 8, variation: 0.3 }, 1.5);
  const floor = made('tiles', { colorA: '#c9b48a', colorB: '#8c7a5a', scale: 4, variation: 0.15 }, 2);
  const stone = made('noise', { colorA: '#9c8f7a', colorB: '#6f6453', scale: 6, bump: 0.8 }, 1);
  const torch = (n, [x, y, z]) => [
    box(`Torch ${n}`, [x, y, z], [0.3, 0.4, 0.3], { material: glow('#ff9a3c', 2.5) }),
    {
      type: 'light', lightType: 'point', name: `Torch ${n} light`, parent: -1,
      position: [x, y + 0.2, z], rotation: [0, 0, 0], scale: [1, 1, 1],
      color: '#ff9a3c', intensity: 18, distance: 11, castShadow: false,
    },
  ];
  const relic = (n, [x, z]) => [
    box(`Pedestal ${n}`, [x, 0.5, z], [1, 1, 1], { material: stone, rigidBody: solid() }),
    pickup('cone', `Relic ${n}`, [x, 1.45, z], [0.3, 0.4, 0.3], 'relics', '#f6c343', 'chime'),
  ];
  const pillar = (n, x, z) => prim('cylinder', `Pillar ${n}`, [x, 1.8, z], [0.6, 2, 0.6], { material: stone, rigidBody: solid() });
  return {
    environment: env('golden'),
    camera: orbitCamera({ target: null, lookAt: [0, 0, -1], phi: 0.75, distance: 26, playMode: 'fps' }),
    space: { space: 'hall', spaceAmount: 0.45 }, // stone walls: everything echoes
    sceneSounds: [sfx('chime', 'powerup'), sfx('open', 'explosion', { volume: 0.5 }), sfx('jump', 'jump', { volume: 0.35 }),
      ambience('wind', 'wind', 0.3)],
    entities: [
      box('Floor', [0, -0.5, -1], [22, 1, 28], { material: floor, rigidBody: solid() }),
      box('Wall north', [0, 2, -15], [22, 4, 1], { material: wall, rigidBody: solid() }),
      box('Wall south', [0, 2, 13], [22, 4, 1], { material: wall, rigidBody: solid() }),
      box('Wall east', [10.5, 2, -1], [1, 4, 28], { material: wall, rigidBody: solid() }),
      box('Wall west', [-10.5, 2, -1], [1, 4, 28], { material: wall, rigidBody: solid() }),
      box('Divider left', [-5.75, 2, 2], [9.5, 4, 1], { material: wall, rigidBody: solid() }),
      box('Divider right', [5.75, 2, 2], [9.5, 4, 1], { material: wall, rigidBody: solid() }),
      box('Lintel', [0, 3.75, 2], [2, 0.5, 1], { material: wall, rigidBody: solid() }),
      box('Door', [0, 1.75, 2], [2, 3.5, 0.8], {
        material: made('planks', { colorA: '#5c3d22', colorB: '#2e1d10', scale: 4 }, 1), rigidBody: solid(),
      }),
      box('Lever base', [6, 0.5, 9], [1, 1, 1], { material: stone, rigidBody: solid() }),
      prim('cylinder', 'Lever', [6, 1.3, 9], [0.15, 0.5, 0.15], {
        rotation: [0, 0, 0.5],
        material: paint('#c0392b', { roughness: 0.4 }),
        rules: [{
          when: { type: 'interact', who: 'player', prompt: 'Pull the lever' },
          if: [],
          do: [
            { type: 'destroy', target: 'Door' },
            { type: 'playSound', sound: 'open', target: 'self' },
            say('The door grinds open…', 2.5, 'middle'),
            { type: 'setVariable', name: '_doorOpen', value: 1 },
          ],
        }],
      }),
      pillar(1, -3, -6), pillar(2, 3, -6), pillar(3, -3, -10), pillar(4, 3, -10),
      ...relic(1, [-7, -4]), ...relic(2, [7, -8]), ...relic(3, [-6, -12]),
      prim('torus', 'Exit portal', [0, 1.8, -13.8], [1, 1, 1], {
        material: glow('#39c5cf', 1.5),
        rigidBody: trigger(),
        components: [{ type: 'rotator', props: { axis: 'z', speed: 45 } }],
        rules: [{
          when: { type: 'triggerEnter', who: 'player' },
          if: [{ type: 'variable', name: 'relics', op: '>=', value: 3 }],
          do: [{ type: 'win', message: 'You escaped with every relic!' }],
        }, {
          when: { type: 'triggerEnter', who: 'player' },
          if: [{ type: 'variable', name: 'relics', op: '<', value: 3 }],
          do: [say('The portal is dark — it needs all three relics.', 3, 'middle')],
        }],
      }),
      ...torch(1, [-9.8, 2.6, 8]), ...torch(2, [9.8, 2.6, 5]), ...torch(3, [-9.8, 2.6, -6]), ...torch(4, [9.8, 2.6, -11]),
      // the player's body is invisible — you are looking out of it
      player([0, 1, 10], { material: paint('#4dd0a6', { opacity: 0, alphaMode: 'cutout' }) }),
    ],
  };
}

// ---------------------------------------------------------------- car racing

/**
 * A car: its body (a box — the Vehicle's root), a cabin on top, four tyres the
 * Vehicle finds by name. They are its children, so they are written in its own
 * (scaled) space: each size and place divided by the body's scale.
 */
function car(name, color, [x, z], extra = {}) {
  const size = [1.9, 0.7, 4.2];
  const s = size.map((v) => v / BOX); // the body's scale
  const root = box(name, [x, 0.95, z], size, {
    material: paint(color, { roughness: 0.35, metalness: 0.4 }),
    rigidBody: { type: 'dynamic', mass: 1200, restitution: 0, friction: 0.5, isTrigger: false },
    components: [{ type: 'vehicle', props: { speedVariable: 'speed', topSpeed: 140, accelTime: 4.5 } }],
    ...extra,
  });
  const local = (offset) => offset.map((v, i) => v / s[i]);
  const cabin = box(`${name} cabin`, local([0, 0.6, -0.3]), [1.6 / s[0], 0.55 / s[1], 2 / s[2]], {
    material: paint('#1f2630', { roughness: 0.2, metalness: 0.6 }),
  });
  cabin.childOf = root;
  // a cylinder turned onto its side (axle across): its height runs along x, its round in y and z
  const tyres = [['FL', 0.9, 1.35], ['FR', -0.9, 1.35], ['RL', 0.9, -1.35], ['RR', -0.9, -1.35]].map(([tag, tx, tz]) => {
    const t = prim('cylinder', `${name} tire ${tag}`, local([tx, -0.57, tz]), [0.38 / (0.7 * s[1]), 0.28 / (1.8 * s[0]), 0.38 / (0.7 * s[2])], {
      rotation: [0, 0, Math.PI / 2], material: paint('#141414', { roughness: 0.9 }),
    });
    t.childOf = root;
    return t;
  });
  return [root, cabin, ...tyres];
}

/** Children point at their parent by its place in the list. */
function linkParents(entities) {
  for (const e of entities) {
    if (!e.childOf) continue;
    e.parent = entities.indexOf(e.childOf);
    delete e.childOf;
  }
  return entities;
}

function circuit() {
  const asphalt = made('noise', { colorA: '#3a3d42', colorB: '#2c2f33', scale: 14, bump: 0.2 }, 4, { roughness: 0.95 });
  const grass = made('noise', { colorA: '#5f8f45', colorB: '#4a7536', scale: 10, bump: 0.3 }, 4);
  const wallTex = made('bricks', { colorA: '#d9d9d9', colorB: '#c0392b', scale: 3 }, 2);
  const road = (name, pos, size) => box(name, pos, size, { material: asphalt, rigidBody: solid(0.9) });
  const wall = (name, pos, size) => box(name, pos, size, { material: wallTex, rigidBody: solid(0.3) });
  // the gates: see-through banners the cars drive through — the Race reads them in name order
  const gate = (name, [x, z], across, color, extra = {}) => box(name, [x, 1.5, z], across === 'x' ? [16, 3, 1] : [1, 3, 16], {
    material: paint(color, { opacity: 0.35, alphaMode: 'blend', emissive: color, emissiveIntensity: 0.4 }), ...extra,
  });
  const entities = [
    box('Grass', [40, -0.5, 40], [300, 1, 300], {
      material: grass, rigidBody: solid(0.6),
      rules: onStart(say('3 laps — finish first to win! R puts you back on the track.', 4, 'top')),
    }),
    // a square circuit: up the west straight, across the north, down the east, back along the south
    road('Road west', [0, 0.02, 40], [14, 0.04, 116]),
    road('Road north', [40, 0.02, 80], [94, 0.04, 14]),
    road('Road east', [80, 0.02, 40], [14, 0.04, 116]),
    road('Road south', [40, 0.02, 0], [94, 0.04, 14]),
    // barriers round the outside, and round the infield
    wall('Barrier west', [-10, 0.5, 40], [1, 1, 130]),
    wall('Barrier east', [90, 0.5, 40], [1, 1, 130]),
    wall('Barrier north', [40, 0.5, 90], [101, 1, 1]),
    wall('Barrier south', [40, 0.5, -25], [101, 1, 1]),
    wall('Infield west', [10, 0.5, 40], [1, 1, 60]),
    wall('Infield east', [70, 0.5, 40], [1, 1, 60]),
    wall('Infield north', [40, 0.5, 70], [61, 1, 1]),
    wall('Infield south', [40, 0.5, 10], [61, 1, 1]),
    ...tree(1, 25, 30), ...tree(2, 52, 45), ...tree(3, 38, 58), ...tree(4, 60, 22), ...tree(5, 22, 55),
    gate('Start line', [0, 0], 'x', '#ffffff', {
      components: [{ type: 'race', props: { checkpoints: 'Checkpoints', laps: 3, countdown: 3, winPlaces: 1, skill: 88, catchUp: true } }],
    }),
    gate('Checkpoint 1', [0, 80], 'x', '#ffd54f', { groups: ['Checkpoints'] }),
    gate('Checkpoint 2', [80, 80], 'z', '#ffd54f', { groups: ['Checkpoints'] }),
    gate('Checkpoint 3', [80, 0], 'z', '#ffd54f', { groups: ['Checkpoints'] }),
    // the grid: behind the line, facing up the straight (+Z)
    ...car('Player', '#e53935', [-2.6, -6]),
    ...car('Rival 1', '#1e88e5', [2.6, -6]),
    ...car('Rival 2', '#43a047', [-2.6, -13]),
    ...car('Rival 3', '#fdd835', [2.6, -13]),
  ];
  return {
    environment: env('day'),
    camera: orbitCamera({ target: 'player', lookAt: [0, 1, -6], phi: 0.95, distance: 20, playMode: 'follow' }),
    sceneSounds: [ambience('wind', 'wind', 0.15)],
    entities: linkParents(entities),
  };
}

// ---------------------------------------------------------------- first-person shooter

/**
 * AK Arena: a warehouse, four robots, an AK74u held in view. Made from models,
 * not just shapes — the template names their files (assetUrl), and opening it
 * brings them into the game's own store (see game.js startNewGame), so it saves
 * and exports with them like any imported model.
 *
 *   the gun     — Held in view, its clips played by the controls: SHOOT on a
 *                 shot, RELOAD1 on R; IDLE while you walk (the Animator, moving
 *                 with the player)
 *   ammo        — variables: ammo (in the magazine), mags (spare); a shot only
 *                 with ammo left and not reloading (_reloading hides it from the HUD)
 *   robots      — Follower to chase, Animator for their clips, Health 3 (three
 *                 bullets); a rule punches (Hit / attack) when they are close
 *   the player  — Health 5, copied to the health bar; at 0 the game is lost
 */
const AK_MODEL = 'assets/ak74u.glb';
const ROBOT_MODEL = 'assets/robot.glb';
const ROBOT_SCALE = 0.3757; // robot.glb is 4.79 units tall: 1.8 m
const AK_RELOAD = 2.2; // seconds: RELOAD1 is 2.23 s long

function model(name, assetUrl, position, scale, extra = {}) {
  return {
    type: 'model', assetUrl, name, parent: -1, position,
    rotation: extra.rotation || [0, 0, 0], scale: [scale, scale, scale], solid: false,
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'rotation')),
  };
}

function robot(n, [x, z], ry = 0) {
  return model(`Robot ${n}`, ROBOT_MODEL, [x, 0, z], ROBOT_SCALE, {
    rotation: [0, ry, 0],
    groups: ['Enemies'],
    rigidBody: { type: 'dynamic', mass: 80, restitution: 0, friction: 0.1, isTrigger: false, shape: 'capsule' },
    components: [
      { type: 'follower', props: { target: 'player', speed: 2.6, stopAt: 1.6, turnToFace: true, avoid: true } },
      { type: 'animator', props: { style: 'clips', idle: 'Idle', walk: 'Walking', run: 'Running', runSpeed: 4, follow: 'self', blend: 0.2 } },
      // three bullets; it falls over (its Death clip) before it goes
      { type: 'health', props: { max: 3, atZero: 'destroy', delay: 1.1, mirrorTo: '' } },
    ],
    rules: [
      // close enough: a punch, once a second, while it still stands
      { when: { type: 'update', every: 1 }, if: [
        { type: 'near', who: 'self', of: 'player', distance: 2.3 },
        { type: 'health', op: '>', value: 0, join: 'and' },
      ], do: [
        { type: 'playAnimation', clip: 'Punch', target: 'self', mode: 'once', speed: 1.2, interrupt: true },
        { type: 'attack', aim: 'in front', reach: 2.4, arc: 120, all: false, hits: 'player', damage: 1, push: 5, sound: 'punch' },
      ] },
      { when: { type: 'hitBy', with: 'a shot', who: 'any', by: 'player', harder: 0, from: 'anywhere', speedTo: '', part: '' }, if: [],
        do: [{ type: 'playSound', sound: 'clank', target: 'self' }] },
      { when: { type: 'healthOut', who: 'any' }, if: [], do: [
        { type: 'playAnimation', clip: 'Death', target: 'self', mode: 'once', speed: 1, interrupt: true },
        { type: 'changeVariable', name: 'robots', by: -1 },
        { type: 'playSound', sound: 'down', target: 'self' },
      ] },
    ],
  });
}

function warehouse() {
  const concrete = made('noise', { colorA: '#7b7f86', colorB: '#5c6068', scale: 8, bump: 0.5 }, 3);
  const brick = made('bricks', { colorA: '#8d5a45', colorB: '#5e3a2c', scale: 6, variation: 0.25 }, 2);
  const planks = made('planks', { colorA: '#a7783f', colorB: '#6e4b25', scale: 4, variation: 0.3 }, 1.2);
  const wall = (name, at, size) => box(name, at, size, { material: brick, rigidBody: solid() });
  const crate = (n, at, size) => box(`Crate ${n}`, at, size, { material: planks, rigidBody: solid() });
  const ammoBox = (n, at) => box(`Ammo box ${n}`, at, [0.7, 0.45, 0.45], {
    material: paint('#c9a227', { metalness: 0.3 }), rigidBody: trigger(),
    components: [
      { type: 'collectible', props: { variable: 'mags', amount: 1, who: 'player', destroy: true, sound: 'pickup' } },
      { type: 'rotator', props: { axis: 'y', speed: 60 } },
    ],
  });
  const place = { position: [0, -1.65, -0.15], rotation: [0, 0, 0] }; // the rig's eye is 1.65 m up, 0.15 m back
  return {
    environment: env('day'),
    camera: {
      ...orbitCamera({ target: null, lookAt: [0, 0, 0], phi: 1.1, distance: 30, playMode: 'fps' }),
      settings: { eyeHeight: 0.75, eyeForward: 0, fovFps: 75, pitchLimit: 80 },
    },
    space: { space: 'hall', spaceAmount: 0.3 },
    sceneSounds: [
      sfx('shoot', 'shoot', { volume: 0.6 }), sfx('clank', 'hit', { volume: 0.6 }), sfx('punch', 'hit', { volume: 0.8 }),
      sfx('hurt', 'hit', { volume: 0.9 }), sfx('down', 'explosion', { volume: 0.6 }), sfx('empty', 'click', { volume: 0.6 }),
      sfx('reload', 'click', { volume: 0.5 }), sfx('pickup', 'powerup', { volume: 0.6 }), sfx('jump', 'jump', { volume: 0.35 }),
    ],
    entities: [
      box('Floor', [0, -0.5, 0], [40, 1, 40], {
        material: concrete, rigidBody: solid(),
        rules: [
          ...onStart(say('Clear the warehouse: 4 robots. Click to shoot · R reloads', 4)),
          { when: { type: 'variable', name: 'robots', op: '<=', value: 0 }, if: [], do: [{ type: 'win', message: 'Warehouse cleared!' }] },
        ],
      }),
      wall('Wall north', [0, 2, -20.5], [42, 4, 1]),
      wall('Wall south', [0, 2, 20.5], [42, 4, 1]),
      wall('Wall east', [20.5, 2, 0], [1, 4, 40]),
      wall('Wall west', [-20.5, 2, 0], [1, 4, 40]),
      crate(1, [-5, 0.75, -4], [3, 1.5, 1.5]),
      crate(2, [6, 0.75, -6], [1.5, 1.5, 3]),
      crate(3, [-9, 1, 6], [2, 2, 2]),
      crate(4, [9, 0.6, 5], [2.4, 1.2, 1.2]),
      crate(5, [0, 1.25, -11], [5, 2.5, 1]),
      box('Pillar 1', [-12, 2, -10], [1.2, 4, 1.2], { material: concrete, rigidBody: solid() }),
      box('Pillar 2', [12, 2, -10], [1.2, 4, 1.2], { material: concrete, rigidBody: solid() }),
      ammoBox(1, [-14, 0.3, 12]),
      ammoBox(2, [14, 0.3, -15]),
      robot(1, [-10, -12]), robot(2, [10, -13]), robot(3, [0, -17]), robot(4, [-15, -2], Math.PI / 2),
      // five hits and down: no Animator — first person, you never see yourself
      box('Player', [0, 0.9, 12], [0.7, 1.7, 0.7], {
        material: paint('#4dd0a6'), rigidBody: PLAYER_BODY,
        components: [{ type: 'health', props: { max: 5, atZero: 'nothing', delay: 0, mirrorTo: 'health' } }],
        rules: [
          { when: { type: 'hurt', who: 'any' }, if: [], do: [
            { type: 'shakeCamera', strength: 0.25, seconds: 0.25 }, { type: 'playSound', sound: 'hurt', target: 'self' }] },
          { when: { type: 'healthOut', who: 'any' }, if: [], do: [{ type: 'lose', message: 'You died — the robots got you.' }] },
        ],
      }),
      // the gun, held in first-person view; its Animator idles it as the player moves
      model('AK74u', AK_MODEL, [0, 0, 14], 1, {
        viewModel: { ...place, scale: 1, aim: { ...place } },
        components: [{ type: 'animator', props: { style: 'clips', idle: 'IDLE', walk: 'IDLE', follow: 'player', blend: 0.15 } }],
      }),
    ],
  };
}

/** WASD where you look, Space jumps; a click shoots (with ammo, not while reloading), R reloads. */
function shooterControls() {
  const ammoLeft = { type: 'variable', name: 'ammo', op: '>', value: 0 };
  const notReloading = { type: 'variable', name: '_reloading', op: '==', value: 0, join: 'and' };
  const extra = [
    {
      inputs: [{ type: 'mouse', button: 'left' }, { type: 'screen', label: 'Fire' }], target: 'player',
      action: { type: 'hitscan', aim: 'camera', range: 150, hits: 'any', damage: 1, push: 0, rate: 0, sound: 'shoot' },
      if: [ammoLeft, notReloading],
      more: [
        { join: 'and', action: { type: 'changeVariable', name: 'ammo', by: -1 } },
        { join: 'and', action: { type: 'playAnimation', clip: 'SHOOT', target: 'AK74u', mode: 'once', interrupt: true } },
        { join: 'and', action: { type: 'recoil' } },
      ],
    },
    {
      inputs: [{ type: 'mouse', button: 'left' }], target: 'player',
      action: { type: 'showMessage', text: 'Out of ammo — press R to reload', seconds: 1.2, where: 'bottom' },
      if: [{ type: 'variable', name: 'ammo', op: '<=', value: 0 }, notReloading],
      more: [{ join: 'and', action: { type: 'playSound', sound: 'empty', target: 'self' } }],
    },
    {
      inputs: [{ type: 'key', code: 'KeyR' }, { type: 'screen', label: 'R' }], target: 'player',
      action: { type: 'setVariable', name: '_reloading', value: 1 },
      if: [{ type: 'variable', name: 'ammo', op: '<', value: 30 }, { type: 'variable', name: 'mags', op: '>', value: 0, join: 'and' }, notReloading],
      more: [
        { join: 'and', action: { type: 'playAnimation', clip: 'RELOAD1', target: 'AK74u', mode: 'once', interrupt: true } },
        { join: 'and', action: { type: 'playSound', sound: 'reload', target: 'self' } },
        { join: 'then', after: AK_RELOAD, action: { type: 'setVariable', name: 'ammo', value: 30 } },
        { join: 'and', action: { type: 'changeVariable', name: 'mags', by: -1 } },
        { join: 'and', action: { type: 'setVariable', name: '_reloading', value: 0 } },
      ],
    },
    {
      inputs: [{ type: 'key', code: 'KeyR' }], target: 'player',
      action: { type: 'showMessage', text: 'No magazines left', seconds: 1.2, where: 'bottom' },
      if: [{ type: 'variable', name: 'mags', op: '<=', value: 0 }, { type: 'variable', name: 'ammo', op: '<', value: 30, join: 'and' }],
    },
  ];
  return [...controls(), ...extra.map(normalizeControl)];
}

// ---------------------------------------------------------------- horror: a short story in a small house

/**
 * Hollow House: Gran's house, at night. A note tells you where her music box is
 * and where the key to her bedroom is; a vase falls as you step into the
 * kitchen; the key opens the bedroom door (about its hinge); taking the music
 * box kills the lights, lets something out in the kitchen, and the front door
 * creaks open. Get out before it touches you.
 *
 *   the story   — messages from rules: on start, on reading the note (E), on each find
 *   the dark    — night outside, three dim lamps (group Lamps) and a lantern glow
 *                 carried by the player (a light parented to it); one lamp flickers
 *                 (two Random chance rules hide and show it)
 *   the ghost   — a prefab (a robe and a head), spawned at a hidden marker when the
 *                 music box is taken: it chases (Follower) and touching you loses
 *   the scares  — a Push on a vase from a trigger zone, a camera shake, made sounds
 */
const HOUSE = { w: 12, d: 10, h: 3, t: 0.2 }; // the house: x −6…6, z −5…5, walls 3 m high

/** A made sound of your own numbers (sfx.js), on top of a preset. */
const synth = (name, preset, params, extra = {}) => ({
  name, synth: { ...presetSfx(preset, 3), ...params, preset: 'custom' }, type: 'global', bus: 'effects',
  volume: 0.8, loop: false, autoplay: false, overlap: true, pitchVary: 0.05, ...extra,
});

function hollowHouse() {
  const { w, d, h, t } = HOUSE;
  const wallpaper = made('noise', { colorA: '#5a4a3f', colorB: '#3f332b', scale: 14, bump: 0.2 }, 1.5); // no striped wallpaper pattern
  const boards = made('planks', { colorA: '#4e3824', colorB: '#2f2015', scale: 5, variation: 0.35 }, 2);
  const grass = made('noise', { colorA: '#26331f', colorB: '#1a2416', scale: 10, bump: 0.3 }, 4);
  const wood = paint('#3b2a1c', { roughness: 0.7 });
  const cloth = paint('#4a2f33', { roughness: 0.95 });
  const wall = (name, at, size) => box(name, at, size, { material: wallpaper, rigidBody: solid() });
  const thing = (name, at, size, material = wood) => box(name, at, size, { material, rigidBody: solid() });
  // a door: turned about its left (−X) side by a rule — the hinge
  const door = (name, at) => box(name, at, [1.2, 2.2, 0.12], { material: paint('#2a1c12', { roughness: 0.6 }), rigidBody: moving() });
  const openDoor = (target, degrees, sound) => [
    { type: 'turn', target, degrees, how: 'by', seconds: 1.4, pivot: 'a point on it', pivotX: 'left', pivotY: 'middle', pivotZ: 'middle' },
    { type: 'playSound', sound, target: 'self' },
  ];
  const lamp = (room, [x, z]) => [
    { type: 'light', lightType: 'point', name: `${room} lamp`, parent: -1, position: [x, h - 0.45, z], rotation: [0, 0, 0], scale: [1, 1, 1],
      color: '#ffb36b', intensity: 30, distance: 8, castShadow: false, groups: ['Lamps'] },
    prim('sphere', `${room} bulb`, [x, h - 0.25, z], [0.1, 0.1, 0.1], { material: glow('#ffb36b', 1.5), groups: ['Lamps'] }),
  ];
  const story = (text, seconds = 5) => say(text, seconds, 'bottom');
  const shown = (on) => [
    { type: 'setVisible', target: 'Living room lamp', visible: on },
    { type: 'setVisible', target: 'Living room bulb', visible: on },
  ];
  const beforeTheBox = { type: 'variable', name: 'musicBox', op: '==', value: 0 };

  const player = box('Player', [0, 0.9, 3.6], [0.6, 1.7, 0.6], {
    material: paint('#4dd0a6'), rigidBody: PLAYER_BODY,
    rules: [
      // footsteps: one every half second while walking
      { when: { type: 'update', every: 0.5 }, if: [{ type: 'moving', who: 'self', speed: 1 }], do: [{ type: 'playSound', sound: 'step', target: 'self' }] },
    ],
  });
  const entities = [
    box('Yard', [0, -0.5, 0], [40, 1, 40], { material: grass, rigidBody: solid() }),
    // a light probe round the house: inside, things are lit and reflected by its lamps, not the night sky
    { type: 'probe', name: 'House probe', parent: -1, position: [0, h / 2, 0], rotation: [0, 0, 0], scale: [w, h, d], intensity: 1 },
    box('Floorboards', [0, 0.025, 0], [w, 0.05, d], {
      material: boards, rigidBody: solid(),
      rules: [
        ...onStart(story('Gran\'s house. Colder than I remember… The door just locked behind me.', 5)),
        // the living-room lamp flickers until the music box is taken
        { when: { type: 'update', every: 0.25 }, if: [beforeTheBox, { type: 'chance', percent: 10, join: 'and' }], do: shown(false) },
        { when: { type: 'update', every: 0.45 }, if: [beforeTheBox], do: shown(true) },
      ],
    }),
    box('Ceiling', [0, h + t / 2, 0], [w + t, t, d + t], { material: paint('#2b2421', { roughness: 1 }), rigidBody: solid() }),
    // outer walls; the front door in the middle of the south wall
    wall('Wall north', [0, h / 2, -d / 2], [w + t, h, t]),
    wall('Wall west', [-w / 2, h / 2, 0], [t, h, d]),
    wall('Wall east', [w / 2, h / 2, 0], [t, h, d]),
    wall('Wall south left', [-3.3, h / 2, d / 2], [5.4, h, t]),
    wall('Wall south right', [3.3, h / 2, d / 2], [5.4, h, t]),
    wall('Above the front door', [0, 2.6, d / 2], [1.2, 0.8, t]),
    { ...door('Front door', [0, 1.1, d / 2]),
      rules: [{ when: { type: 'variable', name: 'musicBox', op: '>=', value: 1 }, if: [], do: openDoor('self', -100, 'creak') }] },
    // inside: the living room (south), the bedroom (north-west) and the kitchen (north-east)
    wall('Wall hall west', [-4.6, h / 2, 0], [2.8, h, t]),
    wall('Wall hall middle', [0, h / 2, 0], [4, h, t]),
    wall('Wall hall east', [4.6, h / 2, 0], [2.8, h, t]),
    wall('Above the bedroom door', [-2.6, 2.6, 0], [1.2, 0.8, t]),
    wall('Above the kitchen door', [2.6, 2.6, 0], [1.2, 0.8, t]),
    wall('Wall between', [0, h / 2, -2.5], [t, h, 5]),
    { ...door('Bedroom door', [-2.6, 1.1, 0]),
      rules: [
        { when: { type: 'interact', who: 'player', prompt: 'Open' }, if: [
          { type: 'variable', name: 'key', op: '>=', value: 1 }, { type: 'variable', name: '_bedroomOpen', op: '==', value: 0, join: 'and' },
        ], do: [...openDoor('self', 95, 'creak'), { type: 'setVariable', name: '_bedroomOpen', value: 1 }] },
        { when: { type: 'interact', who: 'player', prompt: 'Open' }, if: [{ type: 'variable', name: 'key', op: '==', value: 0 }],
          do: [story('Locked. Gran always kept her keys in the kitchen.', 3), { type: 'playSound', sound: 'rattle', target: 'self' }] },
      ] },
    // the living room
    thing('Sofa', [-3.5, 0.4, 3.9], [2.2, 0.8, 0.9], cloth),
    thing('Table', [2.5, 0.35, 2.8], [1.2, 0.7, 0.8]),
    box('Note', [2.5, 0.72, 2.8], [0.3, 0.02, 0.4], {
      material: glow('#e8dcc0', 0.25),
      rules: [{ when: { type: 'interact', who: 'player', prompt: 'Read the note' }, if: [], do: [
        { type: 'playSound', sound: 'page', target: 'self' },
        story('"Sweetheart — my music box is in my bedroom. The key is in the kitchen drawer. Take it and go before the lights do. Don\'t look back. — Gran"', 8),
      ] }],
    }),
    // the kitchen
    thing('Counter', [3.5, 0.45, -4.5], [3, 0.9, 0.7]),
    box('Drawer', [3.5, 0.7, -4.13], [0.6, 0.2, 0.05], {
      material: paint('#5a4030'),
      rules: [{ when: { type: 'interact', who: 'player', prompt: 'Search the drawer' }, if: [{ type: 'variable', name: 'key', op: '==', value: 0 }], do: [
        { type: 'setVariable', name: 'key', value: 1 }, { type: 'playSound', sound: 'pickup', target: 'self' },
        story('A small brass key… Somewhere behind me, three slow knocks.', 4), { type: 'playSound', sound: 'knock', target: 'self' },
      ] }],
    }),
    thing('Shelf', [5.75, 1.8, -2.5], [0.4, 0.1, 1.5]),
    prim('cylinder', 'Vase', [5.75, 2.03, -2.5], [0.17, 0.19, 0.17], {
      material: paint('#6d7f8a', { roughness: 0.3, metalness: 0.1 }),
      rigidBody: { type: 'dynamic', mass: 2, restitution: 0.2, friction: 0.6, isTrigger: false },
    }),
    // stepping into the kitchen: the vase comes off the shelf
    box('Kitchen scare', [2.6, 1, -1.2], [1.6, 2, 1.2], {
      material: paint('#000000', { opacity: 0 }), rigidBody: trigger(),
      rules: [{ when: { type: 'triggerEnter', who: 'player' }, if: [{ type: 'variable', name: '_vase', op: '==', value: 0 }], do: [
        { type: 'setVariable', name: '_vase', value: 1 },
        { type: 'push', target: 'Vase', direction: 'left', relative: 'world', strength: 3 },
        { type: 'playSound', sound: 'crash', target: 'self' },
        { type: 'shakeCamera', strength: 0.2, seconds: 0.3 },
      ] }],
    }),
    // where it comes from: a hidden marker in the kitchen
    box('Ghost spawn', [4.5, 1, -3.4], [0.3, 0.3, 0.3], {
      material: paint('#000000', { opacity: 0 }),
      rules: [{ when: { type: 'variable', name: 'musicBox', op: '>=', value: 1 }, if: [], do: [
        { type: 'spawn', prefab: 'Ghost', at: 'self' }, { type: 'playSound', sound: 'scream', target: 'self' },
      ] }],
    }),
    // the bedroom
    thing('Bed', [-4.5, 0.25, -3.4], [2, 0.5, 1.4], cloth),
    thing('Dresser', [-1, 0.45, -4.6], [1.2, 0.9, 0.5]),
    box('Music box', [-1, 1.0, -4.6], [0.3, 0.2, 0.2], {
      material: glow('#c9a227', 0.5),
      rules: [{ when: { type: 'interact', who: 'player', prompt: 'Take the music box' }, if: [beforeTheBox], do: [
        { type: 'setVariable', name: 'musicBox', value: 1 },
        { type: 'playSound', sound: 'tune', target: 'self' },
        { type: 'setVisible', target: 'group:Lamps', visible: false },
        { type: 'shakeCamera', strength: 0.35, seconds: 0.6 },
        story('The lights die. Something in the kitchen is breathing. RUN.', 4),
        { type: 'destroy', target: 'self', after: 0 },
      ] }],
    }),
    ...lamp('Living room', [0, 2.5]), ...lamp('Kitchen', [3, -2.5]), ...lamp('Bedroom', [-3, -2.5]),
    // out of the front door: free
    box('Way out', [0, 1, d / 2 + 2.5], [3, 2, 1.5], {
      material: paint('#000000', { opacity: 0 }), rigidBody: trigger(),
      rules: [{ when: { type: 'triggerEnter', who: 'player' }, if: [{ type: 'variable', name: 'musicBox', op: '>=', value: 1 }], do: [
        { type: 'win', message: 'You got out. In your pocket, the music box starts to play by itself.' },
      ] }],
    }),
    player,
  ];
  // the lantern the player carries: a warm glow that goes where you go
  entities.push({ type: 'light', lightType: 'point', name: 'Lantern', childOf: player, parent: -1, position: [0.25, 0.3, 0],
    rotation: [0, 0, 0], scale: [1, 1, 1], color: '#ffd9a0', intensity: 8, distance: 6, castShadow: false });

  // the ghost: a pale robe and a head, see-through; it chases, and its touch ends the game
  const ghostLook = { color: '#dfe8ff', roughness: 0.4, metalness: 0, emissive: '#7f95c8', emissiveIntensity: 0.7, opacity: 0.55 };
  const prefabs = {
    Ghost: {
      type: 'primitive', primitive: 'cone', name: 'Ghost', scale: [0.45, 0.85, 0.45], solid: false,
      material: ghostLook, rigidBody: trigger('kinematic'),
      components: [{ type: 'follower', props: { target: 'player', speed: 2.8, stopAt: 0, turnToFace: true, avoid: true } }],
      rules: [{ when: { type: 'triggerEnter', who: 'player' }, if: [], do: [
        { type: 'playSound', sound: 'scream', target: 'self' }, { type: 'lose', message: 'She found you.' }] }],
      children: [{ type: 'primitive', primitive: 'sphere', name: 'Ghost head', position: [0, 1.15, 0], rotation: [0, 0, 0],
        scale: [0.62, 0.33, 0.62], solid: false, material: ghostLook }],
    },
  };
  return {
    // the colour of a scary night: drained, cold, dark at the edges, grainy as old film
    environment: { ...env('night'), exposure: 0.9, fog: 35, saturation: -0.35, warmth: -0.25, vignette: 0.55, grain: 0.18, contrast: 0.1 },
    camera: {
      ...orbitCamera({ target: null, lookAt: [0, 0, 0], theta: 0.5, phi: 0.6, distance: 22, playMode: 'fps' }),
      settings: { eyeHeight: 0.7, fovFps: 70, headBob: 0.8 },
    },
    space: { space: 'room', spaceAmount: 0.35 },
    sceneSounds: [
      ambience('rain', 'rain', 0.25), ambience('hum', 'hum', 0.15),
      sfx('step', 'footstep', { volume: 0.35, pitchVary: 0.2 }), sfx('pickup', 'coin', { volume: 0.3 }), sfx('page', 'click', { volume: 0.4 }),
      synth('creak', 'hit', { wave: 'saw', freq: 140, freqEnd: 90, sustain: 0.7, decay: 0.4, lowpass: 0.15, vibrato: 0.08, vibratoRate: 11, volume: 0.5 }),
      synth('rattle', 'hit', { wave: 'noise', freq: 900, freqEnd: 600, sustain: 0.2, decay: 0.15, lowpass: 0.4, tremolo: 0.9, tremoloRate: 25, volume: 0.4 }),
      synth('knock', 'hit', { wave: 'sine', freq: 90, freqEnd: 60, sustain: 0.02, decay: 0.12, lowpass: 0.3, volume: 0.9 }),
      synth('crash', 'explosion', { freq: 1800, freqEnd: 400, sustain: 0.05, decay: 0.5, lowpass: 0.7, volume: 0.6 }),
      synth('scream', 'hit', { wave: 'saw', freq: 1100, freqEnd: 420, attack: 0.05, sustain: 0.6, decay: 0.7, lowpass: 0.5, vibrato: 0.25, vibratoRate: 17, volume: 0.6 }),
      synth('tune', 'coin', { wave: 'triangle', freq: 1320, freqEnd: 1320, sustain: 0.15, decay: 1.2, jump: 0.75, jumpAt: 0.3, volume: 0.4 }),
    ],
    prefabs,
    entities: linkParents(entities),
  };
}

// ---------------------------------------------------------------- stealth

/**
 * Night Watch — a stealth game: robot guards with Enemy AI patrol a walled
 * yard at night. Their states (patrolling, chasing, searching…) say on screen
 * how alarmed they are; running is heard; a bell across the yard draws them
 * off (Make a noise). The plans go into a list variable — the exit asks the
 * list (List contains).
 */
function nightWatch() {
  const gravel = made('noise', { colorA: '#4a4f57', colorB: '#33373d', scale: 10, bump: 0.4 }, 3, { roughness: 0.95 });
  const brick = made('bricks', { colorA: '#5b4a44', colorB: '#3b302c', scale: 6, variation: 0.25 }, 2);
  const planks = made('planks', { colorA: '#7a5a34', colorB: '#4e391f', scale: 4, variation: 0.3 }, 1.2);
  const wall = (name, at, size) => box(name, at, size, { material: brick, rigidBody: solid() });
  const crate = (n, [x, z], size = [1.6, 1.6, 1.6]) => box(`Crate ${n}`, [x, size[1] / 2, z], size, { material: planks, rigidBody: solid() });
  // where they walk: marks on the ground, in name order
  const post = (round, n, [x, z]) => prim('cylinder', `${round} ${n}`, [x, 0.01, z], [0.25, 0.01, 0.25], {
    material: paint('#2a2e33'), groups: [round],
  });
  const lamp = (n, [x, z]) => [
    box(`Lamp post ${n}`, [x, 1.6, z], [0.2, 3.2, 0.2], { material: paint('#1d1f22'), rigidBody: solid() }),
    prim('sphere', `Lamp ${n} bulb`, [x, 3.3, z], [0.18, 0.18, 0.18], { material: glow('#ffb36b', 2) }),
    { type: 'light', lightType: 'point', name: `Lamp ${n}`, parent: -1, position: [x, 3.1, z], rotation: [0, 0, 0], scale: [1, 1, 1],
      color: '#ffb36b', intensity: 26, distance: 11, castShadow: false },
  ];
  const guard = (n, [x, z], ry, points) => {
    const g = model(`Guard ${n}`, ROBOT_MODEL, [x, 0, z], ROBOT_SCALE, {
      rotation: [0, ry, 0],
      groups: ['Guards'],
      rigidBody: { type: 'dynamic', mass: 80, restitution: 0, friction: 0.1, isTrigger: false, shape: 'capsule' },
      components: [
        // what it notices: 11 m ahead in a 100° view (not through crates), runners within 7 m
        { type: 'senses', props: { who: 'player', sight: 11, fov: 100, feel: 1.2, hears: true, footsteps: 'when running', stepsWithin: 7, memory: 4 } },
        // what it does about it: its round (or its post), chase, a punch, search, call the others
        { type: 'enemyAI', props: { points, walk: 1.6, run: 4.2, wait: 1.5, attack: 'hits', reach: 1.6, damage: 1, every: 1.2,
          clip: 'Punch', sound: 'punch', search: 6, alert: 14, cover: '', coverBelow: 0, coverFor: 4, avoid: true } },
        { type: 'animator', props: { style: 'clips', idle: 'Idle', walk: 'Walking', run: 'Running', runSpeed: 3, follow: 'self', blend: 0.2 } },
      ],
      rules: [
        { when: { type: 'stateEnter', state: 'chasing' }, if: [{ type: 'cooldown', seconds: 4 }], do: [
          { type: 'playSound', sound: 'alarm', target: 'self' }, say('"Intruder!"', 2, 'bottom')] },
        // a sleep dart (from the bag): the one near you sleeps a while — its own state, so its Enemy AI waits
        { when: { type: 'event', name: 'dart' }, if: [{ type: 'near', who: 'self', of: 'player', distance: 6 }], do: [
          { type: 'setState', target: 'self', state: 'asleep' },
          say('The guard slumps against the wall. Zzz…', 3, 'bottom'),
          { type: 'wait', seconds: 10 },
          { type: 'setState', target: 'self', state: 'guarding' },
        ] },
      ],
    });
    // a lantern it carries: you see them coming in the dark
    const light = { type: 'light', lightType: 'point', name: `Guard ${n} lantern`, childOf: g, parent: -1, position: [0, 3.6, 1.4],
      rotation: [0, 0, 0], scale: [1, 1, 1], color: '#a8d4ff', intensity: 7, distance: 5, castShadow: false };
    return [g, light];
  };
  // how alarmed they are, on screen: from the guards' states (State is, any of the group)
  const any = (state, extra = {}) => ({ type: 'state', who: 'group:Guards', state, ...extra });
  const every = { type: 'update', every: 0.25 };
  const status = [
    { when: every, if: [any('chasing'), any('attacking', { join: 'or' })], do: [{ type: 'setVariable', name: 'guards', value: 'SEEN!' }] },
    { when: every, if: [any('searching'), any('chasing', { join: 'and', not: true }), any('attacking', { join: 'and', not: true })],
      do: [{ type: 'setVariable', name: 'guards', value: 'Searching…' }] },
    { when: every, if: [any('searching', { not: true }), any('chasing', { join: 'and', not: true }), any('attacking', { join: 'and', not: true })],
      do: [{ type: 'setVariable', name: 'guards', value: 'Unaware' }] },
  ];
  const hasPlans = { type: 'listContains', name: 'bag', value: 'plans' };
  const picked = (item) => ({ type: 'expression', expr: `picked == "${item}"` });
  const guardNear = { type: 'near', who: 'group:Guards', of: 'player', distance: 6, join: 'and' };
  // Old Tom, by the gate: talk to him (E)
  const tom = [
    prim('cylinder', 'Old Tom', [-11.5, 0.8, 16], [0.35, 0.8, 0.35], {
      material: paint('#8a6d4b'), rigidBody: solid(),
      rules: [
        { when: { type: 'interact', who: 'player', prompt: 'Talk' }, if: [], do: [{ type: 'startDialogue', dialogue: 'Old Tom' }] },
        { when: { type: 'event', name: 'tom gives a dart' }, if: [], do: [
          { type: 'listAdd', name: 'bag', value: 'sleep dart', where: 'at the end', unique: false },
          { type: 'setVariable', name: '_tomGave', value: 'true' },
        ] },
      ],
    }),
    prim('sphere', 'Old Tom head', [-11.5, 1.85, 16], [0.3, 0.3, 0.3], { material: paint('#d9b38c') }),
  ];
  // the bag (I): click what is in it to use it
  const bagRules = [
    { when: { type: 'uiPick', screen: 'Bag', list: 'bag' }, if: [picked('sleep dart'), guardNear], do: [
      { type: 'listRemove', name: 'bag', which: 'this value', value: 'sleep dart' },
      { type: 'showScreen', screen: 'Bag', how: 'hide' },
      { type: 'sendEvent', name: 'dart', to: 'group:Guards', after: 0 },
    ] },
    { when: { type: 'uiPick', screen: 'Bag', list: 'bag' }, if: [picked('sleep dart'), { ...guardNear, not: true }], do: [
      say('Get within a few steps of a guard first.', 2, 'top')] },
    { when: { type: 'uiPick', screen: 'Bag', list: 'bag' }, if: [picked('plans')], do: [say('The plans. Get them out of here.', 2, 'top')] },
  ];

  const entities = [
    box('Ground', [0, -0.5, 0], [40, 1, 40], {
      material: gravel, rigidBody: solid(),
      rules: [
        ...onStart(say('Take the plans from the shed (north) and slip out by the green exit. Old Tom by the gate knows the guards — talk to him (E). I opens your bag.', 8)),
        ...status,
        ...bagRules,
      ],
    }),
    wall('Wall north', [0, 1.5, -18.5], [38, 3, 1]),
    wall('Wall south', [0, 1.5, 18.5], [38, 3, 1]),
    wall('Wall east', [18.5, 1.5, 0], [1, 3, 38]),
    wall('Wall west', [-18.5, 1.5, 0], [1, 3, 38]),
    // the shed: open to the south, the plans on a table inside
    wall('Shed back', [0, 1.4, -17.6], [7, 2.8, 0.4]),
    wall('Shed left', [-3.3, 1.4, -15.2], [0.4, 2.8, 4.8]),
    wall('Shed right', [3.3, 1.4, -15.2], [0.4, 2.8, 4.8]),
    box('Table', [0, 0.45, -16.2], [1.6, 0.9, 0.9], { material: planks, rigidBody: solid() }),
    box('Plans', [0, 0.96, -16.2], [0.5, 0.06, 0.38], {
      material: glow('#9fe0ff', 1.2),
      rules: [{ when: { type: 'interact', who: 'player', prompt: 'Take the plans' }, if: [], do: [
        { type: 'listAdd', name: 'bag', value: 'plans', where: 'at the end', unique: true },
        { type: 'playSound', sound: 'pickup', target: 'self' },
        // a rustle of paper: a guard close by may hear it
        { type: 'makeNoise', loud: 6, kind: 'a noise', target: 'self' },
        say('Got them. Now the green exit, south-east.', 4, 'bottom'),
        { type: 'destroy', target: 'self', after: 0 },
      ] }],
    }),
    // cover from their eyes
    crate(1, [-8, -4]), crate(2, [6, -3], [2.4, 1.6, 1.6]), crate(3, [-3, 5]), crate(4, [9, 8], [1.6, 1.6, 3]),
    crate(5, [-11, 9]), crate(6, [2, -8], [3, 1.6, 1.2]), crate(7, [-13, -12]), crate(8, [12, -13], [1.6, 2.4, 1.6]),
    ...lamp(1, [-10, -10]), ...lamp(2, [10, -10]), ...lamp(3, [0, 4]), ...lamp(4, [-7, 14]),
    // the bell: ring it and every guard within 30 m comes to look (Make a noise)
    box('Bell', [-17.6, 1.6, 0], [0.5, 0.7, 0.5], {
      material: glow('#d4a017', 0.4),
      rules: [{ when: { type: 'interact', who: 'player', prompt: 'Ring the bell' }, if: [{ type: 'cooldown', seconds: 5 }], do: [
        { type: 'playSound', sound: 'bell', target: 'self' },
        { type: 'makeNoise', loud: 30, kind: 'a noise', target: 'self' },
        say('Clang! That will draw them over here.', 3, 'bottom'),
      ] }],
    }),
    box('Exit', [14, 0.03, 15], [3, 0.06, 3], {
      material: glow('#3ddc84', 0.8), rigidBody: trigger(),
      rules: [{ when: { type: 'triggerEnter', who: 'player', part: '' }, if: [hasPlans],
        do: [{ type: 'win', message: 'You slipped out with the plans. Nobody will know until morning.' }],
        else: [say('Not without the plans.', 2, 'bottom')] }],
    }),
    // their rounds: Guard 1 along the north yard, Guard 2 round the middle; Guard 3 keeps watch by the shed
    post('Round A', 1, [-12, -7]), post('Round A', 2, [12, -7]),
    post('Round B', 1, [-6, 1]), post('Round B', 2, [7, 1]), post('Round B', 3, [7, 11]), post('Round B', 4, [-6, 11]),
    ...guard(1, [-12, -7], Math.PI / 2, 'Round A'),
    ...guard(2, [-6, 1], Math.PI / 2, 'Round B'),
    ...guard(3, [6, -12.5], -Math.PI / 2, ''),
    ...tom,
    player([-14, 0.9, 15], {
      rotation: [0, Math.PI, 0], // facing north, into the yard
      components: [{ type: 'health', props: { max: 3, atZero: 'nothing', delay: 0, mirrorTo: 'health' } }],
      rules: [
        { when: { type: 'hurt', who: 'any' }, if: [], do: [
          { type: 'shakeCamera', strength: 0.25, seconds: 0.25 }, { type: 'playSound', sound: 'hurt', target: 'self' }] },
        { when: { type: 'healthOut', who: 'any' }, if: [], do: [{ type: 'lose', message: 'Caught. The guards march you to the gate.' }] },
      ],
    }),
  ];
  return {
    environment: { ...env('night'), exposure: 1.7, fog: 60, warmth: -0.3, vignette: 0.45, saturation: -0.1 },
    camera: orbitCamera({ target: 'player', lookAt: [0, 0, 0], theta: 0, phi: 0.95, distance: 34, playMode: 'follow' }),
    space: { space: 'none', spaceAmount: 0 },
    sceneSounds: [
      ambience('hum', 'hum', 0.12),
      sfx('punch', 'hit', { volume: 0.8 }), sfx('hurt', 'hit', { volume: 0.9 }), sfx('pickup', 'powerup', { volume: 0.5 }),
      synth('alarm', 'hit', { wave: 'square', freq: 880, freqEnd: 620, sustain: 0.25, decay: 0.3, lowpass: 0.5, volume: 0.35 }),
      synth('bell', 'coin', { wave: 'triangle', freq: 660, freqEnd: 650, sustain: 0.3, decay: 1.6, volume: 0.6 }),
    ],
    entities: linkParents(entities),
  };
}

// ---------------------------------------------------------------- open world

/** A path painted along points (terrain-local x, z) on a terrain's settings, as the brush would: { n, layer, weight }. */
function paintedPath(params, points, width) {
  const p = normalizeTerrain(params);
  const n = p.detail + 1;
  const layer = new Uint8Array(n * n);
  const weight = new Uint8Array(n * n);
  const half = p.size / 2;
  const cell = p.size / p.detail;
  const id = PAINTS.indexOf('path') + 1;
  const edge = width / 2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + i * cell;
      const z = -half + j * cell;
      let d = Infinity;
      for (let k = 0; k < points.length - 1; k++) {
        const [ax, az] = points[k];
        const [bx, bz] = points[k + 1];
        const vx = bx - ax;
        const vz = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
        d = Math.min(d, Math.hypot(x - ax - vx * t, z - az - vz * t));
      }
      if (d > edge + 1.5) continue;
      layer[j * n + i] = id;
      weight[j * n + i] = Math.round(255 * Math.min(1, (edge + 1.5 - d) / 1.5)); // soft edges
    }
  }
  return { n, layer: encodeBytes(layer), weight: encodeBytes(weight) };
}

/**
 * Wild Valley — a big open world from the World tools: a 400 m river valley
 * in chunks (each drawn simpler far away), a path painted down its east bank,
 * pine forests on both slopes, broadleaf trees by the river, rocks, a meadow
 * of grass and flowers — all scattered (copies, a few dozen draws for
 * thousands of plants), kept off the path. Three standing stones to find.
 */
function wildValley() {
  const path = [[62, 182], [58, 140], [70, 100], [55, 60], [68, 20], [50, -20], [64, -60], [52, -100], [66, -140], [58, -178]];
  const land = {
    shape: 'valley', size: 400, height: 46, roughness: 0.5, seed: 21, detail: 512, water: 0.07,
    grass: '#6a9a45', rock: '#857a6c', sand: '#cdbb8a', waterColor: '#3a7aa8', rockSlope: 0.45, groundScale: 3,
  };
  land.paint = paintedPath(land, path, 3.2);
  const ground = (x, z) => terrainHeightAt(land, x, z);
  const scatter = (name, at, params) => ({
    type: 'generated', name, generator: 'scatter', parent: -1, position: [at[0], 0, at[1]], rotation: [0, 0, 0], scale: [1, 1, 1],
    params: { notOn: 'paths', ...params },
    ...(params.solid ? { rigidBody: { type: 'static', mass: 1, restitution: 0, friction: 0.5, isTrigger: false, shape: 'mesh' } } : {}),
  });
  const stone = (n, [x, z]) => pickup('box', `Standing stone ${n}`, [x, ground(x, z) + 1.4, z], [0.45, 1.6, 0.35], 'stones', '#7fe0d0', 'chime');
  const start = [62, 176];
  return {
    environment: { ...env('golden'), fog: 320, time: 16.8 },
    camera: orbitCamera({ target: 'player', lookAt: [start[0], ground(...start), start[1]], theta: 0, phi: 1.1, distance: 12, playMode: 'follow' }),
    sceneSounds: [
      ambience('wind', 'wind', 0.25),
      sfx('chime', 'coin', { volume: 0.5 }), sfx('jump', 'jump', { volume: 0.35 }), sfx('win', 'powerup', { volume: 0.6 }),
    ],
    entities: [
      {
        type: 'generated', name: 'Valley', generator: 'terrain', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        params: land,
        rigidBody: { type: 'static', mass: 1, restitution: 0, friction: 0.6, isTrigger: false, shape: 'mesh' },
        physicsParts: { Water: 'trigger' },
        rules: [
          ...onStart(say('Follow the path north through the valley and find the three standing stones. Shift runs.', 6)),
          { when: { type: 'variable', name: 'stones', op: '>=', value: 3 }, if: [], do: [
            { type: 'playSound', sound: 'win', target: 'self' },
            { type: 'win', message: 'All three stones found. The valley hums as the sun goes down.' }] },
        ],
      },
      scatter('Pines east', [125, -10], { kind: 'pines', count: 1400, size: 150, seed: 3, spacing: 2.2, clumping: 0.45, solid: true, maxSlope: 40, far: 0 }),
      scatter('Pines west', [-125, 10], { kind: 'pines', count: 1400, size: 150, seed: 4, spacing: 2.2, clumping: 0.45, solid: true, maxSlope: 40, far: 0 }),
      scatter('Riverside trees', [0, 0], { kind: 'trees', count: 260, size: 150, seed: 5, spacing: 4, clumping: 0.6, solid: true, maxSlope: 30, far: 0 }),
      scatter('Rocks', [0, 0], { kind: 'rocks', count: 260, size: 390, seed: 6, spacing: 2, clumping: 0.3, solid: true, maxSlope: 70, far: 0, scaleMin: 0.4, scaleMax: 2.4 }),
      scatter('Meadow grass', [60, 130], { kind: 'grass', count: 7000, size: 110, seed: 7, spacing: 0.3, clumping: 0.3, far: 70 }),
      scatter('Meadow flowers', [60, 125], { kind: 'flowers', count: 1600, size: 90, seed: 8, spacing: 0.45, clumping: 0.7, far: 60, color: '#f2c94c' }),
      scatter('Bushes', [60, 0], { kind: 'bushes', count: 500, size: 120, seed: 9, spacing: 1.5, clumping: 0.5, far: 140 }),
      stone(1, [76, 95]),
      stone(2, [40, -18]),
      stone(3, [70, -150]),
      player([start[0], ground(...start) + 1.2, start[1]], { rotation: [0, Math.PI, 0] }),
    ],
  };
}

function valleyControls() {
  const list = controls();
  list.push(normalizeControl({ inputs: [{ type: 'key', code: 'ShiftLeft' }, { type: 'screen', label: 'Run' }], target: 'player',
    action: { type: 'sprint', multiplier: 1.8, fovBoost: 4 } }));
  return list;
}

/** Walk slowly (Shift to run), look with the mouse, E to interact — no jumping in Gran's house. */
function houseControls() {
  const list = controls({ interact: true })
    .filter((c) => c.action.type !== 'jump')
    .map((c) => (c.action.type === 'move' ? { ...c, action: { ...c.action, speed: 3.5 } } : c));
  list.push(normalizeControl({ inputs: [{ type: 'key', code: 'ShiftLeft' }, { type: 'screen', label: 'Run' }], target: 'player',
    action: { type: 'sprint', multiplier: 1.8, fovBoost: 4 } }));
  return list;
}

// ---------------------------------------------------------------- the list

export const TEMPLATES = [
  {
    id: 'platformer',
    name: '3D Platformer',
    emoji: '🏃',
    blurb: 'Jump across floating platforms, grab coins and reach the golden ring. Two levels, three lives — fall in the water and you lose one.',
    keys: 'WASD / arrows · Space jumps',
    build: () => project([['Meadow', meadow], ['Sunset Heights', sunsetHeights]], {
      controls: controls(), variables: { coins: 0, lives: 3 },
      ui: {
        title: { enabled: true, text: 'Sky Hopper', subtitle: 'Reach the golden ring — mind the water', prompt: 'Press any key to start' },
        hud: { lives: { show: 'hearts', max: 3 } },
      },
    }),
  },
  {
    id: 'collector',
    name: 'Top-Down Collector',
    emoji: '💎',
    blurb: 'Collect all 12 gems within 60 seconds while slimes chase you. Three hits and it is over.',
    keys: 'WASD / arrows',
    build: () => project([['Garden', garden]], {
      controls: controls(), variables: { gems: 0, health: 3, time: 60 },
      ui: {
        title: { enabled: true, text: 'Gem Garden', subtitle: '12 gems · 60 seconds · watch out for slimes', prompt: 'Press any key to start' },
        hud: { health: { show: 'bar', max: 3 }, gems: { show: 'bar', max: 12 } },
      },
    }),
  },
  {
    id: 'explorer',
    name: 'First-Person Explorer',
    emoji: '🏛️',
    blurb: 'Explore a ruined temple from your own eyes: pull the lever, find three relics and escape through the portal.',
    keys: 'Click, then mouse to look · WASD · E interacts',
    build: () => project([['Temple', temple]], {
      controls: controls({ interact: true }), variables: { relics: 0, _doorOpen: 0 },
      ui: {
        title: { enabled: true, text: 'Lost Temple', subtitle: 'Find the three relics and escape', prompt: 'Click to begin' },
        hud: {},
      },
    }),
  },
  {
    id: 'racing',
    name: 'Car Racing',
    emoji: '🏎️',
    blurb: 'Three laps round a circuit against three rival cars: a 3-2-1 start, checkpoints, positions and lap times. Finish first to win.',
    keys: 'W / ↑ throttle · S / ↓ brake, reverse · A D steer · Space handbrake · R back on track',
    build: () => project([['Circuit', circuit]], {
      controls: defaultControls(), variables: { lap: 1, position: 1, raceTime: 0, speed: 0 }, // a car: W the throttle, Space the handbrake
      ui: {
        title: { enabled: true, text: 'Street Racer', subtitle: '3 laps · 3 rivals · finish first', prompt: 'Press any key to start' },
        hud: { lap: { show: 'number', label: 'Lap' }, position: { show: 'number', label: 'Position' },
          raceTime: { show: 'number', label: 'Time' }, speed: { show: 'number', label: 'km/h' } },
      },
    }),
  },
  {
    id: 'shooter',
    name: 'AK Arena',
    emoji: '🔫',
    blurb: 'A first-person shooter: an AK74u in your hands, 30 rounds a magazine, R to reload. Four robots chase you — three bullets each; five punches and you are down.',
    keys: 'Click, then mouse to look · WASD · click shoots · R reloads',
    build: () => project([['Warehouse', warehouse]], {
      controls: shooterControls(), variables: { health: 5, ammo: 30, mags: 3, robots: 4, _reloading: 0 },
      ui: {
        game: { name: 'AK Arena', icon: '🔫' },
        title: { enabled: true, text: 'AK Arena', subtitle: '4 robots · 3 bullets each · 5 hits and you are down', prompt: 'Click to start' },
        hud: {
          health: { show: 'bar', max: 5, label: 'Health', at: 'top left' },
          robots: { show: 'number', label: 'Robots left' },
          ammo: { show: 'number', label: 'Ammo', at: 'bottom right', size: 34, color: '#ffd166' },
          mags: { show: 'number', label: 'Mags', at: 'bottom right' },
        },
        hudLook: { shadow: true, opacity: 0.55, border: false },
        crosshair: { style: 'cross + dot', show: 'first person', size: 18, thickness: 2, gap: 4, color: '#ffffff', opacity: 0.9, outline: true },
      },
    }),
  },
  {
    id: 'stealth',
    name: 'Night Watch',
    emoji: '🌙',
    blurb: 'A stealth game: three robot guards watch a yard at night. Take the plans from the shed and slip out — walk, keep behind crates, ring the bell to draw them off.',
    keys: 'WASD · Shift runs (they hear it) · E interacts · mouse turns the view',
    build: () => project([['The Yard', nightWatch]], {
      controls: [...houseControls(), normalizeControl({
        inputs: [{ type: 'key', code: 'KeyI' }, { type: 'screen', label: 'Bag' }], target: 'player',
        action: { type: 'showScreen', screen: 'Bag', how: 'show or hide (toggle)' },
      })],
      variables: { health: 3, bag: [], guards: 'Unaware', picked: '', _tomGave: false },
      ui: {
        game: { name: 'Night Watch', icon: '🌙' },
        title: { enabled: true, text: 'Night Watch', subtitle: 'Get the plans. Don\'t get seen.', prompt: 'Press any key to start' },
        hud: {
          health: { show: 'hearts', max: 3, label: 'Health' },
          bag: { show: 'number', label: 'Bag' },
          guards: { show: 'number', label: 'Guards', at: 'top center', size: 22, color: '#ffd166' },
          picked: { show: 'hidden' },
        },
        hudLook: { shadow: true, opacity: 0.5, border: false },
        // the bag: what you carry, as tiles — click one to use it (the rules An item is picked)
        screens: [{
          name: 'Bag', title: 'Your bag', place: 'middle', width: 380, pauses: true, dim: true, closeButton: true, color: '#ffd166',
          items: [
            { type: 'text', text: 'Click something to use it.', size: 14, align: 'center' },
            { type: 'list', variable: 'bag', columns: 3, empty: 'Nothing in it yet.', group: true, pick: 'picked' },
            { type: 'button', label: 'Close', does: 'close this screen', key: 'KeyI' },
          ],
        }],
        // Old Tom: tips, a sleep dart (once), and back to the questions
        dialogues: [{
          name: 'Old Tom', pauses: true,
          lines: [
            { id: 'start', who: 'Old Tom', text: 'Psst. You\'re after the plans in the shed, aren\'t you?', choices: [
              { text: 'How do I get past the guards?', goto: 'tips' },
              { text: 'Got anything that could help?', if: 'not _tomGave', event: 'tom gives a dart', goto: 'dart' },
              { text: 'I\'ll manage. Bye.', goto: 'end' },
            ] },
            { id: 'tips', who: 'Old Tom', text: 'Walk, don\'t run — they hear running. Keep crates between you and their lanterns. And they always go to look when the bell on the west wall rings.', next: 'start' },
            { id: 'dart', who: 'Old Tom', text: 'Here — a sleep dart. Open your bag (I) and use it when a guard is close. It won\'t last long.', next: 'start' },
          ],
        }],
      },
    }),
  },
  {
    id: 'valley',
    name: 'Wild Valley',
    emoji: '🏞️',
    blurb: 'An open world: a 400 m river valley with pine forests, a meadow and a winding path. Follow it north and find the three standing stones.',
    keys: 'WASD · Space jumps · Shift runs · mouse turns the view',
    build: () => project([['The Valley', wildValley]], {
      controls: valleyControls(), variables: { stones: 0 },
      ui: {
        game: { name: 'Wild Valley', icon: '🏞️' },
        title: { enabled: true, text: 'Wild Valley', subtitle: 'Three standing stones, somewhere up the valley', prompt: 'Press any key to start' },
        hud: { stones: { show: 'number', label: 'Stones', at: 'top left' } },
        hudLook: { shadow: true, opacity: 0.45, border: false },
      },
    }),
  },
  {
    id: 'horror',
    name: 'Hollow House',
    emoji: '🕯️',
    blurb: 'A short horror story in a small house at night: read Gran\'s note, find the key, take the music box — then get out before she finds you.',
    keys: 'Click, then mouse to look · WASD · Shift runs · E interacts',
    build: () => project([['Hollow House', hollowHouse]], {
      controls: houseControls(), variables: { key: 0, musicBox: 0, _bedroomOpen: 0, _vase: 0 },
      ui: {
        game: { name: 'Hollow House', icon: '🕯️' },
        title: { enabled: true, text: 'Hollow House', subtitle: 'Gran left you something. Get it, and get out.', prompt: 'Click to enter' },
        hud: { key: { show: 'hidden' }, musicBox: { show: 'hidden' } },
        crosshair: { style: 'dot', show: 'first person', size: 6, thickness: 2, gap: 0, color: '#ffffff', opacity: 0.6, outline: true },
      },
    }),
  },
];
