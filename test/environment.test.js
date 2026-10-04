import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { AUTO_SHADOW_RANGE,
  Environment, describeSky, normalizeSettings, sunElevation, ENV_PRESETS, ENV_DEFAULTS, snapShadowCenter, SHADOW_SIZES,
} from '../src/environment.js';
import { Effects } from '../src/effects.js';

/** Just enough engine for the environment: a scene, a camera and some entities. */
function fakeEngine({ renderer = null, entities = [] } = {}) {
  return {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(60, 1, 0.1, 1000),
    renderer,
    entities,
  };
}

const saturation = (c) => {
  const hsl = {};
  c.getHSL(hsl);
  return hsl.s;
};

describe('describeSky', () => {
  it('puts the sun high and bright at noon', () => {
    const noon = describeSky({ time: 12 });
    expect(noon.elevation).toBeCloseTo(70, 5);
    expect(noon.direction.y).toBeGreaterThan(0.9);
    expect(noon.isMoon).toBe(false);
    expect(noon.intensity).toBeGreaterThan(3);
  });

  it('makes sunset low, warm and dimmer than noon', () => {
    const noon = describeSky({ time: 12 });
    const sunset = describeSky({ time: 18 });
    expect(Math.abs(sunset.elevation)).toBeLessThan(1);
    expect(sunset.intensity).toBeLessThan(noon.intensity);
    expect(sunset.lightColor.r).toBeGreaterThan(sunset.lightColor.b * 2); // orange
    // the setting sun is held just above the horizon, never lighting from below
    expect(sunset.direction.y).toBeGreaterThan(0);
  });

  it('lights the night with a dim, cool moon from the other side of the sky', () => {
    const day = describeSky({ time: 12, azimuth: 90 });
    const night = describeSky({ time: 0, azimuth: 90 });
    expect(night.isMoon).toBe(true);
    expect(night.intensity).toBeLessThan(day.intensity * 0.25);
    expect(night.lightColor.b).toBeGreaterThan(night.lightColor.r);
    expect(Math.sign(night.direction.x)).toBe(-Math.sign(day.direction.x));
    expect(night.sunDisc).toBe(0);
  });

  it('turns the compass direction with azimuth', () => {
    const east = describeSky({ time: 12, azimuth: 90 }).direction;
    expect(east.x).toBeGreaterThan(0);
    expect(Math.abs(east.z)).toBeLessThan(1e-6);
    const south = describeSky({ time: 12, azimuth: 0 }).direction;
    expect(south.z).toBeGreaterThan(0);
  });

  it('clouds dim the sun, grey the sky, soften shadows and raise the sky light', () => {
    const clear = describeSky({ time: 12, clouds: 0, softness: 0.2 });
    const overcast = describeSky({ time: 12, clouds: 1, softness: 0.2 });
    expect(overcast.intensity).toBeLessThan(clear.intensity * 0.2);
    expect(saturation(overcast.sky)).toBeLessThan(saturation(clear.sky));
    expect(overcast.softness).toBeGreaterThan(0.8);
    expect(overcast.fill).toBeGreaterThan(clear.fill);
    expect(overcast.sunDisc).toBe(0);
  });

  it('studio lighting ignores the time of day', () => {
    const a = describeSky({ studio: true, time: 0 });
    const b = describeSky({ studio: true, time: 12 });
    expect(a.intensity).toBe(b.intensity);
    expect(a.direction.equals(b.direction)).toBe(true);
    expect(a.isMoon).toBe(false);
  });

  it('keeps sunrise and sunset symmetric around noon', () => {
    expect(sunElevation(9)).toBeCloseTo(sunElevation(15), 9);
    expect(sunElevation(6)).toBeCloseTo(0, 9);
  });
});

describe('normalizeSettings', () => {
  it('fills in daylight defaults', () => {
    expect(normalizeSettings()).toEqual({ ...ENV_DEFAULTS });
    expect(normalizeSettings(undefined).enabled).toBe(true);
  });

  it('clamps everything into range', () => {
    const s = normalizeSettings({ time: 99, clouds: -1, exposure: 50, softness: 3, fog: -5, azimuth: 370 });
    expect(s.time).toBe(24);
    expect(s.clouds).toBe(0);
    expect(s.exposure).toBe(4);
    expect(s.softness).toBe(1);
    expect(s.fog).toBe(0);
    expect(s.azimuth).toBe(10);
  });

  it('survives junk', () => {
    const s = normalizeSettings({ time: 'noon', exposure: null, enabled: 'yes' });
    expect(s.time).toBe(ENV_DEFAULTS.time);
    expect(s.enabled).toBe(true);
  });
});

describe('Environment', () => {
  it('is on by default, with a shadow-casting sun and a sky', () => {
    const engine = fakeEngine();
    const env = new Environment(engine);
    expect(env.enabled).toBe(true);
    expect(env.sun.visible).toBe(true);
    expect(env.sun.castShadow).toBe(true);
    expect(env.sky.visible).toBe(true);
    expect(engine.scene.children).toContain(env.sun);
  });

  it('switches tone mapping and exposure on the renderer', () => {
    const renderer = { toneMapping: THREE.NoToneMapping, toneMappingExposure: 1 };
    const env = new Environment(fakeEngine({ renderer }));
    env.set({ exposure: 1.6 });
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBeCloseTo(1.6, 9);

    env.applyPreset('off');
    expect(renderer.toneMapping).toBe(THREE.NoToneMapping);
    expect(renderer.toneMappingExposure).toBe(1);
  });

  it('"off" removes the sun, sky, fog and reflections', () => {
    const engine = fakeEngine();
    const env = new Environment(engine);
    env.set({ fog: 200 });
    env.applyPreset('off');
    expect(env.enabled).toBe(false);
    expect(env.sun.visible).toBe(false);
    expect(env.sky.visible).toBe(false);
    expect(engine.scene.fog).toBeNull();
    expect(engine.scene.environment).toBeNull();
  });

  it('applies presets and remembers which one', () => {
    const env = new Environment(fakeEngine());
    env.applyPreset('golden');
    expect(env.settings.preset).toBe('golden');
    expect(env.settings.time).toBe(ENV_PRESETS.golden.time);
    env.applyPreset('nonsense');
    expect(env.settings.preset).toBe('golden');
  });

  it('marks the look "custom" once you tweak it', () => {
    const env = new Environment(fakeEngine());
    env.applyPreset('day');
    env.set({ time: 15 });
    expect(env.settings.preset).toBe('custom');
  });

  it('adds fog that fades into the horizon colour', () => {
    const engine = fakeEngine();
    const env = new Environment(engine);
    env.set({ fog: 300 });
    expect(engine.scene.fog).toBeInstanceOf(THREE.Fog);
    expect(engine.scene.fog.far).toBe(300);
    expect(engine.scene.fog.color.equals(env.look.horizon)).toBe(true);
    env.set({ fog: 0 });
    expect(engine.scene.fog).toBeNull();
  });

  it('turning sun shadows off stops the sun casting', () => {
    const env = new Environment(fakeEngine());
    env.set({ shadows: false });
    expect(env.sun.castShadow).toBe(false);
  });

  it('round-trips its settings and falls back to daylight for old scenes', () => {
    const env = new Environment(fakeEngine());
    env.applyPreset('night');
    const saved = JSON.parse(JSON.stringify(env.toJSON()));

    const other = new Environment(fakeEngine());
    other.load(saved);
    expect(other.toJSON()).toEqual(saved);

    other.load(undefined); // a scene saved before environments existed
    expect(other.settings.preset).toBe('day');
    expect(other.enabled).toBe(true);
  });

  it('fits the sun\'s shadow area to the objects in the scene', () => {
    const near = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    near.position.set(30, 0, 0);
    const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    far.position.set(-30, 0, 0);
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    hidden.position.set(900, 0, 0);
    hidden.visible = false;
    const lamp = new THREE.PointLight();
    lamp.position.set(-900, 0, 0);
    const entities = [near, far, hidden, lamp].map((object3D) => ({ object3D }));

    const env = new Environment(fakeEngine({ entities }));
    const cam = env.sun.shadow.camera;
    expect(cam.right).toBeGreaterThanOrEqual(30);
    expect(cam.right).toBeLessThan(100); // hidden objects and lights don't stretch it
    expect(env.sun.target.position.length()).toBeLessThan(1);
    expect(cam.far).toBeGreaterThan(cam.right * 2);
  });

  it('makes every object cast and receive shadows, however it was added', () => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1));
    const opt = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    opt.userData.noShadow = true;
    const env = new Environment(fakeEngine({ entities: [{ object3D: mesh }, { object3D: opt }] }));
    env.refit();
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    expect(opt.castShadow).toBe(false);
  });

  it('keeps the sky on the camera', () => {
    const engine = fakeEngine();
    const env = new Environment(engine);
    engine.camera.position.set(12, 5, -40);
    env.update(0.016);
    expect(env.sky.position.equals(engine.camera.position)).toBe(true);
  });

  it('points the sun along the time-of-day direction', () => {
    const env = new Environment(fakeEngine());
    env.set({ time: 8, azimuth: 90 });
    const toSun = env.sun.position.clone().sub(env.sun.target.position).normalize();
    expect(toSun.distanceTo(env.sunDirection)).toBeLessThan(1e-6);
    expect(env.sunDirection.x).toBeGreaterThan(0);
  });

  it('bakes sky reflections only when a real renderer is present', () => {
    const engine = fakeEngine();
    const env = new Environment(engine);
    const bake = vi.spyOn(env, '_bakeEnvironment');
    env.update(0.016);
    expect(bake).toHaveBeenCalled();
    expect(engine.scene.environment).toBeNull(); // no renderer, nothing baked
  });
});

describe('sharper shadows, and bloom', () => {
  it('saved with the level, each kept in range', () => {
    const s = normalizeSettings({ shadowQuality: 'ultra', shadowRange: -5, bloom: 1, bloomStrength: 9, bloomThreshold: 2, bloomRadius: 'x' });
    expect(s.shadowQuality).toBe('medium');
    expect(s.shadowRange).toBe(0);
    expect(s.bloom).toBe(true);
    expect(s.bloomStrength).toBe(3);
    expect(s.bloomThreshold).toBe(1);
    expect(s.bloomRadius).toBe(ENV_DEFAULTS.bloomRadius);
    expect(normalizeSettings({}).bloom).toBe(false); // off unless asked for
  });

  it("shadow detail sets the shadow picture's size", () => {
    const env = new Environment(fakeEngine());
    env.set({ shadowQuality: 'high' });
    expect(env.sun.shadow.mapSize.x).toBe(SHADOW_SIZES.high);
    env.set({ shadowQuality: 'low' });
    expect(env.sun.shadow.mapSize.x).toBe(1024);
  });

  it("bloom and shadows don't make a preset custom — and a preset leaves them be", () => {
    const env = new Environment(fakeEngine());
    env.applyPreset('golden');
    env.set({ bloom: true, bloomStrength: 1.2, shadowRange: 40 });
    expect(env.settings.preset).toBe('golden');
    env.applyPreset('night');
    expect(env.settings.bloom).toBe(true);
    expect(env.settings.shadowRange).toBe(40);
  });

  it('a shadow range: sharp round the player, not stretched over the whole level', () => {
    const player = new THREE.Object3D();
    player.position.set(200, 0, -150);
    const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    far.position.set(-240, 0, 240);
    const near = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    near.position.copy(player.position);
    const engine = fakeEngine({ entities: [{ object3D: far }, { object3D: near }] });
    engine.scene.add(far, near);
    engine.playing = true;
    engine.playerEntity = { object3D: player };
    const env = new Environment(engine);
    env.refit();
    // left at 0 (automatic), a level this big gets sharp shadows round the player, not one blurry picture of it all
    expect(env.fitRadius).toBe(AUTO_SHADOW_RANGE.medium);
    expect(env.sun.target.position.distanceTo(player.position)).toBeLessThan(1);
    env.set({ shadowRange: 30 });
    env.refit();
    expect(env.fitRadius).toBe(30);
    expect(env.sun.target.position.distanceTo(player.position)).toBeLessThan(1); // round the player
    player.position.x += 50; // it walks on: the shadows go with it, every frame
    env.update(0.016);
    expect(env.sun.target.position.distanceTo(player.position)).toBeLessThan(1);
  });

  it('automatic: a small level is shadowed all at once; a low sun gets more bias (no bands on the ground at sunset)', () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    box.position.set(20, 0, 10);
    const engine = fakeEngine({ entities: [{ object3D: box }] });
    engine.scene.add(box);
    const env = new Environment(engine);
    env.refit();
    expect(env.activeRange).toBe(0); // all of it, in one shadow picture
    env.set({ preset: 'day' });
    env.refit();
    const noon = env.sun.shadow.normalBias;
    env.applyPreset('golden');
    env.refit();
    expect(env.sunDirection.y).toBeLessThan(0.2);
    expect(env.sun.shadow.normalBias).toBeGreaterThan(noon * 2);
  });

  it("the shadow area moves in whole shadow pixels, so edges don't shimmer as you walk", () => {
    const dir = new THREE.Vector3(0.4, 1, 0.3).normalize();
    const texel = 60 / 2048;
    // across the light, where the shadow picture lies: always on its pixel grid
    const right = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    const up = new THREE.Vector3().crossVectors(dir, right).normalize();
    const onGrid = (v) => Math.abs(v / texel - Math.round(v / texel)) < 1e-6;
    for (let i = 0; i < 50; i++) {
      const focus = new THREE.Vector3(10 + i * 0.0137, 0.3, -4 + i * 0.0071); // walking, a little at a time
      const c = snapShadowCenter(focus, dir, 30, 2048);
      expect(onGrid(c.dot(right)) && onGrid(c.dot(up))).toBe(true);
      expect(c.distanceTo(focus)).toBeLessThan(texel); // and never more than a pixel from where it should be
    }
  });

  it('no bloom, no extra work: the scene is drawn straight to the screen', () => {
    const render = vi.fn();
    const fx = new Effects({ renderer: { render, getContext: () => ({}) } });
    fx.render('scene', 'camera');
    expect(render).toHaveBeenCalledWith('scene', 'camera');
    expect(fx._composer).toBeNull();
    fx.apply({ bloom: true, bloomStrength: 1.5 });
    expect(fx.active).toBe(true);
    expect(fx.settings.bloomStrength).toBe(1.5);
  });
});
