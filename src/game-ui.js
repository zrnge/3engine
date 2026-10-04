import { normalizeLanguages } from './i18n.js';
import { asText } from './expr.js';
import { normalizeScreens, normalizeDialogues } from './screens.js';

/**
 * Game UI settings — what the player sees besides the world, stored with the
 * game (shared by every level):
 *
 *   { title: { enabled, text, subtitle, prompt, inEditor },
 *     hud:   { lives: { show: 'hearts', max: 3 }, health: { show: 'bar', max: 100 }, ... },
 *     crosshair: { style, show, size, thickness, gap, color, opacity, outline } }
 *
 * A variable with no HUD entry shows as a number; one whose name starts with
 * `_` never shows. Drawn by PlayOverlay, in Play mode and in exported games.
 */

export const HUD_STYLES = ['number', 'bar', 'hearts', 'hidden'];
export const HUD_STYLE_LABELS = { number: 'Number', bar: 'Bar', hearts: 'Hearts', hidden: 'Hidden' };

/**
 * How the variables look on screen (ui.hudLook), for the whole game: where
 * they sit, nudged by x / y px (right and down), side by side or one under
 * another, the font, its size and colours, the box behind them. A variable
 * can have a place, colour and size of its own (ui.hud[name].at / color / size)
 * — variables put in the same place share a box.
 */
export const HUD_PLACES = ['top center', 'top left', 'top right', 'middle left', 'middle right', 'bottom left', 'bottom center', 'bottom right'];
export const HUD_LAYOUTS = ['auto', 'row', 'column'];
export const HUD_LAYOUT_LABELS = { auto: 'Auto (across at the top and bottom, down the sides)', row: 'Side by side', column: 'One under another' };
// no web fonts: an exported game plays offline
export const HUD_FONTS = {
  // single quotes inside: these go in a style="…" attribute
  system: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  rounded: "'Trebuchet MS', 'Segoe UI', system-ui, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, Consolas, 'Courier New', monospace",
  heavy: "Impact, 'Arial Black', system-ui, sans-serif",
};
export const HUD_FONT_LABELS = { system: 'Plain', rounded: 'Rounded', serif: 'Serif', mono: 'Monospace', heavy: 'Heavy' };
export const HUD_LOOK_DEFAULTS = Object.freeze({
  at: 'top center', x: 0, y: 0, layout: 'auto', font: 'system', size: 14,
  color: '#4dd0a6', labelColor: '#8b949e', upper: true, bold: true,
  background: '#0d1117', opacity: 0.78, border: true, borderColor: '#4dd0a6', radius: 8, shadow: false,
});

const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v, d) => (HEX.test(v ?? '') ? v.toLowerCase() : d);

export function normalizeHudLook(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const D = HUD_LOOK_DEFAULTS;
  const bool = (v, d) => (v === undefined ? d : !!v);
  return {
    at: HUD_PLACES.includes(c.at) ? c.at : D.at,
    x: num(c.x, -2000, 2000, D.x),
    y: num(c.y, -2000, 2000, D.y),
    layout: HUD_LAYOUTS.includes(c.layout) ? c.layout : D.layout,
    font: Object.hasOwn(HUD_FONTS, c.font ?? '') ? c.font : D.font,
    size: num(c.size, 8, 72, D.size),
    color: hex(c.color, D.color),
    labelColor: hex(c.labelColor, D.labelColor),
    upper: bool(c.upper, D.upper),
    bold: bool(c.bold, D.bold),
    background: hex(c.background, D.background),
    opacity: num(c.opacity, 0, 1, D.opacity),
    border: bool(c.border, D.border),
    borderColor: hex(c.borderColor, D.borderColor),
    radius: num(c.radius, 0, 40, D.radius),
    shadow: bool(c.shadow, D.shadow),
  };
}

export const TITLE_DEFAULTS = Object.freeze({
  enabled: false,
  text: 'My Game',
  subtitle: '',
  prompt: 'Press any key to start',
  inEditor: false, // also in the editor's Play — off, so testing stays quick
});

/**
 * The crosshair: a mark at the middle of the screen to aim with. Off unless a
 * game chooses one — plenty of games have none.
 *   style — none, dot, cross, cross and dot, circle, circle and dot
 *   show  — in first person only, whenever the mouse is captured, or always
 *   size (px across), thickness, gap (cross: the empty middle), colour,
 *   opacity, outline (a dark edge so it shows on bright and dark alike)
 */
export const CROSSHAIR_STYLES = ['none', 'dot', 'cross', 'cross + dot', 'circle', 'circle + dot'];
export const CROSSHAIR_SHOW = ['first person', 'mouse captured', 'always'];
export const CROSSHAIR_DEFAULTS = Object.freeze({
  style: 'none', show: 'first person', size: 18, thickness: 2, gap: 4, color: '#ffffff', opacity: 0.9, outline: true,
});

const str = (v, d) => (typeof v === 'string' ? v.slice(0, 120) : d);
const num = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export function normalizeCrosshair(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const D = CROSSHAIR_DEFAULTS;
  return {
    style: CROSSHAIR_STYLES.includes(c.style) ? c.style : D.style,
    show: CROSSHAIR_SHOW.includes(c.show) ? c.show : D.show,
    size: num(c.size, 2, 96, D.size),
    thickness: num(c.thickness, 1, 12, D.thickness),
    gap: num(c.gap, 0, 40, D.gap),
    color: /^#[0-9a-f]{6}$/i.test(c.color ?? '') ? c.color.toLowerCase() : D.color,
    opacity: num(c.opacity, 0.05, 1, D.opacity),
    outline: c.outline === undefined ? D.outline : !!c.outline,
  };
}

/**
 * Is the crosshair on screen now? `mode` is the camera's; `captured`, whether
 * the mouse is; `aimHides`, whether aiming down the sights has hidden it.
 */
export function crosshairShows(c, { mode, captured, aimHides = false }) {
  if (!c || c.style === 'none' || aimHides) return false;
  if (c.show === 'always') return true;
  if (c.show === 'mouse captured') return !!captured;
  return mode === 'fps';
}

/** The crosshair as an SVG, centred in a square `size + outline` across. */
export function crosshairSvg(raw) {
  const c = normalizeCrosshair(raw);
  if (c.style === 'none') return '';
  const pad = c.thickness + 2;
  const box = c.size + pad * 2;
  const m = box / 2;
  const r = c.size / 2;
  const parts = [];
  if (c.style.startsWith('cross')) {
    const g = Math.min(c.gap, r - 1);
    for (const [x1, y1, x2, y2] of [[m - r, m, m - g, m], [m + g, m, m + r, m], [m, m - r, m, m - g], [m, m + g, m, m + r]]) {
      parts.push({ tag: 'line', attrs: `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`, stroke: true });
    }
  }
  if (c.style.startsWith('circle')) parts.push({ tag: 'circle', attrs: `cx="${m}" cy="${m}" r="${Math.max(1, r - c.thickness / 2)}"`, stroke: true });
  if (c.style === 'dot' || c.style.endsWith('+ dot')) {
    // a dot on its own is a third of Size across; in the middle of a cross or circle, as thick as its lines
    const radius = c.style === 'dot' ? Math.max(1, c.size / 6) : Math.max(1, c.thickness * 0.75);
    parts.push({ tag: 'circle', attrs: `cx="${m}" cy="${m}" r="${radius}"`, fill: true });
  }
  const draw = (color, extra) => parts.map((p) => (p.stroke
    ? `<${p.tag} ${p.attrs} fill="none" stroke="${color}" stroke-width="${c.thickness + extra}" stroke-linecap="round"/>`
    : `<${p.tag} ${p.attrs} fill="${color}" stroke="${extra ? color : 'none'}" stroke-width="${extra}"/>`)).join('');
  const outline = c.outline ? draw('rgba(0,0,0,0.65)', 2) : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="0 0 ${box} ${box}" style="opacity:${c.opacity}">${outline}${draw(c.color, 0)}</svg>`;
}

export function normalizeUI(raw = {}) {
  const r = raw || {};
  const t = r.title || {};
  const title = {
    enabled: !!t.enabled,
    text: str(t.text, TITLE_DEFAULTS.text),
    subtitle: str(t.subtitle, TITLE_DEFAULTS.subtitle),
    prompt: str(t.prompt, TITLE_DEFAULTS.prompt),
    inEditor: !!t.inEditor,
  };
  const crosshair = normalizeCrosshair(r.crosshair);
  // on a touch screen, moving is a joystick (any direction, part way) or a four-button D-pad
  const touch = { move: TOUCH_MOVE.includes(r.touch?.move) ? r.touch.move : 'joystick' };
  // the game's name (its browser tab, its exported files) and its icon: an emoji or an image
  const g = r.game || {};
  const game = {
    name: str(g.name, '').slice(0, 80),
    icon: str(g.icon, '🎮').slice(0, 8) || '🎮',
  };
  if (g.iconAsset?.assetId) game.iconAsset = { assetId: String(g.iconAsset.assetId), name: str(g.iconAsset.name, 'icon') };
  const hud = {};
  for (const [name, c] of Object.entries(r.hud || {})) {
    if (!c || typeof c !== 'object') continue;
    const show = HUD_STYLES.includes(c.show) ? c.show : 'number';
    const entry = { show };
    if (show === 'bar' || show === 'hearts') entry.max = Math.max(1, Math.min(1000, Math.round(Number(c.max) || 3)));
    if (c.label) entry.label = String(c.label).slice(0, 40);
    if (c.noLabel) entry.noLabel = true; // its value alone, no name before it
    // its own place, colour and size, over the HUD's
    if (HUD_PLACES.includes(c.at)) entry.at = c.at;
    if (HEX.test(c.color ?? '')) entry.color = c.color.toLowerCase();
    if (Number(c.size) > 0) entry.size = num(c.size, 8, 96, 14);
    hud[name] = entry;
  }
  const hudLook = normalizeHudLook(r.hudLook);
  // the game's own screens (menus, an inventory) and dialogues (screens.js)
  return { title, hud, hudLook, crosshair, touch, game, languages: normalizeLanguages(r.languages),
    screens: normalizeScreens(r.screens), dialogues: normalizeDialogues(r.dialogues) };
}

/** How a touch screen moves the player: a joystick, or the ▲ ▼ ◀ ▶ buttons of a D-pad. */
export const TOUCH_MOVE = ['joystick', 'dpad'];

/** What the HUD shows, in order: visible variables with their style. */
export function hudItems(values = {}, hud = {}) {
  return Object.keys(values)
    .filter((name) => !name.startsWith('_'))
    .sort()
    .map((name) => {
      const c = hud?.[name] || {};
      return {
        name, label: c.noLabel ? '' : (c.label || name), show: c.show || 'number', max: c.max ?? 3, value: values[name],
        at: c.at || null, color: c.color || null, size: c.size || null,
      };
    })
    .filter((item) => item.show !== 'hidden');
}

const rgba = (hexColor, a) => {
  const n = parseInt(hexColor.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** Where a HUD box goes on screen, as CSS: one of HUD_PLACES, nudged x / y px. */
export function hudPlaceCss(at, x = 0, y = 0) {
  const [v, h] = (HUD_PLACES.includes(at) ? at : HUD_LOOK_DEFAULTS.at).split(' ');
  const css = [];
  let tx = `${x}px`;
  let ty = `${y}px`;
  // top right: below a game's own round buttons there (sound, pause), if it has them
  if (v === 'top') css.push(`top:calc(var(--t3-hud-top, 12px)${h === 'right' ? ' + var(--t3-hud-corner, 0px)' : ''} + ${y}px)`);
  // bottom corners: above a touch screen's joystick and buttons there (the overlay measures them)
  else if (v === 'bottom') css.push(`bottom:calc(var(--t3-hud-bottom, 12px)${h === 'center' ? '' : ` + var(--t3-hud-clear-${h}, 0px)`} - ${y}px)`);
  else { css.push('top:50%'); ty = `calc(-50% + ${y}px)`; }
  if (h === 'left') css.push(`left:calc(var(--t3-hud-left, 12px) + ${x}px)`);
  else if (h === 'right') css.push(`right:calc(var(--t3-hud-right, 12px) - ${x}px)`);
  else { css.push('left:50%'); tx = `calc(-50% + ${x}px)`; }
  // only what wasn't set by top / left already moves by transform
  const moveX = h === 'center' ? tx : '0px';
  const moveY = v === 'middle' ? ty : '0px';
  if (moveX !== '0px' || moveY !== '0px') css.push(`transform:translate(${moveX},${moveY})`);
  return css.join(';');
}

/**
 * The HUD as HTML: a box for each place used (hudItems says which variable
 * goes where), drawn in the game's look. `text` translates a name; `esc`
 * escapes it. Shared by the game (play-overlay.js) and the editor's preview.
 */
export function hudHtml(items, rawLook, { text = (s) => s, esc = (s) => String(s) } = {}) {
  const look = normalizeHudLook(rawLook);
  const places = new Map();
  for (const it of items) {
    const at = it.at || look.at;
    if (!places.has(at)) places.set(at, []);
    places.get(at).push(it);
  }
  const shadow = look.shadow ? 'text-shadow:0 1px 3px rgba(0,0,0,0.85),0 0 2px rgba(0,0,0,0.7);' : '';
  let html = '';
  for (const [at, list] of places) {
    const [v, h] = at.split(' ');
    const column = look.layout === 'column' || (look.layout === 'auto' && (h !== 'center' || v === 'middle'));
    const box = [
      hudPlaceCss(at, look.x, look.y),
      `flex-direction:${column ? 'column' : 'row'}`,
      `align-items:${column ? (h === 'right' ? 'flex-end' : h === 'center' ? 'center' : 'flex-start') : 'center'}`,
      `gap:${column ? Math.round(look.size * 0.35) : Math.round(look.size)}px`,
      `font-family:${HUD_FONTS[look.font]}`,
      `font-size:${look.size}px`,
      `background:${look.opacity > 0 ? rgba(look.background, look.opacity) : 'transparent'}`,
      `border:${look.border ? `1px solid ${rgba(look.borderColor, 0.6)}` : 'none'}`,
      `border-radius:${look.radius}px`,
      `padding:${look.opacity > 0 || look.border ? `${Math.round(look.size * 0.43)}px ${look.size}px` : '0'}`,
    ].join(';');
    const items = list.map((it) => {
      const size = it.size || look.size;
      const color = it.color || look.color;
      const name = it.label
        ? `<span style="color:${look.labelColor};font-size:${Math.max(8, Math.round(size * 0.8))}px;${look.upper ? 'text-transform:uppercase;' : ''}${shadow}">${esc(text(it.label))}</span>`
        : '';
      const n = Number(it.value) || 0;
      const counted = typeof it.value === 'number'; // a bar or hearts of text or a list: shown as it reads
      if (it.show === 'bar' && counted) {
        const pct = Math.max(0, Math.min(100, (n / it.max) * 100));
        const fill = it.color ? `background:${it.color};` : '';
        return `<div class="t3-hud-item">${name}<i class="t3-bar" style="width:${Math.round(size * 6.4)}px;height:${Math.max(4, Math.round(size * 0.65))}px">`
          + `<i style="${fill}width:${Math.round(pct * 10) / 10}%"></i></i></div>`;
      }
      if (it.show === 'hearts' && counted) {
        const total = Math.max(0, Math.min(10, Math.round(it.max)));
        const full = Math.max(0, Math.min(total, Math.round(n)));
        return `<div class="t3-hud-item">${name}<b class="t3-hearts" style="font-size:${Math.round(size * 1.15)}px;${it.color ? `color:${it.color};` : ''}${shadow}">`
          + `${'♥'.repeat(full)}<em>${'♥'.repeat(total - full)}</em></b></div>`;
      }
      // text, yes / no, a list (its items), a record (its fields) — as they read
      return `<div class="t3-hud-item">${name}<b style="color:${color};font-size:${size}px;font-weight:${look.bold ? 700 : 400};${shadow}">${esc(asText(it.value))}</b></div>`;
    }).join('');
    html += `<div class="t3-hud-box" data-at="${at}" style="${box}">${items}</div>`;
  }
  return html;
}
