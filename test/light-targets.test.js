// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LightEntity } from '../src/light-entity.js';
import { world } from './helpers/world.js';

// Lights are things rules can reach: by their name, or by a group they are in.

describe('rules and lights', () => {
  it('a group of lamps all go out; one lamp by name flickers back on', () => {
    const w = world();
    const { engine } = w;
    const lamp = (name) => {
      const e = new LightEntity(new THREE.PointLight('#ffb36b', 5, 7), name);
      e.groups = ['Lamps'];
      engine.entities.push(e);
      engine.scene.add(e.object3D);
      return e;
    };
    const a = lamp('Kitchen lamp');
    const b = lamp('Bedroom lamp');
    const bulb = w.add('Bulb', { groups: ['Lamps'] });
    const sw = w.add('Switch');
    engine.gameplay.rules.add(sw, { when: { type: 'key', code: 'KeyL', mode: 'pressed' }, if: [],
      do: [{ type: 'setVisible', target: 'group:Lamps', visible: false }] });
    engine.gameplay.rules.add(sw, { when: { type: 'key', code: 'KeyK', mode: 'pressed' }, if: [],
      do: [{ type: 'setVisible', target: 'Kitchen lamp', visible: true }] });
    engine.gameplay.start();
    w.input.press('KeyL');
    w.step();
    expect([a, b, bulb].map((e) => e.object3D.visible)).toEqual([false, false, false]);
    w.input.press('KeyK');
    w.step();
    expect([a, b].map((e) => e.object3D.visible)).toEqual([true, false]);
  });
});
