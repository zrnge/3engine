/**
 * AssetStore — durable storage for files the user drops into the editor.
 *
 * Models and sounds used to be held only as `blob:` object URLs, which die with
 * the page. That meant a GLB or a sound file was silently dropped by every save,
 * every autosave, and every Play -> Stop revert. Here each file is written to
 * IndexedDB under a content hash, and scenes serialize that id instead of a URL.
 *
 *   const rec = await assetStore.put(file);     // { id, name, mime, size }
 *   const url = await assetStore.objectURL(rec.id);
 *
 * Object URLs are minted once per id and cached for the life of the page, so
 * repeated loads of the same asset share one blob and the AssetLoader cache hits.
 */

const DB_NAME = 'tiny3';
const DB_VERSION = 1;
const STORE = 'assets';

/** In-memory fallback when IndexedDB is unavailable (private mode, tests, SSR). */
const memory = new Map();

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      console.warn('[Tiny3] IndexedDB unavailable, assets kept in memory only:', err);
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn('[Tiny3] could not open asset database:', req.error);
      resolve(null);
    };
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE, mode).objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Content hash, so the same file dropped twice is stored once. */
async function hash(buffer) {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)]
      .slice(0, 16)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // non-secure context (plain http://): FNV-1a over the bytes is plenty here,
  // collisions only cost us a duplicate entry, never correctness of playback
  const bytes = new Uint8Array(buffer);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 + bytes[i] + i, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') +
    bytes.length.toString(16));
}

export class AssetStore {
  constructor() {
    this._urls = new Map(); // id -> object URL
  }

  /**
   * Store a File/Blob. Returns its metadata record; re-storing identical bytes
   * returns the existing id rather than a second copy.
   * @returns {Promise<{id: string, name: string, mime: string, size: number}>}
   */
  async put(file, { kind = 'binary' } = {}) {
    const data = await file.arrayBuffer();
    const id = await hash(data);
    const meta = {
      id,
      name: file.name || id,
      mime: file.type || 'application/octet-stream',
      kind,
      size: data.byteLength,
      addedAt: new Date().toISOString(),
    };

    const db = await openDB();
    if (db) {
      const existing = await tx(db, 'readonly', (s) => s.get(id)).catch(() => null);
      if (!existing) {
        await tx(db, 'readwrite', (s) => s.put({ ...meta, data })).catch((err) => {
          console.warn('[Tiny3] asset write failed, keeping it in memory:', err);
          memory.set(id, { ...meta, data });
        });
      }
    } else {
      memory.set(id, { ...meta, data });
    }
    return meta;
  }

  /** Read a stored asset back. @returns {Promise<object|null>} */
  async get(id) {
    if (memory.has(id)) return memory.get(id);
    const db = await openDB();
    if (!db) return null;
    return tx(db, 'readonly', (s) => s.get(id)).catch(() => null);
  }

  /**
   * A stable object URL for a stored asset, or null if it isn't in the store.
   * The URL is cached, so loaders that key their cache on URL keep working.
   */
  async objectURL(id) {
    if (this._urls.has(id)) return this._urls.get(id);
    const rec = await this.get(id);
    if (!rec) return null;
    const url = URL.createObjectURL(new Blob([rec.data], { type: rec.mime }));
    this._urls.set(id, url);
    return url;
  }

  /** The object URL already made for an asset, or null — for code that can't wait. */
  cachedURL(id) {
    return this._urls.get(id) ?? null;
  }

  /** Metadata for everything in the store (no file bodies). */
  async list() {
    const out = [...memory.values()].map(({ data, ...meta }) => meta);
    const db = await openDB();
    if (db) {
      const all = await tx(db, 'readonly', (s) => s.getAll()).catch(() => []);
      for (const { data, ...meta } of all) {
        if (!out.some((m) => m.id === meta.id)) out.push(meta);
      }
    }
    return out;
  }

  /**
   * Load assets that were shipped inside a page (see GameExporter) into memory,
   * so an exported game carries its own models and sounds instead of depending
   * on the authoring machine's IndexedDB.
   * @param {Array<{id: string, name: string, mime: string, b64: string}>} records
   */
  seed(records = []) {
    for (const rec of records) {
      if (memory.has(rec.id)) continue;
      const bin = atob(rec.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      memory.set(rec.id, {
        id: rec.id,
        name: rec.name,
        mime: rec.mime || 'application/octet-stream',
        kind: rec.kind || 'binary',
        size: bytes.byteLength,
        data: bytes.buffer,
      });
    }
  }

  /**
   * A game published as a website keeps each asset as a file next to its page
   * (see GameExporter.buildSite): `records` are [{ id, file, … }]. Those are
   * read straight from the file, when a model or a sound needs it — never
   * copied into memory as a whole first.
   */
  seedFiles(records = []) {
    for (const rec of records) {
      if (rec?.id && rec.file && !this._urls.has(rec.id)) this._urls.set(rec.id, rec.file);
    }
  }

  /**
   * Store assets that arrive inside a saved game file, for good — unlike
   * seed(), which only lasts as long as the page. Already-stored ones are skipped.
   * @returns {Promise<number>} how many were new
   */
  async importBase64(records = []) {
    return this.importBytes(records.filter((rec) => typeof rec?.b64 === 'string').map((rec) => {
      const bin = atob(rec.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { ...rec, bytes };
    }));
  }

  /**
   * Store assets that arrive as files inside a saved game (a .tiny3, see
   * game-file.js): [{ id, name, mime, kind, bytes }]. Already-stored ones are skipped.
   * @returns {Promise<number>} how many were new
   */
  async importBytes(records = []) {
    let added = 0;
    const db = await openDB();
    for (const rec of records) {
      if (!rec?.id || !rec.bytes) continue;
      if (memory.has(rec.id)) continue;
      if (db && await tx(db, 'readonly', (s) => s.getKey(rec.id)).catch(() => null)) continue;
      const bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
      const full = {
        id: rec.id, name: rec.name || rec.id, mime: rec.mime || 'application/octet-stream',
        kind: rec.kind || 'binary', size: bytes.byteLength, addedAt: new Date().toISOString(),
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
      if (db) {
        await tx(db, 'readwrite', (s) => s.put(full)).catch((err) => {
          console.warn('[Tiny3] asset write failed, keeping it in memory:', err);
          memory.set(rec.id, full);
        });
      } else {
        memory.set(rec.id, full);
      }
      added++;
    }
    return added;
  }

  /**
   * Note that a game still needs these assets, now. Cleanup only ever removes
   * what nothing has needed for a while (see prune). Kept in localStorage, not
   * in the asset records, so it never rewrites a large file to update a date.
   */
  markUsed(ids, now = Date.now()) {
    const usage = readUsage();
    for (const id of ids) usage[id] = now;
    writeUsage(usage);
  }

  /** When an asset was last needed (ms), or when it was stored if never marked. */
  lastUsed(meta) {
    return readUsage()[meta.id] ?? (Date.parse(meta.addedAt) || 0);
  }

  /** Base64 of a stored asset, for embedding into an exported page. */
  async toBase64(id) {
    const rec = await this.get(id);
    if (!rec) return null;
    const bytes = new Uint8Array(rec.data);
    let bin = '';
    const CHUNK = 0x8000; // avoid blowing the argument limit on large models
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return { id: rec.id, name: rec.name, mime: rec.mime, kind: rec.kind, b64: btoa(bin) };
  }

  /**
   * Change what is known about a stored file — its name, its picture in the
   * library — not the file itself. Resolves to its details, or null if it isn't stored.
   */
  async update(id, patch = {}) {
    const { id: _id, data: _data, size: _size, ...changes } = patch; // what a file is can't be changed
    const rec = await this.get(id);
    if (!rec) return null;
    const next = { ...rec, ...changes };
    if (memory.has(id)) memory.set(id, next);
    else {
      const db = await openDB();
      if (db) await tx(db, 'readwrite', (s) => s.put(next)).catch(() => memory.set(id, next));
      else memory.set(id, next);
    }
    const { data, ...meta } = next;
    return meta;
  }

  async delete(id) {
    memory.delete(id);
    const url = this._urls.get(id);
    if (url) { URL.revokeObjectURL(url); this._urls.delete(id); }
    const db = await openDB();
    if (db) await tx(db, 'readwrite', (s) => s.delete(id)).catch(() => {});
  }

  /**
   * Delete assets nothing needs. `keep` is every id still wanted (see
   * asset-refs.js); `unusedFor` (ms) also spares anything needed that recently
   * — another tab's game, or a game file opened last week, may still want it.
   * @returns {Promise<{ removed: number, bytes: number }>}
   */
  async prune(keep, { unusedFor = 0, now = Date.now() } = {}) {
    const keepSet = new Set(keep);
    let removed = 0;
    let bytes = 0;
    const usage = readUsage();
    for (const meta of await this.list()) {
      if (keepSet.has(meta.id)) continue;
      if (unusedFor > 0 && now - this.lastUsed(meta) < unusedFor) continue;
      await this.delete(meta.id);
      delete usage[meta.id];
      removed++;
      bytes += meta.size || 0;
    }
    writeUsage(usage);
    return { removed, bytes };
  }
}

const USAGE_KEY = 'tiny3.assetUsage';
function readUsage() {
  try { return JSON.parse(localStorage.getItem(USAGE_KEY) || '{}') || {}; } catch { return {}; }
}
function writeUsage(usage) {
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(usage)); } catch { /* storage blocked */ }
}

/** Shared store — the editor, loader and serializer all use this one. */
export const assetStore = new AssetStore();

// ---------------------------------------------------------------- saved games
// The editor's autosave lived in localStorage, which holds about 5 MB: a big
// game stopped being saved — with a warning in the console nobody reads — and
// a refresh lost the work. It has a database of its own now (its own name, so
// opening it never waits on an editor tab still holding the assets' one).

const SAVES_DB = 'tiny3-saves';
const SAVES = 'saves';
const memoryDocs = new Map();
let savesPromise = null;

function openSaves() {
  if (savesPromise) return savesPromise;
  savesPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req;
    try {
      req = indexedDB.open(SAVES_DB, 1);
    } catch (err) {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SAVES)) req.result.createObjectStore(SAVES, { keyPath: 'key' });
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close(); // never hold up a newer editor
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
  });
  return savesPromise;
}

function savesRequest(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(SAVES, mode).objectStore(SAVES));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** A game kept in the browser by name ('autosave'): its JSON text. Rejects if it can't be written. */
export const savedGames = {
  async put(key, text) {
    const db = await openSaves();
    if (!db) { memoryDocs.set(key, text); return; }
    await savesRequest(db, 'readwrite', (s) => s.put({ key, text, savedAt: new Date().toISOString() }));
  },
  async get(key) {
    if (memoryDocs.has(key)) return memoryDocs.get(key);
    const db = await openSaves();
    if (!db) return null;
    return (await savesRequest(db, 'readonly', (s) => s.get(key)))?.text ?? null;
  },
  async delete(key) {
    memoryDocs.delete(key);
    const db = await openSaves();
    if (db) await savesRequest(db, 'readwrite', (s) => s.delete(key)).catch(() => {});
  },
};
