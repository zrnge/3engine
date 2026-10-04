/**
 * Project — a game made of levels.
 *
 *   { type: 'tiny3-project', version: 1, start, current,
 *     shared: { controls, variables, ui, prefabs, modules },  // the same in every level
 *     levels: [{ name, scene }, ...] }          // each a full scene (see SceneSerializer)
 *
 * Only one level lives in the engine at a time. The one being edited is written
 * back to its slot (`snapshot`) before another is opened, so every level keeps
 * its own objects, lighting, camera and music. Controls and variables belong
 * to the whole game: moving between levels keeps them, and during play the
 * variables keep their values — the score carries over.
 *
 * A plain scene file from before levels existed loads as a one-level project.
 */

import { normalizeUI } from './game-ui.js';
import { updateSavedCopies } from './prefabs.js';

export const PROJECT_TYPE = 'tiny3-project';

/** A blank level: nothing in it, daylight, the default camera. */
export function emptyLevelData() {
  return { version: 1, camera: { mode: 'orbit', target: -1 }, entities: [] };
}

export function isProject(data) {
  return !!data && data.type === PROJECT_TYPE && Array.isArray(data.levels);
}

/** Every scene in a project file (or the file itself, if it is a single scene). */
export function projectScenes(data) {
  if (isProject(data)) return data.levels.map((l) => l.scene).filter(Boolean);
  return data ? [data] : [];
}

const clone = (o) => JSON.parse(JSON.stringify(o));

export class Project {
  constructor(serializer) {
    this.serializer = serializer;
    this.engine = serializer.engine;
    this.levels = [{ name: 'Level 1', data: null }]; // null = empty (or live in the editor)
    this.current = 0; // the level being edited
    this.active = 0;  // the level in the engine right now — another one during play
    this.start = 0;   // where the game begins
    this.onLoaded = null; // host hook: refresh panels after a level loads
  }

  names() { return this.levels.map((l) => l.name); }

  /** A new project: one empty level. */
  reset() {
    this.levels = [{ name: 'Level 1', data: null }];
    this.current = this.active = this.start = 0;
  }

  uniqueName(base, except = -1) {
    const taken = new Set(this.levels.filter((_, i) => i !== except).map((l) => l.name.toLowerCase()));
    let name = String(base || 'Level').trim() || 'Level';
    if (!taken.has(name.toLowerCase())) return name;
    const stem = name.replace(/\s*\d+$/, '') || 'Level';
    let n = 2;
    while (taken.has(`${stem} ${n}`.toLowerCase())) n++;
    return `${stem} ${n}`;
  }

  /** Write the level being edited back from the engine. */
  snapshot() {
    const data = this.serializer.serialize();
    this.levels[this.current].data = data;
    return data;
  }

  /** What every level has in common: the controls and the variables. */
  shared() {
    const out = {
      controls: this.engine.gameplay.controls.toJSON(),
      variables: this.engine.variables.toJSON(),
    };
    if (this.engine.ui) out.ui = clone(this.engine.ui); // title screen, HUD styles
    if (this.engine.prefabs) out.prefabs = this.engine.prefabs.toJSON(); // one set for the whole game
    if (this.engine.modules?.list.length) out.modules = this.engine.modules.toJSON(); // code the scripts share
    return out;
  }

  _applyShared(shared, values = null) {
    if (shared?.prefabs && this.engine.prefabs) this.engine.prefabs.load(shared.prefabs);
    if (shared?.controls) this.engine.gameplay.controls.load(shared.controls);
    if (shared?.variables) this.engine.variables.load(shared.variables);
    if (shared?.ui && this.engine.ui) this.engine.ui = normalizeUI(shared.ui);
    if (shared && this.engine.modules) this.engine.modules.load(shared.modules || []);
    if (values) for (const [name, value] of Object.entries(values)) this.engine.variables.set(name, value);
  }

  /**
   * Put a level in the engine. `keepValues` carries the variables' current
   * values across — moving between levels during play.
   */
  async loadLevel(index, { keepValues = false } = {}) {
    const level = this.levels[index];
    if (!level) throw new Error(`There is no level ${index + 1}.`);
    const shared = this.shared();
    const values = keepValues ? { ...this.engine.variables.values } : null;
    await this.serializer.deserialize(clone(level.data ?? emptyLevelData()));
    this._applyShared(shared, values);
    await this.serializer.preloadPrefabs?.(); // model prefabs spawn inside a frame during play
    this.active = index;
    this.onLoaded?.(index);
  }

  /** Edit another level; the one open now is kept first. */
  async open(index) {
    if (index === this.current || !this.levels[index]) return false;
    this.snapshot();
    this.current = index;
    await this.loadLevel(index);
    return true;
  }

  /** Add an empty level after the others. Returns its index (not opened). */
  add(name) {
    this.levels.push({ name: this.uniqueName(name || `Level ${this.levels.length + 1}`), data: null });
    return this.levels.length - 1;
  }

  /** A copy of a level, right after it. Returns the copy's index. */
  duplicate(index) {
    const level = this.levels[index];
    if (!level) return -1;
    if (index === this.current) this.snapshot();
    const copy = { name: this.uniqueName(`${level.name} copy`), data: level.data ? clone(level.data) : null };
    this.levels.splice(index + 1, 0, copy);
    const shift = (i) => (i > index ? i + 1 : i);
    this.current = shift(this.current);
    this.active = shift(this.active);
    this.start = shift(this.start);
    return index + 1;
  }

  /** Delete a level (never the last one). Deleting the open one opens a neighbour. */
  async remove(index) {
    if (this.levels.length <= 1 || !this.levels[index]) return false;
    if (index === this.current) {
      const next = index > 0 ? index - 1 : 1;
      this.current = next; // the deleted level is not written back
      await this.loadLevel(next);
    }
    this.levels.splice(index, 1);
    const shift = (i) => (i > index ? i - 1 : i);
    this.current = shift(this.current);
    this.active = this.current;
    this.start = this.start === index ? 0 : shift(this.start);
    return true;
  }

  rename(index, name) {
    if (!this.levels[index]) return null;
    const clean = String(name ?? '').trim();
    if (!clean) return this.levels[index].name;
    this.levels[index].name = this.uniqueName(clean, index);
    return this.levels[index].name;
  }

  /** Move a level up (-1) or down (+1) in the order. */
  move(index, dir) {
    const to = index + dir;
    if (!this.levels[index] || !this.levels[to]) return false;
    [this.levels[index], this.levels[to]] = [this.levels[to], this.levels[index]];
    const swap = (i) => (i === index ? to : i === to ? index : i);
    this.current = swap(this.current);
    this.active = swap(this.active);
    this.start = swap(this.start);
    return true;
  }

  setStart(index) {
    if (this.levels[index]) this.start = index;
  }

  /**
   * Which level a "go to level" means, from the one playing now: 'next',
   * 'previous', 'this' / 'restart', 'first', a level's name, or its number.
   * -1 when there is no such level (e.g. 'next' from the last one).
   */
  resolve(target, from = this.active) {
    const t = String(target ?? '').trim().toLowerCase();
    if (!t || t === 'next') return from + 1 < this.levels.length ? from + 1 : -1;
    if (t === 'this' || t === 'restart' || t === 'same') return from;
    if (t === 'previous' || t === 'back') return from > 0 ? from - 1 : -1;
    if (t === 'first' || t === 'start') return this.start;
    const byName = this.levels.findIndex((l) => l.name.toLowerCase() === t);
    if (byName !== -1) return byName;
    if (/^\d+$/.test(t)) {
      const n = Number(t) - 1;
      return this.levels[n] ? n : -1;
    }
    return -1;
  }

  /**
   * A prefab changed from `before` to `after` (null: deleted). Every level not
   * in the editor right now brings its copies up to date; the one in the
   * editor is the editor's job, since its objects are live.
   */
  updatePrefabCopies(name, before, after) {
    let n = 0;
    this.levels.forEach((level, i) => {
      // the whole level: a copy's child objects may be added or removed, moving the others
      if (i !== this.current && level.data) n += updateSavedCopies(level.data, name, before, after);
    });
    return n;
  }

  /** How many copies of a prefab the levels not in the editor hold. */
  savedCopies(name) {
    let n = 0;
    this.levels.forEach((level, i) => {
      if (i === this.current || !level.data) return;
      for (const d of level.data.entities || []) if (d?.prefab === name) n++;
    });
    return n;
  }

  /** The whole game, for saving and exporting. Keeps the level being edited up to date first. */
  toJSON() {
    if (!this.engine.playing) this.snapshot();
    return {
      type: PROJECT_TYPE,
      version: 1,
      start: this.start,
      current: this.current,
      shared: this.shared(),
      levels: this.levels.map((l) => ({ name: l.name, scene: l.data ?? emptyLevelData() })),
    };
  }

  /**
   * Open a saved project — or a plain scene from before levels existed.
   * `at: 'start'` opens the start level (an exported game), otherwise the one
   * that was being edited.
   */
  async load(data, { at = 'current' } = {}) {
    let levels;
    let shared = null;
    let start = 0;
    let current = 0;
    if (isProject(data)) {
      levels = data.levels
        .filter((l) => l && typeof l === 'object')
        .map((l, i) => ({ name: String(l.name || `Level ${i + 1}`), data: l.scene || null }));
      const ok = (i) => (Number.isInteger(i) && i >= 0 && i < levels.length ? i : 0);
      start = ok(data.start);
      current = ok(data.current);
      shared = data.shared || null;
    } else if (data && data.version === 1) {
      levels = [{ name: 'Level 1', data }];
    } else {
      throw new Error('Not a Tiny3 scene or project file.');
    }
    if (!levels.length) levels = [{ name: 'Level 1', data: null }];
    this.levels = [];
    for (const l of levels) this.levels.push({ ...l, name: this.uniqueName(l.name) });
    this.start = start;
    this.current = at === 'start' ? start : current;
    await this.serializer.deserialize(clone(this.levels[this.current].data ?? emptyLevelData()));
    // older files keep controls and variables in the scene itself — those stay
    this._applyShared(shared);
    await this.serializer.preloadPrefabs?.(); // model prefabs spawn inside a frame during play
    this.active = this.current;
    this.onLoaded?.(this.current);
  }
}
