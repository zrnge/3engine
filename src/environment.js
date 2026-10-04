import * as THREE from 'three';
import { DOF_FOCUS } from './effects.js';

/**
 * Environment — natural lighting from one description of the sky.
 *
 * A sun (or, at night, a moon) with soft shadows; a procedural sky dome;
 * fill light and reflections baked from that same sky; filmic tone mapping;
 * and atmospheric fog. All of it is driven by a handful of settings, so one
 * "time of day" value moves the sun and recolours the light, sky and fog
 * together.
 *
 * The side of an object facing away from the sun is lit by the sky instead of
 * going black, which is the single biggest difference between "a light" and
 * "daylight". Lights the user adds are extras on top of this.
 *
 * Nothing here is an entity: it never appears in the hierarchy, and it is
 * saved as scene settings rather than as objects.
 */

export const ENV_DEFAULTS = Object.freeze({
  enabled: true,
  preset: 'day',
  time: 11,        // hours, 0–24 — sets how high the sun is
  azimuth: 135,    // degrees — the compass direction the sun shines from
  clouds: 0,       // 0 clear … 1 overcast
  exposure: 1,     // camera exposure after tone mapping
  shadows: true,   // whether the sun casts shadows
  softness: 0.35,  // 0 crisp … 1 very soft shadow edges
  fog: 0,          // how far you can see, in world units; 0 = no fog
  studio: false,   // neutral grey backdrop, fixed light — for showing models
  // sharper shadows: a bigger shadow picture, and it covering only so far round the
  // view (0: automatic — the whole of a small level, round the view in a big one: AUTO_SHADOW_FROM)
  shadowQuality: 'medium',
  shadowRange: 0,
  // what's brighter than the threshold glows (effects.js)
  bloom: false,
  bloomStrength: 0.6,
  bloomThreshold: 0.85,
  bloomRadius: 0.4,
  // more of the picture's effects (effects.js): ambient occlusion, depth of field, a colour grade
  ao: false,
  aoStrength: 0.8,
  aoRadius: 0.6,
  dof: false,
  dofFocus: 'the player',
  dofDistance: 8,
  dofBlur: 0.4,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  vignette: 0,
  grain: 0,
  // how many lamps (point and spot lights) cast shadows at once: the nearest (light-shadows.js)
  lampShadows: 4,
  // speed: copies drawn together; nothing drawn farther than this (0: no limit) — see instancing.js, lod.js
  instancing: true,
  drawDistance: 0,
});

/** Shadow pictures: how many pixels across. */
export const SHADOW_SIZES = Object.freeze({ low: 1024, medium: 2048, high: 4096 });
/**
 * Shadow range 0 means "automatic": a level up to this far across (m, from its
 * middle) has one shadow map over all of it; a bigger one — a terrain, a town —
 * gets sharp shadows round the player (or the editor's view) instead, this far
 * each way for each quality. Over a whole big level each shadow texel was a
 * quarter of a metre or more, and a low sun smeared it into long bands.
 */
export const AUTO_SHADOW_FROM = 70;
export const AUTO_SHADOW_RANGE = Object.freeze({ low: 35, medium: 50, high: 70 });

/** Settings that are how the picture is made, not how the sky looks: no preset changes them, nor they a preset. */
const RENDER_KEYS = ['shadowQuality', 'shadowRange', 'bloom', 'bloomStrength', 'bloomThreshold', 'bloomRadius', 'instancing', 'drawDistance',
  'ao', 'aoStrength', 'aoRadius', 'dof', 'dofFocus', 'dofDistance', 'dofBlur', 'contrast', 'saturation', 'warmth', 'vignette', 'grain', 'lampShadows'];

export const ENV_PRESETS = Object.freeze({
  day: { time: 11, azimuth: 135, clouds: 0, exposure: 1, softness: 0.35, fog: 0, studio: false },
  golden: { time: 17.6, azimuth: 250, clouds: 0.1, exposure: 1.1, softness: 0.45, fog: 220, studio: false },
  overcast: { time: 12, azimuth: 135, clouds: 0.9, exposure: 1.15, softness: 1, fog: 160, studio: false },
  night: { time: 0.5, azimuth: 135, clouds: 0.1, exposure: 1.5, softness: 0.6, fog: 120, studio: false },
  studio: { time: 12, azimuth: 150, clouds: 0, exposure: 1, softness: 0.5, fog: 0, studio: true },
});

export const PRESET_LABELS = Object.freeze({
  day: 'Day', golden: 'Golden hour', overcast: 'Overcast', night: 'Night', studio: 'Studio',
});

// Colours of the sky and the light at a given sun elevation (degrees).
// `lux` is the sun's intensity, `fill` scales the light the sky itself gives.
const KEYS = [
  // night: dark and blue, but still readable — a game has to be playable in it
  { e: -20, sky: '#070b1a', horizon: '#141c35', ground: '#06070b', light: '#9db2ff', lux: 0.6, fill: 1.1 },
  { e: -5, sky: '#0f1836', horizon: '#2a3456', ground: '#0a0b10', light: '#9db2ff', lux: 0.55, fill: 1.0 },
  { e: 0, sky: '#1f3d6e', horizon: '#ff8c5a', ground: '#2a211c', light: '#ff7a3a', lux: 0.9, fill: 0.7 },
  { e: 8, sky: '#34619f', horizon: '#f6b88a', ground: '#433428', light: '#ffae6a', lux: 2.2, fill: 0.85 },
  { e: 25, sky: '#3b74c3', horizon: '#c7d9ec', ground: '#54473a', light: '#ffe6c8', lux: 3.0, fill: 1.0 },
  { e: 70, sky: '#2f6ecd', horizon: '#b8d2ee', ground: '#5a4c3e', light: '#fff7ea', lux: 3.3, fill: 1.0 },
].map((k) => ({
  ...k,
  sky: new THREE.Color(k.sky),
  horizon: new THREE.Color(k.horizon),
  ground: new THREE.Color(k.ground),
  light: new THREE.Color(k.light),
}));

const STUDIO = {
  sky: new THREE.Color('#3a3f48'),
  horizon: new THREE.Color('#262a31'),
  ground: new THREE.Color('#15171b'),
  light: new THREE.Color('#ffffff'),
  lux: 2.6,
  fill: 0.9,
};

/** 06:00 sunrise, 12:00 highest (70°), 18:00 sunset, below the horizon at night. */
export function sunElevation(time) {
  return Math.sin(((time - 6) / 12) * Math.PI) * 70;
}

const luminance = (c) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;

function copyKey(k) {
  return {
    sky: k.sky.clone(), horizon: k.horizon.clone(), ground: k.ground.clone(),
    light: k.light.clone(), lux: k.lux, fill: k.fill,
  };
}

function keyAt(elevation) {
  if (elevation <= KEYS[0].e) return copyKey(KEYS[0]);
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i];
    const b = KEYS[i + 1];
    if (elevation > b.e) continue;
    const t = (elevation - a.e) / (b.e - a.e);
    return {
      sky: new THREE.Color().lerpColors(a.sky, b.sky, t),
      horizon: new THREE.Color().lerpColors(a.horizon, b.horizon, t),
      ground: new THREE.Color().lerpColors(a.ground, b.ground, t),
      light: new THREE.Color().lerpColors(a.light, b.light, t),
      lux: a.lux + (b.lux - a.lux) * t,
      fill: a.fill + (b.fill - a.fill) * t,
    };
  }
  return copyKey(KEYS[KEYS.length - 1]);
}

/** Fill in defaults and clamp every field into range. */
export function normalizeSettings(data = {}) {
  const d = { ...ENV_DEFAULTS, ...(data || {}) };
  const num = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  return {
    enabled: d.enabled !== false,
    preset: typeof d.preset === 'string' ? d.preset : 'custom',
    time: num(d.time, 0, 24, ENV_DEFAULTS.time),
    azimuth: ((num(d.azimuth, -1e6, 1e6, ENV_DEFAULTS.azimuth) % 360) + 360) % 360,
    clouds: num(d.clouds, 0, 1, 0),
    exposure: num(d.exposure, 0.1, 4, 1),
    shadows: d.shadows !== false,
    softness: num(d.softness, 0, 1, ENV_DEFAULTS.softness),
    fog: num(d.fog, 0, 5000, 0),
    studio: !!d.studio,
    shadowQuality: SHADOW_SIZES[d.shadowQuality] ? d.shadowQuality : 'medium',
    shadowRange: num(d.shadowRange, 0, 1000, 0),
    bloom: !!d.bloom,
    bloomStrength: num(d.bloomStrength, 0, 3, ENV_DEFAULTS.bloomStrength),
    bloomThreshold: num(d.bloomThreshold, 0, 1, ENV_DEFAULTS.bloomThreshold),
    bloomRadius: num(d.bloomRadius, 0, 1, ENV_DEFAULTS.bloomRadius),
    ao: !!d.ao,
    aoStrength: num(d.aoStrength, 0, 1, ENV_DEFAULTS.aoStrength),
    aoRadius: num(d.aoRadius, 0.05, 5, ENV_DEFAULTS.aoRadius),
    dof: !!d.dof,
    dofFocus: DOF_FOCUS.includes(d.dofFocus) ? d.dofFocus : 'the player',
    dofDistance: num(d.dofDistance, 0.3, 500, ENV_DEFAULTS.dofDistance),
    dofBlur: num(d.dofBlur, 0, 1, ENV_DEFAULTS.dofBlur),
    contrast: num(d.contrast, -1, 1, 0),
    saturation: num(d.saturation, -1, 1, 0),
    warmth: num(d.warmth, -1, 1, 0),
    vignette: num(d.vignette, 0, 1, 0),
    grain: num(d.grain, 0, 1, 0),
    lampShadows: Math.round(num(d.lampShadows, 0, 8, ENV_DEFAULTS.lampShadows)),
    instancing: d.instancing !== false,
    drawDistance: num(d.drawDistance, 0, 10000, 0),
  };
}

/**
 * Where to centre a shadow area of `radius` round `focus`, seen along the
 * light `dir`: moved only in whole shadow pixels across it. Otherwise every
 * step the player takes redraws each shadow edge a fraction of a pixel over,
 * and they shimmer.
 */
export function snapShadowCenter(focus, dir, radius, mapSize, out = new THREE.Vector3()) {
  const d = _snapD.copy(dir).normalize();
  const right = _snapR.set(0, 1, 0).cross(d);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  right.normalize();
  const up = _snapU.crossVectors(d, right).normalize();
  const texel = (2 * radius) / mapSize;
  const snap = (v) => Math.round(v / texel) * texel;
  const a = focus.dot(right);
  const b = focus.dot(up);
  const c = focus.dot(d);
  return out.copy(right).multiplyScalar(snap(a)).addScaledVector(up, snap(b)).addScaledVector(d, c);
}
const _snapD = new THREE.Vector3();
const _focusV = new THREE.Vector3();
const _centerV = new THREE.Vector3();
const _snapR = new THREE.Vector3();
const _snapU = new THREE.Vector3();

/**
 * What the sky and light look like for a set of settings. Pure, so it can be
 * tested without a renderer.
 */
export function describeSky(settings) {
  const s = normalizeSettings(settings);
  const studio = s.studio;
  const elevation = studio ? 50 : sunElevation(s.time);
  const key = studio ? copyKey(STUDIO) : keyAt(elevation);
  const clouds = studio ? 0 : s.clouds;

  // Below the horizon the moon takes over, from the other side of the sky.
  // A setting sun never lights from under the ground: it is held just above.
  const isMoon = !studio && elevation < -4;
  const lightElevation = isMoon ? 40 : studio ? 50 : Math.max(elevation, 3);
  const lightAzimuth = isMoon ? s.azimuth + 180 : s.azimuth;
  const el = THREE.MathUtils.degToRad(lightElevation);
  const az = THREE.MathUtils.degToRad(lightAzimuth);
  const direction = new THREE.Vector3(
    Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)
  );

  // Clouds grey the sky, dim and whiten the sun, soften its shadows, and make
  // the sky itself a bigger share of the light — which is what overcast is.
  const h = luminance(key.horizon);
  return {
    elevation,
    isMoon,
    direction,
    lightColor: key.light.clone().lerp(new THREE.Color(1, 1, 1), clouds * 0.5),
    intensity: key.lux * (1 - 0.85 * clouds),
    sky: key.sky.clone().lerp(new THREE.Color(h * 0.8, h * 0.8, h * 0.85), clouds * 0.85),
    horizon: key.horizon.clone().lerp(new THREE.Color(h, h, h * 1.02), clouds * 0.8),
    ground: key.ground.clone(),
    fill: key.fill * (1 + 0.5 * clouds),
    softness: Math.min(1, s.softness + clouds * (1 - s.softness) * 0.85),
    sunDisc: !studio && !isMoon && elevation > -2 ? 1 - clouds : 0,
  };
}

function makeSkyMaterial() {
  return new THREE.ShaderMaterial({
    name: 'Tiny3Sky',
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color() },
      horizonColor: { value: new THREE.Color() },
      groundColor: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color() },
      sunDisc: { value: 1 },
      brightness: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // always on the far plane: never clipped, never in front
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 groundColor;
      uniform vec3 sunDir;
      uniform vec3 sunColor;
      uniform float sunDisc;
      uniform float brightness;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        // blend across the horizon instead of switching, which drew a hard line
        vec3 above = mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), 0.55));
        vec3 below = mix(horizonColor, groundColor, smoothstep(0.0, 0.35, -h));
        vec3 col = mix(below, above, smoothstep(-0.03, 0.03, h));
        float s = max(dot(d, normalize(sunDir)), 0.0);
        col += sunColor * sunDisc * (pow(s, 900.0) * 18.0 + pow(s, 12.0) * 0.35);
        gl_FragColor = vec4(col * brightness, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

const _box = new THREE.Box3();
const _part = new THREE.Box3();
const _sphere = new THREE.Sphere();

export class Environment {
  /** @param engine anything with `scene`, `camera`, `entities`, and optionally `renderer` */
  constructor(engine) {
    this.engine = engine;
    this.settings = normalizeSettings();
    this.look = null;
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.fitRadius = 0;

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.name = '__sun';
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    engine.scene.add(this.sun, this.sun.target);

    // the visible sky: a dome that travels with the camera
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), makeSkyMaterial());
    this.sky.name = '__sky';
    this.sky.scale.setScalar(400);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    engine.scene.add(this.sky);

    // the same sky without the sun disc, which PMREM turns into the fill
    // light and reflections every standard material picks up
    this._envScene = new THREE.Scene();
    this._envSky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), makeSkyMaterial());
    this._envScene.add(this._envSky);
    this._pmrem = null;
    this._envTarget = null;
    this._envDirty = true;
    this._fitClock = 0;

    this.apply();
  }

  get enabled() { return this.settings.enabled; }

  /** Change some settings. Touching anything but the preset marks it "custom". */
  set(partial = {}) {
    const changesLook = Object.keys(partial).some((k) => k !== 'preset' && k !== 'enabled' && !RENDER_KEYS.includes(k));
    const next = { ...this.settings, ...partial };
    if (changesLook && partial.preset === undefined) next.preset = 'custom';
    this.settings = normalizeSettings(next);
    this.apply();
    // a probe sees the sky through its windows: captured again once the sky stops changing
    if (changesLook || 'enabled' in partial || 'preset' in partial) this.engine.probes?.invalidate({ soon: true });
  }

  /** 'day' | 'golden' | 'overcast' | 'night' | 'studio', or 'off' for none. */
  applyPreset(name) {
    if (name === 'off') {
      this.set({ enabled: false, preset: 'off' });
      return;
    }
    const preset = ENV_PRESETS[name];
    if (!preset) return;
    this.set({ ...preset, enabled: true, preset: name });
  }

  toJSON() { return { ...this.settings }; }

  /** Replace every setting; missing ones fall back to the defaults (daylight). */
  load(data) {
    this.settings = normalizeSettings(data);
    this.apply();
    this.engine.probes?.invalidate();
  }

  /** Push the current settings into the lights, sky, fog and renderer. */
  apply() {
    const s = this.settings;
    const { scene, renderer } = this.engine;
    const look = describeSky(s);
    const on = s.enabled;
    this.look = look;

    this.sun.visible = on; // an invisible light contributes nothing
    this.sky.visible = on;
    this.sun.color.copy(look.lightColor);
    this.sun.intensity = look.intensity;
    this.sun.castShadow = on && s.shadows;
    // PCF shadows honour radius; this is the "softness" of the shadow edge
    this.sun.shadow.radius = 1 + look.softness * 7;
    const size = SHADOW_SIZES[s.shadowQuality] ?? 2048;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose(); // made again at the new size
      this.sun.shadow.map = null;
    }
    this.engine.effects?.apply(s);
    this.sunDirection.copy(look.direction);

    for (const [material, forEnvironment] of [[this.sky.material, false], [this._envSky.material, true]]) {
      const u = material.uniforms;
      u.topColor.value.copy(look.sky);
      u.horizonColor.value.copy(look.horizon);
      u.groundColor.value.copy(look.ground);
      u.sunDir.value.copy(look.direction);
      u.sunColor.value.copy(look.lightColor);
      u.sunDisc.value = forEnvironment ? 0 : look.sunDisc;
      u.brightness.value = forEnvironment ? look.fill : 1;
    }

    if (on && s.fog > 0) {
      if (!(scene.fog instanceof THREE.Fog)) scene.fog = new THREE.Fog(0xffffff, 1, 100);
      scene.fog.color.copy(look.horizon); // fade into the sky, not into grey
      scene.fog.near = s.fog * 0.1;
      scene.fog.far = s.fog;
    } else {
      scene.fog = null;
    }

    if (renderer) {
      renderer.toneMapping = on ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
      renderer.toneMappingExposure = on ? s.exposure : 1;
    }

    if (on) this._envDirty = true;
    else scene.environment = null;
    this.refit();
  }

  /** Once per frame, before rendering. */
  update(dt = 0) {
    if (!this.settings.enabled) return;
    // the dome follows the camera, so no view can ever reach its edge
    this.sky.position.copy(this.engine.camera.position);
    if (this._envDirty) this._bakeEnvironment();
    this._fitClock -= dt;
    if (this._fitClock <= 0) {
      this._fitClock = 0.25;
      this.refit();
    } else if (this.activeRange > 0) {
      this._aimShadows(this.activeRange); // round the view: follows it every frame
    }
  }

  /** Where shadows are needed most: round the player in play, round what the editor looks at otherwise. */
  _focus(out) {
    const engine = this.engine;
    const player = engine.playing ? engine.playerEntity?.object3D : null;
    if (player) return player.getWorldPosition(out);
    const rig = engine.cameraRig;
    if (rig?.lookAt?.isVector3) return out.copy(rig.lookAt);
    const cam = engine.camera;
    return cam.getWorldDirection(out).multiplyScalar((this.activeRange || this.settings.shadowRange) * 0.5).add(cam.position);
  }

  /** Point the sun's shadow at an area of Shadow range round the view, sharp there. */
  _aimShadows(radius = this.settings.shadowRange) {
    const center = snapShadowCenter(this._focus(_focusV), this.sunDirection, radius, this.sun.shadow.mapSize.x, _centerV);
    this._shadowBox(center, radius);
  }

  /** The sun's shadow camera round `center`, `radius` either way. */
  _shadowBox(center, radius) {
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(this.sunDirection, radius * 2 + 10);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 0.1;
    cam.far = radius * 4 + 20;
    cam.updateProjectionMatrix();
    // bias in proportion to one shadow-map texel, so neither acne nor gaps — more with the
    // sun low: its light skims the ground, and one texel lies along metres of it (a ground
    // shadowing itself in bands at sunset)
    const texel = (2 * radius) / this.sun.shadow.mapSize.x;
    const up = THREE.MathUtils.clamp(this.sunDirection.y, 0.05, 1);
    const skim = Math.sqrt(1 - up * up) / up; // how flat the light comes in: 0 overhead, 8 at 7°
    this.sun.shadow.normalBias = texel * (1.5 + Math.min(6, skim * 0.75));
    this.fitRadius = radius;
  }

  _bakeEnvironment() {
    const renderer = this.engine.renderer;
    if (!renderer) return;
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(renderer);
    const target = this._pmrem.fromScene(this._envScene, 0.02);
    this._envTarget?.dispose();
    this._envTarget = target;
    this.engine.scene.environment = target.texture;
    this._envDirty = false;
  }

  /**
   * Aim the sun's shadow camera so it covers exactly what is in the scene,
   * and make sure every object casts and receives shadows. A fixed shadow
   * area either cuts shadows off or blurs them — the usual reason shadows
   * look broken. Objects added any way at all are picked up here within a
   * quarter of a second.
   */
  refit() {
    _box.makeEmpty();
    for (const entity of this.engine.entities || []) {
      const o = entity.object3D;
      if (!o || !o.visible || o.isLight) continue;
      o.traverse((node) => {
        if (node.isMesh && !node.userData.noShadow) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
      });
      _part.setFromObject(o);
      if (!_part.isEmpty()) _box.union(_part);
    }
    if (_box.isEmpty()) {
      _box.min.set(-10, -1, -10);
      _box.max.set(10, 5, 10);
    }

    _box.getBoundingSphere(_sphere);
    const whole = THREE.MathUtils.clamp(_sphere.radius, 4, 250);
    // a Shadow range smaller than the level — or, left at 0, a big level — sharp shadows
    // round the view instead (AUTO_SHADOW_FROM)
    const range = this.settings.shadowRange > 0 ? this.settings.shadowRange
      : (whole > AUTO_SHADOW_FROM ? AUTO_SHADOW_RANGE[this.settings.shadowQuality] ?? AUTO_SHADOW_RANGE.medium : 0);
    this.activeRange = range > 0 && range < whole ? range : 0;
    if (this.activeRange) {
      this._aimShadows(this.activeRange);
      return;
    }
    this._shadowBox(_sphere.center, whole);
  }

  dispose() {
    this._envTarget?.dispose();
    this._pmrem?.dispose();
    this.engine.scene.remove(this.sun, this.sun.target, this.sky);
  }
}
