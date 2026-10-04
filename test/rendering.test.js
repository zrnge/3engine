// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { budgetLampShadows, tuneLampShadow, LAMP_SHADOW_SIZES } from '../src/light-shadows.js';
import { Probes, makeProbe } from '../src/probes.js';
import { Effects } from '../src/effects.js';
import { normalizeSettings, ENV_DEFAULTS, Environment } from '../src/environment.js';

// Rendering: lamps' shadows (tuned, and only the nearest few at once), light probes
// (what is in a room lit by the room), and the picture's effects as settings.

describe('lamp shadows', () => {
  it('only the nearest few lamps cast at once — and their own settings come back after the frame', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 0);
    const lamps = [1, 2, 3, 4, 5, 6].map((d) => {
      const l = new THREE.PointLight(0xffffff, 10, 12);
      l.position.set(d * 3, 2, 0);
      l.castShadow = true;
      scene.add(l);
      return l;
    });
    const quiet = new THREE.PointLight(0xffffff, 10, 12); // never asked to cast
    scene.add(quiet);
    scene.updateMatrixWorld(true);
    const restore = budgetLampShadows(scene, camera, 2);
    expect(lamps.map((l) => l.castShadow)).toEqual([true, true, false, false, false, false]);
    expect(quiet.castShadow).toBe(false);
    restore();
    expect(lamps.every((l) => l.castShadow)).toBe(true);
    // the camera moved to the far end: the far ones cast instead — still two
    camera.position.set(20, 0, 0);
    const again = budgetLampShadows(scene, camera, 2);
    expect(lamps.map((l) => l.castShadow)).toEqual([false, false, false, false, true, true]);
    again();
    // within the budget: nothing to change
    expect(budgetLampShadows(scene, camera, 8)).toBe(null);
  });

  it('a lamp\'s shadow reaches as far as its light, at the level\'s detail, without acne', () => {
    const l = new THREE.PointLight(0xffffff, 10, 9);
    tuneLampShadow(l, 'high');
    expect(l.shadow.camera.far).toBe(9);
    expect(l.shadow.mapSize.x).toBe(LAMP_SHADOW_SIZES.high);
    expect(l.shadow.bias).toBeLessThan(0);
    const spot = new THREE.SpotLight(0xffffff, 10, 0); // no distance: 30 m
    tuneLampShadow(spot);
    expect(spot.shadow.camera.far).toBe(30);
  });
});

describe('light probes', () => {
  /** A probe round a room at x 0, and a mesh in it and one outside; a capture stood in for (no WebGL here). */
  function room() {
    const scene = new THREE.Scene();
    const probe = makeProbe({ intensity: 0.7 });
    probe.object3D.position.set(0, 2, 0);
    probe.object3D.scale.set(6, 4, 6);
    const inside = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    inside.position.set(1, 1, 1);
    const outside = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    outside.position.set(10, 1, 0);
    scene.add(probe.object3D, inside, outside);
    scene.updateMatrixWorld(true);
    const engine = { scene, entities: [probe, { object3D: inside }, { object3D: outside }], playing: false };
    const probes = new Probes(engine);
    const texture = new THREE.Texture();
    probes._captures.set(probe.object3D, { target: { dispose() {} }, texture });
    return { engine, probes, probe, inside, outside, texture };
  }

  it('what is inside the box takes its picture (at its strength); what is outside keeps the sky', () => {
    const { probes, inside, outside, texture } = room();
    probes.assign();
    expect(inside.material.envMap).toBe(texture);
    expect(inside.material.envMapIntensity).toBe(0.7);
    expect(outside.material.envMap).toBe(null);
  });

  it('something that walks out takes the sky again; back in, the room', () => {
    const { probes, inside, texture, engine } = room();
    probes.assign();
    inside.position.set(20, 1, 0);
    inside.updateMatrixWorld(true);
    probes._give(inside, probes.list);
    expect(inside.material.envMap).toBe(null);
    expect(inside.material.envMapIntensity).toBe(1);
    inside.position.set(0, 1, 0);
    inside.updateMatrixWorld(true);
    probes._give(inside, probes.list);
    expect(inside.material.envMap).toBe(texture);
    expect(engine.entities.length).toBe(3);
  });

  it('overlapping boxes: the smaller one (a cupboard in a room) wins', () => {
    const { probes, probe, engine } = room();
    const small = makeProbe();
    small.object3D.position.set(1, 1, 1);
    small.object3D.scale.set(2, 2, 2);
    engine.scene.add(small.object3D);
    engine.entities.push(small);
    engine.scene.updateMatrixWorld(true);
    expect(probes.probeAt(new THREE.Vector3(1, 1, 1))).toBe(small);
    expect(probes.probeAt(new THREE.Vector3(-2, 1, -2))).toBe(probe);
    expect(probes.probeAt(new THREE.Vector3(9, 1, 0))).toBe(null);
  });

  it('its box and ball are the editor\'s: hidden in play', () => {
    const { probes, probe, engine } = room();
    probes.dirty = false;
    engine.playing = true;
    probes.update(0.016);
    expect(probe.object3D.children.every((c) => !c.visible)).toBe(true);
    engine.playing = false;
    probes.update(0.016);
    expect(probe.object3D.children.every((c) => c.visible)).toBe(true);
  });

  it('moved in the editor, it is captured again once it stops moving', () => {
    const { probes, probe } = room();
    let captures = 0;
    probes.capture = () => { captures++; };
    probes.dirty = false;
    for (let i = 0; i < 40; i++) probes.update(0.016); // its place noted, settled: captured once
    expect(captures).toBe(1);
    for (let i = 0; i < 40; i++) probes.update(0.016); // left alone: not again
    expect(captures).toBe(1);
    // dragged: not while it moves, once when it stops
    for (let i = 0; i < 10; i++) {
      probe.object3D.position.x += 0.1;
      probe.object3D.updateMatrixWorld(true);
      probes.update(0.016);
    }
    expect(captures).toBe(1);
    probes.update(0.4);
    expect(captures).toBe(2);
  });
});

describe('light probes and lamps', () => {
  it('a lamp switched off in play: the probes capture again', () => {
    const scene = new THREE.Scene();
    const probe = makeProbe();
    const lamp = new THREE.PointLight(0xffaa66, 20, 8);
    scene.add(probe.object3D, lamp);
    const engine = { scene, entities: [probe, { object3D: lamp }], playing: true };
    const probes = new Probes(engine);
    let captures = 0;
    probes.capture = () => { captures++; };
    for (let i = 0; i < 10; i++) probes.update(0.016);
    expect(captures).toBe(1); // the first, when it loaded
    lamp.visible = false; // the lights die
    for (let i = 0; i < 10; i++) probes.update(0.016);
    expect(captures).toBe(2);
    for (let i = 0; i < 10; i++) probes.update(0.016);
    expect(captures).toBe(2);
  });
});

describe('effects as settings', () => {
  it('off by default; any effect (or any colour change) turns the chain on', () => {
    const fx = new Effects({ renderer: { getContext() {} } });
    expect(fx.active).toBe(false);
    fx.apply({ vignette: 0.3 });
    expect(fx.grading).toBe(true);
    expect(fx.active).toBe(true);
    fx.apply({ vignette: 0, ao: true });
    expect(fx.grading).toBe(false);
    expect(fx.active).toBe(true);
  });

  it('the level\'s settings: new ones clamped; changing the picture\'s effects keeps the sky\'s preset', () => {
    const s = normalizeSettings({ ao: 1, aoRadius: 99, dofFocus: 'nonsense', contrast: -5, grain: 2, lampShadows: 40 });
    expect(s).toMatchObject({ ao: true, aoRadius: 5, dofFocus: 'the player', contrast: -1, grain: 1, lampShadows: 8 });
    expect(normalizeSettings({}).lampShadows).toBe(ENV_DEFAULTS.lampShadows);
    const engine = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: null };
    const env = new Environment(engine);
    env.applyPreset('golden');
    env.set({ vignette: 0.4, saturation: -0.2, ao: true });
    expect(env.settings.preset).toBe('golden');
  });
});
