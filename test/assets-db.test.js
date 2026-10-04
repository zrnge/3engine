import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AssetStore } from '../src/assets-db.js';

/**
 * These run against the in-memory fallback (no IndexedDB in node), which is the
 * same path a browser takes in private mode — so it needs to work either way.
 */
const file = (name, bytes, type = 'model/gltf-binary') => ({
  name,
  type,
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
});

describe('AssetStore', () => {
  let store;

  beforeEach(() => {
    store = new AssetStore();
    // object URLs don't exist in node
    globalThis.URL.createObjectURL = vi.fn((blob) => `blob:fake/${blob.size}`);
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('stores a file and returns metadata', async () => {
    const meta = await store.put(file('duck.glb', [1, 2, 3, 4]));
    expect(meta.name).toBe('duck.glb');
    expect(meta.size).toBe(4);
    expect(meta.id).toMatch(/^[0-9a-f]+$/);
  });

  it('gives identical bytes the same id (content addressed)', async () => {
    const a = await store.put(file('a.glb', [1, 2, 3]));
    const b = await store.put(file('b.glb', [1, 2, 3]));
    expect(b.id).toBe(a.id);
  });

  it('gives different bytes different ids', async () => {
    const a = await store.put(file('a.glb', [1, 2, 3]));
    const b = await store.put(file('b.glb', [9, 9, 9]));
    expect(b.id).not.toBe(a.id);
  });

  it('reads a stored asset back', async () => {
    const meta = await store.put(file('duck.glb', [7, 7]));
    const rec = await store.get(meta.id);
    expect(rec).not.toBeNull();
    expect(new Uint8Array(rec.data)).toEqual(new Uint8Array([7, 7]));
  });

  it('returns null for an unknown id', async () => {
    expect(await store.get('nope')).toBeNull();
    expect(await store.objectURL('nope')).toBeNull();
  });

  it('mints one stable object URL per asset', async () => {
    const meta = await store.put(file('duck.glb', [1]));
    const first = await store.objectURL(meta.id);
    const second = await store.objectURL(meta.id);
    expect(second).toBe(first);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('lists metadata without file bodies', async () => {
    await store.put(file('a.glb', [1]));
    await store.put(file('b.wav', [2], 'audio/wav'), { kind: 'audio' });
    const list = await store.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const meta of list) expect(meta.data).toBeUndefined();
  });

  it('deletes an asset and revokes its URL', async () => {
    const meta = await store.put(file('gone.glb', [5]));
    await store.objectURL(meta.id);
    await store.delete(meta.id);
    expect(await store.get(meta.id)).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('prunes everything not in the keep set', async () => {
    const keep = await store.put(file('keep.glb', [1]));
    const drop = await store.put(file('drop.glb', [2]));
    await store.prune([keep.id]);
    expect(await store.get(keep.id)).not.toBeNull();
    expect(await store.get(drop.id)).toBeNull();
  });
});
