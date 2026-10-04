import { makeZip, readZip } from './zip.js';

/**
 * A saved game as one file: a .tiny3 — a zip of game.json (every level, its
 * settings) and its models, images and sounds as the files they are, under
 * assets/. It used to be one .json with each file inside it as base64 text: a
 * third bigger, and all of it read into memory as text to open it.
 *
 * An older .json save (assets inside as base64) still opens.
 */

export const GAME_FILE_EXT = '.tiny3';
const GAME_JSON = 'game.json';

const safeName = (s) => String(s || 'file').replace(/[^\w.-]+/g, '_').slice(0, 60);

/**
 * Pack `data` (project.toJSON()) with the assets it names (`ids`), read from
 * `store` (assets-db.js): a Blob. Missing assets are left out, and listed.
 */
export async function packGame(data, ids, store) {
  const files = [];
  const assetFiles = [];
  const missing = [];
  for (const id of ids) {
    const rec = await store.get(id);
    if (!rec) { missing.push(id); continue; }
    const path = `assets/${id}-${safeName(rec.name)}`;
    files.push({ path, data: rec.data });
    assetFiles.push({ id, name: rec.name, mime: rec.mime, kind: rec.kind, path });
  }
  const { assets, ...rest } = data; // never base64 inside it now
  files.unshift({ path: GAME_JSON, data: JSON.stringify({ ...rest, assetFiles }, null, 1) });
  return { blob: await makeZip(files), missing };
}

/** Is this file a packed game (a zip), not an older .json? */
export async function isPackedGame(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b; // "PK"
}

/**
 * Open a saved game file — a .tiny3, or an older .json — putting the files it
 * carries into `store` first, so its models can load. Resolves to its data.
 */
export async function unpackGame(file, store) {
  if (!(await isPackedGame(file))) {
    const data = JSON.parse(await file.text());
    if (Array.isArray(data.assets)) await store.importBase64(data.assets);
    return data;
  }
  const entries = await readZip(file);
  const json = entries.find((e) => e.path === GAME_JSON);
  if (!json) throw new Error(`no ${GAME_JSON} in this file`);
  const data = JSON.parse(new TextDecoder().decode(json.data));
  const byPath = new Map(entries.map((e) => [e.path, e.data]));
  const records = (data.assetFiles || [])
    .filter((a) => byPath.has(a.path))
    .map((a) => ({ id: a.id, name: a.name, mime: a.mime, kind: a.kind, bytes: byPath.get(a.path) }));
  await store.importBytes(records);
  delete data.assetFiles;
  return data;
}
