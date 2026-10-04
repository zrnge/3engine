// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { AssetLoader } from '../src/loader.js';
import { modelParts, partHandle, modelMaterialRecord, adoptModelMaterials } from '../src/model-parts.js';
import { applyMaterialSpec, materialSpec, countUsers } from '../src/materials.js';

/**
 * A car as a file gives it: a body (two meshes sharing the paint) and wheels
 * (one mesh) — two materials, so two parts.
 */
function carFile() {
  const paint = new THREE.MeshStandardMaterial({ name: 'Paint', color: 0xff0000 });
  const rubber = new THREE.MeshStandardMaterial({ name: 'Rubber', color: 0x111111 });
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), paint));
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), rubber));
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), paint)); // the bonnet: paint again
  return { scene, animations: [] };
}

function loaderFor(file) {
  const assets = new AssetLoader();
  assets._loader.loadAsync = vi.fn(async () => file);
  return assets;
}

const colorOf = (root, index) => modelParts(root).find((p) => p.index === index).meshes[0].material.color.getHexString();

describe('a model\'s parts', () => {
  it('one per material of its file, in the file\'s order, named after the material', async () => {
    const car = await loaderFor(carFile()).load('car.glb');
    const parts = modelParts(car);
    expect(parts.map((p) => [p.index, p.name, p.meshes.length])).toEqual([[0, 'Paint', 2], [1, 'Rubber', 1]]);
  });

  it('each copy owns its materials: recolouring one car leaves the others — and later ones — alone', async () => {
    // REGRESSION: every copy of a file shared its materials, though the panel said "this object only"
    const assets = loaderFor(carFile());
    const a = await assets.load('car.glb');
    const b = await assets.load('car.glb');
    applyMaterialSpec(partHandle(modelParts(a)[0]).material, { color: '#00ff00' });
    const c = await assets.load('car.glb');
    expect(colorOf(a, 0)).toBe('00ff00');
    expect(colorOf(b, 0)).toBe('ff0000');
    expect(colorOf(c, 0)).toBe('ff0000');
  });

  it('a part is one thing: giving it a material gives every mesh of it that material', async () => {
    const car = await loaderFor(carFile()).load('car.glb');
    const chrome = new THREE.MeshStandardMaterial({ name: 'Chrome' });
    partHandle(modelParts(car)[0]).material = chrome;
    expect(modelParts(car)[0].meshes.every((m) => m.material === chrome)).toBe(true);
  });

  it('parts stay apart even when two are given the same library material', async () => {
    const car = await loaderFor(carFile()).load('car.glb');
    const shared = new THREE.MeshStandardMaterial();
    for (const part of modelParts(car)) partHandle(part).material = shared;
    expect(modelParts(car).map((p) => p.index)).toEqual([0, 1]);
  });

  it('counts a model whose part is several meshes as one user of a material', async () => {
    const scene = new THREE.Scene();
    const car = await loaderFor(carFile()).load('car.glb');
    car.userData.kind = 'Prop';
    scene.add(car);
    expect(countUsers(scene, modelParts(car)[0].meshes[0].material)).toBe(1);
  });
});

describe('saving a model\'s surfaces, part by part', () => {
  it('keeps only the parts edited here: the first as `material`, the others by number', async () => {
    const car = await loaderFor(carFile()).load('car.glb');
    expect(modelMaterialRecord(car)).toEqual({}); // untouched: the file has it all
    applyMaterialSpec(modelParts(car)[1].meshes[0].material, { ...materialSpec(modelParts(car)[1].meshes[0].material), color: '#3366ff' });
    const rec = modelMaterialRecord(car);
    expect(rec.material).toBeUndefined();
    expect(rec.partMaterials[1].color).toBe('#3366ff');
  });

  it('puts them back on a fresh copy of the file — the wheels blue, the paint as it was', async () => {
    const assets = loaderFor(carFile());
    const car = await assets.load('car.glb');
    const wheels = modelParts(car)[1].meshes[0].material;
    applyMaterialSpec(wheels, { ...materialSpec(wheels), color: '#3366ff', roughness: 0.2 });
    const saved = JSON.parse(JSON.stringify(modelMaterialRecord(car)));

    const again = await assets.load('car.glb');
    await adoptModelMaterials(again, saved);
    expect(colorOf(again, 1)).toBe('3366ff');
    expect(modelParts(again)[1].meshes[0].material.roughness).toBeCloseTo(0.2);
    expect(colorOf(again, 0)).toBe('ff0000');
  });

  it('a save from before parts (one `material`) still recolours the first part', async () => {
    const car = await loaderFor(carFile()).load('car.glb');
    await adoptModelMaterials(car, { material: { color: '#abcdef' } });
    expect(colorOf(car, 0)).toBe('abcdef');
    expect(modelParts(car)[0].meshes.every((m) => m.material.color.getHexString() === 'abcdef')).toBe(true);
  });
});
