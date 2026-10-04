import { escapeHtml } from '../editor.js';
import { defaultControls } from '../controls.js';
import { MIX_DEFAULTS } from '../sound.js';
import { assetStore } from '../assets-db.js';
import { TEMPLATES } from '../templates.js';
import { normalizeUI } from '../game-ui.js';
import { t } from '../i18n.js';

/**
 * New: an empty game, or one of the templates (its model files brought into the game).
 *
 * Moved out of game.js as it was; it reaches the rest of the editor through `app`
 * (game.js): the engine, editor and history — and what other parts offer (app.markDirty…).
 */
export function wireNewGame(app) {
  const { engine, editor, history, rig, assets, player, input, scene, viewport } = app;

  // ---- New game: empty, or one of the templates ----
  const newDialog = document.getElementById('new-dialog');
  const tplGrid = document.getElementById('tpl-grid');

  function openNewDialog() {
    tplGrid.innerHTML = [
      { id: 'empty', emoji: '⬜', name: 'Empty', blurb: 'Nothing but daylight and a grid. Build from scratch.', keys: 'WASD / arrows · Space' },
      ...TEMPLATES,
    ].map((t) => `
      <button class="tpl-card" data-template="${t.id}">
        <span class="tpl-emoji">${t.emoji}</span>
        <span class="tpl-name">${escapeHtml(t.name)}</span>
        <span class="tpl-blurb">${escapeHtml(t.blurb)}</span>
        <span class="tpl-keys">${escapeHtml(t.keys)}</span>
      </button>`).join('');
    newDialog.hidden = false;
    tplGrid.querySelector('.tpl-card')?.focus();
  }
  const closeNewDialog = () => { newDialog.hidden = true; };

  /**
   * A template's models are named by their files (assetUrl, e.g. assets/robot.glb).
   * Brought into this game's own store, as if imported with + GLB, so the game
   * saves and exports with them inside. A file that can't be fetched is left as
   * it was (loaded from its URL, if it can be).
   */
  async function storeTemplateModels(game) {
    const stored = new Map(); // url -> asset id
    for (const level of game.levels || []) {
      for (const e of level.scene?.entities || []) {
        if (e.type !== 'model' || !e.assetUrl || e.assetId) continue;
        if (!stored.has(e.assetUrl)) {
          try {
            const res = await fetch(e.assetUrl);
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            const blob = await res.blob();
            const name = e.assetUrl.split('/').pop();
            stored.set(e.assetUrl, (await assetStore.put(new File([blob], name, { type: 'model/gltf-binary' }), { kind: 'model' })).id);
          } catch (err) {
            console.warn('[Tiny3] template model not found, loading it by its URL:', e.assetUrl, err);
            stored.set(e.assetUrl, null);
          }
        }
        const id = stored.get(e.assetUrl);
        if (id) {
          e.assetId = id;
          delete e.assetUrl;
        }
      }
    }
    return game;
  }

  /** Replace the open game with an empty one or a template. */
  async function startNewGame(id) {
    closeNewDialog();
    if (app.isPlaying()) await app.exitPlay();
    engine.scriptsAllowed = true; // a new game, or one of ours: its scripts run
    if (id === 'empty') { wipeToEmpty(); return; }
    const template = TEMPLATES.find((t) => t.id === id);
    if (!template) return;
    try {
      editor.select(null);
      await app.project.load(await storeTemplateModels(template.build()));
      history.clear();
      app.refreshHistoryButtons();
      app.levelsPanel.render();
      app.markDirty();
    } catch (err) {
      console.error('[Tiny3] could not open template:', err);
      alert(`Could not open the template: ${err.message}`);
    }
  }

  document.getElementById('btn-new').addEventListener('click', openNewDialog);
  document.getElementById('new-cancel').addEventListener('click', closeNewDialog);
  newDialog.addEventListener('click', (e) => {
    if (e.target === newDialog) { closeNewDialog(); return; } // the backdrop
    const card = e.target.closest?.('[data-template]');
    if (card) startNewGame(card.dataset.template);
  });
  window.addEventListener('keydown', (e) => {
    if (!newDialog.hidden && e.code === 'Escape') closeNewDialog();
  });

  /** An empty game: one empty level, daylight, default controls, silence. */
  function wipeToEmpty() {
    // remove all selectable entities
    for (const e of [...editor.selectables]) {
      editor.removeEntity(e, { record: false });
    }
    editor.select(null);
    editor._renderHierarchy();
    app.refreshCamTargets();
    app.refreshControlTargets();
    engine.environment.load(); // a new scene starts in daylight
    app.envPanel.refresh();
    engine.gameplay.controls.load(defaultControls()); // ...and with WASD, Space and a D-pad
    app.controlsPanel.render();
    engine.materialLibrary.clear(); // ...no saved materials...
    engine.audio.clear(); // ...and silence: no scene music, a flat mix
    engine.audio.setMix(MIX_DEFAULTS);
    app.syncMixUI();
    app.renderSceneAudio();
    history.clear();
    app.refreshHistoryButtons();
    app.project.reset(); // ...and one level
    app.levelsPanel.render();
    rig.playMode = null;
    engine.ui = normalizeUI(); // no title screen, plain HUD
    app.syncTitleUI();
    app.renderVariables();
    app.renderScreensPanel?.();
    localStorage.removeItem(app.AUTOSAVE_KEY);
    app.markDirty();
  }

  Object.assign(app, { openNewDialog, startNewGame, wipeToEmpty, storeTemplateModels });
}
