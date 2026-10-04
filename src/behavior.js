/**
 * Behaviors — the per-entity scripts the inspector's Behavior box compiles.
 *
 * A script body runs once per frame with these in scope as plain locals, so a
 * beginner never has to write `this.`:
 *
 *   entity   the THREE.Object3D being driven
 *   body     its RigidBody, or null
 *   delta    seconds since the previous frame
 *   time     seconds since the engine started
 *   keys     keys.KeyW / keys.Space / keys.ArrowLeft -> boolean
 *   engine   the Engine, for anything else
 *   fire()   play this entity's sounds tagged with the 'fire' trigger
 *   log(...) console.log, tagged with the entity's name
 *
 * and the scripting API (script-api.js): vars, find, act — any rule action —,
 * spawn, destroy, message, pressed / held, mouse, touching, raycast, state,
 * first and more; types/tiny3-script.d.ts lists it all, for code editors.
 *
 * e.g.   entity.rotation.y += delta * 2
 *        if (keys.Space) body.velocity.y = 8
 *
 * Kept out of engine.js so it can be tested without a WebGL context.
 */

import { scriptImports } from './script-modules.js';

/** The scripting API's names (script-api.js), each a plain local in a script. */
export const API_NAMES = Object.freeze([
  'state', 'first', 'THREE', 'player', 'camera', 'vars', 'pressed', 'held', 'released', 'mouse', 'find', 'findAll',
  'act', 'spawn', 'destroy', 'damage', 'message', 'sound', 'play', 'touching', 'raycast', 'distanceTo', 'save', 'load',
  'use',
]);

const HEADER = [
  'const entity = this.entity;',
  'const engine = this.engine;',
  'const body = this.body;',
  'const delta = dt;',
  'const time = elapsed;',
  'const keys = this.keys;',
  'const fire = (...a) => this.fire(...a);',
  'const log = (...a) => this.log(...a);',
  ...API_NAMES.map((n) => `const ${n} = this.${n};`),
].join('\n');

/**
 * Compile a script body into a function invoked as fn.call(scope, dt, time).
 * The script runs in a function of its own inside, so a name it declares
 * itself (an older script's own `state` or `player`) is its own, not a clash.
 * Its `import { … } from 'module'` lines take from the game's script modules
 * (script-modules.js), each as a `use('module')` on the same line.
 */
export function compileBehavior(code) {
  code = scriptImports(code);
  // parameter names are deliberately not `delta`/`time` — the header rebinds
  // those to friendlier locals, and shadowing a parameter would be a syntax error
  return new Function('dt', 'elapsed', `${HEADER}\nreturn (function () {\n${code}\n}).call(this);`);
}

/** The line in an error's stack, from a script's code: Chrome's, Firefox's or Safari's way of saying it. */
const lineIn = (err) => {
  const m = String(err?.stack || '').match(/(?:<anonymous>|Function|eval[^:]*):(\d+):\d+/);
  return m ? Number(m[1]) : null;
};
let _firstLine; // where a script's own line 1 is, measured once (the header comes first)

/** Which line of the script an error happened on (1 = its first), or null if the browser won't say. */
export function scriptLine(err) {
  if (_firstLine === undefined) {
    try { compileBehavior('throw new Error("probe")').call({}, 0, 0); } catch (probe) { _firstLine = lineIn(probe); }
  }
  const at = lineIn(err);
  return at && _firstLine ? at - _firstLine + 1 : null;
}

export class BehaviorRunner {
  constructor() {
    this.items = []; // { entity, code, fn, scope, failed }
  }

  /**
   * Compile and register a script for an entity, replacing any previous one.
   * Returns the record, or null for empty code.
   */
  add(entity, code, { engine = null, fire = null, log = null, api = null } = {}) {
    this.remove(entity);
    if (!code || !code.trim()) return null;

    // NOTE: every field here must be a plain writable property. These used to be
    // getters, and the per-frame `scope.delta = dt` write threw TypeError in
    // strict mode on the very first frame — so no behavior script ever ran.
    const scope = {
      entity: entity.object3D,
      engine,
      body: entity.rigidBody ?? null,
      delta: 0,
      time: 0,
      keys: {},
      fire: fire || (() => {}),
      log: log || ((...args) => console.log('[behavior]', ...args)),
    };
    // the scripting API (script-api.js) — getters kept as getters (player, camera)
    if (api) Object.defineProperties(scope, Object.getOwnPropertyDescriptors(api));

    let fn;
    try {
      fn = compileBehavior(code);
    } catch (err) {
      console.error('[Tiny3 behavior] could not compile script for',
        entity.object3D?.name, err);
      return null;
    }

    const item = { entity, code, fn, scope, failed: false };
    this.items.push(item);
    return item;
  }

  remove(entity) {
    const i = this.items.findIndex((b) => b.entity === entity);
    if (i !== -1) this.items.splice(i, 1);
  }

  get(entity) {
    return this.items.find((b) => b.entity === entity) ?? null;
  }

  clear() { this.items.length = 0; }

  /**
   * Run every live script for one frame.
   * A script that throws is reported once and disabled — otherwise a typo
   * floods the console sixty times a second. Re-applying the script revives it.
   * @returns {number} how many scripts actually ran
   */
  run(dt, time, keys = {}, onError = null, timed = null) {
    let ran = 0;
    for (const b of this.items) {
      if (b.failed) continue;
      b.scope.delta = dt;
      b.scope.time = time;
      b.scope.keys = keys;
      b.scope.body = b.entity.rigidBody ?? null;
      const t0 = timed ? performance.now() : 0;
      try {
        b.fn.call(b.scope, dt, time);
        b.scope.first = false;
        ran++;
        timed?.(b, performance.now() - t0); // the Profiler: how long each script takes
      } catch (err) {
        b.failed = true;
        if (onError) onError(b, err);
        else {
          console.error(
            `[Tiny3 behavior] "${b.entity.object3D?.name}" threw and was disabled:`, err
          );
        }
      }
    }
    return ran;
  }
}
