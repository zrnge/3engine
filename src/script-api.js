import * as THREE from 'three';
import { ACTIONS, runAction, withDefaults } from './rules.js';

/**
 * The scripting API — what a Behavior script can use, besides `entity`,
 * `body`, `delta`, `time`, `keys`, `engine`, `fire()` and `log()`
 * (behavior.js). All of it is plain names, with no `this.`, and each part
 * is one line.
 *
 * `act(type, props)` runs any rule action, so everything a rule can do, a
 * script can too:
 *   act('rotate', { how: 'per second', y: 90 })
 *   act('scale', { how: 'times', amount: 2, seconds: 0.5 })
 *   act('destroy', { target: 'group:Coins' })
 *
 * The same list is in types/tiny3-script.d.ts, for code editors, and in the
 * Inspector's help.
 */

/** Every name a script can use, and what it is — for the Inspector's help (and checked against the d.ts). */
export const SCRIPT_API = Object.freeze([
  ['entity', 'this object (its position, rotation, scale, visible…)'],
  ['body', 'its physics body, or null: body.velocity.y = 8'],
  ['delta', 'seconds since the last frame'],
  ['time', 'seconds since the game started'],
  ['first', 'true on the script\'s first frame'],
  ['state', 'an object kept between frames: state.count = (state.count || 0) + 1'],
  ['keys', 'keys held: keys.KeyW, keys.Space, keys.ArrowLeft'],
  ['pressed(code)', 'pressed this frame: pressed("KeyE")'],
  ['held(code)', 'held down: held("ShiftLeft")'],
  ['released(code)', 'let go this frame'],
  ['mouse', 'mouse.x, mouse.y (-1…1), mouse.down(0), mouse.clicked(0)'],
  ['vars', 'variables: vars.get("score"), vars.set("lives", 3), vars.change("score", 1)'],
  ['find(name)', 'the nearest object by name, or of a group: find("Door"), find("group:Enemies")'],
  ['findAll(name)', 'all of them: findAll("group:Coins")'],
  ['player', 'the player\'s object'],
  ['camera', 'the camera'],
  ['act(type, props)', 'any rule action: act("rotate", { y: 90, seconds: 1 })'],
  ['spawn(prefab, at)', 'a prefab copy, here or at a place / object; returns it'],
  ['destroy(what)', 'destroy it (this object, if none given)'],
  ['damage(what, amount)', 'take health off it'],
  ['message(text, seconds)', 'a line of text on screen'],
  ['sound(name)', 'play one of its sounds'],
  ['play(clip, mode)', 'play an animation: play("Run", "loop")'],
  ['touching(who)', 'what it touches now: touching("group:Enemies")'],
  ['raycast(from, dir, max)', 'the first thing along a ray: { object, point, normal, distance }'],
  ['distanceTo(what)', 'metres to an object (or a name)'],
  ['save(slot)', 'save the game'],
  ['load(slot)', 'load it'],
  ['use(module)', 'a script module’s exports: const { wobble } = use("maths") — or, at the top, import { wobble } from "maths"'],
  ['fire()', 'play its sounds tagged "fire"'],
  ['log(...)', 'write to the browser console'],
  ['engine', 'the whole engine, for anything else'],
  ['THREE', 'Three.js: new THREE.Vector3(0, 1, 0)'],
]);

const vec = (v, out = new THREE.Vector3()) => {
  if (!v) return null;
  if (v.isVector3) return out.copy(v);
  if (v.isObject3D) return v.getWorldPosition(out);
  if (v.object3D) return v.object3D.getWorldPosition(out);
  if (Array.isArray(v)) return out.set(Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0);
  if (typeof v === 'object' && 'x' in v) return out.set(Number(v.x) || 0, Number(v.y) || 0, Number(v.z) || 0);
  return null;
};

/** The API for one entity's script: what gets added to its scope (see behavior.js). */
export function scriptApi(engine, entity) {
  const gameplay = () => engine.gameplay;
  const api = () => engine.gameplay.api;
  const input = () => engine.input;
  const entityOf = (what) => {
    if (what === undefined || what === null) return entity;
    if (what.object3D) return what;
    if (what.isObject3D) return engine.entities.find((e) => e.object3D === what) ?? null;
    return api().resolveTarget(String(what), entity, null);
  };
  const warned = new Set();
  const selector = (what) => {
    if (what === undefined || what === null) return 'self';
    if (typeof what === 'string') return what;
    const e = entityOf(what);
    return e === entity ? 'self' : e?.object3D?.name ?? 'self';
  };

  return {
    state: {},
    first: true,
    THREE,
    get player() { return engine.playerEntity?.object3D ?? null; },
    get camera() { return engine.camera; },
    vars: {
      get: (name, fallback = 0) => engine.variables.get(name, fallback),
      set: (name, value) => engine.variables.set(name, value),
      change: (name, by = 1) => engine.variables.change(name, by),
      has: (name) => engine.variables.has(name),
    },
    pressed: (code) => !!input()?.wasPressed(code),
    held: (code) => !!input()?.isDown(code),
    released: (code) => !!input()?.wasReleased?.(code),
    mouse: {
      get x() { return input()?.mouseNDC?.x ?? 0; },
      get y() { return input()?.mouseNDC?.y ?? 0; },
      down: (button = 0) => !!input()?.mouseDown?.(button),
      clicked: (button = 0) => !!(input()?.pointerLocked ? input()?.mouseClicked?.(button) : input()?.mouseTapped?.(button)),
    },
    find: (name) => api().resolveTarget(String(name), entity, null)?.object3D ?? null,
    findAll: (name) => api().resolveAll(String(name), entity, null).map((e) => e.object3D),
    /** Any rule action, with this object as "me": act('rotate', { y: 90 }). False if there's no such action. */
    act: (type, props = {}) => {
      const def = ACTIONS[type];
      if (!def) {
        if (!warned.has(type)) { warned.add(type); console.warn(`[Tiny3 script] there is no action "${type}". Try one of: ${Object.keys(ACTIONS).join(', ')}`); }
        return false;
      }
      const action = withDefaults(def.props, { ...props, type });
      if (action.target && typeof action.target !== 'string') action.target = selector(action.target);
      runAction(def, {
        action, vars: engine.variables, entity, other: null, engine, api: api(), time: engine.time ?? 0, dt: engine._lastDt ?? 1 / 60,
      });
      return true;
    },
    spawn: (prefab, at = entity) => {
      const p = vec(at) ?? entity.object3D.getWorldPosition(new THREE.Vector3());
      return api().spawn(prefab, { x: p.x, y: p.y, z: p.z })?.object3D ?? null;
    },
    destroy: (what) => { const e = entityOf(what); if (e) gameplay().destroy(e); },
    damage: (what, amount = 1) => { const e = entityOf(what); return e ? gameplay().damage(e, amount, entity) : false; },
    message: (text, seconds = 3, where = 'middle') => engine.onMessage?.(String(text), { seconds, where }),
    sound: (name = '') => engine.playSound?.(entity, name),
    play: (clip, mode = 'once') => ACTIONS.playAnimation ? runAction(ACTIONS.playAnimation, {
      action: withDefaults(ACTIONS.playAnimation.props, { type: 'playAnimation', clip, mode, target: 'self' }),
      vars: engine.variables, entity, other: null, engine, api: api(), time: engine.time ?? 0,
    }) : undefined,
    touching: (who = 'any') => (engine.physics?.touching(entity) || [])
      .filter((e) => who === 'any' || api().resolveAll(String(who), entity, null).includes(e))
      .map((e) => e.object3D),
    raycast: (from, dir, max = 100) => {
      const o = vec(from);
      const d = vec(dir, new THREE.Vector3());
      if (!o || !d || d.lengthSq() < 1e-12) return null;
      const hit = engine.physics?.raycast(o, d, max, { skip: (e) => e === entity });
      return hit ? { object: hit.entity.object3D, point: hit.point, normal: hit.normal, distance: hit.distance } : null;
    },
    distanceTo: (what) => {
      const p = typeof what === 'string' ? api().resolveTarget(what, entity, null)?.object3D : what;
      const a = vec(p);
      return a ? entity.object3D.getWorldPosition(new THREE.Vector3()).distanceTo(a) : Infinity;
    },
    use: (name) => engine.modules.use(name),
    save: (slot) => gameplay().saveGame(slot),
    load: (slot) => gameplay().loadGame(slot),
  };
}
