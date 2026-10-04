/**
 * Free the GPU memory an object held, once it has left the game — its
 * geometry, materials and textures. Shots, spawned enemies and pickups come
 * and go all game long; every one used to stay on the GPU.
 *
 * What other objects still use is left alone:
 *   - a model's geometry: every copy of a file shares it (and later copies need it)
 *   - library materials: shared by every object that uses them
 * Anything disposed that is drawn again (a deletion undone) is simply uploaded
 * again by Three.js, so this is always safe to call.
 */
export function disposeObject(root) {
  const done = new Set();
  root?.traverse?.((n) => {
    if (n.isLight) return; // few, and their shadow maps are rebuilt awkwardly
    const g = n.geometry;
    if (g && !g.userData?.shared && !done.has(g)) {
      done.add(g);
      g.dispose();
    }
    const materials = Array.isArray(n.material) ? n.material : n.material ? [n.material] : [];
    for (const m of materials) {
      if (done.has(m) || m.userData?.t3?.library) continue;
      done.add(m);
      for (const value of Object.values(m)) {
        if (value?.isTexture && !done.has(value)) {
          done.add(value);
          value.dispose();
        }
      }
      m.dispose();
    }
    if (n.isSkinnedMesh) n.skeleton?.dispose?.(); // its bone texture
    for (const lod of n.userData?.terrainChunk?.lods || []) lod.geometry?.dispose(); // a terrain chunk's simpler versions
  });
}
