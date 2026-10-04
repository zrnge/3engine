import { escapeHtml } from './ui.js';

/**
 * The Levels panel: one row per level.
 *
 *   ★ 1 [Forest       ] ↑ ↓ ⧉ ×
 *   ☆ 2 [Boss room    ] ↑ ↓ ⧉ ×
 *   + Add level
 *
 * Click a level to open it; click the open one's name to rename it. ★ marks
 * where the game starts.
 */

/** Keep the "level name" suggestions (a <datalist>) in step with the project. */
export function refreshLevelNames(project) {
  if (typeof document === 'undefined') return;
  let list = document.getElementById('t3-level-names');
  if (!list) {
    list = document.createElement('datalist');
    list.id = 't3-level-names';
    document.body.appendChild(list);
  }
  list.innerHTML = ['next', 'this', 'previous', 'first', ...project.names()]
    .map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
}

export function wireLevelsPanel({ project, listEl, addBtn, open, onChange = () => {} }) {
  let busy = false;
  const run = async (fn) => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (err) {
      console.error('[Tiny3] level change failed:', err);
      alert(`Could not change level: ${err.message}`);
    } finally {
      busy = false;
      render();
      onChange();
    }
  };

  function render() {
    const n = project.levels.length;
    listEl.innerHTML = project.levels.map((l, i) => `
      <li class="lvl-row${i === project.current ? ' current' : ''}" data-i="${i}">
        <button class="lvl-start${i === project.start ? ' on' : ''}" data-act="start"
          title="${i === project.start ? 'The game starts here' : 'Start the game here'}">${i === project.start ? '★' : '☆'}</button>
        <span class="lvl-num">${i + 1}</span>
        <input class="lvl-name" value="${escapeHtml(l.name)}" spellcheck="false"
          title="${i === project.current ? 'Being edited — type to rename' : 'Click to open'}" ${i === project.current ? '' : 'readonly'} />
        <button class="gp-x lvl-btn" data-act="up" title="Move earlier" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="gp-x lvl-btn" data-act="down" title="Move later" ${i === n - 1 ? 'disabled' : ''}>↓</button>
        <button class="gp-x lvl-btn" data-act="dup" title="Duplicate">⧉</button>
        <button class="gp-x lvl-btn" data-act="del" title="Delete level" ${n <= 1 ? 'disabled' : ''}>×</button>
      </li>`).join('');
    refreshLevelNames(project);

    listEl.querySelectorAll('.lvl-row').forEach((row) => {
      const i = Number(row.dataset.i);
      const name = row.querySelector('.lvl-name');
      // clicking another level opens it
      name.addEventListener('pointerdown', () => {
        if (i !== project.current) run(() => open(i));
      });
      name.addEventListener('change', () => {
        name.value = project.rename(i, name.value);
        refreshLevelNames(project);
        onChange();
      });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
      row.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => {
        switch (btn.dataset.act) {
          case 'start': run(() => project.setStart(i)); break;
          case 'up': run(() => project.move(i, -1)); break;
          case 'down': run(() => project.move(i, 1)); break;
          case 'dup': run(() => project.duplicate(i)); break;
          case 'del':
            if (confirm(`Delete "${project.levels[i].name}" and everything in it? This can't be undone.`)) {
              run(() => project.remove(i));
            }
            break;
          default:
        }
      }));
    });
  }

  addBtn?.addEventListener('click', () => run(async () => {
    const i = project.add();
    await open(i);
  }));

  render();
  return { render };
}
