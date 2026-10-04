/**
 * Escape text before it goes into an innerHTML template. Object names, prefab
 * names and rule fields are all user-typed and land in both element bodies and
 * attribute values, so an unescaped quote or angle bracket corrupts the panel.
 *
 * Lives here rather than in editor.js so the inspector modules can use it
 * without importing editor.js back (which would be a cycle).
 */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A short message above the status bar, with buttons for what to do about it —
 * where an alert() would stop everything for something that is only a choice.
 *
 *   showNotice('duck.glb is 180 m long.', {
 *     actions: [{ label: 'Made in centimetres', run: () => … }, { label: 'Keep' }],
 *     kind: 'warn', seconds: 20,
 *   });
 *
 * Any button closes it; so does waiting `seconds` (0 = stays). Returns a
 * function that closes it. Without the #notices element it only logs.
 */
export function showNotice(text, { actions = [], kind = 'info', seconds = 8 } = {}) {
  const host = typeof document !== 'undefined' ? document.getElementById('notices') : null;
  if (!host) {
    console.log('[Tiny3]', text);
    return () => {};
  }
  const el = document.createElement('div');
  el.className = `notice ${kind}`;
  el.innerHTML = `<div class="notice-text">${escapeHtml(text)}</div>`;
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'notice-actions';
    actions.forEach((a, i) => {
      const b = document.createElement('button');
      b.className = `tbtn${i === 0 && actions.length > 1 ? ' primary' : ''}`;
      b.textContent = a.label;
      b.addEventListener('click', () => { close(); a.run?.(); });
      row.appendChild(b);
    });
    el.appendChild(row);
  }
  // the newest on top, and never a wall of them
  host.prepend(el);
  while (host.children.length > 3) host.lastElementChild.remove();
  if (seconds > 0) timer = setTimeout(close, seconds * 1000);
  return close;
}

/** True for a panel sitting in a dock column (as opposed to floating free). */
const isDocked = (panel) =>
  !!panel.parentElement?.classList.contains('dock') && !panel.classList.contains('floating');

/**
 * makeDraggable — move a .panel by dragging its header (h3).
 *
 *   makeDraggable(document.getElementById('hierarchy'));
 *
 * Behavior:
 *   - pointerdown on the panel's <h3> starts a drag; pointerup ends it
 *   - a click (press+release without moving) is NOT swallowed, so buttons and
 *     sliders inside the panel keep working — the drag only begins after the
 *     pointer has moved a few pixels
 *   - a docked panel is lifted out of its dock into a floating window
 *   - the panel is clamped to the viewport so it can't be lost off-screen
 *   - the grabbed header gets a "grabbing" cursor while dragging
 */
export function makeDraggable(panel, handleSelector = 'h3') {
  const handle = panel.querySelector(handleSelector) || panel;
  // a whole-panel handle would swallow every click inside the panel — skip it
  if (handle === panel) return;
  handle.style.cursor = 'grab';

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;

    const rect = panel.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    let dragging = false;

    // capture the pointer immediately on the handle so drag continues even if
    // the cursor leaves the header or the panel
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}

    const onMove = (ev) => {
      if (!dragging) {
        // only start the drag (and take over the gesture) after real movement
        if (Math.abs(ev.clientX - e.clientX) < 4 && Math.abs(ev.clientY - e.clientY) < 4) return;
        dragging = true;
        if (isDocked(panel)) {
          // lift it out of the dock into a floating window at the same spot
          panel.classList.add('floating');
          panel.style.width = `${rect.width}px`;
        }
        // freeze current visual position as fixed left/top (drops right/bottom/transform)
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.transform = 'none';
        handle.style.cursor = 'grabbing';
      }
      const x = Math.max(0, Math.min(ev.clientX - dx, window.innerWidth - rect.width));
      const y = Math.max(0, Math.min(ev.clientY - dy, window.innerHeight - rect.height));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    };
    const onUp = () => {
      if (dragging) {
        handle.style.cursor = 'grab';
        // the click that follows a drag must not also collapse the panel
        panel.dataset.justDragged = '1';
        setTimeout(() => { delete panel.dataset.justDragged; }, 0);
      }
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });
}

/**
 * makeResizable — drag the panel's .resize-handle to resize it. A docked panel
 * only changes height (its width belongs to the dock); a floating one changes
 * both.
 */
export function makeResizable(panel, options = {}) {
  const handle = panel.querySelector('.resize-handle');
  if (!handle) return;

  const minW = options.minWidth || 160;
  const minH = options.minHeight || 120;
  const maxW = options.maxWidth || window.innerWidth * 0.8;
  const maxH = options.maxHeight || window.innerHeight * 0.8;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const docked = isDocked(panel);
    const rect = panel.getBoundingClientRect();
    if (!docked) {
      // convert any right/bottom positioning to fixed left/top so resizing works predictably
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.transform = 'none';
    }

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;

    try { handle.setPointerCapture(e.pointerId); } catch (_) {}

    const onMove = (ev) => {
      if (!docked) {
        panel.style.width = `${Math.max(minW, Math.min(startW + (ev.clientX - startX), maxW))}px`;
      }
      panel.style.height = `${Math.max(minH, Math.min(startH + (ev.clientY - startY), maxH))}px`;
      panel.style.maxHeight = 'none';
      panel.style.overflowY = 'auto';
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });
}

/**
 * makeDockPanel — a panel in a dock column:
 *   - click the header to collapse / expand it (remembered between visits;
 *     panels marked data-collapsed="true" start collapsed)
 *   - drag the header to float it (see makeDraggable)
 *   - double-click a floating panel's header to put it back in its dock
 */
export function makeDockPanel(panel, { storageKey = 'tiny3.panels' } = {}) {
  const header = panel.querySelector('h3');
  if (!header || !panel.id) return;

  const read = () => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch (_) { return {}; }
  };
  const write = (state) => {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch (_) {}
  };

  const setCollapsed = (collapsed, remember = true) => {
    panel.classList.toggle('collapsed', collapsed);
    header.setAttribute('aria-expanded', String(!collapsed));
    if (remember) write({ ...read(), [panel.id]: collapsed });
  };
  const toggle = () => setCollapsed(!panel.classList.contains('collapsed'));

  setCollapsed(read()[panel.id] ?? panel.dataset.collapsed === 'true', false);

  header.setAttribute('role', 'button');
  header.tabIndex = 0;
  header.title = 'Click to collapse or expand · drag to float · double-click a floating panel to dock it';

  header.addEventListener('click', () => {
    if (panel.dataset.justDragged) return; // the end of a drag is not a click
    toggle();
  });
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); toggle(); }
  });
  header.addEventListener('dblclick', () => {
    if (!panel.classList.contains('floating')) return;
    panel.classList.remove('floating');
    for (const prop of ['left', 'top', 'right', 'bottom', 'transform', 'width', 'height', 'maxHeight']) {
      panel.style[prop] = '';
    }
  });
}
