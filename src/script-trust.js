/**
 * Scripts from someone else's game. A behaviour script runs as part of the
 * editor's page: it can do anything the page can — read the other games kept
 * in this browser, send them anywhere. So a game opened from a file has its
 * scripts off until the person opening it says they trust it; the scripts stay
 * in the game, saved and exported as they were. New games, templates and
 * exported games run theirs as always.
 */

/** How many behaviour scripts a saved game holds — in every level, and in its prefabs — and its script modules. */
export function countScripts(data) {
  if (!data || typeof data !== 'object') return 0;
  const inEntities = (list) => (Array.isArray(list) ? list : []).filter((e) => typeof e?.behavior === 'string' && e.behavior.trim()).length;
  const inPrefabs = (p) => Object.values(p && typeof p === 'object' ? p : {}).filter((r) => typeof r?.behavior === 'string' && r.behavior.trim()).length;
  const scenes = Array.isArray(data.levels) ? data.levels.map((l) => l?.scene) : [data]; // a project — or a single scene from before levels
  const modules = (Array.isArray(data.shared?.modules) ? data.shared.modules : []).filter((m) => typeof m?.code === 'string' && m.code.trim()).length;
  return scenes.reduce((n, s) => n + inEntities(s?.entities) + inPrefabs(s?.prefabs), 0) + inPrefabs(data.shared?.prefabs) + modules;
}
