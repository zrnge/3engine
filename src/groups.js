/**
 * Groups — names an object belongs to, so a game can say "the enemies" or "the
 * targets" rather than one object at a time. An object can be in any number;
 * a prefab's copies (spawned ones too) are in the prefab's groups.
 *
 *   entity.groups = ['Enemies', 'Robots']
 *
 * Anything that picks who something applies to — what a shot can hit, who a
 * Damager hurts, who sets off a rule — takes one of:
 *   'any'            anything
 *   'player'         the player
 *   'group:Enemies'  anything in that group
 *   'Crate'          the object with that name
 */

export const GROUP_PREFIX = 'group:';

/** Clean a list of group names: trimmed, no blanks, no repeats (ignoring case). */
export function normalizeGroups(list) {
  const raw = Array.isArray(list) ? list : typeof list === 'string' ? list.split(',') : [];
  const out = [];
  for (const g of raw) {
    const name = String(g ?? '').trim().slice(0, 60);
    if (name && !out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

export const groupsOf = (entity) => (Array.isArray(entity?.groups) ? entity.groups : []);

export function inGroup(entity, group) {
  const g = String(group).toLowerCase();
  return groupsOf(entity).some((x) => x.toLowerCase() === g);
}

/** Does `entity` match a who-selector (see above)? */
export function matchesWho(who, entity, engine) {
  if (!entity) return false;
  if (!who || who === 'any') return true;
  if (who === 'player') return entity === engine?.playerEntity;
  const s = String(who);
  if (s.toLowerCase().startsWith(GROUP_PREFIX)) return inGroup(entity, s.slice(GROUP_PREFIX.length));
  return (entity.object3D?.name || '').toLowerCase() === s.toLowerCase();
}

/** Every group used in a scene, and by its prefabs — for pick-lists. */
export function allGroups(entities = [], prefabRecords = []) {
  const names = [];
  for (const e of entities) names.push(...groupsOf(e));
  for (const p of prefabRecords) names.push(...(Array.isArray(p?.groups) ? p.groups : []));
  return normalizeGroups(names).sort((a, b) => a.localeCompare(b));
}

/** A who-selector, said the way the editor shows it. */
export function whoLabel(who) {
  if (!who || who === 'any') return 'Anything';
  if (who === 'player') return 'The player';
  const s = String(who);
  if (s.toLowerCase().startsWith(GROUP_PREFIX)) return `Group: ${s.slice(GROUP_PREFIX.length)}`;
  return s;
}
