import { escapeHtml } from '../editor.js';
import { assetStore } from '../assets-db.js';
import { assetIdsIn } from '../asset-refs.js';
import { t } from '../i18n.js';

/**
 * The asset browser: the game's prefabs (place a copy, delete), saving one, and the files
 * stored in this browser (how much, and cleaning up what nothing uses).
 *
 * Moved out of game.js as it was; it reaches the rest of the editor through `app`
 * (game.js): the engine, editor and history — and what other parts offer (app.markDirty…).
 */
export function wireAssetBrowser(app) {
  const { engine, editor, history, rig, assets, player, input, scene, viewport } = app;

  // ---- asset browser: prefabs and reusable assets ----
  const assetList = document.getElementById('asset-list');
  const btnSavePrefab = document.getElementById('btn-save-prefab');

  // ---- stored files: models, imported textures and sounds live in this browser ----
  /** Startup cleanup only touches files nothing has needed for this long. */
  const UNUSED_FOR = 30 * 24 * 60 * 60 * 1000;

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Every stored file something still wants: any level of the open game, its
   * prefabs, and whatever Undo or the clipboard could bring back.
   */
  function assetsWanted() {
    return new Set([...assetIdsIn(app.project.toJSON()), ...editor.assetIdsInUse()]);
  }

  const storageText = document.getElementById('asset-storage-text');
  const cleanBtn = document.getElementById('btn-clean-assets');
  let storageUnused = [];
  /** "Stored in this browser: 12 files · 34 MB", and what cleaning up would free. */
  async function refreshStorage() {
    if (!storageText) return;
    const all = await assetStore.list();
    const wanted = assetsWanted();
    storageUnused = all.filter((m) => !wanted.has(m.id));
    const total = all.reduce((n, m) => n + (m.size || 0), 0);
    const spare = storageUnused.reduce((n, m) => n + (m.size || 0), 0);
    storageText.textContent = all.length
      ? `Stored in this browser: ${all.length} file${all.length === 1 ? '' : 's'} · ${formatBytes(total)}`
        + (storageUnused.length ? ` (${formatBytes(spare)} unused)` : '')
      : 'Nothing stored in this browser yet';
    if (cleanBtn) cleanBtn.disabled = storageUnused.length === 0;
  }
  let storageTimer = null;
  document.getElementById('asset-browser')?.addEventListener('pointerenter', () => {
    clearTimeout(storageTimer);
    storageTimer = setTimeout(() => refreshStorage().catch(() => {}), 150);
  });
  cleanBtn?.addEventListener('click', async () => {
    if (app.isPlaying()) { alert('Stop the game first.'); return; }
    await refreshStorage();
    if (!storageUnused.length) return;
    const n = storageUnused.length;
    const size = formatBytes(storageUnused.reduce((s, m) => s + (m.size || 0), 0));
    const ok = confirm(`Remove ${n} stored file${n === 1 ? '' : 's'} (${size}) that this game doesn't use?`
      + '\n\nGame files saved from now on carry their own models, textures and sounds. '
      + 'Ones saved before this version don\'t — if you still need one, open it first, then clean up.');
    if (!ok) return;
    const { removed, bytes } = await assetStore.prune(assetsWanted());
    console.log(`[Tiny3] removed ${removed} unused file(s), ${formatBytes(bytes)}`);
    await refreshStorage();
  });

  /** How many linked copies of a prefab the whole game holds. */
  function prefabCopies(name) {
    return editor.selectables.filter((e) => e.prefab === name).length + (editor.project?.savedCopies(name) ?? 0);
  }

  function renderAssetBrowser() {
    if (!assetList) return;
    const names = editor.listPrefabs();
    assetList.innerHTML = '';
    if (!names.length) {
      assetList.innerHTML = '<li class="empty">No prefabs yet. Select an object and press 💾 Prefab.</li>';
      return;
    }
    for (const name of names) {
      const n = prefabCopies(name);
      const li = document.createElement('li');
      li.title = 'Click to place a copy';
      li.innerHTML = `<span class="ico">◆</span><span class="nm">${escapeHtml(name)}</span>`
        + `<span class="cnt" title="Linked copies in the game">${n}</span>`
        + '<span class="del" title="Delete prefab">×</span>';
      li.querySelector('.nm').addEventListener('click', () => {
        editor.instantiatePrefab(name).then((created) => { if (created) { renderAssetBrowser(); app.markDirty(); } });
      });
      li.querySelector('.del').addEventListener('click', (e) => {
        e.stopPropagation();
        const copies = prefabCopies(name);
        const note = copies ? `\n\nIts ${copies} cop${copies === 1 ? 'y stays' : 'ies stay'} in the game as ordinary objects.` : '';
        if (!confirm(`Delete the prefab "${name}"?${note}`)) return;
        editor.deletePrefab(name);
        app.markDirty();
      });
      assetList.appendChild(li);
    }
  }

  if (btnSavePrefab) {
    btnSavePrefab.addEventListener('click', () => {
      const sel = editor.selected;
      if (!sel) { alert('Select an object first.'); return; }
      if (sel.prefab && engine.prefabs.has(sel.prefab)) {
        alert(`This is already a copy of "${sel.prefab}". Use Apply to all in the Inspector to update the prefab.`);
        return;
      }
      const name = prompt('Prefab name:', sel.object3D.name || 'Prefab');
      if (!name) return;
      const saved = editor.saveAsPrefab(name);
      if (!saved) { alert('The player can’t be a prefab.'); return; }
      app.markDirty();
    });
  }

  // the list follows the library: saved, deleted, loaded with a level or a file
  engine.prefabs.onChange = () => renderAssetBrowser();
  renderAssetBrowser();
  // apply / revert / unlink changed the copies: recount and save
  editor.onPrefabsChanged = () => { renderAssetBrowser(); app.markDirty(); };
  // "+ Bind" on an animation clip adds a control: show it in the Controls panel
  editor.onControlsChanged = () => { app.controlsPanel.render(); app.markDirty(); };
  // "Preview in first person" for an object held in view
  editor.onPreviewFirstPerson = () => app.setCamMode('fps');
  // any edit can make (or undo) a copy's own change, so re-check the Prefab box
  let prefabStatusTimer = null;
  const refreshPrefabStatusSoon = () => {
    clearTimeout(prefabStatusTimer);
    prefabStatusTimer = setTimeout(() => editor.refreshPrefabStatus(), 120);
  };
  document.addEventListener('change', refreshPrefabStatusSoon, true);
  document.addEventListener('input', refreshPrefabStatusSoon, true);

  Object.assign(app, { refreshStorage, renderAssetBrowser, refreshPrefabStatusSoon, assetsWanted, formatBytes, UNUSED_FOR });
}
