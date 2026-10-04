import { showNotice } from '../ui.js';
import { run as runExpr, varScope, asText, truthy } from '../expr.js';
import { Engine } from '../engine.js';
import { escapeHtml } from '../editor.js';
import { injectStyle as injectOverlayStyle } from '../play-overlay.js';
import { assetStore } from '../assets-db.js';
import { HUD_STYLES, HUD_STYLE_LABELS, normalizeUI, HUD_PLACES, HUD_LAYOUTS, HUD_LAYOUT_LABELS, HUD_FONTS, HUD_FONT_LABELS, normalizeHudLook, hudItems, hudHtml, CROSSHAIR_STYLES, CROSSHAIR_SHOW, normalizeCrosshair, crosshairSvg } from '../game-ui.js';

/**
 * The Game panel: its variables (and how each shows on screen), its name and icon, the title
 * screen, touch movement, the crosshair, and how the variables look on screen.
 *
 * Moved out of game.js as it was; it reaches the rest of the editor through `app`
 * (game.js): the engine, editor and history — and what other parts offer (app.markDirty…).
 */
// ---- what a variable holds: a number, text, yes or no, a list, a record ----
const VAR_TYPES = ['number', 'text', 'yes/no', 'list', 'record'];
const VAR_TYPE_LABELS = { number: 'Number', text: 'Text', 'yes/no': 'Yes / no', list: 'List', record: 'Record' };
const typeOfValue = (v) => (Array.isArray(v) ? 'list' : v && typeof v === 'object' ? 'record'
  : typeof v === 'boolean' ? 'yes/no' : typeof v === 'string' ? 'text' : 'number');
/** A list or a record as it is typed: [ "sword", 2 ]  ·  { stage: 1, giver: "Gran" } */
const literal = (v) => (Array.isArray(v) ? `[${v.map(literal).join(', ')}]`
  : v && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${literal(x)}`).join(', ')}}`
    : typeof v === 'string' ? JSON.stringify(v) : String(v));
/** The field its starting value is typed into, for its kind. */
function valueEditor(v) {
  const t = typeOfValue(v);
  if (t === 'number') return `<input type="number" data-var-value value="${escapeHtml(v)}" step="any" title="Starting value" />`;
  if (t === 'yes/no') return `<select data-var-value title="Starting value"><option value="true" ${v ? 'selected' : ''}>yes</option><option value="false" ${v ? '' : 'selected'}>no</option></select>`;
  if (t === 'text') return `<input type="text" data-var-value value="${escapeHtml(v)}" spellcheck="false" title="Starting text" />`;
  const hint = t === 'list' ? 'Its starting items, in [ ]: ["sword", "potion"] — or [] for none'
    : 'Its starting fields, in { }: {stage: 1, giver: "Gran"}';
  return `<input type="text" data-var-value class="var-literal" value="${escapeHtml(literal(v))}" spellcheck="false" title="${escapeHtml(hint)}" />`;
}
/** What was typed, as a value of its kind (a list or record that doesn't read: as it was). */
function readValue(el, type) {
  const raw = el.value;
  if (type === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : 0; }
  if (type === 'yes/no') return raw === 'true';
  if (type === 'text') return raw;
  try {
    const v = runExpr(raw.trim() || (type === 'list' ? '[]' : '{}'), varScope(null));
    if (type === 'list') return Array.isArray(v) ? v : [v];
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (err) {
    showNotice(`That ${type} doesn't read: ${err.message}`, { kind: 'warn', seconds: 6 });
    return type === 'list' ? [] : {};
  }
}
/** A value turned into another kind, keeping what it can. */
function convertValue(v, type) {
  if (type === 'number') { const n = Number(Array.isArray(v) ? v.length : v); return Number.isFinite(n) ? n : 0; }
  if (type === 'text') return asText(v);
  if (type === 'yes/no') return truthy(v);
  if (type === 'list') return Array.isArray(v) ? v : (v === '' || v === 0 || v === false ? [] : [v]);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

export function wireGamePanel(app) {
  const { engine, editor, history, rig, assets, player, input, scene, viewport } = app;

  // ---- game variables: score, lives, anything a rule needs to remember ----
  const varList = document.getElementById('var-list');
  const varLookOpen = new Set(); // the variables whose ⚙ (own label, place, colour, size) is open

  /** Change how one variable looks on screen (undoable, saved with the game). */
  function setVarLook(name, patch) {
    const was = engine.ui.hud[name] ? { ...engine.ui.hud[name] } : null;
    const next = { show: 'number', ...(was || {}), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === false) delete next[k];
    const now = normalizeUI({ hud: { [name]: next } }).hud[name];
    if (JSON.stringify(was ?? { show: 'number' }) === JSON.stringify(now)) return;
    const set = (v) => {
      if (v) engine.ui.hud[name] = { ...v };
      else delete engine.ui.hud[name];
      renderVariables();
      app.markDirty();
    };
    history.push({ label: `${name} on screen`, undo: () => set(was), redo: () => set(now) });
    set(now);
  }

  function renderVariables() {
    if (!varList) return;
    const names = Object.keys(engine.variables.toJSON());
    varList.innerHTML = names.length ? '' : '<div class="empty">No variables yet.</div>';
    const hud = engine.ui.hud;
    const look = engine.ui.hudLook;
    for (const name of names) {
      const style = hud[name] || { show: 'number' };
      // a bar or hearts: of a number only — text, a list, a record show as they read
      const numeric = typeOfValue(engine.variables.initial[name]) === 'number';
      const withMax = numeric && (style.show === 'bar' || style.show === 'hearts');
      const open = varLookOpen.has(name);
      const own = !!(style.at || style.color || style.size || style.label || style.noLabel);
      const row = document.createElement('div');
      row.className = 'var-row';
      row.innerHTML = `
        <input type="text" data-var-name value="${escapeHtml(name)}" spellcheck="false" title="Name — start it with _ to keep it off the screen" />
        <select data-var-type title="What it holds: a number, text, yes or no, a list (an inventory), a record (named values: a quest)">${
          VAR_TYPES.map((t) => `<option value="${t}" ${t === typeOfValue(engine.variables.initial[name]) ? 'selected' : ''}>${VAR_TYPE_LABELS[t]}</option>`).join('')}</select>
        <select data-var-show title="How it shows on screen while playing">${(numeric ? HUD_STYLES : ['number', 'hidden']).map((s) =>
          `<option value="${s}" ${s === style.show ? 'selected' : ''}>${numeric || s !== 'number' ? HUD_STYLE_LABELS[s] : 'As text'}</option>`).join('')}</select>
        <button class="gp-x var-look-btn${open ? ' open' : ''}${own ? ' own' : ''}" title="Its own label, place on screen, colour and size">⚙</button>
        <button class="gp-x" data-var-del title="Delete">×</button>
        <div class="var-value">${valueEditor(engine.variables.initial[name])}</div>
        ${withMax ? `<label class="var-max">${style.show === 'bar' ? 'Full at' : 'Hearts'}
          <input type="number" min="1" max="1000" step="1" value="${style.max ?? 3}" /></label>` : ''}
        ${open ? `<div class="var-look">
          <div class="prop-row"><label title="What it is called on screen (its name if empty)">Label</label>
            <input type="text" data-vl="label" value="${escapeHtml(style.label ?? '')}" placeholder="${escapeHtml(name)}" spellcheck="false" maxlength="40" /></div>
          <label class="check-row" title="Off: just the value — hearts, a bar or a number on their own"><input type="checkbox" data-vl="named" ${style.noLabel ? '' : 'checked'} /> Show its label</label>
          <div class="prop-row"><label title="Where on the screen — with the others, or a place of its own">Place</label>
            <select data-vl="at"><option value="">with the others (${look.at})</option>${HUD_PLACES.map((p) =>
              `<option value="${p}" ${p === style.at ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
          <div class="prop-row"><label title="Its value's colour (and its bar's, its hearts')">Colour</label>
            <input type="color" data-vl="color" value="${style.color || look.color}" />
            ${style.color ? '<button class="gp-x" data-vl-reset="color" title="Back to the HUD\'s colour">↺</button>' : '<span class="val">the HUD\'s</span>'}</div>
          <div class="prop-row"><label title="Its text size in pixels (empty: the HUD's)">Size</label>
            <input type="number" data-vl="size" min="8" max="96" step="1" value="${style.size ?? ''}" placeholder="${look.size}" /></div>
        </div>` : ''}`;
      const nameEl = row.querySelector('[data-var-name]');
      const valueEl = row.querySelector('[data-var-value]');
      const typeEl = row.querySelector('[data-var-type]');
      const styleEl = row.querySelector('[data-var-show]');
      // its type: the value turned into one of that kind (5 → "5" → 5…)
      typeEl.addEventListener('change', () => {
        engine.variables.define(name, convertValue(engine.variables.initial[name], typeEl.value));
        renderVariables();
        app.markDirty();
      });
      const maxEl = row.querySelector('.var-max input');
      row.querySelector('.var-look-btn').addEventListener('click', () => {
        if (open) varLookOpen.delete(name);
        else varLookOpen.add(name);
        renderVariables();
      });
      for (const el of row.querySelectorAll('[data-vl]')) {
        el.addEventListener('change', () => {
          const key = el.dataset.vl;
          if (key === 'named') setVarLook(name, { noLabel: !el.checked });
          else if (key === 'size') setVarLook(name, { size: Number(el.value) || undefined });
          else setVarLook(name, { [key]: el.value.trim() || undefined });
        });
      }
      row.querySelector('[data-vl-reset]')?.addEventListener('click', () => setVarLook(name, { color: undefined }));

      nameEl.addEventListener('change', () => {
        const next = nameEl.value.trim();
        if (!next || next === name) { nameEl.value = name; return; }
        const value = engine.variables.initial[name];
        engine.variables.remove(name);
        engine.variables.define(next, value);
        if (hud[name]) { hud[next] = hud[name]; delete hud[name]; } // its look goes with it
        renderVariables();
        app.markDirty();
      });
      valueEl.addEventListener('change', () => {
        engine.variables.define(name, readValue(valueEl, typeOfValue(engine.variables.initial[name])));
        renderVariables();
        app.markDirty();
      });
      styleEl.addEventListener('change', () => {
        const show = styleEl.value;
        if (show === 'number') {
          // its own label, place, colour and size stay
          const { max, ...rest } = hud[name] || {};
          hud[name] = { ...rest, show };
        } else {
          const start = Math.round(Number(engine.variables.initial[name]) || 0);
          hud[name] = { ...(hud[name] || {}), show, max: hud[name]?.max ?? Math.max(1, start || 3) };
        }
        engine.ui = normalizeUI(engine.ui);
        renderVariables();
        app.markDirty();
      });
      maxEl?.addEventListener('change', () => {
        hud[name].max = Math.max(1, Math.min(1000, Math.round(Number(maxEl.value) || 1)));
        maxEl.value = hud[name].max;
        app.markDirty();
      });
      row.querySelector('[data-var-del]').addEventListener('click', () => {
        engine.variables.remove(name);
        delete hud[name];
        renderVariables();
        app.markDirty();
      });
      varList.appendChild(row);
    }
    drawHudPreview();
  }

  // ---- title screen (Game panel) ----
  const TITLE_FIELDS = {
    enabled: 'ui-title-on', text: 'ui-title-text', subtitle: 'ui-title-sub',
    prompt: 'ui-title-prompt', inEditor: 'ui-title-editor',
  };
  // ---- the game's name and icon (Game panel): its browser tab, loading screen and exported files ----
  const gameNameEl = document.getElementById('ui-game-name');
  const gameIconEl = document.getElementById('ui-game-icon');
  const iconImageBtn = document.getElementById('ui-game-icon-image');
  const iconClearBtn = document.getElementById('ui-game-icon-clear');

  function syncGameIdentity() {
    const g = engine.ui.game;
    if (gameNameEl) gameNameEl.value = g.name;
    if (gameIconEl) {
      gameIconEl.value = g.icon;
      gameIconEl.disabled = !!g.iconAsset; // an image is the icon
    }
    if (iconImageBtn) iconImageBtn.textContent = g.iconAsset ? `🖼 ${g.iconAsset.name.slice(0, 14)}` : 'Image…';
    if (iconClearBtn) iconClearBtn.hidden = !g.iconAsset;
    document.title = g.name ? `${g.name} — Tiny3 Editor` : 'Tiny3 Engine — Editor';
  }

  /** Change the game's name or icon (undoable, saved with the game). */
  function setGameIdentity(patch, label) {
    const before = { ...engine.ui.game };
    const after = { ...before, ...patch };
    const apply = (v) => {
      engine.ui = normalizeUI({ ...engine.ui, game: v });
      syncGameIdentity();
      app.markDirty();
    };
    if (JSON.stringify(before) === JSON.stringify(normalizeUI({ game: after }).game)) return;
    history.push({ label, undo: () => apply(before), redo: () => apply(after) });
    apply(after);
  }
  gameNameEl?.addEventListener('change', () => setGameIdentity({ name: gameNameEl.value.trim() }, 'game name'));
  gameIconEl?.addEventListener('change', () => setGameIdentity({ icon: gameIconEl.value.trim() || '🎮' }, 'game icon'));
  iconClearBtn?.addEventListener('click', () => setGameIdentity({ iconAsset: undefined }, 'game icon'));
  iconImageBtn?.addEventListener('click', () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/png,image/svg+xml,image/x-icon,image/webp,image/jpeg';
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0];
      if (!file) return;
      const meta = await assetStore.put(file, { kind: 'icon' });
      setGameIdentity({ iconAsset: { assetId: meta.id, name: file.name } }, 'game icon');
    });
    picker.click();
  });



  function syncTitleUI() {
    app.languagesPanel?.refresh(); // a loaded game brings its own languages
    syncGameIdentity(); // the game's name and icon come with the same settings
    renderCrosshairUI(); // the same game settings: its crosshair too
    renderHudLookUI(); // ...and how its variables look on screen
    const touchMove = document.getElementById('ui-touch-move');
    if (touchMove) touchMove.value = engine.ui.touch?.move ?? 'joystick';
    for (const [key, id] of Object.entries(TITLE_FIELDS)) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!engine.ui.title[key];
      else el.value = engine.ui.title[key] ?? '';
    }
  }
  for (const [key, id] of Object.entries(TITLE_FIELDS)) {
    const el = document.getElementById(id);
    el?.addEventListener('change', () => {
      engine.ui.title[key] = el.type === 'checkbox' ? el.checked : el.value;
      app.markDirty();
    });
  }
  // touch screens move the player with a joystick or a D-pad (undoable, saved with the game)
  document.getElementById('ui-touch-move')?.addEventListener('change', (e) => {
    const before = engine.ui.touch?.move ?? 'joystick';
    const after = e.target.value;
    const set = (v) => {
      engine.ui = normalizeUI({ ...engine.ui, touch: { move: v } });
      e.target.value = v;
      app.markDirty();
    };
    if (before !== after) history.push({ label: 'touch movement', undo: () => set(before), redo: () => set(after) });
    set(after);
  });
  document.getElementById('ui-title-preview')?.addEventListener('click', () =>
    app.overlay.titleScreen({ ...engine.ui.title, text: engine.ui.title.text || 'My Game' }));

  // ---- crosshair (Game panel): how the aiming mark looks, and when it shows ----
  const CROSSHAIR_FIELDS = [
    { key: 'style', label: 'Style', options: CROSSHAIR_STYLES },
    { key: 'show', label: 'Show', options: CROSSHAIR_SHOW },
    { key: 'size', label: 'Size', min: 2, max: 96, step: 1 },
    { key: 'thickness', label: 'Thickness', min: 1, max: 12, step: 0.5 },
    { key: 'gap', label: 'Gap', min: 0, max: 40, step: 1 },
    { key: 'opacity', label: 'Opacity', min: 0.05, max: 1, step: 0.05 },
    { key: 'color', label: 'Colour', type: 'color' },
    { key: 'outline', label: 'Dark outline (shows on anything)', type: 'boolean' },
  ];
  const crosshairEl = document.getElementById('ui-crosshair');
  function renderCrosshairUI() {
    if (!crosshairEl) return;
    const c = normalizeCrosshair(engine.ui.crosshair);
    engine.ui.crosshair = c;
    crosshairEl.innerHTML = `<div class="xh-preview" title="How it looks in the game">${crosshairSvg(c)}</div>${CROSSHAIR_FIELDS.map((f) => {
      if (f.options) {
        return `<div class="prop-row"><label>${f.label}</label><select data-xh="${f.key}">${
          f.options.map((o) => `<option value="${o}" ${o === c[f.key] ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
      }
      if (f.type === 'boolean') return `<label class="check-row"><input type="checkbox" data-xh="${f.key}" ${c[f.key] ? 'checked' : ''}/> ${f.label}</label>`;
      if (f.type === 'color') return `<div class="prop-row"><label>${f.label}</label><input type="color" data-xh="${f.key}" value="${c[f.key]}" /></div>`;
      return `<div class="prop-row"><label>${f.label}</label><input type="range" data-xh="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${c[f.key]}" />
        <span class="val">${c[f.key]}</span></div>`;
    }).join('')}`;
    for (const el of crosshairEl.querySelectorAll('[data-xh]')) {
      const key = el.dataset.xh;
      let before = engine.ui.crosshair[key];
      const read = () => (el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value);
      el.addEventListener('input', () => {
        if (el.type === 'checkbox') return;
        engine.ui.crosshair = normalizeCrosshair({ ...engine.ui.crosshair, [key]: read() });
        crosshairEl.querySelector('.xh-preview').innerHTML = crosshairSvg(engine.ui.crosshair);
        const val = el.parentElement.querySelector('.val');
        if (val) val.textContent = String(read());
      });
      el.addEventListener('change', () => {
        const after = read();
        const set = (v) => {
          engine.ui.crosshair = normalizeCrosshair({ ...engine.ui.crosshair, [key]: v });
          renderCrosshairUI();
          app.markDirty();
        };
        const was = before;
        if (was !== after) history.push({ label: `crosshair ${key}`, undo: () => set(was), redo: () => set(after) });
        before = after;
        set(after);
      });
    }
  }
  // ---- variables on screen (Game panel): where the HUD sits and how it looks ----
  const HUD_LOOK_FIELDS = [
    { key: 'at', label: 'Place', options: HUD_PLACES, tip: 'Where on the screen (a variable can have a place of its own: its ⚙)' },
    { key: 'x', label: 'Nudge across', min: -600, max: 600, step: 1, tip: 'Pixels to the right (−: to the left)' },
    { key: 'y', label: 'Nudge down', min: -400, max: 400, step: 1, tip: 'Pixels down (−: up)' },
    { key: 'layout', label: 'Arrange', options: HUD_LAYOUTS, labels: HUD_LAYOUT_LABELS },
    { key: 'font', label: 'Font', options: Object.keys(HUD_FONTS), labels: HUD_FONT_LABELS },
    { key: 'size', label: 'Text size', min: 8, max: 72, step: 1 },
    { key: 'color', label: 'Value colour', type: 'color' },
    { key: 'labelColor', label: 'Label colour', type: 'color' },
    { key: 'upper', label: 'Labels in CAPITALS', type: 'boolean' },
    { key: 'bold', label: 'Bold values', type: 'boolean' },
    { key: 'shadow', label: 'Text shadow (reads on any background)', type: 'boolean' },
    { key: 'background', label: 'Background', type: 'color' },
    { key: 'opacity', label: 'Background opacity', min: 0, max: 1, step: 0.05, tip: '0: no box behind them' },
    { key: 'border', label: 'Border', type: 'boolean' },
    { key: 'borderColor', label: 'Border colour', type: 'color' },
    { key: 'radius', label: 'Rounded corners', min: 0, max: 40, step: 1 },
  ];
  const hudLookEl = document.getElementById('ui-hud-look');

  /** The preview: the game's variables (at their starting values) on a little screen. */
  function drawHudPreview() {
    const el = hudLookEl?.querySelector('.hud-preview-screen');
    if (!el) return;
    const items = hudItems(engine.variables.toJSON(), engine.ui.hud);
    el.innerHTML = items.length ? hudHtml(items, engine.ui.hudLook, { esc: escapeHtml })
      : '<div class="hud-preview-empty">Add a variable to see it here</div>';
  }

  function renderHudLookUI() {
    if (!hudLookEl) return;
    injectOverlayStyle(); // the preview is drawn as the game draws it
    const c = normalizeHudLook(engine.ui.hudLook);
    engine.ui.hudLook = c;
    hudLookEl.innerHTML = `<div class="hud-preview" title="How the variables look in the game (half size)"><div class="hud-preview-screen"></div></div>${HUD_LOOK_FIELDS.map((f) => {
      const tip = f.tip ? ` title="${escapeHtml(f.tip)}"` : '';
      if (f.options) {
        return `<div class="prop-row"><label${tip}>${f.label}</label><select data-hl="${f.key}">${
          f.options.map((o) => `<option value="${o}" ${o === c[f.key] ? 'selected' : ''}>${escapeHtml(f.labels?.[o] ?? o)}</option>`).join('')}</select></div>`;
      }
      if (f.type === 'boolean') return `<label class="check-row"${tip}><input type="checkbox" data-hl="${f.key}" ${c[f.key] ? 'checked' : ''}/> ${f.label}</label>`;
      if (f.type === 'color') return `<div class="prop-row"><label${tip}>${f.label}</label><input type="color" data-hl="${f.key}" value="${c[f.key]}" /></div>`;
      return `<div class="prop-row"><label${tip}>${f.label}</label><input type="range" data-hl="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${c[f.key]}" />
        <span class="val">${c[f.key]}</span></div>`;
    }).join('')}`;
    drawHudPreview();
    for (const el of hudLookEl.querySelectorAll('[data-hl]')) {
      const key = el.dataset.hl;
      let before = engine.ui.hudLook[key];
      const read = () => (el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value);
      el.addEventListener('input', () => { // live, in the preview and in Play
        if (el.type === 'checkbox') return;
        engine.ui.hudLook = normalizeHudLook({ ...engine.ui.hudLook, [key]: read() });
        drawHudPreview();
        const val = el.parentElement.querySelector('.val');
        if (val) val.textContent = String(read());
      });
      el.addEventListener('change', () => {
        const after = read();
        const set = (v) => {
          engine.ui.hudLook = normalizeHudLook({ ...engine.ui.hudLook, [key]: v });
          renderHudLookUI();
          if (key === 'at' || key === 'color' || key === 'size') renderVariables(); // the ⚙ rows show the HUD's
          app.markDirty();
        };
        const was = before;
        if (was !== after) history.push({ label: `variables on screen: ${key}`, undo: () => set(was), redo: () => set(after) });
        before = after;
        set(after);
      });
    }
  }
  renderCrosshairUI();
  syncTitleUI(); // renders the HUD look too: after it is set up above

  document.getElementById('var-add')?.addEventListener('click', () => {
    const existing = Object.keys(engine.variables.toJSON());
    let name = 'score';
    let i = 2;
    while (existing.includes(name)) name = `score${i++}`;
    engine.variables.define(name, 0);
    renderVariables();
    app.markDirty();
  });
  renderVariables();

  Object.assign(app, { renderVariables, syncTitleUI, renderCrosshairUI, renderHudLookUI, syncGameIdentity, setGameIdentity, drawHudPreview });
}
