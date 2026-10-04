import { showNotice } from '../ui.js';
import { countScripts } from '../script-trust.js';
import { packGame, unpackGame, GAME_FILE_EXT } from '../game-file.js';
import { assetStore, savedGames } from '../assets-db.js';
import { assetIdsIn } from '../asset-refs.js';
import { t } from '../i18n.js';

/**
 * The game in files: Save (a .tiny3), Open (a .tiny3 or an older .json), scripts in a game
 * opened from a file (off until allowed), and the autosave into the browser's database.
 *
 * Moved out of game.js as it was; it reaches the rest of the editor through `app`
 * (game.js): the engine, editor and history — and what other parts offer (app.markDirty…).
 */
export function wireFiles(app) {
  const { engine, editor, history, rig, assets, player, input, scene, viewport } = app;

  /**
   * Save the whole game — every level — as one .json file, with its models,
   * imported textures and sound files inside it. (It used to name them by an id
   * in this browser's storage only, so the file opened anywhere else, or after
   * clearing the browser, without them.)
   */
  async function saveProject() {
    const data = app.project.toJSON();
    const ids = assetIdsIn(data);
    // one .tiny3 file: the game and its models, images and sounds as the files they are (game-file.js)
    const { blob, missing } = await packGame(data, ids, assetStore);
    for (const id of missing) console.warn('[Tiny3] save: a file this game uses is missing from storage:', id);
    assetStore.markUsed(ids);
    const slug = (engine.ui?.game?.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug || 'tiny3-game'}${GAME_FILE_EXT}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Save, and say so if it fails instead of failing silently. */
  function saveProjectSafely() {
    saveProject().catch((err) => {
      console.error('[Tiny3] save failed:', err);
      alert(`Could not save the game: ${err.message}`);
    });
  }

  /**
   * A game opened from a file with scripts in it: they could be anyone's, and a
   * script can do anything this page can — so they stay off until allowed
   * (script-trust.js). Its scripts are kept as they are, whatever is chosen.
   */
  let scriptsReminded = false;
  function setScriptsAllowed(on) {
    engine.scriptsAllowed = on;
    scriptsReminded = false;
    markDirty(); // remembered across a reload
  }
  /** Playing a game whose scripts are off: said once, with the way to allow them. */
  function remindScriptsOff() {
    if (engine.scriptsAllowed !== false || scriptsReminded) return;
    const count = engine.entities.filter((e) => e.behavior).length;
    if (!count) return;
    scriptsReminded = true;
    showNotice(`${count} script${count === 1 ? ' is' : 's are'} off in this game (it was opened from a file).`, {
      kind: 'warn', seconds: 10, actions: [{ label: 'Allow scripts', run: () => setScriptsAllowed(true) }],
    });
  }

  function askAboutScripts(count) {
    if (!count) { engine.scriptsAllowed = true; return; }
    engine.scriptsAllowed = false;
    showNotice(`This game has ${count} script${count === 1 ? '' : 's'}. A script can do anything this page can — `
      + 'read the other games kept in this browser, or send them anywhere — so they are off until you allow them. '
      + 'Only allow scripts from someone you trust.', {
      kind: 'warn', seconds: 0,
      actions: [{ label: 'Allow scripts', run: () => setScriptsAllowed(true) }, { label: 'Keep them off', run: () => setScriptsAllowed(false) }],
    });
  }

  /** Open a saved game — or a single scene saved before levels existed. */
  function loadProjectFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${GAME_FILE_EXT},.zip,.json,application/json`; // a .tiny3 — or a .json saved before it
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        // the files it carries go into storage first, so its models can load (game-file.js)
        const data = await unpackGame(file, assetStore);
        await app.project.load(data);
        assetStore.markUsed(assetIdsIn(data));
        app.refreshStorage();
        history.clear();
        app.refreshHistoryButtons();
        app.levelsPanel.render();
        // someone else's game, maybe: its scripts off until you say you trust it
        askAboutScripts(countScripts(data));
        markDirty();
      } catch (err) {
        console.error('[Tiny3] could not open file:', err);
        alert(`Could not open that file: ${err.message}`);
      }
    });
    input.click();
  }

  // ---- autosave: the whole game, into the browser's database, shortly after any edit ----
  // (It went to localStorage, which holds about 5 MB: a big game silently stopped
  // being saved, and a refresh lost the work. AUTOSAVE_KEY is where older
  // versions left it; it moves over on the first start.)
  const AUTOSAVE_KEY = 'tiny3.autosave';
  const AUTOSAVE_VERSION_KEY = 'tiny3.autosaveVersion';
  const AUTOSAVE_VERSION = '3'; // bump to clear old default scenes
  let _dirtyTimer = null;
  let autosaveWarned = false;

  // one-time migration: clear autosaves from older versions so the new empty-scene boot applies
  if (localStorage.getItem(AUTOSAVE_VERSION_KEY) !== AUTOSAVE_VERSION) {
    localStorage.removeItem(AUTOSAVE_KEY);
    localStorage.setItem(AUTOSAVE_VERSION_KEY, AUTOSAVE_VERSION);
  }

  /**
   * Ask the browser to keep this site's storage for good — once, when there is
   * a game worth keeping. Unasked, a browser may clear it when the disk is full
   * (and Safari does after 7 days away), taking the autosave and the models.
   */
  function keepStorage() {
    try {
      if (localStorage.getItem('tiny3.askedPersist')) return;
      localStorage.setItem('tiny3.askedPersist', '1');
    } catch (_) { return; }
    navigator.storage?.persisted?.().then((kept) => { if (!kept) navigator.storage.persist?.(); }).catch(() => {});
  }

  async function writeAutosave() {
    const data = app.project.toJSON();
    if (engine.scriptsAllowed === false) data.scriptsOff = true; // still not trusted after a reload
    await savedGames.put('autosave', JSON.stringify(data)); // every level
    assetStore.markUsed(assetIdsIn(data)); // still needed: cleanup leaves these alone
    if (data.levels.some((l) => l.scene?.entities?.length)) keepStorage();
  }

  function autosave() {
    _dirtyTimer = null;
    writeAutosave().catch((err) => {
      console.warn('[Tiny3] autosave failed:', err);
      if (autosaveWarned) return;
      autosaveWarned = true; // once: a notice on every edit would be worse than none
      showNotice(`Autosave failed (${err.message || err}). Use 💾 Save to keep your game in a file.`,
        { kind: 'error', seconds: 0, actions: [{ label: 'Save now', run: () => saveProjectSafely() }, { label: 'Later' }] });
    });
  }

  function markDirty() {
    if (app.isPlaying()) return; // play-mode changes are temporary — don't save them
    clearTimeout(_dirtyTimer);
    _dirtyTimer = setTimeout(autosave, 1500);
  }

  // closing or leaving the tab doesn't wait the 1.5 s: what was just changed is saved now
  const flushAutosave = () => {
    if (!_dirtyTimer) return;
    clearTimeout(_dirtyTimer);
    autosave();
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushAutosave(); });
  window.addEventListener('pagehide', flushAutosave);

  // any field edit in any panel (inspector, camera, controls) marks dirty
  document.addEventListener('input', () => markDirty(), true);

  Object.assign(app, { remindScriptsOff, saveProject, saveProjectSafely, loadProjectFile, askAboutScripts, setScriptsAllowed, markDirty, keepStorage, AUTOSAVE_KEY });
}
