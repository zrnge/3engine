/**
 * A .zip file, written in the browser — for exporting a game as a website:
 * an index.html and its files, ready to unzip onto GitHub Pages or any host.
 *
 * Text (code, JSON, HTML) is compressed with the browser's own deflate
 * (CompressionStream); images, models and sounds are compressed already, so
 * they are stored as they are. Without CompressionStream everything is stored.
 */

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Files worth compressing: text. The rest (glb, png, mp3…) is compressed already. */
const TEXT = /\.(html?|js|mjs|json|css|txt|svg|gltf|md)$/i;

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const toBytes = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));

/**
 * `files`: [{ path: 'assets/duck.glb', data: Uint8Array | ArrayBuffer | string }].
 * Resolves to the .zip as a Blob.
 */
export async function makeZip(files) {
  const canDeflate = typeof CompressionStream === 'function';
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const file of files) {
    const name = new TextEncoder().encode(file.path.replace(/^\/+/, ''));
    const raw = toBytes(file.data);
    const crc = crc32(raw);
    let data = raw;
    let method = 0; // stored
    if (canDeflate && TEXT.test(file.path) && raw.length > 64) {
      const packed = await deflate(raw);
      if (packed.length < raw.length) { data = packed; method = 8; }
    }
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);        // version needed
    local.setUint16(6, 0x0800, true);    // names are UTF-8
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);        // made by
    entry.setUint16(6, 20, true);        // needed
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, method, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);   // where its local header is
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/** Read a .zip made by makeZip (or any plain one): [{ path, data: Uint8Array }]. For tests and checks. */
export async function readZip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    let data = bytes.slice(start, start + size);
    if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    out.push({ path, data, crcOk: crc32(data) === view.getUint32(at + 16, true) });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}
