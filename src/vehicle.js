import * as THREE from 'three';

/**
 * Vehicles — a car, kart, truck or buggy that drives like one.
 *
 * The body is a real rigid body that turns every way (it "tumbles", see
 * physics.js), held up by a spring and damper at each wheel: a ray down from
 * the wheel's mount finds the ground, and the spring pushes the body up there.
 * The tyres push along the ground: sideways they grip (up to a limit — past it
 * the car slides: drifting), forwards they drive and brake. Nothing about the
 * way it leans in a corner, dips its nose when braking, squats and pitches over
 * a crest, lands a jump or slides out is scripted: it comes from those forces.
 *
 *   const rig = new VehicleRig(entity, settings);   // the Vehicle component makes one
 *   rig.setInput(throttle, steer, handbrake);       // -1..1, -1..1 (right +), true/false
 *   physics calls rig.slice(ctx) every fixed step; the component calls rig.pose() every frame
 *
 * Wheels are found in the model by name (wheel, tire, tyre, rim — a steering
 * wheel or spare is left alone): they spin with the speed, the front ones
 * steer, and they ride the suspension. A model without them (or a plain box)
 * gets four at its corners, not drawn.
 *
 * Units: settings in km/h, seconds, metres; inside, metres and m/s.
 */

const KMH = 1 / 3.6;
const WHEEL_NAME = /(wheel|tire|tyre|rim)/i;
const NOT_WHEEL = /(steer|spare)/i;
export const FRONTS = { '+Z (glTF)': [0, 0, 1], '-Z': [0, 0, -1], '+X': [1, 0, 0], '-X': [-1, 0, 0] };

/** The Vehicle component's settings, as it shows them. */
export const VEHICLE_DEFAULTS = {
  front: '+Z (glTF)',
  topSpeed: 120,     // km/h
  accelTime: 5,      // s from 0 to 100 km/h
  reverseSpeed: 30,  // km/h
  brakeTime: 2.5,    // s from 100 km/h to a stop
  steerAngle: 32,    // degrees, at a crawl
  steerAtSpeed: 35,  // % of it left at top speed
  grip: 1,           // 1 road tyres; less: ice, gravel; more: racing slicks
  driftGrip: 0.35,   // the rear's sideways grip while the handbrake is on
  drive: 'all',      // which wheels the engine turns: all (easiest), rear (slides its tail: drifting), front
  suspension: 0.3,   // m of travel
  firmness: 0.5,     // 0 soft and bouncy, 1 firm
  stability: 0.4,    // 0 leans most in corners, 1 stays flat
  airLevel: 0.5,     // how much it levels itself in the air (0 = free to flip)
  selfRight: true,   // set back on its wheels if it ends up on its side or roof
  enterKey: 'E',     // the player walks up and presses it to drive, and again to get out ('none': can't)
  engineSound: 0.7,  // 0 silent
  tyreSound: 0.6,    // screech when sliding
  skidMarks: true,   // marks left where the tyres slide
  fovAtSpeed: 10,    // degrees the view widens at top speed (the player's car)
  crashShake: 0.6,   // how hard the view shakes in a crash (the player's car)
  speedVariable: 'speed', // the player's car writes its speed here (km/h), for the HUD: a speedometer ('' none)
};

/** The Get in / out key, as a key code (and a gamepad's Y as well). */
export const ENTER_KEYS = { E: 'KeyE', F: 'KeyF', G: 'KeyG', Q: 'KeyQ', Enter: 'Enter', none: null };
const GEAR_TOPS = [0.28, 0.46, 0.64, 0.82, 1.02]; // each gear's top, as a share of top speed
export const IDLE_RPM = 900;
export const REDLINE_RPM = 6800;

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _box = new THREE.Box3();

/** A node's size in the root's own space (its meshes' boxes, turned and scaled there). */
function boxInRoot(node, rootInverse, out = new THREE.Box3()) {
  out.makeEmpty();
  node.traverse((n) => {
    const g = n.geometry;
    if (!g?.attributes?.position) return;
    if (!g.boundingBox) g.computeBoundingBox();
    _m.multiplyMatrices(rootInverse, n.matrixWorld);
    out.union(_box.copy(g.boundingBox).applyMatrix4(_m));
  });
  return out;
}

/**
 * The model's wheels, in its own space: [{ center, radius, parts }] — a wheel
 * can be several parts (a tyre and its rim) spinning together. [] if it has
 * fewer than three.
 */
export function findWheels(root) {
  root.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const whole = boxInRoot(root, inverse);
  const named = [];
  root.traverse((n) => {
    if (n !== root && WHEEL_NAME.test(n.name || '') && !NOT_WHEEL.test(n.name)) named.push(n);
  });
  // the topmost part of each wheel (a wheel group, not also every piece in it)
  const tops = named.filter((n) => {
    for (let p = n.parent; p && p !== root; p = p.parent) if (named.includes(p)) return false;
    return true;
  });
  const wheels = [];
  for (const node of tops) {
    const b = boxInRoot(node, inverse);
    if (b.isEmpty()) continue;
    const size = b.getSize(new THREE.Vector3());
    const center = b.getCenter(new THREE.Vector3());
    if (size.y < 1e-3 || center.y > whole.getCenter(_v).y) continue; // not down where wheels are
    const radius = size.y / 2;
    const same = wheels.find((w) => w.center.distanceTo(center) < Math.max(w.radius, radius) * 0.6);
    const width = Math.min(size.x, size.z); // its thin side: the tyre's width
    if (same) { // a rim inside its tyre: one wheel
      same.parts.push(node);
      same.radius = Math.max(same.radius, radius);
      same.width = Math.max(same.width, width);
    } else {
      wheels.push({ center, radius, width, parts: [node] });
    }
  }
  return wheels.length >= 3 ? wheels : [];
}

/** Four wheels at the corners of a model with none (not drawn): its own space. */
function cornerWheels(box, forward) {
  const size = box.getSize(new THREE.Vector3());
  const along = Math.abs(forward.x) > 0.5 ? 'x' : 'z';
  const across = along === 'x' ? 'z' : 'x';
  const length = size[along];
  const width = size[across];
  const radius = THREE.MathUtils.clamp(Math.min(size.y * 0.3, length * 0.15), 0.05, 1);
  const c = box.getCenter(new THREE.Vector3());
  const wheels = [];
  for (const f of [1, -1]) {
    for (const s of [1, -1]) {
      const center = new THREE.Vector3(c.x, box.min.y + radius, c.z);
      center[along] += f * length * 0.35;
      center[across] += s * width * 0.42;
      wheels.push({ center, radius, width: radius * 0.7, parts: [] });
    }
  }
  return wheels;
}

/**
 * Make `entity` a car with these settings: its body becomes a dynamic one that
 * turns every way, boxed from its wheels up, and driven by a VehicleRig.
 * Returns the rig (also on entity.vehicle).
 */
export function attachVehicle(engine, entity, settings = {}, RigidBody = null) {
  const rig = new VehicleRig(entity, settings);
  let body = entity.rigidBody;
  if (!body && RigidBody) {
    body = entity.rigidBody = new RigidBody({ type: 'dynamic', mass: 1200, friction: 0.5 });
    engine.physics?.register(entity);
  }
  if (!body) return null;
  body.type = 'dynamic';
  if (body.mass === 1) body.mass = 1200; // a car weighs about that: a person (70) doesn't shove it
  body.invMass = 1 / body.mass;
  body.tumbles = true;
  body.isTrigger = false;
  body.shape = 'box';
  body.box = rig.chassisBox;
  body.vehicle = rig;
  entity.vehicle = rig;
  // which way is its front, for a camera swinging behind it (cameras.js)
  entity.object3D.userData.forward = rig.forwardLocal.toArray();
  return rig;
}

/**
 * `driver` (the player — a person) gets into `car`: hidden and out of the way,
 * riding along inside, and the car becomes the player (the controls drive it,
 * the camera follows it). False if it can't.
 */
export function enterVehicle(engine, car, driver) {
  const rig = car?.vehicle;
  if (!rig || rig.driver || !driver || driver === car || driver.vehicle) return false;
  rig.driver = driver;
  rig.driverWasVisible = driver.object3D.visible;
  driver.object3D.visible = false;
  // out of the physics while inside (the stand-in player takes itself out: player.js)
  if (driver.rigidBody && driver !== engine.player) engine.physics?.unregister(driver);
  if (engine.player) engine.player.target = car;
  swapCameraTarget(engine, driver, car);
  rig.setInput(0, 0, false);
  return true;
}

/**
 * The driver gets out of `car`, beside its door (the other side if a wall is
 * there), and is the player again; the car is left with its handbrake on.
 */
export function exitVehicle(engine, car) {
  const rig = car?.vehicle;
  const driver = rig?.driver;
  if (!driver) return false;
  rig.driver = null;
  const o = car.object3D;
  o.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(o);
  const reach = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.35 + 0.8;
  const left = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), rig.forwardLocal).applyQuaternion(o.quaternion);
  left.y = 0;
  left.normalize();
  const from = box.getCenter(new THREE.Vector3());
  const blocked = (dir) => !!engine.physics?.raycast(from, dir, reach + 0.5, {
    skip: (e, b) => e === car || e === driver || b.isTrigger,
  });
  const side = blocked(left) && !blocked(left.clone().negate()) ? left.negate() : left;
  const d = driver.object3D;
  d.position.copy(from).addScaledVector(side, reach);
  d.position.y = box.min.y + 1;
  d.visible = rig.driverWasVisible !== false;
  const fwd = rig.forwardLocal.clone().applyQuaternion(o.quaternion);
  d.rotation.set(0, Math.atan2(fwd.x, fwd.z), 0);
  if (driver.rigidBody) {
    driver.rigidBody.velocity.set(0, 0, 0);
    if (driver !== engine.player) engine.physics?.register(driver);
  }
  if (engine.player) engine.player.target = driver === engine.player ? null : driver;
  swapCameraTarget(engine, car, driver);
  rig.setInput(0, 0, true); // left parked
  return true;
}

/** The camera following one object follows the other now. */
function swapCameraTarget(engine, from, to) {
  const rig = engine.cameraRig;
  if (!rig) return;
  if (rig.target === from.object3D) rig.target = to.object3D;
  if (rig.fallbackTarget === from.object3D) rig.fallbackTarget = to.object3D;
}

export class VehicleRig {
  /** `entity`: the car (its object is the model's root). `settings`: see VEHICLE_DEFAULTS. */
  constructor(entity, settings = {}) {
    this.entity = entity;
    this.o = entity.object3D;
    this.input = { throttle: 0, steer: 0, handbrake: false };
    this.steer = 0; // radians the front wheels are turned (+ right)
    this.speed = 0; // m/s along its front (- backwards)
    this.grounded = 0; // how many wheels are on the ground
    this.rpm = IDLE_RPM; // engine revs, and the gear it is in (for its sound)
    this.gear = 0;
    this.load = 0;
    this.slip = 0;       // how fast its tyres slide (m/s, the worst of them): screech, skid marks
    this.driver = null;  // who got in (see enterVehicle)
    this.idleFor = Infinity; // seconds since anyone drove it: never, yet (its engine is off)
    this.configure(settings);

    const o = this.o;
    o.updateMatrixWorld(true);
    const inverse = new THREE.Matrix4().copy(o.matrixWorld).invert();
    const whole = boxInRoot(o, inverse);
    const found = findWheels(o);
    const wheels = found.length ? found : cornerWheels(whole, this.forwardLocal);
    this.drawnWheels = found.length > 0;
    this._mountWheels(found);
    // front or back, left or right — by where each is, along its front and across it
    const mid = whole.getCenter(new THREE.Vector3());
    const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), this.forwardLocal);
    const scale = o.getWorldScale(new THREE.Vector3());
    this.scale = Math.abs(scale.y) || 1;
    this.wheels = wheels.map((w) => {
      const rel = _v.subVectors(w.center, mid);
      return {
        center: w.center.clone(),                       // in the model's own space, as modelled
        radius: w.radius * this.scale,                   // in metres
        front: rel.dot(this.forwardLocal) > 0,
        left: rel.dot(side) > 0,
        parts: w.parts.map((node) => this._part(node, w.center)),
        width: (w.width || w.radius * 0.7) * this.scale, // in metres: its skid mark
        springLen: null, grounded: false, load: 0, spin: 0, spinRate: 0,
        point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), compression: 0,
      };
    });
    // the body's box, for bumping into things: the model, from its wheels' middles up
    // (the wheels, on their springs, keep it off the ground)
    const lowest = Math.min(...this.wheels.map((w) => w.center.y));
    this.chassisBox = whole.clone();
    this.chassisBox.min.y = Math.min(whole.max.y - 0.05, Math.max(whole.min.y, lowest));
    // how near the player must be to get in: its half-length, and a couple of metres
    const size = whole.getSize(new THREE.Vector3());
    this.reach = (Math.max(size.x, size.z) * this.scale) / 2 + 2;
  }

  /** Settings may change while it drives (tuning it live in the panel). */
  configure(settings = {}) {
    const key = JSON.stringify(settings);
    if (key === this._settingsKey) return;
    this._settingsKey = key;
    const s = { ...VEHICLE_DEFAULTS, ...settings };
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    this.settings = s;
    // which way its front is: fixed once its wheels are sorted into front and back
    if (!this.forwardLocal) this.forwardLocal = new THREE.Vector3(...(FRONTS[s.front] || FRONTS['+Z (glTF)']));
    this.top = Math.max(1, num(s.topSpeed, 120)) * KMH;
    // The engine pulls hardest from a standstill, fading to nothing at top speed
    // (1 - (v/top)³) — as hard as it takes to reach 100 km/h (or 90% of top speed,
    // if that is lower) in exactly the time set.
    const x1 = Math.min(100 * KMH, 0.9 * this.top) / this.top;
    let fade = 0;
    for (let i = 0; i < 64; i++) fade += (x1 / 64) / (1 - (((i + 0.5) / 64) * x1) ** 3);
    this.accel = (this.top * fade) / Math.max(0.2, num(s.accelTime, 5));
    this.reverseTop = Math.max(0, num(s.reverseSpeed, 30)) * KMH;
    this.brake = (100 * KMH) / Math.max(0.2, num(s.brakeTime, 2.5));
    this.maxSteer = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(num(s.steerAngle, 32), 1, 70));
    this.steerAtSpeed = THREE.MathUtils.clamp(num(s.steerAtSpeed, 35), 1, 100) / 100;
    this.grip = Math.max(0.05, num(s.grip, 1));
    this.driftGrip = THREE.MathUtils.clamp(num(s.driftGrip, 0.35), 0, 1);
    this.drive = ['rear', 'front', 'all'].includes(s.drive) ? s.drive : 'rear';
    this.travel = THREE.MathUtils.clamp(num(s.suspension, 0.3), 0.02, 3);
    this.firmness = THREE.MathUtils.clamp(num(s.firmness, 0.5), 0, 1);
    this.stability = THREE.MathUtils.clamp(num(s.stability, 0.7), 0, 1);
    this.airLevel = THREE.MathUtils.clamp(num(s.airLevel, 0.5), 0, 1);
    this.selfRight = s.selfRight !== false;
    this.enterCode = s.enterKey in ENTER_KEYS ? ENTER_KEYS[s.enterKey] : 'KeyE';
    this.engineVolume = THREE.MathUtils.clamp(num(s.engineSound, 0.7), 0, 1);
    this.tyreVolume = THREE.MathUtils.clamp(num(s.tyreSound, 0.6), 0, 1);
    this.skidMarks = s.skidMarks !== false;
    this.fovAtSpeed = THREE.MathUtils.clamp(num(s.fovAtSpeed, 10), 0, 60);
    this.crashShake = THREE.MathUtils.clamp(num(s.crashShake, 0.6), 0, 2);
  }

  setInput(throttle = 0, steer = 0, handbrake = false) {
    this.input.throttle = THREE.MathUtils.clamp(Number(throttle) || 0, -1, 1);
    this.input.steer = THREE.MathUtils.clamp(Number(steer) || 0, -1, 1);
    this.input.handbrake = !!handbrake;
  }

  /** km/h, forwards (negative backwards). */
  get kmh() { return this.speed / KMH; }

  /**
   * Drive towards a point (a Follower's or Patrol's next stop), at up to `speed`
   * m/s: steer at it, ease off for sharp turns, brake when close to a stop.
   */
  steerTowards(point, speed) {
    const o = this.o;
    const fwd = _v.copy(this.forwardLocal).applyQuaternion(o.quaternion);
    const dx = point.x - o.position.x;
    const dz = point.z - o.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-3) { this.setInput(0, 0, false); return; }
    // the turn to it, + to the right (as seen from behind: right is -X when facing +Z)
    const angle = Math.atan2(fwd.x * dz - fwd.z * dx, fwd.x * dx + fwd.z * dz);
    const steer = THREE.MathUtils.clamp(angle / Math.max(0.2, this.maxSteer * 0.8), -1, 1);
    const sharp = Math.min(1, Math.abs(angle) / 1.2);
    const want = Math.min(speed, this.top) * (1 - 0.6 * sharp);
    const gap = want - this.speed;
    const throttle = Math.abs(angle) > 2.3 && dist < 8 ? -1 : THREE.MathUtils.clamp(gap / 3, -1, 1);
    this.setInput(throttle, steer, false);
  }

  /** A wheel part, remembered as modelled — and how to turn it about the wheel's middle. */
  /**
   * A wheel turned inside a stretched space is smeared as it spins: a tyre
   * parented to a box scaled 1.9 × 0.7 × 4.2 (a car built in the editor) went
   * from round to a long flat ski. So a wheel whose parent is stretched rides on
   * a mount that undoes the stretch. It's in the same place, but turned in true
   * metres. It rides with the car, and lasts as long as this run of the game.
   */
  _mountWheels(found) {
    const o = this.o;
    const s = new THREE.Vector3();
    for (const w of found) {
      for (const node of w.parts) {
        node.parent.getWorldScale(s);
        const lo = Math.min(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
        const hi = Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
        if (hi - lo <= hi * 1e-3) continue; // even: turns as it is
        if (!this._mount) {
          o.getWorldScale(s);
          this._mount = new THREE.Group();
          this._mount.name = '__wheelMount';
          this._mount.scale.set(1 / s.x, 1 / s.y, 1 / s.z);
          o.add(this._mount);
          o.updateMatrixWorld(true);
        }
        this._mount.attach(node); // the same place in the world, now in unstretched space
      }
    }
  }

  _part(node, center) {
    const o = this.o;
    const parent = node.parent;
    // from the model's own space to the part's parent's: fixed, since the model is rigid
    const toParent = new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(o.matrixWorld);
    const rot = new THREE.Quaternion();
    toParent.decompose(new THREE.Vector3(), rot, new THREE.Vector3());
    return {
      node,
      toParent,
      rot, // turns a direction in the model's space into the parent's
      position: node.position.clone(),
      quaternion: node.quaternion.clone(),
      center: center.clone().applyMatrix4(toParent), // the wheel's middle, in the parent's space
    };
  }

  // ---------------------------------------------------------------- physics

  /**
   * One fixed step, from physics.js (before contacts are solved). ctx:
   *   rec, dt, gravity, raycast(origin, dir, length) -> { point, normal, distance } | null,
   *   velocityAt(p, out), giveAt(p, dir), impulseAt(p, J)
   */
  slice(ctx) {
    const { dt, rec } = ctx;
    const o = this.o;
    const body = rec.body;
    const m = body.mass;
    const g = Math.abs(ctx.gravity) || 24;
    o.updateMatrixWorld(true);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(o.quaternion);
    const fwd = this.forwardLocal.clone().applyQuaternion(o.quaternion);
    const n = this.wheels.length;

    // springs: each carries its share of the weight with `sag` of its travel pressed in
    const sag = this.travel * (0.45 - 0.33 * this.firmness);
    const k = (m * g) / (n * sag);
    const damp = 2 * 0.55 * Math.sqrt((k * m) / n);
    const above = this.travel * 0.5;          // the mount: half its travel above the modelled wheel
    const restLen = above + sag;              // the spring's length with nothing on it
    const maxLen = this.travel;               // hanging all the way down

    this.speed = body.velocity.dot(fwd);
    const speedFrac = Math.min(1, Math.abs(this.speed) / this.top);

    // steering: slower to turn the faster it goes; eases to where it is asked
    const want = this.input.steer * this.maxSteer * (1 - (1 - this.steerAtSpeed) * speedFrac);
    const rate = (this.input.steer === 0 ? 5 : 3) * dt;
    this.steer += THREE.MathUtils.clamp(want - this.steer, -rate, rate);

    // 1. suspension
    let grounded = 0;
    const normal = new THREE.Vector3();
    for (const w of this.wheels) {
      const mount = _p.copy(w.center).applyMatrix4(o.matrixWorld).addScaledVector(up, above);
      const hit = ctx.raycast(mount, _v.copy(up).negate(), maxLen + w.radius);
      const len = hit && hit.normal.dot(up) > 0.3 ? THREE.MathUtils.clamp(hit.distance - w.radius, 0, maxLen) : maxLen;
      const vel = w.springLen === null ? 0 : (len - w.springLen) / dt;
      w.springLen = len;
      w.grounded = !!hit && hit.normal.dot(up) > 0.3;
      w.compression = restLen - len;
      w.load = 0;
      if (!w.grounded) continue;
      grounded++;
      w.point.copy(hit.point);
      w.normal.copy(hit.normal);
      normal.add(hit.normal);
      w.load = Math.max(0, k * w.compression - damp * vel);
    }
    // anti-roll: a wheel pressed in more than the one across from it lifts the other side less
    const roll = k * 1.5 * this.stability;
    for (const w of this.wheels) {
      const other = this.wheels.find((x) => x !== w && x.front === w.front && x.left !== w.left);
      if (!other || !w.grounded) continue;
      w.load = Math.max(0, w.load + roll * (w.compression - other.compression) * 0.5);
    }
    for (const w of this.wheels) {
      if (w.load > 0) ctx.impulseAt(w.point, _v.copy(up).multiplyScalar(w.load * dt));
    }
    this.grounded = grounded;
    body.grounded = grounded > 0;
    if (grounded) body.groundNormal.copy(normal.normalize());

    // 2. tyres
    const drivenFront = this.drive !== 'rear';
    const drivenRear = this.drive !== 'front';
    const driven = this.wheels.filter((w) => w.grounded && (w.front ? drivenFront : drivenRear)).length;
    const onGround = this.wheels.filter((w) => w.grounded).length;
    const t = this.input.throttle;
    const forward = this.speed > 0.5 ? 1 : this.speed < -0.5 ? -1 : 0;
    // what the driver asks of the wheels: engine forwards or backwards, or brakes
    const braking = (t > 0 && forward < 0) || (t < 0 && forward > 0);
    let engine = 0;
    if (!braking && t > 0) engine = this.accel * t * Math.max(0, 1 - (Math.max(0, this.speed) / this.top) ** 3);
    if (!braking && t < 0) engine = this.accel * 0.6 * t * Math.max(0, 1 - (Math.max(0, -this.speed) / Math.max(0.1, this.reverseTop)) ** 3);
    // coasting slows it gently; at a walking pace with no throttle it brakes and holds
    // (like an automatic), so it stops — and stays stopped on a slope
    const coast = Math.abs(this.speed) < 3 ? this.brake : 2.5 + 0.03 * Math.abs(this.speed); // engine braking, air
    // faster than it can drive that way (spun round, or down a hill): it slows, as if coasting
    const over = (t > 0 && this.speed > this.top) || (t < 0 && -this.speed > this.reverseTop);
    const decel = braking ? this.brake * Math.abs(t) : (t === 0 || over ? coast : 0);
    const parked = t === 0 && Math.abs(this.speed) < 0.6;

    const tyres = [];
    for (const w of this.wheels) {
      if (!w.grounded) continue;
      // which way this tyre rolls: the car's front, turned for the front wheels, along the ground
      const dir = fwd.clone();
      if (w.front) dir.applyAxisAngle(up, -this.steer);
      dir.addScaledVector(w.normal, -dir.dot(w.normal)).normalize();
      const across = new THREE.Vector3().crossVectors(w.normal, dir).normalize();
      // the push acts part way up towards the body's middle: less lean in corners
      const at = w.point.clone().addScaledVector(up, (this.stability * 0.9) * (rec.col.center.clone().sub(w.point).dot(up)));
      // How hard it can push before it slides: its share of the weight, as on Earth —
      // the engine's snappy gravity (2.4× Earth's) made every car corner at 3 G and heel
      // over; grip 1 is a sporty road car, about 1.2 G.
      const limit = this.grip * 1.2 * w.load * (9.81 / g) * dt;
      const handbrake = this.input.handbrake && !w.front;

      // along: engine, brakes, coasting, holding still
      const vAlong = ctx.velocityAt(at, _v).dot(dir);
      let along = 0;
      if (engine && (w.front ? drivenFront : drivenRear) && !handbrake) along += (m * engine * dt) / Math.max(1, driven);
      const stopping = handbrake ? this.brake * 1.5 : parked ? Infinity : decel;
      if (stopping > 0) {
        const kAlong = ctx.giveAt(at, dir);
        const toStop = kAlong > 0 ? -vAlong / kAlong : 0;
        const most = Number.isFinite(stopping) ? (m * stopping * dt) / Math.max(1, onGround) : Math.abs(toStop);
        along += THREE.MathUtils.clamp(toStop, -most, most);
      }
      // Traction control (and ABS): drive and brakes use at most 80% of the grip, so some
      // is always left for going round — flat out, a rear-driven car's back tyres spent it
      // all pushing and the tail swung out at the least wobble. The handbrake is not held back.
      const most = handbrake ? limit : limit * 0.8;
      along = THREE.MathUtils.clamp(along, -most, most);
      if (along) ctx.impulseAt(at, _p.copy(dir).multiplyScalar(along));
      // what is left of the limit for gripping sideways (little, on the handbrake)
      const room = Math.sqrt(Math.max(0, limit * limit - along * along)) * (handbrake ? this.driftGrip : 1);
      tyres.push({ w, at, across, room, total: 0, locked: handbrake ? Math.abs(vAlong) : 0 });
      // the wheel turns with the ground under it (locked by the handbrake)
      w.spinRate = handbrake ? 0 : vAlong / w.radius;
    }
    // across: every tyre grips together — a few passes, each tyre's running total kept
    // within what it can take (past it, it slides). Each pushing on its own made the
    // pushes add up to too much: the car wagged, then spun out driving straight.
    for (let pass = 0; pass < 4; pass++) {
      for (const tyre of tyres) {
        const kAcross = ctx.giveAt(tyre.at, tyre.across);
        if (!(kAcross > 0)) continue;
        const vAcross = ctx.velocityAt(tyre.at, _v).dot(tyre.across);
        const total = THREE.MathUtils.clamp(tyre.total - vAcross / kAcross, -tyre.room, tyre.room);
        const push = total - tyre.total;
        tyre.total = total;
        if (push) ctx.impulseAt(tyre.at, _p.copy(tyre.across).multiplyScalar(push));
      }
    }
    // how fast each tyre slides — sideways past its grip, or dragged along locked
    let slip = 0;
    for (const w of this.wheels) w.slide = 0;
    for (const tyre of tyres) {
      const sideways = Math.abs(ctx.velocityAt(tyre.at, _v).dot(tyre.across));
      tyre.w.slide = Math.max(sideways, tyre.locked);
      tyre.w.across = tyre.across;
      slip = Math.max(slip, tyre.w.slide);
    }
    this.slip = slip;
    for (const w of this.wheels) {
      if (!w.grounded) w.spinRate *= 1 - Math.min(1, dt * 0.5);
      w.spin = (w.spin + w.spinRate * dt) % (Math.PI * 2);
    }

    // pressed down harder the faster it goes (grip at speed)
    if (grounded) {
      const down = 0.5 * m * g * speedFrac * speedFrac * dt;
      ctx.impulseAt(rec.col.center, _v.copy(up).multiplyScalar(-down));
    }
    // Levelled: in the air (Levels itself in the air), and — tipped far over with its
    // wheels still down, say one side up a kerb — on the ground (Stays flat). Its
    // tumbling slows and it turns back towards upright, the harder the further over:
    // a car kicked sideways off a ramp comes down on its wheels, not its roof.
    const tilt = Math.acos(THREE.MathUtils.clamp(up.y, -1, 1));
    const strength = grounded === 0 ? this.airLevel : (tilt > 0.35 ? this.stability : 0);
    if (strength > 0) {
      const spin = body.angularVelocity;
      const yaw = _v.copy(up).multiplyScalar(spin.dot(up)); // its turning is its own
      spin.sub(yaw).multiplyScalar(1 - Math.min(1, strength * 3 * dt)).add(yaw);
      const level = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0));
      if (level.lengthSq() > 1e-8) spin.addScaledVector(level.normalize(), strength * 14 * tilt * dt);
    }
  }

  /**
   * Every frame (the Vehicle component): a car lying on its side or roof, all
   * but still, for a moment and a half is set back on its wheels, facing the
   * way it was — as racing games do. `selfRight` off: it stays there.
   */
  update(dt) {
    const o = this.o;
    const body = this.entity.rigidBody;
    this._revs(dt);
    // how long since anyone drove it (the player, or a Follower / Patrol): its engine stops
    const used = this.input.throttle !== 0 || this.input.steer !== 0 || this.driver;
    this.idleFor = used ? 0 : (this.idleFor ?? 0) + dt;
    // how hard it was hit since last frame (physics.js keeps the hardest): a crash
    this.crash = null;
    if (body?.impact > 3) {
      this.crash = { speed: body.impact, with: body.impactWith ?? null }; // m/s its speed changed by
    }
    if (body) body.impact = 0;
    // whoever is inside rides along (they are hidden; they get out here)
    if (this.driver) this.driver.object3D.position.copy(o.position);
    if (!this.selfRight || !body) return;
    const up = _v.set(0, 1, 0).applyQuaternion(o.quaternion);
    this.stuck = up.y < 0.4 && body.velocity.length() < 2 ? (this.stuck || 0) + dt : 0;
    if (this.stuck < 1.5) return;
    this.stuck = 0;
    const fwd = this.forwardLocal.clone().applyQuaternion(o.quaternion);
    const heading = Math.atan2(fwd.x, fwd.z) - Math.atan2(this.forwardLocal.x, this.forwardLocal.z);
    o.quaternion.setFromAxisAngle(_p.set(0, 1, 0), heading);
    o.position.y += 1.2;
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    for (const w of this.wheels) w.springLen = null;
  }

  /**
   * Engine revs for its sound: through five gears as it gathers speed (up at
   * 6200 rpm, down under 2800), revving free in the air, pulling away from a stop.
   */
  _revs(dt) {
    const v = Math.abs(this.speed);
    const t = Math.abs(this.input.throttle);
    const rpmIn = (g) => IDLE_RPM * 0.8 + (REDLINE_RPM - IDLE_RPM * 0.8) * (v / (this.top * GEAR_TOPS[g]));
    let target;
    if (this.grounded === 0) {
      target = IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * 0.85 * t; // wheels off the ground: revving free
    } else {
      let g = this.speed < -0.5 ? 0 : this.gear; // reverse: first gear's revs
      while (g < GEAR_TOPS.length - 1 && rpmIn(g) > 6200) g++;
      while (g > 0 && rpmIn(g) < 2800) g--;
      this.gear = g;
      target = Math.max(IDLE_RPM, rpmIn(g));
      if (v < 3 && t > 0) target = Math.max(target, IDLE_RPM + 2600 * t); // pulling away
    }
    target = Math.min(REDLINE_RPM, target);
    const quick = target < this.rpm - 800 ? 12 : 6; // a gear change drops the revs fast
    this.rpm += (target - this.rpm) * Math.min(1, dt * quick);
    this.load += (t - this.load) * Math.min(1, dt * 8);
  }

  /** How many degrees wider the player's view should be at this speed. */
  get fovBoost() { return this.fovAtSpeed * Math.min(1, Math.abs(this.speed) / this.top) ** 1.5; }

  // ---------------------------------------------------------------- drawing

  /** Put the wheels where they are: down on their springs, spinning, the front ones turned. */
  pose() {
    if (!this.drawnWheels) return;
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(up, this.forwardLocal);
    const above = this.travel * 0.5;
    const turn = new THREE.Quaternion();
    const spin = new THREE.Quaternion();
    for (const w of this.wheels) {
      // how far below the modelled place its spring holds it, in the model's own units
      const drop = w.springLen === null ? 0 : (w.springLen - above) / this.scale;
      turn.setFromAxisAngle(up, w.front ? -this.steer : 0);
      spin.setFromAxisAngle(side, w.spin);
      const r = turn.multiply(spin); // in the model's space
      for (const part of w.parts) {
        // the same turn in the part's parent's space: rot · r · rot⁻¹
        _q.copy(part.rot).multiply(r).multiply(part.rot.clone().invert());
        part.node.quaternion.copy(_q).multiply(part.quaternion);
        const moved = _p.copy(w.center).addScaledVector(up, -drop).applyMatrix4(part.toParent);
        part.node.position.copy(part.position).sub(part.center).applyQuaternion(_q).add(moved);
      }
    }
  }
}
