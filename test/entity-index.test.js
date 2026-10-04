// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Entity } from '../src/entity.js';
import { EntityIndex } from '../src/entity-index.js';
import { world } from './helpers/world.js';

// The objects by name and by group: found at once, and right as they are renamed, regrouped, removed.

const thing = (name, groups) => {
  const e = new Entity(new THREE.Object3D());
  e.object3D.name = name;
  if (groups) e.groups = groups;
  return e;
};

describe('the index of objects by name and by group', () => {
  it('finds by name and by group, ignoring case', () => {
    const idx = new EntityIndex();
    const a = thing('Robot 1', ['Enemies']);
    const b = thing('robot 1', ['enemies', 'Metal']);
    const c = thing('Crate');
    for (const e of [a, b, c]) idx.add(e);
    expect(idx.named('ROBOT 1')).toEqual([a, b]);
    expect(idx.grouped('Enemies')).toEqual([a, b]);
    expect(idx.grouped('metal')).toEqual([b]);
    expect(idx.named('Nobody')).toEqual([]);
  });

  it('renamed, regrouped: it follows', () => {
    const idx = new EntityIndex();
    const a = thing('Door', ['Doors']);
    idx.add(a);
    a.object3D.name = 'Front door';
    expect(idx.named('Door')).toEqual([]);
    expect(idx.named('front door')).toEqual([a]);
    a.groups = ['Exits'];
    expect(idx.grouped('Doors')).toEqual([]);
    expect(idx.grouped('exits')).toEqual([a]);
    a.groups = undefined;
    expect(idx.grouped('exits')).toEqual([]);
  });

  it('removed, or destroyed: not found; back again (undo): found, and still watched', () => {
    const idx = new EntityIndex();
    const a = thing('Coin', ['Coins']);
    idx.add(a);
    idx.remove(a);
    expect(idx.named('Coin')).toEqual([]);
    a.object3D.name = 'Renamed while gone'; // not in play: nothing to follow
    expect(idx.named('Renamed while gone')).toEqual([]);
    idx.add(a);
    expect(idx.named('Renamed while gone')).toEqual([a]);
    a.alive = false;
    expect(idx.grouped('Coins')).toEqual([]);
  });

  it('the name is still the object\'s own: copied, cloned, saved as before', () => {
    const idx = new EntityIndex();
    const a = thing('Lamp');
    idx.add(a);
    const clone = a.object3D.clone();
    expect(clone.name).toBe('Lamp');
    expect(JSON.parse(JSON.stringify(a.object3D.toJSON())).object.name).toBe('Lamp');
  });

  it('rules find their targets through it — and much faster than looking through every object', () => {
    const w = world();
    const idx = new EntityIndex();
    w.engine.entityIndex = idx;
    const many = [];
    for (let i = 0; i < 5000; i++) {
      const e = thing(`Rock ${i}`, i % 10 === 0 ? ['Tens'] : undefined);
      w.engine.entities.push(e);
      idx.add(e);
      many.push(e);
    }
    const api = w.engine.gameplay.api;
    expect(api.resolveAll('Rock 4321', null, null)).toEqual([many[4321]]);
    expect(api.resolveAll('group:tens', null, null).length).toBe(500);
    expect(api.findObject('rock 17')).toBe(many[17].object3D);
    const time = (fn) => { const t0 = performance.now(); for (let k = 0; k < 300; k++) fn(`Rock ${k}`); return performance.now() - t0; };
    const indexed = time((n) => api.resolveAll(n, null, null));
    w.engine.entityIndex = null;
    const scanned = time((n) => api.resolveAll(n, null, null));
    expect(indexed * 5).toBeLessThan(scanned);
  });
});
