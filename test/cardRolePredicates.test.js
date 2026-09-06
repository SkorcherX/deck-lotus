/**
 * The role predicates the deck generator fills its slots from.
 *
 * Board wipes have their own file; these are ramp, draw and removal. Nearly
 * every case here is a real card that broke a version of the predicate, and
 * the grouping is by the mistake rather than by the role, because the mistakes
 * are what the tests are for.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isRamp, isCardAdvantage, isSelection, isCreatureRemoval, isPermanentRemoval, effectText,
} from '../src/services/cardRoleService.js';

const card = (name, oracle_text, type_line = 'Sorcery', cmc = 2) =>
  ({ name, oracle_text, type_line, cmc });

const draws = (c) => isCardAdvantage(c) || isSelection(c);
const removes = (c) => isCreatureRemoval(c) || isPermanentRemoval(c);

describe('reminder text is not what a card does', () => {
  test('it is stripped before anything reads the text', () => {
    const cycler = card('Blasted Landscape', '{T}: Add {C}. Cycling {2} ({2}, Discard this card: Draw a card.)');
    assert.ok(!effectText(cycler).includes('draw a card'));
  });

  test('a cycling land is not a card-selection spell', () => {
    // "(Discard this card: Draw a card.)" is the definition of cycling, not
    // something this card does for a deck. 202 cards matched on this alone.
    const land = card('Drifting Meadow',
      'This land enters tapped. {T}: Add {W}. Cycling {2} ({2}, Discard this card: Draw a card.)',
      'Land');
    assert.equal(isSelection(land), false);
  });

  test('a spell with cycling stapled on is judged by its own text', () => {
    const pump = card('Startling Development',
      'Until end of turn, target creature becomes a blue Serpent with base power and toughness '
      + '4/4. Cycling {1} ({1}, Discard this card: Draw a card.)', 'Instant');
    assert.equal(isSelection(pump), false);
  });

  test('basic landcycling is not ramp', () => {
    // It searches a land to hand: a card and a turn spent to accelerate
    // nothing. 129 cards matched isRamp on this reminder alone.
    const lifegain = card('Sylvan Bounty',
      'Target player gains 8 life. Basic landcycling {1}{G} ({1}{G}, Discard this card: Search '
      + 'your library for a basic land card, reveal it, put it into your hand, then shuffle.)');
    assert.equal(isRamp(lifegain), false);
  });
});

describe('isRamp', () => {
  const ramp = [
    card('Sol Ring', '{T}: Add {C}{C}.', 'Artifact'),
    // Says "add one mana of any color" and never prints a symbol.
    card('Arcane Signet', "{T}: Add one mana of any color in your commander's color identity.", 'Artifact'),
    card('Birds of Paradise', 'Flying {T}: Add one mana of any color.', 'Creature — Bird'),
    card('Cultivate',
      'Search your library for up to two basic land cards, reveal those cards, put one onto the '
      + 'battlefield tapped and the other into your hand, then shuffle.'),
    // Names a land type rather than the word "land".
    card('Three Visits', 'Search your library for a Forest card, put it onto the battlefield tapped, then shuffle.'),
    card('Farseek',
      'Search your library for a Plains, Island, Swamp, or Mountain card, put it onto the '
      + 'battlefield tapped, then shuffle.'),
    card('Azusa, Lost but Seeking', 'You may play two additional lands on each of your turns.',
      'Legendary Creature — Human Monk'),
    card('Dark Ritual', 'Add {B}{B}{B}.', 'Instant'),
  ];
  for (const c of ramp) test(c.name, () => assert.equal(isRamp(c), true));

  test('mana that cannot cast the deck is not acceleration', () => {
    const restricted = card('Renowned Weaponsmith',
      '{T}: Add {C}{C}. Spend this mana only to cast artifact spells or activate abilities of '
      + 'artifacts.', 'Creature — Human Artificer');
    assert.equal(isRamp(restricted), false);
  });

  test('Treasure makers are left out rather than guessed at', () => {
    // Both of these tap for mana eventually, and telling the mana source apart
    // from the creature that sometimes makes one needs to know which clause a
    // trigger governs — which sentence splitting gets wrong most of the time.
    // Neither counts, and the ramp bucket has ~1,300 other candidates.
    const conditional = { name: 'Hoarding Ogre', type_line: 'Creature — Ogre', cmc: 3,
      oracle_text: 'Whenever this creature attacks, roll a d20. 1-9 | Create a Treasure token.' };
    const oneShot = { name: 'Junkyard Genius', type_line: 'Creature — Human Artificer', cmc: 4,
      oracle_text: 'When this creature enters, create a tapped Powerstone token.' };
    assert.equal(isRamp(conditional), false);
    assert.equal(isRamp(oneShot), false);
  });
});

describe('draw', () => {
  const drawers = [
    // "draws", not "draw" — the missing s lost this one entirely.
    card('Sign in Blood', 'Target player draws two cards and loses 2 life.'),
    card('Divination', 'Draw two cards.'),
    // The trigger is an opponent's spell, not yours.
    card('Rhystic Study',
      'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.',
      'Enchantment'),
    // A hundred characters of condition sit between the trigger and the draw,
    // which is why the window between them has to be generous. Verbatim oracle
    // text: paraphrasing it here made the gap longer than any real card's and
    // sent me tuning the predicate to fit a card that does not exist.
    card('Guardian Project',
      "Whenever a nontoken creature you control enters, if it doesn't have the same name as "
      + 'another creature you control or a creature card in your graveyard, draw a card.',
      'Enchantment'),
    card('Phyrexian Arena',
      'At the beginning of your upkeep, you draw a card and you lose 1 life.', 'Enchantment'),
    card('Brainstorm', 'Draw three cards, then put two cards from your hand on top of your library in any order.', 'Instant'),
  ];
  for (const c of drawers) test(c.name, () => assert.equal(draws(c), true));

  test('a trigger an opponent controls is not an engine', () => {
    // "Whenever this creature becomes blocked" fires when somebody else
    // decides it does. The old arm accepted any trigger near the word draw.
    const conditional = card('Chambered Nautilus',
      'Whenever this creature becomes blocked, you may draw a card.', 'Creature — Nautilus');
    assert.equal(isCardAdvantage(conditional), false);
  });

  test('drawing to refill after discarding your hand is not advantage', () => {
    const wheel = card('Wheel of Misfortune', 'Each player discards their hand, then draws seven cards.');
    assert.equal(isCardAdvantage(wheel), false);
  });
});

describe('removal', () => {
  const removalCards = [
    card('Murder', 'Destroy target creature.', 'Instant'),
    card('Swords to Plowshares', 'Exile target creature. Its controller gains life equal to its power.', 'Instant'),
    card('Beast Within',
      'Destroy target permanent. Its controller creates a 3/3 green Beast creature token.', 'Instant'),
    // Tucking answers what it cannot destroy.
    card('Chaos Warp',
      "The owner of target permanent shuffles it into their library, then reveals the top card of "
      + 'their library. If it is a permanent card, they put it onto the battlefield.', 'Instant'),
    card('Pongify',
      'Destroy target creature. It cannot be regenerated. That creature\'s controller creates a '
      + '3/3 green Ape creature token.', 'Instant'),
  ];
  for (const c of removalCards) test(c.name, () => assert.equal(removes(c), true));

  test('a combat trick that lowers no toughness is not removal', () => {
    const trick = card('Fleeting Distraction',
      'Target creature gets -1/-0 until end of turn. Draw a card.', 'Instant');
    assert.equal(isCreatureRemoval(trick), false);
  });

  test('but one that does is', () => {
    const slip = card('Tragic Slip',
      'Target creature gets -1/-1 until end of turn. Morbid — That creature gets -13/-13 until '
      + 'end of turn instead if a creature died this turn.', 'Instant');
    assert.equal(isCreatureRemoval(slip), true);
  });

  test('ramp and draw are not removal', () => {
    assert.equal(removes(card('Sol Ring', '{T}: Add {C}{C}.', 'Artifact')), false);
    assert.equal(removes(card('Divination', 'Draw two cards.')), false);
  });
});
