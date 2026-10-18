import { test, describe } from 'node:test';
import assert from 'node:assert';
import { selectBracketCombos, isGameDefining } from '../src/shared/comboFilter.js';

/**
 * Shapes copied from a live find-my-combos response (trimmed to the fields
 * read), so a change on Spellbook's side shows up here as a wrong count.
 */
const use = (name, zones = ['H']) => ({ card: { name }, zoneLocations: zones });
const feature = (name) => ({ feature: { name } });

const thoracle = {
  id: '1-2', uses: [use("Thassa's Oracle"), use('Demonic Consultation')],
  requires: [], produces: [feature('Exile your library'), feature('Win the game')],
  manaValueNeeded: 3, bracketTag: 'R',
};
const bond = {
  id: '3-4', uses: [use('Sanguine Bond', ['B']), use('Exquisite Blood', ['B'])],
  requires: [], produces: [feature('Infinite lifegain triggers'), feature('Infinite lifeloss'), feature('Infinite lifegain')],
  manaValueNeeded: 0, bracketTag: 'S',
};

describe('isGameDefining', () => {
  for (const f of ['Win the game', 'Each opponent loses the game', 'Infinite colorless mana',
    'Infinite colored mana', 'Infinite lifegain', 'Infinite card draw', 'Infinite draw',
    'Infinite creature tokens', 'Infinite damage to any target', 'Infinite lifeloss', 'Near-infinite lifeloss']) {
    test(`${f} counts`, () => assert.equal(isGameDefining(f), true));
  }
  for (const f of ['Infinite lifegain triggers', 'Infinite ETB', 'Infinite storm count',
    'Exile your library', 'Infinite sacrifice triggers', 'Infinite untap']) {
    test(`${f} does not`, () => assert.equal(isGameDefining(f), false));
  }
});

describe('selectBracketCombos', () => {
  test('keeps a two-card win and costs it from hand', () => {
    const [c] = selectBracketCombos([thoracle]);
    assert.deepEqual(c.cards, ['Demonic Consultation', "Thassa's Oracle"]);
    assert.deepEqual(c.produces, ['Win the game']);
    assert.equal(c.totalMana, 3);
  });

  test('battlefield pieces add their own mana value', () => {
    const cmc = new Map([['Sanguine Bond', 5], ['Exquisite Blood', 5]]);
    const [c] = selectBracketCombos([bond], cmc);
    assert.equal(c.totalMana, 10);
    assert.deepEqual(c.produces, ['Infinite lifeloss', 'Infinite lifegain']);
  });

  test('a piece that may start in hand or play is costed as from hand', () => {
    const v = { ...bond, uses: [use('Sanguine Bond', ['B', 'H']), use('Exquisite Blood', ['B'])] };
    assert.equal(selectBracketCombos([v], new Map([['Sanguine Bond', 5], ['Exquisite Blood', 5]]))[0].totalMana, 5);
  });

  test('three cards is not a two-card combo', () => {
    assert.deepEqual(selectBracketCombos([{ ...thoracle, uses: [...thoracle.uses, use('Third')] }]), []);
  });

  test('a template requirement makes it more than two pieces', () => {
    assert.deepEqual(selectBracketCombos([{ ...thoracle, requires: [{ template: { name: 'A sacrifice outlet' } }] }]), []);
  });

  test('a loop that does nothing decisive is dropped', () => {
    assert.deepEqual(selectBracketCombos([{ ...thoracle, produces: [feature('Infinite ETB'), feature('Infinite untap')] }]), []);
  });

  test('cheapest first', () => {
    const r = selectBracketCombos([bond, thoracle], new Map([['Sanguine Bond', 5], ['Exquisite Blood', 5]]));
    assert.deepEqual(r.map((c) => c.totalMana), [3, 10]);
  });
});
