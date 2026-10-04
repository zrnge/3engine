import { Entity } from './entity.js';

/**
 * LightEntity — wraps a THREE.Light so it can live in the engine's entity
 * list and appear in the hierarchy. Ambient/hemisphere lights have no
 * position to drag; directional/point/spot do.
 */
export class LightEntity extends Entity {
  constructor(light, name) {
    super(light);
    light.name = name;
    light.userData.kind = 'Light';
  }
  /**
   * Lights need no per-frame update, but they must still leave the engine's
   * entity list (this used to only detach the Object3D, so deleted lights
   * accumulated in engine.entities forever), and a spot/directional light's
   * target is a separate Object3D that has to go too.
   */
  destroy(engine) {
    const target = this.object3D.target;
    if (target && target.parent) target.parent.remove(target);
    super.destroy(engine);
  }
}
