import * as THREE from 'three';

/**
 * The world drawn as near as it needs to be, for big levels:
 *
 *   - a terrain's chunks, far from the camera, drawn with their simpler
 *     versions (every 2nd point beyond one and a half chunks, every 4th beyond
 *     three) — a skirt on each hides where a simpler one meets a finer one;
 *   - a scatter's cells (trees, rocks, grass) not drawn beyond its draw distance.
 *
 * Only the drawing changes, and only while the frame is drawn: apply, then the
 * restore it returns. Physics, the editor's brushes and clicks see the full
 * ground always.
 */

const _c = new THREE.Vector3();
const _s = new THREE.Vector3();

export function applyWorldDetail(entities, camera) {
  const undo = [];
  const eye = camera.getWorldPosition(new THREE.Vector3());
  for (const e of entities || []) {
    const root = e.object3D;
    const type = root?.userData?.generator?.type;
    if ((type !== 'terrain' && type !== 'scatter') || !root.visible || !root.parent) continue;
    root.getWorldScale(_s);
    const scale = Math.max(Math.abs(_s.x), Math.abs(_s.z)) || 1;
    for (const n of root.children) {
      const chunk = n.userData.terrainChunk;
      if (chunk?.lods?.length && chunk.tiles > 1) {
        const g = n.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        _c.copy(g.boundingSphere.center).applyMatrix4(n.matrixWorld);
        const d = Math.max(0, _c.distanceTo(eye) - g.boundingSphere.radius * scale);
        const size = chunk.size * scale;
        const lod = d > size * 3 ? chunk.lods[chunk.lods.length - 1] : d > size * 1.5 ? chunk.lods[0] : null;
        if (lod) {
          n.geometry = lod.geometry;
          undo.push(() => { n.geometry = g; });
        }
        continue;
      }
      const cell = n.userData.scatterCell;
      if (cell && cell.far > 0 && n.visible) {
        const g = n.geometry;
        if (!n.boundingSphere) n.computeBoundingSphere?.();
        const sphere = n.boundingSphere ?? g.boundingSphere;
        _c.copy(sphere.center).applyMatrix4(n.matrixWorld);
        if (_c.distanceTo(eye) - sphere.radius * scale > cell.far) {
          n.visible = false;
          undo.push(() => { n.visible = true; });
        }
      }
    }
  }
  return undo.length ? () => { for (const u of undo) u(); } : null;
}
