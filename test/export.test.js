import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameExporter, GAME_ENTRY, decoderFilesFor } from '../src/export.js';
import { assetStore } from '../src/assets-db.js';
import { writeGlb } from '../src/gltf-files.js';

describe('decoders in an exported game', () => {
  const store = {
    plain: { kind: 'model', name: 'duck.glb', data: writeGlb({ asset: { version: '2.0' } }) },
    draco: { kind: 'model', name: 'car.glb', data: writeGlb({ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] }) },
    song: { kind: 'audio', name: 'song.mp3', data: new Uint8Array([1, 2, 3]) },
  };
  const readAsset = async (id) => store[id] ?? null;
  const readFile = async (path) => new TextEncoder().encode(`contents of ${path}`);

  it('carries only the decoders its models use', async () => {
    expect(await decoderFilesFor(['plain', 'song'], { readAsset, readFile })).toEqual({});
    const packed = await decoderFilesFor(['plain', 'draco', 'song', 'missing'], { readAsset, readFile });
    expect(Object.keys(packed).sort()).toEqual(['draco_decoder.wasm', 'draco_wasm_wrapper.js']);
    expect(atob(packed['draco_decoder.wasm'])).toBe('contents of lib/libs/draco/gltf/draco_decoder.wasm');
  });

  it('the game reads them from the page before it loads a model', () => {
    const html = new GameExporter({ serialize: () => ({}) })._buildHtml('{}', '[]', '{}', '{"draco_decoder.wasm":"AQI="}');
    expect(html).toContain('id="decoder-data">{"draco_decoder.wasm":"AQI="}');
    expect(GAME_ENTRY).toContain("getElementById('decoder-data')");
    expect(GAME_ENTRY).toContain('new AssetLoader({ renderer: engine.renderer, decoderFiles })');
  });
});

const scene = {
  version: 1,
  entities: [
    { type: 'primitive', primitive: 'box' },
    { type: 'model', assetId: 'model-1', sounds: [{ name: 'hit.wav', assetId: 'sound-1' }] },
    { type: 'model', assetId: 'model-1' },                 // duplicate id
    { type: 'player', sounds: [{ name: 'no-asset.wav' }] }, // legacy sound, no id
  ],
};

describe('GameExporter', () => {
  beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('collects every referenced asset id exactly once', () => {
    const exporter = new GameExporter({ serialize: () => scene });
    const ids = exporter._referencedAssetIds(scene);
    expect(ids.sort()).toEqual(['model-1', 'sound-1']);
  });

  it('embeds textures as well as models and sounds', () => {
    const exporter = new GameExporter({ serialize: () => ({}) });
    const scene = { entities: [{ type: 'primitive', material: { map: { assetId: 'tex-9' } } }] };
    expect(exporter._referencedAssetIds(scene)).toEqual(['tex-9']);
  });

  it('embeds every texture slot, but made textures need no file', () => {
    const exporter = new GameExporter({ serialize: () => ({}) });
    const scene = {
      entities: [{
        type: 'primitive',
        material: {
          maps: {
            map: { procedural: { pattern: 'bricks' }, name: 'Bricks' },
            normalMap: { assetId: 'nrm-1' },
            orm: { assetId: 'orm-1' },
            roughnessMap: null,
          },
        },
      }],
    };
    expect(exporter._referencedAssetIds(scene).sort()).toEqual(['nrm-1', 'orm-1']);
  });

  it('returns no ids for a scene with no imported assets', () => {
    const exporter = new GameExporter({ serialize: () => scene });
    expect(exporter._referencedAssetIds({ entities: [{ type: 'primitive' }] })).toEqual([]);
    expect(exporter._referencedAssetIds({})).toEqual([]);
  });

  it('embeds the scene, its assets and the code in the generated page', () => {
    const exporter = new GameExporter({ serialize: () => scene });
    const html = exporter._buildHtml('{"version":1}', '[{"id":"a","b64":"AQI="}]', '{"entry":"__game__.js"}');
    expect(html).toContain('id="scene-data"');
    expect(html).toContain('id="asset-data"');
    expect(html).toContain('id="tiny3-bundle"');
    expect(html).toContain('"b64":"AQI="');
    expect(html).toContain('URL.createObjectURL'); // the in-page module loader
  });

  it('depends on no file next to it', () => {
    // REGRESSION: the export loaded ./lib and ./src, so opened from Downloads
    // every script was blocked and the game was a blank, dark page
    const html = new GameExporter({ serialize: () => scene })._buildHtml('{}', '[]', '{}');
    expect(html).not.toContain('./lib/');
    expect(html).not.toContain('./src/');
    expect(html).not.toContain('importmap');
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it('starts the game the way Play mode does', () => {
    expect(GAME_ENTRY).toContain('assetStore.seed(');
    expect(GAME_ENTRY).toContain('engine.playing = true');
    expect(GAME_ENTRY).toContain('engine.gameplay.start()');
    // no longer slips in a surprise ground slab that Play mode never had
    expect(GAME_ENTRY).not.toContain("'Ground'");
  });

  it('escapes < so scene, asset or code data cannot close the script tag', () => {
    const exporter = new GameExporter({ serialize: () => scene });
    const html = exporter._buildHtml('{"n":"</script><img>"}', '[]', '{"s":"</script>"}');
    expect(html).not.toContain('</script><img>');
    expect(html).not.toContain('{"s":"</script>"}');
    expect(html).toContain('\\u003c/script>');
  });

  it('round-trips bytes through base64 and back into the store', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    const meta = await assetStore.put({
      name: 'blob.bin', type: 'application/octet-stream',
      arrayBuffer: async () => bytes.buffer,
    });

    const encoded = await assetStore.toBase64(meta.id);
    expect(encoded.b64).toBeTypeOf('string');

    await assetStore.delete(meta.id);
    expect(await assetStore.get(meta.id)).toBeNull();

    assetStore.seed([encoded]);
    const restored = await assetStore.get(meta.id);
    expect(new Uint8Array(restored.data)).toEqual(bytes);
    expect(restored.name).toBe('blob.bin');
  });

  it('returns null when asked to encode an unknown asset', async () => {
    expect(await assetStore.toBase64('missing')).toBeNull();
  });
});
