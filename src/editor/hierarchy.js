import { escapeHtml } from '../ui.js';

/**
 * The Hierarchy panel: the object tree, parenting by drag and drop, names and icons.
 *
 * Mixed into ObjectEditor.prototype (see ../editor.js), so `this` is the editor.
 */
export const hierarchyMethods = {
  _renderHierarchy() {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    const roots = this.selectables.filter((e) => !e.parent);
    for (const root of roots) {
      this._renderHierarchyNode(root, 0);
    }
    this._renderLighting(); // lights added, removed or renamed
  },

  _renderHierarchyNode(entity, depth) {
    const li = document.createElement('li');
    li.style.paddingLeft = `${12 + depth * 16}px`;
    if (this.selectedSet.has(entity)) li.classList.add('selected');
    li.draggable = true;
    const kind = entity.object3D.userData.kind || entity.constructor.name;
    const hasChildren = entity.children.length > 0;
    const collapsed = hasChildren && this._collapsed.has(entity);
    const toggle = hasChildren
      ? `<span class="collapse" style="cursor:pointer;width:14px;text-align:center;display:inline-block">${collapsed ? '▶' : '▼'}</span>`
      : '<span style="width:14px;display:inline-block"></span>';
    li.innerHTML = `${toggle}<span class="ico">${this._icon(kind)}</span><span class="nm">${escapeHtml(this._name(entity))}</span>`;

    // click to select
    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('collapse')) {
        if (this._collapsed.has(entity)) this._collapsed.delete(entity);
        else this._collapsed.add(entity);
        this._renderHierarchy();
        return;
      }
      const additive = e.shiftKey;
      this.select(entity, { additive });
    });

    // drag to reparent
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(this.selectables.indexOf(entity)));
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const from = this.selectables[fromIdx];
      if (!from || from === entity) return;
      if (this._isDescendant(entity, from)) return; // can't parent to own child
      this._setParentWithHistory(from, entity);
    });

    this.listEl.appendChild(li);

    if (hasChildren && !collapsed) {
      for (const child of entity.children) {
        this._renderHierarchyNode(child, depth + 1);
      }
    }
  },

  _isDescendant(ancestor, entity) {
    let p = entity.parent;
    while (p) {
      if (p === ancestor) return true;
      p = p.parent;
    }
    return false;
  },

  _setParentWithHistory(child, newParent) {
    const oldParent = child.parent;
    if (oldParent === newParent) return;
    const self = this;
    const doSet = (parent) => {
      child.setParent(parent, self.engine);
      self._renderHierarchy();
      if (self.selected === child) self._renderInspector();
    };
    if (this.history) {
      this.history.push({
        label: 'reparent',
        undo() { doSet(oldParent); },
        redo() { doSet(newParent); },
      });
    }
    doSet(newParent);
  },

  _icon(kind) {
    switch (kind) {
      case 'Player': return '●';
      case 'Coin': return '◉';
      case 'Prop': return '■';
      case 'Light': return '☀';
      case 'Empty': return '◇';
      default: return '◆';
    }
  },

  _name(entity) {
    return entity.object3D.name || entity.constructor.name;
  },
};
