/**
 * Which stored files (assets-db.js) a piece of game data needs.
 *
 * Models, imported textures and sound files live in the browser's asset store;
 * saved data only names them by id (`assetId`). Exporting, saving a game file
 * and cleaning up the store all have to agree on what "needed" means — if they
 * didn't, a cleanup could delete a file an export or a save still wants. So
 * there is one answer, and it is deliberately blunt: every `assetId` anywhere
 * in the data, however deep, whatever feature put it there. A new feature that
 * stores an asset id is covered without anyone remembering to add it here.
 */

/** How many times each asset id is named in some data (a model placed three times: 3). */
export function assetUses(value) {
  const counts = new Map();
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    for (const [k, child] of Object.entries(v)) {
      if (k === 'assetId' && typeof child === 'string' && child) counts.set(child, (counts.get(child) || 0) + 1);
      else walk(child);
    }
  };
  walk(value);
  return counts;
}

/** Every asset id in a project, scene, prefab, record — any JSON-shaped value. */
export function assetIdsIn(value) {
  const ids = new Set();
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    for (const [k, child] of Object.entries(v)) {
      if (k === 'assetId' && typeof child === 'string' && child) ids.add(child);
      else walk(child);
    }
  };
  walk(value);
  return [...ids];
}
