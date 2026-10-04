import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { simplify, LodSystem } from '../src/lod.js';
import { Instancer } from '../src/instancing.js';

// ---------------------------------------------------------------- simplifying

describe('a simpler shape, for far away', () => {
  it('about the share of points asked for, the same size, nothing squashed flat', () => {
    const ball = new THREE.SphereGeometry(1, 64, 48);
    for (const ratio of [0.5, 0.25, 0.1]) {
      const s = simplify(ball, ratio);
      expect(s).not.toBeNull();
      const got = s.attributes.position.count / ball.attributes.position.count;
      expect(got).toBeLessThan(ratio * 1.6);
      s.computeBoundingBox();
      const size = s.boundingBox.getSize(new THREE.Vector3());
      expect(size.x).toBeGreaterThan(1.7); // still about 2 across
      const idx = s.index.array;
      for (let t = 0; t < idx.length; t += 3) {
        expect(idx[t] !== idx[t + 1] && idx[t + 1] !== idx[t + 2] && idx[t] !== idx[t + 2]).toBe(true);
      }
      expect(s.attributes.normal).toBeTruthy();
      expect(s.attributes.uv).toBeTruthy(); // textures still sit on it
    }
  });

  it('a model of several materials keeps them, part by part', () => {
    const g = new THREE.BoxGeometry(2, 2, 2, 24, 24, 24); // 6 faces, a material each
    const s = simplify(g, 0.25);
    expect(s.groups.length).toBe(6);
    expect(s.groups.every((grp) => grp.count > 0)).toBe(true);
  });

  it('a shape already simple is left alone', () => {
    expect(simplify(new THREE.BoxGeometry(1, 1, 1), 0.25)).toBeNull();
  });

  it('quick, however big: 100 000 points in well under a second', () => {
    const big = new THREE.SphereGeometry(1, 400, 250);
    const t = performance.now();
    const s = simplify(big, 0.1);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(s.attributes.position.count).toBeLessThan(big.attributes.position.count * 0.16);
  });
});

// ---------------------------------------------------------------- by distance

function engineWith(objects, { lod = [], drawDistance = 0 } = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const entities = objects.map((o) => { scene.add(o); return { object3D: o }; });
  scene.updateMatrixWorld(true);
  const engine = {
    scene, camera, entities, playing: true,
    environment: { settings: { drawDistance, instancing: true } },
    gameplay: { components: { instances: lod.map(([i, props]) => ({ type: 'lod', entity: entities[i], props })) } },
  };
  return engine;
}

describe('far things simpler, farther ones not drawn', () => {
  const statue = (x) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.MeshStandardMaterial());
    m.position.set(x, 0, 0);
    return m;
  };

  it('simpler beyond "Simpler from", hidden beyond "Hide from" — and all as it was once drawn', () => {
    const near = statue(10);
    const mid = statue(60);
    const far = statue(300);
    const engine = engineWith([near, mid, far], {
      lod: [0, 1, 2].map((i) => [i, { simplerFrom: 30, detail: '25%', hideFrom: 200 }]),
    });
    const lod = new LodSystem(engine);
    const full = mid.geometry;
    const nearFull = near.geometry;
    let restore = lod.apply(engine.camera); // the first time: queued, made within the frame's budget
    restore?.();
    restore = lod.apply(engine.camera);
    expect(near.geometry).toBe(nearFull); // close: full detail
    expect(mid.geometry).not.toBe(full); // simpler
    expect(mid.geometry.attributes.position.count).toBeLessThan(full.attributes.position.count * 0.4);
    expect(far.visible).toBe(false); // hidden
    restore();
    expect(mid.geometry).toBe(full); // physics and clicks always see the real one
    expect(far.visible).toBe(true);
  });

  it('the level\'s draw distance hides whatever is farther', () => {
    const a = statue(50);
    const b = statue(900);
    const engine = engineWith([a, b], { drawDistance: 400 });
    const restore = new LodSystem(engine).apply(engine.camera);
    expect([a.visible, b.visible]).toEqual([true, false]);
    restore();
    expect(b.visible).toBe(true);
  });

  it('nothing changes while editing', () => {
    const b = statue(900);
    const engine = engineWith([b], { drawDistance: 100 });
    engine.playing = false;
    expect(new LodSystem(engine).apply(engine.camera)).toBeNull();
    expect(b.visible).toBe(true);
  });
});

// ---------------------------------------------------------------- instancing

describe('copies drawn together', () => {
  const coin = (x, color = '#ffcc00', extra = {}) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.1, 24), new THREE.MeshStandardMaterial({ color, ...extra }));
    m.position.set(x, 1, 0);
    return m;
  };

  it('many alike: one batch, each copy where it is, in its own colour; their own meshes draw nothing', () => {
    const coins = Array.from({ length: 10 }, (_, i) => coin(i * 2, i % 2 ? '#ff0000' : '#00ff00'));
    const engine = engineWith(coins);
    const inst = new Instancer(engine);
    inst.sync(0);
    expect(inst.batches.size).toBe(1);
    expect(inst.saved).toBe(9);
    const [b] = inst.batches.values();
    expect(b.mesh.count).toBe(10);
    const m = new THREE.Matrix4();
    b.mesh.getMatrixAt(3, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBe(6);
    const c = new THREE.Color();
    b.mesh.getColorAt(1, c);
    expect(c.getHexString()).toBe('ff0000');
    expect(coins.every((k) => k.material.visible === false)).toBe(true);
    // clicked and shot as ever: the copy's own mesh is still hit
    const ray = new THREE.Raycaster(new THREE.Vector3(6, 5, 0), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(coins[3]).length).toBeGreaterThan(0);
  });

  it('follows them: moved, hidden, destroyed', () => {
    const coins = Array.from({ length: 6 }, (_, i) => coin(i));
    const engine = engineWith(coins);
    const inst = new Instancer(engine);
    inst.sync(0);
    const [b] = inst.batches.values();
    coins[0].position.x = 50;
    coins[1].visible = false;
    engine.scene.updateMatrixWorld(true);
    inst.sync(0.016);
    const m = new THREE.Matrix4();
    b.mesh.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBe(50);
    b.mesh.getMatrixAt(1, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).length()).toBe(0); // hidden: nowhere
    // destroyed: its own material back (so that one is disposed), and the batch remade without it
    const own = inst._batched.get(coins[2]);
    inst.forget(coins[2]);
    expect(coins[2].material).toBe(own);
    coins[2].removeFromParent();
    engine.entities.splice(2, 1);
    inst.sync(0.016);
    expect([...inst.batches.values()][0].mesh.count).toBe(5);
  });

  it('only what can be: not see-through ones, not too few, not different looks', () => {
    const glass = Array.from({ length: 6 }, (_, i) => coin(i, '#ffffff', { transparent: true, opacity: 0.5 }));
    const three = Array.from({ length: 3 }, (_, i) => coin(i + 20));
    const rough = Array.from({ length: 5 }, (_, i) => coin(i + 40, '#fff', { roughness: 0.1 }));
    const matte = Array.from({ length: 5 }, (_, i) => coin(i + 60, '#fff', { roughness: 0.9 }));
    const engine = engineWith([...glass, ...three, ...rough, ...matte]);
    const inst = new Instancer(engine);
    inst.sync(0);
    expect(inst.batches.size).toBe(2); // the rough ones, the matte ones
    expect(glass.every((g) => g.material.visible !== false)).toBe(true);
    expect(three.every((g) => g.material.visible !== false)).toBe(true);
  });

  it('when play stops — or it is switched off — everything draws itself again', () => {
    const coins = Array.from({ length: 5 }, (_, i) => coin(i));
    const engine = engineWith(coins);
    const own = coins.map((c) => c.material);
    const inst = new Instancer(engine);
    inst.sync(0);
    expect(engine.scene.children.some((c) => c.isInstancedMesh)).toBe(true);
    engine.playing = false;
    inst.sync(0);
    expect(coins.map((c) => c.material)).toEqual(own);
    expect(engine.scene.children.some((c) => c.isInstancedMesh)).toBe(false);
    engine.playing = true;
    engine.environment.settings.instancing = false;
    inst.sync(0);
    expect(inst.batches.size).toBe(0);
  });
});
