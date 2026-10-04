import * as THREE from 'three';
import { contactBetween, rayCollider, probeBox, measureLocal } from './physics.js';

/**
 * Navigation — a way round walls for whatever walks by itself (a Follower, a
 * Patrol). Followers used to head straight at their target, through walls and
 * off ledges.
 *
 * The level is laid out as a grid of cells over the ground (x, z), measured
 * from its still, solid bodies — boxes, meshes, anything: a cell is walkable
 * where there is ground under it (not too steep) and nothing solid at body
 * height. The grid spreads out from where the walker stands, a step at a
 * time, so it follows ramps and stairs up and drops down ledges — and only
 * where it can really get to. A* finds the cells between two places, and the
 * path is straightened to the fewest turns.
 *
 * Grids are kept and used again until something solid moves, appears or goes
 * (a door slid open, a wall knocked down): then they are measured again.
 */

const MAX_SIDE = 256;           // cells along a side at most: big levels get bigger cells
const DOWN = new THREE.Vector3(0, -1, 0);
const _p = new THREE.Vector3();
const _half = new THREE.Vector3();

/** Still, solid bodies: what stands in the way, and what can be stood on. */
const isSolid = ({ body }) => body.type !== 'dynamic' && !body.isTrigger;

/** A small binary heap of [cost, cell]. */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(cost, cell) {
    const a = this.a;
    a.push([cost, cell]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top[1];
  }
}

export class NavGrid {
  /**
   * @param {Array<{col}>} colliders still, solid bodies (see PhysicsWorld.colliders)
   * @param {THREE.Vector3} seed where the walker's feet are: the grid spreads from here
   * @param {{ radius, height, step, drop, cell }} agent its size, how high it can step up, how far down it may drop
   */
  constructor(colliders, seed, agent) {
    this.agent = agent;
    let [x0, x1, z0, z1] = [seed.x, seed.x, seed.z, seed.z];
    for (const { col } of colliders) {
      x0 = Math.min(x0, col.min.x); x1 = Math.max(x1, col.max.x);
      z0 = Math.min(z0, col.min.z); z1 = Math.max(z1, col.max.z);
    }
    x0 -= 2; z0 -= 2; x1 += 2; z1 += 2;
    this.cell = Math.max(agent.cell || 0.5, Math.max(x1 - x0, z1 - z0) / MAX_SIDE);
    this.x0 = x0;
    this.z0 = z0;
    this.w = Math.ceil((x1 - x0) / this.cell) + 1;
    this.h = Math.ceil((z1 - z0) / this.cell) + 1;
    this.ground = new Float32Array(this.w * this.h).fill(NaN); // NaN: can't be walked (or not reached)
    this._index(colliders);
    // no floor under the seed at all (nothing solid to stand on in the level): an open plane at its feet
    this.floor = this._groundAt(this.cellOf(seed), seed.y, 1e6) === null ? seed.y : null;
    this._spread(this.cellOf(seed), seed.y);
  }

  cellOf(p) {
    const i = Math.min(this.w - 1, Math.max(0, Math.round((p.x - this.x0) / this.cell)));
    const j = Math.min(this.h - 1, Math.max(0, Math.round((p.z - this.z0) / this.cell)));
    return j * this.w + i;
  }

  centerOf(c, out = new THREE.Vector3()) {
    return out.set(this.x0 + (c % this.w) * this.cell, this.ground[c], this.z0 + Math.floor(c / this.w) * this.cell);
  }

  walkable(c) { return c >= 0 && c < this.ground.length && !Number.isNaN(this.ground[c]); }

  /** Colliders by tiles of 8 × 8 cells, so each cell looks at the few near it. */
  _index(colliders) {
    this.tiles = new Map();
    const r = this.agent.radius;
    for (const item of colliders) {
      const { col } = item;
      const i0 = Math.floor((col.min.x - r - this.x0) / this.cell / 8);
      const i1 = Math.floor((col.max.x + r - this.x0) / this.cell / 8);
      const j0 = Math.floor((col.min.z - r - this.z0) / this.cell / 8);
      const j1 = Math.floor((col.max.z + r - this.z0) / this.cell / 8);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const key = j * 100000 + i;
          if (!this.tiles.has(key)) this.tiles.set(key, []);
          this.tiles.get(key).push(col);
        }
      }
    }
  }

  _near(c) {
    const i = Math.floor((c % this.w) / 8);
    const j = Math.floor(Math.floor(c / this.w) / 8);
    return this.tiles.get(j * 100000 + i) || [];
  }

  /** The top of the ground in cell `c`, between `ref + step` and `ref - below` — null if none (or too steep). */
  _groundAt(c, ref, below = this.agent.drop) {
    const top = ref + this.agent.step + 0.05;
    this.centerOf(c, _p).y = top;
    let best = null;
    for (const col of this._near(c)) {
      if (_p.x < col.min.x || _p.x > col.max.x || _p.z < col.min.z || _p.z > col.max.z) continue;
      const hit = rayCollider(_p, DOWN, col, this.agent.step + 0.05 + below);
      if (hit && hit.normal.y > 0.5 && (best === null || hit.point.y > best)) best = hit.point.y;
    }
    if (best === null && this.floor !== null && this.floor !== undefined && Math.abs(this.floor - ref) <= this.agent.step + 1e-3) {
      best = this.floor; // an open level: its virtual floor
    }
    return best;
  }

  /** Is there room to stand in cell `c`, on ground at `g`: nothing solid from knee to head? */
  _clear(c, g) {
    const { radius, height, step } = this.agent;
    const tall = Math.max(0.1, height - step);
    this.centerOf(c, _p).y = g + step + tall / 2 + 0.02;
    const probe = probeBox(_p, _half.set(radius, tall / 2, radius));
    for (const col of this._near(c)) {
      if (probe.min.x > col.max.x || probe.max.x < col.min.x || probe.min.y > col.max.y || probe.max.y < col.min.y
        || probe.min.z > col.max.z || probe.max.z < col.min.z) continue;
      if (contactBetween(probe, col)) return false;
    }
    return true;
  }

  /** Spread from the seed, cell by cell, over ground it can step up to or drop down to. */
  _spread(start, seedY) {
    const g0 = this._groundAt(start, seedY, this.agent.height + this.agent.drop);
    if (g0 === null || !this._clear(start, g0)) {
      // standing somewhere odd (on a crate, half in a wall): start from the nearest cell that works.
      // (It used to start from nothing: no way anywhere — and a Follower with no way walks
      // straight at what it chases, so a ghost grazing a door frame went through the wall.)
      this.ground[start] = NaN;
      const near = this._nearestClear(start, seedY);
      if (near) {
        start = near.cell;
        this.ground[start] = near.ground;
      }
    } else {
      this.ground[start] = g0;
    }
    const tried = new Uint8Array(this.ground.length);
    tried[start] = 1;
    const queue = Number.isNaN(this.ground[start]) ? [] : [start];
    const w = this.w;
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q];
      const i = c % w;
      const g = this.ground[c];
      for (const n of [i > 0 ? c - 1 : -1, i < w - 1 ? c + 1 : -1, c - w, c + w]) {
        if (n < 0 || n >= this.ground.length || tried[n]) continue;
        const ng = this._groundAt(n, g);
        if (ng === null || !this._clear(n, ng)) continue; // tried again from another side, maybe
        tried[n] = 1;
        this.ground[n] = ng;
        queue.push(n);
      }
    }
  }

  /** The nearest cell round `c` (in rings, out to about 1.5 m) with ground to stand on and room: { cell, ground }, or null. */
  _nearestClear(c, seedY) {
    const i0 = c % this.w;
    const j0 = Math.floor(c / this.w);
    const reach = Math.max(2, Math.ceil(1.5 / this.cell));
    for (let r = 1; r <= reach; r++) {
      let best = null;
      for (let j = j0 - r; j <= j0 + r; j++) {
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r) continue; // this ring only
          if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
          const n = j * this.w + i;
          const g = this._groundAt(n, seedY, this.agent.height + this.agent.drop);
          if (g === null || !this._clear(n, g)) continue;
          const d = (i - i0) ** 2 + (j - j0) ** 2;
          if (!best || d < best.d) best = { cell: n, ground: g, d };
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Can it go straight from cell a to cell b, all on walkable ground within a step? */
  _straight(a, b) {
    const A = this.centerOf(a, new THREE.Vector3());
    const B = this.centerOf(b, new THREE.Vector3());
    const n = Math.ceil(A.distanceTo(B) / (this.cell * 0.5));
    let last = a;
    for (let k = 1; k <= n; k++) {
      const c = this.cellOf(_p.lerpVectors(A, B, k / n));
      if (!this.walkable(c)) return false;
      if (!this._canStep(last, c)) return false;
      last = c;
    }
    return true;
  }

  _canStep(a, b) {
    const d = this.ground[b] - this.ground[a];
    return d <= this.agent.step + 1e-3 && -d <= this.agent.drop + 1e-3;
  }

  /** The walkable cell nearest to `c` (in rings out to `reach` cells), or -1. */
  _nearestWalkable(c, reach = 6) {
    if (this.walkable(c)) return c;
    const i0 = c % this.w;
    const j0 = Math.floor(c / this.w);
    let best = -1;
    let bestD = Infinity;
    for (let j = j0 - reach; j <= j0 + reach; j++) {
      for (let i = i0 - reach; i <= i0 + reach; i++) {
        if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
        const n = j * this.w + i;
        const d = (i - i0) ** 2 + (j - j0) ** 2;
        if (this.walkable(n) && d < bestD) { best = n; bestD = d; }
      }
    }
    return best;
  }

  /**
   * The way from `from` to `to`: points on the ground, the first a turn away
   * from `from`, the last where `to` is (or the nearest place to it that can
   * be walked to). Null when there is no way.
   */
  findPath(from, to) {
    const start = this._nearestWalkable(this.cellOf(from));
    const goal = this._nearestWalkable(this.cellOf(to));
    if (start < 0 || goal < 0) return null;
    const w = this.w;
    const cost = new Float32Array(this.ground.length).fill(Infinity);
    const came = new Int32Array(this.ground.length).fill(-1);
    const open = new Heap();
    const gi = goal % w;
    const gj = Math.floor(goal / w);
    const guess = (c) => {
      const dx = Math.abs((c % w) - gi);
      const dz = Math.abs(Math.floor(c / w) - gj);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    };
    cost[start] = 0;
    open.push(guess(start), start);
    let found = start === goal;
    let expanded = 0;
    while (open.size && !found && expanded++ < 60000) {
      const c = open.pop();
      const i = c % w;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const ni = i + dx;
          const n = c + dz * w + dx;
          if (ni < 0 || ni >= w || !this.walkable(n) || !this._canStep(c, n)) continue;
          // a diagonal only past two open sides: never cut a wall's corner
          if (dx && dz && (!this.walkable(c + dx) || !this.walkable(c + dz * w))) continue;
          const step = cost[c] + (dx && dz ? Math.SQRT2 : 1);
          if (step >= cost[n]) continue;
          cost[n] = step;
          came[n] = c;
          if (n === goal) { found = true; break; }
          open.push(step + guess(n), n);
        }
        if (found) break;
      }
    }
    if (!found) return null;
    const cells = [goal];
    while (cells[0] !== start) cells.unshift(came[cells[0]]);
    // straightened: from each point, on to the furthest it can go to in a straight line
    const turns = [];
    let at = 0;
    while (at < cells.length - 1) {
      let next = cells.length - 1;
      while (next > at + 1 && !this._straight(cells[at], cells[next])) next--;
      turns.push(cells[next]);
      at = next;
    }
    const points = turns.map((c) => this.centerOf(c));
    if (points.length) {
      const last = points[points.length - 1];
      if (goal === this.cellOf(to)) { last.x = to.x; last.z = to.z; } // right up to it, not the middle of its cell
    }
    return points;
  }
}

/**
 * The engine's navigation: grids for each size of walker, kept until the
 * level's solid bodies change.
 */
export class Navigation {
  constructor(engine) {
    this.engine = engine;
    this.grids = [];
    this._signature = '';
  }

  /** A walker's size and reach, from its bounds. */
  agentFor(entity) {
    const o = entity.object3D;
    const box = new THREE.Box3().setFromObject(o);
    // how wide it is in its own space, scaled: the same whichever way it faces (a world
    // box round it grows as it turns — a square body 40% wider at 45° — and a doorway it
    // fits through came and went as it turned on its way)
    const own = measureLocal(o, new THREE.Box3());
    const scale = o.getWorldScale(new THREE.Vector3());
    const size = own.isEmpty()
      ? (box.isEmpty() ? new THREE.Vector3(0.8, 1.8, 0.8) : box.getSize(new THREE.Vector3()))
      : own.getSize(new THREE.Vector3()).multiply(scale.set(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)));
    const radius = THREE.MathUtils.clamp(Math.max(size.x, size.z) / 2, 0.15, 2);
    return {
      radius,
      height: THREE.MathUtils.clamp(size.y, 0.3, 4),
      step: 0.45,
      drop: 3,
      feet: box.isEmpty() ? entity.object3D.position.y : box.min.y,
      // cells no bigger than half its radius: where it only just fits (a door half
      // open, 1.1 m for a walker 0.84 m wide) there is still a cell to stand in —
      // with 0.5 m cells it fell between them, found no way, and walked at the wall
      cell: THREE.MathUtils.clamp(radius / 2, 0.15, 0.5),
    };
  }

  /** Forget every grid — the next path measures the level again. */
  reset() { this.grids = []; }

  /**
   * The way for `entity` from where it is to `to`, round walls: an array of
   * points on the ground, or null when there is no way (or no level to go by).
   */
  path(entity, to) {
    const physics = this.engine.physics;
    if (!physics) return null;
    // A body moving right now (a lift, a door on its way open) is left out: the
    // walker's own body bumps into it anyway, and measuring it where it happens
    // to be would mean measuring the whole level again every time it moved.
    const solid = physics.colliders().filter((c) => isSolid(c) && !c.moving && c.entity !== entity);
    // something solid came, went, or stopped somewhere new: measure again
    const signature = solid.map(({ col }) => `${col.min.x.toFixed(1)},${col.min.y.toFixed(1)},${col.min.z.toFixed(1)},${col.max.x.toFixed(1)},${col.max.z.toFixed(1)}`).join('|');
    if (signature !== this._signature) {
      this._signature = signature;
      this.grids = [];
    }
    const agent = this.agentFor(entity);
    const p = entity.object3D.getWorldPosition(new THREE.Vector3());
    const from = new THREE.Vector3(p.x, agent.feet, p.z);
    const key = `${agent.radius.toFixed(1)}/${agent.height.toFixed(1)}`;
    let grid = this.grids.find((g) => g.key === key && g.walkable(g._nearestWalkable(g.cellOf(from), 2)));
    if (!grid) {
      grid = new NavGrid(solid, from, agent);
      grid.key = key;
      this.grids.unshift(grid);
      if (this.grids.length > 4) this.grids.pop();
    }
    return grid.findPath(from, to);
  }
}
