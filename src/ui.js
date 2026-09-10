/**
 * makeDraggable — move a fixed-position .panel by dragging its header (h3).
 *
 *   makeDraggable(document.getElementById('hierarchy'));
 *
 * Behavior:
 *   - pointerdown on the panel's <h3> starts a drag; pointerup ends it
 *   - a click (press+release without moving) is NOT swallowed, so buttons and
 *     sliders inside the panel keep working — the drag only begins after the
 *     pointer has moved a few pixels
 *   - the panel's inline top/left/right/bottom/transform are rewritten so the
 *     panel stays where you drop it (position:fixed + left/top)
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
      if (dragging) handle.style.cursor = 'grab';
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
