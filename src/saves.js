/**
 * Saves — a game's progress kept in the browser, to go back to later.
 *
 * "Save game" keeps where the game is:
 *   - the level;
 *   - every variable;
 *   - where the player stands, and its health;
 *   - what has changed in the level since it began: objects destroyed, hidden
 *     or moved, and their health;
 *   - the last checkpoint.
 *
 * "Load game" goes back there: the level loads afresh, then those changes are
 * made again. Objects made during play (spawned ones) aren't kept.
 *
 * Kept in the browser's localStorage, under the game's name and a slot
 * ("save", "slot 2"…), so two games on one website keep their saves apart.
 */

const PREFIX = 'tiny3.save:';

/** Where a slot is kept: the game's name, then the slot's. */
export function saveKey(gameName, slot) {
  const game = String(gameName || '').trim() || 'Tiny3 Game';
  const name = String(slot ?? '').trim() || 'save';
  return `${PREFIX}${game}:${name}`;
}

const storage = () => {
  try { return globalThis.localStorage ?? null; } catch { return null; } // blocked (a private window, site data off)
};

export function readSave(key) {
  try {
    const text = storage()?.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null; // not there, or not a save
  }
}

export function writeSave(key, record) {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, JSON.stringify(record));
    return true;
  } catch (err) {
    console.warn('[Tiny3] could not save the game:', err);
    return false;
  }
}

export function removeSave(key) {
  try { storage()?.removeItem(key); } catch { /* nothing to remove */ }
}

const round = (v) => Math.round(v * 1e4) / 1e4;
/** Where an object is, turned and sized — as plain numbers. */
export const poseOf = (o) => ({
  p: o.position.toArray().map(round),
  q: o.quaternion.toArray().map(round),
  s: o.scale.toArray().map(round),
});
const samePose = (a, b) => ['p', 'q', 's'].every((k) => a[k].every((v, i) => Math.abs(v - b[k][i]) < 1e-3));

/** Put an object where a pose says, standing still. */
export function setPose(entity, pose) {
  const o = entity.object3D;
  if (pose.p) o.position.fromArray(pose.p);
  if (pose.q) o.quaternion.fromArray(pose.q);
  if (pose.s) o.scale.fromArray(pose.s);
  entity.rigidBody?.velocity?.set?.(0, 0, 0);
  entity.rigidBody?.angularVelocity?.set?.(0, 0, 0);
}

const healthOf = (engine, entity) => engine.gameplay?.components.listFor(entity).find((c) => c.type === 'health');

/** Its health back to `value` (its Max if none): alive again, if it had run out. */
export function setHealth(engine, entity, value) {
  const h = healthOf(engine, entity);
  if (!h) return;
  h.state.current = value === undefined || value === null ? h.props.max : value;
  if (h.state.current > 0) h.state.dead = false;
  if (h.props.mirrorTo) engine.variables.set(h.props.mirrorTo, h.state.current);
}

/**
 * How the level stands as it begins: each of its objects (by `levelKey`, its
 * place in the level's file), where it is and whether it shows. A save keeps
 * what differs from this.
 */
export function levelStart(engine) {
  const out = new Map();
  for (const e of engine.entities || []) {
    if (Number.isInteger(e.levelKey) && e.object3D) out.set(e.levelKey, { ...poseOf(e.object3D), shown: e.object3D.visible !== false });
  }
  return out;
}

/** Everything a save keeps (see the top of this file). */
export function captureState(engine, { level = '', start = new Map(), checkpoint = null } = {}) {
  const alive = new Map();
  for (const e of engine.entities || []) {
    if (Number.isInteger(e.levelKey) && e.alive !== false) alive.set(e.levelKey, e);
  }
  const objects = {};
  for (const [key, was] of start) {
    const e = alive.get(key);
    if (!e) { objects[key] = { gone: true }; continue; }
    const rec = {};
    const now = poseOf(e.object3D);
    if (!samePose(now, was)) Object.assign(rec, now);
    const shown = e.object3D.visible !== false;
    if (shown !== was.shown) rec.shown = shown;
    const h = healthOf(engine, e);
    if (h && h.state.current !== undefined && h.state.current !== h.props.max) rec.health = h.state.current;
    if (Object.keys(rec).length) objects[key] = rec;
  }
  const player = engine.playerEntity;
  const ph = player ? healthOf(engine, player) : null;
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    level,
    variables: { ...(engine.variables?.values || {}) },
    player: player?.object3D ? { ...poseOf(player.object3D), ...(ph ? { health: ph.state.current } : {}) } : null,
    checkpoint,
    objects,
  };
}

/** Make a save's changes to the level as it has just begun. */
export function applyState(engine, record) {
  const gameplay = engine.gameplay;
  const vars = engine.variables;
  if (vars && record.variables) {
    vars.reset(); // only what the save says: none made since
    for (const [name, value] of Object.entries(record.variables)) vars.set(name, value);
  }
  const byKey = new Map();
  for (const e of engine.entities || []) if (Number.isInteger(e.levelKey)) byKey.set(e.levelKey, e);
  for (const [key, rec] of Object.entries(record.objects || {})) {
    const e = byKey.get(Number(key));
    if (!e) continue;
    if (rec.gone) { gameplay.destroy(e); continue; }
    if (rec.p) setPose(e, rec);
    if (rec.shown === false) gameplay.hide(e);
    else if (rec.shown === true) {
      e.object3D.visible = true;
      if (e.rigidBody) engine.physics.register(e);
    }
    if (rec.health !== undefined) setHealth(engine, e, rec.health);
  }
  const player = engine.playerEntity;
  if (player && record.player) {
    setPose(player, record.player);
    if (record.player.health !== undefined) setHealth(engine, player, record.player.health);
  }
  gameplay.checkpoint = record.checkpoint ?? null;
}
