import * as THREE from 'three';
import { importNotes } from './asset-library.js';
import { makeProbe } from '../probes.js';
import { describeModelError } from '../loader.js';
import { LightEntity } from '../editor.js';
import { showNotice } from '../ui.js';
import { boundsOf, standOn, dropPoint, sizeSuggestions, formatMetres } from '../placement.js';
import { draggingFiles, droppedFiles, pickFolder } from '../file-drop.js';
import { Entity } from '../entity.js';
import { GENERATORS, makeGenerated } from '../generators/generated.js';
import { RigidBody } from '../physics.js';
import { PRIMITIVE_GEOS, PALETTE } from '../factories.js';
import { t } from '../i18n.js';

/**
 * Making objects: the Shape panel's shapes, lights, terrain and buildings; importing models
 * (＋ GLB, the L key, dropped files) — each placed where it can be seen, named, undoable.
 *
 * Moved out of game.js as it was; it reaches the rest of the editor through `app`
 * (game.js): the engine, editor and history — and what other parts offer (app.markDirty…).
 */
export function wireObjects(app) {
  const { engine, editor, history, rig, assets, player, input, scene, viewport } = app;

  class Prop extends Entity {
    constructor(object3D) {
      super(object3D);
      this.halfSize = new THREE.Vector3(0.5, 0.5, 0.5);
      object3D.userData.kind = 'Prop';
    }
  }

  /**
   * A name no other object has — Box, Box 2, Box 3 — so each can be told apart
   * in the hierarchy and picked in a rule. (Several can still be given one name
   * on purpose: a rule on that name then means all of them.)
   */
  function freeName(name) {
    const base = String(name || '').trim() || 'Object';
    const taken = new Set(editor.selectables.map((e) => (e.object3D.name || '').trim().toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    const stem = base.replace(/\s+\d+$/, '');
    for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}`.toLowerCase())) return `${stem} ${n}`;
  }

  function addProp(object3D, name) {
    object3D.name = freeName(name);
    return editor.register(engine.add(new Prop(object3D)));
  }

  function addPrimitive(kind) {
    const geo = PRIMITIVE_GEOS[kind] ? PRIMITIVE_GEOS[kind]() : PRIMITIVE_GEOS.box();
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color }));
    mesh.castShadow = mesh.receiveShadow = true;
    // place in front of the camera so it's immediately visible
    const dir = engine.camera.getWorldDirection(new THREE.Vector3());
    mesh.position.copy(engine.camera.position).addScaledVector(dir, 8);
    mesh.position.y = Math.max(mesh.position.y, 1);
    const entity = addProp(mesh, kind[0].toUpperCase() + kind.slice(1));
    editor.recordAdd(entity); // undoable
    return entity;
  }

  function addLight(kind) {
    if (kind === 'probe') {
      // a box round a room, in front of the view; scale it to the room
      const entity = makeProbe({ name: freeName('Light probe') });
      entity.object3D.position.copy(engine.camera.position)
        .addScaledVector(engine.camera.getWorldDirection(new THREE.Vector3()), 8);
      entity.object3D.position.y = Math.max(2, entity.object3D.position.y);
      editor.register(engine.add(entity)); // in the engine's list: the probes are found there
      editor.recordAdd(entity);
      editor.select(entity);
      engine.probes.invalidate();
      return entity;
    }
    let light;
    const pos = engine.camera.position.clone()
      .addScaledVector(engine.camera.getWorldDirection(new THREE.Vector3()), 6);
    switch (kind) {
      case 'point':
        light = new THREE.PointLight(0xffe0b3, 30, 25);
        light.position.copy(pos);
        break;
      case 'spot': {
        light = new THREE.SpotLight(0xffffff, 60, 30, Math.PI / 6, 0.4);
        light.position.copy(pos);
        light.target.position.set(0, 0, 0);
        scene.add(light.target);
        break;
      }
      case 'ambient':
        light = new THREE.AmbientLight(0xffffff, 0.4);
        break;
      default: // directional
        light = new THREE.DirectionalLight(0xffffff, 1);
        light.position.copy(pos);
    }
    scene.add(light);
    const entity = new LightEntity(light, { point: 'Point Light', spot: 'Spot Light', ambient: 'Ambient Light' }[kind] || 'Directional Light');
    editor.register(entity);
    editor.recordAdd(entity); // undoable
    editor.select(entity);
    return entity;
  }

  /** Every terrain's ground mesh in the level. */
  const terrainGrounds = () => engine.entities.filter((e) => e.object3D.userData.generator?.type === 'terrain')
    .map((e) => e.object3D.children.find((c) => c.name === 'Ground')).filter(Boolean);

  /** The height of a terrain's ground at (x, z), or null: none there. */
  function groundHeightAt(x, z) {
    const terrains = terrainGrounds();
    if (!terrains.length) return null;
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 1e4, z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObjects(terrains, false)[0];
    return hit ? hit.point.y : null;
  }

  /**
   * Something made from settings (generators/): terrain where the view looks at
   * the ground, a building in front of the camera on the ground. Solid, as
   * itself (a mesh): you walk on the land and into the house.
   */
  function addGenerated(type) {
    const root = makeGenerated(type);
    const cam = engine.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    let at;
    // a building: where the middle of the view meets a terrain's ground, however far — the
    // camera stands back to show a whole terrain, and "a little ahead" was off the land
    const lands = type === 'building' ? terrainGrounds() : [];
    const hit = lands.length ? new THREE.Raycaster(cam.position, dir).intersectObjects(lands, false)[0] : null;
    if (hit) at = hit.point;
    else {
      // where the view meets the ground (y = 0), not too far: else straight ahead
      const t = dir.y < -0.05 ? -cam.position.y / dir.y : 12;
      at = cam.position.clone().addScaledVector(dir, Math.min(t, type === 'terrain' ? 40 : type === 'scatter' ? 25 : 15));
    }
    root.position.set(at.x, 0, at.z);
    root.name = freeName(root.name);
    const entity = new Prop(root);
    if (type === 'building') {
      // on a terrain: stood on its ground there, and the ground kept out of it (levelled under it)
      entity.flattenGround = true;
      const ground = groundHeightAt(at.x, at.z);
      if (ground !== null) root.position.y = ground;
    }
    // solid as itself — but a scatter only if its trees and rocks are (grass is walked through)
    const wants = GENERATORS[type].wantsBody?.(root.userData.generator.params) ?? true;
    if (wants) entity.rigidBody = new RigidBody({ type: 'static', shape: 'mesh' });
    const parts = GENERATORS[type].parts;
    if (parts && Object.keys(parts).length) entity.physicsParts = { ...parts };
    editor.register(engine.add(entity));
    editor.recordAdd(entity); // undoable
    return entity;
  }
  document.querySelectorAll('[data-make]').forEach((b) => b.addEventListener('click', () => {
    const entity = addGenerated(b.dataset.make);
    editor.select(entity);
    frameObjects([entity]); // a mountain can be bigger than the view: stand back to see it whole
  }));
  // a change in its settings that swallowed the view (a higher mountain): stand back again
  editor.onFrameObject = (entity) => frameObjects([entity]);
  document.querySelectorAll('[data-add]').forEach((b) =>
    b.addEventListener('click', () => editor.select(addPrimitive(b.dataset.add))));
  document.querySelectorAll('[data-light]').forEach((b) =>
    b.addEventListener('click', () => addLight(b.dataset.light)));
  // ---- importing models: ＋ GLB, the L key, or dropping files on the view ----

  /** What a model dropped on the view can land on: everything shown that isn't a light. */
  function landingSurfaces() {
    return editor.selectables
      .filter((e) => !e.object3D.isLight && e.object3D.visible)
      .map((e) => e.object3D);
  }

  /** Glide the editing camera onto some objects, far enough back to show them whole. */
  function frameObjects(entities) {
    const box = new THREE.Box3();
    for (const e of entities) box.union(boundsOf(e.object3D, new THREE.Box3()));
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    rig.frame(sphere.center, sphere.radius);
  }

  /**
   * A model that came out unusually big or small probably has a file in other
   * units (glTF is metres; some tools write centimetres). Offer the likely fixes
   * — one click, and undoable — but never change it unasked: it may be a city.
   */
  function offerSizeFix(entity, longest) {
    const options = sizeSuggestions(longest);
    if (!options.length) return;
    const o = entity.object3D;
    const snapshot = () => ({ position: o.position.clone(), rotation: o.rotation.clone(), scale: o.scale.clone() });
    const resize = (k) => {
      if (!editor.selectables.includes(entity)) return; // deleted, or its import undone
      const before = snapshot();
      const box = boundsOf(o, new THREE.Box3());
      const spot = box.getCenter(new THREE.Vector3()).setY(box.min.y);
      o.scale.multiplyScalar(k);
      standOn(o, spot); // still standing where it was
      const after = snapshot();
      history.push({
        label: 'resize model',
        undo: () => editor._applySnapshot(o, before),
        redo: () => editor._applySnapshot(o, after),
      });
      editor.select(entity);
      frameObjects([entity]);
    };
    const what = longest > 1 ? 'bigger than most scenes' : 'smaller than a coin';
    showNotice(`${o.name} is ${formatMetres(longest)} across — ${what}. Its file may use other units.`, {
      kind: 'warn',
      seconds: 30,
      actions: [...options.map((s) => ({ label: s.label, run: () => resize(s.scale) })), { label: 'Keep its size' }],
    });
  }

  /**
   * Put freshly imported models in the scene: standing on what they were dropped
   * on (`ndc`, the screen point, -1..1) — or, picked with ＋ GLB, on the ground in
   * the middle of the view — side by side, selected, and framed by the camera.
   * They used to arrive at the world's origin, often inside the ground or out of
   * sight. (Picked ones don't land on what is in the middle of the view: that is
   * the last model, framed there, so each new one piled on top of it.)
   */
  function addImported(models, ndc = null) {
    if (!models.length) return;
    const at = dropPoint(engine.camera, ndc ?? { x: 0, y: 0 }, ndc ? landingSurfaces() : []);
    const across = new THREE.Vector3().setFromMatrixColumn(engine.camera.matrixWorld, 0).setY(0);
    if (across.lengthSq() < 1e-8) across.set(1, 0, 0);
    else across.normalize();
    const box = new THREE.Box3();
    const size = new THREE.Vector3();
    const added = [];
    let offset = 0;
    models.forEach((obj, i) => {
      boundsOf(obj, box).getSize(size);
      const half = Math.max(size.x, size.z) / 2;
      if (i > 0) offset += half;
      standOn(obj, at.clone().addScaledVector(across, offset));
      offset += half + Math.max(0.5, half / 4); // the next one a little apart
      const entity = addProp(obj, obj.name);
      editor.recordAdd(entity); // undoable
      added.push(entity);
      offerSizeFix(entity, Math.max(size.x, size.y, size.z));
    });
    editor.select(added[0]);
    for (const e of added.slice(1)) editor.select(e, { additive: true });
    frameObjects(added);
  }

  /** Say what went wrong with each file that could not be read — and what to do about it. */
  function reportImportErrors(errors) {
    for (const { name, error } of errors) {
      // a .gltf whose files are in its folder: choose that folder, and it loads
      const folder = error?.needsFolder ? [{
        label: 'Choose its folder…',
        run: () => pickFolder().then((files) => (files.length ? assets.importFiles(files) : null)).then((result) => {
          if (!result) return;
          addImported(result.models);
          reportImportErrors(result.errors);
          importNotes(result.notes);
        }).catch((err) => reportImportErrors([{ name, error: err }])),
      }] : [];
      showNotice(`Could not load ${name || 'that model'}.\n${describeModelError(error)}`, {
        kind: 'error', seconds: 0, actions: [...folder, { label: 'OK' }],
      });
    }
  }

  /** ＋ GLB, or L: pick a .glb — or a .gltf with its .bin and textures — from disk. */
  function importModel() {
    assets.pickAndImport().then((result) => {
      if (!result) return; // cancelled
      addImported(result.models);
      reportImportErrors(result.errors);
      importNotes(result.notes);
      app.renderLibrary?.();
    }).catch((err) => reportImportErrors([{ name: '', error: err }]));
  }
  document.getElementById('btn-load-glb').addEventListener('click', importModel);

  // Drop .glb files — or a .gltf with its files, or a whole folder — onto the view.
  {
    const zone = document.getElementById('drop-zone');
    let depth = 0; // dragenter / dragleave come for every element crossed
    const showZone = (on) => { if (zone) zone.hidden = !on; };
    // over the Color & Texture panel, a model (or pictures) is for the selected object's surface
    const onMaterialPanel = (e) => !!editor.materialEl?.onFiles && editor.materialEl.contains(e.target);
    const zoneText = zone?.innerHTML;
    const MATERIAL_ZONE = 'Drop to use its material on this object'
      + '<small>.glb / .gltf (with its files) — or pictures, sorted into slots by name</small>';
    window.addEventListener('dragenter', (e) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      depth++;
      showZone(!app.isPlaying());
    });
    window.addEventListener('dragover', (e) => {
      if (!draggingFiles(e)) return;
      e.preventDefault(); // or the browser opens the file itself, leaving the editor
      e.dataTransfer.dropEffect = app.isPlaying() ? 'none' : 'copy';
      if (zone) {
        const html = onMaterialPanel(e) ? MATERIAL_ZONE : zoneText;
        if (zone.innerHTML !== html) zone.innerHTML = html;
      }
    });
    window.addEventListener('dragleave', (e) => {
      if (!draggingFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth || !e.relatedTarget) { depth = 0; showZone(false); }
    });
    window.addEventListener('drop', (e) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      depth = 0;
      showZone(false);
      if (app.isPlaying()) {
        showNotice('Stop the game first, then drop the model in.', { kind: 'warn' });
        return;
      }
      if (onMaterialPanel(e)) {
        const take = editor.materialEl.onFiles;
        droppedFiles(e.dataTransfer)
          .then((files) => take(files))
          .catch((err) => reportImportErrors([{ name: '', error: err }]));
        return;
      }
      const rect = viewport.getBoundingClientRect();
      const ndc = {
        x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
        y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
      };
      droppedFiles(e.dataTransfer) // read now: the browser empties the drop when this returns
        .then((files) => assets.importFiles(files))
        .then(({ models, errors, notes }) => {
          addImported(models, ndc);
          reportImportErrors(errors);
          importNotes(notes);
          app.renderLibrary?.();
        })
        .catch((err) => reportImportErrors([{ name: '', error: err }]));
    });
  }

  Object.assign(app, { Prop, freeName, addProp, addPrimitive, addLight, addGenerated, groundHeightAt, frameObjects, importModel, addImported, reportImportErrors });
}
