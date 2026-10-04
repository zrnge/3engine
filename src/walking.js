/**
 * Walking by itself: a step towards a point (by a Dynamic body's speed, or by
 * moving it; a car steers and uses its pedals), standing still, the next turn
 * of a way found round walls, and a Patrol's points. Shared by the Follower,
 * Patrol and Enemy AI components.
 */
import * as THREE from 'three';
import { groupsOf } from './groups.js';
import { setYaw } from './heading.js';

export const _goal = new THREE.Vector3();

/**
 * Take a step towards `point` across the ground: with a Dynamic body by its
 * velocity (it falls, collides and climbs what physics lets it), without one
 * by moving it. Turns to face the way it goes unless told not to.
 */
export function walkTowards({ entity, object3D, props, dt }, point, speed) {
  // a car drives there: steers at it and uses its pedals (vehicle.js)
  if (entity.vehicle) { entity.vehicle.steerTowards(point, speed); return; }
  const dx = point.x - object3D.position.x;
  const dz = point.z - object3D.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-4) { halt(entity); return; }
  const ux = dx / dist;
  const uz = dz / dist;
  const body = entity.rigidBody;
  if (body?.type === 'dynamic') {
    body.velocity.x = ux * speed;
    body.velocity.z = uz * speed;
  } else {
    const s = Math.min(dist, speed * dt);
    object3D.position.x += ux * s;
    object3D.position.z += uz * s;
  }
  if (props.turnToFace !== false) setYaw(object3D, Math.atan2(ux, uz));
}

/** Stand still: a Dynamic body stops walking (and keeps falling). */
export function halt(entity) {
  if (entity.vehicle) { entity.vehicle.setInput(0, 0, false); return; } // a car rolls to a stop
  const body = entity.rigidBody;
  if (body?.type !== 'dynamic') return;
  body.velocity.x = 0;
  body.velocity.z = 0;
}

/**
 * The next point to head for on the way to `goal`, round walls: the way is
 * found again twice a second, or as soon as the goal moves a metre. Straight
 * at it when there is no way (or no navigation, in a test).
 */
export function nextStop({ entity, object3D, state, dt, engine }, goal) {
  const nav = engine.navigation;
  if (!nav) return goal;
  state.repath = (state.repath ?? 0) - dt;
  if (state.repath <= 0 || !state.goal || state.goal.distanceToSquared(goal) > 1) {
    state.repath = 0.5 + Math.random() * 0.1; // a little apart, so a crowd doesn't all think at once
    state.goal = goal.clone();
    state.route = nav.path(entity, goal);
    state.leg = 0;
  }
  const route = state.route;
  if (!route?.length) return goal;
  // at a turn: on to the next — near enough, not early (0.4 m early, a walker round a
  // doorway cut its corner, and one that passes through things went through the jamb)
  while (state.leg < route.length - 1
    && Math.hypot(route[state.leg].x - object3D.position.x, route[state.leg].z - object3D.position.z) < 0.2) state.leg++;
  return route[state.leg];
}

/** A Patrol's points: every object in its group (by name), or the objects it names. */
export function patrolPoints({ engine, props, api }, points = props.points) {
  const spec = String(points || '').trim();
  if (!spec) return [];
  const inGroup = (engine.entities || [])
    .filter((e) => groupsOf(e).some((g) => g.toLowerCase() === spec.toLowerCase()))
    .sort((a, b) => (a.object3D.name || '').localeCompare(b.object3D.name || '', undefined, { numeric: true }))
    .map((e) => e.object3D);
  if (inGroup.length) return inGroup;
  return spec.split(',').map((n) => api.findObject(n.trim())).filter(Boolean);
}

/**
 * One step of a patrol: towards the point it is on, waiting `wait` seconds at
 * each, then the next — round again, or back the way it came.
 */
export function patrolStep(ctx, points, { speed = 2, wait = 0, order = 'round', avoid = true } = {}) {
  const { object3D, state, dt, entity } = ctx;
  if (!points.length) return;
  state.at ??= 0;
  state.dir ??= 1;
  if (state.waiting > 0) {
    state.waiting -= dt;
    halt(entity);
    return;
  }
  const point = points[state.at % points.length].getWorldPosition(_goal);
  // there (a car can't turn onto a point: near enough is its own length)
  if (Math.hypot(point.x - object3D.position.x, point.z - object3D.position.z) < (entity.vehicle ? 4 : 0.4)) {
    state.waiting = Number(wait) || 0;
    state.goal = null;
    if (order === 'back and forth' && points.length > 1) {
      if (state.at + state.dir < 0 || state.at + state.dir >= points.length) state.dir = -state.dir;
      state.at += state.dir;
    } else {
      state.at = (state.at + 1) % points.length;
    }
    halt(entity);
    return;
  }
  walkTowards(ctx, avoid ? nextStop(ctx, point) : point, speed);
}
