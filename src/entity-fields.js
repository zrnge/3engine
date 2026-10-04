import { groupsOf, normalizeGroups } from './groups.js';
import { normalizeViewModel } from './view-model.js';
import { normalizePhysicsParts } from './physics-parts.js';

/**
 * An object's own settings that are plain data — its groups, what it holds in
 * view, its parts' physics, whether it flattens the ground — described once,
 * here. Saving and loading a level (scene.js), copy, paste and duplicate
 * (editor/clipboard.js) and prefabs (prefabs.js: which part each belongs to)
 * all go through this list, so a new setting is added in one place.
 *
 * (They used to be written out by hand in each of those, and a setting left
 * out of one was lost there without a word — a pasted house no longer kept the
 * ground out of it.)
 *
 *   key   its name, on the object and in its record
 *   part  the prefab part it belongs to (prefabs.js PREFAB_PARTS)
 *   save  object → the value to keep, or undefined: nothing to keep
 *   load  (object, value from a record) → sets it, or clears it
 *
 * What has more to it than data — a body to register, a script to start,
 * components, rules, sounds — is still done where that happens.
 */
export const ENTITY_FIELDS = [
  {
    key: 'groups', part: 'groups', // 'Enemies', 'Targets'…
    save: (e) => (groupsOf(e).length ? [...groupsOf(e)] : undefined),
    load: (e, v) => {
      const g = normalizeGroups(v);
      if (g.length) e.groups = g;
      else delete e.groups;
    },
  },
  {
    key: 'viewModel', part: 'view', // held in first-person view
    save: (e) => (e.viewModel ? normalizeViewModel(e.viewModel) : undefined),
    load: (e, v) => {
      const vm = normalizeViewModel(v);
      if (vm) e.viewModel = vm;
      else delete e.viewModel;
    },
  },
  {
    key: 'physicsParts', part: 'physics', // a model's parts: left out, own box, trigger zone (before its body is registered)
    save: (e) => normalizePhysicsParts(e.physicsParts),
    load: (e, v) => {
      const parts = normalizePhysicsParts(v);
      if (parts) e.physicsParts = parts;
      else delete e.physicsParts;
    },
  },
  {
    key: 'flattenGround', part: 'physics', // a terrain under it is levelled (ground-pads.js)
    save: (e) => (e.flattenGround ? true : undefined),
    load: (e, v) => {
      if (v) e.flattenGround = true;
      else delete e.flattenGround;
    },
  },
];

const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** An object's settings as a record's fields (only those it has): fresh copies, safe to keep. */
export function saveFields(entity) {
  const out = {};
  for (const f of ENTITY_FIELDS) {
    const v = copy(f.save(entity));
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

/** Set an object's settings from a record — each one it names, and cleared where it names none. */
export function loadFields(entity, record = {}) {
  for (const f of ENTITY_FIELDS) f.load(entity, copy(record?.[f.key]));
  return entity;
}
