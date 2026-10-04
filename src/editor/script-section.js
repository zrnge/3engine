import { escapeHtml } from '../ui.js';
import { SCRIPT_API } from '../script-api.js';

/**
 * The Inspector's Script section: a behavior script, the escape hatch under components and rules.
 *
 * Mixed into ObjectEditor.prototype (see ../editor.js), so `this` is the editor.
 */
export const scriptSectionMethods = {
  _behaviorSection(entity) {
    const code = entity.behavior || '';
    const hint = [
      'Runs every frame in Play mode. No "this." needed, e.g.',
      '  entity.rotation.y += delta * 2',
      '  if (pressed("KeyE") && distanceTo("Door") < 3) act("rotate", { y: 90, seconds: 1 })',
      '  if (touching("group:Coins").length) vars.change("score", 1)',
      'Everything you can use: ? below',
    ].join('\n');
    const help = SCRIPT_API.map(([name, what]) => `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(what)}</td></tr>`).join('');
    return `
      <h4 class="insp-h">Behavior</h4>
      <textarea id="insp-behavior" spellcheck="false" rows="5"
        style="width:100%;background:#0d1117;border:1px solid var(--border);border-radius:4px;color:var(--text);font:12px/1.4 ui-monospace,Consolas,monospace;padding:5px"
        placeholder="${escapeHtml(hint)}">${escapeHtml(code)}</textarea>
      <div class="insp-row">
        <button class="tbtn" id="insp-behavior-apply">Apply</button>
        <button class="tbtn danger" id="insp-behavior-clear">Clear</button>
        <button class="tbtn" id="insp-behavior-help" title="Everything a script can use">?</button>
      </div>
      <div id="insp-behavior-error" class="gp-warn" hidden></div>
      <div id="insp-behavior-api" hidden><table class="script-api">${help}</table>
        <div class="gp-legend">act(type, props) runs any rule action: its type and fields as in the Rules list (rotate, scale, move, destroy, showMessage, saveGame…).
          For code editors: types/tiny3-script.d.ts.</div></div>`;
  },

  _wireBehaviorSection(entity) {
    const q = (s) => this._q(s);
    const ta = q('#insp-behavior');
    let before = entity.behavior || '';
    const apply = () => {
      const after = ta.value;
      this._recordValue(entity, 'behavior', before, after, (v) => {
        entity.behavior = v || null;
        ta.value = v || '';
      }, 'behavior');
      entity.behavior = after || null;
      before = after;
      this.clearScriptError?.(entity);
      const errBox = q('#insp-behavior-error');
      if (errBox) errBox.hidden = true;
      const compiled = this.engine.addBehavior(entity, after);
      if (after.trim() && !compiled && errBox) {
        errBox.hidden = false;
        errBox.textContent = '⚠ It has a mistake and can\'t run: see the browser console (F12) for where.';
      }
    };
    q('#insp-behavior-apply').addEventListener('click', apply);
    q('#insp-behavior-help')?.addEventListener('click', () => {
      const box = q('#insp-behavior-api');
      if (box) box.hidden = !box.hidden;
    });
    // it stopped last Play: said here, until it is applied again
    const err = this.scriptErrorFor?.(entity);
    const errEl = q('#insp-behavior-error');
    if (err && errEl) {
      errEl.hidden = false;
      errEl.textContent = `⚠ It stopped: ${err}`;
    }
    q('#insp-behavior-clear').addEventListener('click', () => {
      this._recordValue(entity, 'behavior', before, '', (v) => {
        entity.behavior = v || null;
        ta.value = v || '';
      }, 'behavior');
      entity.behavior = null;
      before = '';
      this.engine.removeBehavior(entity);
    });
  },
};
