import { describe, it, expect } from 'vitest';
import { packGame, unpackGame, isPackedGame } from '../src/game-file.js';
import { readZip } from '../src/zip.js';

// A saved game as one .tiny3: its data, and its files as files — no base64.

/** An asset store in memory, as assets-db.js offers it. */
function store(records = {}) {
  const items = new Map(Object.entries(records));
  return {
    items,
    async get(id) { return items.get(id) ?? null; },
    async importBytes(list) { for (const r of list) items.set(r.id, { ...r, data: r.bytes.buffer.slice(0) }); return list.length; },
    async importBase64(list) { for (const r of list) items.set(r.id, { ...r, data: Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0)).buffer }); return list.length; },
  };
}

const model = new Uint8Array(200000).map((_, i) => (i * 7) % 256); // a 200 kB "model"

describe('a saved game file', () => {
  it('packs the game and its files as they are: barely bigger than they are (base64 was a third more)', async () => {
    const data = { type: 'tiny3-project', levels: [{ name: 'One', scene: { entities: [{ type: 'model', assetId: 'm1' }] } }] };
    const { blob, missing } = await packGame(data, ['m1', 'gone'], store({ m1: { id: 'm1', name: 'duck.glb', mime: 'model/gltf-binary', kind: 'model', data: model.buffer } }));
    expect(missing).toEqual(['gone']);
    expect(blob.size).toBeLessThan(model.length * 1.01);
    const paths = (await readZip(blob)).map((e) => e.path);
    expect(paths).toEqual(['game.json', 'assets/m1-duck.glb']);
    expect(await isPackedGame(blob)).toBe(true);
  });

  it('opens again: its files back in storage, its data as it was', async () => {
    const data = { type: 'tiny3-project', levels: [{ name: 'One', scene: { entities: [{ type: 'model', assetId: 'm1' }] } }] };
    const { blob } = await packGame(data, ['m1'], store({ m1: { id: 'm1', name: 'duck.glb', mime: 'model/gltf-binary', kind: 'model', data: model.buffer } }));
    const into = store();
    const back = await unpackGame(blob, into);
    expect(back).toEqual(data);
    const rec = await into.get('m1');
    expect(new Uint8Array(rec.data)).toEqual(model);
    expect(rec.name).toBe('duck.glb');
  });

  it('a .json saved before it still opens, its base64 files with it', async () => {
    const b64 = btoa(String.fromCharCode(...model.subarray(0, 1000)));
    const old = { type: 'tiny3-project', levels: [], assets: [{ id: 'm2', name: 'old.glb', b64 }] };
    const into = store();
    const back = await unpackGame(new Blob([JSON.stringify(old)]), into);
    expect(back.levels).toEqual([]);
    expect(new Uint8Array((await into.get('m2')).data)).toEqual(model.subarray(0, 1000));
  });
});
