// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PrefabLibrary, overridesOf, updateSavedCopies } from '../src/prefabs.js';
import { SceneSerializer } from '../src/scene.js';
import { Entity } from '../src/entity.js';
import { Player } from '../src/player.js';
import { PhysicsWorld } from '../src/physics.js';
import { BehaviorRunner } from '../src/behavior.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';
import { inspectorMethods } from '../src/editor/inspector.js';

function harness() {
  const scene = new THREE.Scene();
  const physics = new PhysicsWorld();
  const behaviors = new BehaviorRunner();
  const engine = {
    scene, physics, entities: [], sounds: [], variables: new VariableStore(),
    camera: new THREE.PerspectiveCamera(), materialLibrary: new Map(), prefabs: new PrefabLibrary(), playerEntity: null,
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
      this.gameplay.components.clearEntity(e);
      this.gameplay.rules.clearEntity(e);
      e.object3D.removeFromParent();
    },
    addBehavior: (e, code) => behaviors.add(e, code, { engine }),
    removeBehavior: (e) => behaviors.remove(e),
    addSound() {}, stopAllSounds() {},
  };
  engine.gameplay = new Gameplay(engine);
  const editor = {
    selectables: [], select() {}, _renderHierarchy() {},
    register(e) { if (!this.selectables.includes(e)) this.selectables.push(e); },
    unregister(e) { const i = this.selectables.indexOf(e); if (i !== -1) this.selectables.splice(i, 1); },
  };
  const rig = { mode: 'orbit', target: null, lookAt: new THREE.Vector3(), setMode() {}, setTarget() {}, setFov() {} };
  const player = engine.add(new Player());
  const serializer = new SceneSerializer(engine, editor, rig, player, {});
  engine.gameplay.spawnPrefab = (name, position) => serializer.spawnPrefab(name, position);
  return { engine, editor, serializer, player };
}

/** A box object, registered, at a local place under `parent` (or in the world). */
function box(h, name, { at = [0, 0, 0], parent = null, color = '#888888' } = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), new THREE.MeshStandardMaterial({ color }));
  mesh.name = name;
  const e = new Entity(mesh);
  h.engine.add(e);
  h.editor.register(e);
  if (parent) {
    e.setParent(parent, h.engine);
  }
  mesh.position.set(...at); // its own place: on its parent, if it has one
  return e;
}

/** A car: a body with two wheels and, on the first wheel, a hubcap. */
function car(h) {
  const body = box(h, 'Car', { at: [10, 1, 0], color: '#cc2222' });
  const w1 = box(h, 'Wheel', { at: [1, -0.5, 0.8], parent: body, color: '#111111' });
  box(h, 'Wheel', { at: [-1, -0.5, 0.8], parent: body, color: '#111111' });
  box(h, 'Hubcap', { at: [0, 0, 0.2], parent: w1, color: '#dddddd' });
  return body;
}

const byName = (h, name) => h.editor.selectables.filter((e) => e.object3D.name === name);
const world = (e) => e.object3D.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3));

describe('prefabs with child objects', () => {
  it('a prefab keeps its children — each where it stands on its parent, theirs too', () => {
    const h = harness();
    const rec = h.serializer.prefabRecord(car(h));
    expect(rec.children.map((c) => c.name)).toEqual(['Wheel', 'Wheel']);
    expect(rec.children[0].position).toEqual([1, -0.5, 0.8]);
    expect(rec.children[0].children.map((c) => c.name)).toEqual(['Hubcap']);
    expect(rec.children[0].parent).toBeUndefined();
  });

  it('spawned during play, the whole car comes at once: body, wheels, hubcap, in place', () => {
    const h = harness();
    h.engine.prefabs.set('Car', h.serializer.prefabRecord(car(h)));
    const copy = h.engine.gameplay.spawn('Car', { x: -20, y: 1, z: 5 });
    expect(copy.prefab).toBe('Car');
    expect(copy.children).toHaveLength(2);
    expect(copy.children.every((c) => c.prefabChild)).toBe(true);
    expect(world(copy.children[0])).toEqual([-19, 0.5, 5.8]); // 1, -0.5, 0.8 from where it was spawned
    expect(world(copy.children[0].children[0])).toEqual([-19, 0.5, 6]);
    expect(copy.children[0].object3D.material.color.getHexString()).toBe('111111');
  });

  it('placed in the editor too, and a fresh copy differs from its prefab in nothing', async () => {
    const h = harness();
    h.engine.prefabs.set('Car', h.serializer.prefabRecord(car(h)));
    const copy = await h.serializer.placePrefab('Car', { x: 0, y: 1, z: -8 });
    expect(byName(h, 'Hubcap')).toHaveLength(2);
    expect(overridesOf(h.serializer.entityRecord(copy), h.engine.prefabs.get('Car'))).toEqual([]);
    // painting one wheel of this copy is a change to its child objects
    copy.children[1].object3D.material.color.set('#ffff00');
    expect(overridesOf(h.serializer.entityRecord(copy), h.engine.prefabs.get('Car'))).toEqual(['children']);
  });

  it('something hung on one copy by hand is its own, not a change to the prefab', async () => {
    const h = harness();
    h.engine.prefabs.set('Car', h.serializer.prefabRecord(car(h)));
    const copy = await h.serializer.placePrefab('Car');
    box(h, 'Flag', { at: [0, 2, 0], parent: copy });
    expect(overridesOf(h.serializer.entityRecord(copy), h.engine.prefabs.get('Car'))).toEqual([]);
  });

  it('destroying a copy during play takes its children with it', () => {
    const h = harness();
    h.engine.prefabs.set('Car', h.serializer.prefabRecord(car(h)));
    const n = h.engine.entities.length;
    const copy = h.engine.gameplay.spawn('Car', { x: 0, y: 0, z: 0 });
    expect(h.engine.entities.length).toBe(n + 4);
    h.engine.gameplay.destroy(copy);
    expect(h.engine.entities.length).toBe(n);
  });

  it('saved and loaded, the children still know they came with the prefab', async () => {
    const h = harness();
    h.engine.prefabs.set('Car', h.serializer.prefabRecord(car(h)));
    await h.serializer.placePrefab('Car', { x: 5, y: 1, z: 5 });
    const data = JSON.parse(JSON.stringify(h.serializer.serialize()));
    const h2 = harness();
    await h2.serializer.deserialize(data);
    const copy = h2.editor.selectables.find((e) => e.prefab === 'Car');
    expect(copy.children.map((c) => c.prefabChild)).toEqual([true, true]);
    expect(overridesOf(h2.serializer.entityRecord(copy), h2.engine.prefabs.get('Car'))).toEqual([]);
  });

  it('a level not being edited gets the prefab\'s new children — and every link by place in the list still points right', () => {
    const h = harness();
    const before = h.serializer.prefabRecord(car(h));
    const after = JSON.parse(JSON.stringify(before));
    after.children.push({ ...after.children[1], name: 'Spare', position: [0, 0, -1.5] }); // a third wheel
    const level = {
      version: 1,
      camera: { target: 5 },      // the Lamp, after the copy's family
      player: { target: 5 },
      entities: [
        { type: 'primitive', primitive: 'box', name: 'Car', prefab: 'Car', position: [3, 1, 3], parent: -1 },
        { ...before.children[0], parent: 0, prefabChild: true, children: undefined },
        { ...before.children[0].children[0], parent: 1, prefabChild: true },
        { ...before.children[1], parent: 0, prefabChild: true },
        { type: 'primitive', primitive: 'box', name: 'Flag', parent: 0 }, // hung on by hand
        { type: 'primitive', primitive: 'box', name: 'Lamp', parent: -1 },
      ],
    };
    delete level.entities[1].children;
    expect(updateSavedCopies(level, 'Car', before, after)).toBe(1);
    const names = level.entities.map((d) => d.name);
    expect(names).toEqual(['Car', 'Flag', 'Lamp', 'Wheel', 'Hubcap', 'Wheel', 'Spare']);
    const parentOf = (i) => names[level.entities[i].parent] ?? null;
    expect([1, 2, 3, 4, 5, 6].map(parentOf)).toEqual(['Car', null, 'Car', 'Wheel', 'Car', 'Car']);
    expect(names[level.camera.target]).toBe('Lamp');
    expect(names[level.player.target]).toBe('Lamp');
  });
});

describe('renaming an object — what points at it follows', () => {
  function editorFor(h) {
    return { ...inspectorMethods, engine: h.engine, selectables: h.editor.selectables };
  }

  it('rules, components, controls and prefabs that name it are pointed at the new name — and back on undo', () => {
    const h = harness();
    const door = box(h, 'Door');
    const lever = box(h, 'Lever');
    const guard = box(h, 'Guard');
    const g = h.engine.gameplay;
    g.rules.setFor(lever, [{ when: { type: 'interact', who: 'player' }, if: [], do: [{ type: 'destroy', target: 'Door' }] }]);
    g.components.add(guard, 'follower', { target: 'door' }); // names match whatever their case
    g.controls.load([{ inputs: [{ type: 'key', code: 'KeyO' }], target: 'Door', action: { type: 'setVisible', target: 'self' } }]);
    h.engine.prefabs.set('Key', { type: 'primitive', primitive: 'box', rules: [{ when: { type: 'triggerEnter', who: 'Door' }, do: [] }] });

    door.object3D.name = 'Gate';
    const refs = editorFor(h)._renameReferences(door, 'Door', 'Gate');
    expect(refs.count).toBe(4);
    expect(g.rules.listFor(lever)[0].do[0].target).toBe('Gate');
    expect(g.components.listFor(guard)[0].props.target).toBe('Gate');
    expect(g.controls.list[0].target).toBe('Gate');
    expect(g.controls.list[0].action.target).toBe('self'); // not a name of it
    expect(h.engine.prefabs.get('Key').rules[0].when.who).toBe('Gate');

    refs.undo();
    expect(g.rules.listFor(lever)[0].do[0].target).toBe('Door');
    expect(g.controls.list[0].target).toBe('Door');
    refs.redo();
    expect(g.components.listFor(guard)[0].props.target).toBe('Gate');
  });

  it('not while another object still has the old name: they may mean that one', () => {
    const h = harness();
    const a = box(h, 'Crate');
    box(h, 'Crate');
    const lever = box(h, 'Lever');
    h.engine.gameplay.rules.setFor(lever, [{ when: { type: 'start' }, do: [{ type: 'destroy', target: 'Crate' }] }]);
    a.object3D.name = 'Box';
    expect(editorFor(h)._renameReferences(a, 'Crate', 'Box').count).toBe(0);
    expect(h.engine.gameplay.rules.listFor(lever)[0].do[0].target).toBe('Crate');
  });
});
