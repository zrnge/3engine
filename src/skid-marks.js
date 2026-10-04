import * as THREE from 'three';

/**
 * Skid marks: dark streaks laid on the ground where a tyre slides — a drift,
 * a handbrake turn, a hard stop. Each wheel draws a ribbon as it goes; one
 * mesh holds a car's marks, the oldest giving way to the newest. Drawn only:
 * nothing collides with them, and they aren't saved.
 *
 *   const marks = new SkidMarks(scene);
 *   marks.mark(wheel, point, normal, across, width, strength); // every frame it slides
 *   marks.lift(wheel);                                          // it stopped sliding
 */
export class SkidMarks {
  constructor(scene, { max = 1500 } = {}) {
    this.max = max; // quads
    this.next = 0;
    this.used = 0;
    this.position = new Float32Array(max * 6 * 3);
    this.color = new Float32Array(max * 6 * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const m = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, // over the ground, not flickering in it
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = '__skidMarks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.scene = scene;
    scene?.add(this.mesh);
    this.trails = new Map(); // wheel -> the edge its mark reached: { l, r, p }
  }

  /**
   * Wheel `key` slides at `point` on ground facing `normal`; `across` is the
   * tyre's sideways direction, `width` its width, `strength` 0..1 how dark.
   */
  mark(key, point, normal, across, width, strength = 1) {
    const p = point.clone().addScaledVector(normal, 0.015);
    const l = p.clone().addScaledVector(across, -width / 2);
    const r = p.clone().addScaledVector(across, width / 2);
    const last = this.trails.get(key);
    if (!last || last.p.distanceTo(p) > 3) { // a new mark (or it jumped: start again)
      this.trails.set(key, { l, r, p });
      return;
    }
    if (last.p.distanceTo(p) < 0.12) return; // long enough pieces
    const a = 0.55 * Math.min(1, Math.max(0.15, strength));
    this._quad(last.l, last.r, r, l, a);
    this.trails.set(key, { l, r, p });
  }

  /** It stopped sliding: its next mark starts afresh. */
  lift(key) { this.trails.delete(key); }

  _quad(a, b, c, d, alpha) {
    const i = this.next;
    const verts = [a, b, c, a, c, d];
    for (let k = 0; k < 6; k++) {
      this.position.set([verts[k].x, verts[k].y, verts[k].z], (i * 6 + k) * 3);
      this.color.set([0.04, 0.04, 0.045, alpha], (i * 6 + k) * 4);
    }
    this.next = (i + 1) % this.max;
    this.used = Math.min(this.max, this.used + 1);
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.setDrawRange(0, this.used * 6);
  }

  /** How many pieces of mark there are (for tests). */
  get count() { return this.used; }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.trails.clear();
  }
}
