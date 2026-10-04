import { RigidBody, BODY_TYPES, BODY_SHAPES, DEFAULT_GRAVITY } from '../physics.js';
import { SHAPE_LABELS } from './shared.js';
import { allGroups, whoLabel, GROUP_PREFIX } from '../groups.js';
import { physicsPartList, PART_ROLES, PART_ROLE_LABELS, normalizePhysicsParts } from '../physics-parts.js';
import { escapeHtml } from '../ui.js';

/**
 * The Inspector's Physics section: body type, shape, mass, bounce, friction, trigger.
 *
 * Mixed into ObjectEditor.prototype (see ../editor.js), so `this` is the editor.
 */
export const physicsSectionMethods = {
  _physicsSection(entity) {
    const body = entity.rigidBody;
    const type = body?.type || 'static';
    const mass = body?.mass ?? 1;
    const restitution = body?.restitution ?? 0;
    const friction = body?.friction ?? 0.5;
    const gravityScale = (body?.gravity ?? DEFAULT_GRAVITY) / DEFAULT_GRAVITY;
    const hasBody = !!body;
    // turning as it moves is for things (crates, barrels, balls), never the player: it would fall over
    const canTumble = type === 'dynamic' && this.engine.playerEntity !== entity;
    return `
      <h4 class="insp-h">Physics</h4>
      <label class="check-row"><input type="checkbox" id="insp-rb-enable" ${hasBody ? 'checked' : ''}/> Enable rigid body</label>
      <div class="prop-row"><label>Type</label>
        <select id="insp-rb-type" ${hasBody ? '' : 'disabled'}>
          ${BODY_TYPES.map((t) => `<option value="${t}" ${type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
      <div class="prop-row"><label title="Static and kinematic boxes turn with the object; moving (dynamic) bodies keep an upright shape unless they tumble. Capsules have rounded feet that slide over small steps. Mesh collides as the model's real triangles — walk into a house, over hills, up stairs — for static and kinematic bodies (a dynamic one uses a box).">Shape</label>
        <select id="insp-rb-shape" ${hasBody ? '' : 'disabled'}>
          ${BODY_SHAPES.map((s) => `<option value="${s}" ${(body?.shape ?? 'auto') === s ? 'selected' : ''}>${SHAPE_LABELS[s]}</option>`).join('')}
        </select></div>
      <div class="prop-row"><label>Mass</label>
        <input type="number" id="insp-rb-mass" value="${mass}" step="0.1" ${hasBody ? '' : 'disabled'} /></div>
      <div class="prop-row"><label>Restitution</label>
        <input type="range" id="insp-rb-rest" min="0" max="1" step="0.05" value="${restitution}" ${hasBody ? '' : 'disabled'} />
        <span class="val" id="insp-rb-rest-v">${restitution.toFixed(2)}</span></div>
      <div class="prop-row"><label>Friction</label>
        <input type="range" id="insp-rb-fric" min="0" max="1" step="0.05" value="${friction}" ${hasBody ? '' : 'disabled'} />
        <span class="val" id="insp-rb-fric-v">${friction.toFixed(2)}</span></div>
      <div class="prop-row"><label title="How hard a dynamic body falls: 1 as usual, 0 floats (a ghost, a balloon), 0.3 a moon jump, 2 heavy">Gravity ×</label>
        <input type="range" id="insp-rb-grav" min="0" max="3" step="0.05" value="${gravityScale}" ${hasBody ? '' : 'disabled'} />
        <span class="val" id="insp-rb-grav-v">${gravityScale.toFixed(2)}</span></div>
      <label class="check-row" title="Detects overlaps but never blocks movement — pickups, checkpoints, damage zones">
        <input type="checkbox" id="insp-rb-trigger" ${body?.isTrigger ? 'checked' : ''} ${hasBody ? '' : 'disabled'} />
        Trigger (detect, don't block)</label>
      ${hasBody ? this._passesHtml(entity) : ''}
      ${hasBody ? this._partsHtml(entity) : ''}
      ${canTumble ? `<label class="check-row" title="Turns as well as moves: crates topple off ledges and tip when hit high, barrels and balls roll, a stack can be knocked down. For things, not characters — they must stay upright.">
        <input type="checkbox" id="insp-rb-tumbles" ${body?.tumbles ? 'checked' : ''} ${hasBody ? '' : 'disabled'} />
        Tumbles (rolls and topples)</label>` : ''}`;
  },

  /**
   * "Passes through": what this body goes through as if it weren't there — a
   * ghost through walls, bullets through their shooter's team, the player
   * through a one-way curtain. Groups, the player, or objects.
   */
  _passesHtml(entity) {
    const list = entity.rigidBody?.ignores || [];
    const chips = list.map((s, i) => `<span class="pass-chip">${escapeHtml(whoLabel(s))}<button class="gp-x" data-pass-del="${i}" title="Collide with it again">×</button></span>`).join('');
    const prefabs = this.engine.prefabs?.names?.().map((n) => this.engine.prefabs.get(n)) ?? [];
    const groups = allGroups(this.engine.entities || [], prefabs).map((g) => GROUP_PREFIX + g);
    const names = [...new Set((this.engine.entities || [])
      .filter((e) => e !== entity && e !== this.engine.player && e.object3D?.name && !e.object3D.isLight)
      .map((e) => e.object3D.name))].sort((a, b) => a.localeCompare(b));
    const has = (v) => list.some((s) => s.toLowerCase() === v.toLowerCase());
    const opt = (v, label) => (has(v) ? '' : `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`);
    const gOpts = groups.map((g) => opt(g, `every ${g.slice(GROUP_PREFIX.length)}`)).join('');
    const nOpts = names.map((n) => opt(n, n)).join('');
    return `<div class="prop-row pass-row"><label title="Goes through these as if neither were there: no bumping, no pushing, no standing on — and a trigger isn't set off by them. Set on either one of the two, it works both ways.">Passes through</label>
      <div class="pass-list">${chips || '<span class="pass-none">nothing — it hits everything</span>'}
        <select id="insp-rb-pass-add" title="Add what it passes through"><option value="">+ add…</option>
          ${opt('player', 'The player')}
          ${gOpts ? `<optgroup label="Groups">${gOpts}</optgroup>` : ''}
          ${nOpts ? `<optgroup label="Objects">${nOpts}</optgroup>` : ''}
        </select></div></div>`;
  },

  /**
   * A model's parts, each with physics of its own: in its body, left out, an
   * own box, a trigger zone (physics-parts.js). A filter for a model of many
   * (a field: its grass, trees, rocks, water), and one choice for all it shows.
   */
  _partsHtml(entity) {
    const parts = physicsPartList(entity.object3D);
    if (parts.length < 2) return '';
    const roles = entity.physicsParts || {};
    const filter = (this._partFilter?.get(entity) ?? '').toLowerCase();
    const shown = parts.filter((p) => !filter || p.key.toLowerCase().includes(filter));
    const opts = (role) => PART_ROLES.map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${escapeHtml(PART_ROLE_LABELS[r])}</option>`).join('');
    const counts = PART_ROLES.map((r) => [r, parts.filter((p) => (roles[p.key] || 'body') === r).length]).filter(([, n]) => n);
    const rows = shown.slice(0, 200).map((p) => `
      <div class="part-row" data-part-key="${escapeHtml(p.key)}" title="${escapeHtml(p.key)}">
        <span class="part-name">${escapeHtml(p.name)}</span>
        <select data-part-role="${escapeHtml(p.key)}">${opts(roles[p.key] || 'body')}</select>
      </div>`).join('');
    return `
      <div class="phys-parts">
        <h4 class="insp-h" title="What each part of the model is, for physics: solid as part of it, not solid at all, a solid box of its own, or a trigger zone">Parts (${parts.length})</h4>
        <div class="gp-legend">${counts.map(([r, n]) => `${n} ${escapeHtml(PART_ROLE_LABELS[r].replace(/ \(.*\)/, '').toLowerCase())}`).join(' · ')}</div>
        <div class="prop-row"><label title="Show only the parts whose name has this in it">Find</label>
          <input type="text" id="insp-parts-filter" value="${escapeHtml(filter)}" placeholder="e.g. grass, rock, water" spellcheck="false" /></div>
        <div class="prop-row"><label title="Give every part shown the same physics">All shown</label>
          <select id="insp-parts-all"><option value="">set ${shown.length} to…</option>${PART_ROLES.map((r) => `<option value="${r}">${escapeHtml(PART_ROLE_LABELS[r])}</option>`).join('')}</select></div>
        <div class="part-list">${rows || '<div class="empty">No part by that name.</div>'}
          ${shown.length > 200 ? `<div class="empty">…and ${shown.length - 200} more: narrow it with Find</div>` : ''}</div>
      </div>`;
  },

  /** Its parts' physics changed: kept (one undo step), and its colliders made again. */
  _setPartRoles(entity, next, label) {
    const before = entity.physicsParts ? { ...entity.physicsParts } : undefined;
    const after = normalizePhysicsParts(next);
    if (JSON.stringify(before ?? {}) === JSON.stringify(after ?? {})) return;
    const apply = (v) => {
      entity.physicsParts = v ? { ...v } : undefined;
      if (entity.rigidBody) {
        this.engine.physics.unregister(entity);
        this.engine.physics.register(entity);
      }
    };
    this._recordValue(entity, 'physicsParts', before, after, apply, label);
    apply(after);
    this._renderInspector();
  },

  _wirePhysicsSection(entity) {
    const q = (s) => this._q(s);
    // its parts' own physics
    const parts = () => physicsPartList(entity.object3D);
    this.inspectorEl?.querySelectorAll('[data-part-role]').forEach((sel) => sel.addEventListener('change', () => {
      this._setPartRoles(entity, { ...(entity.physicsParts || {}), [sel.dataset.partRole]: sel.value }, 'part physics');
    }));
    const filterEl = q('#insp-parts-filter');
    filterEl?.addEventListener('change', () => {
      (this._partFilter ??= new WeakMap()).set(entity, filterEl.value.trim());
      this._renderInspector();
      this._q('#insp-parts-filter')?.focus();
    });
    q('#insp-parts-all')?.addEventListener('change', (e) => {
      const role = e.target.value;
      if (!role) return;
      const filter = (this._partFilter?.get(entity) ?? '').toLowerCase();
      const next = { ...(entity.physicsParts || {}) };
      for (const p of parts()) if (!filter || p.key.toLowerCase().includes(filter)) next[p.key] = role;
      this._setPartRoles(entity, next, 'part physics');
    });
    // a part shown in the list: outlined in the view while the pointer is on it
    this.inspectorEl?.querySelectorAll('[data-part-key]').forEach((row) => row.addEventListener('mouseenter', () => {
      const p = parts().find((x) => x.key === row.dataset.partKey);
      if (p) this._flashPartNode?.(p.node);
    }));
    // what it passes through: one undo step each
    const setPasses = (after, label) => {
      const body = entity.rigidBody;
      if (!body) return;
      const before = [...(body.ignores || [])];
      this._recordValue(body, 'ignores', before, after, (v) => { body.ignores = [...v]; }, label);
      body.ignores = [...after];
      this._renderInspector();
    };
    q('#insp-rb-pass-add')?.addEventListener('change', (e) => {
      const v = e.target.value;
      if (v) setPasses([...(entity.rigidBody?.ignores || []), v], 'passes through');
    });
    this.inspectorEl?.querySelectorAll('[data-pass-del]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.passDel);
      setPasses((entity.rigidBody?.ignores || []).filter((_, k) => k !== i), 'collides again');
    }));
    const enable = q('#insp-rb-enable');
    const typeSel = q('#insp-rb-type');
    const massIn = q('#insp-rb-mass');
    const rest = q('#insp-rb-rest');
    const fric = q('#insp-rb-fric');

    const trigger = q('#insp-rb-trigger');
    const shapeSel = q('#insp-rb-shape');
    // the Solid tick and the red box round what blocks follow every change here
    const changed = () => {
      this._updateSolidHelper(entity);
      this._renderInspector();
    };

    shapeSel?.addEventListener('change', () => {
      if (!entity.rigidBody) return;
      const before = entity.rigidBody.shape;
      const after = shapeSel.value;
      this._recordValue(entity, 'shape', before, after, (v) => {
        if (entity.rigidBody) entity.rigidBody.shape = v;
        shapeSel.value = v;
        this._updateSolidHelper(entity);
      }, 'collision shape');
      entity.rigidBody.shape = after;
      changed();
    });

    const updateUI = (enabled) => {
      typeSel.disabled = !enabled;
      if (shapeSel) shapeSel.disabled = !enabled;
      massIn.disabled = !enabled;
      rest.disabled = !enabled;
      fric.disabled = !enabled;
      if (trigger) trigger.disabled = !enabled;
      if (tumbles) tumbles.disabled = !enabled;
    };

    const tumbles = q('#insp-rb-tumbles');
    tumbles?.addEventListener('change', () => {
      if (!entity.rigidBody) return;
      const after = tumbles.checked;
      this._recordValue(entity.rigidBody, 'tumbles', !after, after, (v) => {
        entity.rigidBody.tumbles = v;
        tumbles.checked = v;
      }, 'tumbles');
      entity.rigidBody.tumbles = after;
      changed();
    });

    trigger?.addEventListener('change', () => {
      const after = trigger.checked;
      const before = !after;
      this._recordValue(entity, 'isTrigger', before, after, (v) => {
        if (entity.rigidBody) entity.rigidBody.isTrigger = v;
        trigger.checked = v;
        this._updateSolidHelper(entity);
      }, 'trigger');
      if (entity.rigidBody) entity.rigidBody.isTrigger = after;
      changed();
    });

    enable.addEventListener('change', () => {
      const after = enable.checked;
      // The player's body moves: dynamic, a capsule — a static player can't
      // fall, jump or be stopped by walls (it floated off the edge of things).
      // A model's body starts as its real shape — walk into a house, over its
      // hills — where a box round all of it would be a solid block. (A new
      // body only: saved ones keep theirs.)
      const o = entity.object3D;
      const isPlayer = this.engine.playerEntity === entity; // the chosen object, or the stand-in player
      const settings = isPlayer
        ? { type: 'dynamic', shape: 'capsule', mass: 70, friction: 0.1 }
        : { shape: o.userData.assetId || o.userData.assetUrl ? 'mesh' : 'auto' };
      const body = after ? new RigidBody(settings) : null;
      // the same body the object gets, so undo and redo bring back that one
      this._recordValue(entity, 'rigidBody', entity.rigidBody, body, (v) => {
        entity.rigidBody = v;
        if (v) this.engine.physics.register(entity);
        else this.engine.physics.unregister(entity);
        this._renderInspector();
      }, 'rigid body');
      if (body) {
        entity.rigidBody = body;
        this.engine.physics.register(entity);
      } else {
        this.engine.physics.unregister(entity);
        entity.rigidBody = null;
      }
      updateUI(after);
      changed();
    });

    typeSel.addEventListener('change', () => {
      if (!entity.rigidBody) return;
      const before = entity.rigidBody.type;
      const after = typeSel.value;
      this._recordValue(entity.rigidBody, 'type', before, after, (v) => {
        entity.rigidBody.type = v;
        entity.rigidBody.invMass = v === 'dynamic' ? 1 / entity.rigidBody.mass : 0;
        this._updateSolidHelper(entity);
      }, 'physics type');
      entity.rigidBody.type = after;
      entity.rigidBody.invMass = after === 'dynamic' ? 1 / entity.rigidBody.mass : 0;
      changed();
    });

    let massBefore = entity.rigidBody?.mass ?? 1;
    massIn.addEventListener('input', () => {
      if (!entity.rigidBody) return;
      const v = Math.max(0.001, parseFloat(massIn.value) || 0.001);
      entity.rigidBody.mass = v;
      entity.rigidBody.invMass = entity.rigidBody.type === 'dynamic' ? 1 / v : 0;
    });
    massIn.addEventListener('change', () => {
      if (!entity.rigidBody) return;
      const after = entity.rigidBody.mass;
      this._recordValue(entity.rigidBody, 'mass', massBefore, after, (v) => {
        entity.rigidBody.mass = v;
        entity.rigidBody.invMass = entity.rigidBody.type === 'dynamic' ? 1 / v : 0;
        massIn.value = v;
      }, 'physics mass');
      massBefore = after;
    });

    let restBefore = entity.rigidBody?.restitution ?? 0;
    rest.addEventListener('input', () => {
      if (!entity.rigidBody) return;
      entity.rigidBody.restitution = parseFloat(rest.value);
      q('#insp-rb-rest-v').textContent = entity.rigidBody.restitution.toFixed(2);
    });
    rest.addEventListener('change', () => {
      if (!entity.rigidBody) return;
      const after = entity.rigidBody.restitution;
      this._recordValue(entity.rigidBody, 'restitution', restBefore, after, (v) => {
        entity.rigidBody.restitution = v;
        rest.value = v;
        q('#insp-rb-rest-v').textContent = v.toFixed(2);
      }, 'physics restitution');
      restBefore = after;
    });

    let fricBefore = entity.rigidBody?.friction ?? 0.5;
    fric.addEventListener('input', () => {
      if (!entity.rigidBody) return;
      entity.rigidBody.friction = parseFloat(fric.value);
      q('#insp-rb-fric-v').textContent = entity.rigidBody.friction.toFixed(2);
    });
    fric.addEventListener('change', () => {
      if (!entity.rigidBody) return;
      const after = entity.rigidBody.friction;
      this._recordValue(entity.rigidBody, 'friction', fricBefore, after, (v) => {
        entity.rigidBody.friction = v;
        fric.value = v;
        q('#insp-rb-fric-v').textContent = v.toFixed(2);
      }, 'physics friction');
      fricBefore = after;
    });

    // Gravity ×: how hard it falls, as a share of the usual pull (saved with it)
    const grav = q('#insp-rb-grav');
    let gravBefore = entity.rigidBody?.gravity ?? DEFAULT_GRAVITY;
    grav?.addEventListener('input', () => {
      if (!entity.rigidBody) return;
      entity.rigidBody.gravity = DEFAULT_GRAVITY * parseFloat(grav.value);
      q('#insp-rb-grav-v').textContent = parseFloat(grav.value).toFixed(2);
    });
    grav?.addEventListener('change', () => {
      if (!entity.rigidBody) return;
      const after = entity.rigidBody.gravity;
      this._recordValue(entity.rigidBody, 'gravity', gravBefore, after, (v) => {
        entity.rigidBody.gravity = v;
        grav.value = v / DEFAULT_GRAVITY;
        q('#insp-rb-grav-v').textContent = (v / DEFAULT_GRAVITY).toFixed(2);
      }, 'physics gravity');
      gravBefore = after;
    });
  },
};
