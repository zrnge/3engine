import * as THREE from 'three';
import { measureLocal } from './physics.js';

/**
 * Where an object turns and grows from: its pivot. By itself, that's its origin
 * (a box's middle, a model's feet). A door turns about its hinge side instead,
 * a moon about its planet, and a pillar grows up from its bottom. And for a
 * Move object: which point of it arrives (its bottom, on the spot).
 *
 * Its sides are its own, whatever way it's turned. Left is its −X side and
 * front its +Z side, as the editor first looks at it. So a swung door keeps its
 * hinge side.
 */

export const PIVOTS = ['its origin', 'a point on it', 'an object'];
const SIDE = { left: 'min', right: 'max', bottom: 'min', top: 'max', back: 'min', front: 'max' };

/**
 * The fields a Rotate, Turn or Scale takes for its pivot; a Move object takes
 * them for the point that arrives (no "an object" then). `only`: when they
 * matter at all (showIf). `at`: where on it, to start with.
 */
export function pivotProps({ label = 'Pivot', only = {}, object = true, at = {} } = {}) {
  const when = (extra) => ({ showIf: { ...only, ...extra } });
  const point = when({ pivot: ['a point on it'] });
  return {
    pivot: {
      type: 'select', options: object ? PIVOTS : PIVOTS.slice(0, 2), default: 'its origin', label,
      hint: object
        ? 'its origin: where it is (a box\'s middle, a model\'s feet) · a point on it: a side, edge or corner of it — a door\'s hinge side · an object: round another one'
        : 'its origin, or a point on it (its bottom: it stands on the spot)',
      redraw: true, ...(Object.keys(only).length ? { showIf: only } : {}),
    },
    pivotX: {
      type: 'select', options: ['left', 'middle', 'right'], default: at.x ?? 'middle', label: '…across (X)',
      hint: 'left: its −X side (on the left as the editor first looks at it) · right: its +X side', redraw: true, ...point,
    },
    pivotY: {
      type: 'select', options: ['bottom', 'middle', 'top'], default: at.y ?? 'middle', label: '…up (Y)', redraw: true, ...point,
    },
    pivotZ: {
      type: 'select', options: ['back', 'middle', 'front'], default: at.z ?? 'middle', label: '…deep (Z)',
      hint: 'front: its +Z side, the way it faces (towards the editor\'s first view) · back: its −Z side', redraw: true, ...point,
    },
    ...(object ? {
      pivotObject: {
        type: 'object', default: '', label: 'Pivot object', redraw: true, ...when({ pivot: ['an object'] }),
      },
    } : {}),
  };
}

let _bounds = new WeakMap(); // object -> its size in its own space (measured once a play, or a redraw)

/** Measure again: a new play, or an edit in the editor (a shape changed). */
export function forgetBounds() { _bounds = new WeakMap(); }

function boundsOf(o) {
  let b = _bounds.get(o);
  if (!b) {
    b = measureLocal(o, new THREE.Box3());
    if (!b.isEmpty()) _bounds.set(o, b); // a model still loading: measured again next time
  }
  return b;
}

/**
 * Its pivot, as a point in the world — or null: its origin (nothing to do).
 * `resolve(name)` finds a pivot object.
 */
export function pivotPoint(t, action, resolve = null) {
  const o = t?.object3D;
  const how = action?.pivot;
  if (!o || !how || how === 'its origin') return null;
  if (how === 'an object') {
    const at = resolve?.(action.pivotObject);
    return at?.object3D && at !== t ? at.object3D.getWorldPosition(new THREE.Vector3()) : null;
  }
  const b = boundsOf(o);
  if (b.isEmpty()) return null;
  const c = b.getCenter(new THREE.Vector3());
  const pick = (axis, side) => (SIDE[side] ? b[SIDE[side]][axis] : c[axis]);
  o.updateWorldMatrix(true, false);
  return o.localToWorld(new THREE.Vector3(pick('x', action.pivotX), pick('y', action.pivotY), pick('z', action.pivotZ)));
}

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _d = new THREE.Quaternion();

/** Turn it to `q` about `pivot` (a point in the world; null: its origin): the pivot stays where it is. */
export function turnAround(o, q, pivot = null) {
  if (pivot) {
    o.updateWorldMatrix(true, false);
    _p.copy(pivot);
    if (o.parent) o.parent.worldToLocal(_p); // where it is, in its parent's space
    _d.copy(q).multiply(o.quaternion.clone().invert()); // the turn it makes
    o.position.sub(_p).applyQuaternion(_d).add(_p);
  }
  o.quaternion.copy(q);
}

/** Scale it to `s` from `pivot` (a point in the world; null: its origin): the pivot stays where it is. */
export function scaleAround(o, s, pivot = null) {
  if (pivot) {
    o.updateWorldMatrix(true, false);
    const local = o.worldToLocal(_p.copy(pivot)); // the pivot, in its own space: it must stay put
    o.position.add(_v.copy(o.scale).sub(s).multiply(local).applyQuaternion(o.quaternion));
  }
  o.scale.copy(s);
}

/** How far its pivot is from its origin, in the world — what to take off where it's sent, so the pivot arrives. */
export function pivotOffset(t, action) {
  const p = pivotPoint(t, action);
  return p ? p.sub(t.object3D.getWorldPosition(_v)) : null;
}
