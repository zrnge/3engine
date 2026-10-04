// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { GameExporter, GAME_ENTRY, fileSlug, emojiIcon, webManifest, serviceWorker } from '../src/export.js';
import { assetStore, savedGames } from '../src/assets-db.js';
import { writeGlb } from '../src/gltf-files.js';
import { makeZip, readZip } from '../src/zip.js';
import { normalizeUI } from '../src/game-ui.js';
import { SceneSerializer } from '../src/scene.js';
import { PhysicsWorld } from '../src/physics.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';
import { Player } from '../src/player.js';
import * as THREE from 'three';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..'); // (a string: the page's URL class isn't Node's)

describe('a .zip written in the browser', () => {
  it('unzips to the same files, byte for byte — text compressed, the rest stored', async () => {
    const code = 'export const x = 1;\n'.repeat(200);
    const glb = new Uint8Array(3000).map((_, i) => (i * 7) & 255);
    const zip = await makeZip([
      { path: 'index.html', data: '<!DOCTYPE html><title>Ünïcode ✓</title>' },
      { path: 'src/big.js', data: code },
      { path: 'assets/duck-1234.glb', data: glb },
      { path: '.nojekyll', data: '' },
    ]);
    expect(zip.size).toBeLessThan(code.length + glb.length); // the code shrank
    const files = await readZip(zip);
    expect(files.map((f) => f.path)).toEqual(['index.html', 'src/big.js', 'assets/duck-1234.glb', '.nojekyll']);
    expect(files.every((f) => f.crcOk)).toBe(true);
    expect(new TextDecoder().decode(files[0].data)).toContain('Ünïcode ✓');
    expect(new TextDecoder().decode(files[1].data)).toBe(code);
    expect([...files[2].data]).toEqual([...glb]);
    expect(files[3].data.length).toBe(0);
  });
});

describe('names and icons', () => {
  it('a game\'s name as a file name', () => {
    expect(fileSlug('My Great Game!')).toBe('my-great-game');
    expect(fileSlug('Ça va — été')).toBe('ca-va-ete');
    expect(fileSlug('')).toBe('tiny3-game');
    expect(fileSlug('!!!')).toBe('tiny3-game');
  });

  it('an emoji as a tab icon', () => {
    expect(decodeURIComponent(emojiIcon('🚀'))).toContain('🚀');
    expect(emojiIcon('🚀')).toMatch(/^data:image\/svg\+xml,/);
  });

  it('the Game panel\'s name and icon are kept with the game, cleaned up', () => {
    expect(normalizeUI().game).toEqual({ name: '', icon: '🎮' });
    const ui = normalizeUI({ game: { name: 'Sky Duck', icon: '', iconAsset: { assetId: 'abc', name: 'duck.png' } } });
    expect(ui.game).toEqual({ name: 'Sky Duck', icon: '🎮', iconAsset: { assetId: 'abc', name: 'duck.png' } });
  });
});

describe('the game as a website', () => {
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    Object.defineProperty(document, 'baseURI', { value: 'http://editor.test/', configurable: true });
    // the editor's own files, as a web server would give them
    globalThis.fetch = vi.fn(async (url) => {
      const path = decodeURIComponent(new URL(url).pathname.slice(1));
      try {
        return new Response(await readFile(join(ROOT, path)));
      } catch {
        return new Response('not found', { status: 404 });
      }
    });
    globalThis.URL.createObjectURL ??= () => 'blob:x';
  });
  afterAll(() => { globalThis.fetch = realFetch; });

  async function exporterWith({ ui = {}, draco = false } = {}) {
    const glb = writeGlb({ asset: { version: '2.0' }, ...(draco ? { extensionsUsed: ['KHR_draco_mesh_compression'] } : {}) });
    const model = await assetStore.put(new File([glb], 'Sky Duck.glb', { type: 'model/gltf-binary' }), { kind: 'model' });
    const png = await assetStore.put(new File([new Uint8Array([137, 80, 78, 71, 1])], 'icon.png', { type: 'image/png' }), { kind: 'icon' });
    const project = {
      type: 'tiny3-project', version: 1, start: 0, current: 0,
      shared: { ui: normalizeUI(typeof ui === 'function' ? ui(png) : ui) },
      levels: [{ name: 'Level 1', scene: { version: 1, entities: [{ type: 'model', assetId: model.id, name: 'Duck' }] } }],
    };
    const exporter = new GameExporter({ engine: { ui: project.shared.ui } }, { toJSON: () => project });
    return { exporter, project, model, glb, png };
  }
  const byPath = (files) => Object.fromEntries(files.map((f) => [f.path, f.data]));
  const text = (d) => (typeof d === 'string' ? d : new TextDecoder().decode(d));

  it('is a page, its code as real modules, the levels, and each asset as a file of its own', async () => {
    const { exporter, project, model, glb } = await exporterWith({ ui: { game: { name: 'Sky Duck' } } });
    const files = byPath(await exporter.buildSite());

    const page = text(files['index.html']);
    expect(page).toContain('<title>Sky Duck</title>');
    expect(page).toContain('id="loading"');
    expect(page).toContain('<script type="module" src="./game.js">');
    const imports = JSON.parse(page.match(/<script type="importmap">(.*?)<\/script>/)[1]).imports;
    expect(imports.three).toBe('./lib/three.module.js');

    expect(text(files['game.js'])).toBe(GAME_ENTRY);
    for (const path of ['lib/three.module.js', 'lib/GLTFLoader.js', 'src/engine.js', 'src/scene.js', 'src/assets-db.js']) {
      expect(files[path], path).toBeDefined();
    }
    expect(files['src/game.js']).toBeUndefined(); // the editor stays out
    expect(JSON.parse(text(files['game.json']))).toEqual(project);

    const manifest = JSON.parse(text(files['assets.json']));
    const entry = manifest.find((m) => m.id === model.id);
    expect(entry.file).toMatch(/^assets\/sky-duck-[0-9a-f]{8}\.glb$/);
    expect([...files[entry.file]]).toEqual([...glb]); // its real bytes, not base64
    expect(files['.nojekyll']).toBe('');
    // no decoder files it doesn't need (the small decoder modules come with the engine)
    expect(Object.keys(files).some((p) => /^lib\/libs\/(draco|basis)\//.test(p))).toBe(false);
  });

  it('is an app: a manifest, and a service worker that keeps every file for playing offline', async () => {
    const { exporter } = await exporterWith({ ui: { game: { name: 'Sky Duck', icon: '🦆' } } });
    const files = byPath(await exporter.buildSite());
    const page = text(files['index.html']);
    expect(page).toContain('<link rel="manifest" href="manifest.webmanifest" />');
    expect(page).toContain("navigator.serviceWorker.register('sw.js')");
    expect(page).toContain('beforeinstallprompt');
    const manifest = JSON.parse(text(files['manifest.webmanifest']));
    expect(manifest).toMatchObject({ name: 'Sky Duck', start_url: './', display: 'fullscreen', background_color: '#0b0e14' });
    const sw = text(files['sw.js']);
    expect(() => new Function(sw)).not.toThrow(); // it is JavaScript
    const cached = JSON.parse(sw.match(/const FILES = (.*);/)[1]);
    for (const path of ['./', 'index.html', 'game.js', 'game.json', 'assets.json', 'lib/three.module.js', 'src/engine.js', 'manifest.webmanifest']) {
      expect(cached, path).toContain(path);
    }
    expect(cached.some((p) => p.startsWith('assets/'))).toBe(true); // the models too: offline means everything
    expect(cached).not.toContain('sw.js');
    expect(sw).toMatch(/const CACHE = "tiny3-sky-duck-[0-9a-z]+"/); // this game's, not another's on the same site
  });

  it('the manifest names the app, and lists its icons as phones want them', () => {
    const m = webManifest('A Very Long Game Name', [{ path: 'icon-192.png', size: 192 }, { path: 'icon-512.png', size: 512 }]);
    expect(m.short_name.length).toBeLessThanOrEqual(12);
    expect(m.icons).toEqual([
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ]);
  });

  it("a new export is a new cache; the old one is let go, other games' are left alone", async () => {
    const a = serviceWorker('tiny3-duck-', ['index.html']);
    await new Promise((r) => setTimeout(r, 5));
    const b = serviceWorker('tiny3-duck-', ['index.html']);
    const cacheOf = (sw) => sw.match(/const CACHE = "(.*?)"/)[1];
    expect(cacheOf(a)).not.toBe(cacheOf(b));
    expect(b).toContain('k.startsWith("tiny3-duck-") && k !== CACHE');
  });

  it('carries a decoder only for the models that need it, where the loader looks', async () => {
    const { exporter } = await exporterWith({ draco: true });
    const files = byPath(await exporter.buildSite());
    expect(files['lib/libs/draco/gltf/draco_decoder.wasm']?.length).toBeGreaterThan(100000);
    expect(files['lib/libs/draco/gltf/draco_wasm_wrapper.js']).toBeDefined();
    expect(files['lib/libs/basis/basis_transcoder.wasm']).toBeUndefined();
  });

  it('its tab icon: an emoji, or the game\'s own image as a file', async () => {
    const emoji = byPath(await (await exporterWith({ ui: { game: { icon: '🦆' } } })).exporter.buildSite());
    expect(decodeURIComponent(text(emoji['index.html']).match(/rel="icon" href="([^"]+)"/)[1])).toContain('🦆');
    const { exporter } = await exporterWith({ ui: (png) => ({ game: { iconAsset: { assetId: png.id, name: 'icon.png' } } }) });
    const files = byPath(await exporter.buildSite());
    const href = text(files['index.html']).match(/rel="icon" href="([^"]+)"/)[1];
    expect(href).toMatch(/^assets\/icon-[0-9a-f]{8}\.png$/);
    expect(files[href]).toBeDefined();
  });

  it('the page starts from game.json and its files when nothing is inside it', () => {
    expect(GAME_ENTRY).toContain("read('game.json')");
    expect(GAME_ENTRY).toContain('assetStore.seedFiles(files)');
  });

  it('a game read from files finds each asset at its file', async () => {
    assetStore.seedFiles([{ id: 'from-a-file', file: 'assets/tree-12345678.glb' }]);
    expect(await assetStore.objectURL('from-a-file')).toBe('assets/tree-12345678.glb');
    expect(assetStore.cachedURL('from-a-file')).toBe('assets/tree-12345678.glb');
  });
});

describe('loading a level', () => {
  function harness(assets) {
    const engine = {
      scene: new THREE.Scene(), physics: new PhysicsWorld(), entities: [], sounds: [], variables: new VariableStore(),
      materialLibrary: new Map(), camera: new THREE.PerspectiveCamera(),
      add(e) { this.entities.push(e); this.scene.add(e.object3D); return e; },
      remove(e) { this.entities.splice(this.entities.indexOf(e), 1); },
      addBehavior() {}, removeBehavior() {}, addSound() {}, stopAllSounds() {},
    };
    engine.gameplay = new Gameplay(engine);
    const editor = { selectables: [], select() {}, register(e) { this.selectables.push(e); }, unregister() {}, _renderHierarchy() {} };
    const rig = { lookAt: new THREE.Vector3(), setMode() {}, setTarget() {}, setFov() {} };
    return new SceneSerializer(engine, editor, rig, new Player(), assets);
  }

  it('reads every model file at once, not one after another, and says how far it has got', async () => {
    let reading = 0;
    let most = 0;
    const assets = {
      preload: vi.fn(async () => {
        most = Math.max(most, ++reading);
        await new Promise((r) => setTimeout(r, 5));
        reading--;
      }),
      loadFromStore: async () => new THREE.Group(),
    };
    const serializer = harness(assets);
    const progress = [];
    serializer.onProgress = (done, total) => progress.push([done, total]);
    await serializer.deserialize({
      version: 1,
      entities: [
        { type: 'model', assetId: 'a' }, { type: 'model', assetId: 'b' }, { type: 'model', assetId: 'c' },
        { type: 'primitive', primitive: 'box' },
      ],
    });
    expect(most).toBe(3); // all three at the same time
    expect(progress.at(-1)).toEqual([7, 7]); // 3 files read, then 4 objects built
    expect(progress.map(([d]) => d)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('the autosave\'s own store', () => {
  it('keeps, gives back and forgets a game by name', async () => {
    await savedGames.put('autosave', '{"type":"tiny3-project"}');
    expect(await savedGames.get('autosave')).toBe('{"type":"tiny3-project"}');
    await savedGames.delete('autosave');
    expect(await savedGames.get('autosave')).toBeNull();
  });
});
