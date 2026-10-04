import { readGlb, writeGlb } from './gltf-files.js';

/**
 * Smaller models on import: a model's pictures (textures) are most of its
 * size — a 4096 × 4096 PNG is 20 MB or more, and a game in a browser tab, sent
 * over the web, needs nothing like that. So each is:
 *
 *   - made no bigger than `maxSize` across (2048 by default: sharp on a big
 *     screen, a quarter of the bytes of 4096);
 *   - kept as a PNG if it has see-through parts or is a normal map (JPEG's
 *     blur would show in the lighting), else stored as a JPEG.
 *
 * A picture only changes if it comes out smaller. Its file inside the .glb is
 * replaced and the rest laid out again; nothing else in the model changes.
 * Done once, on import, in the editor; the stored model is the small one.
 */

const align4 = (n) => (n + 3) & ~3;

/** Which images are normal maps (they stay lossless). */
function normalImages(json) {
  const out = new Set();
  for (const m of json.materials || []) {
    const tex = m.normalTexture?.index;
    const img = tex !== undefined ? json.textures?.[tex]?.source : undefined;
    if (img !== undefined) out.add(img);
  }
  return out;
}

/**
 * A .glb with its images made smaller. Returns { bytes, before, after, images }
 * (how many images changed). `transform(bytes, mime, opts)` makes one image
 * smaller — { bytes, mime } — or returns null to leave it; the default draws it
 * on a canvas (a browser's).
 */
export async function shrinkGlb(input, { maxSize = 2048, jpeg = true, quality = 0.85 } = {}, { transform = canvasTransform } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const glb = readGlb(bytes);
  const before = bytes.length;
  const same = { bytes, before, after: before, images: 0 };
  if (!glb || !glb.json.images?.length || !glb.json.bufferViews?.length) return same;
  const { json, bin } = glb;
  const normals = normalImages(json);
  const replaced = new Map(); // bufferView index -> new bytes
  for (const [i, image] of json.images.entries()) {
    if (image.bufferView === undefined) continue;
    const mime = image.mimeType;
    if (mime !== 'image/png' && mime !== 'image/jpeg') continue; // KTX2, WebP: already made for the web
    const view = json.bufferViews[image.bufferView];
    if ((view.buffer ?? 0) !== 0) continue;
    const data = bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
    let out = null;
    try {
      out = await transform(data, mime, { maxSize, jpeg: jpeg && !normals.has(i), quality });
    } catch (err) {
      console.warn('[Tiny3] a texture could not be made smaller; kept as it was:', err);
    }
    if (!out || out.bytes.length >= data.length) continue;
    replaced.set(image.bufferView, out.bytes);
    image.mimeType = out.mime;
  }
  if (!replaced.size) return same;
  // the binary chunk again: every part in order, the replaced ones new, each on a 4-byte boundary
  const parts = json.bufferViews.map((v, k) => (replaced.has(k)
    ? replaced.get(k)
    : bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength)));
  let size = 0;
  for (const p of parts) size = align4(size) + p.length;
  const out = new Uint8Array(align4(size));
  let at = 0;
  json.bufferViews.forEach((v, k) => {
    at = align4(at);
    out.set(parts[k], at);
    v.byteOffset = at;
    v.byteLength = parts[k].length;
    at += parts[k].length;
  });
  json.buffers[0].byteLength = out.length;
  const result = writeGlb(json, out);
  return { bytes: result, before, after: result.length, images: replaced.size };
}

/** One picture, smaller, through a canvas: scaled down to maxSize, JPEG if it has no see-through parts. */
export async function canvasTransform(data, mime, { maxSize, jpeg, quality }) {
  if (typeof createImageBitmap !== 'function') return null;
  const bitmap = await createImageBitmap(new Blob([data], { type: mime }));
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const toJpeg = jpeg && mime === 'image/png';
  if (scale >= 1 && !toJpeg) { bitmap.close?.(); return null; }
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: toJpeg });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  let type = mime;
  if (toJpeg) {
    // see-through anywhere (leaves, a fence, glass): it stays a PNG
    const px = ctx.getImageData(0, 0, w, h).data;
    let opaque = true;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 250) { opaque = false; break; }
    if (opaque) type = 'image/jpeg';
  }
  if (type === mime && scale >= 1) return null;
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type, quality })
    : await new Promise((r) => canvas.toBlob(r, type, quality));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: type };
}

/** "12.4 MB" */
export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
