/**
 * History — undo/redo command stack.
 *
 * A command is any object with `undo()` and `redo()` methods. Push it after
 * performing an action; History will call undo/redo as the user steps back
 * and forward. Adding a new command clears the redo branch.
 *
 *   const history = new History({ limit: 100 });
 *   history.push({ undo() {...}, redo() {...} });
 *   history.undo();  history.redo();
 */
export class History {
  constructor({ limit = 100, onChange = null } = {}) {
    this._undo = [];
    this._redo = [];
    this.limit = limit;
    this.onChange = onChange; // called whenever canUndo/canRedo may have changed
  }

  /** Record a command that has already been performed. */
  push(cmd) {
    this._undo.push(cmd);
    if (this._undo.length > this.limit) this._undo.shift();
    this._redo.length = 0; // new action invalidates the redo branch
    this.onChange?.();
  }

  undo() {
    const cmd = this._undo.pop();
    if (!cmd) return false;
    cmd.undo?.();
    this._redo.push(cmd);
    this.onChange?.();
    return true;
  }

  redo() {
    const cmd = this._redo.pop();
    if (!cmd) return false;
    cmd.redo?.();
    this._undo.push(cmd);
    this.onChange?.();
    return true;
  }

  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  clear() {
    this._undo.length = 0;
    this._redo.length = 0;
    this.onChange?.();
  }
}
