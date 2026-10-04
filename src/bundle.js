/**
 * Bundle — pack a module and everything it imports into one self-contained
 * object, so an exported game can run from a single HTML file.
 *
 * There is no build step in this project, so this is not a bundler in the
 * usual sense: modules are kept exactly as written. At export time we collect
 * their source text and record, for each one, which file every import
 * specifier points at. In the exported page `bootBundle` turns each module
 * into a Blob URL — dependencies first — rewriting its import specifiers to
 * those URLs, then imports the entry.
 *
 * That matters because a page opened straight off the disk (file://) cannot
 * load module scripts from files at all, and an export used to depend on
 * ./lib and ./src sitting next to it. Opened anywhere else it was a blank page.
 */

/** Bare specifiers, mirroring the importmap in index.html. */
export const BARE = Object.freeze({
  three: 'lib/three.module.js',
  'three/addons/loaders/GLTFLoader.js': 'lib/GLTFLoader.js',
  'three/addons/loaders/DRACOLoader.js': 'lib/loaders/DRACOLoader.js',
  'three/addons/loaders/KTX2Loader.js': 'lib/loaders/KTX2Loader.js',
  'three/addons/libs/meshopt_decoder.module.js': 'lib/libs/meshopt_decoder.module.js',
  'three/addons/controls/TransformControls.js': 'lib/TransformControls.js',
  'three/addons/postprocessing/EffectComposer.js': 'lib/postprocessing/EffectComposer.js',
  'three/addons/postprocessing/RenderPass.js': 'lib/postprocessing/RenderPass.js',
  'three/addons/postprocessing/UnrealBloomPass.js': 'lib/postprocessing/UnrealBloomPass.js',
  'three/addons/postprocessing/OutputPass.js': 'lib/postprocessing/OutputPass.js',
  'three/addons/postprocessing/ShaderPass.js': 'lib/postprocessing/ShaderPass.js',
  'three/addons/postprocessing/Pass.js': 'lib/postprocessing/Pass.js',
  'three/addons/postprocessing/GTAOPass.js': 'lib/postprocessing/GTAOPass.js',
  'three/addons/postprocessing/BokehPass.js': 'lib/postprocessing/BokehPass.js',
  'three/addons/loaders/OBJLoader.js': 'lib/loaders/OBJLoader.js',
  'three/addons/loaders/MTLLoader.js': 'lib/loaders/MTLLoader.js',
  'three/addons/loaders/FBXLoader.js': 'lib/loaders/FBXLoader.js',
  'three/addons/loaders/STLLoader.js': 'lib/loaders/STLLoader.js',
  'three/addons/exporters/GLTFExporter.js': 'lib/exporters/GLTFExporter.js',
  'three/addons/utils/SkeletonUtils.js': 'lib/utils/SkeletonUtils.js',
});

/**
 * Import specifiers: `from '…'`, `import('…')` and `import '…'`.
 * Group 1 is what precedes the quote, 2 the quote, 3 the specifier.
 */
export const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g;

/** Every specifier a source mentions (some may sit in comments; see collect). */
export function findSpecifiers(source) {
  return [...source.matchAll(SPECIFIER)].map((m) => m[3]);
}

/**
 * Where a specifier points, as a project-relative path — or null for a bare
 * name we don't know or an absolute URL, which are left alone.
 */
export function resolveSpecifier(specifier, fromPath) {
  if (BARE[specifier]) return BARE[specifier];
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const url = new URL(specifier, `https://bundle.invalid/${fromPath}`);
  return decodeURIComponent(url.pathname).replace(/^\//, '');
}

/**
 * Collect `entrySource` and everything it imports.
 *
 * @param {string} entrySource the entry module's code
 * @param {{ fetchText: (path: string) => Promise<string>, entryPath?: string }} opts
 * @returns {Promise<{ entry, order, sources, deps, pattern }>}
 *   `order` lists modules dependencies-first; `deps[path][specifier]` is the
 *   file each import resolves to.
 */
export async function collectModules(entrySource, { fetchText, entryPath = '__game__.js' }) {
  const sources = {};
  const deps = {};
  const order = [];
  const state = new Map(); // path -> 'visiting' | 'done'

  async function visit(path, source, chain) {
    if (state.get(path) === 'done') return;
    if (state.get(path) === 'visiting') {
      // Blob URLs must exist before anything can point at them, so a cycle
      // cannot be packed. Say which files, rather than hanging.
      throw new Error(`Cannot export: circular import ${[...chain, path].join(' → ')}`);
    }
    state.set(path, 'visiting');
    sources[path] = source;
    deps[path] = {};

    for (const specifier of findSpecifiers(source)) {
      const dep = resolveSpecifier(specifier, path);
      if (!dep) continue;
      if (!state.has(dep)) {
        let depSource;
        try {
          depSource = await fetchText(dep);
        } catch (_) {
          // A specifier inside a comment or string that names no real file.
          // A genuine missing import would fail when the game boots, loudly.
          continue;
        }
        await visit(dep, depSource, [...chain, path]);
      } else if (state.get(dep) === 'visiting') {
        await visit(dep, sources[dep], [...chain, path]); // throws the cycle
      }
      deps[path][specifier] = dep;
    }

    state.set(path, 'done');
    order.push(path);
  }

  await visit(entryPath, entrySource, []);
  return { entry: entryPath, order, sources, deps, pattern: SPECIFIER.source };
}

/**
 * Runs inside the exported page (it is embedded there as source text, so it
 * must not use anything outside its own body). Returns the entry's import.
 */
export function bootBundle(bundle) {
  const pattern = new RegExp(bundle.pattern, 'g');
  const urls = {};
  for (const path of bundle.order) {
    // dependencies come first in `order`, so each one already has a URL
    const table = bundle.deps[path] || {};
    const code = bundle.sources[path].replace(pattern, (all, prefix, quote, specifier) => {
      const dep = table[specifier];
      return dep && urls[dep] ? prefix + quote + urls[dep] + quote : all;
    });
    urls[path] = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  }
  return import(urls[bundle.entry]);
}
