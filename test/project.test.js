import { describe, it, expect, vi } from 'vitest';
import { Project, emptyLevelData, isProject, projectScenes } from '../src/project.js';
import { VariableStore } from '../src/variables.js';
import { Gameplay } from '../src/gameplay.js';
import { ACTIONS } from '../src/rules.js';
import { COMPONENTS } from '../src/components.js';
import { GameExporter } from '../src/export.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * The engine a project touches is the controls and the variables; the
 * serializer is a stand-in that keeps the "live" scene as data.
 */
function harness() {
  const engine = {
    playing: false,
    variables: new VariableStore(),
    gameplay: {
      controls: {
        list: [{ id: 'default' }],
        load(list) { this.list = clone(list); },
        toJSON() { return clone(this.list); },
      },
    },
  };
  const h = { engine, live: { version: 1, entities: [], tag: 'first' } };
  h.serializer = {
    engine,
    serialize: vi.fn(() => clone({
      ...h.live, controls: engine.gameplay.controls.toJSON(), variables: engine.variables.toJSON(),
    })),
    deserialize: vi.fn(async (data) => {
      h.live = clone(data);
      if (data.controls) engine.gameplay.controls.load(data.controls);
      if (data.variables) engine.variables.load(data.variables);
    }),
  };
  h.project = new Project(h.serializer);
  return h;
}

describe('Project — levels', () => {
  it('starts with one level; each level keeps its own contents', async () => {
    const h = harness();
    expect(h.project.names()).toEqual(['Level 1']);
    const boss = h.project.add('Boss room');
    await h.project.open(boss);
    expect(h.live.entities).toEqual([]);                  // a new level is empty
    expect(h.live.tag).toBeUndefined();
    h.live.tag = 'boss';                                  // "edit" it
    await h.project.open(0);
    expect(h.live.tag).toBe('first');
    await h.project.open(boss);
    expect(h.live.tag).toBe('boss');
    expect(h.project.current).toBe(1);
  });

  it('controls and variables belong to the whole game', async () => {
    const h = harness();
    h.engine.variables.define('score', 0);
    h.engine.gameplay.controls.load([{ id: 'wasd' }]);
    const other = h.project.add();
    // a level saved with different controls and variables of its own
    h.project.levels[other].data = { version: 1, entities: [], controls: [{ id: 'old' }], variables: { lives: 3 } };
    await h.project.open(other);
    expect(h.engine.gameplay.controls.list).toEqual([{ id: 'wasd' }]);
    expect(h.engine.variables.toJSON()).toEqual({ score: 0 });
  });

  it('keeps the variables\' values when moving between levels in play', async () => {
    const h = harness();
    h.engine.variables.define('score', 0);
    h.project.add();
    h.engine.variables.set('score', 7);
    await h.project.loadLevel(1, { keepValues: true });
    expect(h.engine.variables.get('score')).toBe(7);
    expect(h.project.active).toBe(1);
    expect(h.project.current).toBe(0); // still editing level 1
    await h.project.loadLevel(0);
    expect(h.engine.variables.get('score')).toBe(0);
  });

  it('resolves where "Go to level" goes', () => {
    const h = harness();
    h.project.add('Forest');
    h.project.add('Boss Room');
    const p = h.project;
    expect(p.resolve('next', 0)).toBe(1);
    expect(p.resolve('', 1)).toBe(2);
    expect(p.resolve('next', 2)).toBe(-1);   // past the last level
    expect(p.resolve('previous', 1)).toBe(0);
    expect(p.resolve('previous', 0)).toBe(-1);
    expect(p.resolve('this', 2)).toBe(2);
    expect(p.resolve('boss room', 0)).toBe(2);
    expect(p.resolve('2', 0)).toBe(1);
    expect(p.resolve('9', 0)).toBe(-1);
    expect(p.resolve('nowhere', 0)).toBe(-1);
    p.setStart(1);
    expect(p.resolve('first', 2)).toBe(1);
  });

  it('renames uniquely, reorders, duplicates and deletes, keeping its place', async () => {
    const h = harness();
    const p = h.project;
    p.add('Forest');
    p.add('Cave');
    expect(p.rename(2, 'forest')).toBe('forest 2');
    expect(p.rename(2, '  ')).toBe('forest 2');
    p.setStart(1);
    await p.open(1);
    expect(p.move(1, -1)).toBe(true);
    expect(p.names()).toEqual(['Forest', 'Level 1', 'forest 2']);
    expect([p.current, p.start]).toEqual([0, 0]); // both followed the move

    h.live.tag = 'forest';
    const copy = p.duplicate(0);
    expect(p.names()[copy]).toBe('Forest copy');
    expect(p.levels[copy].data.tag).toBe('forest');

    await p.remove(0); // the open one: its neighbour opens
    expect(p.names()).toEqual(['Forest copy', 'Level 1', 'forest 2']);
    expect(p.current).toBe(0);
    expect(h.live.tag).toBe('forest');
    p.levels.splice(1);
    expect(await p.remove(0)).toBe(false); // never the last level
  });

  it('saves every level and opens them again', async () => {
    const h = harness();
    h.engine.variables.define('coins', 2);
    h.project.add('Boss');
    h.project.setStart(0);
    await h.project.open(1);
    h.live.tag = 'boss';
    const json = clone(h.project.toJSON());
    expect(isProject(json)).toBe(true);
    expect(json.levels.map((l) => l.name)).toEqual(['Level 1', 'Boss']);
    expect(json.levels[1].scene.tag).toBe('boss');
    expect(json.shared.variables).toEqual({ coins: 2 });
    expect(projectScenes(json)).toHaveLength(2);

    const again = harness();
    await again.project.load(json);
    expect(again.project.names()).toEqual(['Level 1', 'Boss']);
    expect(again.project.current).toBe(1);
    expect(again.live.tag).toBe('boss');
    expect(again.engine.variables.toJSON()).toEqual({ coins: 2 });

    const game = harness();
    await game.project.load(json, { at: 'start' }); // an exported game
    expect(game.project.active).toBe(0);
    expect(game.live.tag).toBe('first');
  });

  it('opens a single scene from before levels existed as a one-level game', async () => {
    const h = harness();
    await h.project.load({ version: 1, entities: [], tag: 'old', variables: { gems: 1 } });
    expect(h.project.names()).toEqual(['Level 1']);
    expect(h.live.tag).toBe('old');
    expect(h.engine.variables.toJSON()).toEqual({ gems: 1 });
    await expect(h.project.load({ nope: true })).rejects.toThrow();
    expect(projectScenes({ version: 1 })).toHaveLength(1);
    expect(emptyLevelData().entities).toEqual([]);
  });

  it('does not overwrite a level with play-mode changes', () => {
    const h = harness();
    h.project.snapshot();
    h.engine.playing = true;
    h.live.tag = 'mid-game';
    h.project.toJSON();
    expect(h.project.levels[0].data.tag).toBe('first');
  });
});

describe('Go to level in gameplay', () => {
  function fakeEngine() {
    const engine = {
      entities: [],
      variables: new VariableStore(),
      physics: { events: [], resetContacts() {} },
      input: { isDown: () => false, wasPressed: () => false },
      playerEntity: null,
    };
    engine.gameplay = new Gameplay(engine);
    return engine;
  }

  it('changes level after the frame, and gameplay waits for it', async () => {
    const engine = fakeEngine();
    const calls = [];
    let finish;
    engine.gameplay.onGoToLevel = (t) => { calls.push(t); return new Promise((r) => { finish = r; }); };
    const update = vi.spyOn(engine.gameplay.rules, 'update');

    expect(engine.gameplay.goToLevel('Boss')).toBe(true);
    expect(calls).toEqual([]); // not in the middle of the frame
    expect(engine.gameplay.goToLevel('Other')).toBe(false); // one at a time
    engine.gameplay.update(0.016, 0);
    expect(update).not.toHaveBeenCalled(); // paused while loading

    await vi.waitFor(() => expect(calls).toEqual(['Boss']));
    finish();
    await vi.waitFor(() => expect(engine.gameplay.loading).toBe(false));
    engine.gameplay.update(0.016, 0);
    expect(update).toHaveBeenCalled();
  });

  it('arriving in a level keeps the score; starting the game resets it', () => {
    const engine = fakeEngine();
    engine.variables.define('score', 0);
    engine.variables.set('score', 5);
    engine.gameplay.start({ keepVariables: true });
    expect(engine.variables.get('score')).toBe(5);
    engine.gameplay.start();
    expect(engine.variables.get('score')).toBe(0);
  });

  it('the rule action and the Level exit component both ask to go', () => {
    const api = { goToLevel: vi.fn() };
    ACTIONS.goToLevel.run({ action: { level: 'Boss' }, api });
    expect(api.goToLevel).toHaveBeenCalledWith('Boss');

    const state = {};
    const ctx = { props: { level: 'next', who: 'any' }, state, engine: {}, api };
    COMPONENTS.levelExit.onTrigger(ctx, { object3D: {} });
    COMPONENTS.levelExit.onTrigger(ctx, { object3D: {} }); // only once
    expect(api.goToLevel).toHaveBeenCalledTimes(2);
    expect(api.goToLevel).toHaveBeenLastCalledWith('next');
  });
});

describe('exporting a game with levels', () => {
  it('embeds the assets of every level', () => {
    const exporter = new GameExporter({ serialize: () => ({}) });
    const game = {
      type: 'tiny3-project', levels: [
        { name: 'A', scene: { entities: [{ type: 'model', assetId: 'tree' }] } },
        { name: 'B', scene: { entities: [{ type: 'model', assetId: 'tree' }], sceneSounds: [{ assetId: 'boss-theme' }] } },
      ],
    };
    expect(exporter._assetIds(game).sort()).toEqual(['boss-theme', 'tree']);
  });
});
