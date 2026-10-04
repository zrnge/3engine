import { describe, it, expect } from 'vitest';
import { run, valueOf, formatText, truthy, problemIn, varScope, asText, ExprError } from '../src/expr.js';
import { VariableStore } from '../src/variables.js';

// Expressions: values worked out from the game's variables — safely, no eval.

const vars = new VariableStore({
  score: 7, name: 'Ada', coins: 12, inventory: ['sword', 'potion'], quest: { stage: 2, title: 'The Key' }, dead: false,
});
const s = varScope(vars);
const x = (src) => run(src, s);

describe('expressions', () => {
  it('arithmetic, precedence, parentheses, unary minus', () => {
    expect(x('score * 2 + 1')).toBe(15);
    expect(x('(score + 3) * 2')).toBe(20);
    expect(x('-score + 10 % 4')).toBe(-5);
    expect(x('10 / 0')).toBe(0); // never Infinity in a game value
  });

  it('text joins with +; comparisons; and / or / not; ? :', () => {
    expect(x('"Hi " + name + "!"')).toBe('Hi Ada!');
    expect(x("'coins: ' + coins")).toBe('coins: 12');
    expect(x('coins >= 10 and not dead')).toBe(true);
    expect(x('coins < 10 || score == 7')).toBe(true);
    expect(x('score > 5 ? "high" : "low"')).toBe('high');
    expect(x('name == "Ada"')).toBe(true);
    expect(x('score = 7')).toBe(true); // a lone = reads as "is"
  });

  it('lists and records: index, field, len, contains, literals', () => {
    expect(x('inventory[0]')).toBe('sword');
    expect(x('inventory[-1]')).toBe('potion');
    expect(x('len(inventory)')).toBe(2);
    expect(x('contains(inventory, "potion")')).toBe(true);
    expect(x('quest.stage + 1')).toBe(3);
    expect(x('quest["title"]')).toBe('The Key');
    expect(x('inventory + ["key"]')).toEqual(['sword', 'potion', 'key']);
    expect(x('{stage: quest.stage + 1, done: false}')).toEqual({ stage: 3, done: false });
    expect(x('join(inventory, " & ")')).toBe('sword & potion');
    expect(x('has(quest, "stage") and not has(quest, "reward")')).toBe(true);
  });

  it('functions; an unknown name is 0; an unknown function says so', () => {
    expect(x('max(score, coins) - min(1, 2)')).toBe(11);
    expect(x('clamp(score * 10, 0, 50)')).toBe(50);
    expect(x('round(2.345, 2)')).toBe(2.35);
    expect(x('nothingHere + 1')).toBe(1);
    expect(() => x('explode(1)')).toThrow(ExprError);
    const r = x('randint(1, 6)');
    expect(r >= 1 && r <= 6 && Number.isInteger(r)).toBe(true);
  });

  it('what is wrong is said, not thrown at the game', () => {
    expect(problemIn('score +')).toMatch(/missing/);
    expect(problemIn('"open')).toMatch(/quote/);
    expect(problemIn('(score')).toMatch(/expected "\)"/);
    expect(problemIn('score * 2')).toBe(null);
  });

  it('cannot reach outside the game: no globals, no properties of JavaScript itself', () => {
    expect(x('constructor')).toBe(0); // a variable name, not Object's
    expect(x('quest.constructor')).toBe(undefined);
    expect(() => x('window.alert(1)')).toThrow(ExprError);
    expect(x('inventory.length')).toBe(undefined); // fields of records only: len() for a list
  });

  it('a field\'s value as it reads: number, true/false, list, text, {interpolated}, =expression', () => {
    expect(valueOf('5', s)).toBe(5);
    expect(valueOf('-2.5', s)).toBe(-2.5);
    expect(valueOf('true', s)).toBe(true);
    expect(valueOf('[1, "a"]', s)).toEqual([1, 'a']);
    expect(valueOf('Hello', s)).toBe('Hello');
    expect(valueOf('Coins: {coins}', s)).toBe('Coins: 12');
    expect(valueOf('=coins * 2', s)).toBe(24);
    expect(valueOf(3, s)).toBe(3); // a number saved before
    expect(formatText('{name} has {len(inventory)} things: {inventory}', s)).toBe('Ada has 2 things: sword, potion');
    expect(formatText('{broken +} stays', s)).toBe('{broken +} stays');
  });

  it('truth and text of values', () => {
    expect([0, '', [], {}, false, '0'].map(truthy)).toEqual([false, false, false, false, false, false]);
    expect([1, 'a', [0], { a: 1 }, true].map(truthy)).toEqual([true, true, true, true, true]);
    expect(asText(2.50000001)).toBe('2.5');
    expect(asText({ stage: 2 })).toBe('stage: 2');
  });
});
