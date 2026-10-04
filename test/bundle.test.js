import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  findSpecifiers, resolveSpecifier, collectModules, bootBundle,
} from '../src/bundle.js';
import { GAME_ENTRY } from '../src/export.js';

const ROOT = new URL('../', import.meta.url);
const readProjectFile = (path) => readFile(new URL(path, ROOT), 'utf8');

/** A pretend project: path -> source. Missing paths throw, like a 404. */
const fakeFiles = (files) => async (path) => {
  if (!(path in files)) throw new Error(`404 ${path}`);
  return files[path];
};

describe('findSpecifiers', () => {
  it('finds static, side-effect and dynamic imports, with either quote', () => {
    const src = `
      import * as THREE from 'three';
      import { a, b } from "./a.js";
      import './side.js';
      const m = await import('./lazy.js');
      export { c } from './c.js';`;
    expect(findSpecifiers(src)).toEqual(['three', './a.js', './side.js', './lazy.js', './c.js']);
  });
});

describe('resolveSpecifier', () => {
  it('maps the importmap names to the vendored files', () => {
    expect(resolveSpecifier('three', 'src/engine.js')).toBe('lib/three.module.js');
    expect(resolveSpecifier('three/addons/loaders/GLTFLoader.js', 'src/loader.js')).toBe('lib/GLTFLoader.js');
  });

  it('resolves relative paths against the importing file', () => {
    expect(resolveSpecifier('./physics.js', 'src/scene.js')).toBe('src/physics.js');
    expect(resolveSpecifier('./utils/BufferGeometryUtils.js', 'lib/GLTFLoader.js'))
      .toBe('lib/utils/BufferGeometryUtils.js');
    expect(resolveSpecifier('../lib/x.js', 'src/a.js')).toBe('lib/x.js');
    expect(resolveSpecifier('./src/engine.js', '__game__.js')).toBe('src/engine.js');
  });

  it('leaves unknown bare names and absolute URLs alone', () => {
    expect(resolveSpecifier('lodash', 'src/a.js')).toBeNull();
    expect(resolveSpecifier('https://example.com/x.js', 'src/a.js')).toBeNull();
  });
});

describe('collectModules', () => {
  const files = {
    'src/a.js': "import { b } from './b.js';\nimport * as T from 'three';",
    'src/b.js': "import * as T from 'three';",
    'lib/three.module.js': 'export const REVISION = 1;',
  };
  const entry = "import './src/a.js';\nimport { b } from './src/b.js';";

  it('lists every module once, dependencies before the modules that need them', async () => {
    const bundle = await collectModules(entry, { fetchText: fakeFiles(files) });
    expect(bundle.order).toEqual(['lib/three.module.js', 'src/b.js', 'src/a.js', '__game__.js']);
    expect(Object.keys(bundle.sources).sort()).toEqual(
      ['__game__.js', 'lib/three.module.js', 'src/a.js', 'src/b.js']);
    expect(bundle.deps['src/a.js']).toEqual({ './b.js': 'src/b.js', three: 'lib/three.module.js' });
  });

  it('follows dynamic imports too', async () => {
    const bundle = await collectModules("const m = await import('./lazy.js');", {
      fetchText: fakeFiles({ 'lazy.js': 'export default 1;' }),
    });
    expect(bundle.order).toEqual(['lazy.js', '__game__.js']);
  });

  it('skips a specifier that names no file, such as one in a comment', async () => {
    const bundle = await collectModules("// e.g. import { x } from './nowhere.js'\nexport {};", {
      fetchText: fakeFiles({}),
    });
    expect(bundle.order).toEqual(['__game__.js']);
    expect(bundle.deps['__game__.js']).toEqual({});
  });

  it('refuses a circular import, naming the files', async () => {
    const fetchText = fakeFiles({
      'a.js': "import './b.js';",
      'b.js': "import './a.js';",
    });
    await expect(collectModules("import './a.js';", { fetchText }))
      .rejects.toThrow(/circular import .*a\.js.*b\.js.*a\.js/);
  });

  it('packs the real exported game: engine, Three.js and every module it reaches', async () => {
    const bundle = await collectModules(GAME_ENTRY, { fetchText: readProjectFile });
    const paths = Object.keys(bundle.sources);
    for (const needed of [
      'lib/three.module.js', 'lib/GLTFLoader.js', 'lib/utils/BufferGeometryUtils.js',
      'src/engine.js', 'src/scene.js', 'src/environment.js', 'src/gameplay.js',
      'src/physics.js', // reached only through a dynamic import in scene.js
    ]) {
      expect(paths, `${needed} should be in the bundle`).toContain(needed);
    }
    // editor-only code stays out of the game
    expect(paths).not.toContain('src/game.js');
    expect(paths).not.toContain('src/export.js');
    // every recorded dependency is itself in the bundle, and comes earlier
    for (const [path, table] of Object.entries(bundle.deps)) {
      for (const dep of Object.values(table)) {
        expect(bundle.order.indexOf(dep)).toBeLessThan(bundle.order.indexOf(path));
      }
    }
  });
});

describe('bootBundle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rewrites every import to its dependency\'s in-memory URL', async () => {
    const files = {
      'src/a.js': "import { b } from './b.js';\nconst lazy = () => import('./b.js');",
      'src/b.js': 'export const b = 1;',
    };
    const bundle = await collectModules("import './src/a.js';", { fetchText: fakeFiles(files) });

    const made = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      made.push(blob);
      return `blob:fake/${made.length}`;
    });
    await bootBundle(JSON.parse(JSON.stringify(bundle))).catch(() => {}); // node can't import blob:

    const code = await Promise.all(made.map((b) => b.text()));
    const [b, a, entry] = code; // dependencies first
    expect(b).toBe('export const b = 1;');
    expect(a).toContain("from 'blob:fake/1'");
    expect(a).toContain("import('blob:fake/1')");
    expect(a).not.toContain('./b.js');
    expect(entry).toContain("import 'blob:fake/2'");
  });
});
