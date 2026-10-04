import * as THREE from 'three';

/**
 * Texture maker — seamless textures made from a few settings instead of image
 * files, each with a matching normal map so bricks, planks and tiles catch the
 * light at their edges.
 *
 *   const params = normalizeTexParams({ pattern: 'bricks' });
 *   const color  = makeProceduralTexture(params, 'color');
 *   const bumps  = makeProceduralTexture(params, 'normal');
 *
 * Only the settings are saved (like the sound maker), and every pattern tiles:
 * the right edge continues the left, the top continues the bottom.
 */

export const TEX_SIZES = [64, 128, 256, 512, 1024];

export const PATTERNS = {
  checker: { label: 'Checker', defaults: { colorA: '#e8e8e8', colorB: '#3a3f4b', scale: 8, gap: 0, variation: 0.05, bump: 0 } },
  grid: { label: 'Grid', defaults: { colorA: '#1d2330', colorB: '#4dd0a6', scale: 8, gap: 0.06, variation: 0, bump: 0.3 } },
  bricks: { label: 'Bricks', defaults: { colorA: '#9c4a32', colorB: '#cfc6b8', scale: 8, gap: 0.1, variation: 0.3, bump: 1 } },
  planks: { label: 'Wood planks', defaults: { colorA: '#9a6a3c', colorB: '#3b2616', scale: 5, gap: 0.04, variation: 0.3, bump: 0.6 } },
  tiles: { label: 'Tiles', defaults: { colorA: '#d9dde3', colorB: '#8b939e', scale: 4, gap: 0.05, variation: 0.08, bump: 0.8 } },
  noise: { label: 'Noise (grass, dirt…)', defaults: { colorA: '#6b8e4e', colorB: '#3f5a2c', scale: 6, gap: 0, variation: 0.2, bump: 0.5 } },
  gradient: { label: 'Gradient', defaults: { colorA: '#1f6feb', colorB: '#e8f1ff', scale: 1, gap: 0, variation: 0, bump: 0 } },
};

// ---------------------------------------------------------------- noise

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const frac = (x) => x - Math.floor(x);
const wrap = (i, n) => ((i % n) + n) % n;
const lerp = (a, b, t) => a + (b - a) * t;
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Value noise that repeats every `period` cells across u and v in [0, 1). */
function valueNoise(u, v, period, seed) {
  const x = u * period;
  const y = v * period;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const ax = wrap(x0, period);
  const bx = wrap(x0 + 1, period);
  const ay = wrap(y0, period);
  const by = wrap(y0 + 1, period);
  return lerp(
    lerp(hash2(ax, ay, seed), hash2(bx, ay, seed), sx),
    lerp(hash2(ax, by, seed), hash2(bx, by, seed), sx),
    sy
  );
}

function fbm(u, v, period, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = period;
  for (let o = 0; o < 4; o++) {
    sum += amp * valueNoise(u, v, p, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------- settings

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export function normalizeTexParams(raw = {}) {
  const r = raw || {};
  const pattern = PATTERNS[r.pattern] ? r.pattern : 'checker';
  const d = PATTERNS[pattern].defaults;
  let scale = Math.round(num(r.scale, 1, 64, d.scale));
  // an odd count of checker squares or brick rows would not repeat seamlessly
  if ((pattern === 'checker' || pattern === 'bricks') && scale % 2) scale += 1;
  return {
    pattern,
    colorA: HEX.test(r.colorA) ? r.colorA.toLowerCase() : d.colorA,
    colorB: HEX.test(r.colorB) ? r.colorB.toLowerCase() : d.colorB,
    scale,
    gap: num(r.gap, 0, 0.45, d.gap),
    variation: num(r.variation, 0, 1, d.variation),
    bump: num(r.bump, 0, 2, d.bump),
    size: TEX_SIZES.includes(Number(r.size)) ? Number(r.size) : 512,
    seed: Math.floor(num(r.seed, 1, 2147483646, 1)),
  };
}

// ---------------------------------------------------------------- patterns

/**
 * One point of a pattern: `t` mixes colour A (0) to colour B (1), `h` is the
 * height used for the normal map, `cell` a per-brick/tile random for variation.
 */
export function samplePattern(params, u, v) {
  const p = params;
  const s = p.scale;
  switch (p.pattern) {
    case 'grid': {
      const fu = frac(u * s);
      const fv = frac(v * s);
      const d = Math.min(fu, 1 - fu, fv, 1 - fv) / s;
      const line = d < (p.gap / s) / 2;
      return { t: line ? 1 : 0, h: line ? 0 : 1, cell: 0.5 };
    }
    case 'bricks': {
      const rows = s;
      const cols = Math.max(1, Math.round(s / 2));
      const r = Math.floor(v * rows);
      const x = u * cols + (wrap(r, 2) ? 0.5 : 0);
      const c = wrap(Math.floor(x), cols);
      const fu = frac(x);
      const fv = frac(v * rows);
      const d = Math.min(Math.min(fu, 1 - fu) / cols, Math.min(fv, 1 - fv) / rows);
      const g = (p.gap / rows) / 2;
      if (d < g) return { t: 1, h: 0, cell: 0.5 };
      const grit = fbm(u, v, 16, p.seed);
      return { t: 0, h: smoothstep(0, g * 1.5 + 1e-4, d - g) * (0.85 + 0.15 * grit), cell: hash2(c, wrap(r, rows), p.seed) };
    }
    case 'planks': {
      const cols = s;
      const x = u * cols;
      const c = wrap(Math.floor(x), cols);
      const fu = frac(x);
      const d = Math.min(fu, 1 - fu) / cols;
      const g = (p.gap / cols) / 2;
      if (d < g) return { t: 1, h: 0, cell: 0.5 };
      const n = fbm(u, v, 4, p.seed + c * 7);
      const grain = 0.5 + 0.5 * Math.sin(2 * Math.PI * (v * 6 + n * 2 + c * 0.37));
      return { t: grain * 0.35, h: smoothstep(0, g * 1.5 + 1e-4, d - g) * (0.95 - 0.08 * grain), cell: hash2(c, 3, p.seed) };
    }
    case 'tiles': {
      const x = u * s;
      const y = v * s;
      const fu = frac(x);
      const fv = frac(y);
      const d = Math.min(fu, 1 - fu, fv, 1 - fv) / s;
      const g = (p.gap / s) / 2;
      if (d < g) return { t: 1, h: 0, cell: 0.5 };
      return { t: 0, h: smoothstep(0, g * 2 + 2e-3, d - g), cell: hash2(wrap(Math.floor(x), s), wrap(Math.floor(y), s), p.seed) };
    }
    case 'noise': {
      const n = fbm(u, v, s, p.seed);
      return { t: n, h: n, cell: 0.5 };
    }
    case 'gradient':
      return { t: v, h: 0.5, cell: 0.5 };
    default: { // checker
      const cx = Math.floor(u * s);
      const cy = Math.floor(v * s);
      return { t: (cx + cy) & 1, h: 0.5, cell: hash2(wrap(cx, s), wrap(cy, s), p.seed) };
    }
  }
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const _cache = new Map();

/** Colour and normal-map pixels (RGBA, row 0 = the bottom edge, v = 0). Cached. */
export function renderTexturePixels(raw) {
  const p = normalizeTexParams(raw);
  const key = JSON.stringify(p);
  const hit = _cache.get(key);
  if (hit) return hit;

  const n = p.size;
  const color = new Uint8ClampedArray(n * n * 4);
  const normal = new Uint8ClampedArray(n * n * 4);
  const height = new Float32Array(n * n);
  const A = rgb(p.colorA);
  const B = rgb(p.colorB);

  for (let y = 0; y < n; y++) {
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const s = samplePattern(p, u, v);
      let shade = 1;
      if (p.variation) {
        shade += (s.cell - 0.5) * p.variation * 0.6
          + (valueNoise(u, v, 32, p.seed + 7) - 0.5) * p.variation * 0.25;
      }
      const i = y * n + x;
      height[i] = s.h;
      color[i * 4] = (A[0] + (B[0] - A[0]) * s.t) * shade * 255;
      color[i * 4 + 1] = (A[1] + (B[1] - A[1]) * s.t) * shade * 255;
      color[i * 4 + 2] = (A[2] + (B[2] - A[2]) * s.t) * shade * 255;
      color[i * 4 + 3] = 255;
    }
  }

  // normals from the height field, wrapping at the edges so they tile too
  const k = p.bump * n * 0.02;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const hl = height[y * n + wrap(x - 1, n)];
      const hr = height[y * n + wrap(x + 1, n)];
      const hd = height[wrap(y - 1, n) * n + x];
      const hu = height[wrap(y + 1, n) * n + x];
      const nx = -(hr - hl) * 0.5 * k;
      const ny = -(hu - hd) * 0.5 * k; // green = up (OpenGL / glTF convention)
      const len = Math.hypot(nx, ny, 1);
      const i = (y * n + x) * 4;
      normal[i] = (nx / len * 0.5 + 0.5) * 255;
      normal[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      normal[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      normal[i + 3] = 255;
    }
  }

  const out = { size: n, color, normal };
  if (_cache.size > 24) _cache.delete(_cache.keys().next().value);
  _cache.set(key, out);
  return out;
}

/** A texture ready for a material slot: 'color' or 'normal'. */
export function makeProceduralTexture(raw, output = 'color') {
  const px = renderTexturePixels(raw);
  const tex = new THREE.DataTexture(output === 'normal' ? px.normal : px.color, px.size, px.size, THREE.RGBAFormat);
  // DataTexture defaults to nearest filtering and no mipmaps; a texture wants both
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
