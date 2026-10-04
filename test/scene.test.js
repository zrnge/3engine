// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneSerializer } from '../src/scene.js';
import { CAMERA_DEFAULTS } from '../src/cameras.js';
import { LightEntity } from '../src/editor.js';
import { Entity } from '../src/entity.js';
import { Player } from '../src/player.js';
import { RigidBody, PhysicsWorld } from '../src/physics.js';
import { BehaviorRunner } from '../src/behavior.js';
import { assetStore } from '../src/assets-db.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';
import { presetSfx } from '../src/sfx.js';

// Decoding an image needs a real browser. Stand in a texture that carries the
// same identity (name + asset id), which is all the serializer relies on.
vi.mock('../src/factories.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { Texture } = await import('three');
  return {
    ...actual,
    loadStoredTexture: vi.fn(async ({ assetId, name } = {}) => {
      const texture = new Texture();
      texture.name = name;
      texture.userData.assetId = assetId;
      return texture;
    }),
    applyStoredTexture: vi.fn(async (material, { assetId, name } = {}) => {
      const texture = new Texture();
      texture.name = name;
      texture.userData.assetId = assetId;
      material.map = texture;
      return texture;
    }),
  };
});

/** Minimal stand-ins — the real Engine needs WebGL and the editor needs panels. */
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
    playerEntity: null,
    add(e) {
      if (!this.entities.includes(e)) this.entities.push(e);
      if (e.parent) e.parent.object3D.add(e.object3D); else scene.add(e.object3D);
      physics.register(e);
      return e;
    },
    remove(e) {
      const i = this.entities.indexOf(e);
      if (i !== -1) this.entities.splice(i, 1);
      physics.unregister(e);
      behaviors.remove(e);
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
    ...CAMERA_DEFAULTS, // every setting a real rig starts with
    mode: 'orbit', target: null, theta: 0.7, phi: 1, distance: 14,
    lookAt: new THREE.Vector3(), followOffset: 6, followHeight: 3, followLerp: 8,
    followLookUp: 1, rotateWithTarget: true,
    setMode(mode, opts = {}) { this.mode = mode; this.target = opts.target ?? null; },
    setTarget(t) { this.target = t; },
    setFov() {},
  };

  const assets = {
    load: vi.fn(async (url, { name } = {}) => {
      const g = new THREE.Group();
      g.name = name || 'model';
      g.userData.assetUrl = url;
      return g;
    }),
    loadFromStore: vi.fn(async (id, { name } = {}) => {
      const g = new THREE.Group();
      g.name = name || 'model';
      g.userData.assetId = id;
      return g;
    }),
  };

  const player = engine.add(new Player());
  const serializer = new SceneSerializer(engine, editor, rig, player, assets);
  return { engine, editor, rig, player, assets, serializer, behaviors };
}

/** Register a primitive prop with the editor and engine. */
function addBox(h, name, { x = 0, y = 0, z = 0, color = 0x539bf5 } = {}) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 1.5, 1.5),
    new THREE.MeshStandardMaterial({ color })
  );
  mesh.name = name;
  mesh.position.set(x, y, z);
  const e = new Entity(mesh);
  h.engine.add(e);
  h.editor.register(e);
  return e;
}

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe('SceneSerializer round-trip', () => {
  it('restores primitives with their transform and material', async () => {
    const h = harness();
    const box = addBox(h, 'Crate', { x: 2, y: 1, z: -3, color: 0xff8800 });
    box.object3D.rotation.y = 0.5;
    box.object3D.scale.set(2, 2, 2);

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    await h.serializer.deserialize(json);

    const restored = h.editor.selectables.find((e) => e.object3D.name === 'Crate');
    expect(restored).toBeDefined();
    expect(restored.object3D.position.toArray()).toEqual([2, 1, -3]);
    expect(restored.object3D.rotation.y).toBeCloseTo(0.5, 3);
    expect(restored.object3D.scale.x).toBeCloseTo(2, 6);
    expect(restored.object3D.material.color.getHexString()).toBe('ff8800');
  });

  it('restores lights with colour, intensity and shadow flag', async () => {
    const h = harness();
    const light = new THREE.PointLight(0x00ff99, 3.5, 25);
    light.castShadow = true;
    light.position.set(1, 5, 2);
    const entity = new LightEntity(light, 'Key Light');
    h.engine.add(entity);
    h.editor.register(entity);

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    await h.serializer.deserialize(json);

    const restored = h.editor.selectables.find((e) => e.object3D.isPointLight);
    expect(restored.object3D.color.getHexString()).toBe('00ff99');
    expect(restored.object3D.intensity).toBeCloseTo(3.5, 3);
    expect(restored.object3D.castShadow).toBe(true);
    expect(restored.object3D.position.toArray()).toEqual([1, 5, 2]);
  });

  it('restores a light probe: its box (scale) and its strength', async () => {
    const h = harness();
    const { makeProbe, isProbe } = await import('../src/probes.js');
    const probe = makeProbe({ name: 'Kitchen probe', intensity: 0.6 });
    probe.object3D.position.set(3, 1.5, -2);
    probe.object3D.scale.set(5, 3, 4);
    h.engine.add(probe);
    h.editor.register(probe);
    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    expect(json.entities.find((e) => e.name === 'Kitchen probe')).toMatchObject({ type: 'probe', intensity: 0.6 });
    await h.serializer.deserialize(json);
    const restored = h.editor.selectables.find((e) => isProbe(e.object3D));
    expect(restored.object3D.name).toBe('Kitchen probe');
    expect(restored.object3D.scale.toArray()).toEqual([5, 3, 4]);
    expect(restored.object3D.position.toArray()).toEqual([3, 1.5, -2]);
    expect(restored.object3D.userData.probe.intensity).toBe(0.6);
  });

  it('restores rigid bodies and behavior scripts', async () => {
    const h = harness();
    const box = addBox(h, 'Mover');
    box.rigidBody = new RigidBody({ type: 'dynamic', mass: 12, restitution: 0.4, friction: 0.3, tumbles: true });
    h.engine.physics.register(box);
    box.behavior = 'entity.rotation.y += delta';

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    await h.serializer.deserialize(json);

    const restored = h.editor.selectables.find((e) => e.object3D.name === 'Mover');
    expect(restored.rigidBody.type).toBe('dynamic');
    expect(restored.rigidBody.mass).toBeCloseTo(12, 6);
    expect(restored.rigidBody.restitution).toBeCloseTo(0.4, 6);
    expect(restored.rigidBody.tumbles).toBe(true); // rolls and topples after a reload too
    expect(restored.behavior).toBe('entity.rotation.y += delta');
    expect(h.behaviors.get(restored)).not.toBeNull();
  });

  it('keeps an imported model by asset id instead of dropping it', async () => {
    // REGRESSION: models imported from disk were held as blob: URLs and skipped
    // by the serializer, so every save and every Play -> Stop deleted them.
    const h = harness();
    const group = new THREE.Group();
    group.name = 'Duck';
    group.userData.assetId = 'abc123';
    group.position.set(4, 0, 4);
    const entity = new Entity(group);
    h.engine.add(entity);
    h.editor.register(entity);

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    const record = json.entities.find((e) => e.name === 'Duck');
    expect(record).toBeDefined();
    expect(record.type).toBe('model');
    expect(record.assetId).toBe('abc123');

    await h.serializer.deserialize(json);
    expect(h.assets.loadFromStore).toHaveBeenCalledWith('abc123', expect.anything());
    const restored = h.editor.selectables.find((e) => e.object3D.name === 'Duck');
    expect(restored.object3D.position.toArray()).toEqual([4, 0, 4]);
  });

  it('keeps a sound by asset id instead of dropping it', async () => {
    // REGRESSION: sounds serialized no URL at all, and restore fetched the
    // filename as a path — so audio never survived a save or a Play -> Stop.
    const h = harness();
    const box = addBox(h, 'Speaker');
    h.engine.addSound(box, null, {
      name: 'boom.wav', assetId: 'snd-9', type: 'positional',
      volume: 0.5, loop: true, autoplay: false, refDistance: 5, trigger: 'fire',
    });

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    const record = json.entities.find((e) => e.name === 'Speaker');
    expect(record.sounds).toHaveLength(1);
    expect(record.sounds[0].assetId).toBe('snd-9');
    expect(record.sounds[0].trigger).toBe('fire');
    expect(record.sounds[0].volume).toBeCloseTo(0.5, 6);
  });

  it('restores components, rules and variables', async () => {
    const h = harness();
    const coin = addBox(h, 'Coin');
    h.engine.gameplay.components.add(coin, 'collectible', { variable: 'score', amount: 7 });
    h.engine.gameplay.rules.setFor(coin, [{
      when: { type: 'triggerEnter', who: 'player' },
      if: [{ type: 'variable', name: 'score', op: '>=', value: 3 }],
      do: [{ type: 'win', message: 'Done' }],
    }]);
    h.engine.variables.define('score', 0);
    h.engine.variables.define('lives', 3);

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    expect(json.variables).toEqual({ score: 0, lives: 3 });

    await h.serializer.deserialize(json);

    const restored = h.editor.selectables.find((e) => e.object3D.name === 'Coin');
    const comps = h.engine.gameplay.components.listFor(restored);
    expect(comps).toHaveLength(1);
    expect(comps[0].type).toBe('collectible');
    expect(comps[0].props.amount).toBe(7);

    const rules = h.engine.gameplay.rules.listFor(restored);
    expect(rules).toHaveLength(1);
    expect(rules[0].when.type).toBe('triggerEnter');
    expect(rules[0].do[0]).toEqual({ type: 'win', message: 'Done' });
    expect(h.engine.variables.get('lives')).toBe(3);
  });

  it('keeps a rigid body a trigger across save and load', async () => {
    // REGRESSION: isTrigger was not serialized, so every pickup and checkpoint
    // silently turned solid on reload and on Play -> Stop.
    const h = harness();
    const zone = addBox(h, 'Zone');
    zone.rigidBody = new RigidBody({ type: 'static', isTrigger: true });
    h.engine.physics.register(zone);

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    expect(json.entities.find((e) => e.name === 'Zone').rigidBody.isTrigger).toBe(true);

    await h.serializer.deserialize(json);
    const restored = h.editor.selectables.find((e) => e.object3D.name === 'Zone');
    expect(restored.rigidBody.isTrigger).toBe(true);
  });

  it('keeps a texture by asset id, and the colour it replaced', async () => {
    // REGRESSION: textures were not serialized, so every save, reload and
    // Play -> Stop stripped them off.
    const h = harness();
    const crate = addBox(h, 'Crate', { color: 0xe0601a });
    const mat = crate.object3D.material;
    const texture = new THREE.Texture();
    texture.name = 'bricks.jpg';
    texture.userData.assetId = 'tex-1';
    mat.map = texture;
    mat.userData.baseColor = 0xe0601a;
    mat.color.set(0xffffff);

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    const record = json.entities.find((e) => e.name === 'Crate').material;
    expect(record.maps.map).toEqual({ assetId: 'tex-1', name: 'bricks.jpg' });
    expect(record.color).toBe('#ffffff');
    expect(record.baseColor).toBe('#e0601a');

    await h.serializer.deserialize(json);
    const restored = h.editor.selectables.find((e) => e.object3D.name === 'Crate').object3D.material;
    expect(restored.map?.userData.assetId).toBe('tex-1');
    expect(restored.color.getHexString()).toBe('ffffff');
    expect(restored.userData.baseColor).toBe(0xe0601a);
  });

  it('keeps every texture slot, placement setting and shared library material', async () => {
    const { withMadeTexture, materialSpec } = await import('../src/materials.js');
    const h = harness();
    const wall = addBox(h, 'Wall');
    const floor = addBox(h, 'Floor');
    const { applyMaterialSpec } = await import('../src/materials.js');
    await applyMaterialSpec(wall.object3D.material, {
      ...withMadeTexture({ color: '#ffffff' }, { pattern: 'bricks', seed: 9, size: 64 }),
      maps: {
        ...withMadeTexture({}, { pattern: 'bricks', seed: 9, size: 64 }).maps,
        orm: { assetId: 'orm-7', name: 'wall_arm.png' },
      },
      uv: { repeat: [3, 1], worldScale: true, tileSize: 2, filter: 'pixel' },
      library: 'Brick wall',
    });
    h.engine.materialLibrary.set('Brick wall', wall.object3D.material);
    floor.object3D.material = wall.object3D.material; // "use library material"
    const before = materialSpec(wall.object3D.material);

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    expect(json.entities.find((e) => e.name === 'Wall').material.maps.map.procedural.pattern).toBe('bricks');
    await h.serializer.deserialize(json);

    const w = h.editor.selectables.find((e) => e.object3D.name === 'Wall').object3D.material;
    const f = h.editor.selectables.find((e) => e.object3D.name === 'Floor').object3D.material;
    expect(f).toBe(w); // still one shared material
    expect(h.engine.materialLibrary.get('Brick wall')).toBe(w);
    expect(materialSpec(w)).toEqual(before);
    expect(w.roughnessMap.userData.assetId).toBe('orm-7');
  });

  it('opens every template through the real loader', async () => {
    const { TEMPLATES } = await import('../src/templates.js');
    const { Project } = await import('../src/project.js');
    for (const t of TEMPLATES) {
      const h = harness();
      const game = t.build();
      const project = new Project(h.serializer);
      await project.load(game);
      const first = game.levels[0].scene;
      expect(h.editor.selectables.length, t.id).toBe(first.entities.length);
      expect(h.player.target?.object3D.name, t.id).toBe('Player');
      expect(h.engine.gameplay.controls.list.length, t.id).toBe(game.shared.controls.length);
      expect(h.engine.variables.toJSON(), t.id).toEqual(game.shared.variables);
      expect(h.rig.playMode, t.id).toBe(first.camera.playMode ?? null);
      // saving it again keeps what the template set up
      const again = h.serializer.serialize();
      expect(again.camera.playMode, t.id).toBe(first.camera.playMode ?? undefined);
      expect(again.entities.length, t.id).toBe(first.entities.length);
    }
  });

  it('restores parent/child relationships by index', async () => {
    const h = harness();
    const parent = addBox(h, 'Rig', { x: 5 });
    const child = addBox(h, 'Wheel');
    child.setParent(parent, h.engine);

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    await h.serializer.deserialize(json);

    const restoredChild = h.editor.selectables.find((e) => e.object3D.name === 'Wheel');
    const restoredParent = h.editor.selectables.find((e) => e.object3D.name === 'Rig');
    expect(restoredChild.parent).toBe(restoredParent);
    expect(restoredChild.object3D.parent).toBe(restoredParent.object3D);
  });

  it('saves every camera setting — including the ones that used to be dropped', async () => {
    const h = harness();
    Object.assign(h.rig, { followLookAhead: 2.5, orbitHeight: 3, followLockY: true, eyeHeight: 1.6, flySpeed: 25, fovFps: 90 });
    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    const h2 = harness();
    await h2.serializer.deserialize(json);
    expect(h2.rig).toMatchObject({ followLookAhead: 2.5, orbitHeight: 3, followLockY: true, eyeHeight: 1.6, flySpeed: 25, fovFps: 90 });
  });

  it('a camera setting a file leaves out starts from its default, not from the game opened before', async () => {
    const h = harness();
    h.rig.eyeHeight = 3.3; // the previous game's
    await h.serializer.deserialize({ version: 1, entities: [], camera: { mode: 'orbit', target: -1 } });
    expect(h.rig.eyeHeight).toBe(1.1);
  });

  it('opens camera settings saved by older versions (one field of view for every camera)', async () => {
    const h = harness();
    await h.serializer.deserialize({
      version: 1, entities: [],
      camera: { mode: 'orbit', target: -1, fov: 75, followOffset: 9, followHeight: 2, rotateWithTarget: false },
    });
    expect(h.rig).toMatchObject({ followOffset: 9, followHeight: 2, rotateWithTarget: false,
      fovOrbit: 75, fovFollow: 75, fovFps: 75, fovFly: 75 });
  });

  it('children keep their place, however their parents are moved, turned and scaled', async () => {
    // REGRESSION: a child is saved relative to its parent, but was rebuilt as if
    // that were a world position and re-parented keeping it — so every save,
    // Play -> Stop and level switch moved children by their parent's offset
    const h = harness();
    const wheel = addBox(h, 'Wheel');     // listed first: its parent does not exist yet on load
    const bolt = addBox(h, 'Bolt');
    const car = addBox(h, 'Car', { x: 10, y: 1 });
    car.object3D.rotation.set(0, Math.PI / 3, 0.2);
    car.object3D.scale.set(2, 1, 1.5);
    wheel.object3D.position.set(13, 0.5, 2);
    wheel.object3D.rotation.set(Math.PI / 2, 0, 0);
    bolt.object3D.position.set(13.2, 0.9, 2.1);
    wheel.setParent(car, h.engine);
    bolt.setParent(wheel, h.engine);
    const world = (name) => {
      const o = h.editor.selectables.find((e) => e.object3D.name === name).object3D;
      o.updateWorldMatrix(true, false);
      return o.matrixWorld.toArray();
    };
    const snap = () => ({ wheel: world('Wheel'), bolt: world('Bolt') });
    const reload = async () => {
      await h.serializer.deserialize(JSON.parse(JSON.stringify(h.serializer.serialize())));
    };
    const before = snap();
    await reload();
    const once = snap();
    await reload();
    await reload();
    const thrice = snap();

    for (const name of ['wheel', 'bolt']) {
      // where it stands (the matrix's translation) — saved to the millimetre
      for (const i of [12, 13, 14]) expect(once[name][i], `${name} position`).toBeCloseTo(before[name][i], 2);
      // its turn and size, within the file's rounding
      for (let i = 0; i < 12; i++) expect(Math.abs(once[name][i] - before[name][i]), `${name}[${i}]`).toBeLessThan(0.01);
      // and nothing adds up: drift used to grow with every reload
      thrice[name].forEach((v, i) => expect(v, `${name}[${i}] drifted`).toBeCloseTo(once[name][i], 3));
    }
    const bolt2 = h.editor.selectables.find((e) => e.object3D.name === 'Bolt');
    expect(bolt2.parent.object3D.name).toBe('Wheel');
  });

  it('keeps index alignment when an entity fails to rebuild', async () => {
    // a missing model must not shift the indices that parenting relies on
    const h = harness();
    h.assets.loadFromStore.mockRejectedValueOnce(new Error('asset gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const json = {
      version: 1,
      camera: { mode: 'orbit', target: -1 },
      player: { enabled: true, target: -1, controls: {} },
      entities: [
        { type: 'model', assetId: 'missing', name: 'Ghost', parent: -1 },
        { type: 'primitive', primitive: 'box', name: 'Parent', parent: -1 },
        { type: 'primitive', primitive: 'box', name: 'Child', parent: 1 },
      ],
    };
    await h.serializer.deserialize(json);

    const child = h.editor.selectables.find((e) => e.object3D.name === 'Child');
    const parent = h.editor.selectables.find((e) => e.object3D.name === 'Parent');
    expect(child.parent).toBe(parent);
    expect(h.editor.selectables.some((e) => e.object3D.name === 'Ghost')).toBe(false);
    warn.mockRestore();
  });

  it('keeps parent, camera target and player on the right objects when one object can\'t be saved', async () => {
    // REGRESSION: links were saved as places among ALL objects, but an object
    // that can't be saved is left out of the file — so every link after it
    // pointed at its neighbour
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const odd = new Entity(new THREE.Group()); // nothing the saver can rebuild
    odd.object3D.name = 'Unsaveable';
    h.engine.add(odd);
    h.editor.register(odd);
    const car = addBox(h, 'Car', { x: 4 });
    const wheel = addBox(h, 'Wheel');
    wheel.setParent(car, h.engine);
    h.rig.target = car.object3D;
    h.player.target = wheel;

    const data = JSON.parse(JSON.stringify(h.serializer.serialize()));
    expect(data.entities.map((d) => d.name)).toEqual(['Car', 'Wheel']);

    const h2 = harness();
    await h2.serializer.deserialize(data);
    const find = (name) => h2.editor.selectables.find((e) => e.object3D.name === name);
    expect(find('Wheel').parent).toBe(find('Car'));
    expect(h2.rig.target).toBe(find('Car').object3D);
    expect(h2.player.target).toBe(find('Wheel'));
    warn.mockRestore();
  });

  it('an object saved as Solid — from when that only drew a red box — loads with a body that blocks', async () => {
    // REGRESSION: "Solid (blocks player)" set a flag nothing read: the player walked through it
    const h = harness();
    await h.serializer.deserialize({
      version: 1,
      entities: [
        { type: 'primitive', primitive: 'box', name: 'Wall', solid: true },
        { type: 'model', assetId: 'court', name: 'Court', solid: true },
        { type: 'primitive', primitive: 'box', name: 'Crate', solid: true, rigidBody: { type: 'dynamic', mass: 2 } },
      ],
    });
    const find = (name) => h.editor.selectables.find((e) => e.object3D.name === name);
    expect(find('Wall').rigidBody).toMatchObject({ type: 'static', shape: 'auto', isTrigger: false });
    expect(find('Court').rigidBody).toMatchObject({ type: 'static', shape: 'mesh' }); // a model: its real shape
    expect(find('Crate').rigidBody.type).toBe('dynamic'); // a body of its own wins
    expect(h.engine.physics.bodyFor(find('Wall'))).toBe(find('Wall').rigidBody);
    // and saved again, it is the body that says so
    const again = JSON.parse(JSON.stringify(h.serializer.serialize()));
    expect(again.entities[0]).toMatchObject({ solid: false, rigidBody: { type: 'static' } });
  });

  it('Play → Stop (a reload) puts the hidden stand-in player back where it starts, standing still', async () => {
    // REGRESSION: it is in no save, so it stayed wherever the game had left it —
    // and a first-person view started from there
    const h = harness();
    const data = JSON.parse(JSON.stringify(h.serializer.serialize()));
    h.player.object3D.position.set(40, -12, 7); // walked off and fell during play
    h.player.object3D.rotation.y = 2;
    h.player.rigidBody.velocity.set(0, -30, 0);
    await h.serializer.deserialize(data);
    expect(h.player.object3D.position.toArray()).toEqual([0, 1.5, 0]);
    expect(h.player.object3D.rotation.y).toBe(0);
    expect(h.player.rigidBody.velocity.toArray()).toEqual([0, 0, 0]);
  });

  it('keeps a body\'s own gravity (a floating ghost, a moon jump) — the usual one isn\'t written', async () => {
    const h = harness();
    const ghost = addBox(h, 'Ghost');
    ghost.rigidBody = new RigidBody({ type: 'dynamic', gravity: 0 });
    const rock = addBox(h, 'Rock');
    rock.rigidBody = new RigidBody({ type: 'dynamic' });
    const data = JSON.parse(JSON.stringify(h.serializer.serialize()));
    expect(data.entities[0].rigidBody.gravity).toBe(0);
    expect(data.entities[1].rigidBody.gravity).toBeUndefined();
    const h2 = harness();
    await h2.serializer.deserialize(data);
    expect(h2.editor.selectables.map((e) => e.rigidBody.gravity)).toEqual([0, -24]);
  });

  it('keeps a tiny scale: a model made in millimetres does not vanish on reload', async () => {
    // REGRESSION: scale was rounded to 3 decimals, so 0.0004 was saved as 0
    const h = harness();
    addBox(h, 'Tiny').object3D.scale.set(0.0004, 0.00125, 2.5);
    const data = JSON.parse(JSON.stringify(h.serializer.serialize()));
    expect(data.entities[0].scale).toEqual([0.0004, 0.00125, 2.5]);

    const h2 = harness();
    await h2.serializer.deserialize(data);
    expect(h2.editor.selectables[0].object3D.scale.toArray()).toEqual([0.0004, 0.00125, 2.5]);
  });

  it('saves sound-maker sounds as settings and re-makes them on load, no file needed', async () => {
    const h = harness();
    const chest = addBox(h, 'Chest');
    h.engine.addSound(chest, null, {
      name: 'coin', synth: presetSfx('coin', 7), type: 'positional', bus: 'effects',
      volume: 0.4, overlap: true, pitchVary: 0.1,
    });
    h.engine.addSound(null, null, {
      name: 'wind', synth: presetSfx('wind', 3), type: 'global', bus: 'ambience', loop: true, autoplay: true,
    });

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    expect(json.sceneSounds).toEqual([expect.objectContaining({ name: 'wind', bus: 'ambience', loop: true, autoplay: true })]);
    const saved = json.entities.find((e) => e.name === 'Chest').sounds[0];
    expect(saved.synth.preset).toBe('coin');
    expect(saved.assetId).toBeUndefined();

    await h.serializer.deserialize(json);
    const coin = h.engine.sounds.find((s) => s.name === 'coin');
    expect(coin.entity.object3D.name).toBe('Chest');
    expect(coin.synth).toEqual(presetSfx('coin', 7));
    expect(coin.pitchVary).toBeCloseTo(0.1, 6);
    expect(coin.overlap).toBe(true);
    const wind = h.engine.sounds.find((s) => s.name === 'wind');
    expect(wind.entity).toBeNull();
    expect(wind.bus).toBe('ambience');
  });

  it('restores the controls and which object is the player', async () => {
    const h = harness();
    const controls = [
      { inputs: [{ type: 'key', code: 'KeyJ' }, { type: 'screen', label: 'Up' }], target: 'player',
        action: { type: 'jump', strength: 7, sound: 'boing' } },
      { inputs: [{ type: 'mouse', button: 'right' }], target: 'Hero',
        action: { type: 'move', direction: 'left', speed: 13.5, relative: 'camera', face: false } },
    ];
    h.engine.gameplay.controls.load(controls);
    addBox(h, 'Hero');
    h.player.target = h.editor.selectables.find((e) => e.object3D.name === 'Hero');

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    h.engine.gameplay.controls.load([]);
    h.player.target = null;
    await h.serializer.deserialize(json);

    expect(h.engine.gameplay.controls.toJSON()).toEqual(controls);
    expect(h.player.target?.object3D.name).toBe('Hero');
  });

  it('turns an old scene\'s fixed key map into controls', async () => {
    const h = harness();
    await h.serializer.deserialize({
      version: 1,
      camera: { mode: 'orbit', target: -1 },
      player: { enabled: true, speed: 11, jumpVelocity: 6, target: -1,
        controls: { forward: ['KeyI'], back: [], left: [], right: [], jump: ['KeyU'], fire: [] } },
      entities: [],
    });
    const list = h.engine.gameplay.controls.list;
    const forward = list.find((c) => c.action.direction === 'forward');
    expect(forward.inputs[0]).toEqual({ type: 'key', code: 'KeyI' });
    expect(forward.action.speed).toBe(11);
    expect(list.find((c) => c.action.type === 'jump').action.strength).toBe(6);
  });

  it('restores the camera rig settings and target', async () => {
    const h = harness();
    const box = addBox(h, 'Follow me');
    h.rig.setMode('follow', { target: box.object3D });
    h.rig.followOffset = 9.5;
    h.rig.followHeight = 4.25;

    const json = JSON.parse(JSON.stringify(h.serializer.serialize()));
    await h.serializer.deserialize(json);

    expect(h.rig.mode).toBe('follow');
    expect(h.rig.followOffset).toBeCloseTo(9.5, 6);
    expect(h.rig.followHeight).toBeCloseTo(4.25, 6);
    expect(h.rig.target?.name).toBe('Follow me');
  });

  it('rejects a scene file from an unknown version', async () => {
    const h = harness();
    await expect(h.serializer.deserialize({ version: 99 })).rejects.toThrow(/version/i);
    await expect(h.serializer.deserialize(null)).rejects.toThrow();
  });

  it('survives a full save -> load -> save cycle unchanged', async () => {
    const h = harness();
    addBox(h, 'A', { x: 1 });
    addBox(h, 'B', { x: -1 });

    const first = JSON.parse(JSON.stringify(h.serializer.serialize()));
    await h.serializer.deserialize(first);
    const second = JSON.parse(JSON.stringify(h.serializer.serialize()));

    // savedAt is a timestamp; everything else must match
    delete first.meta.savedAt;
    delete second.meta.savedAt;
    expect(second).toEqual(first);
  });
});

describe('an object\'s plain settings: one list, the same through save, load, copy and prefabs', async () => {
  const { ENTITY_FIELDS, saveFields } = await import('../src/entity-fields.js');
  const { clipboardMethods } = await import('../src/editor/clipboard.js');
  const { PREFAB_PARTS } = await import('../src/prefabs.js');
  const { firstMesh } = await import('../src/factories.js');
  const { makeGenerated, generatorOf } = await import('../src/generators/generated.js');

  // a value for each — a new setting in the list needs one here, and is then checked everywhere below
  const SAMPLES = {
    groups: ['Enemies', 'Doors'],
    viewModel: { position: [0.2, -0.3, -0.5], rotation: [0, 180, 0], scale: 0.5 },
    physicsParts: { Lid: 'none' },
    flattenGround: true,
  };
  const withAll = (e) => { for (const f of ENTITY_FIELDS) e[f.key] = JSON.parse(JSON.stringify(SAMPLES[f.key])); return e; };
  const editorFor = (h) => Object.assign(Object.create(clipboardMethods), { engine: h.engine, serializer: h.serializer, _firstMesh: firstMesh });

  it('every setting has a sample here', () => {
    for (const f of ENTITY_FIELDS) expect(SAMPLES, f.key).toHaveProperty(f.key);
  });

  it('saved and opened again: every setting comes back', async () => {
    const h = harness();
    withAll(addBox(h, 'Crate'));
    const data = h.serializer.serialize();
    const h2 = harness();
    await h2.serializer.deserialize(data);
    const back = h2.editor.selectables.find((e) => e.object3D.name === 'Crate');
    expect(saveFields(back)).toEqual(saveFields(withAll(new Entity(new THREE.Object3D()))));
  });

  it('copied and pasted (or duplicated): every setting comes with it, a copy of its own', () => {
    const h = harness();
    const src = withAll(addBox(h, 'Crate'));
    const ed = editorFor(h);
    const rec = ed._serializeForClipboard(src);
    const copy = ed._applyExtras(ed._buildSimpleEntity(rec), rec);
    for (const f of ENTITY_FIELDS) expect(copy[f.key], f.key).toEqual(f.save(src));
    copy.groups.push('Changed'); // its own, not the original's
    expect(src.groups).toEqual(SAMPLES.groups);
  });

  it('a prefab part for every setting', () => {
    const keys = Object.values(PREFAB_PARTS).flatMap((p) => p.keys);
    for (const f of ENTITY_FIELDS) expect(keys, f.key).toContain(f.key);
  });

  it('a terrain or a building copies too — made again from its settings (copying one used to do nothing)', () => {
    const h = harness();
    const house = new Entity(makeGenerated('building', { storeys: 2, roof: 'hip' }));
    house.object3D.name = 'House';
    house.flattenGround = true;
    h.engine.add(house);
    h.editor.register(house);
    const ed = editorFor(h);
    const rec = ed._serializeForClipboard(house);
    const copy = ed._applyExtras(ed._buildSimpleEntity(rec), rec);
    expect(generatorOf(copy.object3D)).toEqual(generatorOf(house.object3D));
    expect(copy.object3D.children.map((c) => c.name)).toContain('Stairs 1');
    expect(copy.flattenGround).toBe(true);
  });
});
