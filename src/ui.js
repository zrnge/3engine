/**
 * makeDraggable — move a fixed-position .panel by dragging its header (h3).
 *
 *   makeDraggable(document.getElementById('hierarchy'));
 *
 * Behavior:
 *   - pointerdown on the panel's <h3> starts a drag; pointerup ends it
 *   - the panel's inline top/left/right/bottom/transform are rewritten so the
 *     panel stays where you drop it (position:fixed + left/top)
 *   - the panel is clamped to the viewport so it can't be lost off-screen
 *   - the grabbed header gets a "grabbing" cursor while dragging
 */
export function makeDraggable(panel, handleSelector = 'h3') {
  const handle = panel.querySelector(handleSelector) || panel;
  handle.style.cursor = 'grab';

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const rect = panel.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;

    // freeze current visual position as fixed left/top (drops right/bottom/transform)
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.transform = 'none';

    handle.style.cursor = 'grabbing';
    handle.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const x = Math.max(0, Math.min(ev.clientX - dx, window.innerWidth - rect.width));
      const y = Math.max(0, Math.min(ev.clientY - dy, window.innerHeight - rect.height));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    };
    const onUp = () => {
      handle.style.cursor = 'grab';
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}
