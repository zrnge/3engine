// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { Entity } from '../src/entity.js';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';
import { Input } from '../src/input.js';
import { PlayOverlay } from '../src/play-overlay.js';
import {
  CONTROL_ACTIONS, ACTION_GROUPS, defaultControls, controlsFromLegacy, normalizeControl,
  controlsHint, blankControl, screenInputId, keyLabel,
} from '../src/controls.js';

/** Input with every method the control runtime reads, driven by hand. */
function fakeInput() {
  return {
    _down: new Set(), _pressed: new Set(), _mouseDown: new Set(), _tapped: new Set(),
    _vDown: new Set(), _vPressed: new Set(),
    mouseNDC: { x: 0, y: 0 },
    isDown(c) { return this._down.has(c); },
    wasPressed(c) { return this._pressed.has(c); },
    mouseDown(b) { return this._mouseDown.has(b); },
    mouseTapped(b) { return this._tapped.has(b); },
    virtualDown(id) { return this._vDown.has(id); },
    virtualPressed(id) { return this._vPressed.has(id); },
    hold(...codes) { for (const c of codes) { this._down.add(c); this._pressed.add(c); } },
    endFrame() { this._pressed.clear(); this._tapped.clear(); this._vPressed.clear(); },
    release() {
      for (const s of [this._down, this._pressed, this._mouseDown, this._tapped, this._vDown, this._vPressed]) s.clear();
    },
  };
}

function setup(controls) {
  const engine = {
    entities: [],
    variables: new VariableStore(),
    physics: new PhysicsWorld(),
    input: fakeInput(),
    scene: new THREE.Scene(),
    camera: null,
    hero: null,
    get playerEntity() { return this.hero; },
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
  if (controls) engine.gameplay.controls.load(controls);
  return engine;
}

function add(engine, name, { x = 0, y = 0, z = 0, body = null } = {}) {
  const e = new Entity(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
  e.object3D.name = name;
  e.object3D.position.set(x, y, z);
  engine.entities.push(e);
  engine.scene.add(e.object3D);
  if (body) {
    e.rigidBody = new RigidBody(body);
    engine.physics.register(e);
  }
  return e;
}

function hero(engine, opts = {}) {
  engine.hero = add(engine, 'Hero', { body: { type: 'dynamic', friction: 0, gravity: 0 }, ...opts });
  return engine.hero;
}

function frame(engine, dt = 1 / 60) {
  engine.scene.updateMatrixWorld(true);
  engine.gameplay.update(dt, 0);
  engine.input.endFrame();
}

const key = (code) => ({ type: 'key', code });
const control = (inputs, action, target = 'player') => ({ inputs, target, action });

describe('controls — movement', () => {
  it('a new scene is driven by WASD out of the box', () => {
    const engine = setup();
    const h = hero(engine);
    engine.input.hold('KeyW');
    frame(engine);
    expect(h.rigidBody.velocity.z).toBeLessThan(0); // forward is -Z
    expect(h.rigidBody.velocity.x).toBe(0);
  });

  it('nothing is hardcoded: only the keys in the list do anything', () => {
    const engine = setup([control([key('KeyI')], { type: 'move', direction: 'forward' })]);
    const h = hero(engine);

    engine.input.hold('KeyW');
    frame(engine);
    expect(h.rigidBody.velocity.lengthSq()).toBe(0);

    engine.input.release();
    engine.input.hold('KeyI');
    frame(engine);
    expect(h.rigidBody.velocity.z).toBeLessThan(0);
  });

  it('with no controls at all, input does nothing', () => {
    const engine = setup([]);
    const h = hero(engine);
    engine.input.hold('KeyW', 'Space');
    frame(engine);
    expect(h.rigidBody.velocity.lengthSq()).toBe(0);
  });

  it('diagonals are no faster than straight lines, and the mover faces where it goes', () => {
    const engine = setup();
    const h = hero(engine);
    engine.input.hold('KeyW', 'KeyD');
    for (let i = 0; i < 120; i++) frame(engine);
    const v = h.rigidBody.velocity;
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(8, 3);
    expect(v.x).toBeGreaterThan(0);
    expect(v.z).toBeLessThan(0);
    expect(h.object3D.rotation.y).toBeCloseTo(Math.atan2(1, -1), 5);
  });

  it('brakes when nothing is held', () => {
    const engine = setup();
    const h = hero(engine);
    engine.input.hold('KeyW');
    for (let i = 0; i < 30; i++) frame(engine);
    engine.input.release();
    for (let i = 0; i < 60; i++) frame(engine);
    expect(h.rigidBody.velocity.z).toBe(0);
  });

  it('gives a body-less player a dynamic body, so it falls and collides', () => {
    const engine = setup();
    engine.hero = add(engine, 'Hero');
    engine.input.hold('KeyD');
    frame(engine);
    expect(engine.hero.rigidBody?.type).toBe('dynamic');
    expect(engine.physics.bodyFor(engine.hero)).toBe(engine.hero.rigidBody);
    expect(engine.hero.rigidBody.velocity.x).toBeGreaterThan(0);
  });

  it('slides an ordinary object with no body directly, without adding physics', () => {
    const engine = setup([control([key('KeyL')], { type: 'move', direction: 'right', speed: 6 }, 'Platform')]);
    const platform = add(engine, 'Platform');
    engine.input.hold('KeyL');
    frame(engine, 0.5);
    expect(platform.rigidBody).toBeNull();
    expect(platform.object3D.position.x).toBeCloseTo(3, 6);
  });

  it('moves relative to the camera when asked', () => {
    const engine = setup([control([key('KeyW')], { type: 'move', direction: 'forward', relative: 'camera' })]);
    const h = hero(engine);
    engine.camera = new THREE.PerspectiveCamera();
    engine.camera.lookAt(1, 0, 0); // looking down +X
    engine.input.hold('KeyW');
    frame(engine);
    expect(h.rigidBody.velocity.x).toBeGreaterThan(0);
    expect(Math.abs(h.rigidBody.velocity.z)).toBeLessThan(1e-9);
  });

  it('first person: W walks where the camera looks, and the player faces that way', () => {
    const engine = setup();
    const h = hero(engine);
    engine.camera = new THREE.PerspectiveCamera();
    engine.camera.rotation.set(0, -Math.PI / 2, 0, 'YXZ'); // looking down +X
    engine.camera.updateMatrixWorld(true);
    engine.cameraRig = { mode: 'fps', yaw: -Math.PI / 2 };
    engine.input.hold('KeyW');
    frame(engine);
    expect(h.rigidBody.velocity.x).toBeGreaterThan(0);
    expect(Math.abs(h.rigidBody.velocity.z)).toBeLessThan(1e-9);
    expect(h.object3D.rotation.y).toBeCloseTo(Math.PI / 2, 6); // facing +X, not spun to the movement
  });

  it('first person, the view turned from the body (arms built looking down -Z): play keeps that turn', () => {
    const engine = setup([control([key('KeyW')], { type: 'move', direction: 'forward', relative: 'camera' })]);
    const h = hero(engine);
    engine.camera = new THREE.PerspectiveCamera();
    engine.camera.rotation.set(0, -Math.PI / 2, 0, 'YXZ'); // looking down +X
    engine.camera.updateMatrixWorld(true);
    engine.cameraRig = { mode: 'fps', yaw: -Math.PI / 2, fpsTurn: -180 };
    engine.input.hold('KeyW');
    frame(engine);
    // the body faces -X: its own -Z (where the arms look) is down +X, with the view —
    // it used to be spun to face the view, leaving the arms behind the camera
    expect(Math.abs(h.object3D.rotation.y)).toBeCloseTo(Math.PI / 2, 6);
    expect(Math.sin(h.object3D.rotation.y)).toBeCloseTo(-1, 6);
    expect(h.rigidBody.velocity.x).toBeGreaterThan(0); // W still walks where you look
  });

  it('tank controls: turn, then move relative to itself', () => {
    const engine = setup([
      control([key('KeyA')], { type: 'turn', direction: 'left', speed: 90 }),
      control([key('KeyW')], { type: 'move', direction: 'forward', relative: 'self' }),
    ]);
    const h = hero(engine);
    engine.input.hold('KeyA');
    frame(engine, 1);
    expect(h.object3D.rotation.y).toBeCloseTo(Math.PI / 2, 6); // turned left a quarter

    engine.input.release();
    engine.input.hold('KeyW');
    frame(engine);
    expect(h.rigidBody.velocity.x).toBeGreaterThan(0); // facing +X now
    expect(h.object3D.rotation.y).toBeCloseTo(Math.PI / 2, 6); // self-relative never re-faces
  });

  it('jumps only when grounded, with its own strength, and plays the jump sound', () => {
    const engine = setup([control([key('KeyJ')], { type: 'jump', strength: 12 })]);
    const h = hero(engine);
    h.rigidBody.grounded = false;
    engine.input.hold('KeyJ');
    frame(engine);
    expect(h.rigidBody.velocity.y).toBe(0);

    engine.input.release();
    h.rigidBody.grounded = true;
    engine.input.hold('KeyJ');
    frame(engine);
    expect(h.rigidBody.velocity.y).toBe(12);
    expect(engine.playEntitySounds).toHaveBeenCalledWith(h, { trigger: 'jump' });
  });

  it('can drive any object by name, not just the player', () => {
    const engine = setup([control([key('KeyK')], { type: 'move', direction: 'back', speed: 4 }, 'crate')]);
    const crate = add(engine, 'Crate', { body: { type: 'dynamic', friction: 0, gravity: 0 } });
    engine.input.hold('KeyK');
    frame(engine);
    expect(crate.rigidBody.velocity.z).toBeGreaterThan(0);
  });
});

describe('controls — inputs', () => {
  it('a mouse button held moves; a mouse click (not a drag) fires once', () => {
    const engine = setup([
      control([{ type: 'mouse', button: 'right' }], { type: 'move', direction: 'forward' }),
      control([{ type: 'mouse', button: 'left' }], { type: 'changeVariable', name: 'clicks', by: 1 }),
    ]);
    const h = hero(engine);
    engine.input._mouseDown.add(2);
    frame(engine);
    expect(h.rigidBody.velocity.z).toBeLessThan(0);

    engine.input._mouseDown.add(0); // pressing left alone is not a click yet
    frame(engine);
    expect(engine.variables.get('clicks', 0)).toBe(0);
    engine.input._tapped.add(0);
    frame(engine);
    frame(engine);
    expect(engine.variables.get('clicks', 0)).toBe(1);
  });

  it('an on-screen button works like a key', () => {
    const engine = setup();
    const h = hero(engine);
    // the first default control is "move forward": its keys and pad, then the ▲ button
    const button = engine.gameplay.controls.list[0].inputs.findIndex((i) => i.type === 'screen');
    engine.input._vDown.add(screenInputId(0, button));
    frame(engine);
    expect(h.rigidBody.velocity.z).toBeLessThan(0);
  });

  it('Input tracks on-screen buttons: pressed for one frame, down until released', () => {
    const input = new Input();
    input.setVirtual('b', true);
    expect(input.virtualPressed('b')).toBe(true);
    expect(input.virtualDown('b')).toBe(true);
    input.endFrame();
    expect(input.virtualPressed('b')).toBe(false);
    expect(input.virtualDown('b')).toBe(true);
    input.setVirtual('b', true); // still held: not a new press
    expect(input.virtualPressed('b')).toBe(false);
    input.releaseVirtual();
    expect(input.virtualDown('b')).toBe(false);
  });

  it('one-shot actions fire once per press, not every frame held', () => {
    const engine = setup([control([key('KeyC')], { type: 'changeVariable', name: 'coins', by: 1 })]);
    hero(engine);
    engine.input.hold('KeyC');
    for (let i = 0; i < 10; i++) frame(engine);
    expect(engine.variables.get('coins', 0)).toBe(1);
  });
});

describe('controls — interact and shoot', () => {
  function doorScene(extraRule = {}) {
    const engine = setup([control([key('KeyE')], { type: 'interact', pick: 'nearest', range: 2 })]);
    const h = hero(engine);
    const door = add(engine, 'Door', { x: 5 });
    engine.gameplay.rules.setFor(door, [{
      when: { type: 'interact', who: 'player', prompt: 'Open door', ...extraRule },
      if: [],
      do: [{ type: 'setVariable', name: 'open', value: 1 }],
    }]);
    return { engine, h, door };
  }

  it('runs the nearest object\'s interact rules, only within range', () => {
    const { engine, h } = doorScene();
    engine.input.hold('KeyE');
    frame(engine);
    expect(engine.variables.get('open', 0)).toBe(0); // 4.5 away, range 2

    engine.input.release();
    h.object3D.position.x = 3.8; // 0.7 from the door's face
    engine.input.hold('KeyE');
    frame(engine);
    expect(engine.variables.get('open', 0)).toBe(1);
  });

  it('shows a prompt with the key while something can be interacted with', () => {
    const { engine, h } = doorScene();
    frame(engine);
    expect(engine.gameplay.controls.prompt).toBeNull();
    h.object3D.position.x = 4;
    frame(engine);
    expect(engine.gameplay.controls.prompt).toMatchObject({ key: 'E', text: 'Open door' });
  });

  it('respects who the rule is for', () => {
    const { engine, h } = doorScene({ who: 'Ghost' });
    h.object3D.position.x = 4;
    engine.input.hold('KeyE');
    frame(engine);
    expect(engine.variables.get('open', 0)).toBe(0);
    expect(engine.gameplay.controls.prompt).toBeNull();
  });

  it('can interact with the object under the pointer instead', () => {
    const engine = setup([control([{ type: 'mouse', button: 'left' }], { type: 'interact', pick: 'pointed', range: 0 })]);
    hero(engine);
    const lever = add(engine, 'Lever', { z: -10 });
    add(engine, 'Other', { x: 3 });
    engine.gameplay.rules.setFor(lever, [{
      when: { type: 'interact', who: 'player' }, if: [], do: [{ type: 'setVariable', name: 'pulled', value: 1 }],
    }]);
    engine.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    engine.camera.position.set(0, 0, 5);
    engine.camera.lookAt(0, 0, -10);
    engine.camera.updateMatrixWorld(true);
    engine.input.mouseNDC = { x: 0, y: 0 }; // dead centre: the lever
    engine.input._tapped.add(0);
    frame(engine);
    expect(engine.variables.get('pulled', 0)).toBe(1);
  });

  it('shoots a prefab the way the shooter faces, and removes it after its lifetime', () => {
    const engine = setup([control([key('KeyF')], { type: 'shoot', prefab: 'Bullet', speed: 30, lifetime: 1 })]);
    const h = hero(engine);
    h.object3D.rotation.y = Math.PI / 2; // facing +X
    const spawned = [];
    engine.gameplay.spawnPrefab = (name) => {
      const e = add(engine, `${name}${spawned.length}`);
      spawned.push(e);
      return e;
    };
    engine.input.hold('KeyF');
    frame(engine);
    expect(spawned).toHaveLength(1);
    const shot = spawned[0];
    expect(shot.object3D.position.x).toBeCloseTo(1.2, 6);
    expect(shot.rigidBody.velocity.x).toBeCloseTo(30, 6);
    expect(shot.rigidBody.gravity).toBe(0);

    engine.input.release();
    for (let i = 0; i < 70; i++) frame(engine); // > 1 s
    expect(shot.alive).toBe(false);
    expect(engine.entities).not.toContain(shot);
  });

  it('one broken control is switched off without stopping the others', () => {
    const engine = setup([
      control([key('KeyP')], { type: 'playSound', trigger: 'boom' }),
      control([key('KeyW')], { type: 'move', direction: 'forward' }),
    ]);
    const h = hero(engine);
    engine.playEntitySounds = () => { throw new Error('no audio'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    engine.input.hold('KeyP', 'KeyW');
    frame(engine);
    frame(engine);
    expect(err).toHaveBeenCalledTimes(1);
    expect(h.rigidBody.velocity.z).toBeLessThan(0);
    err.mockRestore();
  });
});

describe('controls — data', () => {
  it('fills in defaults and drops inputs it does not understand', () => {
    const c = normalizeControl({ inputs: [{ type: 'key', code: 'KeyQ' }, { type: 'joystick' }, null], action: { type: 'move' } });
    expect(c.inputs).toEqual([{ type: 'key', code: 'KeyQ' }]);
    expect(c.target).toBe('player');
    expect(c.action).toMatchObject({ type: 'move', direction: 'forward', speed: 8, relative: 'world', face: true });
    expect(normalizeControl({ action: { type: 'nonsense' } }).action.type).toBe('interact');
  });

  it('every action has a label, a group and field schemas', () => {
    for (const [type, def] of Object.entries(CONTROL_ACTIONS)) {
      expect(def.label, type).toBeTruthy();
      expect(ACTION_GROUPS).toContain(def.group);
      expect(typeof def.props).toBe('object');
    }
    expect(CONTROL_ACTIONS.changeVariable.group).toBe('Game'); // borrowed from rules
  });

  it('turns an old scene\'s fixed key map into controls, keeping its tuning', () => {
    const list = controlsFromLegacy({
      speed: 12, jumpVelocity: 7, rotateToMovement: false,
      controls: { forward: ['KeyI'], back: ['KeyK'], left: ['KeyJ'], right: ['KeyL'], jump: ['KeyU'], fire: ['KeyO'] },
    });
    const forward = list.find((c) => c.action.type === 'move' && c.action.direction === 'forward');
    expect(forward.inputs[0]).toEqual({ type: 'key', code: 'KeyI' });
    expect(forward.action).toMatchObject({ speed: 12, face: false });
    expect(list.find((c) => c.action.type === 'jump').action.strength).toBe(7);
    expect(list.find((c) => c.action.type === 'playSound')).toMatchObject({ inputs: [{ type: 'key', code: 'KeyO' }] });
    expect(controlsFromLegacy({ controls: {} })).toEqual(defaultControls());
    expect(controlsFromLegacy(undefined)).toEqual(defaultControls());
  });

  it('describes the keys for a help line', () => {
    expect(controlsHint(defaultControls())).toBe(
      'W/↑ move forward · S/↓ move back · A/← move left · D/→ move right · Space jump');
    expect(keyLabel('KeyE')).toBe('E');
    expect(keyLabel('Digit3')).toBe('3');
    expect(blankControl()).toMatchObject({ inputs: [{ type: 'key', code: 'KeyE' }], action: { type: 'interact' } });
  });
});

describe('PlayOverlay', () => {
  const press = (el, type) => el.dispatchEvent(
    typeof PointerEvent === 'function'
      ? new PointerEvent(type, { bubbles: true, pointerId: 1 })
      : new Event(type, { bubbles: true }));

  it('with the D-pad chosen, puts move buttons on it, the rest on the right, and reports presses', () => {
    const engine = setup();
    engine.input = new Input();
    engine.ui = { touch: { move: 'dpad' } };
    const overlay = new PlayOverlay(engine);
    overlay.show();

    const dpad = document.querySelectorAll('.t3-dpad .t3-touch-btn');
    const actions = document.querySelectorAll('.t3-actions .t3-touch-btn');
    expect([...dpad].map((b) => b.textContent)).toEqual(['▲', '▼', '◀', '▶']);
    expect([...actions].map((b) => b.textContent)).toEqual(['Jump']);

    const up = dpad[0];
    press(up, 'pointerdown');
    expect(engine.input.virtualDown(up.dataset.screenInput)).toBe(true);
    press(up, 'pointerup');
    expect(engine.input.virtualDown(up.dataset.screenInput)).toBe(false);

    press(up, 'pointerdown');
    overlay.hide(); // Stop mid-press must not leave the button stuck down
    expect(engine.input.virtualDown(up.dataset.screenInput)).toBe(false);
    expect(document.querySelector('.t3-touch')).toBeNull();
  });

  it('by default moves with a joystick: part way walks slowly, letting go stops', () => {
    const engine = setup();
    engine.input = new Input();
    const h = hero(engine);
    const overlay = new PlayOverlay(engine);
    overlay.show();
    expect(document.querySelector('.t3-dpad')).toBeNull();
    expect([...document.querySelectorAll('.t3-actions .t3-touch-btn')].map((b) => b.textContent)).toEqual(['Jump']);
    const stick = document.querySelector('.t3-stick');
    stick.getBoundingClientRect = () => ({ left: 0, top: 0, width: 132, height: 132 });
    stick.setPointerCapture = () => {};
    const drag = (type, x, y) => stick.dispatchEvent(
      Object.assign(new Event(type, { bubbles: true }), { pointerId: 7, clientX: x, clientY: y }));
    const speed = () => {
      h.rigidBody.velocity.set(0, 0, 0);
      for (let i = 0; i < 60; i++) frame(engine);
      return -h.rigidBody.velocity.z;
    };
    drag('pointerdown', 66, 66 - 48); // the knob all the way up
    expect(speed()).toBeCloseTo(8, 1);
    drag('pointermove', 66, 66 - 24); // half way
    expect(speed()).toBeGreaterThan(2);
    expect(speed()).toBeLessThan(5);
    drag('pointerup', 66, 66);
    expect(speed()).toBeCloseTo(0, 6);
    overlay.hide();
  });

  it('shows the game\'s variables when asked (exported games), hiding _private ones', () => {
    const engine = setup();
    engine.variables.define('score', 0);
    engine.variables.define('_timer', 3);
    const overlay = new PlayOverlay(engine, { hud: true });
    overlay.show();
    engine.variables.set('score', 12);
    overlay.update();
    const hud = document.querySelector('.t3-hud');
    expect(hud.textContent).toBe('score12');
    overlay.hide();
    expect(document.querySelector('.t3-hud')).toBeNull();
  });

  it('shows the interaction prompt', () => {
    const engine = setup();
    const overlay = new PlayOverlay(engine);
    overlay.show();
    engine.gameplay.controls.prompt = { key: 'E', text: 'Open <door>' };
    overlay.update();
    const el = document.querySelector('.t3-prompt');
    expect(el.classList.contains('show')).toBe(true);
    expect(el.innerHTML).toBe('<b>E</b>Open &lt;door&gt;');
    overlay.hide();
  });
});

describe('gamepads', () => {
  /** A standard-layout pad: 16 buttons, 4 axes. */
  const pad = ({ pressed = [], axes = [0, 0, 0, 0], trigger = 0 } = {}) => ({
    connected: true,
    axes,
    buttons: Array.from({ length: 16 }, (_, i) => ({
      pressed: pressed.includes(i) || (i === 7 && trigger > 0.1),
      value: i === 7 ? trigger : (pressed.includes(i) ? 1 : 0),
    })),
  });
  const withPads = (...pads) => { globalThis.navigator.getGamepads = () => pads; };

  it('buttons and stick directions read like keys; a newly pushed one is pressed for one frame', () => {
    const input = new Input();
    withPads(pad({ pressed: [0], axes: [0, -0.9, 0, 0] }));
    input.poll();
    expect(input.isDown('PadA')).toBe(true);
    expect(input.wasPressed('PadA')).toBe(true);
    expect(input.isDown('PadLStickUp')).toBe(true);
    expect(input.isDown('PadLStickDown')).toBe(false);
    expect(input.keyState.PadA).toBe(true); // behavior scripts see it too
    input.endFrame();
    input.poll();
    expect(input.wasPressed('PadA')).toBe(false); // still held: not a new press
    expect(input.isDown('PadA')).toBe(true);
  });

  it('a stick near the middle counts as let go; part way reads part way', () => {
    const input = new Input();
    withPads(pad({ axes: [0.1, -0.6, 0, 0], trigger: 0.5 }));
    input.poll();
    expect(input.isDown('PadLStickRight')).toBe(false); // inside the dead zone
    expect(input.value('PadLStickUp')).toBeCloseTo(0.5, 5); // (0.6 − 0.2) / 0.8
    expect(input.value('PadRT')).toBeCloseTo(0.5, 5);
    expect(input.value('KeyW')).toBe(0);
    expect(input.stick('left').y).toBeLessThan(-0.4);
  });

  it('the left stick tilted half way walks at half speed', () => {
    const engine = setup(defaultControls());
    const input = new Input();
    engine.input = input;
    const h = hero(engine);
    const speedAt = (tilt) => {
      withPads(pad({ axes: [0, -tilt, 0, 0] }));
      h.rigidBody.velocity.set(0, 0, 0);
      for (let i = 0; i < 60; i++) { input.poll(); frame(engine); }
      return -h.rigidBody.velocity.z;
    };
    expect(speedAt(1)).toBeCloseTo(8, 1);
    expect(speedAt(0.6)).toBeCloseTo(4, 1);
  });

  it('new games take a pad: left stick and D-pad move, A jumps', () => {
    const codes = defaultControls().flatMap((c) => c.inputs.filter((i) => i.type === 'key').map((i) => i.code));
    for (const c of ['PadLStickUp', 'PadLStickDown', 'PadLStickLeft', 'PadLStickRight', 'PadUp', 'PadA']) {
      expect(codes).toContain(c);
    }
    expect(keyLabel('PadA')).toBe('Pad A');
    expect(keyLabel('PadLStickUp')).toBe('Left stick ↑');
  });

  it('the help line keeps to the keyboard (a pad\'s names would crowd it)', () => {
    const hint = controlsHint(defaultControls());
    expect(hint).toContain('W/↑ move forward');
    expect(hint).not.toMatch(/Pad|stick/);
  });

  it('"press what should do it" takes a pad button too', async () => {
    const { captureNextInput } = await import('../src/input.js');
    let frameFn = null;
    globalThis.requestAnimationFrame = (fn) => { frameFn = fn; return 1; };
    globalThis.cancelAnimationFrame = () => {};
    withPads(pad({ pressed: [0] })); // A already held when it starts listening: not the answer
    const got = [];
    captureNextInput((code) => got.push(code));
    frameFn();
    expect(got).toEqual([]);
    withPads(pad({ pressed: [0, 3] })); // then Y
    frameFn();
    expect(got).toEqual(['PadY']);
  });
});
