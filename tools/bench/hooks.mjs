// Node, like the browser's importmap (index.html): `three` and its add-ons from lib/.
const LIB = new URL('../../lib/', import.meta.url);
const MAP = {
  three: 'three.module.js',
  'three/addons/loaders/GLTFLoader.js': 'GLTFLoader.js',
  'three/addons/loaders/DRACOLoader.js': 'loaders/DRACOLoader.js',
  'three/addons/loaders/KTX2Loader.js': 'loaders/KTX2Loader.js',
  'three/addons/libs/meshopt_decoder.module.js': 'libs/meshopt_decoder.module.js',
  'three/addons/controls/TransformControls.js': 'TransformControls.js',
};
export async function resolve(specifier, context, next) {
  if (MAP[specifier]) return next(new URL(MAP[specifier], LIB).href, context);
  const post = specifier.match(/^three\/addons\/postprocessing\/(.+)$/);
  if (post) return next(new URL(`postprocessing/${post[1]}`, LIB).href, context);
  return next(specifier, context);
}
