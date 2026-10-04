import { escapeHtml, showNotice } from '../ui.js';
import { buildLogicGraph, portIn, portOut, linkRules, unlink, freshEventName } from '../tools/logic-graph.js';
import { Debugger, watchEntity, show } from '../tools/debugger.js';
import { Profiler, PARTS, PART_LABELS } from '../tools/profiler.js';
import { checkModule, moduleKey } from '../script-modules.js';

/**
 * The Tools drawer (🧰 Tools): along the bottom of the view, over the game,
 * and usable while it plays.
 *
 *   Logic graph  the level's rules as a graph — what sets off what (tools/logic-graph.js)
 *   Debugger     pause, step, a trace of what runs, breakpoints, a watch (tools/debugger.js)
 *   Profiler     each part of a frame's time, the slowest scripts and components (tools/profiler.js)
 *   Modules      the game's script modules, shared by its scripts (script-modules.js)
 *
 * Editor only: none of it goes into an exported game.
 */

const TABS = [['graph', 'Logic graph'], ['debug', 'Debugger'], ['profile', 'Profiler'], ['modules', 'Modules']];
const COLORS = {
  physics: '#58a6ff', controls: '#d2a8ff', components: '#3fb950', rules: '#f0883e',
  scripts: '#f778ba', animation: '#e3b341', render: '#8b949e', other: '#30363d',
};
const STORE = 'tiny3.tools';
const load = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } };
const save = (v) => { try { localStorage.setItem(STORE, JSON.stringify({ ...load(), ...v })); } catch { /* private window */ } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const ms = (v) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));

export function wireToolsDrawer(app) {
  const { engine, editor, history } = app;
  const rules = engine.gameplay.rules;
  const dbg = new Debugger(engine);
  const profiler = new Profiler();
  dbg.attach(); // cheap: a few lines per rule that runs — and breakpoints work with the drawer shut
  engine.debugger = dbg;

  const drawer = document.createElement('div');
  drawer.id = 'tools';
  drawer.className = 'panel';
  drawer.hidden = true;
  drawer.innerHTML = `
    <div class="tl-grip" title="Drag to make it taller or shorter"></div>
    <div class="tl-tabs">
      ${TABS.map(([id, label]) => `<button class="tl-tab" data-tab="${id}">${label}</button>`).join('')}
      <span class="tl-note"></span>
      <button class="tl-close" title="Close (the tools keep what they had)">×</button>
    </div>
    <div class="tl-body">
      <section class="tl-pane" data-pane="graph">
        <div class="tl-bar">
          <button class="tbtn" data-g="fit" title="Everything in view">Fit</button>
          <button class="tbtn" data-g="out" title="Zoom out">−</button>
          <button class="tbtn" data-g="in" title="Zoom in">+</button>
          <button class="tbtn" data-g="arrange" title="Lay it out again: forget where nodes were dragged">Arrange</button>
          <label class="tl-check"><input type="checkbox" data-g="only"> Only the selected object</label>
          <button class="tbtn" data-g="add" title="A new rule on the selected object">+ Rule</button>
          <span class="tl-hint">Click a rule to edit it in the Inspector · drag its ⊕ onto another rule to send it an event · ● stops there while playing</span>
        </div>
        <div class="lg-view"><div class="lg-world"><svg class="lg-edges"><defs>
          <marker id="lg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker>
        </defs><g class="lg-paths"></g></svg><div class="lg-nodes"></div></div>
        <div class="lg-pop" hidden></div><div class="lg-empty" hidden>No rules in this level yet — add one in the Inspector, or select an object and press + Rule.</div></div>
      </section>
      <section class="tl-pane" data-pane="debug">
        <div class="tl-bar">
          <button class="tbtn" data-d="pause">⏸ Pause</button>
          <button class="tbtn" data-d="step" title="On by one frame (1/60 s), then paused">⏭ 1 frame</button>
          <button class="tbtn" data-d="step10" title="On by ten frames">⏭ 10</button>
          <label class="tl-check"><input type="checkbox" data-d="errors"> Pause on errors</label>
          <button class="tbtn" data-d="clear">Clear trace</button>
          <input class="tl-input" data-d="filter" placeholder="Filter the trace…">
          <span class="db-status"></span>
        </div>
        <div class="tl-cols">
          <div class="db-trace"></div>
          <div class="db-side">
            <h5>Breakpoints</h5><div class="db-bps"></div>
            <h5>Variables</h5><div class="db-vars"></div>
            <h5>Watch <select class="tl-select" data-d="watch"></select></h5><div class="db-watch"></div>
          </div>
        </div>
      </section>
      <section class="tl-pane" data-pane="profile">
        <div class="tl-bar">
          <button class="tbtn" data-p="freeze">Freeze</button>
          <button class="tbtn" data-p="reset">Reset</button>
          <span class="pf-fps"></span>
          <span class="tl-hint">Drawing is CPU time: a frame much longer than its parts is waiting on the GPU or the screen.</span>
        </div>
        <div class="tl-cols">
          <div class="pf-left"><canvas class="pf-chart"></canvas><div class="pf-legend"></div></div>
          <div class="pf-right"><h5>Slowest lately</h5><table class="pf-slow"></table><h5>Drawing · counts</h5><div class="pf-draw"></div></div>
        </div>
      </section>
      <section class="tl-pane" data-pane="modules">
        <div class="tl-cols md-cols">
          <div class="md-list"><div class="md-items"></div><button class="tbtn" data-m="new">+ Module</button>
            <div class="tl-hint md-help">Code your scripts share. In a module: <code>export function wobble(t) {…}</code>.
              In a Behavior script, at its top: <code>import { wobble } from 'maths'</code> — or <code>use('maths')</code> anywhere.</div></div>
          <div class="md-edit">
            <div class="tl-bar"><input class="tl-input md-name" placeholder="name" title="Its name: what scripts import it by">
              <button class="tbtn" data-m="check" title="Read it for mistakes and list what it exports (without running it)">Check</button>
              <button class="tbtn danger" data-m="delete">Delete</button><span class="md-used tl-hint"></span></div>
            <textarea class="md-code" spellcheck="false" placeholder="export function wobble(t, amount = 0.2) {&#10;  return Math.sin(t * Math.PI * 2) * amount;&#10;}"></textarea>
            <div class="md-msg"></div>
          </div>
        </div>
      </section>
    </div>`;
  document.body.appendChild(drawer);
  const $ = (s) => drawer.querySelector(s);
  const $$ = (s) => [...drawer.querySelectorAll(s)];

  // ---- the drawer: where it is, how tall, which tab

  const saved = load();
  let tab = TABS.some(([id]) => id === saved.tab) ? saved.tab : 'graph';
  let height = Math.max(160, Number(saved.height) || 320);
  const toolsBtn = document.getElementById('btn-tools');

  function place() {
    const left = document.getElementById('dock-left')?.getBoundingClientRect();
    const right = document.getElementById('dock-right')?.getBoundingClientRect();
    const status = document.getElementById('status')?.getBoundingClientRect();
    const l = left && left.width ? left.right + 8 : 10;
    const r = right && right.width ? window.innerWidth - right.left + 8 : 10;
    const bottom = status ? window.innerHeight - status.top + 8 : 10;
    const top = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top')) || 64;
    const h = Math.min(height, window.innerHeight - bottom - top);
    Object.assign(drawer.style, { left: `${l}px`, right: `${r}px`, bottom: `${bottom}px`, height: `${Math.max(120, h)}px` });
  }

  function open(which = tab) {
    drawer.hidden = false;
    toolsBtn?.classList.add('active');
    place(); // sized first: the graph is laid out for the room it has
    showTab(which);
  }
  function close() {
    drawer.hidden = true;
    toolsBtn?.classList.remove('active');
    engine.profiler = null;
  }
  function showTab(which) {
    tab = which;
    save({ tab });
    for (const b of $$('.tl-tab')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const p of $$('.tl-pane')) p.hidden = p.dataset.pane !== tab;
    engine.profiler = tab === 'profile' && !drawer.hidden ? profiler : null; // timed only while looked at
    if (tab === 'graph') renderGraph();
    if (tab === 'debug') renderDebug(true);
    if (tab === 'profile') renderProfile();
    if (tab === 'modules') renderModules();
  }
  toolsBtn?.addEventListener('click', () => (drawer.hidden ? open() : close()));
  $('.tl-close').addEventListener('click', close);
  for (const b of $$('.tl-tab')) b.addEventListener('click', () => showTab(b.dataset.tab));
  window.addEventListener('resize', () => { if (!drawer.hidden) place(); });
  if (typeof ResizeObserver !== 'undefined') {
    const watch = new ResizeObserver(() => { if (!drawer.hidden) place(); });
    for (const id of ['dock-left', 'dock-right', 'status']) { const el = document.getElementById(id); if (el) watch.observe(el); }
  }
  // taller or shorter, from its top edge
  $('.tl-grip').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = drawer.getBoundingClientRect().height;
    const move = (ev) => { height = Math.max(140, h0 + (y0 - ev.clientY)); place(); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); save({ height }); if (tab === 'graph') drawEdges(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  // keys typed in the drawer are the drawer's, not the game's or the editor's shortcuts
  drawer.addEventListener('keydown', (e) => { if (e.target.matches('input, textarea, select')) e.stopPropagation(); });

  /** Rule lists changed by the graph: applied together, and undoable together. */
  function applyRules(changes, label) {
    if (!changes.length) return;
    const before = changes.map(({ entity }) => clone(rules.listFor(entity)));
    const after = changes.map(({ next }) => clone(next));
    const set = (lists) => {
      changes.forEach(({ entity }, i) => rules.setFor(entity, clone(lists[i])));
      editor._renderInspector();
      app.markDirty?.();
      graphStale = true;
      if (!drawer.hidden && tab === 'graph') renderGraph();
    };
    history.push({ label, undo: () => set(before), redo: () => set(after) });
    app.refreshHistoryButtons?.();
    set(after);
  }

  // ======================================================== Logic graph

  const view = $('.lg-view');
  const worldEl = $('.lg-world');
  const nodesEl = $('.lg-nodes');
  const pathsEl = $('.lg-paths');
  const svg = $('.lg-edges');
  const pop = $('.lg-pop');
  let graph = null;
  let graphStale = true;
  let cam = { x: 20, y: 20, z: 1 };
  let fitted = false;
  let selectedEdge = null;
  let only = false;

  // the Inspector drawn again: a rule may have changed
  const renderInspector = editor._renderInspector.bind(editor);
  editor._renderInspector = (...a) => {
    const out = renderInspector(...a);
    graphStale = true;
    if (!drawer.hidden && tab === 'graph' && !dragging) queueMicrotask(() => { if (graphStale) renderGraph(); });
    return out;
  };

  const editing = () => !app.isPlaying?.();

  function renderGraph() {
    graphStale = false;
    pop.hidden = true;
    // each object's place in the level — what a rule's breakpoint is kept by — as Play's snapshot will
    // give it (a save gives it: before the first one an object only had its name, and a breakpoint set
    // then was looked for under another key in play)
    if (editing()) { try { app.serializer?.serialize(); } catch { /* an object that can't be saved: by name, then */ } }
    const sel = editor.selected;
    // columns as tall as the view shows at about full size: the drawer is wide and short
    graph = buildLogicGraph(engine, { only: only && sel ? [sel] : null, layout: engine.logicLayout, columnHeight: Math.max(220, ((view.clientHeight || 300) - 40) / 0.9) });
    $('.lg-empty').hidden = graph.nodes.length > 0;
    nodesEl.innerHTML = graph.nodes.map((n) => {
      const bp = n.kind === 'rule' ? `<span class="lg-bp${dbg.breakpoints.has(n.key) ? ' on' : ''}" data-bp="${escapeHtml(n.key)}" title="Breakpoint: pause the game when this rule runs">●</span>` : '';
      const link = n.kind === 'rule' && editing() ? '<span class="lg-link" title="Drag onto another rule (or a rule of another object): this rule sends it an event">⊕</span>' : '';
      const lines = n.lines.map((l) => `<div class="lg-line lg-${l.kind}">${escapeHtml(l.text)}${l.port ? '<i class="lg-port"></i>' : ''}</div>`).join('');
      return `<div class="lg-node lg-k-${n.kind}" data-id="${escapeHtml(n.id)}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px">
        <div class="lg-head">${bp}<span class="lg-title">${escapeHtml(n.title)}</span><span class="lg-count"></span>${link}</div>${lines}</div>`;
    }).join('');
    // the real heights, as drawn
    for (const el of nodesEl.children) {
      const n = graph.byId.get(el.dataset.id);
      if (n) n.h = el.offsetHeight || n.h;
    }
    drawEdges();
    if (!fitted && graph.nodes.length) { fit(); fitted = true; } else applyCam();
    liveGraph();
  }

  function drawEdges() {
    if (!graph) return;
    let maxX = 0;
    let maxY = 0;
    for (const n of graph.nodes) { maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h); }
    svg.setAttribute('width', maxX + 200);
    svg.setAttribute('height', maxY + 200);
    pathsEl.innerHTML = graph.edges.map((e) => {
      const a = graph.byId.get(e.from);
      const b = graph.byId.get(e.to);
      if (!a || !b) return '';
      const p = portOut(a, e.fromLine);
      const q = portIn(b);
      const dx = Math.max(40, Math.abs(q.x - p.x) * 0.45);
      const d = `M${p.x},${p.y} C${p.x + dx},${p.y} ${q.x - dx},${q.y} ${q.x - 2},${q.y}`;
      const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 - 4 };
      const label = e.label && ['event', 'state'].includes(e.kind) ? `<text x="${mid.x}" y="${mid.y}" class="lg-label">${escapeHtml(String(e.label))}</text>` : '';
      return `<g class="lg-edge lg-e-${e.kind}${e.dashed ? ' dashed' : ''}${selectedEdge === e.id ? ' sel' : ''}" data-edge="${escapeHtml(e.id)}">
        <path class="lg-hit" d="${d}"/><path class="lg-path" d="${d}" marker-end="url(#lg-arrow)"/>${label}</g>`;
    }).join('');
  }

  function applyCam() {
    worldEl.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  }

  function fit() {
    if (!graph?.nodes.length) return;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const n of graph.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
    const w = view.clientWidth || 800;
    const h = view.clientHeight || 300;
    const z = Math.min(1, Math.max(0.2, Math.min((w - 40) / (x1 - x0), (h - 40) / (y1 - y0))));
    cam = { z, x: 20 - x0 * z + Math.max(0, (w - 40 - (x1 - x0) * z) / 2), y: 20 - y0 * z };
    applyCam();
  }

  function zoomAt(f, cx = view.clientWidth / 2, cy = view.clientHeight / 2) {
    const z = Math.min(2.5, Math.max(0.15, cam.z * f));
    cam.x = cx - ((cx - cam.x) * z) / cam.z;
    cam.y = cy - ((cy - cam.y) * z) / cam.z;
    cam.z = z;
    applyCam();
  }

  const toWorld = (e) => {
    const r = view.getBoundingClientRect();
    return { x: (e.clientX - r.left - cam.x) / cam.z, y: (e.clientY - r.top - cam.y) / cam.z };
  };

  $('[data-g="fit"]').addEventListener('click', fit);
  $('[data-g="in"]').addEventListener('click', () => zoomAt(1.25));
  $('[data-g="out"]').addEventListener('click', () => zoomAt(0.8));
  $('[data-g="only"]').addEventListener('change', (e) => { only = e.target.checked; fitted = false; renderGraph(); });
  $('[data-g="arrange"]').addEventListener('click', () => {
    if (!editing()) return;
    for (const r of rules.rules) delete r.rule.at;
    engine.logicLayout = {};
    app.markDirty?.();
    fitted = false;
    renderGraph();
  });
  $('[data-g="add"]').addEventListener('click', () => {
    const sel = editor.selected;
    if (!editing()) return;
    if (!sel) { showNotice('Select an object first: the new rule goes on it.', { seconds: 4 }); return; }
    const next = clone(rules.listFor(sel));
    next.push({ when: { type: 'start' }, if: [], do: [] });
    applyRules([{ entity: sel, next }], 'add rule');
  });
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = view.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  let dragging = null;
  view.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const nodeEl = e.target.closest('.lg-node');
    const edgeEl = e.target.closest('.lg-edge');
    if (e.target.closest('.lg-pop')) return;
    pop.hidden = true;
    if (e.target.classList.contains('lg-bp')) {
      const on = dbg.toggleBreakpoint(e.target.dataset.bp);
      e.target.classList.toggle('on', on);
      renderDebug();
      return;
    }
    if (e.target.classList.contains('lg-link') && nodeEl) { startLink(e, graph.byId.get(nodeEl.dataset.id)); return; }
    if (edgeEl) { pickEdge(e, edgeEl.dataset.edge); return; }
    if (selectedEdge) { selectedEdge = null; drawEdges(); }
    const start = { x: e.clientX, y: e.clientY };
    if (nodeEl) {
      const n = graph.byId.get(nodeEl.dataset.id);
      const from = { x: n.x, y: n.y };
      dragging = { kind: 'node', moved: false };
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / cam.z;
        const dy = (ev.clientY - start.y) / cam.z;
        if (!dragging.moved && Math.hypot(dx, dy) * cam.z < 4) return;
        dragging.moved = true;
        n.x = Math.round(from.x + dx);
        n.y = Math.round(from.y + dy);
        nodeEl.style.left = `${n.x}px`;
        nodeEl.style.top = `${n.y}px`;
        drawEdges();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const moved = dragging.moved;
        dragging = null;
        if (moved) {
          // where it was put is kept: a rule's in the rule itself, the rest with the level
          if (editing()) {
            if (n.kind === 'rule') n.rule.at = [n.x, n.y];
            else (engine.logicLayout ??= {})[n.id] = [n.x, n.y];
            app.markDirty?.();
          }
        } else openNode(n);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    // the background: pan
    const c0 = { ...cam };
    dragging = { kind: 'pan' };
    const move = (ev) => { cam.x = c0.x + ev.clientX - start.x; cam.y = c0.y + ev.clientY - start.y; applyCam(); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); dragging = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  /** A rule clicked: its object selected, and that rule shown in the Inspector. */
  function openNode(n) {
    if (n.kind !== 'rule') return;
    if (app.isPlaying?.()) {
      // while playing the Inspector is locked: the Watch shows the object instead
      watchSel.value = String(engine.entities.indexOf(n.entity));
      showTab('debug');
      return;
    }
    editor.select(n.entity);
    const inspector = document.getElementById('inspector');
    inspector?.classList.remove('collapsed');
    const card = editor.inspectorEl.querySelectorAll('.gp-rule')[n.index];
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.add('gp-flash');
      setTimeout(() => card.classList.remove('gp-flash'), 1200);
    }
  }

  function pickEdge(e, id) {
    selectedEdge = id;
    drawEdges();
    const edge = graph.edges.find((x) => x.id === id);
    if (!edge) return;
    const a = graph.byId.get(edge.from);
    const b = graph.byId.get(edge.to);
    const removable = editing() && unlink(engine, edge).length > 0;
    const what = { event: `sends “${edge.label}”`, state: `sets the state “${edge.label}”`, write: 'changes it', read: edge.label === 'when' ? 'is watched by' : 'is read by',
      screen: 'opens it / its buttons', dialogue: 'its end', spawn: 'spawns it', level: 'goes to it' }[edge.kind] ?? '';
    pop.innerHTML = `<div><b>${escapeHtml(a?.title ?? '')}</b> ${escapeHtml(what)} → <b>${escapeHtml(b?.title ?? '')}</b></div>
      ${removable ? '<button class="tbtn danger" data-pop="unlink">Remove this link</button>' : edge.dashed ? '<div class="tl-hint">To “other”: whoever set the rule off.</div>' : ''}`;
    const r = view.getBoundingClientRect();
    pop.style.left = `${Math.min(e.clientX - r.left + 8, r.width - 260)}px`;
    pop.style.top = `${Math.max(4, e.clientY - r.top - 10)}px`;
    pop.hidden = false;
    pop.querySelector('[data-pop="unlink"]')?.addEventListener('click', () => {
      pop.hidden = true;
      selectedEdge = null;
      applyRules(unlink(engine, edge), 'remove link');
    });
  }

  /** Drag from a rule's ⊕: a line follows; dropped on a rule, it asks the event's name. */
  function startLink(e, from) {
    if (!editing() || !from) return;
    e.preventDefault();
    const ns = 'http://www.w3.org/2000/svg';
    const line = document.createElementNS(ns, 'path');
    line.setAttribute('class', 'lg-drawing');
    pathsEl.appendChild(line);
    const p = portOut(from, null);
    const move = (ev) => {
      const q = toWorld(ev);
      line.setAttribute('d', `M${p.x},${p.y} L${q.x},${q.y}`);
      for (const el of nodesEl.children) el.classList.toggle('lg-target', el.contains(ev.target) && el.dataset.id !== from.id);
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      line.remove();
      for (const el of nodesEl.children) el.classList.remove('lg-target');
      const targetEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.lg-node');
      const to = targetEl && graph.byId.get(targetEl.dataset.id);
      if (!to || to.kind !== 'rule') return;
      askEventName(ev, from, to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function askEventName(ev, from, to) {
    const name = to.rule.when?.type === 'event' && to.rule.when.name ? to.rule.when.name : freshEventName(engine);
    const r = view.getBoundingClientRect();
    pop.innerHTML = `<div><b>${escapeHtml(from.title)}</b> sends <b>${escapeHtml(to.entity.object3D.name || 'it')}</b> an event:</div>
      <div class="tl-bar"><input class="tl-input" data-pop="name" value="${escapeHtml(name)}">
      <button class="tbtn" data-pop="ok">Link</button><button class="tbtn" data-pop="cancel">Cancel</button></div>
      <div class="tl-hint">${to.rule.when?.type === 'event' ? 'It receives it in this rule.' : 'A rule receiving it is added to it.'}</div>`;
    pop.style.left = `${Math.min(ev.clientX - r.left + 8, r.width - 280)}px`;
    pop.style.top = `${Math.max(4, ev.clientY - r.top - 20)}px`;
    pop.hidden = false;
    const input = pop.querySelector('[data-pop="name"]');
    input.focus();
    input.select();
    const ok = () => {
      pop.hidden = true;
      try {
        // into the rule it was dropped on, if that one receives an event; otherwise a new one
        const changes = linkRules(engine, from.entity, from.index, to.entity, input.value);
        applyRules(changes, 'link rules');
      } catch (err) {
        showNotice(err.message, { kind: 'warn', seconds: 5 });
      }
    };
    pop.querySelector('[data-pop="ok"]').addEventListener('click', ok);
    pop.querySelector('[data-pop="cancel"]').addEventListener('click', () => { pop.hidden = true; });
    input.addEventListener('keydown', (k) => { if (k.key === 'Enter') ok(); if (k.key === 'Escape') pop.hidden = true; });
  }

  /** While playing: each rule lights up as it runs, with how many times; a failed one is red; where a breakpoint stopped. */
  function liveGraph() {
    if (!graph) return;
    const t = engine.time ?? 0;
    const stopKey = dbg.stoppedAt?.key;
    for (const el of nodesEl.children) {
      const n = graph.byId.get(el.dataset.id);
      if (n?.kind !== 'rule') continue;
      const run = dbg.runs.get(n.key);
      const playing = app.isPlaying?.();
      el.classList.toggle('lg-hot', !!(playing && run && t - run.last < 0.35));
      el.classList.toggle('lg-failed', !!(playing && (run?.failed || n.rec?.failed)));
      el.classList.toggle('lg-stopped', !!(playing && stopKey === n.key));
      const count = el.querySelector('.lg-count');
      if (count) count.textContent = playing && run ? `×${run.count}` : '';
    }
    // events just sent: their links pulse
    const recent = new Set(dbg.sent.filter((s) => t - s.time < 0.35).map((s) => String(s.name).toLowerCase()));
    for (const g of pathsEl.children) {
      const e = graph.edges.find((x) => x.id === g.dataset.edge);
      g.classList.toggle('lg-pulse', !!(e && e.kind === 'event' && recent.has(String(e.label).toLowerCase())));
    }
  }

  // ======================================================== Debugger

  const traceEl = $('.db-trace');
  const watchSel = $('[data-d="watch"]');
  let filter = '';
  let lastTraceN = -1;

  dbg.onStop = (stop) => {
    // to the Debugger: why it stopped, the trace, the step buttons (the graph marks the rule in red)
    if (drawer.hidden) open('debug');
    else if (tab !== 'debug') showTab('debug');
    renderDebug(true);
    showNotice(`⏸ ${stop.text}`, { kind: stop.kind === 'error' ? 'error' : 'info', seconds: 6 });
  };

  $('[data-d="pause"]').addEventListener('click', () => {
    if (!app.isPlaying?.()) return;
    if (engine.paused) dbg.resume(); else dbg.pause();
    renderDebug(true);
  });
  $('[data-d="step"]').addEventListener('click', () => { if (app.isPlaying?.()) { dbg.step(1); renderDebug(true); } });
  $('[data-d="step10"]').addEventListener('click', () => { if (app.isPlaying?.()) { dbg.step(10); renderDebug(true); } });
  $('[data-d="errors"]').addEventListener('change', (e) => { dbg.breakOnErrors = e.target.checked; });
  $('[data-d="clear"]').addEventListener('click', () => { dbg.trace = []; renderDebug(true); });
  $('[data-d="filter"]').addEventListener('input', (e) => { filter = e.target.value; renderDebug(true); });
  traceEl.addEventListener('click', (e) => {
    const row = e.target.closest('[data-key]');
    if (!row) return;
    // to that rule in the graph
    showTab('graph');
    const n = graph?.nodes.find((x) => x.key === row.dataset.key);
    if (n) {
      cam.x = view.clientWidth / 2 - (n.x + n.w / 2) * cam.z;
      cam.y = view.clientHeight / 2 - (n.y + 30) * cam.z;
      applyCam();
      const el = nodesEl.querySelector(`[data-id="${CSS.escape(n.id)}"]`);
      el?.classList.add('lg-flash');
      setTimeout(() => el?.classList.remove('lg-flash'), 1200);
    }
  });

  function renderDebug(full = false) {
    const playing = app.isPlaying?.();
    const pauseBtn = $('[data-d="pause"]');
    pauseBtn.textContent = engine.paused && playing ? '▶ Resume' : '⏸ Pause';
    for (const b of $$('[data-d="pause"], [data-d="step"], [data-d="step10"]')) b.disabled = !playing;
    const status = !playing ? 'Press ▶ Play to debug. Breakpoints can be set now.'
      : engine.paused ? `⏸ ${dbg.stoppedAt?.text ?? 'Paused'} · ${(engine.time ?? 0).toFixed(2)} s`
        : `▶ Running · ${(engine.time ?? 0).toFixed(2)} s`;
    $('.db-status').textContent = status;
    $('.db-status').classList.toggle('stopped', !!(playing && engine.paused && dbg.stoppedAt && dbg.stoppedAt.kind !== 'pause'));
    // the trace: only drawn again when there is something new (or the filter changed)
    const newest = dbg.trace.at(-1)?.n ?? 0;
    if (full || newest !== lastTraceN) {
      lastTraceN = newest;
      const rows = dbg.filtered(filter).slice(0, 200);
      traceEl.innerHTML = rows.length ? rows.map((t) => `<div class="db-row db-${t.kind}"${t.key ? ` data-key="${escapeHtml(t.key)}" title="Show this rule in the graph"` : ''}>
        <span class="db-t">${t.time.toFixed(2)}</span><b>${escapeHtml(t.who)}</b> ${escapeHtml(t.text)}</div>`).join('')
        : `<div class="empty">${playing ? 'Nothing has happened yet.' : 'What runs while playing shows here: each rule, each event sent, each script’s log() and each mistake.'}</div>`;
    }
    // breakpoints
    const bps = [...dbg.breakpoints];
    $('.db-bps').innerHTML = bps.length ? bps.map((k) => {
      const n = graph?.nodes.find((x) => x.key === k) ?? buildLogicGraph(engine).nodes.find((x) => x.key === k);
      return `<div class="db-bp"><span>● ${escapeHtml(n ? `${n.title}: ${n.lines[0].text}` : k)}</span><button class="gp-x" data-unbp="${escapeHtml(k)}" title="Remove">×</button></div>`;
    }).join('') : '<div class="tl-hint">None. Click a rule’s ● in the Logic graph.</div>';
    for (const b of $$('[data-unbp]')) b.addEventListener('click', () => { dbg.toggleBreakpoint(b.dataset.unbp, false); renderDebug(); if (graph) renderGraph(); });
    renderVars(full);
    renderWatch(full);
  }

  function renderVars(full) {
    const box = $('.db-vars');
    if (box.contains(document.activeElement)) return; // being typed in
    const vars = engine.variables;
    const names = Object.keys(vars.values ?? {}).filter((n) => !n.startsWith('__'));
    if (!names.length) { box.innerHTML = '<div class="tl-hint">No variables.</div>'; return; }
    if (full || box.childElementCount !== names.length) {
      box.innerHTML = names.map((n) => `<label class="db-var"><span>${escapeHtml(n)}</span><input class="tl-input" data-var="${escapeHtml(n)}"></label>`).join('');
      for (const input of box.querySelectorAll('[data-var]')) {
        input.addEventListener('change', () => {
          const raw = input.value.trim();
          let v = raw;
          if (raw === 'true' || raw === 'false') v = raw === 'true';
          else if (raw !== '' && Number.isFinite(Number(raw))) v = Number(raw);
          else if (/^[[{]/.test(raw)) { try { v = JSON.parse(raw); } catch { /* text, then */ } }
          vars.set(input.dataset.var, v);
          dbg.log('(you)', `set ${input.dataset.var} = ${show(v)}`);
        });
      }
    }
    for (const input of box.querySelectorAll('[data-var]')) input.value = show(vars.get(input.dataset.var));
  }

  function renderWatch(full) {
    const list = engine.entities.filter((e) => e.object3D && e.object3D.name);
    if (full || watchSel.options.length !== list.length + 1) {
      const keep = watchSel.value;
      watchSel.innerHTML = `<option value="">(an object)</option>${list.map((e) => `<option value="${engine.entities.indexOf(e)}">${escapeHtml(e.object3D.name)}</option>`).join('')}`;
      if ([...watchSel.options].some((o) => o.value === keep)) watchSel.value = keep;
      else if (editor.selected) watchSel.value = String(engine.entities.indexOf(editor.selected));
    }
    const e = engine.entities[Number(watchSel.value)];
    const rows = watchSel.value === '' || !e ? [] : watchEntity(engine, e);
    $('.db-watch').innerHTML = rows.length ? `<table class="db-table">${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`).join('')}</table>`
      : '<div class="tl-hint">Pick an object to watch it.</div>';
  }
  watchSel.addEventListener('change', () => renderWatch());

  // ======================================================== Profiler

  const chart = $('.pf-chart');
  $('[data-p="freeze"]').addEventListener('click', (e) => {
    profiler.frozen = !profiler.frozen;
    e.target.textContent = profiler.frozen ? 'Go on' : 'Freeze';
  });
  $('[data-p="reset"]').addEventListener('click', () => { const frozen = profiler.frozen; profiler.reset(); profiler.frozen = frozen; renderProfile(); });

  function renderProfile() {
    const fps = profiler.fps;
    $('.pf-fps').innerHTML = profiler.history.length
      ? `<b>${fps ? fps.toFixed(0) : '–'} fps</b> · a frame ${ms(profiler.avgGap || profiler.avgTotal)} ms, its parts ${ms(profiler.avgTotal)} ms${profiler.spike ? ` · slowest lately ${ms(profiler.spike.total)} ms` : ''}`
      : 'Measuring…';
    // the chart: each frame's parts, stacked; lines at 60 and 30 fps
    const w = chart.clientWidth || 400;
    const h = chart.clientHeight || 150;
    if (chart.width !== w) chart.width = w;
    if (chart.height !== h) chart.height = h;
    const g = chart.getContext('2d');
    if (g) {
      g.clearRect(0, 0, w, h);
      // scaled to the frames shown (a quick game's 2 ms frames would be slivers under a 60 fps scale)
      const top = Math.max(2, ...profiler.history.map((f) => f.total)) * 1.25;
      const y = (v) => h - (v / top) * h;
      const hist = profiler.history;
      const bw = w / profiler.size;
      hist.forEach((f, i) => {
        let acc = 0;
        const x = w - (hist.length - i) * bw;
        for (const p of PARTS) {
          const v = f.parts[p];
          if (!(v > 0)) continue;
          g.fillStyle = COLORS[p];
          g.fillRect(x, y(acc + v), Math.max(1, bw - 0.5), y(acc) - y(acc + v));
          acc += v;
        }
      });
      g.font = '10px system-ui, sans-serif';
      g.fillStyle = 'rgba(230,237,243,0.6)';
      g.fillText(`${ms(top)} ms`, 4, 11);
      for (const [v, label] of [[1000 / 60, '60 fps'], [1000 / 30, '30 fps']]) {
        if (v > top) continue;
        g.strokeStyle = 'rgba(230,237,243,0.35)';
        g.setLineDash([4, 4]);
        g.beginPath(); g.moveTo(0, y(v)); g.lineTo(w, y(v)); g.stroke();
        g.setLineDash([]);
        g.fillStyle = 'rgba(230,237,243,0.6)';
        g.fillText(label, 4, y(v) - 3);
      }
    }
    $('.pf-legend').innerHTML = PARTS.map((p) => `<span class="pf-key"><i style="background:${COLORS[p]}"></i>${PART_LABELS[p]} <b>${ms(profiler.avg[p])}</b><small> / ${ms(profiler.worst[p])}</small></span>`).join('');
    const slow = profiler.slowest(10);
    const objs = profiler.slowestObjects(5);
    $('.pf-slow').innerHTML = slow.length || objs.length
      ? `<tr><th></th><th>ms avg</th><th>worst</th></tr>${slow.map((it) => `<tr><td><i style="background:${COLORS[it.part]}"></i>${escapeHtml(it.name)}${it.calls > 1 ? ` <small>×${it.calls}</small>` : ''}</td><td>${ms(it.avg)}</td><td>${ms(it.worst)}</td></tr>`).join('')}
         ${objs.map((o) => `<tr><td><i style="background:${COLORS.components}"></i>${escapeHtml(o.name)} <small>(its components)</small></td><td>${ms(o.avg)}</td><td>${ms(o.worst)}</td></tr>`).join('')}`
      : '<tr><td class="tl-hint">Scripts and components show here while the game plays.</td></tr>';
    const d = profiler.drawing;
    const c = profiler.counts;
    $('.pf-draw').innerHTML = `${d ? `<div>${d.calls} draw calls · ${(d.triangles / 1000).toFixed(1)}k triangles · ${d.textures} textures · ${d.geometries} meshes · ${d.programs} shaders</div>` : ''}
      ${c ? `<div>${c.objects} objects · ${c.bodies} bodies (${c.moving} moving${c.joints ? `, ${c.joints} joints` : ''}) · ${c.rules} rules · ${c.components} components · ${c.scripts} scripts · ${c.animated} animated${c.heapMB !== null ? ` · ${c.heapMB} MB memory` : ''}</div>` : ''}`;
  }

  // ======================================================== Modules

  const modules = engine.modules;
  let current = null; // the module open
  const codeEl = $('.md-code');
  const nameEl = $('.md-name');
  const msgEl = $('.md-msg');

  /** Who imports a module: the scripts (by object) and the other modules. */
  function usersOf(name) {
    const key = moduleKey(name);
    const reads = (code) => [...String(code ?? '').matchAll(/(?:from\s+|use\(\s*)(['"])([^'"]+)\1/g)].some((m) => moduleKey(m[2]) === key);
    const scripts = editor.selectables.filter((e) => reads(e.behavior)).map((e) => e.object3D.name || 'unnamed');
    const mods = modules.list.filter((m) => moduleKey(m.name) !== key && reads(m.code)).map((m) => `module ${m.name}`);
    return [...scripts, ...mods];
  }

  function renderModules() {
    const list = modules.list;
    if (current && !modules.get(current)) current = null;
    if (!current && list.length) current = list[0].name;
    $('.md-items').innerHTML = list.length ? list.map((m) => `<div class="md-item${m.name === current ? ' active' : ''}" data-mod="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>`).join('')
      : '<div class="tl-hint">No modules yet.</div>';
    for (const el of $$('.md-item')) el.addEventListener('click', () => { commitCode(); current = el.dataset.mod; renderModules(); });
    const m = current ? modules.get(current) : null;
    $('.md-edit').classList.toggle('none', !m);
    nameEl.value = m?.name ?? '';
    if (document.activeElement !== codeEl) codeEl.value = m?.code ?? '';
    nameEl.disabled = codeEl.disabled = !m;
    const users = m ? usersOf(m.name) : [];
    $('.md-used').textContent = m ? (users.length ? `Imported by: ${users.join(', ')}` : 'Not imported yet') : '';
    msgEl.textContent = '';
    msgEl.className = 'md-msg';
  }

  /** A change to the modules, undoable. */
  function changeModules(label, mutate) {
    const before = modules.toJSON();
    mutate();
    const after = modules.toJSON();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const set = (list, name) => { modules.load(clone(list)); current = name; renderModules(); app.markDirty?.(); };
    const was = current;
    const now = current;
    history.push({ label, undo: () => set(before, was), redo: () => set(after, now) });
    app.refreshHistoryButtons?.();
    app.markDirty?.();
  }

  function commitCode() {
    const m = current && modules.get(current);
    if (!m || m.code === codeEl.value) return;
    changeModules('edit module', () => modules.set(m.name, codeEl.value));
  }

  $('[data-m="new"]').addEventListener('click', () => {
    commitCode();
    let name = 'module';
    for (let n = 2; modules.get(name); n++) name = `module${n}`;
    changeModules('add module', () => modules.set(name, '// Shared by your scripts. Export what they import:\nexport function wobble(time, amount = 0.2) {\n  return Math.sin(time * Math.PI * 2) * amount;\n}\n'));
    current = name;
    renderModules();
    nameEl.focus();
    nameEl.select();
  });
  $('[data-m="delete"]').addEventListener('click', () => {
    const m = current && modules.get(current);
    if (!m) return;
    const users = usersOf(m.name);
    changeModules('delete module', () => modules.remove(m.name));
    current = null;
    renderModules();
    if (users.length) showNotice(`“${m.name}” was imported by ${users.join(', ')}: they'll stop with an error until it's back (Undo).`, { kind: 'warn', seconds: 8 });
  });
  nameEl.addEventListener('change', () => {
    const m = current && modules.get(current);
    const to = nameEl.value.trim();
    if (!m || !to || to === m.name) { nameEl.value = m?.name ?? ''; return; }
    if (modules.get(to)) { showNotice(`There's already a module called “${to}”.`, { kind: 'warn', seconds: 4 }); nameEl.value = m.name; return; }
    changeModules('rename module', () => modules.rename(m.name, to));
    current = to;
    renderModules();
  });
  codeEl.addEventListener('change', commitCode);
  codeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { // two spaces, not the next field
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = codeEl;
      codeEl.value = `${value.slice(0, a)}  ${value.slice(b)}`;
      codeEl.selectionStart = codeEl.selectionEnd = a + 2;
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitCode(); check(); }
  });
  function check() {
    commitCode();
    const m = current && modules.get(current);
    if (!m) return;
    const { names, error } = checkModule(m.code);
    msgEl.className = `md-msg ${error ? 'bad' : 'good'}`;
    msgEl.textContent = error ? `⚠ ${error}` : names.length ? `✓ Reads fine. It exports: ${names.join(', ')}` : '✓ Reads fine — but it exports nothing yet (put export before a function or const).';
  }
  $('[data-m="check"]').addEventListener('click', check);
  // a module's mistake while playing: said once, by name and line
  modules.onError = (name, err) => {
    dbg.log(`module ${name}`, err.message, 'error');
    if (!drawer.hidden && tab === 'modules' && current === name) { msgEl.className = 'md-msg bad'; msgEl.textContent = `⚠ ${err.message}`; }
  };

  // ======================================================== keeping up

  // scripts that stop are in the trace too (play-mode's own notice stays)
  const behaviorError = engine.onBehaviorError;
  engine.onBehaviorError = (entity, err) => {
    behaviorError?.(entity, err);
    dbg.scriptFailed(entity, String(err?.message || err));
  };
  // Play and Stop (play-mode.js): a fresh trace; the graph's rules are the level's again after Stop
  app.beforePlay = () => {
    dbg.restart();
    profiler.reset();
    graphStale = true;
    if (!drawer.hidden) queueMicrotask(() => showTab(tab));
  };
  app.afterPlay = () => {
    dbg.stoppedAt = null;
    graphStale = true;
    if (!drawer.hidden) showTab(tab);
  };

  // a few times a second while open: the trace, the watch, the chart, the graph's lights
  let last = 0;
  const loop = (t) => {
    requestAnimationFrame(loop);
    if (drawer.hidden || t - last < (tab === 'profile' ? 100 : 150)) return;
    last = t;
    if (tab === 'graph') { if (graphStale && !dragging) renderGraph(); else liveGraph(); }
    else if (tab === 'debug') renderDebug();
    else if (tab === 'profile') renderProfile();
  };
  requestAnimationFrame(loop);

  if (saved.open) open();
  window.addEventListener('beforeunload', () => save({ open: !drawer.hidden }));

  const api = { open, close, showTab, debugger: dbg, profiler, renderGraph, get graph() { return graph; } };
  app.tools = api;
  return api;
}
