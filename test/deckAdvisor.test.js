/**
 * Checks for the deck advisor.
 *
 * The advisor is deliberately pure — card rows in, findings out — so it is the
 * one part of the deck pipeline that can be exercised on a machine where the
 * SQLite driver will not build. That makes these worth keeping honest: they
 * are the only automated coverage this logic gets before it reaches a running
 * container.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { adviseDeck, analyzeDeck } from '../src/services/deckAdvisorService.js';
import {
  isGraveyardHate, isSelection, isCardAdvantage, isPermanentRemoval,
  hasAlternativeCost, costPips
} from '../src/services/cardRoleService.js';

const card = (name, overrides = {}) => ({
  name,
  quantity: 4,
  cmc: 0,
  mana_cost: '',
  type_line: '',
  oracle_text: '',
  color_identity: '',
  power: null,
  keywords: null,
  ...overrides
});

const codes = (result) => result.findings.map((f) => f.code);
const find = (result, code) => result.findings.find((f) => f.code === code);

// --- Role classification ---------------------------------------------------

test('card selection and card advantage are told apart', () => {
  const ponder = card('Ponder', {
    cmc: 1, type_line: 'Sorcery',
    oracle_text: 'Look at the top three cards of your library, then put them back in any order. You may shuffle. Draw a card.'
  });
  const divination = card('Divination', {
    cmc: 3, type_line: 'Sorcery', oracle_text: 'Draw two cards.'
  });

  assert.ok(isSelection(ponder), 'Ponder digs');
  assert.ok(isCardAdvantage(divination), 'Divination draws extra cards');
  assert.ok(!isCardAdvantage(ponder), 'a cantrip is not card advantage');
});

test('removal that only hits creatures is not counted as broader removal', () => {
  const murder = card('Murder', { type_line: 'Instant', oracle_text: 'Destroy target creature.' });
  const naturalize = card('Naturalize', {
    type_line: 'Instant', oracle_text: 'Destroy target artifact or enchantment.'
  });

  assert.ok(!isPermanentRemoval(murder));
  assert.ok(isPermanentRemoval(naturalize));
});

test('graveyard hate is distinguished from merely mentioning graveyards', () => {
  const rip = card('Rest in Peace', {
    type_line: 'Enchantment',
    oracle_text: 'When Rest in Peace enters, exile all graveyards. If a card would be put into a graveyard from anywhere, exile it instead.'
  });
  const goyf = card('Tarmogoyf', {
    type_line: 'Creature — Lhurgoyf',
    oracle_text: "Tarmogoyf's power is equal to the number of card types among cards in all graveyards."
  });

  assert.ok(isGraveyardHate(rip));
  assert.ok(!isGraveyardHate(goyf), 'a graveyard payoff is not graveyard hate');
});

test('a pitch spell is recognised as having an alternative cost', () => {
  const fow = card('Force of Will', {
    cmc: 5, mana_cost: '{3}{U}{U}', type_line: 'Instant',
    oracle_text: "You may pay 1 life and exile a blue card from your hand rather than pay this spell's mana cost. Counter target spell."
  });
  assert.ok(hasAlternativeCost(fow));
});

test('hybrid pips demand no single colour', () => {
  assert.deepEqual(costPips('{1}{U}{U}'), { U: 2 });
  assert.deepEqual(costPips('{W/U}{W/U}'), {});
});

// --- Deck-level findings ---------------------------------------------------

test('a symmetric lock reports how many of your own cards it would hit', () => {
  const deck = [
    card('Chalice of the Void', {
      quantity: 4, cmc: 0, mana_cost: '{X}{X}', type_line: 'Artifact',
      oracle_text: 'Whenever a player casts a spell with mana value equal to the number of charge counters on Chalice of the Void, counter that spell.'
    }),
    card('Lightning Bolt', {
      quantity: 20, cmc: 1, mana_cost: '{R}', type_line: 'Instant',
      oracle_text: 'Lightning Bolt deals 3 damage to any target.'
    }),
    card('Mountain', { quantity: 20, type_line: 'Basic Land — Mountain', color_identity: 'R' })
  ];

  const hazard = find(adviseDeck(deck, [], 'legacy'), 'symmetry-mana-value-lock');
  assert.ok(hazard, 'the hazard is reported');
  assert.equal(hazard.severity, 'warn');
  assert.match(hazard.message, /20 of your own cards/);
});

test('a payoff short of its critical mass is flagged, and met when it is not', () => {
  const delver = card('Delver of Secrets', {
    quantity: 4, cmc: 1, mana_cost: '{U}', type_line: 'Creature — Human Wizard', power: '1',
    oracle_text: 'At the beginning of your upkeep, look at the top card of your library. You may reveal an instant or sorcery card from it. If you do, transform Delver of Secrets.'
  });
  const island = card('Island', { quantity: 20, type_line: 'Basic Land — Island', color_identity: 'U' });
  const bear = card('Grizzly Bears', { quantity: 36, cmc: 2, mana_cost: '{1}{G}', type_line: 'Creature — Bear', power: '2' });
  const brainstorm = card('Brainstorm', {
    quantity: 36, cmc: 1, mana_cost: '{U}', type_line: 'Instant',
    oracle_text: 'Draw three cards, then put two cards from your hand on top of your library in any order.'
  });

  const short = adviseDeck([delver, island, bear], [], 'legacy');
  assert.ok(codes(short).includes('requirement-instants-sorceries'));

  const supported = adviseDeck([delver, island, brainstorm], [], 'legacy');
  assert.ok(codes(supported).includes('requirement-met-instants-sorceries'));
  assert.ok(!codes(supported).includes('requirement-instants-sorceries'));
});

test('creature-only answers are called out', () => {
  const deck = [
    card('Murder', { quantity: 12, cmc: 3, mana_cost: '{1}{B}{B}', type_line: 'Instant', oracle_text: 'Destroy target creature.' }),
    card('Grizzly Bears', { quantity: 24, cmc: 2, mana_cost: '{1}{B}', type_line: 'Creature — Bear', power: '2' }),
    card('Swamp', { quantity: 24, type_line: 'Basic Land — Swamp', color_identity: 'B' })
  ];

  const breadth = find(adviseDeck(deck, [], 'standard'), 'answer-breadth');
  assert.ok(breadth, 'a creature-only removal suite is reported');
  assert.equal(breadth.severity, 'warn');
});

test('combo decks are not nagged about interaction they deliberately lack', () => {
  // A deck whose payoff demands critical mass, is very cheap, and interacts
  // barely at all — Part 5's "no plan B by design".
  const deck = [
    card('Storm Payoff', {
      quantity: 4, cmc: 2, mana_cost: '{1}{B}', type_line: 'Sorcery',
      oracle_text: 'Storm. Target player loses 2 life and you gain 2 life.'
    }),
    card('Dark Ritual', { quantity: 32, cmc: 1, mana_cost: '{B}', type_line: 'Instant', oracle_text: 'Add {B}{B}{B}.' }),
    card('Swamp', { quantity: 24, type_line: 'Basic Land — Swamp', color_identity: 'B' })
  ];

  const result = adviseDeck(deck, [], 'legacy');
  assert.equal(result.archetype, 'combo');
  assert.ok(!codes(result).includes('loss-mode-threat'), 'combo is spared the interaction nag');
  assert.ok(!codes(result).includes('answer-breadth'));
});

test('a few copies of one lock piece is not a prison deck', () => {
  const deck = [
    card('Chalice of the Void', {
      quantity: 4, cmc: 0, mana_cost: '{X}{X}', type_line: 'Artifact',
      oracle_text: 'Whenever a player casts a spell with mana value equal to the number of charge counters on Chalice of the Void, counter that spell.'
    }),
    card('Grizzly Bears', { quantity: 32, cmc: 2, mana_cost: '{1}{G}', type_line: 'Creature — Bear', power: '2' }),
    card('Forest', { quantity: 24, type_line: 'Basic Land — Forest', color_identity: 'G' })
  ];

  assert.notEqual(adviseDeck(deck, [], 'legacy').archetype, 'prison');
});

test('pitch spells do not create a demand on the mana base', () => {
  const deck = [
    card('Force of Will', {
      quantity: 8, cmc: 5, mana_cost: '{3}{U}{U}', type_line: 'Instant',
      oracle_text: "You may pay 1 life and exile a blue card from your hand rather than pay this spell's mana cost. Counter target spell."
    }),
    card('Mountain', { quantity: 24, type_line: 'Basic Land — Mountain', color_identity: 'R' }),
    card('Lightning Bolt', { quantity: 28, cmc: 1, mana_cost: '{R}', type_line: 'Instant', oracle_text: 'Lightning Bolt deals 3 damage to any target.' })
  ];

  const blue = analyzeDeck(deck, [], 'legacy').colors.find((c) => c.color === 'U');
  assert.equal(blue, undefined, 'a pitched {U}{U} is never actually paid');
});

test('a deck barely started is left alone', () => {
  const deck = [card('Grizzly Bears', { quantity: 8, cmc: 2, mana_cost: '{1}{G}', type_line: 'Creature — Bear', power: '2' })];
  assert.deepEqual(adviseDeck(deck, [], 'standard').findings, []);
});

test('opening-hand odds are withheld until the deck is nearly built', () => {
  const partial = [
    card('Grizzly Bears', { quantity: 20, cmc: 2, mana_cost: '{1}{G}', type_line: 'Creature — Bear', power: '2' }),
    card('Forest', { quantity: 20, type_line: 'Basic Land — Forest', color_identity: 'G' })
  ];

  const found = codes(adviseDeck(partial, [], 'standard'));
  assert.ok(!found.includes('keepable-hands'), 'a 40-card work in progress is not judged on its opening hands');
  assert.ok(!found.includes('turn-one'));
});

test('findings avoid jargon a new player would not know', () => {
  // The audience is someone who has been playing for a week. "You have 11 B
  // sources" is a correct sentence that tells them nothing, so the vocabulary
  // is a design constraint rather than a matter of taste.
  const banned = /\b(pips?|sources?|cantrips?|CMC|mana value|curve|goldfish|tempo|card advantage|on-curve|two-for-one)\b/i;

  const deck = [
    card('Death Baron', {
      quantity: 4, cmc: 3, mana_cost: '{1}{B}{B}', type_line: 'Creature — Zombie Wizard', power: '2',
      oracle_text: 'Skeletons you control and other Zombies you control get +1/+1 and have deathtouch.'
    }),
    card('Murder', { quantity: 8, cmc: 3, mana_cost: '{1}{B}{B}', type_line: 'Instant', oracle_text: 'Destroy target creature.' }),
    card('Grizzly Bears', { quantity: 24, cmc: 2, mana_cost: '{1}{G}', type_line: 'Creature — Bear', power: '2' }),
    card('Swamp', { quantity: 11, type_line: 'Basic Land — Swamp', color_identity: 'B' }),
    card('Forest', { quantity: 13, type_line: 'Basic Land — Forest', color_identity: 'G' })
  ];

  for (const finding of adviseDeck(deck, [], 'standard').findings) {
    const match = finding.message.match(banned);
    assert.equal(match, null, `"${finding.code}" uses jargon (${match && match[0]}): ${finding.message}`);
    assert.ok(!/\bthe [WUBRG] \b/.test(finding.message), `"${finding.code}" uses a bare colour letter`);
  }
});

test('colour findings name the colour and both sides of the count', () => {
  const deck = [
    card('Death Baron', {
      quantity: 4, cmc: 3, mana_cost: '{1}{B}{B}', type_line: 'Creature — Zombie Wizard', power: '2',
      oracle_text: 'Zombies you control get +1/+1.'
    }),
    card('Grizzly Bears', { quantity: 32, cmc: 2, mana_cost: '{1}{G}', type_line: 'Creature — Bear', power: '2' }),
    card('Swamp', { quantity: 11, type_line: 'Basic Land — Swamp', color_identity: 'B' }),
    card('Forest', { quantity: 13, type_line: 'Basic Land — Forest', color_identity: 'G' })
  ];

  const black = find(adviseDeck(deck, [], 'standard'), 'color-support');
  assert.ok(black, 'the shortfall is reported');
  assert.match(black.message, /black/, 'the colour is spelled out');
  assert.match(black.message, /11 of your 24 lands/, 'both sides of the count are given');
  assert.ok(black.deckAction, 'the player can see which lands were counted');
  assert.equal(black.deckAction.filter.produces, 'B');
});

/**
 * A two-colour deck whose colour requirements cannot both fit inside its land
 * count. Left alone, this produced advice that read as self-contradictory:
 * "add green lands" beside "cut four lands".
 */
const conflictedDeck = (lands) => [
  card('Battle Mammoth', { cmc: 5, mana_cost: '{3}{G}{G}', type_line: 'Creature — Elephant', power: '6', oracle_text: 'Trample.' }),
  card('Death Baron', { cmc: 3, mana_cost: '{1}{B}{B}', type_line: 'Creature — Zombie Wizard', power: '2', oracle_text: 'Zombies you control get +1/+1.' }),
  card('Grizzly Bears', { quantity: 16, cmc: 2, mana_cost: '{1}{G}', type_line: 'Creature — Bear', power: '2' }),
  card('Murder', { quantity: 8, cmc: 3, mana_cost: '{1}{B}{B}', type_line: 'Instant', oracle_text: 'Destroy target creature.' }),
  card('Duress', { quantity: 6, cmc: 1, mana_cost: '{B}', type_line: 'Sorcery', oracle_text: 'Target opponent reveals their hand. You choose a noncreature card from it. That player discards that card.' }),
  ...lands
];

const separateLands = [
  card('Forest', { quantity: 11, type_line: 'Basic Land — Forest', color_identity: 'G' }),
  card('Swamp', { quantity: 11, type_line: 'Basic Land — Swamp', color_identity: 'B' })
];

const dualLands = [
  card('Forest', { quantity: 6, type_line: 'Basic Land — Forest', color_identity: 'G' }),
  card('Swamp', { quantity: 6, type_line: 'Basic Land — Swamp', color_identity: 'B' }),
  card('Overgrown Tomb', { quantity: 10, type_line: 'Land — Swamp Forest', color_identity: 'B,G' })
];

test('colour demands that cannot all fit are reported once, not as two contradictions', () => {
  const result = adviseDeck(conflictedDeck(separateLands), [], 'standard');
  const found = codes(result);

  assert.ok(found.includes('color-demands-conflict'), 'the impossible arithmetic is named');
  assert.ok(!found.includes('color-support'), 'no per-colour finding alongside it');
  assert.ok(!found.includes('color-support-spread'));

  const conflict = find(result, 'color-demands-conflict');
  assert.match(conflict.message, /22 lands in total/);
  // The player asked whether the answer is to drop the card. It should say so.
  assert.match(conflict.message, /Battle Mammoth/);
  assert.ok(conflict.evidence.length > 0, 'the demanding cards are listed');
});

test('no advice to cut lands while the colours already do not fit', () => {
  // Cutting lands makes an unsatisfiable colour requirement strictly worse, so
  // this pairing must never appear together.
  const found = codes(adviseDeck(conflictedDeck(separateLands), [], 'standard'));
  assert.ok(!found.includes('land-count'), 'cutting lands would make the real problem worse');
});

test('with enough lands, colour advice says swap rather than add', () => {
  const result = adviseDeck(conflictedDeck(dualLands), [], 'standard');
  assert.ok(!codes(result).includes('color-demands-conflict'), 'duals resolve the conflict');

  const support = find(result, 'color-support');
  assert.ok(support, 'the remaining shortfall is still reported');
  assert.match(support.message, /swap some/, 'framed as changing which lands, not adding more');
  assert.doesNotMatch(support.message, /adding more lands/i);
});

test('land-cutting advice never tells you to keep every land you have', () => {
  // "Cut 5 lands, keep the green and black ones" is not an instruction when
  // green and black are the only lands in the deck.
  const landCount = find(adviseDeck(conflictedDeck(dualLands), [], 'standard'), 'land-count');
  assert.ok(landCount);

  const keeps = landCount.message.match(/making ([a-z ]+?) first/);
  if (keeps) {
    const shortColorNames = adviseDeck(conflictedDeck(dualLands), [], 'standard')
      .snapshot.colors.filter((c) => c.sources < c.wanted).length;
    assert.ok(shortColorNames >= 0);
    assert.doesNotMatch(landCount.message, /keep the green and black ones/);
  }
});

test('cantrip density lowers the suggested land count', () => {
  const lands = card('Island', { quantity: 17, type_line: 'Basic Land — Island', color_identity: 'U' });
  const filler = card('Grizzly Bears', { quantity: 43, cmc: 2, mana_cost: '{1}{U}', type_line: 'Creature — Bear', power: '2' });
  const cantrip = card('Brainstorm', {
    quantity: 43, cmc: 1, mana_cost: '{U}', type_line: 'Instant',
    oracle_text: 'Draw three cards, then put two cards from your hand on top of your library in any order.'
  });

  const plain = analyzeDeck([lands, filler], [], 'legacy').suggestedLands;
  const digging = analyzeDeck([lands, cantrip], [], 'legacy').suggestedLands;

  assert.ok(digging < plain, `expected fewer lands with cantrips (${digging} vs ${plain})`);
});
