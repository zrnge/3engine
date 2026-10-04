// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AssetStore } from '../src/assets-db.js';
import { assetIdsIn } from '../src/asset-refs.js';
import { GameExporter } from '../src/export.js';

const file = (name, bytes, type = 'model/gltf-binary') => ({
  name, type, arrayBuffer: async () => new Uint8Array(bytes).buffer,
});
const DAY = 24 * 60 * 60 * 1000;

describe('which stored files a game needs', () => {
  it('finds every asset, however deep: models, texture slots, sounds, prefabs, every level', () => {
    const game = {
      type: 'tiny3-project',
      shared: { prefabs: { Tree: { type: 'model', assetId: 'tree' } } },
      levels: [
        { name: 'One', scene: {
          entities: [
            { type: 'model', assetId: 'duck', material: { maps: { map: { assetId: 'bark' }, normalMap: { assetId: 'bark-n' } } } },
            { type: 'primitive', material: { map: { assetId: 'old-style' } }, sounds: [{ name: 'hit', assetId: 'hit.wav' }] },
            { type: 'primitive', material: { maps: { map: { procedural: { pattern: 'tiles' } } } } }, // made: no file
          ],
          sceneSounds: [{ name: 'theme', assetId: 'theme.ogg' }],
        } },
        { name: 'Two', scene: { entities: [{ type: 'model', assetId: 'duck' }] } }, // counted once
      ],
    };
    expect(assetIdsIn(game).sort()).toEqual(['bark', 'bark-n', 'duck', 'hit.wav', 'old-style', 'theme.ogg', 'tree']);
  });

  it('ignores junk, and survives data that refers to itself', () => {
    const loop = { assetId: 'a' };
    loop.self = loop;
    expect(assetIdsIn([loop, { assetId: 42 }, { assetId: '' }, null, 'assetId'])).toEqual(['a']);
  });

  it('export, save and cleanup agree: the exporter uses the same answer', () => {
    const game = { levels: [{ scene: { entities: [{ assetId: 'x' }] } }], shared: { prefabs: { P: { assetId: 'y' } } } };
    expect(new GameExporter({}, null)._assetIds(game).sort()).toEqual(['x', 'y']);
  });
});

describe('cleaning up stored files', () => {
  let store;
  beforeEach(() => {
    store = new AssetStore();
    localStorage.clear();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('removes what nothing wants, and says how much it freed', async () => {
    const used = await store.put(file('used.glb', [11, 1]));
    const unused = await store.put(file('unused.glb', [11, 2, 3]));
    const result = await store.prune([used.id]);
    expect(result).toEqual({ removed: 1, bytes: 3 });
    expect(await store.get(used.id)).not.toBeNull();
    expect(await store.get(unused.id)).toBeNull();
  });

  it('the startup cleanup spares anything needed recently — another game may still want it', async () => {
    const now = Date.now();
    const recent = await store.put(file('recent.glb', [12, 1]));
    const stale = await store.put(file('stale.glb', [12, 2]));
    store.markUsed([recent.id], now - 3 * DAY);
    store.markUsed([stale.id], now - 45 * DAY);
    const { removed } = await store.prune([], { unusedFor: 30 * DAY, now });
    expect(removed).toBe(1);
    expect(await store.get(recent.id)).not.toBeNull();
    expect(await store.get(stale.id)).toBeNull();
  });

  it('a file never marked counts from when it was stored', async () => {
    const fresh = await store.put(file('fresh.glb', [13, 1]));
    const { removed } = await store.prune([], { unusedFor: 30 * DAY });
    expect(removed).toBe(0);
    expect(await store.get(fresh.id)).not.toBeNull();
    await store.prune([fresh.id]);
  });

  it('files carried in a saved game go into storage and come back byte for byte', async () => {
    const original = await store.put(file('carried.glb', [14, 200, 7, 0, 255]));
    const packed = await store.toBase64(original.id);
    await store.delete(original.id); // as in another browser
    expect(await store.get(original.id)).toBeNull();

    expect(await store.importBase64([packed, { junk: true }])).toBe(1);
    const back = await store.get(original.id);
    expect([...new Uint8Array(back.data)]).toEqual([14, 200, 7, 0, 255]);
    expect(back.name).toBe('carried.glb');
    expect(await store.importBase64([packed])).toBe(0); // already there: not stored twice
  });
});
