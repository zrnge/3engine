import { AnimationPlayer, clipNames } from '../animation.js';
import { RigidBody } from '../physics.js';
import { MOUSE_BUTTONS, keyLabel, normalizeControl } from '../controls.js';
import { captureNextInput } from '../input.js';
import { fitViewModel } from '../view-model.js';
import { escapeHtml } from '../ui.js';
import { assetStore } from '../assets-db.js';

/**
 * The Inspector's Animation section, for a model that brought clips with it.
 *
 * Nothing here knows what a clip is for. Every clip is listed as the file named
 * it; the game maker decides what each one does:
 *   - ▶ previews it;
 *   - "+ Bind" waits for whatever they press next — a key, a mouse button, or
 *     an on-screen button — and makes a Play animation control from it (the
 *     Controls panel shows it like any other, to change or delete);
 *   - the Animator component (Components, below) is where the clips for
 *     standing, walking, running and jumping are picked.
 * And two one-click setups, both undoable: make the model the player (third
 * person), or hold it in first-person view (arms, a gun).
 *
 * Mixed into ObjectEditor.prototype (see ../editor.js), so `this` is the editor.
 */

/** How an input reads on a chip: "R", "Mouse left", "Screen: Fire". */
function inputLabel(input) {
  if (input.type === 'mouse') return `Mouse ${input.button}`;
  if (input.type === 'screen') return `Screen: ${input.label}`;
  return keyLabel(input.code);
}

export const animationSectionMethods = {
  /** The name controls use to find this object: "player" for the player. */
  _controlTargetFor(entity) {
    return this.engine.player?.target === entity ? 'player' : entity.object3D.name;
  },

  /** Does this control play `clip` on `entity`? */
  _playsClipOn(control, entity, clip) {
    const a = control.action;
    if (a.type !== 'playAnimation' || a.clip !== clip) return false;
    const who = a.target && a.target !== 'self' ? a.target : control.target;
    if (who === 'player') return this.engine.playerEntity === entity;
    return who === entity.object3D.name;
  },

  /**
   * While editing, loop the default clip ("Plays on its own") of every model
   * that asks for it — and let go of those that stopped asking. In Play the
   * Animator does this itself.
   */
  _previewDefaultClips() {
    const components = this.engine.gameplay?.components;
    if (!components) return;
    const now = new Set();
    for (const e of this.selectables) {
      const anim = components.listFor(e).find((c) => c.type === 'animator');
      if (!anim?.props.preview || !anim.props.idle) continue;
      now.add(e);
      AnimationPlayer.for(this.engine, e.object3D).setBase(anim.props.idle);
    }
    for (const e of this._previewingDefaults || []) {
      if (now.has(e)) continue;
      const player = this.engine.mixers?.find((m) => m.root === e.object3D);
      if (player instanceof AnimationPlayer) player.setBase('');
    }
    this._previewingDefaults = now;
  },

  _animationSection(entity) {
    const o = entity.object3D;
    const clipObjects = o.userData.animations || [];
    const clips = clipNames(o);
    // a model can take clips from other files even if its own has none
    const isModel = !!(o.userData.assetId || o.userData.assetUrl);
    if (!clips.length && !isModel) return '';
    const controls = this.engine.gameplay?.controls.list || [];
    const player = this.engine.mixers?.find((m) => m.root === o);
    const previewing = player instanceof AnimationPlayer ? player.playing : '';
    const cutting = this._cutting?.entity === entity ? this._cutting.clip : null;
    const rows = clips.map((clip, i) => {
      const source = clipObjects[i]?.tiny3;
      const chips = [];
      controls.forEach((c, ci) => {
        if (!this._playsClipOn(c, entity, clip)) return;
        c.inputs.forEach((input, ii) => chips.push(`<span class="anim-chip" title="${escapeHtml(c.action.mode)}">${
          escapeHtml(inputLabel(input))}<button class="gp-x" data-anim-unbind="${ci}:${ii}" title="Remove">×</button></span>`));
      });
      const seconds = clipObjects[i]?.duration ?? 0;
      const from = source?.kind === 'added' ? `from ${source.file}` : source?.kind === 'cut' ? 'a part you cut' : 'in the model\'s file';
      const remove = source ? `<button class="gp-x" data-anim-remove="${i}" title="${
        source.kind === 'added' ? `Remove the clips from ${escapeHtml(source.file)}` : 'Remove this part'}">×</button>` : '';
      const row = `<li class="${clip === previewing ? 'playing' : ''}">
        <button class="tbtn mini" data-anim-preview="${i}" title="Preview">${clip === previewing ? '⏹' : '▶'}</button>
        <span class="anim-name" title="${escapeHtml(clip)} — ${seconds.toFixed(2)} s, ${escapeHtml(from)}">${escapeHtml(clip)}</span>
        <span class="anim-len">${seconds.toFixed(1)}s</span>
        ${chips.join('')}
        <button class="tbtn mini" data-anim-cut="${i}" title="Cut a part out of it (a long clip holding several moves)">✂</button>
        <button class="tbtn mini" data-anim-bind="${i}" title="Press a key, a mouse button or add a screen button to play it">+ Bind</button>
        ${remove}
      </li>`;
      if (clip !== cutting) return row;
      return `${row}<li class="anim-cut-form">
        <div class="anim-cut-scrub" title="Drag through the clip: the model shows each moment, so you can see where a move starts and ends">
          <input type="range" id="anim-cut-scrub" min="0" max="${seconds}" step="0.01" value="0" />
          <span id="anim-cut-at">0.00s</span>
        </div>
        <button class="tbtn mini" id="anim-cut-start" title="The part starts at the moment shown">⇤ Start here</button>
        <button class="tbtn mini" id="anim-cut-end" title="The part ends at the moment shown">⇥ End here</button>
        <button class="tbtn mini" id="anim-cut-play" title="Loop the part, to check it before cutting">▶ Play part</button>
        <input type="text" id="anim-cut-name" value="${escapeHtml(`${clip} part`)}" spellcheck="false" title="The part's name" />
        <label>from <input type="number" id="anim-cut-from" min="0" max="${seconds}" step="0.01" value="0" /></label>
        <label>to <input type="number" id="anim-cut-to" min="0" max="${seconds}" step="0.01" value="${+seconds.toFixed(2)}" /> s</label>
        <button class="tbtn mini" id="anim-cut-ok">✂ Cut</button>
        <button class="gp-x" id="anim-cut-close" title="Close">×</button>
      </li>`;
    }).join('');
    const isPlayer = this.engine.player?.target === entity;
    const note = this._animNote?.entity === entity ? `<div class="anim-note">${escapeHtml(this._animNote.text)}</div>` : '';
    const fewHint = clips.length <= 1
      ? `<div class="anim-hint">${clips.length ? 'Only one clip in this file.' : 'No animations in this file.'}
        If each move is its own file (Mixamo, many stores), add them with <b>＋ Clips from other files</b>.
        If one clip holds several moves, <b>✂</b> cut it into parts.</div>`
      : '';
    // its default clip: the Animator's standing clip, which plays whenever it isn't moving
    const animator = this.engine.gameplay?.components.listFor(entity).find((c) => c.type === 'animator');
    const idle = animator?.props.idle || '';
    const defaultRow = clips.length ? `
      <div class="prop-row" title="Loops whenever nothing else plays and it isn't moving — breathing, idling. It is the Animator's standing clip.">
        <label>Plays on its own</label>
        <select id="anim-default"><option value="" ${idle ? '' : 'selected'}>— nothing —</option>${
          clips.map((c) => `<option value="${escapeHtml(c)}" ${c === idle ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>
      </div>
      <label class="check-row" title="See it play while you build the scene, not only in the game">
        <input type="checkbox" id="anim-default-edit" ${animator?.props.preview ? 'checked' : ''} ${idle ? '' : 'disabled'} /> Also while editing</label>` : '';
    return `
      <h4 class="insp-h">Animation <span class="anim-count">${clips.length} clip${clips.length === 1 ? '' : 's'}</span></h4>
      ${defaultRow}
      <ul class="anim-list">${rows}</ul>
      ${fewHint}
      <div class="insp-row wrap" style="margin-top:4px">
        <button class="tbtn" id="anim-add-files" title="Animations saved in other files — they must use this model's bone names, as files from the same rig do">＋ Clips from other files…</button>
      </div>
      ${note}
      <div class="anim-hint">Pick the clips for standing, walking, running and jumping in the <b>Animator</b> component.
        <b>+ Bind</b> plays a clip from a key, a mouse button or a screen button.</div>
      <div class="insp-row wrap" style="margin:6px 0 8px">
        <button class="tbtn" id="anim-as-player" ${isPlayer ? 'disabled' : ''}
          title="Third person: it becomes the player, moves with the controls and the camera follows it">🧍 Make it the player</button>
        <button class="tbtn" id="anim-as-arms" ${entity.viewModel ? 'disabled' : ''}
          title="First person: arms, a gun — drawn in front of the camera, animated as the player moves">🖐 Hold in first-person view</button>
      </div>`;
  },

  _wireAnimationSection(entity) {
    const root = this._q('.anim-list');
    if (!root) return;
    const clips = clipNames(entity.object3D);
    const player = () => AnimationPlayer.for(this.engine, entity.object3D);
    const o = entity.object3D;
    const extras = () => ({ animationFiles: [...(o.userData.animationFiles || [])], clipCuts: [...(o.userData.clipCuts || [])] });

    this._q('#anim-add-files')?.addEventListener('click', () => this._addClipFiles(entity));
    // the default clip lives on the Animator (added if there is none) — one place, one undo step
    this._q('#anim-default')?.addEventListener('change', (e) => {
      const clip = e.target.value;
      this._setup(entity, 'default animation', () => this._ensureAnimator(entity, { idle: clip }));
    });
    this._q('#anim-default-edit')?.addEventListener('change', (e) => {
      const on = e.target.checked;
      this._setup(entity, 'default animation while editing', () => this._ensureAnimator(entity, { preview: on }));
    });
    for (const b of root.querySelectorAll('[data-anim-cut]')) {
      b.addEventListener('click', () => {
        const clip = clips[Number(b.dataset.animCut)];
        this._cutting = this._cutting?.entity === entity && this._cutting.clip === clip ? null : { entity, clip };
        this._renderInspector();
      });
    }
    // finding the moves: drag through the clip, mark where a part starts and ends, loop it
    const scrub = root.querySelector('#anim-cut-scrub');
    if (scrub) {
      const clip = this._cutting.clip;
      const at = () => Number(scrub.value);
      scrub.addEventListener('input', () => {
        player().pose(clip, at());
        root.querySelector('#anim-cut-at').textContent = `${at().toFixed(2)}s`;
      });
      root.querySelector('#anim-cut-start').addEventListener('click', () => { root.querySelector('#anim-cut-from').value = at().toFixed(2); });
      root.querySelector('#anim-cut-end').addEventListener('click', () => { root.querySelector('#anim-cut-to').value = at().toFixed(2); });
      root.querySelector('#anim-cut-play').addEventListener('click', () => {
        player().previewPart(clip, Number(root.querySelector('#anim-cut-from').value), Number(root.querySelector('#anim-cut-to').value));
      });
    }
    root.querySelector('#anim-cut-close')?.addEventListener('click', () => {
      this._cutting = null;
      player().stop();
      this._renderInspector();
    });
    root.querySelector('#anim-cut-ok')?.addEventListener('click', async () => {
      player().stop();
      const from = this._cutting.clip;
      const name = root.querySelector('#anim-cut-name').value.trim() || `${from} part`;
      const start = Number(root.querySelector('#anim-cut-from').value);
      const end = Number(root.querySelector('#anim-cut-to').value);
      this._cutting = null;
      const x = extras();
      x.clipCuts.push({ from, name, start, end });
      await this._setClipExtras(entity, x, 'cut an animation clip');
    });
    for (const b of root.querySelectorAll('[data-anim-remove]')) {
      b.addEventListener('click', async () => {
        const source = o.userData.animations[Number(b.dataset.animRemove)]?.tiny3;
        const x = extras();
        if (source?.kind === 'added') x.animationFiles = x.animationFiles.filter((f) => f.assetId !== source.assetId);
        if (source?.kind === 'cut') x.clipCuts.splice(source.index, 1);
        await this._setClipExtras(entity, x, 'remove animation clips');
      });
    }

    for (const b of root.querySelectorAll('[data-anim-preview]')) {
      b.addEventListener('click', () => {
        const clip = clips[Number(b.dataset.animPreview)];
        const p = player();
        if (p.playing === clip) p.stop();
        else p.play(clip, { mode: 'loop', interrupt: true });
        this._renderInspector();
      });
    }
    for (const b of root.querySelectorAll('[data-anim-bind]')) {
      b.addEventListener('click', () => this._bindClip(entity, clips[Number(b.dataset.animBind)]));
    }
    for (const b of root.querySelectorAll('[data-anim-unbind]')) {
      b.addEventListener('click', () => {
        const [ci, ii] = b.dataset.animUnbind.split(':').map(Number);
        this._editControls('unbind animation', (list) => {
          list[ci].inputs.splice(ii, 1);
          if (!list[ci].inputs.length) list.splice(ci, 1); // nothing left to press it
        });
      });
    }
    this._q('#anim-as-player')?.addEventListener('click', () => this.makePlayer(entity));
    this._q('#anim-as-arms')?.addEventListener('click', () => this.holdInView(entity));
  },

  /**
   * Change which other files a model takes clips from and which parts are cut
   * from its clips — one undo step. Returns what each file gave.
   */
  async _setClipExtras(entity, extras, label) {
    const o = entity.object3D;
    const before = { animationFiles: [...(o.userData.animationFiles || [])], clipCuts: [...(o.userData.clipCuts || [])] };
    const apply = async (x) => {
      const report = await this.assets.applyAnimationExtras(o, x);
      // the clips are numbered afresh: the model's player starts again
      const player = this.engine.mixers?.find((m) => m.root === o);
      if (player instanceof AnimationPlayer) player.dispose(this.engine);
      this._renderInspector();
      return report;
    };
    const report = await apply(extras);
    this.history?.push({ label, undo: () => apply(before), redo: () => apply(extras) });
    return report;
  },

  /** "＋ Clips from other files…": pick one or more files, keep what fits this model. */
  _addClipFiles(entity) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    // (an .fbx too — Mixamo's clips come as .fbx — made into a .glb as it comes in)
    input.accept = ['.glb,.gltf,model/gltf-binary', ...(this.assets?.convertible || []).map((e) => `.${e}`)].join(',');
    input.addEventListener('change', async () => {
      const files = [...(input.files || [])];
      if (!files.length) return;
      const o = entity.object3D;
      const list = [...(o.userData.animationFiles || [])];
      const picked = [];
      for (let file of files) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (this.assets?.convertModel && this.assets.convertible.includes(ext)) {
          try {
            const glb = await this.assets.convertModel({ file, path: file.name }, [{ file, path: file.name }]);
            file = new File([glb], file.name, { type: 'model/gltf-binary' }); // named as picked: its one clip is called after it
          } catch (err) {
            console.warn('[Tiny3] could not read', file.name, err);
            continue;
          }
        }
        const meta = await assetStore.put(file, { kind: 'animation' });
        picked.push(meta.id);
        if (!list.some((f) => f.assetId === meta.id)) list.push({ assetId: meta.id, name: file.name });
      }
      const report = await this._setClipExtras(entity, { animationFiles: list, clipCuts: [...(o.userData.clipCuts || [])] },
        'add animation clips');
      // say what each file gave — and why, when it gave nothing
      const mine = report.filter((r) => list.some((f) => f.name === r.file && picked.includes(f.assetId)));
      this._animNote = {
        entity,
        text: mine.map((r) => (r.used
          ? `${r.file}: ${r.used} clip${r.used === 1 ? '' : 's'} added${r.across ? ` (made for another skeleton: carried across by body part${r.across < r.used ? `, ${r.across} of them` : ''})` : ''}`
          : `${r.file}: ${r.of ? 'its clips move a skeleton this model doesn\'t have, and its bones couldn\'t be matched by body part' : 'no animations in it'}`)).join(' · '),
      };
      this._renderInspector();
    });
    input.click();
  },

  /** Change the controls list as one undoable step, then redraw what shows it. */
  _editControls(label, change) {
    const runtime = this.engine.gameplay.controls;
    const before = runtime.toJSON();
    const list = runtime.toJSON();
    change(list);
    const after = list;
    const apply = (data) => {
      runtime.load(data);
      this.onControlsChanged?.();
      this._renderInspector();
    };
    this.history?.push({ label, undo: () => apply(before), redo: () => apply(after) });
    apply(after);
  },

  /**
   * "+ Bind": wait for the next key or mouse button (or a click on "On-screen
   * button") and make a Play animation control for this clip from it.
   */
  _bindClip(entity, clip) {
    document.querySelector('.anim-capture')?.remove();
    const el = document.createElement('div');
    // a modal: its clicks are not clicks on the scene (input.js ignores them)
    el.className = 'anim-capture modal';
    el.innerHTML = `<div class="anim-capture-card">
      <div>Press a key, a mouse button or a gamepad button to play <b>${escapeHtml(clip)}</b></div>
      <div class="prop-row"><label>Play</label>
        <select data-mode><option value="once">once</option><option value="loop">loop</option>
          <option value="while held">while held</option></select></div>
      <div class="insp-row">
        <button class="tbtn" data-screen>▣ On-screen button</button>
        <button class="tbtn" data-cancel>Cancel (Esc)</button>
      </div></div>`;
    document.body.appendChild(el);
    const mode = () => el.querySelector('[data-mode]').value;
    let stopCapture = () => {};
    const done = (input) => {
      stopCapture();
      el.remove();
      if (!input) return;
      // controls find objects by name: a nameless or shared name needs its own
      const target = this._controlTargetFor(entity);
      if (target !== 'player') this._ensureUniqueName(entity);
      this._editControls('bind animation', (list) => list.push(normalizeControl({
        inputs: [input],
        target: this._controlTargetFor(entity),
        action: { type: 'playAnimation', clip, target: 'self', mode: mode() },
      })));
    };
    // a key or a gamepad button (Esc cancels); a modifier alone is not an answer
    stopCapture = captureNextInput((code) => done(code ? { type: 'key', code } : null), {
      ignore: ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'],
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, select')) return;
      e.preventDefault();
      const input = { type: 'mouse', button: MOUSE_BUTTONS[e.button] ?? 'left' };
      // Finish after the release: closing on the press let the release and its
      // click fall through to the 3D view, which deselected the model.
      window.addEventListener('mouseup', () => setTimeout(() => done(input), 0), { once: true });
    });
    el.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    el.querySelector('[data-screen]').addEventListener('click', () => {
      done({ type: 'screen', label: clip.slice(0, 10) });
    });
  },

  _ensureUniqueName(entity) {
    const o = entity.object3D;
    const taken = (n) => this.selectables.some((e) => e !== entity && e.object3D.name === n);
    if (o.name && !taken(o.name)) return;
    const base = (o.name || 'Model').replace(/\s*\d+$/, '') || 'Model';
    let n = 2;
    while (taken(`${base} ${n}`)) n++;
    o.name = `${base} ${n}`;
    this._renderHierarchy();
  },

  /** Record everything the setups below change, so each is one undo step. */
  _setupSnapshot(entity) {
    const rig = this.engine.cameraRig;
    return {
      playerTarget: this.engine.player?.target ?? null,
      playMode: rig?.playMode ?? null,
      body: entity.rigidBody ? entity.rigidBody.toJSON() : null,
      solid: !!entity.solid,
      viewModel: entity.viewModel ? JSON.parse(JSON.stringify(entity.viewModel)) : null,
      components: this.engine.gameplay.components.serializeFor(entity) ?? [],
    };
  },

  _applySetup(entity, s) {
    const { engine } = this;
    if (engine.player) engine.player.target = s.playerTarget;
    if (engine.cameraRig) engine.cameraRig.playMode = s.playMode;
    engine.physics.unregister(entity);
    entity.rigidBody = s.body ? new RigidBody(s.body) : null;
    if (entity.rigidBody) engine.physics.register(entity);
    entity.solid = s.solid;
    if (s.viewModel) entity.viewModel = s.viewModel;
    else delete entity.viewModel;
    const components = engine.gameplay.components;
    components.clearEntity(entity);
    for (const c of s.components) components.add(entity, c.type, c.props);
    this._updateSolidHelper(entity);
    window.dispatchEvent(new CustomEvent('tiny3:player-loaded')); // the panels re-read who the player is
    this._renderInspector();
  },

  _setup(entity, label, change) {
    const before = this._setupSnapshot(entity);
    change();
    const after = this._setupSnapshot(entity);
    this.history?.push({ label, undo: () => this._applySetup(entity, before), redo: () => this._applySetup(entity, after) });
    this._applySetup(entity, after);
  },

  /** An Animator on it, if it has none yet (picks left to the game maker). */
  _ensureAnimator(entity, props = {}) {
    const components = this.engine.gameplay.components;
    const existing = components.listFor(entity).find((c) => c.type === 'animator');
    if (existing) Object.assign(existing.props, props);
    else components.add(entity, 'animator', { style: 'clips', ...props });
  },

  /**
   * Third person: this model is the player. It gets a capsule body if it has
   * no body (so it falls, collides and walks up slopes), an Animator for its
   * movement clips, and the game's camera follows it.
   */
  makePlayer(entity) {
    this._setup(entity, 'make it the player', () => {
      if (this.engine.player) this.engine.player.target = entity;
      if (!entity.rigidBody || entity.rigidBody.type !== 'dynamic') {
        entity.rigidBody = new RigidBody({ type: 'dynamic', shape: 'capsule', mass: 70, friction: 0.1 });
      }
      delete entity.viewModel;
      this._ensureAnimator(entity, { follow: 'self' });
      const rig = this.engine.cameraRig;
      if (rig) rig.playMode = 'follow';
    });
  },

  /**
   * First person: arms, a gun — drawn in front of the camera, sized and turned
   * to a starting place (the Held in view sliders take it from there), animated
   * by the player's movement. Its place in the level no longer collides.
   */
  holdInView(entity) {
    this._setup(entity, 'hold in first-person view', () => {
      entity.viewModel = fitViewModel(entity.object3D);
      if (this.engine.player?.target === entity) this.engine.player.target = null;
      entity.rigidBody = null;
      entity.solid = false;
      this._ensureAnimator(entity, { follow: 'player' });
      const rig = this.engine.cameraRig;
      if (rig) rig.playMode = 'fps';
    });
  },
};
