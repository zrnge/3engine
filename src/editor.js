import * as THREE from 'three';

/**
 * ObjectEditor — click to select any registered object, then move it on the
 * ground plane by dragging, rotate with R (Shift = reverse), scale with [ ],
 * delete with Delete/Backspace.
 *
 *   const editor = new ObjectEditor(engine, infoElement);
 *   editor.register(entity);            // entity: { object3D, ... }
 *   editor.update(dt);                  // call every frame
 *   editor.selected                     // currently selected entity or null
 */
export class ObjectEditor {
  constructor(engine, infoEl = null) {
    this.engine = engine;
    this.infoEl = infoEl;
    this.selectables = [];
    this.selected = null;
    this._raycaster = new THREE.Raycaster();
    this._dragging = false;
    this._dragOffset = new THREE.Vector3();
    this._dragPoint = new THREE.Vector3();
    this._dragY = 0;

    this._helper = new THREE.BoxHelper(new THREE.Object3D(), 0x4dd0a6);
    this._helper.visible = false;
    engine.scene.add(this._helper);
  }

  register(entity) {
    if (!this.selectables.includes(entity)) this.selectables.push(entity);
    return entity;
  }

  unregister(entity) {
    const i = this.selectables.indexOf(entity);
    if (i !== -1) this.selectables.splice(i, 1);
    if (this.selected === entity) this.select(null);
  }

  select(entity) {
    this.selected = entity;
    this._helper.visible = entity != null;
    if (entity) this._helper.setFromObject(entity.object3D);
    this._renderInfo();
  }

  update(_dt) {
    const { input, camera } = this.engine;

    // --- selection ---
    if (input.mouseClicked(0)) {
      this._raycaster.setFromCamera(input.mouseNDC, camera);
      const roots = this.selectables.map((e) => e.object3D);
      const hit = this._raycaster.intersectObjects(roots, true)[0];
      if (hit) {
        const entity = this.selectables.find((e) => {
          let node = hit.object;
          while (node) { if (node === e.object3D) return true; node = node.parent; }
          return false;
        });
        if (entity) {
          this.select(entity);
          // begin ground-plane drag
          const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
          if (this._raycaster.ray.intersectPlane(plane, this._dragPoint)) {
            this._dragging = true;
            this._dragY = entity.object3D.position.y;
            this._dragOffset.copy(entity.object3D.position).sub(this._dragPoint);
          }
        }
      } else if (this.selected && !this._dragging) {
        this.select(null);
      }
    }

    // --- drag on ground plane ---
    if (this._dragging && input.mouseDown(0) && this.selected) {
      this._raycaster.setFromCamera(input.mouseNDC, camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      if (this._raycaster.ray.intersectPlane(plane, this._dragPoint)) {
        this.selected.object3D.position.set(
          this._dragPoint.x + this._dragOffset.x,
          this._dragY,
          this._dragPoint.z + this._dragOffset.z
        );
      }
    }
    if (!input.mouseDown(0)) this._dragging = false;

    // --- transform hotkeys ---
    const sel = this.selected;
    if (sel) {
      const obj = sel.object3D;
      if (input.wasPressed('KeyR')) {
        obj.rotation.y += input.isDown('ShiftLeft') ? -Math.PI / 12 : Math.PI / 12;
      }
      if (input.wasPressed('BracketLeft')) obj.scale.multiplyScalar(0.9);
      if (input.wasPressed('BracketRight')) obj.scale.multiplyScalar(1.1);
      if (input.wasPressed('Delete') || input.wasPressed('Backspace')) {
        const entity = sel;
        this.select(null);
        if (typeof entity.destroy === 'function') entity.destroy(this.engine);
        else this.engine.remove(entity);
        this.unregister(entity);
      }
      this._helper.setFromObject(obj);
      this._renderInfo();
    }
  }

  _renderInfo() {
    if (!this.infoEl) return;
    const sel = this.selected;
    if (!sel) {
      this.infoEl.innerHTML = '<span class="dim">(nothing selected)</span>';
      return;
    }
    const p = sel.object3D.position;
    const s = sel.object3D.scale;
    this.infoEl.innerHTML =
      `<b>${sel.object3D.name || sel.constructor.name}</b><br />` +
      `pos&nbsp; ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}<br />` +
      `scale ${s.x.toFixed(2)}`;
  }
}
