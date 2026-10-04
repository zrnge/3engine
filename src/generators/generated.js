import * as THREE from 'three';
import { disposeObject } from '../dispose.js';
import {
  TERRAIN_DEFAULTS, TERRAIN_SHAPES, TERRAIN_SHAPE_LABELS, TERRAIN_SHAPE_PRESETS, TERRAIN_DETAILS, normalizeTerrain, buildTerrain,
} from './terrain.js';
import {
  SCATTER_DEFAULTS, SCATTER_KINDS, SCATTER_LABELS, SCATTER_PRESETS, SCATTER_NOT_ON, normalizeScatter, buildScatter,
} from './scatter.js';
import {
  BUILDING_DEFAULTS, ROOF_TYPES, ROOF_LABELS, WALL_STYLES, SIDES, ROOM_LAYOUTS, normalizeBuilding, buildBuilding,
} from './building.js';

/**
 * Generated objects — made from a few settings instead of a file: terrain
 * (fields, valleys, mountains…) and buildings (houses, huts, towers…).
 *
 * The object is a group; its parts (meshes, named: Ground, Water, Wall front,
 * Roof…) are made from its settings and made again whenever they change. Only
 * the settings are saved — { type: 'generated', generator, params } — so a
 * whole valley costs a few numbers in a game file. Anything put under it as a
 * child stays: only its own parts are remade.
 *
 * Each generator lists its settings (fields) for the Inspector, the same way
 * the rest of the engine describes its settings.
 */

const f = (key, label, extra = {}) => ({ key, label, ...extra });

export const GENERATORS = {
  terrain: {
    label: 'Terrain',
    icon: '⛰',
    defaults: TERRAIN_DEFAULTS,
    normalize: normalizeTerrain,
    build: buildTerrain,
    // its water is a trigger zone by default (swimming, drowning, a splash), not a floor
    parts: { Water: 'trigger' },
    /** Choosing a shape also sets what suits it (its height, its water). */
    onChange(params, key) { return key === 'shape' ? { ...params, ...TERRAIN_SHAPE_PRESETS[params.shape] } : params; },
    fields: [
      { group: 'Land' },
      f('shape', 'Shape', { type: 'select', options: TERRAIN_SHAPES, labels: TERRAIN_SHAPE_LABELS }),
      f('size', 'Size (m)', { type: 'range', min: 10, max: 1000, step: 5, hint: 'How far across it is, each way' }),
      f('height', 'Height (m)', { type: 'range', min: 0, max: 300, step: 1, hint: 'From its lowest to its highest' }),
      f('roughness', 'Roughness', { type: 'range', min: 0, max: 1, step: 0.05, hint: '0: smooth and gentle · 1: rugged, lots of small bumps' }),
      f('seed', 'Variation', { type: 'number', min: 1, max: 99999, step: 1, dice: true, hint: 'Another number: different land of the same kind (🎲 picks one)' }),
      f('detail', 'Detail', { type: 'select', options: TERRAIN_DETAILS, hint: 'Cells along a side: more is smoother, and heavier to make and collide with. Over 128 it is made in chunks, each drawn simpler far away — a big world (a 1 km valley at 512 or more)' }),
      { group: 'Water' },
      f('water', 'Water level', { type: 'range', min: 0, max: 0.9, step: 0.01, hint: '0: none · a lake, a river, the sea, as high as this much of its height. It is a trigger zone (Physics → Parts): rules can tell when you are in it' }),
      f('waterColor', 'Water colour', { type: 'color' }),
      { group: 'Colours' },
      f('grass', 'Grass', { type: 'color' }),
      f('rock', 'Rock (steep)', { type: 'color' }),
      f('rockSlope', 'Rock from', { type: 'range', min: 0, max: 1, step: 0.05, hint: 'How steep before it is rock: 0 only cliffs · 1 even gentle slopes' }),
      f('snow', 'Snow', { type: 'color' }),
      f('snowLine', 'Snow line', { type: 'range', min: 0, max: 1, step: 0.01, hint: 'How high up the snow starts, of its height · 1: no snow' }),
      f('sand', 'Sand (by the water)', { type: 'color' }),
      f('ground', 'Ground', { type: 'select', options: ['textured', 'plain'], hint: 'Textured: a fine grain of earth and grass under its colours, tiled by the metre' }),
      f('groundScale', 'Grain size (m)', { type: 'range', min: 0.5, max: 20, step: 0.5, hint: 'How many metres the ground texture repeats over' }),
      { group: 'Paints (Sculpt & paint)' },
      f('darkGrass', 'Dark grass', { type: 'color' }),
      f('dirt', 'Dirt (and mud)', { type: 'color' }),
      f('path', 'Path', { type: 'color' }),
      f('flowers', 'Flowers', { type: 'color' }),
    ],
  },
  scatter: {
    label: 'Scatter',
    icon: '🌲',
    defaults: SCATTER_DEFAULTS,
    normalize: normalizeScatter,
    build: buildScatter,
    parts: {},
    /** Trunks and rocks are bumped into (a collider of boxes); grass and flowers are walked through. */
    wantsBody: (p) => !!p.solid && !['grass', 'flowers'].includes(p.kind),
    /** Choosing a kind also sets what suits it: how many, how far apart, its colours. */
    onChange(params, key) { return key === 'kind' ? { ...params, ...SCATTER_PRESETS[params.kind] } : params; },
    fields: [
      { group: 'What' },
      f('kind', 'Kind', { type: 'select', options: SCATTER_KINDS, labels: SCATTER_LABELS }),
      f('count', 'How many', { type: 'range', min: 0, max: 20000, step: 10 }),
      f('size', 'Area (m)', { type: 'range', min: 2, max: 1000, step: 1, hint: 'How far across the area is, each way: its box in the view' }),
      f('seed', 'Variation', { type: 'number', min: 1, max: 99999, step: 1, dice: true, hint: 'Another number: another arrangement (🎲 picks one)' }),
      { group: 'Where' },
      f('spacing', 'Spacing (m)', { type: 'range', min: 0, max: 20, step: 0.05, hint: 'No two closer than this' }),
      f('clumping', 'Clumping', { type: 'range', min: 0, max: 1, step: 0.05, hint: '0: spread evenly · 1: in groups (copses, patches)' }),
      f('maxSlope', 'Steepest (°)', { type: 'range', min: 0, max: 90, step: 1, hint: 'Not on ground steeper than this' }),
      f('avoidWater', 'Not in water', { type: 'boolean', hint: 'Not under a terrain’s water' }),
      f('notOn', 'Not on', { type: 'select', options: SCATTER_NOT_ON, hint: 'Kept off what is painted on the terrain (Sculpt & paint): a path through a forest stays clear' }),
      { group: 'Look' },
      f('scaleMin', 'Smallest', { type: 'range', min: 0.1, max: 5, step: 0.05 }),
      f('scaleMax', 'Biggest', { type: 'range', min: 0.1, max: 5, step: 0.05 }),
      f('color', 'Colour', { type: 'color', hint: 'Leaves, grass, stone, petals' }),
      f('color2', 'Second colour', { type: 'color', hint: 'Trunks, stems' }),
      f('variety', 'Variety', { type: 'range', min: 0, max: 1, step: 0.05, hint: 'How much each one’s colour differs from the next' }),
      { group: 'Play' },
      f('solid', 'Solid (trunks, rocks)', { type: 'boolean', hint: 'Bumped into: a box round each trunk or rock. Grass and flowers are always walked through' }),
      f('far', 'Draw distance (m)', { type: 'range', min: 0, max: 1000, step: 5, hint: 'Not drawn farther away than this (0: always) — grass need not be drawn a valley away' }),
    ],
  },
  building: {
    label: 'Building',
    icon: '🏠',
    defaults: BUILDING_DEFAULTS,
    normalize: normalizeBuilding,
    build: buildBuilding,
    parts: {},
    fields: [
      { group: 'Size' },
      f('width', 'Width (m)', { type: 'range', min: 2, max: 60, step: 0.5 }),
      f('depth', 'Depth (m)', { type: 'range', min: 2, max: 60, step: 0.5 }),
      f('storeys', 'Storeys', { type: 'number', min: 1, max: 10, step: 1 }),
      f('storeyHeight', 'Storey height (m)', { type: 'range', min: 2.2, max: 6, step: 0.1 }),
      f('wall', 'Wall thickness (m)', { type: 'range', min: 0.05, max: 1, step: 0.05 }),
      { group: 'Inside' },
      f('rooms', 'Rooms', { type: 'select', options: ROOM_LAYOUTS, hint: 'two rooms: a wall across the middle, a doorway in it' }),
      f('stairs', 'Stairs between storeys', { type: 'boolean', hint: 'A flight along the back wall, a hole in the floor above it' }),
      { group: 'Door' },
      f('door', 'Door', { type: 'select', options: [...SIDES, 'none'], hint: 'Which side the way in is on: front faces +Z' }),
      f('doorOffset', 'Along the wall', { type: 'range', min: -1, max: 1, step: 0.05, hint: '−1 one end · 0 the middle · 1 the other end' }),
      f('doorWidth', 'Door width (m)', { type: 'range', min: 0.6, max: 4, step: 0.05 }),
      f('doorHeight', 'Door height (m)', { type: 'range', min: 1.6, max: 4, step: 0.05 }),
      { group: 'Windows' },
      f('windows', 'Per wall, per storey', { type: 'number', min: 0, max: 20, step: 1 }),
      f('windowWidth', 'Width (m)', { type: 'range', min: 0.2, max: 4, step: 0.05 }),
      f('windowHeight', 'Height (m)', { type: 'range', min: 0.2, max: 3, step: 0.05 }),
      f('sill', 'From the floor (m)', { type: 'range', min: 0, max: 3, step: 0.05 }),
      f('glass', 'Glass in them', { type: 'boolean', hint: 'Off: open holes you can climb through' }),
      { group: 'Roof' },
      f('roof', 'Roof', { type: 'select', options: ROOF_TYPES, labels: ROOF_LABELS }),
      f('pitch', 'Pitch (°)', { type: 'range', min: 5, max: 70, step: 1 }),
      f('overhang', 'Overhang (m)', { type: 'range', min: 0, max: 3, step: 0.05 }),
      { group: 'Look' },
      f('wallStyle', 'Walls', { type: 'select', options: WALL_STYLES }),
      f('wallColor', 'Wall colour', { type: 'color' }),
      f('roofColor', 'Roof colour', { type: 'color' }),
      f('floorColor', 'Floor colour', { type: 'color' }),
      f('trimColor', 'Sills', { type: 'color' }),
    ],
  },
};
export const GENERATOR_TYPES = Object.keys(GENERATORS);

/** The generator behind an object, or null: { type, params }. */
export const generatorOf = (object3D) => object3D?.userData?.generator ?? null;

/** Build (or build again) `root`'s own parts from its settings; its other children stay. */
export function regenerate(root, params) {
  const { type } = root.userData.generator;
  const gen = GENERATORS[type];
  const p = gen.normalize(params);
  root.userData.generator = { type, params: p };
  for (const child of [...root.children]) {
    if (!child.userData.generatedPart) continue;
    root.remove(child);
    disposeObject(child);
  }
  // a terrain is levelled under what stands on it (ground-pads.js): not saved, worked out again
  for (const part of gen.build(p, { pads: root.userData.pads || [], root })) {
    part.userData.generatedPart = true;
    root.add(part);
  }
  root.updateMatrixWorld(true);
  return root;
}

/** A new generated object (a group), its parts made from `params` (the generator's defaults for the rest). */
export function makeGenerated(type, params = {}) {
  const gen = GENERATORS[type];
  if (!gen) throw new Error(`no generator "${type}"`);
  const root = new THREE.Group();
  root.name = gen.label;
  root.userData.kind = 'Prop';
  root.userData.generator = { type, params: gen.normalize({ ...gen.defaults, ...params }) };
  return regenerate(root, root.userData.generator.params);
}
