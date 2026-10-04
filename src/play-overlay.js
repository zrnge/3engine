import { t, i18n } from './i18n.js';
import { screenInputId } from './controls.js';
import { hudItems, hudHtml, crosshairShows, crosshairSvg } from './game-ui.js';
import { screenHtml, dialogueHtml, SCREEN_STYLE } from './screens.js';

/**
 * PlayOverlay — the on-screen part of the controls while a game runs: touch
 * buttons for every "Screen button" input, and the "E  Open door" prompt when
 * something can be interacted with.
 *
 * Shared by the editor's Play mode and exported games. Buttons report through
 * Input's virtual buttons, so the control runtime never touches the DOM.
 * Move controls land on a D-pad at bottom-left; everything else is a round
 * button at bottom-right.
 */

/** grid-area (row / column) of each move direction on the D-pad. */
const DPAD_CELL = { forward: '1 / 2', left: '2 / 1', right: '2 / 3', back: '3 / 2' };

const STYLE = `
.t3-touch { position: fixed; inset: 0; pointer-events: none; z-index: 25; font-family: system-ui, sans-serif; }
.t3-touch-btn {
  pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none;
  -webkit-touch-callout: none; appearance: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  width: 58px; height: 58px; border-radius: 14px;
  border: 2px solid rgba(255,255,255,0.35); background: rgba(13,17,23,0.55);
  color: #e6edf3; font: 600 15px system-ui, sans-serif;
}
.t3-touch-btn.down { background: rgba(77,208,166,0.5); border-color: #4dd0a6; }
.t3-dpad {
  position: absolute; left: var(--t3-touch-left, 24px); bottom: var(--t3-touch-bottom, 24px);
  display: grid; grid-template-columns: repeat(3, 58px); grid-template-rows: repeat(3, 58px); gap: 4px;
}
.t3-stick {
  position: absolute; left: var(--t3-touch-left, 24px); bottom: var(--t3-touch-bottom, 24px);
  width: 132px; height: 132px; border-radius: 50%; pointer-events: auto; touch-action: none;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  background: rgba(13,17,23,0.4); border: 2px solid rgba(255,255,255,0.3);
}
.t3-stick.down { border-color: #4dd0a6; }
.t3-knob {
  position: absolute; left: 50%; top: 50%; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%;
  background: rgba(230,237,243,0.5); border: 2px solid rgba(255,255,255,0.65); pointer-events: none;
}
.t3-actions {
  position: absolute; right: var(--t3-touch-right, 24px); bottom: var(--t3-touch-bottom, 24px);
  display: flex; flex-direction: row-reverse; flex-wrap: wrap-reverse; gap: 10px; max-width: 45vw;
}
.t3-actions .t3-touch-btn { width: 68px; height: 68px; border-radius: 50%; }
.t3-prompt {
  position: absolute; left: 50%; bottom: calc(var(--t3-touch-bottom, 24px) + 90px); transform: translateX(-50%);
  display: none; white-space: nowrap; padding: 7px 14px; border-radius: 8px;
  background: rgba(13,17,23,0.85); border: 1px solid #4dd0a6; color: #e6edf3; font-size: 14px;
}
.t3-prompt.show { display: block; }
.t3-hud-box .t3-hud-item { display: flex; align-items: center; }
.t3-bar { display: inline-block; width: 90px; height: 9px; border-radius: 999px; background: rgba(255,255,255,0.14); overflow: hidden; }
.t3-bar i { display: block; height: 100%; background: linear-gradient(90deg, #f47067, #f6c343 45%, #4dd0a6); transition: width 0.25s; }
.t3-hud-box .t3-hearts { color: #f47067; letter-spacing: 1px; font-size: 16px; }
.t3-hud-box .t3-hearts em { font-style: normal; color: rgba(255,255,255,0.2); }
.t3-message {
  position: absolute; left: 50%; transform: translateX(-50%); max-width: min(640px, 88vw); padding: 10px 18px;
  border-radius: 10px; background: rgba(13,17,23,0.86); border: 1px solid rgba(255,255,255,0.18);
  color: #e6edf3; font: 16px/1.4 system-ui, sans-serif; text-align: center; pointer-events: none; transition: opacity 0.4s;
}
.t3-message.at-middle { top: 40%; }
.t3-message.at-top { top: calc(var(--t3-hud-top, 12px) + 52px); }
.t3-message.at-bottom { bottom: calc(var(--t3-touch-bottom, 24px) + 150px); }
.t3-message.out { opacity: 0; }
.t3-title {
  position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 20px; text-align: center; cursor: pointer; pointer-events: auto; /* a click or a tap starts the game */ color: #e6edf3; font-family: system-ui, sans-serif;
  background: radial-gradient(ellipse at center, rgba(13,17,23,0.5), rgba(5,7,11,0.93));
}
.t3-title h1 { margin: 0; font-size: clamp(34px, 7vw, 72px); letter-spacing: 0.02em; text-shadow: 0 4px 24px rgba(0,0,0,0.6); }
.t3-title p { margin: 0; font-size: 18px; opacity: 0.85; }
.t3-title .t3-press { margin-top: 26px; font-size: 15px; color: #4dd0a6; animation: t3-pulse 1.6s ease-in-out infinite; }
@keyframes t3-pulse { 50% { opacity: 0.35; } }
.t3-hud { position: absolute; inset: 0; pointer-events: none; }
.t3-hud:empty { display: none; }
/* each place used gets a box; where it sits and how it looks come from the game (game-ui.js hudHtml) */
.t3-hud-box { position: absolute; display: flex; color: #e6edf3; white-space: nowrap; line-height: 1.25; }
.t3-crosshair { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: none; line-height: 0; }
.t3-crosshair svg { display: block; }
.t3-hud-box span { letter-spacing: 0.06em; margin-inline-end: 0.45em; }
.t3-hud-box b { font-variant-numeric: tabular-nums; }
.t3-touch .t3-mute { position: absolute; top: 12px; right: 12px; width: 44px; height: 44px; border-radius: 50%; font-size: 18px; }
.t3-prompt b { color: #4dd0a6; margin-right: 8px; }
.t3-announce {
  position: absolute; left: 50%; top: 28%; transform: translateX(-50%); max-width: 90vw; text-align: center;
  font: 700 34px system-ui, sans-serif; color: #e6edf3; text-shadow: 0 2px 14px rgba(0,0,0,0.75);
  pointer-events: none; transition: opacity 0.6s;
}
.t3-announce small { display: block; font-size: 15px; font-weight: 500; opacity: 0.8; margin-top: 6px; }
.t3-announce.out { opacity: 0; }
.t3-touch .t3-pause-btn { position: absolute; top: 12px; right: 64px; width: 44px; height: 44px; border-radius: 50%; font-size: 16px; }
.t3-lang-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 6px 0; font-size: 14px; }
.t3-lang-row select { flex: 1; max-width: 60%; padding: 6px; border-radius: 6px; background: #161b22; color: #e6edf3; border: 1px solid #30363d; }
.t3-touch .t3-install-btn { position: absolute; top: 12px; right: 116px; width: 44px; height: 44px; border-radius: 50%; font-size: 18px; }
.t3-pause {
  position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; padding: 16px;
  background: rgba(5,7,11,0.62); backdrop-filter: blur(3px); font-family: system-ui, sans-serif; color: #e6edf3;
}
.t3-pause-card {
  width: min(340px, 100%); max-height: 100%; overflow-y: auto; padding: 22px 22px 16px; border-radius: 14px;
  background: rgba(13,17,23,0.96); border: 1px solid rgba(77,208,166,0.5); box-shadow: 0 18px 50px rgba(0,0,0,0.55);
  display: flex; flex-direction: column; gap: 8px;
}
.t3-pause h2 { margin: 0; font-size: 26px; text-align: center; }
.t3-pause-level { text-align: center; color: #8b949e; font-size: 13px; margin: -4px 0 6px; }
.t3-pause button {
  appearance: none; cursor: pointer; padding: 11px 14px; border-radius: 9px; font: 600 15px system-ui, sans-serif;
  color: #e6edf3; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.16);
}
.t3-pause button:hover, .t3-pause button:focus-visible { border-color: #4dd0a6; outline: none; background: rgba(77,208,166,0.14); }
.t3-pause button.primary { background: #4dd0a6; color: #0b0e14; border-color: #4dd0a6; }
.t3-pause button.confirm { border-color: #f47067; color: #f47067; }
.t3-pause-sound { display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; align-items: center; margin-top: 8px;
  padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.1); font-size: 13px; color: #c9d1d9; }
.t3-pause-sound input[type=range] { width: 100%; accent-color: #4dd0a6; }
.t3-pause-sound .t3-mute-row { grid-column: 1 / 3; display: flex; align-items: center; gap: 8px; cursor: pointer; }
.t3-pause-sound input[type=checkbox] { accent-color: #4dd0a6; width: 16px; height: 16px; }
.t3-pause-keys { margin-top: 6px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); font-size: 12px; color: #8b949e; line-height: 1.6; }
.t3-pause-hint { text-align: center; font-size: 12px; color: #8b949e; margin-top: 4px; }
`;

/** Where a game remembers the player's volume between visits. */
const VOLUME_KEY = 't3.playerVolume';

/** The overlay's styles, once (the editor's HUD preview uses them too). */
export function injectStyle() {
  if (document.getElementById('t3-touch-style')) return;
  const style = document.createElement('style');
  style.id = 't3-touch-style';
  style.textContent = STYLE + SCREEN_STYLE;
  document.head.appendChild(style);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export class PlayOverlay {
  constructor(engine, { parent = null, muteButton = false, hud = false, pauseButton = false } = {}) {
    this.engine = engine;
    this.parent = parent;
    this.muteButton = muteButton; // exported games: a 🔊 toggle, top-right
    this.pauseButton = pauseButton; // exported games: ⏸ for touch screens (no Esc key)
    this.onInstall = null; // the game can be installed: see setInstall
    // another language picked: every text on screen in it, and read the way it reads
    i18n.onChange(() => {
      if (this.root) this.root.dir = i18n.rtl ? 'rtl' : 'ltr';
      this._lastHud = null;
      this._lastPrompt = null;
      this._car = undefined;
    });
    this.onPauseButton = null;
    this.pauseEl = null;
    this.hud = hud;               // exported games: the variables, top-centre
    this.hudEl = null;
    this._lastHud = null;
    this.root = null;
    this.promptEl = null;
    this._lastPrompt = null;
  }

  /** Build the buttons for the scene's current controls. */
  show() {
    this.hide();
    injectStyle();
    const root = document.createElement('div');
    root.className = 't3-touch';
    const dpad = document.createElement('div');
    dpad.className = 't3-dpad';
    const actions = document.createElement('div');
    actions.className = 't3-actions';
    const usedCells = new Set();
    // moving on a touch screen: a joystick unless the game asks for a D-pad
    const joystick = (this.engine.ui?.touch?.move ?? 'joystick') === 'joystick';
    const stickIds = { forward: [], back: [], left: [], right: [] };

    const list = this.engine.gameplay?.controls?.list || [];
    list.forEach((control, ci) => control.inputs.forEach((input, ii) => {
      if (input.type !== 'screen') return;
      const direction = control.action?.type === 'move' ? control.action.direction : null;
      if (joystick && stickIds[direction]) {
        stickIds[direction].push(screenInputId(ci, ii)); // the joystick pushes it
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 't3-touch-btn';
      btn.textContent = t(input.label) || '●';
      btn.dataset.screenInput = screenInputId(ci, ii);
      if (control.action?.type === 'jump') { // in a car it is the handbrake: said so (see update)
        btn.dataset.jump = '1';
        btn.dataset.label = btn.textContent;
      }
      const dir = control.action?.type === 'move' ? control.action.direction : null;
      if (dir && DPAD_CELL[dir] && !usedCells.has(dir)) {
        usedCells.add(dir);
        btn.style.gridArea = DPAD_CELL[dir];
        dpad.appendChild(btn);
      } else {
        actions.appendChild(btn);
      }
      this._wire(btn, screenInputId(ci, ii));
    }));

    if (dpad.children.length) root.appendChild(dpad);
    if (Object.values(stickIds).some((ids) => ids.length)) root.appendChild(this._joystick(stickIds));
    if (actions.children.length) root.appendChild(actions);
    if (this.muteButton && this.engine.audio) root.appendChild(this._muteButton());
    if (this.pauseButton) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 't3-touch-btn t3-pause-btn';
      btn.tabIndex = -1;
      btn.textContent = '⏸';
      btn.title = 'Pause (Esc)';
      btn.addEventListener('pointerdown', (e) => e.preventDefault());
      btn.addEventListener('click', () => this.onPauseButton?.());
      root.appendChild(btn);
    }
    if (this.onInstall) root.appendChild(this._installButton());
    if (this.hud) {
      this.hudEl = document.createElement('div');
      this.hudEl.className = 't3-hud';
      // the sound / pause / install buttons sit top right: a HUD there goes below them
      if (this.muteButton || this.pauseButton) root.style.setProperty('--t3-hud-corner', '56px');
      root.appendChild(this.hudEl);
      this._lastHud = null;
    }
    // the crosshair, at the middle of the screen (game-ui.js says how and when)
    this.crosshairEl = document.createElement('div');
    this.crosshairEl.className = 't3-crosshair';
    root.appendChild(this.crosshairEl);
    this._lastCrosshair = null;
    const prompt = document.createElement('div');
    prompt.className = 't3-prompt';
    root.appendChild(prompt);
    // the game's own screens and its dialogue box (screens.js), over everything else of the game
    this.uiEl = document.createElement('div');
    this.uiEl.className = 't3-ui-layer';
    root.appendChild(this.uiEl);
    this._wireScreens();

    (this.parent || document.body).appendChild(root);
    this.root = root;
    root.dir = i18n.rtl ? 'rtl' : 'ltr';
    // a HUD in a bottom corner sits above the joystick / D-pad there, and the buttons
    const clear = (els, side) => {
      const tall = Math.max(0, ...els.map((el) => el.getBoundingClientRect().height || 0));
      if (tall) root.style.setProperty(`--t3-hud-clear-${side}`, `${Math.ceil(tall) + 10}px`);
    };
    clear([...root.querySelectorAll('.t3-dpad, .t3-stick')], 'left');
    clear([...root.querySelectorAll('.t3-actions')], 'right');
    this.promptEl = prompt;
    prompt.addEventListener('pointerdown', (e) => {
      const p = this.engine.gameplay?.controls?.prompt;
      if (!p?.tap) return;
      e.preventDefault();
      e.stopPropagation();
      p.tap();
    });
    this._lastPrompt = null;
    if (this._pending) {
      const [text, opts] = this._pending;
      this._pending = null;
      this.message(text, opts);
    }
  }

  _wire(btn, id) {
    const set = (down) => {
      this.engine.input?.setVirtual?.(id, down);
      btn.classList.toggle('down', down);
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // no focus, no text selection, no synthetic mouse click
      try { btn.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ }
      set(true);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      btn.addEventListener(type, () => set(false));
    }
    btn.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press on touch
  }

  /**
   * A thumb joystick for the move controls' on-screen inputs: drag the knob any
   * way, as far as you like — part way walks slowly — and let go to stop. It
   * pushes each direction's inputs (▲ ▼ ◀ ▶) as far as the knob leans that way.
   */
  _joystick(ids) {
    const base = document.createElement('div');
    base.className = 't3-stick';
    const knob = document.createElement('div');
    knob.className = 't3-knob';
    base.appendChild(knob);
    const reach = 48; // how far the knob travels, px
    const set = (x, y) => {
      knob.style.transform = `translate(${x * reach}px, ${y * reach}px)`;
      base.classList.toggle('down', x !== 0 || y !== 0);
      const lean = { forward: -y, back: y, left: -x, right: x };
      for (const [direction, list] of Object.entries(ids)) {
        const v = lean[direction] > 0.15 ? Math.min(1, (lean[direction] - 0.15) / 0.85) : 0; // a small dead zone
        for (const id of list) this.engine.input?.setVirtual?.(id, v > 0, v);
      }
    };
    let finger = null;
    const follow = (e) => {
      const r = base.getBoundingClientRect();
      let x = (e.clientX - (r.left + r.width / 2)) / reach;
      let y = (e.clientY - (r.top + r.height / 2)) / reach;
      const m = Math.hypot(x, y);
      if (m > 1) { x /= m; y /= m; }
      set(x, y);
    };
    base.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      finger = e.pointerId;
      try { base.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ }
      follow(e);
    });
    base.addEventListener('pointermove', (e) => { if (e.pointerId === finger) follow(e); });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      base.addEventListener(type, (e) => {
        if (e.pointerId !== finger) return;
        finger = null;
        set(0, 0);
      });
    }
    base.addEventListener('contextmenu', (e) => e.preventDefault());
    return base;
  }

  /**
   * The game can be installed (a phone's home screen, a computer's apps): `fn`
   * asks the browser to. A ⤓ button top-right, and "Install game" in the pause
   * menu — gone again with null (installed, or the browser won't).
   */
  setInstall(fn) {
    this.onInstall = fn || null;
    this.root?.querySelector('.t3-install-btn')?.remove();
    if (this.onInstall) this.root?.querySelector('.t3-touch')?.appendChild(this._installButton());
  }

  _installButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 't3-touch-btn t3-install-btn';
    btn.tabIndex = -1;
    btn.textContent = '⤓';
    btn.title = 'Install the game: play it from your home screen, offline too';
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('click', () => this.onInstall?.());
    return btn;
  }

  _muteButton() {
    const audio = this.engine.audio;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 't3-touch-btn t3-mute';
    btn.tabIndex = -1; // never focused, or Space (jump) would press it
    const sync = () => {
      btn.textContent = audio.muted ? '🔇' : '🔊';
      btn.title = audio.muted ? 'Sound off' : 'Sound on';
    };
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      audio.setMuted(!audio.muted);
      audio.unlock();
      sync();
      this._saveVolume();
    });
    sync();
    return btn;
  }

  /** A big line of text in the middle of the screen: a level's name, "You win!". */
  announce(text, { sub = '', stay = false } = {}) {
    if (!this.root) return null;
    this.root.querySelectorAll('.t3-announce').forEach((n) => n.remove());
    const el = document.createElement('div');
    el.className = 't3-announce';
    el.innerHTML = `${esc(t(text))}${sub ? `<small>${esc(t(sub))}</small>` : ''}`;
    this.root.appendChild(el);
    if (!stay) {
      setTimeout(() => el.classList.add('out'), 1600);
      setTimeout(() => el.remove(), 2300);
    }
    return el;
  }

  /** A line of text for the player — the Show message action. seconds 0 = until the next one. */
  message(text, { seconds = 3, where = 'middle' } = {}) {
    if (!this.root) {
      // a "Play starts" rule runs before the overlay is up: keep it for show()
      this._pending = [text, { seconds, where }];
      return null;
    }
    this.root.querySelectorAll('.t3-message').forEach((n) => n.remove());
    if (!text) return null;
    const el = document.createElement('div');
    el.className = `t3-message at-${['top', 'bottom'].includes(where) ? where : 'middle'}`;
    el.textContent = t(text);
    this.root.appendChild(el);
    if (seconds > 0) {
      setTimeout(() => el.classList.add('out'), seconds * 1000);
      setTimeout(() => el.remove(), seconds * 1000 + 450);
    }
    return el;
  }

  /**
   * The title screen. Resolves when the player presses a key or clicks —
   * the host keeps the game paused until then.
   */
  titleScreen({ text = '', subtitle = '', prompt = 'Press any key to start' } = {}) {
    injectStyle();
    this._closeTitle?.();
    const el = document.createElement('div');
    el.className = 't3-title t3-touch';
    el.dir = i18n.rtl ? 'rtl' : 'ltr';
    el.innerHTML = `<h1>${esc(t(text))}</h1>${subtitle ? `<p>${esc(t(subtitle))}</p>` : ''}
      <div class="t3-press">${esc(t(prompt))}</div>`;
    document.body.appendChild(el);
    return new Promise((resolve) => {
      const done = () => {
        window.removeEventListener('keydown', onKey, true);
        el.remove();
        this._closeTitle = null;
        resolve();
      };
      const onKey = (e) => {
        if (e.code === 'Escape') return; // Esc still means "stop" in the editor
        done();
      };
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); done(); });
      window.addEventListener('keydown', onKey, true);
      this._closeTitle = done;
    });
  }

  /** True while the pause menu is up. */
  get pauseOpen() { return !!this.pauseEl; }

  /**
   * The pause menu. The host pauses the game and passes what the buttons do:
   *   onResume, onRestartLevel (left out: no such button), onRestartGame.
   * `level` names the level being played; `keys` is the controls line.
   * Esc or P resumes; the arrow keys move between buttons.
   */
  pauseMenu({ level = '', keys = '', onResume = null, onRestartLevel = null, onRestartGame = null, onInstall = this.onInstall } = {}) {
    if (this.pauseEl) return this.pauseEl;
    injectStyle();
    const audio = this.engine.audio;
    const el = document.createElement('div');
    el.className = 't3-pause';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Paused');
    const slider = (ch, label) => `<label for="t3-vol-${ch}">${esc(t(label))}</label>
      <input type="range" id="t3-vol-${ch}" data-ch="${ch}" min="0" max="1" step="0.05" value="${audio?.playerMix?.[ch] ?? 1}">`;
    el.dir = i18n.rtl ? 'rtl' : 'ltr';
    const languages = i18n.data.list;
    el.innerHTML = `<div class="t3-pause-card">
      <h2>${esc(t('Paused'))}</h2>
      ${level ? `<div class="t3-pause-level">${esc(t(level))}</div>` : ''}
      <button type="button" class="primary" data-act="resume">${esc(t('Resume'))}</button>
      ${onRestartLevel ? `<button type="button" data-act="level">${esc(t('Restart level'))}</button>` : ''}
      <button type="button" data-act="game">${esc(t('Restart game'))}</button>
      ${onInstall ? `<button type="button" data-act="install">${esc(t('Install game'))}</button>` : ''}
      ${languages.length > 1 ? `<label class="t3-lang-row">${esc(t('Language'))}
        <select data-lang>${languages.map((l) => `<option value="${esc(l.code)}" ${l.code === i18n.language ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` : ''}
      ${audio ? `<div class="t3-pause-sound">
        ${slider('effects', 'Sound effects')}
        ${slider('music', 'Music')}
        <label class="t3-mute-row"><input type="checkbox" data-mute ${audio.muted ? 'checked' : ''}> ${esc(t('Mute everything'))}</label>
      </div>` : ''}
      ${keys ? `<div class="t3-pause-keys">${esc(keys)}</div>` : ''}
      <div class="t3-pause-hint">${esc(t('Esc to resume'))}</div>
    </div>`;

    const close = () => {
      window.removeEventListener('keydown', onKey, true);
      el.remove();
      this.pauseEl = null;
      this._closePause = null;
    };
    const resume = () => { close(); onResume?.(); };
    const buttons = () => [...el.querySelectorAll('button')];
    const onKey = (e) => {
      // the game (and the engine's own P key) must not see keys meant for the menu
      e.stopPropagation();
      if (e.code === 'Escape' || e.code === 'KeyP') { e.preventDefault(); resume(); return; }
      if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
        e.preventDefault();
        const list = buttons();
        const i = list.indexOf(document.activeElement);
        const next = e.code === 'ArrowDown' ? i + 1 : i - 1;
        list[(next + list.length) % list.length]?.focus();
      }
    };
    let confirmTimer = null;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'resume') resume();
      else if (act === 'level') { close(); onRestartLevel?.(); }
      else if (act === 'install') { onInstall?.(); }
      else if (act === 'game') {
        // starting over loses the run: ask once more on the button itself
        if (!btn.classList.contains('confirm')) {
          btn.classList.add('confirm');
          btn.textContent = t('Restart from the beginning?');
          clearTimeout(confirmTimer);
          confirmTimer = setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = t('Restart game'); }, 3000);
          return;
        }
        close();
        onRestartGame?.();
      }
    });
    el.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.ch && audio) {
        audio.setPlayerVolume(t.dataset.ch, Number(t.value));
        if (t.dataset.ch === 'effects') audio.setPlayerVolume('ambience', Number(t.value)); // one slider for both
        this._saveVolume();
      }
    });
    el.addEventListener('change', (e) => {
      if (e.target.matches('[data-lang]')) {
        // the player's language, kept for next time; the menu again, in it
        i18n.setLanguage(e.target.value, { remember: true });
        close();
        this.pauseMenu({ level, keys, onResume, onRestartLevel, onRestartGame, onInstall });
        this.pauseEl?.querySelector('[data-lang]')?.focus();
        return;
      }
      if (e.target.matches('[data-mute]') && audio) {
        audio.setMuted(e.target.checked);
        this.root?.querySelector('.t3-mute')?.replaceWith(this._muteButton()); // keep the 🔊 in step
        this._saveVolume();
      }
    });
    // a click on the dimmed backdrop resumes, like Esc
    el.addEventListener('pointerdown', (e) => { if (e.target === el) { e.preventDefault(); resume(); } });

    window.addEventListener('keydown', onKey, true);
    document.body.appendChild(el);
    this.pauseEl = el;
    this._closePause = close;
    el.querySelector('button.primary')?.focus();
    return el;
  }

  /** Close the pause menu without resuming (the host is changing level, restarting…). */
  closePause() { this._closePause?.(); }

  /** Bring back the volume this player chose last time. */
  loadVolume() {
    const audio = this.engine.audio;
    if (!audio) return;
    try {
      const saved = JSON.parse(localStorage.getItem(VOLUME_KEY) || 'null');
      if (!saved) return;
      for (const ch of ['effects', 'music', 'ambience']) if (ch in saved) audio.setPlayerVolume(ch, saved[ch]);
      if (saved.muted) audio.setMuted(true);
    } catch { /* storage blocked: the defaults are fine */ }
  }

  _saveVolume() {
    const audio = this.engine.audio;
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify({ ...audio.playerMix, muted: audio.muted }));
    } catch { /* storage blocked */ }
  }

  /** Clicks on screens and the dialogue box, and keys (a choice's number, Space to go on, a button's key). */
  _wireScreens() {
    const runtime = this.engine.gameplay?.screens;
    this._lastUi = null;
    if (!runtime) return;
    runtime.onChange = () => this.renderScreens();
    this.uiEl.addEventListener('click', (e) => {
      const el = e.target.closest('[data-ui-btn],[data-ui-pick],[data-ui-choice],[data-ui-next],[data-ui-close]');
      if (!el) return;
      e.preventDefault();
      const d = el.dataset;
      const ix = (s) => s.split(':').map(Number);
      if (d.uiBtn) runtime.press(...ix(d.uiBtn));
      else if (d.uiPick) runtime.pick(...ix(d.uiPick));
      else if (d.uiChoice) runtime.choose(Number(d.uiChoice));
      else if (d.uiNext) runtime.advance();
      else if (d.uiClose) runtime.hide(runtime.screens[Number(d.uiClose)]?.name);
    });
    // the game must not see keys meant for a screen or the dialogue (Space going on is not a jump)
    this._uiKeys = (e) => {
      if (!runtime.active || e.repeat || e.code === 'Escape') return;
      if (runtime.key(e.code)) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', this._uiKeys, true);
    this.renderScreens();
  }

  /** The screens up and the dialogue line, drawn again only when something on them changed. */
  renderScreens() {
    const runtime = this.engine.gameplay?.screens;
    if (!this.uiEl || !runtime) return;
    const opts = { vars: this.engine.variables, t, esc };
    const screens = runtime.open.map((name) => {
      const si = runtime.screens.findIndex((s) => s.name === name);
      return si >= 0 ? screenHtml(runtime.screens[si], si, opts) : '';
    }).join('');
    const html = screens + dialogueHtml(runtime.view(), opts);
    if (html === this._lastUi) return;
    this._lastUi = html;
    this.uiEl.innerHTML = html;
    // a screen to click on: the mouse captured for looking around is given back
    if (runtime.active && document.pointerLockElement) document.exitPointerLock?.();
  }

  hide() {
    if (this._uiKeys) window.removeEventListener('keydown', this._uiKeys, true);
    this._uiKeys = null;
    if (this.engine.gameplay?.screens) this.engine.gameplay.screens.onChange = null;
    this.uiEl = null;
    this._closeTitle?.();
    this.closePause();
    this.root?.remove();
    this.root = null;
    this.promptEl = null;
    this.hudEl = null;
    this.crosshairEl = null;
    this.engine.input?.releaseVirtual?.();
  }

  /** Per frame: the crosshair, the variables (names starting with _ stay hidden) and the interaction prompt. */
  update() {
    this.renderScreens(); // a screen's {score} and lists as they are now
    if (this.crosshairEl) {
      const c = this.engine.ui?.crosshair;
      const rig = this.engine.cameraRig;
      const shows = crosshairShows(c, { mode: rig?.mode, captured: this.engine.input?.pointerLocked, aimHides: !!rig?.hidesCrosshair });
      const key = shows ? JSON.stringify(c) : '';
      if (key !== this._lastCrosshair) {
        this._lastCrosshair = key;
        this.crosshairEl.innerHTML = shows ? crosshairSvg(c) : '';
      }
    }
    if (this.hudEl) {
      const items = hudItems(this.engine.variables?.values || {}, this.engine.ui?.hud);
      // each in its place, in the game's look (Game panel → Variables on screen)
      const html = hudHtml(items, this.engine.ui?.hudLook, { text: t, esc });
      if (html !== this._lastHud) {
        this._lastHud = html;
        this.hudEl.innerHTML = html;
      }
    }
    // driving: the Jump button is the handbrake
    const car = !!this.engine.playerEntity?.vehicle;
    if (car !== this._car && this.root) {
      this._car = car;
      for (const b of this.root.querySelectorAll('[data-jump]')) b.textContent = car ? t('Brake') : b.dataset.label;
    }
    if (!this.promptEl) return;
    const p = this.engine.gameplay?.controls?.prompt;
    const html = p ? `<b>${esc(p.key)}</b>${esc(t(p.text))}` : '';
    // a prompt that can be tapped (a car's "Drive"): on a touch screen, there is no key
    this.promptEl.style.pointerEvents = p?.tap ? 'auto' : '';
    this.promptEl.style.cursor = p?.tap ? 'pointer' : '';
    if (html === this._lastPrompt) return;
    this._lastPrompt = html;
    this.promptEl.innerHTML = html;
    this.promptEl.classList.toggle('show', !!p);
  }
}
