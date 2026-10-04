import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Player } from '../src/player.js';
import { Entity } from '../src/entity.js';
import { PhysicsWorld } from '../src/physics.js';

// What the player can DO is tested in controls.test.js; Player only decides
// which object is the player.

function fakeEngine({ playing = true } = {}) {
  return { physics: new PhysicsWorld(), playing, entities: [] };
}

function target(name = 'Hero') {
  const e = new Entity(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
  e.object3D.name = name;
  return e;
}

describe('Player', () => {
  it('the stand-in is never drawn, wherever it is made — the editor or an exported game', () => {
    const player = new Player();
    expect(player.object3D.visible).toBe(false);
    expect(player.object3D.userData.kind).toBe('Player');
    player.reset();
    expect(player.object3D.visible).toBe(false);
  });

  it('has no key bindings of its own any more', () => {
    const player = new Player();
    expect(player.controls).toBeUndefined();
    expect(player.controlled).toBe(player);
    player.target = target();
    expect(player.controlled).toBe(player.target);
  });

  it('does nothing while the editor is not playing', () => {
    const engine = fakeEngine({ playing: false });
    const player = new Player();
    engine.physics.register(player);
    player.target = target();
    player.update(1 / 60, engine);
    expect(engine.physics.bodyFor(player)).not.toBeNull(); // untouched in edit mode
  });

  it('detaches its own body while another object is the player', () => {
    // otherwise an invisible cube falls through the level shoving things around
    const engine = fakeEngine();
    const player = new Player();
    engine.physics.register(player);
    expect(engine.physics.bodyFor(player)).not.toBeNull();

    player.target = target();
    player.update(1 / 60, engine);
    expect(engine.physics.bodyFor(player)).toBeNull();

    player.target = null;
    player.update(1 / 60, engine);
    expect(engine.physics.bodyFor(player)).not.toBeNull();
  });
});
