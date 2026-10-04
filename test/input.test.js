// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { Input, DRAG_THRESHOLD_PX, isTyping } from '../src/input.js';

describe('isTyping — shortcuts stand aside while a field takes text', () => {
  const make = (tag, type) => {
    const el = document.createElement(tag);
    if (type) el.type = type;
    document.body.appendChild(el);
    return el;
  };

  it('is true in text and number fields and text areas; not on sliders, boxes, colours or the page', () => {
    expect(isTyping(make('input', 'text'))).toBe(true);
    expect(isTyping(make('input', 'number'))).toBe(true);
    expect(isTyping(make('textarea'))).toBe(true);
    expect(isTyping(make('input', 'range'))).toBe(false);
    expect(isTyping(make('input', 'checkbox'))).toBe(false);
    expect(isTyping(make('input', 'color'))).toBe(false);
    expect(isTyping(make('button'))).toBe(false);
    expect(isTyping(document.body)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });

  it('looks at the focused element by default', () => {
    const field = make('input', 'number');
    field.focus();
    expect(isTyping()).toBe(true);
    field.blur();
    expect(isTyping()).toBe(false);
  });
});

describe('Input', () => {
  it('reports held keys by code through keyState, for behavior scripts', () => {
    const input = new Input();
    expect(input.keyState.KeyW).toBe(false);

    input._down.add('KeyW');
    expect(input.keyState.KeyW).toBe(true);
    expect(input.keyState.Space).toBe(false);
    expect('KeyW' in input.keyState).toBe(true);
  });

  it('edge-triggers wasPressed and clears it at the end of the frame', () => {
    const input = new Input();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));

    expect(input.isDown('Space')).toBe(true);
    expect(input.wasPressed('Space')).toBe(true);

    input.endFrame();
    expect(input.wasPressed('Space')).toBe(false);
    expect(input.isDown('Space')).toBe(true); // still held

    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
    expect(input.isDown('Space')).toBe(false);
  });

  it('does not re-trigger wasPressed while a key is held down', () => {
    const input = new Input();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
    input.endFrame();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' })); // auto-repeat
    expect(input.wasPressed('KeyA')).toBe(false);
  });

  it('releases everything when the window loses focus', () => {
    const input = new Input();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(input.isDown('KeyW')).toBe(true);

    window.dispatchEvent(new Event('blur'));
    expect(input.isDown('KeyW')).toBe(false);
    expect(input.keyState.KeyW).toBe(false);
  });

  it('clears wheel and pointer delta each frame', () => {
    const input = new Input();
    input.wheel = 120;
    input.pointerDelta.dx = 5;
    input.endFrame();
    expect(input.wheel).toBe(0);
    expect(input.pointerDelta.dx).toBe(0);
  });
});

describe('Input — click versus drag', () => {
  // Left-drag orbits the camera, so selection must only happen on a genuine
  // click. These flags are what the editor selects with.
  const send = (type, x, y, target = window) =>
    target.dispatchEvent(new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true }));

  it('a press released in place is a tap', () => {
    const input = new Input();
    send('mousedown', 50, 50);
    send('mouseup', 51, 50);
    expect(input.mouseTapped(0)).toBe(true);
    expect(input.mouseReleased(0)).toBe(true);
  });

  it(`travelling ${DRAG_THRESHOLD_PX}px makes it a drag, not a tap`, () => {
    const input = new Input();
    send('mousedown', 50, 50);
    send('mousemove', 50 + DRAG_THRESHOLD_PX, 50);
    send('mouseup', 50 + DRAG_THRESHOLD_PX, 50);
    expect(input.mouseTapped(0)).toBe(false);
    expect(input.mouseReleased(0)).toBe(true);
  });

  it('dragging away and back again is still a drag', () => {
    const input = new Input();
    send('mousedown', 50, 50);
    send('mousemove', 120, 50);
    send('mousemove', 50, 50);
    send('mouseup', 50, 50);
    expect(input.mouseTapped(0)).toBe(false);
  });

  it('a press that starts on a panel counts as neither', () => {
    const input = new Input();
    const panel = document.createElement('div');
    panel.className = 'panel';
    document.body.appendChild(panel);
    send('mousedown', 50, 50, panel);
    send('mouseup', 50, 50, panel);
    expect(input.mouseTapped(0)).toBe(false);
    expect(input.mouseReleased(0)).toBe(false);
    panel.remove();
  });

  it('tap and release last exactly one frame', () => {
    const input = new Input();
    send('mousedown', 50, 50);
    send('mouseup', 50, 50);
    input.endFrame();
    expect(input.mouseTapped(0)).toBe(false);
    expect(input.mouseReleased(0)).toBe(false);
  });
});
