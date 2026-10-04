// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { standOn, dropPoint, sizeSuggestions, boundsOf } from '../src/placement.js';
import { droppedFiles, draggingFiles } from '../src/file-drop.js';
import { showNotice } from '../src/ui.js';

/** A 2 × 4 × 2 box whose file put its origin far from it — as many models do. */
function offCentreModel() {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), new THREE.MeshBasicMaterial());
  mesh.position.set(30, -5, 12);
  root.add(mesh);
  return root;
}

describe('standing a model where it is put', () => {
  it('puts its bottom on the surface and its middle over the point, wherever its origin is', () => {
    const model = offCentreModel();
    standOn(model, new THREE.Vector3(1, 2, 3));
    const box = boundsOf(model);
    expect(box.min.y).toBeCloseTo(2);
    expect(box.getCenter(new THREE.Vector3()).x).toBeCloseTo(1);
    expect(box.getCenter(new THREE.Vector3()).z).toBeCloseTo(3);
  });

  it('a scaled model stands on the point too', () => {
    const model = offCentreModel();
    model.scale.setScalar(0.01);
    standOn(model, new THREE.Vector3(0, 0, 0));
    expect(boundsOf(model).min.y).toBeCloseTo(0);
  });
});

describe('where a drop lands', () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 10, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  it('on the ground in the middle of the view', () => {
    const p = dropPoint(camera, { x: 0, y: 0 });
    expect(p.y).toBeCloseTo(0);
    expect(p.x).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(0);
  });

  it('on top of whatever is under the pointer', () => {
    const table = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 4), new THREE.MeshBasicMaterial());
    table.position.y = 1;
    table.updateMatrixWorld();
    const p = dropPoint(camera, { x: 0, y: 0 }, [table]);
    expect(p.y).toBeGreaterThan(1.5); // its top, not the floor under it
  });

  it('looking at the sky: on the ground a little way ahead, not miles off', () => {
    const up = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    up.position.set(0, 2, 0);
    up.lookAt(0, 3, -10);
    up.updateMatrixWorld();
    const p = dropPoint(up, { x: 0, y: 0 }, [], { fallback: 8 });
    expect(p.y).toBe(0);
    expect(p.distanceTo(new THREE.Vector3(0, 0, 0))).toBeLessThan(9);
  });
});

describe('sizes a file might have meant', () => {
  it('a believable size needs nothing', () => {
    expect(sizeSuggestions(1.8)).toEqual([]);
    expect(sizeSuggestions(40)).toEqual([]);
  });

  it('180 units: centimetres (1.8 m) first, and fitting to a metre', () => {
    const s = sizeSuggestions(180);
    expect(s[0]).toMatchObject({ scale: 0.01 });
    expect(s[0].label).toMatch(/centimetres \(1\.8 m\)/);
    expect(s.at(-1)).toMatchObject({ label: 'Fit to 1 m' });
    expect(s.at(-1).scale).toBeCloseTo(1 / 180);
  });

  it('something tiny can be fitted to a metre', () => {
    expect(sizeSuggestions(0.004)).toEqual([{ label: 'Fit to 1 m', scale: 250 }]);
  });
});

describe('files dropped from the desktop', () => {
  const fakeFile = (name) => ({ name });
  const fileEntry = (name) => ({ isFile: true, name, file: (ok) => ok(fakeFile(name)) });
  const folderEntry = (name, children) => {
    let handed = false;
    return {
      isDirectory: true,
      name,
      createReader: () => ({ readEntries: (ok) => { ok(handed ? [] : children); handed = true; } }),
    };
  };

  it('reads a dropped folder with its layout, so a .gltf finds its textures', async () => {
    const car = folderEntry('car', [fileEntry('scene.gltf'), folderEntry('textures', [fileEntry('paint.png')])]);
    const dt = { items: [{ kind: 'file', webkitGetAsEntry: () => car }], files: [] };
    const files = await droppedFiles(dt);
    expect(files.map((f) => f.path)).toEqual(['car/scene.gltf', 'car/textures/paint.png']);
  });

  it('plain files, where the browser offers no folders', async () => {
    const dt = { items: [], files: [fakeFile('duck.glb')] };
    expect(await droppedFiles(dt)).toEqual([{ file: { name: 'duck.glb' }, path: 'duck.glb' }]);
  });

  it('only a drag carrying files counts (a hierarchy row does not)', () => {
    expect(draggingFiles({ dataTransfer: { types: ['Files'] } })).toBe(true);
    expect(draggingFiles({ dataTransfer: { types: ['text/plain'] } })).toBe(false);
  });
});

describe('notices', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

  it('shows the text and its choices; a choice runs and closes it', () => {
    document.body.innerHTML = '<div id="notices"></div>';
    const run = vi.fn();
    showNotice('duck.glb is 180 m across.', { actions: [{ label: 'Made in centimetres', run }, { label: 'Keep' }] });
    const note = document.querySelector('.notice');
    expect(note.textContent).toContain('duck.glb is 180 m across.');
    note.querySelector('button').click();
    expect(run).toHaveBeenCalled();
    expect(document.querySelector('.notice')).toBeNull();
  });

  it('goes by itself after a while, and never piles up past three', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="notices"></div>';
    for (let i = 0; i < 5; i++) showNotice(`note ${i}`, { seconds: 2 });
    expect(document.querySelectorAll('.notice')).toHaveLength(3);
    expect(document.querySelector('.notice').textContent).toBe('note 4'); // newest on top
    vi.advanceTimersByTime(2100);
    expect(document.querySelectorAll('.notice')).toHaveLength(0);
  });
});
