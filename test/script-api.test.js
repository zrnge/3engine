// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as THREE from 'three';
import { BehaviorRunner, API_NAMES, scriptLine, compileBehavior } from '../src/behavior.js';
import { scriptApi, SCRIPT_API } from '../src/script-api.js';
import { world } from './helpers/world.js';
import { RigidBody } from '../src/physics.js';

// A script, as the engine runs it: its entity, the scripting API, each frame.
function scripted(code, { setup = null } = {}) {
  const w = world();
  const { engine, add } = w;
  const me = add('Me', { at: [0, 0.5, 0] });
  setup?.(w, me);
  engine.gameplay.start();
  const runner = new BehaviorRunner();
  const errors = [];
  runner.add(me, code, { engine, log: vi.fn(), api: scriptApi(engine, me) });
  // a frame as the engine runs one: physics, gameplay, the scripts — then this frame's input is over
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) {
      engine.time += 1 / 60;
      engine.scene.updateMatrixWorld(true);
      engine.physics.step(1 / 60);
      engine.gameplay.update(1 / 60, engine.time);
      runner.run(1 / 60, engine.time, {}, (b, err) => errors.push(err));
      engine.input.endFrame();
    }
  };
  return { ...w, me, frame, errors, runner };
}

describe('the scripting API', () => {
  it('variables, first and state', () => {
    const { engine, frame, errors } = scripted(`
      if (first) vars.set('score', 10);
      state.frames = (state.frames || 0) + 1;
      vars.change('score', 1);
      vars.set('frames', state.frames);
    `);
    frame(5);
    expect(errors).toEqual([]);
    expect(engine.variables.get('score')).toBe(15);
    expect(engine.variables.get('frames')).toBe(5);
  });

  it('act: any rule action, with this object as "me"', () => {
    const { me, frame } = scripted(`if (first) act('rotate', { y: 90 }); act('scale', { how: 'to', amount: 2 });`);
    frame(3);
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(me.object3D.quaternion).x).toBeCloseTo(1, 5);
    expect(me.object3D.scale.x).toBe(2);
  });

  it('act on a group, find the nearest, find them all', () => {
    const { engine, frame } = scripted(`
      if (!first) return;
      vars.set('nearest', find('group:Coins').position.x);
      vars.set('coins', findAll('group:Coins').length);
      act('setVisible', { target: 'group:Coins', visible: false });
    `, { setup: ({ add }) => { add('C1', { at: [9, 0, 0], groups: ['Coins'] }); add('C2', { at: [3, 0, 0], groups: ['Coins'] }); } });
    frame();
    expect(engine.variables.get('nearest')).toBe(3);
    expect(engine.variables.get('coins')).toBe(2);
    expect(engine.entities.filter((e) => e.groups?.includes('Coins')).every((e) => !e.object3D.visible)).toBe(true);
  });

  it('input: pressed this frame, held, let go', () => {
    const { engine, frame, input } = scripted(`
      if (pressed('KeyE')) vars.change('presses', 1);
      if (held('KeyE')) vars.change('heldFrames', 1);
      if (released('KeyE')) vars.change('releases', 1);
    `);
    input.press('KeyE');
    frame(3);
    input.release('KeyE');
    frame(2);
    expect(engine.variables.get('presses')).toBe(1); // once, not every frame it's held
    expect(engine.variables.get('heldFrames')).toBe(3);
    expect(engine.variables.get('releases')).toBe(1);
  });

  it('distanceTo, raycast, touching', () => {
    const { engine, frame } = scripted(`
      vars.set('d', Math.round(distanceTo('Wall')));
      const hit = raycast(entity, [1, 0, 0], 50);
      vars.set('hitWall', hit && hit.object.name === 'Wall' ? 1 : 0);
      vars.set('touch', touching().length);
    `, {
      setup: ({ add, engine: e }, me) => {
        add('Wall', { at: [6, 0.5, 0], size: [1, 4, 4], body: { type: 'static' } });
        add('Pad', { at: [0, 0.5, 0], size: [2, 1, 2], body: { type: 'static', isTrigger: true } });
        me.rigidBody = new RigidBody({ type: 'dynamic', gravity: 0 });
        e.physics.register(me);
      },
    });
    frame(3);
    expect(engine.variables.get('d')).toBe(6);
    expect(engine.variables.get('hitWall')).toBe(1); // straight through the trigger pad: it blocks nothing
    expect(engine.variables.get('touch')).toBe(1); // standing in the pad
  });

  it('spawn, destroy, message', () => {
    const { engine, frame, me } = scripted(`if (first) { message('Hi'); destroy(); }`);
    frame();
    expect(engine.onMessage).toHaveBeenCalledWith('Hi', expect.anything());
    expect(engine.entities.includes(me)).toBe(false);
  });

  it('an older script\'s own "state" or "player" is its own — not a clash', () => {
    const { engine, frame, errors } = scripted(`
      var state = 5; let player = 'me'; const find = 2;
      vars.set('ok', state + find);
    `);
    frame();
    expect(errors).toEqual([]);
    expect(engine.variables.get('ok')).toBe(7);
  });

  it('an unknown action says so once, and does nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { frame, errors } = scripted(`act('fly away', {});`);
    frame(3);
    expect(errors).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a mistake says which line of the script', () => {
    const fn = compileBehavior('const a = 1;\nconst b = 2;\nnope();');
    let err;
    try { fn.call({}, 0, 0); } catch (e) { err = e; }
    expect(scriptLine(err)).toBe(3);
  });

  it('the types for code editors declare every name a script can use', () => {
    const dts = readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'types', 'tiny3-script.d.ts'), 'utf8');
    const names = new Set([...API_NAMES, ...SCRIPT_API.map(([n]) => n.replace(/\(.*$/, ''))]);
    for (const name of names) {
      expect(dts, name).toMatch(new RegExp(`declare (const|function) ${name}\\b`));
    }
  });
});
