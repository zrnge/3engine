import { describeEvent, ruleKey } from './logic-graph.js';

/**
 * The Debugger — the game, watched while it plays (the editor's Tools drawer).
 *
 *   Trace        each rule that runs (its WHEN, whether its IFs held, who set
 *                it off), each event sent, each script's log() and each
 *                mistake — newest first, as many as the last few hundred
 *   Breakpoints  a rule marked to stop at: when it runs, the game pauses at
 *                the end of that frame, and says where it stopped and why
 *   Pause / Step pause, and go on a frame at a time (1/60 s each)
 *   Watch        the variables (changed in place while paused or not) and one
 *                object's live state: where it is, its speed, its health,
 *                its state, what it sees, its clip, its components
 *
 * A breakpoint is kept by the rule's key (its object's place in the level and
 * its place among that object's rules), so it stays set across Play and Stop.
 * Nothing here runs unless the Debugger is attached: the engine's hooks are
 * empty otherwise.
 */

const MAX_TRACE = 400;
const nameOf = (e) => e?.object3D?.name || (e ? 'unnamed' : '');

export class Debugger {
  constructor(engine) {
    this.engine = engine;
    this.trace = []; // newest last: { n, frame, time, kind: rule|event|log|error, who, text, key?, pass? }
    this.breakpoints = new Set(); // rule keys
    this.breakOnErrors = false;
    this.stoppedAt = null; // { kind: breakpoint|error|pause|step, text, key?, time }
    this.runs = new Map(); // rule key -> { count, last (engine time), pass, failed }
    this.sent = []; // recent events: { name, from, to: [names], time }
    this.onChange = null; // the drawer redraws
    this.onStop = null; // paused at a breakpoint / an error
    this._n = 0;
    this._pending = null;
    this._attached = false;
  }

  attach() {
    if (this._attached) return;
    this._attached = true;
    const e = this.engine;
    e.onRuleRun = (rec, pass, other) => this._ruleRan(rec, pass, other);
    e.onRuleFail = (rec, err) => this._ruleFailed(rec, err);
    e.onEventSent = (name, sender, targets) => this._eventSent(name, sender, targets);
    e.onFrameDone = (stepping) => this._frameDone(stepping);
    e.onScriptLog = (entity, args) => this.log(nameOf(entity), args.map(show).join(' '));
  }

  detach() {
    if (!this._attached) return;
    this._attached = false;
    const e = this.engine;
    for (const k of ['onRuleRun', 'onRuleFail', 'onEventSent', 'onFrameDone', 'onScriptLog']) e[k] = null;
  }

  /** Play started again: a fresh trace (the breakpoints stay). */
  restart() {
    this.trace = [];
    this.runs.clear();
    this.sent = [];
    this.stoppedAt = null;
    this._pending = null;
    this._changed();
  }

  get paused() { return !!this.engine.paused; }

  pause(why = 'pause', text = 'Paused') {
    this.engine.paused = true;
    this.stoppedAt = { kind: why, text, time: this.engine.time ?? 0, frame: this._frame() };
    this._changed();
  }

  resume() {
    this.engine.paused = false;
    this.stoppedAt = null;
    this._changed();
  }

  /** On by `frames` frames (1/60 s each), then paused again. */
  step(frames = 1) {
    if (!this.engine.paused) this.pause();
    this.engine.stepFrames = (this.engine.stepFrames ?? 0) + Math.max(1, frames | 0);
    this.stoppedAt = { kind: 'step', text: `Stepped ${frames} frame${frames === 1 ? '' : 's'}`, time: this.engine.time ?? 0 };
  }

  toggleBreakpoint(key, on = !this.breakpoints.has(key)) {
    if (on) this.breakpoints.add(key);
    else this.breakpoints.delete(key);
    this._changed();
    return on;
  }

  log(who, text, kind = 'log') {
    this._push({ kind, who, text: String(text) });
  }

  /** The trace, newest first — those matching `filter` (any part of who, what). */
  filtered(filter = '') {
    const f = String(filter).trim().toLowerCase();
    const list = f ? this.trace.filter((t) => `${t.who} ${t.text}`.toLowerCase().includes(f)) : this.trace;
    return list.slice().reverse();
  }

  // ---- what the engine tells it

  /** A rule's place among its object's rules (looked up once: a level with hundreds of rules each frame). */
  _indexOf(rec) {
    let i = this._index?.get(rec);
    if (i === undefined) {
      this._index = new WeakMap();
      const counts = new Map();
      for (const r of this.engine.gameplay.rules.rules) {
        const n = counts.get(r.entity) ?? 0;
        this._index.set(r, n);
        counts.set(r.entity, n + 1);
      }
      i = this._index.get(rec) ?? 0;
    }
    return i;
  }

  _ruleRan(rec, pass, other) {
    const index = this._indexOf(rec);
    const key = ruleKey(rec.entity, index);
    const run = this.runs.get(key) ?? { count: 0 };
    run.count++;
    run.last = this.engine.time ?? 0;
    run.pass = pass;
    this.runs.set(key, run);
    const by = other ? ` (by ${nameOf(other)})` : '';
    const text = `${describeEvent(rec.rule.when)}${by} → ${pass ? 'DO' : (rec.rule.else?.length ? 'ELSE' : 'conditions not met')}`;
    this._push({ kind: 'rule', who: nameOf(rec.entity), text, key, pass });
    if (this.breakpoints.has(key) && !this._pending) {
      this._pending = { kind: 'breakpoint', key, text: `Breakpoint: ${nameOf(rec.entity)} · rule ${index + 1} — ${text}` };
    }
  }

  _ruleFailed(rec, err) {
    const index = this._indexOf(rec);
    const key = ruleKey(rec.entity, index);
    const run = this.runs.get(key) ?? { count: 0 };
    run.failed = String(err?.message || err);
    this.runs.set(key, run);
    this._push({ kind: 'error', who: nameOf(rec.entity), text: `rule ${index + 1} failed: ${run.failed}`, key });
    if (this.breakOnErrors && !this._pending) this._pending = { kind: 'error', key, text: `Error in ${nameOf(rec.entity)} · rule ${index + 1}: ${run.failed}` };
  }

  /** A script stopped (the editor's onBehaviorError tells it). */
  scriptFailed(entity, message) {
    this._push({ kind: 'error', who: nameOf(entity), text: `script stopped: ${message}` });
    if (this.breakOnErrors && !this._pending) this._pending = { kind: 'error', text: `Script on ${nameOf(entity)} stopped: ${message}` };
  }

  _eventSent(name, sender, targets) {
    const listening = (targets || []).filter((t) => this.engine.gameplay.rules.rules
      .some((r) => r.entity === t && r.rule.when?.type === 'event' && String(r.rule.when.name ?? '').toLowerCase() === String(name).toLowerCase()));
    const to = listening.map(nameOf);
    this.sent.push({ name, from: nameOf(sender), to, time: this.engine.time ?? 0 });
    if (this.sent.length > 60) this.sent.shift();
    this._push({ kind: 'event', who: nameOf(sender) || '(the game)', text: `sent “${name}” → ${to.length ? to.join(', ') : 'nobody listening'}` });
  }

  _frameDone() {
    if (this._pending) {
      const stop = this._pending;
      this._pending = null;
      this.engine.paused = true;
      this.engine.stepFrames = 0;
      this.stoppedAt = { ...stop, time: this.engine.time ?? 0, frame: this._frame() };
      this.onStop?.(this.stoppedAt);
    }
    this._changed();
  }

  _frame() { return this.engine.profiler?.frame ?? null; }

  _push(entry) {
    entry.n = ++this._n;
    entry.time = this.engine.time ?? 0;
    this.trace.push(entry);
    if (this.trace.length > MAX_TRACE) this.trace.splice(0, this.trace.length - MAX_TRACE);
  }

  _changed() { this.onChange?.(); }
}

/** A value as a line of text (a script's log, a watched value). */
export function show(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === 'string') return v;
  if (v.isVector3) return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
  if (v.isObject3D) return v.name || v.type;
  if (v.object3D) return v.object3D.name || 'object';
  try { return JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isInteger(x) ? +x.toFixed(3) : x)); } catch { return String(v); }
}

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * One object's state right now, for the Watch: [[label, value]…] — where it
 * is, how fast, its body, health, state, senses, clip, and each component's
 * own state (its timers, its counts).
 */
export function watchEntity(engine, entity) {
  if (!entity?.object3D) return [];
  const o = entity.object3D;
  const rows = [];
  const p = o.position;
  rows.push(['position', `${r2(p.x)}, ${r2(p.y)}, ${r2(p.z)}`]);
  rows.push(['turned (°)', `${r2(o.rotation.x * 57.2958)}, ${r2(o.rotation.y * 57.2958)}, ${r2(o.rotation.z * 57.2958)}`]);
  rows.push(['shown', o.visible !== false ? 'yes' : 'no']);
  if (entity.alive === false) rows.push(['alive', 'no (destroyed)']);
  const b = entity.rigidBody;
  if (b) {
    rows.push(['body', `${b.type}${b.tumbles ? ', tumbles' : ''}${b.isTrigger ? ', trigger' : ''}`]);
    if (b.type === 'dynamic') {
      rows.push(['speed (m/s)', `${r2(b.velocity.length())} (${r2(b.velocity.x)}, ${r2(b.velocity.y)}, ${r2(b.velocity.z)})`]);
      rows.push(['on the ground', b.grounded ? 'yes' : 'no']);
    }
  }
  if (entity.state) rows.push(['state', entity.state]);
  if (entity.crouched) rows.push(['crouched', 'yes']);
  if (entity.ragdoll) rows.push(['ragdoll', 'limp']);
  const s = entity.senses;
  if (s) {
    if (s.sees) rows.push(['sees', nameOf(s.sees)]);
    if (s.heard) rows.push(['heard', `${s.heard.kind ?? 'a noise'} at ${show(s.heard.at)}`]);
  }
  const player = engine.mixers?.find((m) => m.root === o);
  if (player?.playing) rows.push(['clip', player.playing]);
  for (const c of engine.gameplay?.components?.instances ?? []) {
    if (c.entity !== entity) continue;
    const label = c.def?.label || c.type;
    if (c.failed) { rows.push([label, 'failed (stopped)']); continue; }
    const st = Object.entries(c.state ?? {}).filter(([, v]) => v === null || ['number', 'string', 'boolean'].includes(typeof v));
    rows.push([label, st.length ? st.map(([k, v]) => `${k}: ${show(v)}`).join(' · ') : '—']);
  }
  const rules = engine.gameplay?.rules?.rules?.filter((r) => r.entity === entity) ?? [];
  if (rules.length) rows.push(['rules', `${rules.length}${rules.some((r) => r.failed) ? ' (one failed)' : ''}`]);
  return rows;
}
