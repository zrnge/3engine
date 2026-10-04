import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // The app has no build step — the browser resolves bare specifiers through the
  // importmap in index.html. Mirror that map here so tests import the same
  // vendored Three.js the page does.
  resolve: {
    // Array form with anchored patterns: a plain `three` string alias would
    // prefix-match `three/addons/...` too and rewrite it to a path inside the
    // three.module.js file.
    alias: [
      { find: /^three\/addons\/loaders\/GLTFLoader\.js$/, replacement: r('./lib/GLTFLoader.js') },
      { find: /^three\/addons\/loaders\/DRACOLoader\.js$/, replacement: r('./lib/loaders/DRACOLoader.js') },
      { find: /^three\/addons\/loaders\/KTX2Loader\.js$/, replacement: r('./lib/loaders/KTX2Loader.js') },
      {
        find: /^three\/addons\/libs\/meshopt_decoder\.module\.js$/,
        replacement: r('./lib/libs/meshopt_decoder.module.js'),
      },
      {
        find: /^three\/addons\/controls\/TransformControls\.js$/,
        replacement: r('./lib/TransformControls.js'),
      },
      { find: /^three\/addons\/postprocessing\/EffectComposer\.js$/, replacement: r('./lib/postprocessing/EffectComposer.js') },
      { find: /^three\/addons\/postprocessing\/RenderPass\.js$/, replacement: r('./lib/postprocessing/RenderPass.js') },
      { find: /^three\/addons\/postprocessing\/UnrealBloomPass\.js$/, replacement: r('./lib/postprocessing/UnrealBloomPass.js') },
      { find: /^three\/addons\/postprocessing\/OutputPass\.js$/, replacement: r('./lib/postprocessing/OutputPass.js') },
      { find: /^three\/addons\/postprocessing\/ShaderPass\.js$/, replacement: r('./lib/postprocessing/ShaderPass.js') },
      { find: /^three\/addons\/postprocessing\/Pass\.js$/, replacement: r('./lib/postprocessing/Pass.js') },
      { find: /^three\/addons\/postprocessing\/GTAOPass\.js$/, replacement: r('./lib/postprocessing/GTAOPass.js') },
      { find: /^three\/addons\/postprocessing\/BokehPass\.js$/, replacement: r('./lib/postprocessing/BokehPass.js') },
      { find: /^three\/addons\/loaders\/OBJLoader\.js$/, replacement: r('./lib/loaders/OBJLoader.js') },
      { find: /^three\/addons\/loaders\/MTLLoader\.js$/, replacement: r('./lib/loaders/MTLLoader.js') },
      { find: /^three\/addons\/loaders\/FBXLoader\.js$/, replacement: r('./lib/loaders/FBXLoader.js') },
      { find: /^three\/addons\/loaders\/STLLoader\.js$/, replacement: r('./lib/loaders/STLLoader.js') },
      { find: /^three\/addons\/exporters\/GLTFExporter\.js$/, replacement: r('./lib/exporters/GLTFExporter.js') },
      { find: /^three\/addons\/utils\/SkeletonUtils\.js$/, replacement: r('./lib/utils/SkeletonUtils.js') },
      { find: /^three$/, replacement: r('./lib/three.module.js') },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
