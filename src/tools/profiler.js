/**
 * The Profiler — how long each part of a frame takes (the editor's Tools
 * drawer). While it is on, the engine marks its parts each frame
 * (engine.profiler, see Engine._tick): physics, controls, components, rules,
 * scripts, animation, drawing. What's left is "other" (the sky, levels of
 * detail, the editor itself).
 *
 * It keeps the last few seconds frame by frame (a chart), each part's average
 * and worst, and within the parts the slowest things: each script (by its
 * object), each kind of component (Enemy AI, Animator…), each object's
 * components together. With the drawing's own numbers — draw calls,
 * triangles, textures — and how many of everything there are.
 *
 * Drawing is timed on the CPU: what the GPU then takes is not in it (a frame
 * whose parts add up to much less than its time apart is waiting on the GPU,
 * or on the screen's refresh).
 */

export const PARTS = ['physics', 'controls', 'components', 'rules', 'scripts', 'animation', 'render', 'other'];
export const PART_LABELS = {
  physics: 'Physics', controls: 'Controls', components: 'Components', rules: 'Rules',
  scripts: 'Scripts', animation: 'Animation', render: 'Drawing (CPU)', other: 'Other',
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const EMA = 0.06; // how quickly a recent average follows (about the last 30 frames)

export class Profiler {
  constructor({ frames = 300, clock = now } = {}) {
    this.size = frames;
    this.clock = clock;
    this.history = []; // { total, gap, parts: { physics: ms, … } }, oldest first
    this.avg = Object.fromEntries(PARTS.map((p) => [p, 0]));
    this.worst = Object.fromEntries(PARTS.map((p) => [p, 0]));
    this.avgTotal = 0;
    this.avgGap = 0;
    this.items = new Map(); // `${part}|${name}` -> { part, name, avg, worst, calls, frames }
    this.objects = new Map(); // components per object: name -> { avg, worst }
    this.spike = null; // the slowest frame lately, part by part
    this.drawing = null; // renderer.info, as last drawn
    this.counts = null;
    this.frozen = false;
    this._t0 = 0;
    this._last = 0;
    this._open = {};
    this._parts = null;
    this._items = new Map();
    this._objects = new Map();
    this.frame = 0;
  }

  /** Start again from nothing. */
  reset() {
    const fresh = new Profiler({ frames: this.size, clock: this.clock });
    Object.assign(this, fresh);
  }

  frameStart(engine) {
    this._t0 = this.clock();
    this._parts = Object.fromEntries(PARTS.map((p) => [p, 0]));
    this._open = {};
    this._items.clear();
    this._objects.clear();
    const info = engine?.renderer?.info;
    if (info) { info.autoReset = false; info.reset(); } // every pass of a frame counted (bloom, AO… draw again)
  }

  begin(part) { this._open[part] = this.clock(); }

  end(part) {
    const t = this._open[part];
    if (t === undefined || !this._parts) return;
    this._parts[part] = (this._parts[part] ?? 0) + (this.clock() - t);
    delete this._open[part];
  }

  /** One thing's time inside a part: a script, a component (and whose). */
  item(part, name, ms, who = null) {
    const key = `${part}|${name}`;
    const it = this._items.get(key) ?? { part, name, ms: 0, calls: 0 };
    it.ms += ms;
    it.calls++;
    this._items.set(key, it);
    if (who) this._objects.set(who, (this._objects.get(who) ?? 0) + ms);
  }

  frameEnd(engine) {
    if (!this._parts) return;
    const t = this.clock();
    const total = t - this._t0;
    const gap = this._last ? t - this._last : 0; // from the last frame's end: the real frame time
    this._last = t;
    const parts = this._parts;
    const known = PARTS.reduce((s, p) => (p === 'other' ? s : s + parts[p]), 0);
    parts.other = Math.max(0, total - known);
    this._parts = null;
    this.frame++;
    if (this.frozen) return;
    this.history.push({ total, gap, parts });
    if (this.history.length > this.size) this.history.shift();
    const k = this.history.length < 30 ? 1 / this.history.length : EMA;
    for (const p of PARTS) {
      this.avg[p] += (parts[p] - this.avg[p]) * k;
      this.worst[p] = Math.max(this.worst[p] * 0.995, parts[p]); // the worst lately (it fades)
    }
    this.avgTotal += (total - this.avgTotal) * k;
    if (gap > 0) this.avgGap += (gap - this.avgGap) * (this.avgGap ? EMA : 1);
    if (!this.spike || total > this.spike.total || this.frame - this.spike.frame > this.size) {
      this.spike = { total, frame: this.frame, parts: { ...parts } };
    }
    // each thing's average per frame — counting frames it didn't run in as nothing
    for (const it of this.items.values()) { it.avg *= 1 - EMA; it.seen = false; }
    for (const [key, it] of this._items) {
      const had = this.items.get(key) ?? { part: it.part, name: it.name, avg: 0, worst: 0, calls: 0 };
      had.avg += it.ms * (had.avg === 0 && !had.calls ? 1 : EMA);
      had.worst = Math.max(had.worst * 0.995, it.ms);
      had.calls = it.calls;
      had.seen = true;
      this.items.set(key, had);
    }
    for (const [key, it] of this.items) if (!it.seen && it.avg < 1e-4) this.items.delete(key);
    for (const o of this.objects.values()) o.avg *= 1 - EMA;
    for (const [who, ms] of this._objects) {
      const o = this.objects.get(who) ?? { avg: 0, worst: 0 };
      o.avg += ms * EMA;
      o.worst = Math.max(o.worst * 0.995, ms);
      this.objects.set(who, o);
    }
    for (const [who, o] of this.objects) if (o.avg < 1e-4 && !this._objects.has(who)) this.objects.delete(who);
    const info = engine?.renderer?.info;
    if (info) {
      this.drawing = {
        calls: info.render.calls, triangles: info.render.triangles, lines: info.render.lines, points: info.render.points,
        geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0,
      };
    }
    if (engine) this.counts = countsOf(engine);
  }

  /** The slowest things lately: [{ part, name, avg, worst, calls }], slowest first. */
  slowest(n = 12) {
    return [...this.items.values()].sort((a, b) => b.avg - a.avg).slice(0, n);
  }

  /** The objects whose components take longest: [{ name, avg, worst }]. */
  slowestObjects(n = 8) {
    return [...this.objects.entries()].map(([name, o]) => ({ name, ...o })).sort((a, b) => b.avg - a.avg).slice(0, n);
  }

  /** Frames per second lately (from the time between frames). */
  get fps() { return this.avgGap > 0 ? 1000 / this.avgGap : 0; }
}

/** How many of everything the engine has right now. */
export function countsOf(engine) {
  const physics = engine.physics;
  return {
    objects: engine.entities?.length ?? 0,
    bodies: physics?.bodies?.length ?? 0,
    moving: physics?.bodies?.filter((b) => b.body.type === 'dynamic').length ?? 0,
    joints: physics?.joints?.length ?? 0,
    rules: engine.gameplay?.rules?.rules?.length ?? 0,
    components: engine.gameplay?.components?.instances?.length ?? 0,
    scripts: engine.behaviors?.length ?? 0,
    animated: engine.mixers?.length ?? 0,
    heapMB: typeof performance !== 'undefined' && performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  };
}
