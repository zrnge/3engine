/**
 * glTF files as files: what is inside one, which decoders it needs, and a
 * multi-file .gltf packed into a single .glb.
 *
 * A model is stored, saved and exported as ONE file (see assets-db.js). A .glb
 * already is one. A .gltf usually is not: it names a .bin with its geometry and
 * image files for its textures (a Sketchfab download is scene.gltf, scene.bin
 * and a textures folder). packGltf moves all of them into one .glb — exactly
 * the same model, nothing re-encoded — so from then on it is like any other.
 *
 * Nothing here needs Three.js.
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/**
 * The decoders compressed models need, where the editor finds their files, and
 * which glTF extension calls for each. (meshopt's decoder is a plain module with
 * its code inside, so it needs no files and is not listed.)
 */
export const DECODERS = {
  draco: {
    extension: 'KHR_draco_mesh_compression',
    dir: 'lib/libs/draco/gltf/',
    files: ['draco_wasm_wrapper.js', 'draco_decoder.wasm'],
  },
  basis: {
    extension: 'KHR_texture_basisu',
    dir: 'lib/libs/basis/',
    files: ['basis_transcoder.js', 'basis_transcoder.wasm'],
  },
};

const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ktx2: 'image/ktx2', avif: 'image/avif',
};

const toBytes = (data) => (data instanceof Uint8Array ? data : new Uint8Array(data));

/** The JSON part of a .glb or .gltf, or null if it is neither. */
export function gltfJson(data) {
  const bytes = toBytes(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 20 && view.getUint32(0, true) === GLB_MAGIC) {
    const length = view.getUint32(12, true);
    if (view.getUint32(16, true) !== CHUNK_JSON) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
    } catch {
      return null;
    }
  }
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes));
    return json && typeof json === 'object' && json.asset ? json : null;
  } catch {
    return null;
  }
}

/** A .glb's two parts: its JSON and its binary chunk (empty if none), or null if it isn't a .glb. */
export function readGlb(data) {
  const bytes = toBytes(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== GLB_MAGIC) return null;
  const json = gltfJson(bytes);
  if (!json) return null;
  const at = 20 + view.getUint32(12, true);
  let bin = new Uint8Array(0);
  if (at + 8 <= bytes.length && view.getUint32(at + 4, true) === CHUNK_BIN) {
    bin = bytes.subarray(at + 8, at + 8 + view.getUint32(at, true));
  }
  return { json, bin };
}

/** The glTF extensions a file uses (compression among them). */
export function extensionsUsed(data) {
  const used = gltfJson(data)?.extensionsUsed;
  return Array.isArray(used) ? used : [];
}

/** Which of DECODERS a set of model files needs, e.g. ['draco']. */
export function decodersNeeded(files) {
  const need = new Set();
  for (const data of files) {
    const used = extensionsUsed(data);
    for (const [name, d] of Object.entries(DECODERS)) if (used.includes(d.extension)) need.add(name);
  }
  return [...need];
}

// ---------------------------------------------------------------- packing

/** 'a/b/../c/./d.png' -> 'a/c/d.png' (and no leading './' or '/'). */
function normalizePath(path) {
  const out = [];
  for (const part of String(path).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export const dirOf = (path) => {
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i + 1);
};
export const baseName = (path) => normalizePath(path).split('/').pop() || '';

export function decodeUri(uri) {
  try { return decodeURIComponent(uri); } catch { return uri; }
}

export function dataUriBytes(uri) {
  const comma = uri.indexOf(',');
  const head = uri.slice(0, comma);
  const body = uri.slice(comma + 1);
  if (/;base64$/i.test(head)) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(decodeUri(body));
}

/**
 * The file a .gltf means by `uri`: the exact path next to it first (a dropped
 * folder keeps its layout), then any file of that name (picked one by one,
 * the files have no folders).
 */
export function findFile(entries, base, uri) {
  const want = normalizePath(base + decodeUri(uri));
  const name = baseName(want);
  return entries.find((e) => normalizePath(e.path) === want)
    ?? entries.find((e) => normalizePath(e.path).endsWith(`/${want}`))
    ?? entries.find((e) => baseName(e.path) === name)
    ?? null;
}

/**
 * The error for a .gltf picked without the files it names. `needsFolder`: a
 * picker can only take files from one folder, and a download keeps its
 * pictures in a textures/ folder beside it — so the answer is to choose the
 * model's folder (or drop it), which the editor offers.
 */
export function missingFiles(name, missing) {
  const names = [...new Set(missing)];
  const inFolder = names.some((n) => n.includes('/'));
  const err = new Error(`${name} keeps ${names.length === 1 ? 'part of itself in another file' : 'parts of itself in other files'}: `
    + `${names.join(', ')}. `
    + (inFolder
      ? 'They are in a folder beside it, which a file picker can\'t reach into — choose the folder the model is in, or drop that folder here.'
      : 'Pick them together with it, choose the folder the model is in, or drop that folder here.'));
  err.missing = names;
  err.needsFolder = true;
  return err;
}

/** A .glb from its JSON and binary chunk. */
export function writeGlb(json, bin = new Uint8Array(0)) {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const textPad = (4 - (text.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + text.length + textPad + (bin.length ? 8 + bin.length + binPad : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, text.length + textPad, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + text.length + textPad); // JSON pads with spaces
  if (bin.length) {
    const at = 20 + text.length + textPad;
    view.setUint32(at, bin.length + binPad, true);
    view.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8); // and the binary chunk with zeros
  }
  return out;
}

/**
 * Pack a .gltf and the files it names into one .glb.
 *   gltf     { file, path } — the .gltf itself
 *   entries  every file given with it, as { file, path } (path inside a dropped
 *            folder, or just the name); File/Blob objects with text()/arrayBuffer()
 * Resolves to the .glb bytes. Throws, naming every file that is missing.
 */
export async function packGltf(gltf, entries) {
  const json = JSON.parse(await gltf.file.text());
  const base = dirOf(gltf.path);
  const missing = [];
  const read = async (uri) => {
    if (/^data:/i.test(uri)) return dataUriBytes(uri);
    const found = findFile(entries, base, uri);
    if (!found) { missing.push(decodeUri(uri)); return null; }
    return new Uint8Array(await found.file.arrayBuffer());
  };

  // every piece of data goes, 4-byte aligned, into one binary chunk: buffer 0
  const pieces = [];
  let length = 0;
  const append = (bytes) => {
    const offset = Math.ceil(length / 4) * 4;
    pieces.push([offset, bytes]);
    length = offset + bytes.length;
    return offset;
  };

  // buffers with data join the chunk; one with none (a meshopt fallback) stays as it is
  const buffers = [{ byteLength: 0 }];
  const moved = []; // old buffer index -> { index, offset }
  for (const [i, buffer] of (json.buffers || []).entries()) {
    if (buffer.uri === undefined) {
      moved[i] = { index: buffers.length, offset: 0 };
      buffers.push(buffer);
      continue;
    }
    const bytes = await read(buffer.uri);
    moved[i] = { index: 0, offset: bytes ? append(bytes) : 0 };
  }
  const repoint = (ref) => {
    const to = moved[ref.buffer];
    if (!to) return;
    ref.buffer = to.index;
    if (to.index === 0) ref.byteOffset = (ref.byteOffset || 0) + to.offset;
  };
  for (const view of json.bufferViews || []) {
    repoint(view);
    // meshopt keeps its compressed data in a buffer of its own
    for (const ext of ['EXT_meshopt_compression', 'KHR_meshopt_compression']) {
      if (view.extensions?.[ext]) repoint(view.extensions[ext]);
    }
  }

  // images named by file become part of the chunk too
  for (const image of json.images || []) {
    if (image.uri === undefined) continue;
    const bytes = await read(image.uri);
    if (!bytes) continue;
    const ext = baseName(decodeUri(image.uri)).split('.').pop().toLowerCase();
    const match = /^data:([^;,]+)/i.exec(image.uri);
    json.bufferViews = json.bufferViews || [];
    image.bufferView = json.bufferViews.push({ buffer: 0, byteOffset: append(bytes), byteLength: bytes.length }) - 1;
    image.mimeType = image.mimeType || match?.[1] || IMAGE_TYPES[ext] || 'image/png';
    // its file name stays with it (what the texture is called in the Color & Texture panel)
    if (!image.name && !match) image.name = baseName(decodeUri(image.uri)).replace(/\.[a-z0-9]+$/i, '');
    delete image.uri;
  }

  if (missing.length) throw missingFiles(gltf.file.name, missing);

  const bin = new Uint8Array(length);
  for (const [offset, bytes] of pieces) bin.set(bytes, offset);
  if (length) buffers[0].byteLength = length;
  else if (buffers.length === 1) buffers.length = 0; // nothing binary at all
  if (buffers.length) json.buffers = buffers;
  else delete json.buffers;
  return writeGlb(json, bin);
}
