// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { conditionsHtml, wireConditions } from '../src/inspector-gameplay.js';

// The Only if / If rows: every field its own id, so each is wired to what it changes.

describe('condition rows', () => {
  const list = [
    { type: 'variable', name: 'ammo', op: '>=', value: 1 },
    { type: 'variable', name: 'lives', op: '<', value: 3, join: 'and' },
  ];
  const draw = () => {
    const root = document.createElement('div');
    root.innerHTML = conditionsHtml('ctl-0-if', list, null, { tag: 'ONLY IF' });
    document.body.appendChild(root);
    const holder = { if: JSON.parse(JSON.stringify(list)) };
    const labels = [];
    wireConditions(root, 'ctl-0-if', list, (label, fn) => { labels.push(label); fn(holder); });
    return { root, holder, labels };
  };

  it('no two fields share an id (a variable condition\'s compare used to share the IF / AND picker\'s)', () => {
    const { root } = draw();
    const ids = [...root.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the compare picker changes the compare; the IF / AND picker its join and not', () => {
    const { root, holder } = draw();
    const compare = root.querySelector('#ctl-0-if-0-op');
    compare.value = '>';
    compare.dispatchEvent(new Event('change'));
    expect(holder.if[0].op).toBe('>');
    const join = root.querySelector('#ctl-0-if-1-join');
    join.value = 'or not';
    join.dispatchEvent(new Event('change'));
    expect(holder.if[1]).toMatchObject({ join: 'or', not: true, op: '<' }); // its compare untouched
    const first = root.querySelector('#ctl-0-if-0-join');
    first.value = 'not';
    first.dispatchEvent(new Event('change'));
    expect(holder.if[0]).toMatchObject({ not: true, op: '>' });
  });
});
