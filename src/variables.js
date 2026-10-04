/**
 * VariableStore — the game's named state: score, lives, ammo, keysFound.
 *
 * Rules read and write these, the HUD displays them, and `reset()` puts them back
 * to their authored values when play stops. Without this there is nowhere for a
 * game to keep a number that outlives a single object.
 *
 *   vars.define('score', 0);
 *   vars.change('score', 1);
 *   vars.onChange((name, value) => hud.update(name, value));
 */
export class VariableStore {
  constructor(initial = {}) {
    this.initial = { ...initial };
    this.values = { ...initial };
    this._listeners = new Set();
  }

  /** Declare a variable and its starting value (what `reset()` returns to). */
  define(name, value = 0) {
    this.initial[name] = value;
    if (!this.has(name)) this.set(name, value);
    return this;
  }

  remove(name) {
    delete this.initial[name];
    delete this.values[name];
    this._emit(name, undefined);
  }

  has(name) { return Object.hasOwn(this.values, name); } // its own: never Object's (constructor, toString…)

  get(name, fallback = 0) {
    return this.has(name) ? this.values[name] : fallback;
  }

  set(name, value) {
    const before = this.values[name];
    this.values[name] = value;
    if (before !== value) this._emit(name, value);
    return value;
  }

  /** Add to a numeric variable (negative to subtract). Non-numbers are ignored. */
  change(name, by) {
    const current = Number(this.get(name, 0));
    const delta = Number(by);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) return this.get(name, 0);
    return this.set(name, current + delta);
  }

  /** Restore every variable to its authored starting value. */
  reset() {
    for (const name of Object.keys(this.values)) {
      if (!Object.hasOwn(this.initial, name)) {
        this.remove(name);
      }
    }
    for (const [name, value] of Object.entries(this.initial)) {
      this.set(name, value);
    }
  }

  names() { return Object.keys(this.values).sort(); }

  /** Subscribe to changes. Returns an unsubscribe function. */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(name, value) {
    for (const fn of this._listeners) {
      try { fn(name, value); } catch (err) { console.error('[Tiny3 variables]', err); }
    }
  }

  /** The authored values, for saving. Runtime values are deliberately not saved. */
  toJSON() { return { ...this.initial }; }

  load(data = {}) {
    this.initial = { ...data };
    this.values = { ...data };
    for (const [name, value] of Object.entries(this.values)) this._emit(name, value);
  }
}

/** Compare two values with a named operator, for rule conditions. */
export function compare(left, op, right) {
  const a = Number(left);
  const b = Number(right);
  const numeric = Number.isFinite(a) && Number.isFinite(b);
  switch (op) {
    case '==': return numeric ? a === b : String(left) === String(right);
    case '!=': return numeric ? a !== b : String(left) !== String(right);
    case '>': return numeric && a > b;
    case '>=': return numeric && a >= b;
    case '<': return numeric && a < b;
    case '<=': return numeric && a <= b;
    default: return false;
  }
}

export const COMPARE_OPS = ['==', '!=', '>', '>=', '<', '<='];
