/**
 * Tiny3 — what a Behavior script can use.
 *
 * A script runs every frame in Play (the Inspector's Behavior box). It uses
 * the names below as they are, with no `this.` and nothing to import. To have
 * a code editor complete and check them while writing a script in a file,
 * put this at its top:
 *
 *     /// <reference path="./types/tiny3-script.d.ts" />
 *
 * Kept in step with src/script-api.js and src/behavior.js (a test checks).
 */

/** A point or direction, as Three.js has it (x, y, z). */
interface Vec3 {
  x: number; y: number; z: number;
  set(x: number, y: number, z: number): this;
  copy(v: Vec3): this;
  add(v: Vec3): this;
  sub(v: Vec3): this;
  multiplyScalar(s: number): this;
  addScaledVector(v: Vec3, s: number): this;
  length(): number;
  normalize(): this;
  distanceTo(v: Vec3): number;
  clone(): Vec3;
  toArray(): [number, number, number];
}

/** An object in the level, as Three.js has it: where it is, how it's turned and sized, whether it shows. */
interface Obj3D {
  name: string;
  position: Vec3;
  /** In radians. */
  rotation: { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown };
  scale: Vec3;
  visible: boolean;
  parent: Obj3D | null;
  children: Obj3D[];
  userData: Record<string, unknown>;
  getWorldPosition(target: Vec3): Vec3;
  lookAt(x: number | Vec3, y?: number, z?: number): void;
}

/** A moving body's physics. */
interface Body {
  type: 'static' | 'kinematic' | 'dynamic';
  velocity: Vec3;
  angularVelocity: Vec3;
  mass: number;
  friction: number;
  restitution: number;
  /** Negative: down. */
  gravity: number;
  grounded: boolean;
  isTrigger: boolean;
  /** What it passes through: 'player', 'group:Ghosts', an object's name. */
  ignores: string[];
}

/** Who or what: 'self', 'player', 'other', 'group:Enemies', or an object's name. */
type Who = 'self' | 'player' | 'other' | `group:${string}` | string;
/** A place: a point, [x, y, z], or an object (its position). */
type Place = Vec3 | [number, number, number] | { x: number; y: number; z: number } | Obj3D;

/** The fields of the actions scripts use most (every rule action works; see the Rules list for the rest). */
interface ActionProps {
  rotate: { target?: Who; how?: 'by' | 'to' | 'per second'; x?: number; y?: number; z?: number; relative?: 'self' | 'world'; seconds?: number;
    pivot?: 'its origin' | 'a point on it' | 'an object'; pivotX?: 'left' | 'middle' | 'right'; pivotY?: 'bottom' | 'middle' | 'top';
    pivotZ?: 'back' | 'middle' | 'front'; pivotObject?: Who };
  scale: { target?: Who; how?: 'times' | 'to' | 'by' | 'times per second'; even?: boolean; amount?: number; x?: number; y?: number; z?: number;
    seconds?: number; pivot?: 'its origin' | 'a point on it' | 'an object' };
  turn: { target?: Who; degrees?: number; how?: 'by' | 'per second'; seconds?: number };
  move: { target?: Who; direction?: 'forward' | 'back' | 'left' | 'right' | 'up' | 'down'; relative?: 'self' | 'world' | 'camera'; speed?: number };
  moveObject: { target?: Who; how?: 'by' | 'to' | 'to object'; x?: number; y?: number; z?: number; object?: Who; seconds?: number };
  push: { target?: Who; direction?: string; relative?: 'self' | 'world' | 'camera'; strength?: number };
  jump: { target?: Who; strength?: number; ground?: boolean };
  face: { target?: Who; at?: Who };
  stop: { target?: Who };
  destroy: { target?: Who; after?: number };
  setVisible: { target?: Who; visible?: boolean };
  spawn: { prefab: string; at?: 'self' | 'origin' };
  showMessage: { text: string; seconds?: number; where?: 'top' | 'middle' | 'bottom' };
  setVariable: { name: string; value: number };
  changeVariable: { name: string; by: number };
  playAnimation: { target?: Who; clip: string; mode?: string };
  playSound: { target?: Who; sound: string };
  damage: { target?: Who; amount?: number };
  win: { message?: string };
  lose: { message?: string };
  goToLevel: { level: string };
  saveGame: { slot?: string };
  loadGame: { slot?: string };
  checkpoint: { at?: 'here' | 'where the player is' };
  respawn: { target?: Who; heal?: boolean };
}

// ---- this object, and the moment

/** This object. */
declare const entity: Obj3D;
/** Its physics body, or null. */
declare const body: Body | null;
/** Seconds since the last frame. */
declare const delta: number;
/** Seconds since the game started. */
declare const time: number;
/** True on the script's first frame. */
declare const first: boolean;
/** Kept between frames: `state.count = (state.count || 0) + 1`. */
declare const state: Record<string, any>;

// ---- input

/** Keys held now: keys.KeyW, keys.Space, keys.ArrowLeft. */
declare const keys: Record<string, boolean>;
/** Pressed this frame: pressed('KeyE'). */
declare function pressed(code: string): boolean;
/** Held down now. */
declare function held(code: string): boolean;
/** Let go this frame. */
declare function released(code: string): boolean;
/** The mouse: where it points (-1…1 across and up the view), and its buttons (0 left, 1 middle, 2 right). */
declare const mouse: { readonly x: number; readonly y: number; down(button?: number): boolean; clicked(button?: number): boolean };

// ---- the game

/** The game's variables: score, lives, keys found… */
declare const vars: {
  get(name: string, fallback?: number): number;
  set(name: string, value: number): number;
  change(name: string, by?: number): number;
  has(name: string): boolean;
};
/** The nearest object by name — or of a group ('group:Enemies'). */
declare function find(name: Who): Obj3D | null;
/** All of them: every object with that name, or in that group — the nearest first. */
declare function findAll(name: Who): Obj3D[];
/** The player's object. */
declare const player: Obj3D | null;
/** The camera. */
declare const camera: Obj3D;
/** Any rule action, with this object as "me". False if there's no such action. */
declare function act<T extends keyof ActionProps>(type: T, props?: ActionProps[T]): boolean;
declare function act(type: string, props?: Record<string, unknown>): boolean;
/** A script module's exports (Tools → Modules). At a script's top, `import { x } from 'name'` does the same. */
declare function use(module: string): Record<string, any>;
/** A copy of a prefab, here — or at a place or object. */
declare function spawn(prefab: string, at?: Place): Obj3D | null;
/** Destroy it (this object if none is given). */
declare function destroy(what?: Obj3D | Who): void;
/** Take health off it (its Health component). */
declare function damage(what: Obj3D | Who, amount?: number): boolean;
/** A line of text on screen. */
declare function message(text: string, seconds?: number, where?: 'top' | 'middle' | 'bottom'): void;
/** Play one of its sounds, by name (all of them: none given). */
declare function sound(name?: string): void;
/** Play one of its animations: play('Run', 'loop'). */
declare function play(clip: string, mode?: 'once' | 'loop' | string): void;

// ---- the world

/** What it touches now — anything, or only who: touching('group:Enemies'). */
declare function touching(who?: Who): Obj3D[];
/** The first solid thing along a ray (trigger zones aren't in the way). */
declare function raycast(from: Place, dir: Place, max?: number): { object: Obj3D; point: Vec3; normal: Vec3; distance: number } | null;
/** Metres to an object, a place, or an object by name. */
declare function distanceTo(what: Place | Who): number;

// ---- saving

/** Save the game (a slot's name: several can be kept). */
declare function save(slot?: string): boolean;
/** Load it. */
declare function load(slot?: string): boolean;

// ---- and

/** Play its sounds tagged "fire". */
declare function fire(): void;
/** Write to the browser's console, with this object's name. */
declare function log(...args: unknown[]): void;
/** The whole engine, for anything else. */
declare const engine: any;
/** Three.js: new THREE.Vector3(0, 1, 0). */
declare const THREE: any;
