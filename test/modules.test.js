// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';

import * as assetsDb from '../src/assets-db.js';
import * as behavior from '../src/behavior.js';
import * as cameras from '../src/cameras.js';
import * as editor from '../src/editor.js';
import * as engine from '../src/engine.js';
import * as lightEntity from '../src/light-entity.js';
import * as enemy from '../src/enemy.js';
import * as entity from '../src/entity.js';
import * as exporter from '../src/export.js';
import * as factories from '../src/factories.js';
import * as environment from '../src/environment.js';
import * as environmentPanel from '../src/environment-panel.js';
import * as history from '../src/history.js';
import * as input from '../src/input.js';
import * as loader from '../src/loader.js';
import * as physics from '../src/physics.js';
import * as player from '../src/player.js';
import * as scene from '../src/scene.js';
import * as ui from '../src/ui.js';

/**
 * Import smoke test. The app has no build step and no type checker, so nothing
 * else catches a renamed export or a bad import path until the page is opened
 * in a browser — including the vendored files' own internal imports.
 *
 * game.js is excluded on purpose: it is the entry point and constructs an
 * Engine (and therefore a WebGL context) at import time.
 */
const MODULES = {
  'assets-db.js': [assetsDb, ['AssetStore', 'assetStore']],
  'behavior.js': [behavior, ['BehaviorRunner', 'compileBehavior']],
  'cameras.js': [cameras, ['CameraRig']],
  'editor.js': [editor, ['ObjectEditor', 'LightEntity', 'escapeHtml']],
  'light-entity.js': [lightEntity, ['LightEntity']],
  'engine.js': [engine, ['Engine']],
  'enemy.js': [enemy, ['Coin', 'Enemy']],
  'entity.js': [entity, ['Entity', 'aabbCollides', 'getWorldHalfSize']],
  'export.js': [exporter, ['GameExporter']],
  'factories.js': [factories, [
    'PRIMITIVE_GEOS', 'LIGHT_TYPES', 'primitiveKind', 'lightKind', 'firstMesh', 'PALETTE',
  ]],
  'history.js': [history, ['History']],
  'environment.js': [environment, [
    'Environment', 'describeSky', 'normalizeSettings', 'sunElevation', 'ENV_PRESETS', 'ENV_DEFAULTS',
  ]],
  'environment-panel.js': [environmentPanel, ['wireEnvironmentPanel']],
  'input.js': [input, ['Input']],
  'loader.js': [loader, ['AssetLoader']],
  'physics.js': [physics, [
    'PhysicsWorld', 'RigidBody', 'BODY_TYPES', 'getWorldAABB', 'aabbOverlap', 'aabbPenetration',
  ]],
  'player.js': [player, ['Player']],
  'scene.js': [scene, ['SceneSerializer']],
  'ui.js': [ui, ['makeDraggable', 'makeResizable', 'makeDockPanel', 'escapeHtml']],
};

describe('module graph', () => {
  for (const [file, [mod, exports]] of Object.entries(MODULES)) {
    it(`${file} exports what callers expect`, () => {
      for (const name of exports) {
        expect(mod[name], `${file} should export ${name}`).toBeDefined();
      }
    });
  }

  it('loads GLTFLoader, which pulls in a vendored relative dependency', () => {
    // REGRESSION: lib/GLTFLoader.js imported '../utils/BufferGeometryUtils.js',
    // a path that only resolved via an importmap entry that works when the site
    // is served from the server root — so GLB loading broke on GitHub Pages.
    expect(loader.AssetLoader).toBeDefined();
    expect(() => new loader.AssetLoader()).not.toThrow();
  });
});

describe('the editor, split by job', () => {
  it('no two of its files define the same method (one would silently replace the other)', async () => {
    const files = ['history', 'clipboard', 'prefabs', 'hierarchy', 'inspector', 'physics-section',
      'script-section', 'animation-section', 'audio-section', 'lighting', 'view-section'];
    const own = new Set(Object.getOwnPropertyNames(class {}.prototype));
    const seen = new Map();
    for (const file of files) {
      const mod = await import(`../src/editor/${file}.js`);
      const mixin = Object.values(mod)[0];
      for (const name of Object.keys(mixin)) {
        expect(seen.get(name), `${name} is in both editor/${seen.get(name)}.js and editor/${file}.js`).toBeUndefined();
        seen.set(name, file);
        expect(editor.ObjectEditor.prototype[name]).toBe(mixin[name]); // really mixed in
        expect(own.has(name)).toBe(false);
      }
    }
    expect(seen.size).toBeGreaterThan(60); // the files really were read
  });

  it('still answers to everything the app and the tests call', () => {
    for (const name of ['select', 'register', 'unregister', 'deleteSelected', 'removeEntity', 'duplicateSelection',
      'copySelection', 'pasteSelection', 'copyProperties', 'pasteProperties', 'saveAsPrefab', 'instantiatePrefab',
      'instantiatePrefabSync', 'applyToPrefab', 'revertToPrefab', 'unlinkPrefab', 'prefabStatus', 'refreshPrefabStatus',
      'listPrefabs', 'deletePrefab', 'setGizmoMode', 'setSnap', 'setGizmoSensitivity', 'recordAdd', 'recordRemove',
      'update', '_renderInspector', '_renderHierarchy', '_renderLighting', '_renderAudio', '_recordValue']) {
      expect(typeof editor.ObjectEditor.prototype[name], name).toBe('function');
    }
    expect(editor.ObjectEditor.LEGACY_PREFAB_KEY).toBe('tiny3.prefabs');
  });

  it('exported games do not carry the editor (its gizmo, panels and inspector)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { collectModules } = await import('../src/bundle.js');
    const bundle = await collectModules(exporter.GAME_ENTRY, { fetchText: (p) => readFile(p, 'utf8') });
    expect(bundle.order).toContain('src/light-entity.js');
    expect(bundle.order.filter((p) => /editor|TransformControls|-panel\.js|inspector/.test(p))).toEqual([]);
  });
});

describe('factories', () => {
  it('produces a geometry for every primitive the UI offers', () => {
    for (const kind of ['box', 'sphere', 'cone', 'cylinder', 'torus']) {
      const geo = factories.PRIMITIVE_GEOS[kind]();
      expect(geo).toBeDefined();
      // every primitive must be recognisable again, or saving silently drops it
      expect(factories.primitiveKind(geo)).toBe(kind);
    }
  });

  it('produces a light for every light type the UI offers', () => {
    const opts = { color: '#ffffff', intensity: 1 };
    for (const kind of ['directional', 'point', 'spot', 'ambient']) {
      const light = factories.LIGHT_TYPES[kind](opts);
      expect(light.isLight).toBe(true);
      expect(factories.lightKind(light)).toBe(kind);
    }
  });

  it('returns null for geometry it does not own', () => {
    expect(factories.primitiveKind(null)).toBeNull();
    expect(factories.primitiveKind({ type: 'BufferGeometry' })).toBeNull();
  });
});
