import { showNotice } from '../ui.js';
import { clearRagdolls } from '../ragdoll.js';
import { PlayOverlay } from '../play-overlay.js';
import { i18n, t } from '../i18n.js';
import { scriptLine } from '../behavior.js';

/**
 * Play and Stop: the game run in the editor from a snapshot it goes back to; its camera, its
 * HUD and win / lose banner, level changes, pausing, and what a script that stopped said.
 *
 * Moved out of game.js as it was; it reaches the rest of the editor through `app`
 * (game.js): the engine, editor and history — and what other parts offer (app.markDirty…).
 */
export function wirePlayMode(app) {
  const { engine, editor, history, rig, assets, player, input, scene, viewport } = app;

  /** Switch to the game's camera for Play (and its level changes). */
  function applyPlayCamera({ captureMouse = true } = {}) {
    rig.fallbackTarget = engine.playerEntity?.object3D ?? null; // follow / first person with no target
    if (rig.playMode && rig.playMode !== rig.mode) app.setCamMode(rig.playMode);
    // a camera that looks with the mouse takes it straight away — the Play click
    // is the gesture the browser needs (it used to wait for a second click)
    if (captureMouse && rig.wantsPointerLock()) input.requestPointerLock();
  }

  /** The chosen player has a body that doesn't move by physics: it can't fall, jump or be stopped. */
  const playerCantMove = () => {
    const body = player.target?.rigidBody;
    return !!body && body.type !== 'dynamic';
  };

  // ---- play-mode HUD: live variable readout ----
  // the same HUD as exported games (play-overlay.js): numbers, bars, hearts; _names hidden
  function renderHud() { overlay.update(); }
  // body.playing rather than the `playing` binding, which is declared further down
  engine.variables.onChange(() => {
    if (document.body.classList.contains('playing')) renderHud();
  });

  // ---- win / lose banner ----
  const outcomeEl = document.getElementById('outcome');
  const outcomeMsg = document.getElementById('outcome-msg');

  engine.gameplay.onFinish = ({ result, message }) => {
    if (!outcomeEl) return;
    outcomeEl.classList.toggle('lose', result === 'lose');
    outcomeEl.classList.add('show');
    outcomeMsg.textContent = t(message || (result === 'win' ? 'You win!' : 'Game over'));
  };
  engine.gameplay.onRestart = () => { restartPlay(); };
  document.getElementById('outcome-again')?.addEventListener('click', () => restartPlay());

  // the gameplay layer asks the editor for prefab instances
  engine.gameplay.spawnPrefab = (name, position) => editor.instantiatePrefabSync(name, position);

  // anything destroyed at runtime must also leave the hierarchy and the dropdowns
  engine.onEntityRemoved = (entity) => editor.unregister(entity);

  // ---- play / edit mode ----
  // Edit mode: full editor. Play mode: editing is locked and the simulation
  // runs; stopping reverts the scene to the exact snapshot taken at Play.
  const playBtn = document.getElementById('btn-play');
  // on-screen buttons, the HUD, messages and the interact prompt while playing
  const overlay = new PlayOverlay(engine, { hud: true });
  engine.onMessage = (text, opts) => { if (playing) overlay.message(text, opts); };
  let playing = false;
  let playSnapshot = null;
  let levelLoad = null; // a level change under way during play
  let titleUp = false;  // the title screen holds the game until a key or a click
  let pausedNote = null; // "Paused" on screen while P has the game paused

  /** P during Play pauses and resumes, and says so on screen and in the status bar. */
  engine.onPauseKey = () => {
    if (!playing || titleUp) return;
    engine.togglePause();
    pausedNote?.remove();
    pausedNote = engine.paused ? overlay.announce('Paused', { sub: 'Press P to resume', stay: true }) : null;
    editor.statusPrefix = engine.paused ? '⏸ PAUSED · ' : '▶ PLAYING · ';
    editor._renderStatus();
  };

  /**
   * "Go to level" during play. Levels load as they were last edited; the
   * variables keep their values, and past the last level the game is won.
   */
  async function playLevel(target) {
    if (!playing) return;
    const index = app.project.resolve(target);
    if (index < 0) {
      const t = String(target ?? '').trim().toLowerCase();
      if (!t || t === 'next') engine.gameplay.finish('win', 'You finished the game!');
      else console.warn(`[Tiny3] "Go to level": there is no level called "${target}"`);
      return;
    }
    const load = (async () => {
      engine.stopAllSounds();
      overlay.hide();
      await app.project.loadLevel(index, { keepValues: true });
    })();
    levelLoad = load;
    try {
      await load;
    } finally {
      if (levelLoad === load) levelLoad = null;
    }
    if (!playing) return; // stopped while it was loading
    editor.select(null);
    engine.player = player;
    applyPlayCamera(); // this level's player, and the game's camera
    engine.gameplay.start({ keepVariables: true });
    renderHud();
    overlay.show();
    overlay.announce(app.project.levels[index].name);
    engine.audio.startAutoplay();
  }
  engine.gameplay.onGoToLevel = playLevel;
  // a Behavior script that throws stops — and says which, and why (the Inspector keeps it too)
  // Kept by the object's place in the level: Stop loads the level again, as new objects.
  const scriptErrors = new Map();
  const scriptKey = (e) => (Number.isInteger(e?.levelKey) ? `#${e.levelKey}` : e?.object3D?.name ?? '');
  editor.scriptErrorFor = (entity) => scriptErrors.get(scriptKey(entity)) ?? null;
  editor.clearScriptError = (entity) => scriptErrors.delete(scriptKey(entity));
  editor.clearScriptErrors = () => scriptErrors.clear();
  engine.onBehaviorError = (entity, err) => {
    const line = scriptLine(err);
    const message = `${err?.message || err}${line > 0 ? ` (line ${line})` : ''}`;
    scriptErrors.set(scriptKey(entity), message);
    showNotice(`The Behavior script on "${entity.object3D?.name || 'an object'}" stopped: ${message}`, { kind: 'error', seconds: 10 });
  };
  engine.gameplay.levelName = () => app.project.levels[app.project.active]?.name ?? ''; // a saved game keeps it

  /**
   * A player with a Static or Kinematic body can't fall, jump or be stopped by
   * walls: the controls slide it through everything, floating off every edge.
   * Say so at Play — with the one-click fix — instead of leaving it a mystery.
   */
  function checkPlayerBody() {
    if (!playerCantMove()) return;
    const p = player.target;
    const kind = p.rigidBody.type === 'static' ? 'Static' : 'Kinematic';
    // (Play leaves the mouse free then — captured, the fix couldn't be clicked)
    showNotice(`The player (${p.object3D.name || 'unnamed'}) has a ${kind} body, so it can't fall, jump or be `
      + 'stopped by walls — it slides through everything.', {
      kind: 'warn',
      seconds: 25,
      actions: [
        {
          label: 'Make it Dynamic',
          run: async () => {
            if (playing) await exitPlay(); // the change belongs to the game, not to this run
            const target = player.target;
            const b = target?.rigidBody;
            if (!b) return;
            const set = ({ type, shape }) => {
              b.type = type;
              b.shape = shape;
              b.invMass = type === 'dynamic' ? 1 / b.mass : 0;
              editor._updateSolidHelper(target);
              editor._renderInspector();
            };
            const before = { type: b.type, shape: b.shape };
            const after = { type: 'dynamic', shape: b.shape === 'mesh' ? 'capsule' : b.shape };
            history.push({ label: 'make the player dynamic', undo: () => set(before), redo: () => set(after) });
            set(after);
            enterPlay();
          },
        },
        { label: 'Keep it' },
      ],
    });
  }

  function enterPlay() {
    if (playing) return;
    playing = true;
    app.remindScriptsOff(); // a game opened from a file, its scripts not allowed: said once (files.js)
    playSnapshot = app.project.snapshot(); // also keeps this level's slot up to date
    editor.clearScriptErrors?.(); // this run's own, if any
    // in the language Play is to show (Game panel), else as a player's browser would pick
    i18n.load(engine.ui.languages, { game: engine.ui.game?.name });
    if (app.languagesPanel?.preview) i18n.setLanguage(app.languagesPanel.preview);
    app.project.active = app.project.current;
    editor.select(null);
    engine.playing = true; // gameplay code is inert until this is set
    engine.player = player; // so components and rules can resolve "player"
    applyPlayCamera({ captureMouse: !playerCantMove() }); // the game's camera; Stop brings the editor view back
    if (engine.grid) engine.grid.visible = false; // the editor's grid is not part of the game
    app.setPanTool(false);           // the hand tool is an editing tool
    // (after that, which hands the gizmo the left button back) the gizmo is the editor's: in play it
    // doesn't even listen — a click it took tried to capture the pointer while the game was locking it
    if (editor.gizmo) editor.gizmo.enabled = false;
    rig.allowSpacePan = false;   // Space is the jump key while playing
    outcomeEl?.classList.remove('show');
    app.beforePlay?.(); // the Tools: a fresh trace, before the start rules run
    engine.gameplay.start(); // reset variables, run start hooks and start rules
    checkPlayerBody();
    renderHud();
    overlay.show();
    document.body.classList.add('playing');
    playBtn.classList.add('playing');
    playBtn.textContent = '⏹ Stop';
    playBtn.blur();
    app.focusViewport(); // so WASD/Space reach the game, not the toolbar
    editor.statusPrefix = '▶ PLAYING · ';
    editor._renderStatus();
    // sounds marked "on start" begin now — never while editing
    engine.audio.startAutoplay();
    const lookHint = () => {
      if (rig.wantsPointerLock()) overlay.announce('Click to look around', { sub: 'Esc gives the mouse back' });
    };
    const title = engine.ui.title;
    if (title.enabled && title.inEditor) {
      // the title screen: the game waits behind it until a key or a click
      engine.paused = true;
      titleUp = true;
      overlay.titleScreen(title).then(() => {
        titleUp = false;
        if (!playing) return;
        engine.paused = false;
        lookHint(); // after the title, not behind it
      });
    } else {
      lookHint();
    }
  }

  async function exitPlay() {
    if (!playing) return;
    playing = false;
    engine.playing = false;
    if (engine.grid) engine.grid.visible = true;
    rig.allowSpacePan = true;
    engine.physics.resetContacts();
    overlay.hide(); // also closes a title screen
    engine.gameplay.screens.reset(); // no menu or dialogue holding the editor still
    clearRagdolls(engine); // no limp character's limbs left in the editor
    if (editor.gizmo) editor.gizmo.enabled = true;
    titleUp = false;
    pausedNote = null; // went with the overlay
    input.exitPointerLock(); // the mouse is the editor's again
    engine.paused = false;
    outcomeEl?.classList.remove('show');
    document.body.classList.remove('playing');
    playBtn.classList.remove('playing');
    playBtn.textContent = '▶ Play';
    editor.statusPrefix = '';
    const snap = playSnapshot;
    playSnapshot = null;
    if (levelLoad) await levelLoad.catch(() => {}); // let a level change finish first
    engine.stopAllSounds();
    if (snap) {
      // back to the level being edited, exactly as it was before Play
      await app.serializer.deserialize(snap);
      app.project.active = app.project.current;
      history.clear();
      app.refreshHistoryButtons();
      app.refreshCamTargets();
      app.refreshControlTargets();
    }
    editor._renderStatus();
    app.afterPlay?.(); // the Tools: back to the level as edited
  }

  /** Stop and immediately start again — used by the Restart action and the banner. */
  async function restartPlay() {
    await exitPlay();
    enterPlay();
  }

  playBtn.addEventListener('click', () => (playing ? exitPlay() : enterPlay()));
  // Playing with a camera that looks with the mouse: clicking the view takes the
  // mouse back after Esc freed it. Never while editing — there the cursor stays
  // free for the panels, and first person / fly look round by dragging instead.
  viewport.addEventListener('click', () => {
    if (playing && rig.wantsPointerLock()) input.requestPointerLock();
  });
  window.addEventListener('keydown', (e) => { if (playing && e.code === 'Escape') exitPlay(); });

  Object.assign(app, { isPlaying: () => playing, enterPlay, exitPlay, restartPlay, playLevel, applyPlayCamera, playerCantMove, renderHud, checkPlayerBody, overlay });
}
