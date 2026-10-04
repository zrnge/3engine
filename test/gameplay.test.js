import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Entity } from '../src/entity.js';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { VariableStore, compare } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';
import { COMPONENTS, defaultProps, coerceProp } from '../src/components.js';
import { EVENTS, ACTIONS, CONDITIONS, blankRule } from '../src/rules.js';

/** An engine stub carrying everything the gameplay layer reads. */
function fakeEngine() {
  const engine = {
    entities: [],
    variables: new VariableStore(),
    physics: new PhysicsWorld(),
    input: {
      _down: new Set(), _pressed: new Set(),
      isDown(c) { return this._down.has(c); },
      wasPressed(c) { return this._pressed.has(c); },
    },
    scene: new THREE.Scene(),
    player: null,
    playerEntity: null,
    playEntitySounds: vi.fn(),
    remove(e) {
      const i = this.entities.indexOf(e);
      if (i !== -1) this.entities.splice(i, 1);
      this.physics.unregister(e);
      this.scene.remove(e.object3D);
    },
    addBehavior() {}, removeBehavior() {},
  };
  engine.gameplay = new Gameplay(engine);
  return engine;
}

function obj(name, { x = 0, y = 0, z = 0, size = 1 } = {}) {
  const e = new Entity(new THREE.Mesh(new THREE.BoxGeometry(size, size, size)));
  e.object3D.name = name;
  e.object3D.position.set(x, y, z);
  return e;
}

function addTo(engine, entity, bodyOpts = null) {
  engine.entities.push(entity);
  engine.scene.add(entity.object3D);
  if (bodyOpts) {
    entity.rigidBody = new RigidBody(bodyOpts);
    engine.physics.register(entity);
  }
  return entity;
}

describe('VariableStore', () => {
  it('defines, reads and changes values', () => {
    const v = new VariableStore();
    v.define('score', 0);
    expect(v.get('score')).toBe(0);
    v.change('score', 5);
    v.change('score', -2);
    expect(v.get('score')).toBe(3);
  });

  it('returns a fallback for an unknown name', () => {
    expect(new VariableStore().get('nope', 42)).toBe(42);
  });

  it('notifies listeners only on an actual change', () => {
    const v = new VariableStore({ hp: 3 });
    const seen = [];
    v.onChange((name, value) => seen.push([name, value]));
    v.set('hp', 3);   // no change
    v.set('hp', 2);
    expect(seen).toEqual([['hp', 2]]);
  });

  it('resets to authored values and drops runtime-only names', () => {
    const v = new VariableStore({ score: 0 });
    v.change('score', 10);
    v.set('temp', 'x');
    v.reset();
    expect(v.get('score')).toBe(0);
    expect(v.has('temp')).toBe(false);
  });

  it('ignores non-numeric arithmetic instead of producing NaN', () => {
    const v = new VariableStore({ name: 'bob' });
    v.change('name', 1);
    expect(v.get('name')).toBe('bob');
  });

  it('compares with every operator', () => {
    expect(compare(5, '>=', 5)).toBe(true);
    expect(compare(5, '>', 5)).toBe(false);
    expect(compare(1, '<', 2)).toBe(true);
    expect(compare('a', '==', 'a')).toBe(true);
    expect(compare('a', '!=', 'b')).toBe(true);
    expect(compare(1, 'bogus', 1)).toBe(false);
  });
});

describe('physics triggers', () => {
  it('reports enter, stay and exit for a trigger volume', () => {
    const engine = fakeEngine();
    const zone = addTo(engine, obj('Zone', { size: 2 }), { type: 'static', isTrigger: true });
    const ball = addTo(engine, obj('Ball', { x: 10 }), { type: 'kinematic' });

    engine.physics.step(1 / 60);
    expect(engine.physics.events).toHaveLength(0);

    ball.object3D.position.x = 0;               // move in
    engine.physics.step(1 / 60);
    expect(engine.physics.events.map((e) => e.type)).toEqual(['triggerEnter']);

    engine.physics.step(1 / 60);                // still inside
    expect(engine.physics.events.map((e) => e.type)).toEqual(['triggerStay']);

    ball.object3D.position.x = 10;              // move out
    engine.physics.step(1 / 60);
    expect(engine.physics.events.map((e) => e.type)).toEqual(['triggerExit']);
  });

  it('never blocks movement through a trigger', () => {
    const engine = fakeEngine();
    addTo(engine, obj('Zone', { size: 4 }), { type: 'static', isTrigger: true });
    const ball = addTo(engine, obj('Ball', { y: 0.1 }), { type: 'dynamic', gravity: 0 });

    engine.physics.step(1 / 60);
    // a solid static body would have ejected it; a trigger must not
    expect(ball.object3D.position.y).toBeCloseTo(0.1, 6);
  });

  it('reports collisions between solid bodies', () => {
    const engine = fakeEngine();
    addTo(engine, obj('Ground', { y: -1, size: 10 }), { type: 'static' });
    addTo(engine, obj('Box', { y: 0.2 }), { type: 'dynamic', gravity: -24 });

    engine.physics.step(1 / 60);
    expect(engine.physics.events.some((e) => e.type === 'collisionEnter')).toBe(true);
  });

  it('forgets contacts for an unregistered body', () => {
    const engine = fakeEngine();
    const zone = addTo(engine, obj('Zone', { size: 2 }), { type: 'static', isTrigger: true });
    const ball = addTo(engine, obj('Ball'), { type: 'kinematic' });
    engine.physics.step(1 / 60);
    expect(engine.physics.events).toHaveLength(1);

    engine.physics.unregister(ball);
    engine.physics.step(1 / 60);
    expect(engine.physics.events).toHaveLength(0);
  });
});

describe('components', () => {
  it('fills in defaults and coerces out-of-range props', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Spinner'));
    const c = engine.gameplay.components.add(e, 'rotator', { speed: 99999 });
    expect(c.props.axis).toBe('y');                      // default filled in
    expect(c.props.speed).toBe(COMPONENTS.rotator.props.speed.max); // clamped
  });

  it('rejects an unknown component type', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = fakeEngine();
    expect(engine.gameplay.components.add(addTo(engine, obj('X')), 'nope')).toBeNull();
    warn.mockRestore();
  });

  it('rotator spins the object', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Spinner'));
    engine.gameplay.components.add(e, 'rotator', { axis: 'y', speed: 90 });
    engine.gameplay.start();
    engine.gameplay.update(1, 1);
    expect(e.object3D.rotation.y).toBeCloseTo(Math.PI / 2, 5);
  });

  it('mover ping-pongs around its starting position', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Platform', { x: 5 }));
    engine.gameplay.components.add(e, 'mover', { axis: 'x', distance: 2, speed: 1 });
    engine.gameplay.start();

    engine.gameplay.update(0, Math.PI / 2);   // sin = 1 -> +distance
    expect(e.object3D.position.x).toBeCloseTo(7, 5);
    engine.gameplay.update(0, (3 * Math.PI) / 2); // sin = -1 -> -distance
    expect(e.object3D.position.x).toBeCloseTo(3, 5);
  });

  it('follower moves toward its target and stops at range', () => {
    const engine = fakeEngine();
    const hero = addTo(engine, obj('Hero', { x: 10 }));
    const enemy = addTo(engine, obj('Enemy'));
    engine.gameplay.components.add(enemy, 'follower', { target: 'Hero', speed: 2, stopAt: 1 });
    engine.gameplay.start();

    engine.gameplay.update(1, 1);
    expect(enemy.object3D.position.x).toBeCloseTo(2, 5);

    enemy.object3D.position.x = 9.5; // inside stopAt
    engine.gameplay.update(1, 2);
    expect(enemy.object3D.position.x).toBeCloseTo(9.5, 5);
  });

  it('timer counts down into a variable', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Clock'));
    engine.gameplay.components.add(e, 'timer', { variable: 'time', from: 10, direction: 'down' });
    engine.gameplay.start();
    expect(engine.variables.get('time')).toBe(10);

    for (let i = 0; i < 4; i++) engine.gameplay.update(1, i);
    expect(engine.variables.get('time')).toBe(6);
  });

  it('timer stops at zero rather than going negative', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Clock'));
    engine.gameplay.components.add(e, 'timer', { variable: 't', from: 1, stopAtZero: true });
    engine.gameplay.start();
    for (let i = 0; i < 5; i++) engine.gameplay.update(1, i);
    expect(engine.variables.get('t')).toBe(0);
  });

  it('collectible adds to a variable and removes itself on touch', () => {
    const engine = fakeEngine();
    const hero = addTo(engine, obj('Hero', { x: 10 }), { type: 'dynamic', gravity: 0 });
    engine.player = { target: hero };
    Object.defineProperty(engine, 'playerEntity', { get: () => hero });

    const coin = addTo(engine, obj('Coin'), { type: 'static', isTrigger: true });
    engine.gameplay.components.add(coin, 'collectible', { variable: 'score', amount: 5 });
    engine.gameplay.start();

    hero.object3D.position.x = 0; // walk onto the coin
    engine.physics.step(1 / 60);
    engine.gameplay.update(1 / 60, 1);

    expect(engine.variables.get('score')).toBe(5);
    expect(engine.entities).not.toContain(coin);
  });

  it('collectible ignores anything that is not the named collector', () => {
    const engine = fakeEngine();
    const hero = addTo(engine, obj('Hero', { x: 50 }), { type: 'dynamic', gravity: 0 });
    Object.defineProperty(engine, 'playerEntity', { get: () => hero });
    const rock = addTo(engine, obj('Rock'), { type: 'kinematic' });
    const coin = addTo(engine, obj('Coin'), { type: 'static', isTrigger: true });
    engine.gameplay.components.add(coin, 'collectible', { variable: 'score', who: 'player' });
    engine.gameplay.start();

    engine.physics.step(1 / 60);   // the rock is overlapping the coin
    engine.gameplay.update(1 / 60, 1);
    expect(engine.variables.get('score')).toBe(0);
    expect(engine.entities).toContain(coin);
  });

  it('damager reduces health, respecting its cooldown', () => {
    const engine = fakeEngine();
    const hero = addTo(engine, obj('Hero'), { type: 'dynamic', gravity: 0 });
    Object.defineProperty(engine, 'playerEntity', { get: () => hero });
    engine.gameplay.components.add(hero, 'health', { max: 5, destroyAtZero: false, mirrorTo: 'hp' });

    const spikes = addTo(engine, obj('Spikes'), { type: 'static', isTrigger: true });
    engine.gameplay.components.add(spikes, 'damager', { amount: 2, who: 'player', cooldown: 1 });
    engine.gameplay.start();
    expect(engine.variables.get('hp')).toBe(5);

    engine.physics.step(1 / 60);
    engine.gameplay.update(1 / 60, 0);
    expect(engine.variables.get('hp')).toBe(3);

    engine.physics.step(1 / 60);
    engine.gameplay.update(1 / 60, 0.5);   // inside cooldown
    expect(engine.variables.get('hp')).toBe(3);

    engine.physics.step(1 / 60);
    engine.gameplay.update(1 / 60, 1.6);   // cooldown elapsed
    expect(engine.variables.get('hp')).toBe(1);
  });

  it('health destroys its owner at zero', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Mortal'));
    engine.gameplay.components.add(e, 'health', { max: 2, destroyAtZero: true });
    engine.gameplay.start();

    engine.gameplay.damage(e, 2);
    engine.gameplay.update(1 / 60, 1);
    expect(engine.entities).not.toContain(e);
  });

  it('spawner creates instances up to its cap', () => {
    const engine = fakeEngine();
    const made = [];
    engine.gameplay.spawnPrefab = (name) => {
      const e = obj(`${name}-${made.length}`);
      made.push(e);
      return e;
    };
    const s = addTo(engine, obj('Spawner'));
    engine.gameplay.components.add(s, 'spawner', { prefab: 'Enemy', interval: 1, max: 2 });
    engine.gameplay.start();

    for (let i = 0; i < 6; i++) engine.gameplay.update(1, i);
    expect(made).toHaveLength(2);
  });

  it('a throwing component is disabled rather than run every frame', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const engine = fakeEngine();
    const e = addTo(engine, obj('Bad'));
    const c = engine.gameplay.components.add(e, 'rotator');
    c.def = { ...c.def, update() { throw new Error('boom'); } };

    engine.gameplay.update(1 / 60, 0);
    engine.gameplay.update(1 / 60, 0);
    expect(c.failed).toBe(true);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('exposes a schema for every component so the inspector can render it', () => {
    for (const [type, def] of Object.entries(COMPONENTS)) {
      expect(def.label, `${type} needs a label`).toBeTruthy();
      const props = defaultProps(type);
      for (const [name, schema] of Object.entries(def.props)) {
        expect(schema.type, `${type}.${name} needs a type`).toBeTruthy();
        expect(props[name], `${type}.${name} needs a default`).not.toBeUndefined();
        expect(coerceProp(schema, props[name])).toEqual(props[name]);
      }
    }
  });
});

describe('rules', () => {
  it('fires a start rule once when play begins', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Init'));
    engine.gameplay.rules.setFor(e, [{
      when: { type: 'start' },
      do: [{ type: 'setVariable', name: 'lives', value: 3 }],
    }]);

    engine.gameplay.start();
    expect(engine.variables.get('lives')).toBe(3);

    engine.gameplay.update(1 / 60, 1);
    expect(engine.variables.get('lives')).toBe(3); // not re-fired
  });

  it('runs a timed rule on its interval, not every frame', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Ticker'));
    engine.gameplay.rules.setFor(e, [{
      when: { type: 'update', every: 1 },
      do: [{ type: 'changeVariable', name: 'ticks', by: 1 }],
    }]);
    engine.gameplay.start();

    for (let i = 0; i < 10; i++) engine.gameplay.update(0.25, i * 0.25);
    expect(engine.variables.get('ticks')).toBe(2);
  });

  it('runs a key rule on press', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Shooter'));
    engine.gameplay.rules.setFor(e, [{
      when: { type: 'key', code: 'KeyF', mode: 'pressed' },
      do: [{ type: 'changeVariable', name: 'shots', by: 1 }],
    }]);
    engine.gameplay.start();

    engine.gameplay.update(1 / 60, 0);
    expect(engine.variables.get('shots')).toBe(0);

    engine.input._pressed.add('KeyF');
    engine.gameplay.update(1 / 60, 0);
    expect(engine.variables.get('shots')).toBe(1);
  });

  it('runs a trigger rule and can destroy the other object', () => {
    const engine = fakeEngine();
    const hero = addTo(engine, obj('Hero', { x: 10 }), { type: 'dynamic', gravity: 0 });
    Object.defineProperty(engine, 'playerEntity', { get: () => hero });
    const pad = addTo(engine, obj('Pad'), { type: 'static', isTrigger: true });

    engine.gameplay.rules.setFor(pad, [{
      when: { type: 'triggerEnter', who: 'player' },
      do: [
        { type: 'changeVariable', name: 'score', by: 10 },
        { type: 'destroy', target: 'self' },
      ],
    }]);
    engine.gameplay.start();

    hero.object3D.position.x = 0;
    engine.physics.step(1 / 60);
    engine.gameplay.update(1 / 60, 1);

    expect(engine.variables.get('score')).toBe(10);
    expect(engine.entities).not.toContain(pad);
  });

  it('respects conditions', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Door'));
    engine.variables.define('keys', 0);
    engine.gameplay.rules.setFor(e, [{
      when: { type: 'update', every: 0 },
      if: [{ type: 'variable', name: 'keys', op: '>=', value: 1 }],
      do: [{ type: 'setVariable', name: 'open', value: 1 }],
    }]);
    engine.gameplay.start();

    engine.gameplay.update(1 / 60, 0);
    expect(engine.variables.get('open', 0)).toBe(0);

    engine.variables.set('keys', 1);
    engine.gameplay.update(1 / 60, 0);
    expect(engine.variables.get('open')).toBe(1);
  });

  it('fires a variable rule on the edge, not continuously', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Watcher'));
    engine.variables.define('score', 0);
    engine.gameplay.rules.setFor(e, [{
      when: { type: 'variable', name: 'score', op: '>=', value: 3 },
      do: [{ type: 'changeVariable', name: 'fired', by: 1 }],
    }]);
    engine.gameplay.start();

    engine.variables.set('score', 5);
    engine.gameplay.update(1 / 60, 0);
    engine.gameplay.update(1 / 60, 0);
    engine.gameplay.update(1 / 60, 0);
    expect(engine.variables.get('fired')).toBe(1);
  });

  it('records a win exactly once', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Goal'));
    const onFinish = vi.fn();
    engine.gameplay.onFinish = onFinish;
    engine.gameplay.rules.setFor(e, [{
      when: { type: 'update', every: 0 },
      do: [{ type: 'win', message: 'Nice' }],
    }]);
    engine.gameplay.start();

    engine.gameplay.update(1 / 60, 0);
    engine.gameplay.update(1 / 60, 0);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(engine.gameplay.outcome).toEqual({ result: 'win', message: 'Nice' });
  });

  it('warns about an unknown action instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = fakeEngine();
    const e = addTo(engine, obj('X'));
    engine.gameplay.rules.setFor(e, [{ when: { type: 'start' }, do: [{ type: 'nope' }] }]);
    expect(() => engine.gameplay.start()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('disables a rule whose action throws, reporting it once', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.spyOn(ACTIONS.log, 'run').mockImplementation(() => {
      throw new Error('boom');
    });
    const engine = fakeEngine();
    const e = addTo(engine, obj('X'));
    engine.gameplay.rules.setFor(e, [{
      when: { type: 'update', every: 0 },
      do: [{ type: 'log', message: 'x' }],
    }]);
    engine.gameplay.start();

    engine.gameplay.update(1 / 60, 0);
    engine.gameplay.update(1 / 60, 0);
    engine.gameplay.update(1 / 60, 0);

    expect(engine.gameplay.rules.rules[0].failed).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    run.mockRestore();
    err.mockRestore();
  });

  it('round-trips rules and components as plain JSON', () => {
    const engine = fakeEngine();
    const e = addTo(engine, obj('Thing'));
    engine.gameplay.components.add(e, 'rotator', { speed: 45 });
    engine.gameplay.rules.setFor(e, [blankRule()]);

    const comps = engine.gameplay.components.serializeFor(e);
    const rules = engine.gameplay.rules.serializeFor(e);
    expect(JSON.parse(JSON.stringify(comps))).toEqual(comps);
    expect(JSON.parse(JSON.stringify(rules))).toEqual(rules);
    expect(comps[0]).toEqual({ type: 'rotator', props: { axis: 'y', speed: 45 } });
  });

  it('exposes a schema for every event, action and condition', () => {
    for (const [type, def] of Object.entries(EVENTS)) {
      expect(def.label, `event ${type}`).toBeTruthy();
    }
    for (const [type, def] of Object.entries(ACTIONS)) {
      expect(def.label, `action ${type}`).toBeTruthy();
      expect(typeof def.run, `action ${type} needs run()`).toBe('function');
    }
    for (const [type, def] of Object.entries(CONDITIONS)) {
      expect(typeof def.test, `condition ${type} needs test()`).toBe('function');
    }
  });
});
