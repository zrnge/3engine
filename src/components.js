/**
 * Components — named, typed behaviours you attach to an object from the
 * inspector instead of writing a script.
 *
 * Each definition declares its props (so the inspector can build the fields and
 * the serializer can round-trip them) plus optional lifecycle hooks:
 *
 *   start(ctx)              once when play begins
 *   update(ctx)             every frame
 *   onTrigger(ctx, other)   this object's trigger volume was entered
 *   onCollide(ctx, other)   this object bumped into something solid
 *
 * `ctx` carries { entity, object3D, props, state, dt, time, engine, vars, api }.
 * `state` is scratch space that survives between frames and is cleared on stop.
 */

import * as THREE from 'three';
import { AnimationPlayer } from './animation.js';
import { matchesWho } from './groups.js';
import { attachVehicle, enterVehicle, exitVehicle, FRONTS, ENTER_KEYS, VEHICLE_DEFAULTS } from './vehicle.js';
import { VehicleAudio } from './vehicle-audio.js';
import { SkidMarks } from './skid-marks.js';
import { Race, RACE_DEFAULTS, RESET_KEYS } from './race.js';
import { RigidBody } from './physics.js';
import { yawOf } from './heading.js';
import { AI_COMPONENTS } from './ai.js';
import { JOINT_COMPONENTS } from './joints.js';
import { walkTowards, halt, nextStop, patrolPoints, patrolStep, _goal } from './walking.js';

const DEG = Math.PI / 180;

/** A push away from `from` (what hit it): `speed` m/s along the ground, a little up — or null. */
export function pushFrom(entity, from, speed) {
  const a = entity?.object3D;
  const b = from?.object3D;
  if (!a || !b || !(speed > 0)) return null;
  const d = a.getWorldPosition(new THREE.Vector3()).sub(b.getWorldPosition(new THREE.Vector3())).setY(0);
  if (d.lengthSq() < 1e-6) return null;
  return d.normalize().multiplyScalar(speed).setY(speed * 0.4);
}

/** Play a sound by name (older scenes tagged sounds with a trigger instead). */
function playSound(engine, entity, name) {
  if (!name) return;
  if (engine.playSound) engine.playSound(entity, name);
  else engine.playEntitySounds?.(entity, { trigger: name });
}

/** Resolve a `who` prop ("any" | "player" | "group:Enemies" | an object name) against an entity. */
const matches = matchesWho;

export const COMPONENTS = {
  rotator: {
    label: 'Rotator',
    hint: 'Spins the object continuously.',
    props: {
      axis: { type: 'select', options: ['x', 'y', 'z'], default: 'y', label: 'Axis' },
      speed: { type: 'number', default: 90, min: -720, max: 720, step: 5, label: 'Deg/sec' },
    },
    update({ object3D, props, dt }) {
      object3D.rotation[props.axis] += props.speed * DEG * dt;
    },
  },

  mover: {
    label: 'Mover',
    hint: 'Slides back and forth — moving platforms, hazards.',
    props: {
      axis: { type: 'select', options: ['x', 'y', 'z'], default: 'x', label: 'Axis' },
      distance: { type: 'number', default: 3, min: 0, max: 100, step: 0.5, label: 'Distance' },
      speed: { type: 'number', default: 1, min: 0, max: 20, step: 0.1, label: 'Speed' },
    },
    start({ object3D, state }) {
      state.origin = object3D.position.clone();
    },
    update({ object3D, props, state, time }) {
      if (!state.origin) state.origin = object3D.position.clone();
      const offset = Math.sin(time * props.speed) * props.distance;
      object3D.position[props.axis] = state.origin[props.axis] + offset;
    },
  },

  follower: {
    label: 'Follower',
    hint: 'Chases another object — enemies, pets, turrets. It finds its way round walls and up ramps (it used to walk '
      + 'straight at its target, through anything). With a Dynamic body it falls and collides as it goes.',
    props: {
      target: { type: 'text', default: 'player', label: 'Target' },
      speed: { type: 'number', default: 2, min: 0, max: 30, step: 0.1, label: 'Speed' },
      stopAt: { type: 'number', default: 1, min: 0, max: 20, step: 0.1, label: 'Stop at' },
      turnToFace: { type: 'boolean', default: true, label: 'Face target' },
      avoid: { type: 'boolean', default: true, label: 'Find a way round walls' },
    },
    update(ctx) {
      const { object3D, props, api, entity } = ctx;
      const target = api.findObject(props.target);
      if (!target) return;
      const goal = target.getWorldPosition(_goal);
      if (Math.hypot(goal.x - object3D.position.x, goal.z - object3D.position.z) <= props.stopAt) {
        halt(entity);
        return;
      }
      walkTowards(ctx, props.avoid ? nextStop(ctx, goal) : goal, props.speed);
    },
  },

  patrol: {
    label: 'Patrol',
    hint: 'Walks from point to point, and round again — guards, animals, a moving hazard. The points are objects: a '
      + 'group (every object in it, in name order: "Point 1", "Point 2"…) or names split by commas. It finds its way '
      + 'round walls and waits at each point if asked. With a Dynamic body it falls and collides as it goes.',
    props: {
      points: { type: 'text', default: 'Waypoints', label: 'Points (a group, or names)' },
      speed: { type: 'number', default: 2, min: 0, max: 30, step: 0.1, label: 'Speed' },
      wait: { type: 'number', default: 0.5, min: 0, max: 60, step: 0.1, label: 'Waits at each (s)' },
      order: { type: 'select', options: ['round', 'back and forth'], default: 'round', label: 'Order' },
      turnToFace: { type: 'boolean', default: true, label: 'Face the way it goes' },
      avoid: { type: 'boolean', default: true, label: 'Find a way round walls' },
    },
    update(ctx) {
      const { props } = ctx;
      patrolStep(ctx, patrolPoints(ctx), { speed: props.speed, wait: props.wait, order: props.order, avoid: props.avoid });
    },
  },

  health: {
    label: 'Health',
    hint: 'Gives the object hit points; shots, Damagers and Damage actions take them away. When they run out it is destroyed, '
      + 'hidden (gone from sight and out of the way), or left alone — "After (s)" waits first, say for a falling-over animation. '
      + 'Its rules can do more: "I\'m hurt", "My health runs out", and the condition "My health is".',
    props: {
      max: { type: 'number', default: 3, min: 1, max: 1000, step: 1, label: 'Max' },
      atZero: {
        type: 'select', options: ['destroy', 'hide', 'respawn', 'go limp', 'nothing'], default: 'destroy', label: 'When it runs out',
        hint: 'respawn: the player back at its last checkpoint (Set checkpoint), anything else where it began — health full again. go limp: a character falls as a ragdoll (flung away from what hit it); anything else tumbles',
      },
      delay: { type: 'number', default: 0, min: 0, max: 60, step: 0.1, label: 'After (s)' },
      mirrorTo: { type: 'text', default: '', label: 'Copy to var' },
    },
    // saved before there was a choice: "Destroy at 0" on or off
    migrate(props) {
      if (props.atZero === undefined && props.destroyAtZero !== undefined) props.atZero = props.destroyAtZero ? 'destroy' : 'nothing';
      delete props.destroyAtZero;
      return props;
    },
    start({ props, state, vars }) {
      state.current = props.max;
      if (props.mirrorTo) vars.set(props.mirrorTo, state.current);
    },
    update({ props, state, vars, api, entity }) {
      if (state.current === undefined) state.current = props.max;
      if (props.mirrorTo) vars.set(props.mirrorTo, state.current);
      if (state.current <= 0 && !state.dead && props.atZero !== 'nothing') {
        state.dead = true;
        const gone = () => (props.atZero === 'hide' ? api.hide?.(entity)
          : props.atZero === 'respawn' ? api.respawn?.(entity)
            : props.atZero === 'go limp' ? api.ragdoll?.(entity, { push: pushFrom(entity, entity.lastHurtBy, 4) }) : api.destroy(entity));
        if (Number(props.delay) > 0 && api.after) api.after(props.delay, gone);
        else gone();
      }
    },
  },

  lod: {
    label: 'Level of detail',
    hint: 'Far away it is drawn with a simpler version of its shape (made automatically), and farther still not at all, '
      + 'so a big level of detailed models stays quick. Only its drawing changes: it is still hit, clicked and collided with. '
      + 'The level\'s Draw distance (Lighting panel) does the hiding for everything else.',
    props: {
      simplerFrom: { type: 'number', default: 30, min: 0, max: 5000, step: 5, label: 'Simpler from (m)', hint: '0: always full detail' },
      detail: { type: 'select', options: ['50%', '25%', '10%'], default: '25%', label: 'Far detail', hint: 'How much of its shape is kept far away' },
      hideFrom: { type: 'number', default: 0, min: 0, max: 10000, step: 10, label: 'Hide from (m)', hint: '0: never hidden' },
    },
  },

  damager: {
    label: 'Damager',
    hint: 'Hurts whatever touches it. Needs a trigger or a solid body.',
    props: {
      amount: { type: 'number', default: 1, min: 0, max: 1000, step: 1, label: 'Damage' },
      who: { type: 'who', default: 'player', label: 'Hurts' },
      cooldown: { type: 'number', default: 1, min: 0, max: 30, step: 0.1, label: 'Cooldown' },
      sound: { type: 'sound', default: '', label: 'Hit sound' },
    },
    onTrigger(ctx, other) { applyDamage(ctx, other); },
    onCollide(ctx, other) { applyDamage(ctx, other); },
  },

  collectible: {
    label: 'Collectible',
    hint: 'Picked up on touch — coins, keys, power-ups.',
    props: {
      variable: { type: 'text', default: 'score', label: 'Adds to' },
      amount: { type: 'number', default: 1, min: -1000, max: 1000, step: 1, label: 'Amount' },
      who: { type: 'who', default: 'player', label: 'Collected by' },
      destroy: { type: 'boolean', default: true, label: 'Disappear' },
      sound: { type: 'sound', default: '', label: 'Sound' },
    },
    onTrigger({ entity, props, state, vars, engine, api }, other) {
      if (state.taken) return;
      if (!matches(props.who, other, engine)) return;
      state.taken = true;
      if (props.variable) vars.change(props.variable, props.amount);
      playSound(engine, entity, props.sound); // overlapping sounds outlive the coin
      if (props.destroy) api.destroy(entity);
    },
  },

  animator: {
    label: 'Animator',
    hint: 'Animates a character as it moves. A model plays the clips you pick for standing, walking, running and being in the air (leave one empty to skip it) — blended by its speed, and played as fast as it moves so its feet don\'t slide. Its state (Set state, an Enemy AI: chasing, attacking, dead…) can play a clip of its own. Feet on the ground bends its legs to uneven ground; Looks at turns its head. A plain shape bobs as it walks, leans into its run and squashes when it lands. "Moves with: player" is for first-person arms, which move with the player rather than on their own.',
    props: {
      style: { type: 'select', options: ['auto', 'clips', 'shape'], default: 'auto', label: 'Style' },
      idle: { type: 'clip', default: '', label: 'Standing' },
      walk: { type: 'clip', default: '', label: 'Walking' },
      run: { type: 'clip', default: '', label: 'Running' },
      blendMoves: { type: 'boolean', default: true, label: 'Blend by speed', hint: 'Standing, walking and running mixed by how fast it goes, walking and running in step. Off: one clip at a time, swapped at the speeds' },
      walkSpeed: { type: 'number', default: 2, min: 0.1, max: 100, step: 0.1, label: 'Walking at (m/s)', hint: 'The speed the walking clip was made for: faster, it plays faster' },
      runSpeed: { type: 'number', default: 6, min: 0, max: 100, step: 0.5, label: 'Run from (m/s)', hint: 'Below this it walks, above it runs — blended across a short band round it; from here the running clip plays at its own pace' },
      matchSpeed: { type: 'boolean', default: true, label: 'Play as fast as it moves', hint: 'Walking and running clips sped up or slowed down to its speed: no sliding feet' },
      jump: { type: 'clip', default: '', label: 'In the air' },
      follow: { type: 'select', options: ['self', 'player'], default: 'self', label: 'Moves with' },
      // the standing clip loops in the editor too (breathing, idling) — the scene looks alive as you build it
      preview: { type: 'boolean', default: false, label: 'Also while editing' },
      blend: { type: 'number', default: 0.2, min: 0, max: 2, step: 0.05, label: 'Blend (s)' },
      bounce: { type: 'number', default: 1, min: 0, max: 3, step: 0.1, label: 'Bounce' },
      states: { type: 'stateClips', default: [], label: 'Clips for states', hint: 'What it plays in a state of its own (Set state, an Enemy AI\'s: chasing, attacking, searching, stunned, dead…): looped while in it, once then held (dead), or once then back to moving' },
      footIK: { type: 'boolean', default: false, label: 'Feet on the ground (IK)', hint: 'Its legs bend so each foot rests on the ground under it: steps, slopes, rocks. For a model with legs (hips, thighs, shins, feet)' },
      lookAt: { type: 'select', options: ['nothing', 'the player', 'the camera', 'what it sees'], default: 'nothing', label: 'Looks at', hint: 'Its head (and a little of its body) turns toward this, as far as a neck turns. What it sees: its Senses' },
      rootMotion: { type: 'boolean', default: false, label: 'Root motion', hint: 'A clip that moves the character forward (a lunge, a dodge, a dance) moves the object itself, instead of walking on the spot and snapping back' },
    },
    // saved before walking and running were separate clips
    migrate(props) {
      if (props.move !== undefined && props.walk === undefined) props.walk = props.move;
      return props;
    },
    update(ctx) { if (!ctx.entity.ragdoll) animate(ctx); }, // limp: its bones are its limbs' (ragdoll.js)
    dispose({ engine, object3D }) {
      engine.poses?.delete(object3D);
      // made again on first use; leaving it would keep a gone object animating
      const player = engine.mixers?.find((m) => m.root === object3D);
      if (player instanceof AnimationPlayer) player.dispose(engine);
    },
  },

  movement: {
    label: 'Movement feel',
    hint: 'How this character moves under its controls (they used to be fixed): how quickly it gets going and stops, '
      + 'how much it can still steer in the air, and forgiving jumps — just after running off an edge (coyote time), '
      + 'or pressed just before landing — jumps in the air (a double jump), lower jumps when the key is let go early, '
      + 'and how fast it can fall. Over rough ground: how high it steps up (a capsule body), the steepest slope it walks up, '
      + 'how hard it pushes things, whether steps and bumps '
      + 'are eased, "Tilt with the ground" for cars, boards and animals (1 = fully; people stay upright at 0), and '
      + '"Hover height" for hovercraft, drones and flyers — held that high over hills and pits. '
      + 'Needs a Dynamic body; without this component it moves as the defaults here say.',
    props: {
      accelTime: { type: 'number', default: 0.17, min: 0, max: 3, step: 0.01, label: 'Speeds up in (s)' },
      brakeTime: { type: 'number', default: 0.25, min: 0, max: 5, step: 0.01, label: 'Stops in (s)' },
      airControl: { type: 'number', default: 1, min: 0, max: 1, step: 0.05, label: 'Steering in the air' },
      coyote: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.01, label: 'Jump after leaving an edge (s)' },
      buffer: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.01, label: 'Jump pressed before landing (s)' },
      airJumps: { type: 'number', default: 0, min: 0, max: 5, step: 1, label: 'Jumps in the air' },
      shortHop: { type: 'boolean', default: true, label: 'Let go early: lower jump' },
      maxFall: { type: 'number', default: 0, min: 0, max: 300, step: 1, label: 'Fastest fall (m/s, 0 = any)' },
      stepHeight: { type: 'number', default: 0.45, min: 0, max: 2, step: 0.05, label: 'Steps up onto (m)' },
      maxSlope: { type: 'number', default: 60, min: 5, max: 85, step: 1, label: 'Steepest slope (°)', hint: 'Steeper than this it slides back down and can’t walk up' },
      pushStrength: { type: 'number', default: 1, min: 0, max: 20, step: 0.1, label: 'Push strength (×)', hint: 'The most it shoves crates and other moving things with: × its own weight (a heavy crate barely moves for a weak push). 0: it can’t push anything' },
      softSteps: { type: 'boolean', default: true, label: 'Soften steps and bumps' },
      tilt: { type: 'number', default: 0, min: 0, max: 1, step: 0.05, label: 'Tilt with the ground (0–1)' },
      hover: { type: 'number', default: 0, min: 0, max: 100, step: 0.1, label: 'Hover height (m, 0 = off)' },
    },
    start({ state }) { state.sinceGround = 0; },
    update({ entity, props, state, dt, time, engine }) {
      const body = entity.rigidBody;
      if (!body || body.type !== 'dynamic') return;
      // the ground under it: how high it steps, whether steps are eased, hovering, tilting
      body.stepHeight = Math.max(0, Number(props.stepHeight ?? 0.45) || 0);
      body.maxSlope = Number(props.maxSlope) || 60;
      body.pushStrength = Math.max(0, Number(props.pushStrength ?? 1));
      body.smoothSteps = props.softSteps !== false;
      body.hover = Math.max(0, Number(props.hover) || 0);
      tiltWithGround(engine, entity, Math.min(1, Math.max(0, Number(props.tilt) || 0)), dt, state);
      if (body.grounded) {
        state.sinceGround = 0;
        state.airJumps = Number(props.airJumps) || 0;
        state.jumping = false;
      } else {
        state.sinceGround = (state.sinceGround ?? 0) + dt;
      }
      // a jump pressed just before landing happens as it lands
      const asked = state.buffered;
      if (asked && time - asked.at > (Number(props.buffer) || 0)) state.buffered = null;
      else if (asked && body.grounded) {
        state.buffered = null;
        jumpNow(engine, entity, body, asked, state);
      }
      const cap = Number(props.maxFall) || 0;
      if (cap > 0 && body.velocity.y < -cap) body.velocity.y = -cap;
    },
  },

  vehicle: {
    label: 'Vehicle',
    hint: 'Drives like a car, kart, truck or buggy: suspension on every wheel, tyres that grip and slide. '
      + 'The controls drive it — Move forward is the throttle, back brakes then reverses, left and right steer, '
      + 'Jump is the handbrake — and a Follower or Patrol drives it round too. Its wheels are found by name '
      + '(wheel, tire, tyre, rim): they spin, steer and ride the bumps; without any it gets four at its corners. '
      + 'Make it the player and use the Follow camera — or let the player walk up and get in with its Get in key. '
      + 'Its engine and tyres make their own sound, its tyres leave skid marks, and a crash thumps, shakes the view '
      + 'and runs its "I crash" rules.',
    props: {
      front: { type: 'select', options: Object.keys(FRONTS), default: VEHICLE_DEFAULTS.front, label: 'Front of the model' },
      topSpeed: { type: 'number', default: VEHICLE_DEFAULTS.topSpeed, min: 5, max: 500, step: 5, label: 'Top speed (km/h)' },
      accelTime: { type: 'number', default: VEHICLE_DEFAULTS.accelTime, min: 0.5, max: 60, step: 0.1, label: '0–100 km/h in (s)' },
      reverseSpeed: { type: 'number', default: VEHICLE_DEFAULTS.reverseSpeed, min: 0, max: 200, step: 5, label: 'Reverse speed (km/h)' },
      brakeTime: { type: 'number', default: VEHICLE_DEFAULTS.brakeTime, min: 0.3, max: 30, step: 0.1, label: 'Stops from 100 km/h in (s)' },
      steerAngle: { type: 'number', default: VEHICLE_DEFAULTS.steerAngle, min: 5, max: 60, step: 1, label: 'Steering (°)' },
      steerAtSpeed: { type: 'number', default: VEHICLE_DEFAULTS.steerAtSpeed, min: 5, max: 100, step: 5, label: 'Steering left at top speed (%)' },
      grip: { type: 'number', default: VEHICLE_DEFAULTS.grip, min: 0.1, max: 3, step: 0.05, label: 'Grip (1 road, less ice, more slicks)' },
      driftGrip: { type: 'number', default: VEHICLE_DEFAULTS.driftGrip, min: 0, max: 1, step: 0.05, label: 'Rear grip on the handbrake' },
      drive: { type: 'select', options: ['all', 'rear', 'front'], default: VEHICLE_DEFAULTS.drive, label: 'Driven wheels (all: easiest; rear: drifts)' },
      suspension: { type: 'number', default: VEHICLE_DEFAULTS.suspension, min: 0.05, max: 2, step: 0.05, label: 'Suspension travel (m)' },
      firmness: { type: 'number', default: VEHICLE_DEFAULTS.firmness, min: 0, max: 1, step: 0.05, label: 'Suspension firmness (0–1)' },
      stability: { type: 'number', default: VEHICLE_DEFAULTS.stability, min: 0, max: 1, step: 0.05, label: 'Stays flat in corners (0–1)' },
      airLevel: { type: 'number', default: VEHICLE_DEFAULTS.airLevel, min: 0, max: 1, step: 0.05, label: 'Levels itself in the air (0–1)' },
      selfRight: { type: 'boolean', default: VEHICLE_DEFAULTS.selfRight, label: 'Back on its wheels if it lands on its side or roof' },
      enterKey: { type: 'select', options: Object.keys(ENTER_KEYS), default: VEHICLE_DEFAULTS.enterKey, label: 'Get in / out key (and pad Y)' },
      engineSound: { type: 'number', default: VEHICLE_DEFAULTS.engineSound, min: 0, max: 1, step: 0.05, label: 'Engine sound' },
      tyreSound: { type: 'number', default: VEHICLE_DEFAULTS.tyreSound, min: 0, max: 1, step: 0.05, label: 'Tyre screech' },
      skidMarks: { type: 'boolean', default: VEHICLE_DEFAULTS.skidMarks, label: 'Skid marks' },
      fovAtSpeed: { type: 'number', default: VEHICLE_DEFAULTS.fovAtSpeed, min: 0, max: 40, step: 1, label: 'Wider view at speed (°)' },
      crashShake: { type: 'number', default: VEHICLE_DEFAULTS.crashShake, min: 0, max: 2, step: 0.05, label: 'Crash shakes the view' },
      speedVariable: { type: 'text', default: VEHICLE_DEFAULTS.speedVariable, label: 'Speed into variable (km/h, for the HUD)' },
    },
    start({ engine, entity, props }) {
      const rig = attachVehicle(engine, entity, props, RigidBody);
      if (!rig) return;
      rig.audio = new VehicleAudio(engine, rig);
      rig.skids = engine.scene ? new SkidMarks(engine.scene) : null;
    },
    update({ entity, props, dt, time, engine, api }) {
      const rig = entity.vehicle;
      if (!rig) return;
      rig.configure(props); // tuned live
      rig.update(dt);       // revs, crashes; back on its wheels if stuck on its side or roof
      vehicleCrash(engine, entity, rig, time, api);
      vehicleDoor(engine, entity, rig, time);
      // its engine runs while it is driven: the player's car, or one driven in the last few seconds
      rig.engineOn = engine.playerEntity === entity || rig.idleFor < 3;
      rig.audio?.update(rig);
      vehicleSkids(rig);
      // a speedometer: the player's car writes its speed where the HUD shows it
      const name = String(props.speedVariable ?? '').trim();
      if (name && engine.playerEntity === entity) engine.variables?.set(name, Math.round(Math.abs(rig.kmh)));
      rig.pose();           // its wheels: spinning, steering, on their springs
    },
    dispose({ entity }) {
      const rig = entity.vehicle;
      rig?.audio?.dispose();
      rig?.skids?.dispose();
    },
  },

  race: {
    label: 'Race',
    hint: 'Put it on the start / finish line. The checkpoints are objects in a group (in name order round the track: '
      + '"Checkpoint 1", "Checkpoint 2"…) — gates, markers, empty objects. Every car (Vehicle) races: 3, 2, 1, GO!, '
      + 'laps through the checkpoints in order, positions, lap times; the cars the player is not driving are driven '
      + 'round by the race. The race of the player is in the variables lap, position, raceTime and bestLap (the HUD shows '
      + 'them). Finishing in the top places wins the game; the reset key puts the car back at its last checkpoint.',
    props: {
      checkpoints: { type: 'text', default: RACE_DEFAULTS.checkpoints, label: 'Checkpoints (a group, or names)' },
      laps: { type: 'number', default: RACE_DEFAULTS.laps, min: 1, max: 99, step: 1, label: 'Laps' },
      countdown: { type: 'number', default: RACE_DEFAULTS.countdown, min: 0, max: 10, step: 1, label: 'Countdown (s)' },
      racers: { type: 'text', default: RACE_DEFAULTS.racers, label: 'Racers (every car, or a group)' },
      skill: { type: 'number', default: RACE_DEFAULTS.skill, min: 10, max: 150, step: 5, label: 'Other cars: speed (% of top)' },
      catchUp: { type: 'boolean', default: RACE_DEFAULTS.catchUp, label: 'Keep it close (the others catch up / ease off)' },
      winPlaces: { type: 'number', default: RACE_DEFAULTS.winPlaces, min: 0, max: 99, step: 1, label: 'Wins if it finishes in the top (0: any)' },
      resetKey: { type: 'select', options: Object.keys(RESET_KEYS), default: RACE_DEFAULTS.resetKey, label: 'Back to the last checkpoint key' },
      showNext: { type: 'boolean', default: RACE_DEFAULTS.showNext, label: 'Arrow over the next checkpoint' },
      messages: { type: 'boolean', default: RACE_DEFAULTS.messages, label: 'Lap messages' },
    },
    start({ engine, entity, props, state }) {
      state.race = new Race(engine, entity, props);
    },
    update({ props, state, dt, time, api }) {
      if (!state.race) return;
      state.race.configure(props);
      state.race.update(dt, time, api);
    },
    dispose({ state }) {
      state.race?.dispose();
    },
  },

  levelExit: {
    label: 'Level exit',
    hint: 'Touching it goes to another level — doors, portals, finish flags. Tick Trigger on its body. "next" after the last level wins the game.',
    props: {
      level: { type: 'level', default: 'next', label: 'Go to' },
      who: { type: 'who', default: 'player', label: 'Used by' },
    },
    onTrigger({ props, state, engine, api }, other) {
      if (state.used || !matches(props.who, other, engine)) return;
      state.used = true;
      api.goToLevel?.(props.level);
    },
  },

  spawner: {
    label: 'Spawner',
    hint: 'Creates copies of a prefab on a timer.',
    props: {
      prefab: { type: 'text', default: '', label: 'Prefab' },
      interval: { type: 'number', default: 2, min: 0.1, max: 60, step: 0.1, label: 'Every (s)' },
      max: { type: 'number', default: 5, min: 1, max: 200, step: 1, label: 'Max alive' },
      radius: { type: 'number', default: 0, min: 0, max: 50, step: 0.5, label: 'Scatter' },
    },
    start({ state }) { state.elapsed = 0; state.spawned = []; },
    update({ object3D, props, state, dt, api }) {
      if (!props.prefab) return;
      state.elapsed = (state.elapsed || 0) + dt;
      state.spawned = (state.spawned || []).filter((e) => e.alive !== false);
      if (state.elapsed < props.interval || state.spawned.length >= props.max) return;
      state.elapsed = 0;
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * props.radius;
      const spawned = api.spawn(props.prefab, {
        x: object3D.position.x + Math.cos(angle) * r,
        y: object3D.position.y,
        z: object3D.position.z + Math.sin(angle) * r,
      });
      if (spawned) state.spawned.push(spawned);
    },
  },

  timer: {
    label: 'Timer',
    hint: 'Counts a variable up or down — time limits, cooldowns.',
    props: {
      variable: { type: 'text', default: 'time', label: 'Variable' },
      from: { type: 'number', default: 60, min: 0, max: 10000, step: 1, label: 'Start at' },
      direction: {
        type: 'select', options: ['down', 'up'], default: 'down', label: 'Direction',
      },
      stopAtZero: { type: 'boolean', default: true, label: 'Stop at 0' },
    },
    start({ props, state, vars }) {
      state.value = props.from;
      if (props.variable) vars.set(props.variable, Math.round(state.value));
    },
    update({ props, state, vars, dt }) {
      if (state.value === undefined) state.value = props.from;
      state.value += (props.direction === 'down' ? -dt : dt);
      if (props.stopAtZero && state.value <= 0) state.value = 0;
      if (props.variable) vars.set(props.variable, Math.round(state.value));
    },
  },

  // Senses and Enemy AI (ai.js)
  ...AI_COMPONENTS,
  // Joints (joints.js)
  ...JOINT_COMPONENTS,
};

// ---------------------------------------------------------------- walking by itself


/** A car's crash: a thump as hard as the hit, the view shaken (the player's car), its "I crash" rules. */
function vehicleCrash(engine, entity, rig, time, api) {
  const crash = rig.crash;
  if (!crash || time - (rig.lastCrash ?? -1) < 0.3) return; // one hit, not every slice of it
  rig.lastCrash = time;
  const strength = Math.min(1, (crash.speed - 3) / 12);
  rig.audio?.crash(strength);
  if (engine.playerEntity === entity && rig.crashShake > 0) {
    engine.cameraRig?.shake?.(rig.crashShake * (0.3 + 0.7 * strength), 0.25 + 0.3 * strength);
  }
  engine.gameplay?.rules?.crashed(entity, crash.with, crash.speed * 3.6, api, time);
}

/**
 * Getting in and out: the player (a person) near the car sees "E  Drive" and
 * gets in with the car's key (or a pad's Y, or a tap on the prompt); driving
 * it, the same key gets out — once it is going slower than 30 km/h.
 */
function vehicleDoor(engine, entity, rig, time) {
  if (!rig.enterCode || !engine.input) return;
  const input = engine.input;
  const pressed = input.wasPressed(rig.enterCode) || input.wasPressed('PadY');
  const controls = engine.gameplay?.controls;
  const key = Object.keys(ENTER_KEYS).find((k) => ENTER_KEYS[k] === rig.enterCode) || 'E';
  const once = () => { // one car per press: getting out beside another doesn't get straight into it
    if (engine._vehicleDoorAt === time) return false;
    engine._vehicleDoorAt = time;
    return true;
  };
  if (rig.driver) {
    if (Math.abs(rig.kmh) >= 30) return;
    const out = () => once() && exitVehicle(engine, entity);
    if (controls && !controls.prompt && Math.abs(rig.kmh) < 5) controls.prompt = { key, text: 'Get out', entity, tap: out };
    if (pressed) out();
    return;
  }
  const player = engine.playerEntity;
  if (!player || player === entity || player.vehicle || !player.object3D) return;
  if (player.object3D.position.distanceTo(entity.object3D.position) > rig.reach) return;
  const inside = () => once() && enterVehicle(engine, entity, player);
  if (controls && !controls.prompt) controls.prompt = { key, text: 'Drive', entity, tap: inside };
  if (pressed) inside();
}

/** Skid marks where its tyres slide. */
function vehicleSkids(rig) {
  const marks = rig.skids;
  if (!marks) return;
  for (const w of rig.wheels) {
    if (rig.skidMarks && w.grounded && w.slide > 3 && w.across) {
      marks.mark(w, w.point, w.normal, w.across, w.width, (w.slide - 3) / 6);
    } else {
      marks.lift(w);
    }
  }
}



// ---------------------------------------------------------------- movement feel

/** A character's Movement feel — its settings and what it remembers — or null for the defaults. */
export function movementFeel(engine, entity) {
  const c = engine?.gameplay?.components.listFor(entity).find((x) => x.type === 'movement' && !x.failed);
  return c ? { props: c.props, state: c.state } : null;
}

/**
 * Can it jump right now? 'ground' on something (or just off an edge, within
 * its coyote time), 'air' with a jump left in the air, or null.
 */
export function jumpKind(body, feel) {
  if (body.grounded) return 'ground';
  if (!feel) return null;
  const { props, state } = feel;
  if (!state.jumping && (state.sinceGround ?? Infinity) <= (Number(props.coyote) || 0)) return 'ground';
  if ((state.airJumps ?? 0) > 0) return 'air';
  return null;
}

/** Jump: `jump` is { strength, sound, ci } — the control that asked (for a lower jump when let go). */
export function jumpNow(engine, entity, body, jump, state = null, kind = 'ground') {
  body.velocity.y = Number(jump.strength) || 0;
  body.grounded = false;
  if (state) {
    state.jumping = true;
    state.cut = false;
    state.jumpControl = jump.ci;
    if (kind === 'air') state.airJumps = Math.max(0, (state.airJumps ?? 0) - 1);
  }
  if (jump.sound && engine.playSound) engine.playSound(entity, jump.sound);
  else engine.playEntitySounds?.(entity, { trigger: 'jump' }); // sounds tagged the old way
}

function applyDamage(ctx, other) {
  const { props, state, engine, api, time } = ctx;
  if (!matches(props.who, other, engine)) return;
  state.lastHit = state.lastHit ?? -Infinity;
  if (time - state.lastHit < props.cooldown) return;
  state.lastHit = time;
  api.damage(other, props.amount, ctx.entity);
  playSound(engine, ctx.entity, props.sound);
}

// ---------------------------------------------------------------- animator

const _step = new THREE.Vector3();
const _bounds = new THREE.Box3();
const MOVING = 0.4; // m/s

/** How the object is moving: from its body, or from how far it went since last frame. */
function motionOf({ engine, entity, object3D, props, state, dt }) {
  // first-person arms stay put in front of the camera: they move as the player does
  if (props.follow === 'player' && engine.playerEntity && engine.playerEntity !== entity) {
    entity = engine.playerEntity;
    object3D = entity.object3D;
  }
  const body = entity.rigidBody;
  if (body && body.type === 'dynamic') {
    return { speed: Math.hypot(body.velocity.x, body.velocity.z), vy: body.velocity.y, grounded: !!body.grounded };
  }
  const p = object3D.position;
  if (!state.last) state.last = p.clone();
  _step.subVectors(p, state.last);
  state.last.copy(p);
  const speed = dt > 0 ? Math.hypot(_step.x, _step.z) / dt : 0;
  const vy = dt > 0 ? _step.y / dt : 0;
  return { speed, vy, grounded: Math.abs(vy) < 0.5 };
}

function animate(ctx) {
  const { object3D, props } = ctx;
  const clips = object3D.userData.animations || [];
  const motion = motionOf(ctx);
  const useClips = props.style === 'clips' || (props.style === 'auto' && clips.length > 0);
  if (useClips && clips.length) animateClips(ctx, motion);
  else if (props.style !== 'clips') animateShape(ctx, motion);
}

/**
 * The clips the game maker picked, as the movement changes: in the air, running,
 * walking, standing. An empty choice falls through to the next one that fits
 * (no running clip: walking is used at any speed). Nothing is guessed by name.
 * Action clips (Play animation) play over this and hand back to it.
 */
function animateClips(ctx, m) {
  const { engine, object3D, props, dt } = ctx;
  const player = AnimationPlayer.for(engine, object3D);
  stateClip(ctx, player);
  // what the rig does after its clips: feet on the ground, a head that turns, a clip that moves it (ik.js)
  player.rig = {
    entity: ctx.entity, engine,
    footIK: !!props.footIK, rootMotion: !!props.rootMotion,
    lookAt: props.lookAt && props.lookAt !== 'nothing' ? lookTarget(ctx) : null,
  };
  if (props.blendMoves !== false) {
    player.setMoveBlend({
      idle: props.idle, walk: props.walk, run: props.run, air: props.jump,
      inAir: !m.grounded && Math.abs(m.vy) > 0.5 && !!props.jump,
      speed: m.speed, walkSpeed: props.walkSpeed, runSpeed: props.runSpeed,
      match: props.matchSpeed !== false, fade: Number(props.blend) || 0,
    }, dt);
    return;
  }
  const pick = (...names) => names.find((n) => n) ?? '';
  let want;
  if (!m.grounded && Math.abs(m.vy) > 0.5 && props.jump) want = props.jump;
  else if (m.speed > MOVING) {
    const running = props.run && m.speed >= (Number(props.runSpeed) || 0);
    want = running ? props.run : pick(props.walk, props.run, props.idle);
  } else want = pick(props.idle, props.walk);
  AnimationPlayer.for(engine, object3D).setBase(want, { fade: Number(props.blend) || 0 });
}

/**
 * Its state's own clip: when its state (Set state, an Enemy AI) changes to one
 * listed in Clips for states, that clip plays — looped while in it, once and
 * held, or once and back to moving; leaving the state lets a looped or held
 * one go.
 */
function stateClip({ entity, props, state }, player) {
  const now = String(entity.state ?? '').trim().toLowerCase();
  if (now === (state.clipState ?? '')) return;
  const was = state.stateRow;
  if (was && was.play !== 'once, then moves') player.stop(was.clip);
  state.clipState = now;
  const row = now ? (props.states || []).find((r) => String(r.state || '').trim().toLowerCase() === now && r.clip) : null;
  state.stateRow = row || null;
  if (!row) return;
  const fade = Number(props.blend) || 0.15;
  if (row.play === 'loops') player.play(row.clip, { mode: 'loop', interrupt: true, fade });
  else if (row.play === 'once, then holds') player.play(row.clip, { mode: 'hold', loop: false, interrupt: true, fade });
  else player.play(row.clip, { mode: 'once', interrupt: true, fade });
}

/** What its head turns to: the player, the camera, or what its Senses see now — as a world point, or null. */
function lookTarget({ engine, entity, props }) {
  if (props.lookAt === 'the camera') return engine.camera?.getWorldPosition(new THREE.Vector3()) ?? null;
  const who = props.lookAt === 'what it sees' ? entity.senses?.sees : engine.playerEntity;
  if (!who?.object3D || who === entity) return null;
  const box = new THREE.Box3().setFromObject(who.object3D);
  if (box.isEmpty()) return who.object3D.getWorldPosition(new THREE.Vector3());
  const p = box.getCenter(new THREE.Vector3());
  p.y = box.max.y - (box.max.y - box.min.y) * 0.1; // its eyes
  return p;
}

/** A plain shape: bob while walking, lean into the run, squash on landing, breathe when still. */
function animateShape({ engine, object3D, props, state, dt, time }, m) {
  if (!engine.poses) return;
  if (state.halfHeight === undefined) {
    _bounds.setFromObject(object3D);
    state.halfHeight = _bounds.isEmpty() ? 0.5 : (_bounds.max.y - _bounds.min.y) / 2;
    state.phase = 0;
    state.land = 1;
    state.wasGrounded = m.grounded;
    state.fall = 0;
  }
  const k = Number(props.bounce) || 0;
  const moving = m.grounded && m.speed > MOVING;
  if (moving) state.phase += dt * (7 + m.speed * 0.9);
  if (m.grounded && !state.wasGrounded && state.fall < -3) state.land = 0; // just landed hard
  state.wasGrounded = m.grounded;
  state.fall = m.vy;
  state.land = Math.min(1, state.land + dt * 5);

  const impact = (1 - state.land) ** 2;                 // 1 at touchdown, easing to 0
  const stretch = m.grounded ? 0 : Math.min(0.18, Math.abs(m.vy) / 60);
  let sy = 1 - 0.3 * impact * k + stretch * k;
  if (!moving && m.grounded) sy += Math.sin(time * 2.2) * 0.015 * k; // breathing
  sy = Math.max(0.3, sy);
  const sxz = 1 / Math.sqrt(sy); // keep the volume: squash wide, stretch thin
  engine.poses.set(object3D, {
    tilt: engine.poses.get(object3D)?.tilt, // Movement feel's lean with the ground
    y: (moving ? Math.abs(Math.sin(state.phase)) * 0.12 * k : 0) - (1 - sy) * state.halfHeight, // feet stay down
    lean: Math.min(1, m.speed / 8) * 0.16 * k,
    sx: sxz, sy, sz: sxz,
  });
}

const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _tiltTo = new THREE.Quaternion();
const _none = new THREE.Quaternion();
const _ray = new THREE.Vector3();
const _pts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _along = new THREE.Vector3();
const _across = new THREE.Vector3();
const _plane = new THREE.Vector3();

/**
 * Movement feel's "Tilt with the ground": the drawn object leans to the ground
 * under it, eased — a car rides over a bump nose-up then nose-down, a board
 * banks on a slope. Measured like wheels: the ground under its front, back
 * and sides, so it sits across a ridge the way a car does. Only the picture
 * turns (a pose); its body stays upright and never snags. 0 = off.
 */
function tiltWithGround(engine, entity, amount, dt, state) {
  const o = entity.object3D;
  const pose = engine.poses?.get(o);
  if (!(amount > 0)) {
    if (pose?.tilt) delete pose.tilt;
    state.tilt = null;
    return;
  }
  if (!engine.poses) return;
  if (!state.reach) {
    // how far its wheels are from its middle: half its length and width (unturned)
    const q = o.quaternion.clone();
    o.quaternion.identity();
    o.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
    o.quaternion.copy(q);
    o.updateMatrixWorld(true);
    state.reach = { x: Math.max(0.1, size.x * 0.4), z: Math.max(0.1, size.z * 0.4), h: Math.max(0.2, size.y) };
  }
  const { x: rx, z: rz, h } = state.reach;
  const yaw = yawOf(o);
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const base = new THREE.Box3().setFromObject(o).min.y;
  const skip = (e, b) => e === entity || b.isTrigger || b.type === 'dynamic';
  const offsets = [[fx * rz, fz * rz], [-fx * rz, -fz * rz], [fz * rx, -fx * rx], [-fz * rx, fx * rx]]; // front, back, right, left
  let hits = 0;
  offsets.forEach(([dx, dz], i) => {
    _ray.set(o.position.x + dx, base + h * 0.5, o.position.z + dz);
    const hit = engine.physics?.raycast(_ray, _down, h * 0.5 + 3, { skip });
    if (hit) { _pts[i].copy(hit.point); hits++; }
  });
  const body = entity.rigidBody;
  if (hits === 4) {
    _along.subVectors(_pts[0], _pts[1]);
    _across.subVectors(_pts[2], _pts[3]);
    _plane.crossVectors(_along, _across).normalize();
    if (_plane.y < 0) _plane.negate();
  } else if (body?.grounded) {
    _plane.copy(body.groundNormal);
  } else {
    _plane.copy(_up); // in the air: level out
  }
  if (_plane.y < 0.5) _plane.copy(_up); // no steeper than it could stand on
  _tiltTo.setFromUnitVectors(_up, _plane);
  if (amount < 1) _tiltTo.copy(_none.identity().slerp(_tiltTo, amount));
  state.tilt ??= new THREE.Quaternion();
  state.tilt.slerp(_tiltTo, 1 - Math.exp(-dt * 10));
  if (pose) pose.tilt = state.tilt;
  else engine.poses.set(o, { tilt: state.tilt });
}

/** Default prop values for a component type. */
export function defaultProps(type) {
  const def = COMPONENTS[type];
  if (!def) return {};
  const out = {};
  for (const [name, schema] of Object.entries(def.props || {})) out[name] = Array.isArray(schema.default) ? [...schema.default] : schema.default;
  return out;
}

export const STATE_CLIP_PLAYS = ['loops', 'once, then holds', 'once, then moves'];

/** Clips for states, as saved: [{ state, clip, play }] — rows with a state. */
export function normalizeStateClips(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.slice(0, 40).filter((r) => r && typeof r === 'object').map((r) => ({
    state: String(r.state ?? '').slice(0, 60),
    clip: String(r.clip ?? '').slice(0, 120),
    play: STATE_CLIP_PLAYS.includes(r.play) ? r.play : 'loops',
  }));
}

/** Coerce a value to the type its schema declares. */
export function coerceProp(schema, value) {
  if (!schema) return value;
  switch (schema.type) {
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return schema.default;
      return Math.min(schema.max ?? Infinity, Math.max(schema.min ?? -Infinity, n));
    }
    case 'boolean': return !!value;
    case 'select': return schema.options.includes(value) ? value : schema.default;
    case 'stateClips': return normalizeStateClips(value);
    default: return value == null ? schema.default : String(value);
  }
}

/**
 * ComponentRuntime — holds the component instances for a scene and drives them.
 */
export class ComponentRuntime {
  constructor(engine) {
    this.engine = engine;
    this.instances = []; // { entity, type, props, state, def }
  }

  /** Attach a component. Unknown types are rejected rather than silently ignored. */
  add(entity, type, props = {}) {
    const def = COMPONENTS[type];
    if (!def) {
      console.warn('[Tiny3] unknown component type:', type);
      return null;
    }
    const merged = { ...defaultProps(type) };
    // older saves may name a setting differently; the definition translates them
    if (def.migrate) props = def.migrate({ ...props });
    for (const [name, value] of Object.entries(props)) {
      if (name in merged) merged[name] = coerceProp(def.props[name], value);
    }
    const instance = { entity, type, props: merged, state: {}, def };
    this.instances.push(instance);
    return instance;
  }

  remove(instance) {
    const i = this.instances.indexOf(instance);
    if (i !== -1) this.instances.splice(i, 1);
    this._dispose(instance);
  }

  clearEntity(entity) {
    for (const c of this.instances) if (c.entity === entity) this._dispose(c);
    this.instances = this.instances.filter((c) => c.entity !== entity);
  }

  clear() {
    for (const c of this.instances) this._dispose(c);
    this.instances.length = 0;
  }

  /** Let a component undo what it set up (an Animator's pose and mixer). */
  _dispose(c) {
    try {
      c.def.dispose?.({ engine: this.engine, entity: c.entity, object3D: c.entity.object3D, state: c.state });
    } catch (err) {
      console.warn(`[Tiny3 component] ${c.type} cleanup failed:`, err);
    }
  }

  listFor(entity) { return this.instances.filter((c) => c.entity === entity); }

  /** Serializable form for one entity's components. */
  serializeFor(entity) {
    const list = this.listFor(entity);
    if (!list.length) return undefined;
    return list.map((c) => ({ type: c.type, props: { ...c.props } }));
  }

  /** Reset scratch state and run every start() hook. Called when play begins. */
  start(api) {
    for (const c of this.instances) {
      this._dispose(c); // anything left from a previous run
      c.state = {};
      try {
        c.def.start?.(this._ctx(c, 0, 0, api));
      } catch (err) {
        this._fail(c, err);
      }
    }
  }

  update(dt, time, api, profiler = null) {
    for (const c of this.instances) {
      if (c.failed || !c.def.update) continue;
      const t0 = profiler ? performance.now() : 0;
      try {
        c.def.update(this._ctx(c, dt, time, api));
      } catch (err) {
        this._fail(c, err);
      }
      // the Profiler: each kind's time (Enemy AI, Animator...), and the slowest objects
      if (profiler) profiler.item('components', c.def.label || c.type, performance.now() - t0, c.entity.object3D?.name);
    }
  }

  /** Dispatch a physics contact to whichever components care about it. */
  dispatchContact(event, time, api) {
    const hook = event.type.startsWith('trigger') ? 'onTrigger' : 'onCollide';
    if (!event.type.endsWith('Enter') && !event.type.endsWith('Stay')) return;
    // both sides get told, each about the other
    for (const [self, other] of [[event.a, event.b], [event.b, event.a]]) {
      for (const c of this.instances) {
        if (c.entity !== self || c.failed || !c.def[hook]) continue;
        try {
          c.def[hook](this._ctx(c, 0, time, api), other);
        } catch (err) {
          this._fail(c, err);
        }
      }
    }
  }

  _ctx(instance, dt, time, api) {
    return {
      entity: instance.entity,
      object3D: instance.entity.object3D,
      props: instance.props,
      state: instance.state,
      dt,
      time,
      engine: this.engine,
      vars: this.engine.variables,
      api,
    };
  }

  _fail(instance, err) {
    instance.failed = true;
    console.error(
      `[Tiny3 component] ${instance.type} on "${instance.entity.object3D?.name}" failed:`, err
    );
  }
}
