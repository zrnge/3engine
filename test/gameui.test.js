// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  normalizeUI, hudItems, hudHtml, hudPlaceCss, normalizeHudLook, HUD_LOOK_DEFAULTS, TITLE_DEFAULTS, CROSSHAIR_DEFAULTS, normalizeCrosshair, crosshairShows, crosshairSvg,
} from '../src/game-ui.js';
import { applyPoses } from '../src/poses.js';
import { COMPONENTS, ComponentRuntime, defaultProps } from '../src/components.js';
import { ACTIONS } from '../src/rules.js';
import { RigidBody } from '../src/physics.js';
import { PlayOverlay } from '../src/play-overlay.js';
import { VariableStore } from '../src/variables.js';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('game UI settings', () => {
  it('fills in a title screen and cleans up HUD styles', () => {
    expect(normalizeUI().title).toEqual({ ...TITLE_DEFAULTS });
    const ui = normalizeUI({
      title: { enabled: 1, text: 'Sky Hopper' },
      hud: { lives: { show: 'hearts', max: 3.4 }, hp: { show: 'bar', max: -5 }, x: { show: 'rainbow' }, y: null },
    });
    expect(ui.title).toMatchObject({ enabled: true, text: 'Sky Hopper', prompt: TITLE_DEFAULTS.prompt });
    expect(ui.hud).toEqual({ lives: { show: 'hearts', max: 3 }, hp: { show: 'bar', max: 1 }, x: { show: 'number' } });
  });

  it('lists what the HUD shows: sorted, _private and hidden ones left out', () => {
    const items = hudItems(
      { score: 4, _timer: 9, lives: 2, secret: 1 },
      { lives: { show: 'hearts', max: 3, label: 'Lives' }, secret: { show: 'hidden' } },
    );
    expect(items).toEqual([
      { name: 'lives', label: 'Lives', show: 'hearts', max: 3, value: 2, at: null, color: null, size: null },
      { name: 'score', label: 'score', show: 'number', max: 3, value: 4, at: null, color: null, size: null },
    ]);
  });

  it('the variables on screen: a look for the game, and a place, colour and size of each one\'s own', () => {
    expect(normalizeUI().hudLook).toEqual({ ...HUD_LOOK_DEFAULTS });
    const look = normalizeHudLook({ at: 'bottom right', size: 400, color: '#FF0000', font: 'comic', opacity: -1, x: 'a', border: 0 });
    expect(look).toMatchObject({ at: 'bottom right', size: 72, color: '#ff0000', font: 'system', opacity: 0, x: 0, border: false });
    expect(normalizeHudLook({ at: 'sideways' }).at).toBe('top center');
    const ui = normalizeUI({ hud: { coins: { show: 'number', at: 'top left', color: '#FFD700', size: 30, noLabel: 1 }, hp: { at: 'nowhere', color: 'red', size: 0 } } });
    expect(ui.hud.coins).toEqual({ show: 'number', at: 'top left', color: '#ffd700', size: 30, noLabel: true });
    expect(ui.hud.hp).toEqual({ show: 'number' }); // nonsense left out: the HUD's own look
    expect(hudItems({ coins: 5 }, ui.hud)[0]).toMatchObject({ label: '', at: 'top left', color: '#ffd700', size: 30 });
  });

  it('draws a box for each place used, in the game\'s look', () => {
    const ui = normalizeUI({
      hudLook: { at: 'top right', size: 20, color: '#112233', labelColor: '#445566', opacity: 0, border: false, upper: false, font: 'mono' },
      hud: { coins: { show: 'number', at: 'bottom left', color: '#ffd700', size: 30 } },
    });
    const host = document.createElement('div');
    host.innerHTML = hudHtml(hudItems({ score: 7, lives: 3, coins: 5 }, ui.hud), ui.hudLook);
    const boxes = [...host.querySelectorAll('.t3-hud-box')];
    expect(boxes.map((b) => b.dataset.at)).toEqual(['bottom left', 'top right']);
    const [coinBox, mainBox] = boxes;
    expect(mainBox.textContent).toBe('lives3score7');
    expect(mainBox.style.right).toContain('var(--t3-hud-right');
    expect(mainBox.style.top).toContain('var(--t3-hud-corner'); // below a game's own buttons up there
    expect(mainBox.style.flexDirection).toBe('column'); // down the side
    expect(mainBox.style.fontFamily).toContain('monospace');
    expect(mainBox.style.background).toBe('transparent');
    expect(mainBox.querySelector('b').style.color).toBe('#112233');
    expect(mainBox.querySelector('b').style.fontSize).toBe('20px');
    expect(mainBox.querySelector('span').style.color).toBe('#445566');
    expect(mainBox.querySelector('span').style.textTransform).toBe('');
    expect(coinBox.style.bottom).toContain('var(--t3-hud-bottom');
    expect(coinBox.style.left).toContain('var(--t3-hud-left');
    expect(coinBox.querySelector('b').style.color).toBe('#ffd700');
    expect(coinBox.querySelector('b').style.fontSize).toBe('30px');
  });

  it('places: nudged right and down, centred ones moved by transform', () => {
    expect(hudPlaceCss('top center', 10, 5)).toBe('top:calc(var(--t3-hud-top, 12px) + 5px);left:50%;transform:translate(calc(-50% + 10px),0px)');
    expect(hudPlaceCss('middle left', 4, -20)).toBe('top:50%;left:calc(var(--t3-hud-left, 12px) + 4px);transform:translate(0px,calc(-50% + -20px))');
    expect(hudPlaceCss('bottom right', 0, 0)).toBe('bottom:calc(var(--t3-hud-bottom, 12px) + var(--t3-hud-clear-right, 0px) - 0px);right:calc(var(--t3-hud-right, 12px) - 0px)');
    expect(hudPlaceCss('bottom center')).toBe('bottom:calc(var(--t3-hud-bottom, 12px) - 0px);left:50%;transform:translate(calc(-50% + 0px),0px)');
  });

  it('Show message goes to whoever draws it', () => {
    const engine = { onMessage: vi.fn() };
    ACTIONS.showMessage.run({ action: { text: 'Hi', seconds: 2, where: 'top' }, engine });
    expect(engine.onMessage).toHaveBeenCalledWith('Hi', { seconds: 2, where: 'top' });
  });
});

describe('poses — animation the physics never sees', () => {
  it('applies a bob, lean and squash, then puts everything back exactly', () => {
    const scene = new THREE.Scene();
    const o = new THREE.Object3D();
    scene.add(o);
    o.position.set(1, 2, 3);
    o.rotation.set(0, 0.7, 0);
    o.scale.set(2, 2, 2);
    const before = { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() };

    const restore = applyPoses(new Map([[o, { y: 0.5, lean: 0.2, sx: 1.1, sy: 0.8, sz: 1.1 }]]));
    expect(o.position.y).toBeCloseTo(2.5, 6);
    expect(o.scale.y).toBeCloseTo(1.6, 6);
    expect(o.quaternion.equals(before.q)).toBe(false);
    restore();
    expect(o.position.equals(before.p)).toBe(true);
    expect(o.quaternion.equals(before.q)).toBe(true);
    expect(o.scale.equals(before.s)).toBe(true);
    expect(o.rotation.y).toBeCloseTo(0.7, 6);
  });

  it('skips objects that have left the scene', () => {
    const lonely = new THREE.Object3D();
    applyPoses(new Map([[lonely, { y: 5 }]]))();
    expect(lonely.position.y).toBe(0);
  });
});

describe('Animator', () => {
  const setup = () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    new THREE.Scene().add(mesh);
    const entity = { object3D: mesh, rigidBody: new RigidBody({ type: 'dynamic' }) };
    const engine = { poses: new Map(), mixers: [] };
    const ctx = { entity, object3D: mesh, props: defaultProps('animator'), state: {}, engine, dt: 1 / 60, time: 0 };
    const step = (n = 1) => { for (let i = 0; i < n; i++) { ctx.time += ctx.dt; COMPONENTS.animator.update(ctx); } };
    return { mesh, entity, engine, ctx, step };
  };

  it('a plain shape bobs and leans while running, and breathes when still', () => {
    const { entity, engine, mesh, step } = setup();
    entity.rigidBody.grounded = true;
    entity.rigidBody.velocity.set(6, 0, 0);
    const ys = [];
    for (let i = 0; i < 30; i++) { step(); ys.push(engine.poses.get(mesh).y); }
    expect(Math.max(...ys)).toBeGreaterThan(0.05);   // bobbing up
    expect(engine.poses.get(mesh).lean).toBeGreaterThan(0.08);
    entity.rigidBody.velocity.set(0, 0, 0);
    step();
    expect(engine.poses.get(mesh).lean).toBe(0);
    expect(Math.abs(engine.poses.get(mesh).sy - 1)).toBeLessThan(0.02); // just breathing
  });

  it('squashes on a hard landing, keeping its feet on the ground', () => {
    const { entity, engine, mesh, step } = setup();
    entity.rigidBody.grounded = false;
    entity.rigidBody.velocity.set(0, -12, 0);
    step();
    expect(engine.poses.get(mesh).sy).toBeGreaterThan(1); // stretched while falling
    entity.rigidBody.grounded = true;
    entity.rigidBody.velocity.set(0, 0, 0);
    step();
    const pose = engine.poses.get(mesh);
    expect(pose.sy).toBeLessThan(0.85);
    expect(pose.sx).toBeGreaterThan(1);
    expect(pose.y).toBeCloseTo(-(1 - pose.sy) * 0.5, 6); // the bottom stays put
    step(30);
    expect(engine.poses.get(mesh).sy).toBeGreaterThan(0.97); // and springs back
  });

  it('a model plays the clips picked for standing, walking, running and the air — whatever they are called', () => {
    const { entity, engine, mesh, ctx, step } = setup();
    const clip = (name) => new THREE.AnimationClip(name, 1, [new THREE.NumberKeyframeTrack('.scale[x]', [0, 1], [1, 2])]);
    mesh.userData.animations = [clip('Anim_A'), clip('Take 002'), clip('sprint_loop'), clip('air')];
    Object.assign(ctx.props, { idle: 'Anim_A', walk: 'Take 002', run: 'sprint_loop', runSpeed: 5, jump: 'air' });
    const showing = () => engine.mixers[0].playing;
    entity.rigidBody.grounded = true;
    step();
    expect(engine.mixers).toHaveLength(1);
    expect(showing()).toBe('Anim_A');
    entity.rigidBody.velocity.set(3, 0, 0);
    step();
    expect(showing()).toBe('Take 002');
    entity.rigidBody.velocity.set(7, 0, 0);
    step();
    expect(showing()).toBe('sprint_loop');
    entity.rigidBody.grounded = false;
    entity.rigidBody.velocity.y = 6;
    step();
    expect(showing()).toBe('air');
    expect(engine.poses.size).toBe(0); // models animate with clips, not poses
  });

  it('guesses nothing: with no clips picked, a model stays as it is', () => {
    const { entity, engine, mesh, step } = setup();
    mesh.userData.animations = [new THREE.AnimationClip('Idle', 1, []), new THREE.AnimationClip('Walk', 1, [])];
    entity.rigidBody.grounded = true;
    entity.rigidBody.velocity.set(3, 0, 0);
    step();
    expect(engine.mixers[0].playing).toBe('');
  });

  it('an empty choice falls back to the next that fits (no running clip: walk at any speed)', () => {
    const { entity, engine, mesh, ctx, step } = setup();
    mesh.userData.animations = [new THREE.AnimationClip('Stand', 1, []), new THREE.AnimationClip('Stroll', 1, [])];
    Object.assign(ctx.props, { idle: 'Stand', walk: 'Stroll' });
    entity.rigidBody.grounded = true;
    entity.rigidBody.velocity.set(20, 0, 0);
    step();
    expect(engine.mixers[0].playing).toBe('Stroll');
    entity.rigidBody.grounded = false;
    entity.rigidBody.velocity.y = 8; // no clip for the air: keeps its movement clip
    step();
    expect(engine.mixers[0].playing).toBe('Stroll');
  });

  it('reads games saved when walking was called "Move clip"', () => {
    const runtime = new ComponentRuntime({ poses: new Map(), mixers: [], variables: new VariableStore() });
    const c = runtime.add({ object3D: new THREE.Object3D() }, 'animator', { idle: 'idle', move: 'walk' });
    expect(c.props.walk).toBe('walk');
  });

  it('cleans up its pose and mixer when play stops or the object goes', () => {
    const { mesh } = setup();
    mesh.userData.animations = [new THREE.AnimationClip('Idle', 1, [new THREE.NumberKeyframeTrack('.scale[x]', [0, 1], [1, 2])])];
    const engine = { poses: new Map(), mixers: [], variables: new VariableStore() };
    const runtime = new ComponentRuntime(engine);
    const shape = new THREE.Mesh(new THREE.BoxGeometry());
    new THREE.Scene().add(shape);
    const a = { object3D: mesh, rigidBody: null };
    const b = { object3D: shape, rigidBody: null };
    runtime.add(a, 'animator');
    runtime.add(b, 'animator');
    runtime.update(1 / 60, 0, {});
    expect(engine.mixers).toHaveLength(1);
    expect(engine.poses.has(shape)).toBe(true);
    runtime.clearEntity(b);
    expect(engine.poses.has(shape)).toBe(false);
    runtime.clear();
    expect(engine.mixers).toHaveLength(0);
  });
});

describe('PlayOverlay — HUD, messages, title screen', () => {
  const engine = () => ({ variables: new VariableStore(), gameplay: { controls: { list: [] } }, input: {}, ui: normalizeUI() });

  it('draws bars and hearts', () => {
    const e = engine();
    e.variables.define('health', 1);
    e.variables.define('lives', 2);
    e.ui = normalizeUI({ hud: { health: { show: 'bar', max: 4 }, lives: { show: 'hearts', max: 3 } } });
    const overlay = new PlayOverlay(e, { hud: true });
    overlay.show();
    overlay.update();
    expect(document.querySelector('.t3-bar i').style.width).toBe('25%');
    expect(document.querySelector('.t3-hearts').textContent).toBe('♥♥♥');
    expect(document.querySelector('.t3-hearts em').textContent).toBe('♥'); // one lost
    overlay.hide();
  });

  it('shows a message where asked, and takes it away after its seconds', () => {
    vi.useFakeTimers();
    const overlay = new PlayOverlay(engine());
    overlay.show();
    overlay.message('The door opens', { seconds: 2, where: 'top' });
    const el = document.querySelector('.t3-message');
    expect(el.textContent).toBe('The door opens');
    expect(el.classList.contains('at-top')).toBe(true);
    overlay.message('Newer'); // replaces it
    expect(document.querySelectorAll('.t3-message')).toHaveLength(1);
    vi.advanceTimersByTime(3500);
    expect(document.querySelector('.t3-message')).toBeNull();
    overlay.hide();
  });

  it('a message sent before the overlay is up (a "Play starts" rule) shows when it appears', () => {
    const overlay = new PlayOverlay(engine());
    overlay.message('Reach the golden ring!', { seconds: 3, where: 'top' });
    expect(document.querySelector('.t3-message')).toBeNull();
    overlay.show();
    expect(document.querySelector('.t3-message.at-top')?.textContent).toBe('Reach the golden ring!');
    overlay.hide();
  });

  it('the title screen waits for a key (not Esc) and then goes', async () => {
    const overlay = new PlayOverlay(engine());
    const started = overlay.titleScreen({ text: 'Sky Hopper', subtitle: 'Go', prompt: 'Press any key' });
    expect(document.querySelector('.t3-title h1').textContent).toBe('Sky Hopper');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    expect(document.querySelector('.t3-title')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
    await started;
    expect(document.querySelector('.t3-title')).toBeNull();
  });
});

describe('PlayOverlay — pause menu', () => {
  const fakeAudio = () => ({
    playerMix: { master: 1, effects: 1, music: 1, ambience: 1 }, muted: false,
    setPlayerVolume(ch, v) { this.playerMix[ch] = v; },
    setMuted(m) { this.muted = m; },
    unlock() {},
  });
  const engine = () => ({
    variables: new VariableStore(), gameplay: { controls: { list: [] } }, input: {},
    ui: normalizeUI(), audio: fakeAudio(),
  });
  const key = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
  const click = (sel) => document.querySelector(sel).click();

  it('shows the level, the buttons and the controls; Esc resumes', () => {
    const overlay = new PlayOverlay(engine());
    const onResume = vi.fn();
    overlay.pauseMenu({ level: 'Sunset Heights', keys: 'W move forward', onResume, onRestartLevel: () => {} });
    expect(overlay.pauseOpen).toBe(true);
    expect(document.querySelector('.t3-pause-level').textContent).toBe('Sunset Heights');
    expect([...document.querySelectorAll('.t3-pause button')].map((b) => b.textContent))
      .toEqual(['Resume', 'Restart level', 'Restart game']);
    expect(document.querySelector('.t3-pause-keys').textContent).toBe('W move forward');
    expect(document.activeElement.textContent).toBe('Resume'); // Enter resumes straight away
    key('Escape');
    expect(onResume).toHaveBeenCalledOnce();
    expect(overlay.pauseOpen).toBe(false);
  });

  it('the game never sees keys pressed while it is paused (P included)', () => {
    const overlay = new PlayOverlay(engine());
    const game = vi.fn();
    window.addEventListener('keydown', game);
    overlay.pauseMenu({});
    key('KeyW');
    expect(game).not.toHaveBeenCalled();
    key('KeyP'); // P resumes too
    expect(overlay.pauseOpen).toBe(false);
    key('KeyW');
    expect(game).toHaveBeenCalledOnce();
    window.removeEventListener('keydown', game);
  });

  it('arrow keys move between the buttons', () => {
    const overlay = new PlayOverlay(engine());
    overlay.pauseMenu({ onRestartLevel: () => {} });
    key('ArrowDown');
    expect(document.activeElement.textContent).toBe('Restart level');
    key('ArrowUp');
    key('ArrowUp');
    expect(document.activeElement.textContent).toBe('Restart game'); // wraps round
  });

  it('Restart game asks once more before throwing the run away', () => {
    const overlay = new PlayOverlay(engine());
    const onRestartGame = vi.fn();
    overlay.pauseMenu({ onRestartGame });
    click('[data-act="game"]');
    expect(onRestartGame).not.toHaveBeenCalled();
    expect(document.querySelector('[data-act="game"]').textContent).toMatch(/beginning/);
    click('[data-act="game"]');
    expect(onRestartGame).toHaveBeenCalledOnce();
    expect(overlay.pauseOpen).toBe(false);
  });

  it('no Restart level button unless the host offers one', () => {
    new PlayOverlay(engine()).pauseMenu({});
    expect(document.querySelector('[data-act="level"]')).toBeNull();
  });

  it("volume sliders and mute set the player's volume and are remembered", () => {
    localStorage.clear();
    const e = engine();
    const overlay = new PlayOverlay(e);
    overlay.pauseMenu({});
    const music = document.querySelector('[data-ch="music"]');
    music.value = '0.25';
    music.dispatchEvent(new Event('input', { bubbles: true }));
    const effects = document.querySelector('[data-ch="effects"]');
    effects.value = '0.5';
    effects.dispatchEvent(new Event('input', { bubbles: true }));
    const mute = document.querySelector('[data-mute]');
    mute.checked = true;
    mute.dispatchEvent(new Event('change', { bubbles: true }));
    expect(e.audio.playerMix).toMatchObject({ music: 0.25, effects: 0.5, ambience: 0.5 });
    expect(e.audio.muted).toBe(true);

    const next = engine(); // the next visit
    new PlayOverlay(next).loadVolume();
    expect(next.audio.playerMix.music).toBe(0.25);
    expect(next.audio.muted).toBe(true);
  });

  it('a ⏸ button for touch screens asks the host to pause', () => {
    const overlay = new PlayOverlay(engine(), { pauseButton: true });
    overlay.onPauseButton = vi.fn();
    overlay.show();
    click('.t3-pause-btn');
    expect(overlay.onPauseButton).toHaveBeenCalledOnce();
  });
});

describe('the crosshair', () => {
  it('fills in and clamps its settings', () => {
    expect(normalizeCrosshair()).toEqual({ ...CROSSHAIR_DEFAULTS });
    const c = normalizeCrosshair({ style: 'star', show: 'never', size: 999, thickness: -1, color: 'red', opacity: 5, outline: false });
    expect(c).toMatchObject({ style: 'none', show: 'first person', size: 96, thickness: 1, color: '#ffffff', opacity: 1, outline: false });
    expect(normalizeUI({}).crosshair).toEqual({ ...CROSSHAIR_DEFAULTS }); // saved with the game's other settings
  });

  it('is off unless a game chooses one', () => {
    expect(CROSSHAIR_DEFAULTS.style).toBe('none');
    expect(crosshairShows(normalizeUI({}).crosshair, { mode: 'fps', captured: true })).toBe(false);
  });

  it('shows when it is asked to: in first person, while the mouse is captured, or always', () => {
    const at = (show, mode, captured) => crosshairShows(normalizeCrosshair({ style: 'dot', show }), { mode, captured });
    expect(at('first person', 'fps', false)).toBe(true);
    expect(at('first person', 'follow', true)).toBe(false);
    expect(at('mouse captured', 'follow', true)).toBe(true);
    expect(at('mouse captured', 'fps', false)).toBe(false);
    expect(at('always', 'orbit', false)).toBe(true);
    expect(crosshairShows(normalizeCrosshair({ style: 'none', show: 'always' }), { mode: 'fps' })).toBe(false);
  });

  it('draws each style: a dot, a cross, a circle, and those together', () => {
    const count = (svg, tag) => (svg.match(new RegExp(`<${tag} `, 'g')) || []).length;
    const plain = (style) => crosshairSvg({ style, outline: false });
    expect(count(plain('dot'), 'circle')).toBe(1);
    expect(count(plain('cross'), 'line')).toBe(4);
    expect(count(plain('cross + dot'), 'line') + count(plain('cross + dot'), 'circle')).toBe(5);
    expect(count(plain('circle + dot'), 'circle')).toBe(2);
    expect(crosshairSvg({ style: 'none' })).toBe('');
    // the outline draws everything twice: dark underneath, the colour on top
    expect(count(crosshairSvg({ style: 'cross', outline: true }), 'line')).toBe(8);
    expect(crosshairSvg({ style: 'dot', color: '#ff0000' })).toContain('#ff0000');
  });

  it('the overlay puts it in the middle only when it should show', () => {
    const engine = { variables: new VariableStore(), gameplay: { controls: { list: [] } }, input: { pointerLocked: false },
      ui: normalizeUI({ crosshair: { style: 'dot', show: 'first person' } }), cameraRig: { mode: 'orbit' } };
    const overlay = new PlayOverlay(engine);
    overlay.show();
    overlay.update();
    expect(document.querySelector('.t3-crosshair').innerHTML).toBe('');
    engine.cameraRig.mode = 'fps';
    overlay.update();
    expect(document.querySelector('.t3-crosshair svg')).not.toBeNull();
  });
});
