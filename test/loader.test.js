// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { AssetLoader, describeModelError } from '../src/loader.js';
import { assetStore } from '../src/assets-db.js';
import { fieldNumber } from '../src/editor/inspector.js';

describe('describeModelError — why a model could not be read, in plain words', () => {
  const says = (message) => describeModelError(new Error(message));

  it('names the compression a file needs', () => {
    expect(says('THREE.GLTFLoader: No DRACOLoader instance provided.')).toMatch(/Draco/);
    expect(says('THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures')).toMatch(/KTX2/);
    expect(says('THREE.GLTFLoader: setMeshoptDecoder must be called before loading compressed files')).toMatch(/meshopt/);
  });

  it('a .gltf whose data sits in another file: names the file and says to bring it along', () => {
    expect(says('THREE.GLTFLoader: Failed to load buffer "scene.bin".')).toMatch(/"scene\.bin".*folder/);
  });

  it('a decoder file that could not be fetched: says which, and to upload the lib folder', () => {
    expect(says('fetch for "lib/libs/draco/gltf/draco_decoder.wasm" responded with 404: Not Found'))
      .toMatch(/draco_decoder\.wasm.*lib folder/);
  });

  it('something that is not a model at all, or an old glTF 1.0 file', () => {
    expect(describeModelError(new SyntaxError('Unexpected token \'h\', "this is not"... is not valid JSON')))
      .toMatch(/not a \.glb or \.gltf/);
    expect(says('THREE.GLTFLoader: Unsupported asset. glTF versions >=2.0 are supported.')).toMatch(/glTF 1\.0/);
  });

  it('passes anything else through as it is', () => {
    expect(says('The disk is full')).toBe('The disk is full');
    expect(describeModelError(null)).toBe('Unknown error.');
  });
});

describe('AssetLoader — a file read once is copied straight away', () => {
  const fakeFile = () => {
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    return { scene, animations: [] };
  };
  afterEach(() => vi.restoreAllMocks());

  it('copies a model inside the frame once it has been read — and reads it only once', async () => {
    const assets = new AssetLoader();
    assets._loader.loadAsync = vi.fn(async () => fakeFile());
    expect(assets.loadSync('crate.glb')).toBeNull(); // not read yet: the caller waits instead

    await assets.preload({ assetUrl: 'crate.glb' });
    const a = assets.loadSync('crate.glb', { name: 'A' });
    const b = assets.loadSync('crate.glb', { name: 'B' });
    expect(a.name).toBe('A');
    expect(b).not.toBe(a);
    expect(a.userData.assetUrl).toBe('crate.glb');
    expect(assets._loader.loadAsync).toHaveBeenCalledTimes(1);
  });

  it('a model in the asset store too, by its id', async () => {
    const assets = new AssetLoader();
    assets._loader.loadAsync = vi.fn(async () => fakeFile());
    vi.spyOn(assetStore, 'objectURL').mockResolvedValue('blob:rocket');
    const cached = vi.spyOn(assetStore, 'cachedURL').mockReturnValue(null);
    expect(assets.loadFromStoreSync('rocket-1')).toBeNull();

    await assets.preload({ assetId: 'rocket-1' });
    cached.mockReturnValue('blob:rocket');
    expect(assets.loadFromStoreSync('rocket-1').userData.assetId).toBe('rocket-1');
  });

  it('a read that failed is tried again next time, not remembered as failed', async () => {
    const assets = new AssetLoader();
    assets._loader.loadAsync = vi.fn()
      .mockRejectedValueOnce(new Error('network hiccup'))
      .mockResolvedValueOnce(fakeFile());
    await expect(assets.load('tree.glb')).rejects.toThrow('network hiccup');
    await expect(assets.load('tree.glb')).resolves.toBeInstanceOf(THREE.Group);
    expect(assets._loader.loadAsync).toHaveBeenCalledTimes(2);
  });

  it('a file with nothing to place says so — and a file of animations only says where it goes', async () => {
    const assets = new AssetLoader();
    const clip = new THREE.AnimationClip('Wave', 1, []);
    assets._loader.loadAsync = vi.fn(async (url) => ({ scene: undefined, animations: url === 'dance.glb' ? [clip] : [] }));
    const why = async (url) => describeModelError(await assets.load(url).catch((e) => e));
    expect(await why('empty.gltf')).toMatch(/no objects/);
    expect(await why('dance.glb')).toMatch(/animations only.*Clips from other files/);
    vi.spyOn(assetStore, 'objectURL').mockResolvedValue('dance.glb');
    expect(await assets.clipsFromStore('dance-1')).toEqual([clip]); // ...where it is still read for its clips
  });
});

describe('AssetLoader.importFiles — what the picker or a drop brought', () => {
  afterEach(() => vi.restoreAllMocks());
  let made = 0;
  globalThis.URL.createObjectURL = vi.fn(() => `blob:fake/${++made}`);
  const fakeFile = (name, text = '') => new File([text], name);

  it('a .glb and a .gltf with its .bin: both become models; the .gltf is named after its folder', async () => {
    const assets = new AssetLoader();
    const read = vi.fn(async () => {
      const scene = new THREE.Group();
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
      return { scene, animations: [] };
    });
    assets._loader.loadAsync = read;
    const gltf = JSON.stringify({
      asset: { version: '2.0' }, buffers: [{ uri: 'scene.bin', byteLength: 4 }],
      bufferViews: [{ buffer: 0, byteLength: 4 }],
    });
    const { models, errors } = await assets.importFiles([
      fakeFile('duck.glb', 'glTF…'),
      { file: fakeFile('scene.gltf', gltf), path: 'old_car/scene.gltf' },
      { file: fakeFile('scene.bin', 'abcd'), path: 'old_car/scene.bin' },
    ]);
    expect(errors).toEqual([]);
    expect(models.map((m) => m.name)).toEqual(['duck.glb', 'old_car']);
    expect(models.every((m) => m.userData.assetId)).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('one bad file is reported and the others still come in; no model at all says so', async () => {
    const assets = new AssetLoader();
    assets._loader.loadAsync = vi.fn(async () => ({ scene: new THREE.Group(), animations: [] }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lonely = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'gone.bin', byteLength: 4 }] });
    const { models, errors } = await assets.importFiles([fakeFile('lonely.gltf', lonely), fakeFile('ok.glb', 'x')]);
    expect(models).toHaveLength(1);
    expect(errors[0].name).toBe('lonely.gltf');
    expect(describeModelError(errors[0].error)).toMatch(/gone\.bin/);

    const none = await assets.importFiles([fakeFile('notes.txt', 'hello')]);
    expect(none.models).toEqual([]);
    expect(none.errors[0].error.message).toMatch(/no model among these files \(\.glb, \.gltf/);
  });
});

describe('fieldNumber — the Shape panel\'s numbers', () => {
  it('shows 3 decimals, trimmed', () => {
    expect(fieldNumber(1.5, 'pos')).toBe('1.5');
    expect(fieldNumber(2, 'scl')).toBe('2');
    expect(fieldNumber(1e-17, 'pos')).toBe('0'); // float noise, not a number to show
  });

  it('a small scale keeps its digits instead of showing 0', () => {
    expect(fieldNumber(0.0004, 'scl')).toBe('0.0004');
    expect(fieldNumber(0.00125, 'scl')).toBe('0.00125');
  });
});
