// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { ScriptModules, transformModule, scriptImports, moduleKey } from '../src/script-modules.js';
import { BehaviorRunner } from '../src/behavior.js';
import { countScripts } from '../src/script-trust.js';
import { buildLogicGraph, linkRules, unlink, freshEventName, ruleKey, describeAction } from '../src/tools/logic-graph.js';
import { Debugger, watchEntity } from '../src/tools/debugger.js';
import { Profiler, PARTS } from '../src/tools/profiler.js';
import { world } from './helpers/world.js';
import { ACTIONS } from '../src/rules.js';

describe('script modules', () => {
  const mods = (list) => { const m = new ScriptModules({ variables: null }); m.load(list); return m; };

  it('exports functions, constants, classes, a default — and imports from each other', () => {
    const m = mods([
      { name: 'maths', code: 'export const TAU = Math.PI * 2;\nexport function twice(x) { return x * 2; }\nexport class Box { constructor(n) { this.n = n; } }\nexport default 42;' },
      { name: 'game', code: "import { twice, TAU as T } from 'maths';\nimport answer from './maths.js';\nimport * as all from 'Maths';\nexport const four = twice(2);\nexport const both = [T, answer, all.twice(5)];" },
    ]);
    const g = m.use('game');
    expect(g.four).toBe(4);
    expect(g.both).toEqual([Math.PI * 2, 42, 10]);
    expect(new (m.use('maths').Box)(3).n).toBe(3);
  });

  it('a module runs once; its `let` is shared and read live; Play again runs it afresh', () => {
    const m = mods([{ name: 'counter', code: 'export let count = 0;\nexport function bump() { count++; return count; }' }]);
    const c = m.use('counter');
    c.bump(); c.bump();
    expect(m.use('counter').count).toBe(2);
    m.reset();
    expect(m.use('counter').count).toBe(0);
  });

  it('export lists, renames, and several names on one line', () => {
    const m = mods([{ name: 'a', code: 'const x = 1, y = [2, 3], z = { k: 4 };\nfunction f() { return 5; }\nexport { x, f as five };\nexport let p = 1, q = 2;\nexport const { k } = z;' }]);
    const a = m.use('a');
    expect(a.x).toBe(1);
    expect(a.five()).toBe(5);
    expect([a.p, a.q, a.k]).toEqual([1, 2, 4]);
    expect(transformModule('export const a = 1;\nlet b = 2;').split('\n').length).toBe(2); // lines stay where they were
  });

  it('two modules importing each other get what has run so far', () => {
    const m = mods([
      { name: 'ping', code: "import { pong } from 'pong';\nexport function ping(n) { return n <= 0 ? 'ping' : pong(n - 1); }" },
      { name: 'pong', code: "import { ping } from 'ping';\nexport function pong(n) { return n <= 0 ? 'pong' : ping(n - 1); }" },
    ]);
    expect(m.use('ping').ping(3)).toBe('pong');
  });

  it('says which module, and which line, a mistake is on — and when there is no such module', () => {
    const m = mods([{ name: 'bad', code: 'export const a = 1;\nexport const b = 2;\nnope();' }]);
    expect(() => m.use('bad')).toThrow(/Script module "bad": .*nope.*\(line 3\)/);
    expect(() => m.use('missing')).toThrow(/no script module "missing".*bad/);
    expect(() => mods([{ name: 's', code: 'export const = ;' }]).use('s')).toThrow(/Script module "s"/);
  });

  it('a Behavior script imports at its top; its line numbers stay the same', () => {
    expect(scriptImports("import { twice } from 'maths';\nentity.x = twice(2);")).toBe("const { twice } = use(\"maths\");\nentity.x = twice(2);");
    const m = mods([{ name: 'maths', code: 'export function twice(x) { return x * 2; }' }]);
    const runner = new BehaviorRunner();
    const entity = { object3D: { name: 'Cube', position: { x: 0 } } };
    runner.add(entity, "import { twice } from 'maths';\nentity.position.x = twice(21);", { api: { use: (n) => m.use(n) } });
    runner.run(1 / 60, 0);
    expect(entity.object3D.position.x).toBe(42);
  });

  it('names, saving, and a game with modules counts as having scripts', () => {
    expect(moduleKey('./Maths.js')).toBe('maths');
    const m = mods([]);
    m.set('maths', 'export const a = 1;');
    m.rename('maths', 'numbers');
    expect(m.toJSON()).toEqual([{ name: 'numbers', code: 'export const a = 1;' }]);
    expect(countScripts({ type: 'tiny3-project', levels: [], shared: { modules: m.toJSON() } })).toBe(1);
  });
});

/** A small level with linked rules: a key sends an alarm, the guard hears it, chases, the score goes up, a screen shows. */
function linkedLevel() {
  const w = world();
  const { engine, add } = w;
  const button = add('Button');
  const guard = add('Guard');
  const hud = add('Hud');
  const R = engine.gameplay.rules;
  R.add(button, { when: { type: 'key', code: 'KeyE', mode: 'pressed' }, if: [], do: [{ type: 'sendEvent', name: 'alarm', to: 'Guard', after: 0 }] });
  R.add(guard, { when: { type: 'event', name: 'alarm' }, if: [], do: [{ type: 'setState', target: 'self', state: 'chasing' }] });
  R.add(guard, { when: { type: 'stateEnter', state: 'chasing' }, if: [], do: [{ type: 'changeVariable', name: 'score', by: '5' }] });
  R.add(hud, { when: { type: 'variable', name: 'score', op: '>=', value: '5' }, if: [], do: [{ type: 'showScreen', screen: 'Win', how: 'show' }] });
  R.add(hud, { when: { type: 'uiButton', screen: 'Win', button: 'Again' }, if: [{ type: 'expression', expr: 'score > 1' }], do: [{ type: 'restart' }] });
  return { ...w, button, guard, hud };
}

describe('the Logic graph', () => {
  it('each rule is a node; what one sets off elsewhere is a link', () => {
    const { engine, button, guard } = linkedLevel();
    const g = buildLogicGraph(engine);
    expect(g.nodes.filter((n) => n.kind === 'rule')).toHaveLength(5);
    const has = (from, to, kind) => g.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
    expect(has(`rule:${ruleKey(button, 0)}`, `rule:${ruleKey(guard, 0)}`, 'event'), 'alarm').toBe(true);
    expect(has(`rule:${ruleKey(guard, 0)}`, `rule:${ruleKey(guard, 1)}`, 'state'), 'chasing').toBe(true);
    expect(has(`rule:${ruleKey(guard, 1)}`, 'var:score', 'write')).toBe(true);
    const reads = g.edges.filter((e) => e.from === 'var:score' && e.kind === 'read');
    expect(reads, 'its watch and the expression').toHaveLength(2);
    expect(g.edges.some((e) => e.from.endsWith('>') || (e.from === 'screen:win' && e.kind === 'screen'))).toBe(true);
    // its lines say what it does; a line that links has a port
    const first = g.byId.get(`rule:${ruleKey(button, 0)}`);
    expect(first.lines.map((l) => l.text)).toEqual(['WHEN E pressed', 'Send “alarm” → Guard']);
    expect(first.lines[1].port).toBe(true);
  });

  it('an event sent to someone else is not linked to the guard', () => {
    const { engine, button, guard } = linkedLevel();
    engine.gameplay.rules.listFor(button)[0].do[0].to = 'Hud';
    const g = buildLogicGraph(engine);
    expect(g.edges.some((e) => e.to === `rule:${ruleKey(guard, 0)}`)).toBe(false);
  });

  it('laid out in columns without overlapping; a dragged rule keeps its place', () => {
    const { engine, hud } = linkedLevel();
    engine.gameplay.rules.listFor(hud)[1].at = [900, 40];
    const g = buildLogicGraph(engine);
    const rules = g.nodes.filter((n) => n.kind === 'rule' && !n.rule.at);
    for (const a of rules) for (const b of rules) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlap, `${a.id} / ${b.id}`).toBe(false);
    }
    const dragged = g.nodes.find((n) => n.rule?.at);
    expect([dragged.x, dragged.y]).toEqual([900, 40]);
  });

  it('a link drawn from a rule to an object: it sends the event, and the object gets a rule receiving it', () => {
    const { engine, button, hud } = linkedLevel();
    const name = freshEventName(engine);
    const changes = linkRules(engine, button, 0, hud, name);
    for (const { entity, next } of changes) engine.gameplay.rules.setFor(entity, next);
    expect(engine.gameplay.rules.listFor(button)[0].do.at(-1)).toMatchObject({ type: 'sendEvent', name: 'event', to: 'Hud' });
    expect(engine.gameplay.rules.listFor(hud).at(-1).when).toEqual({ type: 'event', name: 'event' });
    const g = buildLogicGraph(engine);
    const edge = g.edges.find((e) => e.kind === 'event' && e.label === 'event');
    expect(edge).toBeTruthy();
    // ...and taken away again
    for (const { entity, next } of unlink(engine, edge)) engine.gameplay.rules.setFor(entity, next);
    expect(engine.gameplay.rules.listFor(button)[0].do.some((a) => a.name === 'event')).toBe(false);
    expect(freshEventName(engine)).toBe('event 2'); // the receiving rule still uses it
  });

  it('the Controls that reach rules come in from a Controls node', () => {
    const { engine, hud } = linkedLevel();
    engine.gameplay.controls.load([{ inputs: [{ type: 'key', code: 'KeyM' }], target: 'player', action: { type: 'changeVariable', name: 'score', by: '1' } }]);
    const g = buildLogicGraph(engine);
    expect(g.byId.get('controls').lines[0].text).toBe('M: score += 1');
    expect(g.edges.some((e) => e.from === 'controls' && e.to === 'var:score')).toBe(true);
    expect(describeAction({ type: 'showScreen', screen: '', how: 'hide' })).toBe('Hide screen (all)');
    expect(hud).toBeTruthy();
  });
});

describe('the Debugger', () => {
  it('traces what runs, and a breakpoint pauses the game at the end of that frame', () => {
    const { engine, step, input, button, guard } = linkedLevel();
    const dbg = new Debugger(engine);
    dbg.attach();
    const frame = () => { step(); engine.onFrameDone?.(false); };
    engine.gameplay.start();
    dbg.toggleBreakpoint(ruleKey(guard, 1)); // "I enter chasing"
    const stopped = vi.fn();
    dbg.onStop = stopped;
    input.press('KeyE');
    frame();
    const texts = dbg.filtered().map((t) => `${t.kind} ${t.who}: ${t.text}`);
    expect(texts.some((t) => t.startsWith('rule Button: WHEN E pressed → DO'))).toBe(true);
    expect(texts.some((t) => t.startsWith('event Button: sent “alarm” → Guard'))).toBe(true);
    expect(texts.some((t) => t.startsWith('rule Guard: WHEN I enter “chasing”'))).toBe(true);
    expect(engine.paused).toBe(true);
    expect(stopped).toHaveBeenCalledOnce();
    expect(dbg.stoppedAt.text).toMatch(/Breakpoint: Guard · rule 2/);
    expect(dbg.runs.get(ruleKey(button, 0)).count).toBe(1);
    // a step lets one frame through, then it is paused again
    dbg.step(2);
    expect(engine.stepFrames).toBe(2);
    dbg.resume();
    expect(engine.paused).toBe(false);
    expect(dbg.filtered('alarm').every((t) => /alarm/.test(t.text))).toBe(true);
    dbg.detach();
    expect(engine.onRuleRun).toBe(null);
  });

  it('a failing rule is traced, and pauses with "break on errors"', () => {
    const { engine, step, add } = world();
    const bad = add('Bad');
    ACTIONS.boom = { label: 'Boom', props: {}, run() { throw new Error('boom'); } };
    engine.gameplay.rules.add(bad, { when: { type: 'update', every: 0 }, if: [], do: [{ type: 'boom' }] });
    const dbg = new Debugger(engine);
    dbg.breakOnErrors = true;
    dbg.attach();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      engine.gameplay.start();
      step();
      engine.onFrameDone(false);
    } finally {
      err.mockRestore();
      delete ACTIONS.boom;
    }
    expect(dbg.trace.find((t) => t.kind === 'error').text).toBe('rule 1 failed: boom');
    expect(engine.paused).toBe(true);
    expect(dbg.stoppedAt).toMatchObject({ kind: 'error', text: 'Error in Bad · rule 1: boom' });
  });

  it('watching an object: where it is, its body, its state and its components', () => {
    const { engine, add } = world();
    const crate = add('Crate', { at: [1, 2, 3], body: { type: 'dynamic' } });
    engine.gameplay.components.add(crate, 'health', { max: 10 });
    engine.gameplay.start();
    crate.state = 'open'; // (Play starts every object with no state of its own)
    const rows = Object.fromEntries(watchEntity(engine, crate));
    expect(rows.position).toBe('1, 2, 3');
    expect(rows.body).toBe('dynamic');
    expect(rows.state).toBe('open');
    expect(Object.keys(rows).some((k) => /health/i.test(k))).toBe(true);
  });
});

describe('the Profiler', () => {
  it('each part of a frame, what is left over, and the slowest things', () => {
    let t = 0;
    const p = new Profiler({ clock: () => t });
    for (let f = 0; f < 40; f++) {
      p.frameStart(null);
      p.begin('physics'); t += 2; p.end('physics');
      p.begin('scripts');
      p.item('scripts', 'Guard', 3); p.item('scripts', 'Door', 0.5);
      t += 3.5; p.end('scripts');
      p.begin('components'); t += 1; p.item('components', 'Enemy AI', 1, 'Guard'); p.end('components');
      t += 1.5; // the sky, the editor…
      p.frameEnd(null);
    }
    expect(p.avg.physics).toBeCloseTo(2, 5);
    expect(p.avg.scripts).toBeCloseTo(3.5, 5);
    expect(p.avg.other).toBeCloseTo(1.5, 5);
    expect(p.avgTotal).toBeCloseTo(8, 5);
    expect(p.fps).toBeCloseTo(125, 0);
    expect(p.slowest(2).map((i) => i.name)).toEqual(['Guard', 'Enemy AI']);
    expect(p.slowestObjects()[0].name).toBe('Guard');
    expect(p.history).toHaveLength(40);
    expect(Object.keys(p.history[0].parts)).toEqual(PARTS);
  });

  it('frozen, it keeps what it showed', () => {
    let t = 0;
    const p = new Profiler({ clock: () => t });
    p.frameStart(null); t += 5; p.frameEnd(null);
    p.frozen = true;
    p.frameStart(null); t += 50; p.frameEnd(null);
    expect(p.history).toHaveLength(1);
    expect(p.avgTotal).toBeCloseTo(5);
  });
});
