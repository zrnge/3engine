import { groupsOf } from './groups.js';

/**
 * The objects in play by name and by group — so a rule, a control or a
 * component naming "Robot 3" or "group:Enemies" finds it at once, instead of
 * looking through every object in the level each time (thousands of objects,
 * each asked about every frame by a Follower or a rule, added up).
 *
 * Kept up to date as objects come and go (Engine.add / remove) and as they are
 * renamed or regrouped: an object's name and its groups are watched — set
 * them (object3D.name = …, entity.groups = […]) and the index follows. Names
 * and groups are matched ignoring case, as everywhere else.
 */
const key = (s) => String(s ?? '').toLowerCase();

export class EntityIndex {
  constructor() {
    this._names = new Map();  // lower-case name -> Set of entities
    this._groups = new Map(); // lower-case group -> Set of entities
    this._members = new Set();
  }

  get size() { return this._members.size; }

  /** An object in play: indexed, and its name and groups watched from now on. */
  add(entity) {
    if (!entity?.object3D || this._members.has(entity)) return;
    this._watch(entity);
    this._members.add(entity);
    this._file(entity, entity.object3D.name, groupsOf(entity));
  }

  /** Gone from play. */
  remove(entity) {
    if (!this._members.delete(entity)) return;
    this._unfile(entity, entity.object3D.name, groupsOf(entity));
  }

  /** The objects with this name (ignoring case), still in play. */
  named(name) {
    return this._live(this._names.get(key(name)));
  }

  /** The objects in this group (ignoring case), still in play. */
  grouped(group) {
    return this._live(this._groups.get(key(group)));
  }

  _live(set) {
    return set ? [...set].filter((e) => e.alive !== false) : [];
  }

  _put(map, k, e) {
    let set = map.get(k);
    if (!set) map.set(k, (set = new Set()));
    set.add(e);
  }

  _take(map, k, e) {
    const set = map.get(k);
    if (!set) return;
    set.delete(e);
    if (!set.size) map.delete(k);
  }

  _file(e, name, groups) {
    this._put(this._names, key(name), e);
    for (const g of groups) this._put(this._groups, key(g), e);
  }

  _unfile(e, name, groups) {
    this._take(this._names, key(name), e);
    for (const g of groups) this._take(this._groups, key(g), e);
  }

  /**
   * Its name and its groups, watched: set either and the index follows. Done
   * once per object (an object back in play after Undo is watched already).
   */
  _watch(e) {
    const o = e.object3D;
    const index = this;
    if (!Object.getOwnPropertyDescriptor(o, 'name')?.get) {
      let name = o.name;
      Object.defineProperty(o, 'name', {
        configurable: true, enumerable: true,
        get() { return name; },
        set(v) {
          if (v === name) return;
          const was = name;
          name = v;
          for (const idx of watchers(e)) idx._rename(e, was, v);
        },
      });
    }
    if (!Object.getOwnPropertyDescriptor(e, 'groups')?.get) {
      let groups = e.groups;
      Object.defineProperty(e, 'groups', {
        configurable: true, enumerable: true,
        get() { return groups; },
        set(v) {
          const was = groupsOf(e);
          groups = v;
          for (const idx of watchers(e)) idx._regroup(e, was, groupsOf(e));
        },
      });
    }
    indexesOf(e).add(index);
  }

  _rename(e, from, to) {
    if (!this._members.has(e)) return;
    this._take(this._names, key(from), e);
    this._put(this._names, key(to), e);
  }

  _regroup(e, from, to) {
    if (!this._members.has(e)) return;
    for (const g of from) this._take(this._groups, key(g), e);
    for (const g of to) this._put(this._groups, key(g), e);
  }
}

// which indexes watch an object (one, in practice: its engine's)
const _indexes = new WeakMap();
const indexesOf = (e) => {
  let set = _indexes.get(e);
  if (!set) _indexes.set(e, (set = new Set()));
  return set;
};
const watchers = (e) => _indexes.get(e) ?? [];
