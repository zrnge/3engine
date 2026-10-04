/**
 * Seeded 2D noise for the generators: the same seed always makes the same
 * hills. Value noise with a smooth fade, layered (fbm) for natural detail, and
 * a ridged kind for mountain crests.
 */

/** A small fast hash of two integers and a seed, to 0…1. */
function hash(ix, iz, seed) {
  let h = (ix * 374761393 + iz * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Smooth value noise at (x, z): −1…1. */
export function noise2(x, z, seed = 1) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fz = fade(z - iz);
  const a = hash(ix, iz, seed);
  const b = hash(ix + 1, iz, seed);
  const c = hash(ix, iz + 1, seed);
  const d = hash(ix + 1, iz + 1, seed);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return (top + (bottom - top) * fz) * 2 - 1;
}

/**
 * Layers of noise, each finer and fainter: `octaves` of them, each `gain` as
 * strong as the last. About −1…1.
 */
export function fbm(x, z, { seed = 1, octaves = 4, gain = 0.5 } = {}) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * f, z * f, seed + i * 101) * amp;
    norm += amp;
    amp *= gain;
    f *= 2.03;
  }
  return sum / norm;
}

/** Sharp crests where the noise crosses zero (mountain ridges): 0…1. */
export function ridged(x, z, opts = {}) {
  const { seed = 1, octaves = 4, gain = 0.5 } = opts;
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * f, z * f, seed + i * 211));
    sum += n * n * amp;
    norm += amp;
    amp *= gain;
    f *= 2.07;
  }
  return sum / norm;
}

export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
