import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { TEMPLATES } from '../src/templates.js';
import { isProject } from '../src/project.js';
import { COMPONENTS } from '../src/components.js';
import { EVENTS, ACTIONS, CONDITIONS } from '../src/rules.js';
import { CONTROL_ACTIONS } from '../src/controls.js';

const BOX = 1.5;

/** Every rule, component and control in a template names things that exist. */
function checkLevel(scene, shared) {
  const names = new Set(scene.entities.map((e) => e.name));
  const sounds = new Set((scene.sceneSounds || []).map((s) => s.name));
  const variables = new Set(Object.keys(shared.variables));
  const problems = [];

  const player = scene.entities[scene.player.target];
  if (player?.name !== 'Player') problems.push('player target is not "Player"');
  if (player?.rigidBody?.type !== 'dynamic') problems.push('player has no dynamic body');

  for (const e of scene.entities) {
    for (const c of e.components || []) {
      if (!COMPONENTS[c.type]) problems.push(`${e.name}: unknown component ${c.type}`);
      if (c.props.sound && !sounds.has(c.props.sound)) problems.push(`${e.name}: no sound "${c.props.sound}"`);
      if (c.props.variable && !variables.has(c.props.variable)) problems.push(`${e.name}: no variable "${c.props.variable}"`);
      if (c.props.mirrorTo && !variables.has(c.props.mirrorTo)) problems.push(`${e.name}: no variable "${c.props.mirrorTo}"`);
      if ((c.type === 'collectible' || c.type === 'levelExit' || c.type === 'damager') && !e.rigidBody?.isTrigger) {
        problems.push(`${e.name}: ${c.type} without a trigger body never fires`);
      }
    }
    for (const r of e.rules || []) {
      if (!EVENTS[r.when.type]) problems.push(`${e.name}: unknown event ${r.when.type}`);
      if (r.when.type === 'variable' && !variables.has(r.when.name)) problems.push(`${e.name}: no variable "${r.when.name}"`);
      for (const c of r.if || []) {
        if (!CONDITIONS[c.type] || (c.type === 'variable' && !variables.has(c.name))) problems.push(`${e.name}: bad condition`);
      }
      for (const a of r.do || []) {
        if (!ACTIONS[a.type]) problems.push(`${e.name}: unknown action ${a.type}`);
        if (a.sound && !sounds.has(a.sound)) problems.push(`${e.name}: no sound "${a.sound}"`);
        const group = /^group:/.test(a.target || '') && scene.entities.some((x) => x.groups?.includes(a.target.slice(6)));
        if (['destroy', 'setVisible'].includes(a.type) && !['self', 'other', 'player'].includes(a.target) && !names.has(a.target) && !group) {
          problems.push(`${e.name}: no object "${a.target}"`);
        }
        if (/Variable$/.test(a.type) && !variables.has(a.name)) problems.push(`${e.name}: no variable "${a.name}"`);
      }
    }
  }
  for (const name of Object.keys(shared.ui?.hud || {})) {
    if (!variables.has(name)) problems.push(`HUD style for missing variable "${name}"`);
  }
  for (const c of shared.controls) {
    if (!CONTROL_ACTIONS[c.action.type]) problems.push(`control: unknown action ${c.action.type}`);
    if (c.action.sound && !sounds.has(c.action.sound)) problems.push(`control: no sound "${c.action.sound}"`);
  }
  return problems;
}

describe('templates', () => {
  it('each is a complete project whose rules, components and controls all line up', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(['platformer', 'collector', 'explorer', 'racing', 'shooter', 'stealth', 'valley', 'horror']);
    for (const t of TEMPLATES) {
      const game = t.build();
      expect(isProject(game), t.id).toBe(true);
      for (const level of game.levels) {
        expect(checkLevel(level.scene, game.shared), `${t.id} / ${level.name}`).toEqual([]);
      }
    }
  });

  it('every level can be finished: a way to win or to the next level', () => {
    for (const t of TEMPLATES) {
      for (const level of t.build().levels) {
        const ends = level.scene.entities.some((e) =>
          (e.components || []).some((c) => c.type === 'levelExit' || (c.type === 'race' && c.props.winPlaces > 0))
          || (e.rules || []).some((r) => r.do.some((a) => a.type === 'win')));
        expect(ends, `${t.id} / ${level.name}`).toBe(true);
      }
    }
  });

  it('the platformer\'s jumps are all makeable with the default jump', () => {
    // gravity -24, jump 9: ~1.69 m up; at 8 m/s about 6 m across on the level
    const top = (e) => e.position[1] + (e.scale[1] * BOX) / 2;
    const half = (e, i) => (e.scale[i] * BOX) / 2;
    for (const level of TEMPLATES[0].build().levels) {
      const path = level.scene.entities.filter((e) => /island|Platform/i.test(e.name));
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        const gx = Math.max(0, Math.abs(a.position[0] - b.position[0]) - half(a, 0) - half(b, 0));
        const gz = Math.max(0, Math.abs(a.position[2] - b.position[2]) - half(a, 2) - half(b, 2));
        const step = top(b) - top(a);
        expect(Math.hypot(gx, gz), `${level.name}: ${a.name} → ${b.name}`).toBeLessThanOrEqual(3);
        expect(step, `${level.name}: ${a.name} → ${b.name}`).toBeLessThanOrEqual(1.2);
      }
    }
  });

  it('the explorer plays in first person but opens in an editing view', () => {
    const scene = TEMPLATES[2].build().levels[0].scene;
    expect(scene.camera.mode).toBe('orbit');
    expect(scene.camera.playMode).toBe('fps');
    const interact = TEMPLATES[2].build().shared.controls.find((c) => c.action.type === 'interact');
    expect(interact.inputs.map((i) => i.code || i.label)).toEqual(['KeyE', 'E']);
  });

  it('each has a title screen, and an animated player (or a car — or in first person, where you never see yourself, none)', () => {
    for (const t of TEMPLATES) {
      const game = t.build();
      expect(game.shared.ui.title.enabled, t.id).toBe(true);
      const { entities } = game.levels[0].scene;
      const player = entities.find((e) => e.name === 'Player');
      expect((player.components || []).map((c) => c.type).some((c) => c === 'animator' || c === 'vehicle')
        || game.levels[0].scene.camera.playMode === 'fps', t.id).toBe(true);
    }
  });

  it('the racing game: four cars on the grid with four tyres each, a race round three checkpoints, played from behind', () => {
    const scene = TEMPLATES[3].build().levels[0].scene;
    const cars = scene.entities.filter((e) => e.components?.some((c) => c.type === 'vehicle'));
    expect(cars.map((c) => c.name)).toEqual(['Player', 'Rival 1', 'Rival 2', 'Rival 3']);
    for (const c of cars) {
      const i = scene.entities.indexOf(c);
      const tyres = scene.entities.filter((e) => e.parent === i && /tire/.test(e.name));
      expect(tyres.length, c.name).toBe(4);
      // a tyre: about 0.76 m across, 0.28 m wide, however the body is scaled
      // turned on its side: its own x is along the body's y, its own y along the body's x
      const [tx, ty, tz] = tyres[0].scale;
      expect(+(tx * c.scale[1] * 0.7 * 2).toFixed(2)).toBe(0.76); // its round, up and down…
      expect(+(tz * c.scale[2] * 0.7 * 2).toFixed(2)).toBe(0.76); // …and along the car
      expect(+(ty * c.scale[0] * 1.8).toFixed(2)).toBe(0.28); // its width
    }
    const start = scene.entities.find((e) => e.name === 'Start line');
    expect(start.components[0].type).toBe('race');
    expect(scene.entities.filter((e) => e.groups?.includes('Checkpoints')).map((e) => e.name))
      .toEqual(['Checkpoint 1', 'Checkpoint 2', 'Checkpoint 3']);
    expect(scene.camera.playMode).toBe('follow');
    expect(scene.player.target).toBe(scene.entities.findIndex((e) => e.name === 'Player'));
  });

  it('builds a fresh copy every time — changing one game never changes the template', () => {
    const a = TEMPLATES[0].build();
    a.levels[0].scene.entities[0].name = 'changed';
    expect(TEMPLATES[0].build().levels[0].scene.entities[0].name).toBe('Start island');
  });

  it('AK Arena: models from files, a held AK, robots of three bullets, a player of five hits, ammo and reloading', () => {
    const game = TEMPLATES.find((t) => t.id === 'shooter').build();
    const scene = game.levels[0].scene;
    const models = scene.entities.filter((e) => e.type === 'model');
    for (const m of models) expect(existsSync(new URL(`../${m.assetUrl}`, import.meta.url)), m.assetUrl).toBe(true);
    const ak = scene.entities.find((e) => e.name === 'AK74u');
    expect(ak.viewModel).toBeTruthy();
    const robots = scene.entities.filter((e) => e.groups?.includes('Enemies'));
    expect(robots.length).toBe(4);
    for (const r of robots) {
      expect(r.components.find((c) => c.type === 'health').props.max).toBe(3);
      expect(r.rules.some((x) => x.do.some((a) => a.type === 'attack' && a.hits === 'player'))).toBe(true);
    }
    const player = scene.entities[scene.player.target];
    expect(player.components.find((c) => c.type === 'health').props).toMatchObject({ max: 5, mirrorTo: 'health' });
    expect(player.rules.some((r) => r.when.type === 'healthOut' && r.do[0].type === 'lose')).toBe(true);
    const fire = game.shared.controls.find((c) => c.action.type === 'hitscan');
    expect(fire.if.map((c) => c.name)).toEqual(['ammo', '_reloading']);
    expect(fire.more[0].action).toMatchObject({ type: 'changeVariable', name: 'ammo', by: -1 });
    const reload = game.shared.controls.find((c) => c.inputs.some((i) => i.code === 'KeyR') && c.more);
    expect(reload.more.find((m) => m.join === 'then').action).toMatchObject({ type: 'setVariable', name: 'ammo', value: 30 });
    expect(scene.camera.playMode).toBe('fps');
  });

  it('Hollow House: a note, a key, a door on its hinge, a music box that lets the ghost out, a way out', () => {
    const game = TEMPLATES.find((t) => t.id === 'horror').build();
    const scene = game.levels[0].scene;
    const named = (n) => scene.entities.find((e) => e.name === n);
    // the lantern goes with the player
    expect(named('Lantern').parent).toBe(scene.entities.indexOf(named('Player')));
    // interact: the note, the drawer (the key), the bedroom door (locked without it), the music box
    for (const n of ['Note', 'Drawer', 'Bedroom door', 'Music box']) {
      expect(named(n).rules.some((r) => r.when.type === 'interact'), n).toBe(true);
    }
    const open = named('Bedroom door').rules.find((r) => r.do.some((a) => a.type === 'turn'));
    expect(open.if[0]).toMatchObject({ name: 'key', op: '>=', value: 1 });
    expect(open.do[0]).toMatchObject({ pivot: 'a point on it', pivotX: 'left' }); // about its hinge
    // the music box: the lamps out, the ghost spawned at its marker, the front door opens
    const take = named('Music box').rules[0].do;
    expect(take).toContainEqual(expect.objectContaining({ type: 'setVisible', target: 'group:Lamps', visible: false }));
    expect(named('Ghost spawn').rules[0].do[0]).toMatchObject({ type: 'spawn', prefab: 'Ghost' });
    expect(Object.keys(scene.prefabs)).toEqual(['Ghost']);
    expect(scene.prefabs.Ghost.components[0].type).toBe('follower');
    expect(scene.prefabs.Ghost.rules[0].do.some((a) => a.type === 'lose')).toBe(true);
    expect(named('Front door').rules[0].when).toMatchObject({ type: 'variable', name: 'musicBox' });
    expect(named('Way out').rules[0].do[0].type).toBe('win');
    // every sound a rule plays is one of its own
    const sounds = new Set(scene.sceneSounds.map((x) => x.name));
    for (const e of [...scene.entities, ...Object.values(scene.prefabs)]) {
      for (const r of e.rules || []) for (const a of r.do) if (a.sound) expect(sounds.has(a.sound), `${e.name}: ${a.sound}`).toBe(true);
    }
    // no jumping; Shift runs
    expect(game.shared.controls.some((c) => c.action.type === 'jump')).toBe(false);
    expect(game.shared.controls.some((c) => c.action.type === 'sprint')).toBe(true);
  });
});
