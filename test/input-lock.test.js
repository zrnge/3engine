// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { Input } from '../src/input.js';

describe('capturing the mouse for looking around', () => {
  it('captures it on the 3D view it was given', () => {
    const canvas = { requestPointerLock: vi.fn() };
    const input = new Input(canvas);
    expect(input.lockTarget).toBe(canvas);
    input.requestPointerLock();
    expect(canvas.requestPointerLock).toHaveBeenCalledOnce();
  });

  it('without a view, falls back to the page instead of silently doing nothing', () => {
    // REGRESSION: the engine made its Input with no element, so capture was
    // asked of `window` — which can't — and mouse look never worked in Play
    const input = new Input();
    expect(input.lockTarget).toBe(document.body);
  });
});
