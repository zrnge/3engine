import { describe, it, expect } from 'vitest';
import { countScripts } from '../src/script-trust.js';

// A game opened from a file: how many scripts it brings (they stay off until allowed).

describe('scripts in an opened game', () => {
  it('counts them in every level and in its prefabs — none in a game without', () => {
    const game = {
      type: 'tiny3-project',
      shared: { prefabs: { Bomb: { behavior: 'api.message("boom")' } } },
      levels: [
        { scene: { entities: [{ name: 'A', behavior: 'x()' }, { name: 'B' }, { name: 'C', behavior: '   ' }], prefabs: { Coin: { behavior: 'y()' } } } },
        { scene: { entities: [{ name: 'D', behavior: 'z()' }] } },
      ],
    };
    expect(countScripts(game)).toBe(4);
    expect(countScripts({ levels: [{ scene: { entities: [{ name: 'A' }] } }] })).toBe(0);
    expect(countScripts({ entities: [{ behavior: 'old()' }] })).toBe(1); // a scene from before levels
    expect(countScripts(null)).toBe(0);
  });
});
