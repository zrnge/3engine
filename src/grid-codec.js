/**
 * Grids of numbers as short text, for saving in a game file: a terrain's
 * sculpted heights and its painted ground. Most of a grid is untouched (0), so
 * it is run-length encoded — a count, then a value — and the bytes written as
 * base64. A 513 × 513 grid nobody touched is a few bytes; one with a painted
 * path, a few hundred.
 *
 *   { n, data }   n: points along a side (n × n of them); data: the encoded text
 *
 * Read back at any other resolution by sampling (bilinear), so a terrain's
 * detail can change after it was sculpted and painted.
 */

/** Unsigned LEB128: small counts in one byte. */
function pushVarint(out, v) {
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Bytes (0…255) as text: runs of the same value, counted. */
export function encodeBytes(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const v = bytes[i];
    let run = 1;
    while (i + run < bytes.length && bytes[i + run] === v) run++;
    pushVarint(out, run);
    out.push(v);
    i += run;
  }
  return toBase64(Uint8Array.from(out));
}

/** Text from encodeBytes, back to `length` bytes (short or broken text: zeros for the rest). */
export function decodeBytes(text, length) {
  const out = new Uint8Array(length);
  if (!text) return out;
  let bytes;
  try { bytes = fromBase64(text); } catch { return out; }
  let i = 0;
  let at = 0;
  while (i < bytes.length && at < length) {
    let run = 0;
    let shift = 0;
    let b;
    do { b = bytes[i++]; run |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80 && i < bytes.length);
    const v = bytes[i++] ?? 0;
    const end = Math.min(length, at + run);
    out.fill(v, at, end);
    at = end;
  }
  return out;
}

/** Signed numbers (−32768…32767) as text: each split into two byte planes, so runs of 0 stay runs. */
export function encodeInt16(values) {
  const lo = new Uint8Array(values.length);
  const hi = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(values[i]))) & 0xffff;
    lo[i] = v & 0xff;
    hi[i] = v >> 8;
  }
  return `${encodeBytes(lo)}.${encodeBytes(hi)}`;
}

export function decodeInt16(text, length) {
  const [a = '', b = ''] = String(text || '').split('.');
  const lo = decodeBytes(a, length);
  const hi = decodeBytes(b, length);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) out[i] = ((hi[i] << 8) | lo[i]) << 16 >> 16;
  return out;
}

/**
 * The value of an n × n grid (row by row, row 0 at v = 0) at (u, v), 0…1 each
 * way, between its points. `values` is any indexable array.
 */
export function sampleGrid(values, n, u, v) {
  if (!values || n < 2) return 0;
  const x = Math.min(n - 1, Math.max(0, u * (n - 1)));
  const y = Math.min(n - 1, Math.max(0, v * (n - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = values[y0 * n + x0] * (1 - fx) + values[y0 * n + x1] * fx;
  const b = values[y1 * n + x0] * (1 - fx) + values[y1 * n + x1] * fx;
  return a * (1 - fy) + b * fy;
}
