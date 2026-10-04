import { ENTITY_FIELDS } from './entity-fields.js';
/**
 * Live prefabs — reusable objects whose copies stay linked to them.
 *
 * A prefab is stored in the same shape as one entity of a saved scene (see
 * SceneSerializer._serializeEntity), so the scene loader builds it — in the
 * editor and in an exported game alike. Prefabs belong to the project: every
 * level shares them and they travel in the saved file and in exports.
 *
 * A copy placed from a prefab carries its name (`prefab: 'Coin'`). Editing the
 * prefab updates every copy, in every level, part by part:
 *
 *   shape · colour & texture · light · size · physics · script · components ·
 *   rules · sounds
 *
 * A part a copy has changed itself is an override and is kept. Overrides are
 * never bookkept: a part is overridden exactly when the copy's version differs
 * from the prefab's, so every inspector edit counts without extra wiring.
 * Where a copy is, which way it faces and its name always belong to the copy.
 */

/** The parts of a prefab, and the scene-entity keys each one covers. */
export const PREFAB_PARTS = {
  shape: { label: 'Shape', keys: ['type', 'primitive', 'assetId', 'assetUrl', 'lightType', 'generator', 'params'] },
  look: { label: 'Color & texture', keys: ['material', 'partMaterials'] },
  light: { label: 'Light', keys: ['color', 'intensity', 'castShadow', 'distance', 'angle', 'penumbra'] },
  size: { label: 'Size', keys: ['scale'] },
  physics: { label: 'Physics', keys: ['rigidBody', 'solid'] },
  behavior: { label: 'Script', keys: ['behavior'] },
  components: { label: 'Components', keys: ['components'] },
  rules: { label: 'Rules', keys: ['rules'] },
  sounds: { label: 'Sounds', keys: ['sounds'] },
  view: { label: 'Held in view', keys: [] },
  groups: { label: 'Groups', keys: [] },
  clips: { label: 'Animation clips', keys: ['animationFiles', 'clipCuts'] },
  // a car's wheels, an enemy's gun: the objects under it that came with the prefab
  children: { label: 'Child objects', keys: ['children'] },
};
// the plain settings (entity-fields.js), each in its part: listed there once
for (const f of ENTITY_FIELDS) {
  if (PREFAB_PARTS[f.part] && !PREFAB_PARTS[f.part].keys.includes(f.key)) PREFAB_PARTS[f.part].keys.push(f.key);
}
export const PART_NAMES = Object.keys(PREFAB_PARTS);

/** Keys that always belong to the copy, never the prefab. */
const OWN_KEYS = ['name', 'position', 'rotation', 'parent', 'targetPosition', 'prefab', 'prefabChild'];

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

/** JSON with sorted keys and no undefined, so equal data compares equal. */
export function canonical(value) {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const partOf = (data, part) => PREFAB_PARTS[part].keys.map((k) => canonical(data?.[k])).join('|');

/**
 * A prefab from one saved entity: everything but where it stands. It keeps
 * its height and facing, which new copies start with.
 */
export function prefabFromEntity(data) {
  const rec = clone(data);
  delete rec.parent;
  delete rec.prefab;
  delete rec.targetPosition;
  delete rec.name;
  const y = Array.isArray(rec.position) ? rec.position[1] : 0;
  rec.position = [0, y, 0];
  return rec;
}

/** The parts where a copy differs from its prefab. */
export function overridesOf(data, prefab) {
  if (!prefab) return [];
  return PART_NAMES.filter((part) => partOf(data, part) !== partOf(prefab, part));
}

/**
 * A copy brought up to date with its prefab: the prefab's parts, except the
 * ones in `keep`, which stay the copy's own.
 */
export function mergeFromPrefab(data, prefab, keep = []) {
  const out = {};
  for (const k of OWN_KEYS) if (data[k] !== undefined) out[k] = clone(data[k]);
  for (const part of PART_NAMES) {
    const from = keep.includes(part) ? data : prefab;
    for (const k of PREFAB_PARTS[part].keys) if (from[k] !== undefined) out[k] = clone(from[k]);
  }
  return out;
}

/** A new copy of a prefab, ready for the scene loader. */
export function instanceRecord(prefab, name, position = null) {
  const d = clone(prefab);
  d.name = name;
  d.prefab = name;
  d.parent = -1;
  if (position) d.position = [position.x ?? position[0], position.y ?? position[1], position.z ?? position[2]];
  return d;
}

/**
 * A saved copy's child objects that came with its prefab, as prefab records
 * (each on its parent, with its own) — its prefab children are separate
 * entities in the level, pointing at it with `parent`.
 */
function savedChildren(entities, index) {
  const out = [];
  entities.forEach((d, k) => {
    if (!d || d.parent !== index || !d.prefabChild) return;
    const rec = clone(d);
    delete rec.parent;
    delete rec.prefab;
    delete rec.prefabChild;
    const grand = savedChildren(entities, k);
    if (grand) rec.children = grand;
    out.push(rec);
  });
  return out.length ? out : undefined;
}

/**
 * Give saved copies new prefab children: `jobs` is [[copy index, records]].
 * The old ones go (anything a user hung under them moves up to the copy), the
 * new ones join the end, and every link by position in the list — parents,
 * the camera's target, the player — is moved to match.
 */
function replaceSavedChildren(scene, jobs) {
  const entities = scene.entities;
  const gone = new Map(); // index -> the copy it belonged to
  const drop = (parent, copy) => {
    entities.forEach((d, k) => {
      if (d && d.parent === parent && d.prefabChild && !gone.has(k)) {
        gone.set(k, copy);
        drop(k, copy);
      }
    });
  };
  for (const [copy] of jobs) drop(copy, copy);
  const moved = new Map(); // old index -> new index
  const kept = [];
  entities.forEach((d, k) => {
    if (gone.has(k)) return;
    moved.set(k, kept.length);
    kept.push(d);
  });
  const to = (i) => (Number.isInteger(i) && i >= 0 ? (moved.get(gone.has(i) ? gone.get(i) : i) ?? -1) : -1);
  for (const d of kept) if (d) d.parent = to(d.parent);
  const add = (records, parent) => {
    for (const c of records || []) {
      const { children, ...rec } = clone(c);
      kept.push({ ...rec, parent, prefabChild: true });
      add(children, kept.length - 1);
    }
  };
  for (const [copy, records] of jobs) add(records, moved.get(copy));
  scene.entities = kept;
  if (scene.camera && Number.isInteger(scene.camera.target)) scene.camera.target = to(scene.camera.target);
  if (scene.player && Number.isInteger(scene.player.target)) scene.player.target = to(scene.player.target);
}

/**
 * Bring every copy in a saved level up to date after a prefab changed from
 * `before` to `after` (null = deleted: the copies become ordinary objects) —
 * their child objects too. `scene` is the level's data (an entities array is
 * taken as well). Returns how many copies were touched.
 */
export function updateSavedCopies(scene, name, before, after) {
  const data = Array.isArray(scene) ? { entities: scene } : scene;
  const entities = data?.entities || [];
  let n = 0;
  const jobs = [];
  for (let i = 0; i < entities.length; i++) {
    const d = entities[i];
    if (!d || d.prefab !== name) continue;
    n++;
    if (!after) {
      delete d.prefab;
      continue;
    }
    const current = { ...d, children: savedChildren(entities, i) };
    const keep = overridesOf(current, before);
    const { children, ...merged } = mergeFromPrefab(current, after, keep);
    entities[i] = merged;
    if (canonical(children) !== canonical(current.children)) jobs.push([i, children]);
  }
  if (jobs.length) replaceSavedChildren(data, jobs);
  return n;
}

/**
 * Convert a prefab saved by an older Tiny3 (in the browser, in the editor's
 * copy/paste format) to the scene-entity format.
 */
export function legacyPrefab(old) {
  if (!old || typeof old !== 'object') return null;
  const xyz = (v, d = 0) => [v?.x ?? d, v?.y ?? d, v?.z ?? d];
  const rec = {
    position: [0, old.position?.y ?? 0, 0],
    rotation: xyz(old.rotation),
    scale: xyz(old.scale, 1),
    solid: !!old.solid,
  };
  if (old.light) {
    Object.assign(rec, {
      type: 'light', lightType: old.light.type, color: old.light.color,
      intensity: old.light.intensity, castShadow: !!old.light.castShadow,
    });
    for (const k of ['distance', 'angle', 'penumbra']) if (old.light[k] !== undefined) rec[k] = old.light[k];
  } else if (old.assetId || old.assetUrl) {
    rec.type = 'model';
    if (old.assetId) rec.assetId = old.assetId;
    else rec.assetUrl = old.assetUrl;
  } else if (old.primitive) {
    rec.type = 'primitive';
    rec.primitive = old.primitive;
  } else {
    return null;
  }
  if (old.material) rec.material = clone(old.material);
  if (old.rigidBody) {
    rec.rigidBody = { ...old.rigidBody };
    if (!rec.rigidBody.shape || rec.rigidBody.shape === 'auto') delete rec.rigidBody.shape;
  }
  if (old.behavior) rec.behavior = old.behavior;
  if (old.components?.length) rec.components = clone(old.components);
  if (old.rules?.length) rec.rules = clone(old.rules);
  if (old.sounds?.length) rec.sounds = clone(old.sounds);
  return rec;
}

/**
 * A saved object marked Solid, from before Solid meant a body: the static body
 * it stood for — a model's real shape, a shape's box — or null. ("Solid" only
 * drew a red box then; nothing collided with it.) For a scene's objects and
 * its prefabs alike, so a copy and its prefab still match.
 */
export function legacySolidBody(rec) {
  if (!rec?.solid || rec.rigidBody) return null;
  const body = { type: 'static', mass: 1, restitution: 0, friction: 0.5, isTrigger: false };
  if (rec.type === 'model') body.shape = 'mesh';
  return body;
}

/** A prefab record brought up to date (see legacySolidBody). */
function upgraded(rec) {
  const out = clone(rec);
  const body = legacySolidBody(out);
  if (body) out.rigidBody = body;
  if (out.solid) out.solid = false;
  return out;
}

/** The project's prefabs, by name. */
export class PrefabLibrary {
  constructor() {
    this.items = new Map();
    this.onChange = null; // host hook: redraw the asset list
  }

  names() { return [...this.items.keys()]; }
  has(name) { return this.items.has(name); }
  /** A copy of the prefab, safe to change. */
  get(name) { return clone(this.items.get(name)) ?? null; }

  set(name, rec) {
    this.items.set(name, clone(rec));
    this.onChange?.();
  }

  delete(name) {
    const had = this.items.delete(name);
    if (had) this.onChange?.();
    return had;
  }

  clear() {
    this.items.clear();
    this.onChange?.();
  }

  /** A name not taken yet: "Coin", "Coin 2", ... */
  uniqueName(base) {
    let name = String(base || 'Prefab').trim() || 'Prefab';
    if (!this.items.has(name)) return name;
    const stem = name.replace(/\s*\d+$/, '') || 'Prefab';
    let n = 2;
    while (this.items.has(`${stem} ${n}`)) n++;
    return `${stem} ${n}`;
  }

  toJSON() {
    const out = {};
    for (const [name, rec] of this.items) out[name] = clone(rec);
    return out;
  }

  load(data) {
    this.items.clear();
    for (const [name, rec] of Object.entries(data || {})) {
      if (rec && typeof rec === 'object') this.items.set(name, upgraded(rec));
    }
    this.onChange?.();
  }
}
