// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { disposeObject } from '../src/dispose.js';
import { AnimationPlayer, releaseAnimations } from '../src/animation.js';
import { Engine } from '../src/engine.js';
import { PhysicsWorld, RigidBody } from '../src/physics.js';
import { BehaviorRunner } from '../src/behavior.js';
import { Gameplay } from '../src/gameplay.js';
import { VariableStore } from '../src/variables.js';

const spyDispose = (x) => vi.spyOn(x, 'dispose');

describe('freeing what a removed object held on the GPU', () => {
  it('its own geometry, material and textures are freed', () => {
    const map = new THREE.Texture();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map }));
    const [g, m, t] = [spyDispose(mesh.geometry), spyDispose(mesh.material), spyDispose(map)];
    disposeObject(mesh);
    expect(g).toHaveBeenCalledOnce();
    expect(m).toHaveBeenCalledOnce();
    expect(t).toHaveBeenCalledOnce();
  });

  it('what others still use stays: a model file\'s shared geometry, a library material', () => {
    const geometry = new THREE.BoxGeometry();
    geometry.userData.shared = true; // every copy of a model's file draws it
    const library = new THREE.MeshStandardMaterial();
    library.userData.t3 = { library: 'Brick' };
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, library));
    const [g, m] = [spyDispose(geometry), spyDispose(library)];
    disposeObject(root);
    expect(g).not.toHaveBeenCalled();
    expect(m).not.toHaveBeenCalled();
  });

  it('a texture used in several slots (packed ORM) is freed once', () => {
    const orm = new THREE.Texture();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ aoMap: orm, roughnessMap: orm, metalnessMap: orm }));
    const t = spyDispose(orm);
    disposeObject(mesh);
    expect(t).toHaveBeenCalledOnce();
  });
});

describe('animation players of a removed object', () => {
  it('its own and its children\'s are dropped; others keep playing', () => {
    const engine = { mixers: [] };
    const enemy = new THREE.Group();
    const arm = new THREE.Object3D();
    enemy.add(arm);
    const other = new THREE.Group();
    const a = AnimationPlayer.for(engine, enemy);
    AnimationPlayer.for(engine, arm);
    const keep = AnimationPlayer.for(engine, other);
    const uncache = vi.spyOn(a.mixer, 'uncacheRoot');
    releaseAnimations(engine, enemy);
    expect(engine.mixers).toEqual([keep]);
    expect(uncache).toHaveBeenCalledWith(enemy);
  });
});

describe('Engine.remove — what a destroyed object leaves behind', () => {
  /** Just what remove() touches (the real Engine needs WebGL). */
  function fakeEngine() {
    const engine = {
      entities: [], scene: new THREE.Scene(), physics: new PhysicsWorld(), variables: new VariableStore(),
      mixers: [], poses: new Map(), _behaviors: new BehaviorRunner(),
      audio: { retire: vi.fn() }, onEntityRemoved: vi.fn(),
      removeBehavior(e) { this._behaviors.remove(e); },
    };
    engine.gameplay = new Gameplay(engine);
    return engine;
  }

  it('nothing of it stays: body, animation, pose, sounds, GPU memory — even under a parent', () => {
    const engine = fakeEngine();
    const carrier = new THREE.Group();
    engine.scene.add(carrier);
    const shot = { object3D: new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshStandardMaterial()),
      rigidBody: new RigidBody({ type: 'dynamic' }) };
    carrier.add(shot.object3D);
    engine.entities.push(shot);
    engine.physics.register(shot);
    AnimationPlayer.for(engine, shot.object3D);
    engine.poses.set(shot.object3D, { y: 1 });
    const freed = spyDispose(shot.object3D.geometry);

    Engine.prototype.remove.call(engine, shot);

    expect(engine.entities).toEqual([]);
    expect(engine.physics.bodies).toEqual([]);
    expect(shot.object3D.parent).toBeNull(); // it used to stay drawn under its parent
    expect(engine.mixers).toEqual([]);
    expect(engine.poses.size).toBe(0);
    expect(engine.audio.retire).toHaveBeenCalledWith(shot);
    expect(freed).toHaveBeenCalled();
    expect(engine.onEntityRemoved).toHaveBeenCalledWith(shot);
  });
});
