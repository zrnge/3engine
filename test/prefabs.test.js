// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  PrefabLibrary, prefabFromEntity, overridesOf, mergeFromPrefab, instanceRecord,
  updateSavedCopies, legacyPrefab, canonical,
} from '../src/prefabs.js';
import { SceneSerializer } from '../src/scene.js';
import { Project } from '../src/project.js';
import { Entity } from '../src/entity.js';
import { Player } from '../src/player.js';
import { PhysicsWorld } from '../src/physics.js';
import { BehaviorRunner } from '../src/behavior.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';

/** A saved crate, as a scene stores one entity. */
const crate = (over = {}) => ({
  name: 'Crate', type: 'primitive', primitive: 'box',
  position: [3, 0.5, -2], rotation: [0, 0.4, 0], scale: [1, 1, 1],
  solid: true, parent: -1,
  material: { color: '#aa7744', roughness: 0.8 },
  rigidBody: { type: 'static', mass: 1, restitution: 0, friction: 0.5, isTrigger: false },
  components: [{ type: 'rotator', props: { speed: 1 } }],
  ...over,
});

describe('comparing a copy with its prefab', () => {
  it('a prefab keeps everything but where the object stood', () => {
    const rec = prefabFromEntity(crate());
    expect(rec.position).toEqual([0, 0.5, 0]); // its height, centred
    expect(rec.rotation).toEqual([0, 0.4, 0]);
    expect(rec.name).toBeUndefined();
    expect(rec.parent).toBeUndefined();
    expect(rec.material.color).toBe('#aa7744');
  });

  it('a fresh copy has no overrides; moving, turning or renaming it adds none', () => {
    const rec = prefabFromEntity(crate());
    expect(overridesOf(crate(), rec)).toEqual([]);
    expect(overridesOf(crate({ name: 'Crate 7', position: [9, 9, 9], rotation: [1, 2, 3], parent: 4 }), rec)).toEqual([]);
  });

  it('each changed part is its own override', () => {
    const rec = prefabFromEntity(crate());
    const d = crate({ material: { color: '#ff0000', roughness: 0.8 }, scale: [2, 2, 2] });
    expect(overridesOf(d, rec)).toEqual(['look', 'size']);
    expect(overridesOf(crate({ components: undefined }), rec)).toEqual(['components']);
    expect(overridesOf(crate({ solid: false }), rec)).toEqual(['physics']);
  });

  it('key order and missing-vs-undefined never count as a change', () => {
    expect(canonical({ a: 1, b: undefined, c: [1, { y: 2, x: 1 }] })).toBe(canonical({ c: [1, { x: 1, y: 2 }], a: 1 }));
  });

  it('bringing a copy up to date takes the prefab, but keeps its place and its own changes', () => {
    const before = prefabFromEntity(crate());
    const after = { ...before, material: { color: '#00ff00', roughness: 0.2 }, scale: [3, 3, 3] };
    const plain = crate({ name: 'A', position: [5, 0.5, 5] });
    const bigger = crate({ name: 'B', scale: [2, 2, 2] });

    const a = mergeFromPrefab(plain, after, overridesOf(plain, before));
    expect(a.material.color).toBe('#00ff00');
    expect(a.scale).toEqual([3, 3, 3]);
    expect(a.position).toEqual([5, 0.5, 5]);
    expect(a.name).toBe('A');

    const b = mergeFromPrefab(bigger, after, overridesOf(bigger, before));
    expect(b.material.color).toBe('#00ff00'); // the colour it never changed follows
    expect(b.scale).toEqual([2, 2, 2]);       // the size it did change is kept
  });

  it('a part the prefab drops is dropped from its copies too', () => {
    const before = prefabFromEntity(crate());
    const after = { ...before };
    delete after.components;
    const merged = mergeFromPrefab(crate(), after, []);
    expect(merged.components).toBeUndefined();
  });

  it('a new copy is linked, named after the prefab, and stands where asked', () => {
    const d = instanceRecord(prefabFromEntity(crate()), 'Crate', { x: 1, y: 2, z: 3 });
    expect(d).toMatchObject({ name: 'Crate', prefab: 'Crate', parent: -1, position: [1, 2, 3] });
    expect(instanceRecord(prefabFromEntity(crate()), 'Crate').position).toEqual([0, 0.5, 0]);
  });
});

describe('saved levels', () => {
  it('copies in a level on disk follow the prefab; deleting it leaves ordinary objects', () => {
    const before = prefabFromEntity(crate());
    const after = { ...before, material: { color: '#123456' } };
    const entities = [
      { ...crate(), prefab: 'Crate' },
      { ...crate({ material: { color: '#ffffff' } }), prefab: 'Crate' },
      crate(), // not linked
    ];
    expect(updateSavedCopies(entities, 'Crate', before, after)).toBe(2);
    expect(entities[0].material.color).toBe('#123456');
    expect(entities[1].material.color).toBe('#ffffff'); // its own colour
    expect(entities[2].material.color).toBe('#aa7744'); // untouched

    updateSavedCopies(entities, 'Crate', after, null);
    expect(entities.some((d) => d.prefab)).toBe(false);
    expect(entities[0].material.color).toBe('#123456'); // they stay as they were
  });
});

describe('prefabs from older versions', () => {
  it('converts the old in-browser format', () => {
    const box = legacyPrefab({
      name: 'Old', position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 2, y: 2, z: 2 }, solid: true, primitive: 'sphere',
      material: { color: '#ff00ff' }, rigidBody: { type: 'dynamic', shape: 'auto' },
      components: [{ type: 'pickup', props: {} }],
    });
    expect(box).toMatchObject({ type: 'primitive', primitive: 'sphere', position: [0, 1, 0], scale: [2, 2, 2] });
    expect(box.rigidBody.shape).toBeUndefined();
    expect(box.components).toHaveLength(1);

    const lamp = legacyPrefab({ light: { type: 'point', color: '#ffeeaa', intensity: 3, distance: 8 } });
    expect(lamp).toMatchObject({ type: 'light', lightType: 'point', intensity: 3, distance: 8 });
    expect(legacyPrefab({ name: 'nothing' })).toBeNull();
  });
});

describe('PrefabLibrary', () => {
  it('stores copies, never the caller\'s object', () => {
    const lib = new PrefabLibrary();
    const rec = prefabFromEntity(crate());
    lib.set('Crate', rec);
    rec.scale = [9, 9, 9];
    expect(lib.get('Crate').scale).toEqual([1, 1, 1]);
    lib.get('Crate').scale[0] = 5;
    expect(lib.get('Crate').scale[0]).toBe(1);
  });

  it('finds a free name and survives a save/load round trip', () => {
    const lib = new PrefabLibrary();
    const onChange = vi.fn();
    lib.onChange = onChange;
    lib.set('Coin', { type: 'coin' });
    expect(lib.uniqueName('Coin')).toBe('Coin 2');
    expect(lib.uniqueName('Gem')).toBe('Gem');
    const copy = new PrefabLibrary();
    copy.load(JSON.parse(JSON.stringify(lib.toJSON())));
    expect(copy.names()).toEqual(['Coin']);
    expect(onChange).toHaveBeenCalled();
    expect(lib.delete('Coin')).toBe(true);
    expect(lib.has('Coin')).toBe(false);
  });
});

// ---------------------------------------------------------------- building them

function harness() {
  const scene = new THREE.Scene();
  const physics = new PhysicsWorld();
  const behaviors = new BehaviorRunner();
  const engine = {
    scene, physics, entities: [], sounds: [],
    camera: new THREE.PerspectiveCamera(60, 1, 0.1, 1000),
    grid: new THREE.GridHelper(1, 1),
    variables: new VariableStore(),
    materialLibrary: new Map(),
    prefabs: new PrefabLibrary(),
    playerEntity: null,
    add(e) {
      if (!this.entities.includes(e)) this.entities.push(e);
      scene.add(e.object3D);
      physics.register(e);
      return e;
    },
    remove(e) {
      const i = this.entities.indexOf(e);
      if (i !== -1) this.entities.splice(i, 1);
      physics.unregister(e);
      this.gameplay.components.clearEntity(e);
      this.gameplay.rules.clearEntity(e);
      scene.remove(e.object3D);
    },
    addBehavior: (e, code) => behaviors.add(e, code, { engine }),
    removeBehavior: (e) => behaviors.remove(e),
    addSound(entity, buffer, opts) {
      const rec = { entity, audio: { isPlaying: false, stop() {} }, ...opts };
      this.sounds.push(rec);
      return rec;
    },
    stopAllSounds() {},
  };
  engine.gameplay = new Gameplay(engine);
  const editor = {
    selectables: [],
    select() {},
    register(e) { if (!this.selectables.includes(e)) this.selectables.push(e); },
    unregister(e) {
      const i = this.selectables.indexOf(e);
      if (i !== -1) this.selectables.splice(i, 1);
    },
    _renderHierarchy() {},
  };
  const rig = {
    mode: 'orbit', target: null, theta: 0, phi: 1, distance: 10, lookAt: new THREE.Vector3(),
    setMode(mode, opts = {}) { this.mode = mode; this.target = opts.target ?? null; },
    setTarget(t) { this.target = t; }, setFov() {},
  };
  const player = engine.add(new Player());
  const serializer = new SceneSerializer(engine, editor, rig, player, {});
  engine.gameplay.spawnPrefab = (name, position) => serializer.spawnPrefab(name, position);
  return { engine, editor, serializer, player };
}

function placeBox(h, name, color = '#aa7744') {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color }));
  mesh.name = name;
  mesh.position.set(4, 0.5, 4);
  const e = new Entity(mesh);
  h.engine.add(e);
  h.editor.register(e);
  h.engine.gameplay.components.add(e, 'rotator', { speed: 2 });
  return e;
}

describe('building prefabs', () => {
  it('an object saved as a prefab rebuilds with its components, linked, where it is spawned', () => {
    const h = harness();
    const box = placeBox(h, 'Crate');
    h.engine.prefabs.set('Crate', h.serializer.prefabRecord(box));

    // spawning during play has no frame to wait in: it comes back at once
    const copy = h.engine.gameplay.spawn('Crate', { x: 7, y: 1, z: -3 });
    expect(copy).toBeTruthy();
    expect(copy.prefab).toBe('Crate');
    expect(copy.object3D.position.toArray()).toEqual([7, 1, -3]);
    expect(copy.object3D.material.color.getHexString()).toBe('aa7744');
    expect(h.engine.gameplay.components.serializeFor(copy)).toMatchObject([{ type: 'rotator', props: { speed: 2 } }]);
    expect(h.editor.selectables).toContain(copy);
    expect(overridesOf(h.serializer.entityRecord(copy), h.engine.prefabs.get('Crate'))).toEqual([]);
  });

  it('the player can\'t be a prefab', () => {
    const h = harness();
    expect(h.serializer.prefabRecord(h.player)).toBeNull();
  });

  it('the link and the library are saved with the scene and come back', async () => {
    const h = harness();
    const box = placeBox(h, 'Crate');
    h.engine.prefabs.set('Crate', h.serializer.prefabRecord(box));
    await h.serializer.placePrefab('Crate', { x: 1, y: 0.5, z: 1 });
    const data = JSON.parse(JSON.stringify(h.serializer.serialize()));
    expect(Object.keys(data.prefabs)).toEqual(['Crate']);
    expect(data.entities.filter((d) => d.prefab === 'Crate')).toHaveLength(1);

    const h2 = harness();
    await h2.serializer.deserialize(data);
    expect(h2.engine.prefabs.names()).toEqual(['Crate']);
    const linked = h2.editor.selectables.filter((e) => e.prefab === 'Crate');
    expect(linked).toHaveLength(1);
    expect(linked[0].object3D.position.toArray()).toEqual([1, 0.5, 1]);
  });

  it('a model prefab spawned in play arrives a moment later, at its spawn point', async () => {
    const h = harness();
    h.serializer.assets = {
      loadFromStore: vi.fn(async (id) => {
        const g = new THREE.Group();
        g.userData.assetId = id;
        return g;
      }),
    };
    h.engine.prefabs.set('Tree', { type: 'model', assetId: 'tree-1', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(h.engine.gameplay.spawn('Tree', { x: 5, y: 0, z: 6 })).toBeNull();
    await vi.waitFor(() => expect(h.editor.selectables.some((e) => e.prefab === 'Tree')).toBe(true));
    const tree = h.editor.selectables.find((e) => e.prefab === 'Tree');
    expect(tree.object3D.position.toArray()).toEqual([5, 0, 6]);
  });

  it('a model prefab whose file has been read spawns inside the frame, ready to launch', () => {
    // REGRESSION: model prefabs always arrived a moment later and spawn returned
    // null — so "Shoot prefab" with a model never flew and never timed out
    const h = harness();
    h.serializer.assets = {
      loadFromStoreSync: vi.fn((id) => {
        const g = new THREE.Group();
        g.userData.assetId = id;
        return g;
      }),
      loadFromStore: vi.fn(),
    };
    h.engine.prefabs.set('Rocket', {
      type: 'model', assetId: 'rocket-1', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      rigidBody: { type: 'dynamic', mass: 1, restitution: 0, friction: 0, isTrigger: false },
    });
    const rocket = h.engine.gameplay.spawn('Rocket', { x: 2, y: 1, z: 3 });
    expect(rocket).toBeTruthy();
    expect(rocket.prefab).toBe('Rocket');
    expect(rocket.object3D.userData.assetId).toBe('rocket-1');
    expect(rocket.object3D.position.toArray()).toEqual([2, 1, 3]);
    expect(rocket.rigidBody?.type).toBe('dynamic');
    expect(h.editor.selectables).toContain(rocket);
    expect(h.serializer.assets.loadFromStore).not.toHaveBeenCalled();
  });

  it('a spawner stops at "Max alive" with model prefabs too', () => {
    // REGRESSION: it counted what spawn returned — null for a model — so it never stopped
    const h = harness();
    h.serializer.assets = { loadFromStoreSync: (id) => Object.assign(new THREE.Group(), { userData: { assetId: id } }) };
    h.engine.prefabs.set('Bat', { type: 'model', assetId: 'bat-1', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    const nest = placeBox(h, 'Nest');
    h.engine.gameplay.components.add(nest, 'spawner', { prefab: 'Bat', interval: 0.1, max: 2 });
    h.engine.gameplay.start();
    for (let i = 1; i <= 20; i++) h.engine.gameplay.update(0.2, i * 0.2);
    expect(h.editor.selectables.filter((e) => e.prefab === 'Bat')).toHaveLength(2);
  });

  it('opening a game reads every model prefab\'s file, so its copies can spawn at once', async () => {
    const h = harness();
    const preload = vi.fn(async () => {});
    h.serializer.assets = { preload };
    const project = new Project(h.serializer);
    await project.load({
      type: 'tiny3-project', version: 1, start: 0, current: 0,
      shared: {
        prefabs: {
          Rocket: { type: 'model', assetId: 'rocket-1', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          Crate: prefabFromEntity(crate()),
        },
      },
      levels: [{ name: 'One', scene: { version: 1, entities: [] } }],
    });
    expect(preload).toHaveBeenCalledTimes(1); // the model, not the crate
    expect(preload).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'rocket-1' }));
  });

  it('a model still loading when the level changes never lands in the new level', async () => {
    const h = harness();
    let finish;
    h.serializer.assets = { loadFromStore: () => new Promise((r) => { finish = r; }) };
    h.engine.prefabs.set('Tree', { type: 'model', assetId: 't', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    h.engine.gameplay.spawn('Tree', { x: 0, y: 0, z: 0 });
    await h.serializer.deserialize({ version: 1, entities: [], prefabs: h.engine.prefabs.toJSON() });
    finish(new THREE.Group());
    await new Promise((r) => setTimeout(r, 0));
    expect(h.editor.selectables.some((e) => e.prefab === 'Tree')).toBe(false);
  });
});

describe('Project — prefabs across levels', () => {
  it('shares one library, and updates copies in the levels not being edited', () => {
    const h = harness();
    const project = new Project(h.serializer);
    const before = prefabFromEntity(crate());
    h.engine.prefabs.set('Crate', before);
    project.levels = [
      { name: 'One', data: { version: 1, entities: [{ ...crate(), prefab: 'Crate' }] } },
      { name: 'Two', data: { version: 1, entities: [{ ...crate(), prefab: 'Crate' }, { ...crate(), prefab: 'Crate' }] } },
    ];
    project.current = 0;
    expect(project.shared().prefabs.Crate).toEqual(before);
    expect(project.savedCopies('Crate')).toBe(2); // level One is live in the editor

    const after = { ...before, material: { color: '#00ff00' } };
    expect(project.updatePrefabCopies('Crate', before, after)).toBe(2);
    expect(project.levels[1].data.entities.every((d) => d.material.color === '#00ff00')).toBe(true);
    expect(project.levels[0].data.entities[0].material.color).toBe('#aa7744'); // the editor's job
  });
});
