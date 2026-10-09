/**
 * Pairing a revision's cuts with its additions.
 *
 * What has to hold: a card is replaced by one doing the same job when there is
 * one, regardless of the order the lists arrive in; lands never pair with
 * spells; quantities are conserved; and the reason given is true of the pair.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { pairSwaps } from '../src/services/revisionSwaps.js';
import { resolveTheme } from '../src/services/deckGeneratorService.js';

const card = (name, props = {}) => ({
  name,
  type_line: 'Instant',
  oracle_text: '',
  cmc: 2,
  color_identity: 'B',
  subtypes: '',
  ...props,
});
const one = (c, quantity = 1) => ({ card: c, quantity });

const murder = card('Murder', { oracle_text: 'Destroy target creature.', cmc: 3 });
const fatalPush = card('Fatal Push', { oracle_text: 'Destroy target creature if it has mana value 2 or less.', cmc: 1 });
const divination = card('Divination', { type_line: 'Sorcery', oracle_text: 'Draw two cards.', cmc: 3 });
const thoughtScour = card('Thought Scour', { oracle_text: 'Target player mills two cards. Draw a card.', cmc: 1 });
const bear = card('Grizzly Bears', { type_line: 'Creature — Bear', cmc: 2 });
const dualLand = card('Watery Grave', { type_line: 'Land — Island Swamp', cmc: 0, oracle_text: '{T}: Add {U} or {B}.' });
const otherLand = card('Darkslick Shores', { type_line: 'Land', cmc: 0, oracle_text: '{T}: Add {U} or {B}.' });

describe('pairSwaps', () => {
  test('pairs each cut with the addition doing the same job, whatever the order', () => {
    const { swaps } = pairSwaps(
      [one(divination), one(murder)],
      [one(fatalPush), one(thoughtScour)]
    );
    const pairs = Object.fromEntries(swaps.map((s) => [s.cut.name, s.add.name]));
    assert.equal(pairs.Murder, 'Fatal Push');
    assert.equal(pairs.Divination, 'Thought Scour');
  });

  test('says why, and only what is true of the pair', () => {
    const { swaps } = pairSwaps([one(murder)], [one(fatalPush)]);
    assert.deepEqual(swaps[0].why, ['both spot removal', '2 cheaper']);
  });

  test('names the theme the new card serves and the old one does not', () => {
    const graveyard = resolveTheme('graveyard', []);
    const { swaps } = pairSwaps([one(divination)], [one(thoughtScour)], [graveyard]);
    assert.ok(swaps[0].why.includes('Thought Scour is part of graveyard value; Divination is not'));
  });

  test('a card that does nothing the build counts is said to', () => {
    const { swaps } = pairSwaps([one(bear)], [one(card('Gurmag Angler', { type_line: 'Creature — Zombie Fish', oracle_text: 'Delve', cmc: 7 }))]);
    assert.match(swaps[0].why[0], /Grizzly Bears fills none of the roles or themes/);
  });

  test('lands only pair with lands', () => {
    const { swaps, cut, added } = pairSwaps([one(dualLand), one(murder)], [one(otherLand), one(divination)]);
    const landSwap = swaps.find((s) => s.cut.name === 'Watery Grave');
    assert.equal(landSwap.add.name, 'Darkslick Shores');
    assert.equal(cut.length + added.length, 0);
  });

  test('quantities are conserved, and what cannot pair is left over', () => {
    const { swaps, cut, added } = pairSwaps([one(murder, 4)], [one(fatalPush, 3), one(otherLand, 1)]);
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0].quantity, 3);
    assert.deepEqual(cut.map((c) => [c.name, c.quantity]), [['Murder', 1]]);
    assert.deepEqual(added.map((c) => [c.name, c.quantity]), [['Darkslick Shores', 1]]);
  });
});
