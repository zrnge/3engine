import { materialSpec, adoptMaterial } from './materials.js';

/**
 * A model's parts — one per material its file gave it — so each can have its
 * own surface edited, saved and put back. (Only the first mesh's material could
 * be changed: a car was all one colour, its wheels and windows included.)
 *
 * Parts are numbered by the file's own materials, in the file's order (the
 * loader marks each mesh with `userData.part`), so a part edited here is found
 * again when the model is loaded from its file — however its materials have
 * been swapped since. Anything the loader didn't mark (a primitive) is one part.
 */

/** [{ index, name, meshes }] — the meshes of each part share one material. */
export function modelParts(root) {
  const parts = [];
  const byKey = new Map();
  root?.traverse?.((n) => {
    if (!n.isMesh || !n.material || Array.isArray(n.material)) return;
    const key = Number.isInteger(n.userData.part) ? n.userData.part : n.material;
    let part = byKey.get(key);
    if (!part) {
      part = { index: Number.isInteger(key) ? key : parts.length, meshes: [] };
      byKey.set(key, part);
      parts.push(part);
    }
    part.meshes.push(n);
  });
  parts.sort((a, b) => a.index - b.index);
  for (const part of parts) {
    const m = part.meshes[0].material;
    part.name = m.name || part.meshes[0].name || `Part ${part.index + 1}`;
  }
  return parts;
}

/**
 * A part as one mesh, for code written for one (the Color & Texture panel):
 * reading `material` gives the part's; setting it gives every mesh of the part
 * that material (a library material, or "Make unique").
 */
export function partHandle(part) {
  return {
    isPart: true,
    get material() { return part.meshes[0].material; },
    set material(m) { for (const mesh of part.meshes) mesh.material = m; },
    get parent() { return part.meshes[0].parent; },
    meshes: part.meshes,
  };
}

/**
 * What a save keeps of a model's surfaces: only the parts edited here (the
 * file has the rest). Part 0 as `material` — what saves before parts had —
 * and the others in `partMaterials`, by part number.
 */
export function modelMaterialRecord(root) {
  const out = {};
  for (const part of modelParts(root)) {
    const m = part.meshes[0].material;
    if (!m?.isMeshStandardMaterial || !m.userData.t3) continue; // never edited here
    const spec = materialSpec(m);
    if (part.index === 0) out.material = spec;
    else (out.partMaterials ??= {})[part.index] = spec;
  }
  return out;
}

/** Put saved surfaces back on a freshly loaded model: `material` (part 0) and `partMaterials`. */
export async function adoptModelMaterials(root, { material, partMaterials } = {}, library = null) {
  const parts = modelParts(root);
  const jobs = [];
  const adopt = (index, spec) => {
    const part = parts.find((p) => p.index === index);
    if (part && spec) jobs.push(adoptMaterial(partHandle(part), spec, library));
  };
  adopt(0, material);
  for (const [index, spec] of Object.entries(partMaterials || {})) adopt(Number(index), spec);
  await Promise.all(jobs);
}
