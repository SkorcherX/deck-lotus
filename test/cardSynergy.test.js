/**
 * The synergy heuristics, checked against cards whose behaviour is not in
 * dispute.
 *
 * The tests that matter here are not "does this regex fire" but the two design
 * claims the module rests on:
 *
 *   1. Strength is min(enablers, payoffs), so a theme with an abundant half
 *      and an empty one scores zero rather than scoring well.
 *   2. Tribes go through the same machinery as mechanical themes, so Human —
 *      the most common creature type in the game and not a tribe — scores on
 *      payoffs rather than on how many Humans exist.
 *
 * Both are things a tag-counting model gets wrong, and both are cheap to
 * regress accidentally.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  THEMES, MIN_VIABLE_STRENGTH,
  subtypesOf, withinColorIdentity, tribeTheme, themeRole,
  analyzeTheme, candidateTribes, rankThemes, viableThemes, synergyScore,
} from '../src/services/cardSynergyService.js';

/** A card row shaped the way the cards table hands one over. */
const card = (name, props = {}) => ({
  name,
  type_line: 'Creature — Human',
  oracle_text: '',
  color_identity: '',
  subtypes: 'Human',
  cmc: 2,
  ...props,
});

const bloodArtist = card('Blood Artist', {
  type_line: 'Creature — Vampire',
  subtypes: 'Vampire',
  color_identity: 'B',
  oracle_text: 'Whenever Blood Artist or another creature dies, target player loses 1 life and you gain 1 life.',
});

const vikingLonghouse = card('Carrion Feeder', {
  type_line: 'Creature — Zombie',
  subtypes: 'Zombie',
  color_identity: 'B',
  oracle_text: 'Carrion Feeder can\'t block. Sacrifice a creature: Put a +1/+1 counter on Carrion Feeder.',
});

describe('subtypesOf', () => {
  test('parses the comma-joined string the cards table stores', () => {
    assert.deepEqual(subtypesOf({ subtypes: 'Human, Soldier' }), ['Human', 'Soldier']);
  });

  test('accepts an array a caller has already parsed', () => {
    assert.deepEqual(subtypesOf({ subtypes: ['Elf', 'Druid'] }), ['Elf', 'Druid']);
  });

  test('an absent or empty column is no subtypes, not a crash', () => {
    assert.deepEqual(subtypesOf({}), []);
    assert.deepEqual(subtypesOf({ subtypes: '' }), []);
    assert.deepEqual(subtypesOf({ subtypes: null }), []);
  });
});

describe('withinColorIdentity', () => {
  test('a colourless card fits every identity', () => {
    assert.equal(withinColorIdentity(card('Sol Ring', { color_identity: '' }), 'BG'), true);
  });

  test('every symbol must be allowed, not merely one of them', () => {
    const gruul = card('X', { color_identity: 'RG' });
    assert.equal(withinColorIdentity(gruul, 'RG'), true);
    assert.equal(withinColorIdentity(gruul, 'BRG'), true);
    // Sharing red is not enough — the green makes it illegal.
    assert.equal(withinColorIdentity(gruul, 'UR'), false);
  });
});

describe('theme polarity', () => {
  test('a death trigger is a payoff, a sac outlet is an enabler', () => {
    assert.equal(themeRole(bloodArtist, THEMES.aristocrats), 'payoff');
    assert.equal(themeRole(vikingLonghouse, THEMES.aristocrats), 'enabler');
  });

  test('a card doing both jobs is reported as both, not collapsed', () => {
    const ophiomancer = card('Token Reaper', {
      color_identity: 'B',
      oracle_text: 'At the beginning of your upkeep, create a 1/1 black Snake creature token. '
        + 'Whenever another creature you control dies, each opponent loses 1 life.',
    });
    assert.equal(themeRole(ophiomancer, THEMES.aristocrats), 'both');
    assert.equal(synergyScore(ophiomancer, THEMES.aristocrats), 3);
  });

  test('an unrelated card sits on neither side', () => {
    const bolt = card('Lightning Bolt', {
      type_line: 'Instant', subtypes: '', color_identity: 'R',
      oracle_text: 'Lightning Bolt deals 3 damage to any target.',
    });
    assert.equal(themeRole(bolt, THEMES.aristocrats), null);
    assert.equal(synergyScore(bolt, THEMES.aristocrats), 0);
  });

  test('payoffs outrank enablers, because payoffs are the scarce half', () => {
    assert.ok(synergyScore(bloodArtist, THEMES.aristocrats) > synergyScore(vikingLonghouse, THEMES.aristocrats));
  });
});

describe('analyzeTheme', () => {
  const sacOutlet = (n) => card(`Outlet ${n}`, {
    color_identity: 'B',
    oracle_text: 'Sacrifice a creature: Draw a card.',
  });

  test('strength is the weaker half, not the sum', () => {
    // Twenty enablers, one payoff. A tag-counting model calls this a
    // 21-card theme; it is a one-card theme.
    const pool = [...Array(20)].map((_, i) => sacOutlet(i)).concat(bloodArtist);
    const result = analyzeTheme(pool, THEMES.aristocrats);

    assert.equal(result.enablers, 20);
    assert.equal(result.payoffs, 1);
    assert.equal(result.strength, 1);
    assert.equal(result.viable, false);
  });

  test('an abundant half with an empty one scores zero', () => {
    const pool = [...Array(30)].map((_, i) => sacOutlet(i));
    const result = analyzeTheme(pool, THEMES.aristocrats);

    assert.equal(result.enablers, 30);
    assert.equal(result.payoffs, 0);
    assert.equal(result.strength, 0);
  });

  test('it carries the cards behind the numbers', () => {
    const result = analyzeTheme([bloodArtist, vikingLonghouse], THEMES.aristocrats);
    assert.deepEqual(result.payoffCards, ['Blood Artist']);
    assert.deepEqual(result.enablerCards, ['Carrion Feeder']);
  });

  test('lands are excluded, so a land count cannot inflate a theme', () => {
    const fetchland = card('Evolving Wilds', {
      type_line: 'Land', subtypes: '', color_identity: '',
      oracle_text: 'Sacrifice a creature: nothing. Search your library for a basic land card.',
    });
    const result = analyzeTheme([fetchland, fetchland, bloodArtist], THEMES.aristocrats);
    assert.equal(result.enablers, 0);
  });
});

describe('tribes go through the same machinery', () => {
  const vampires = [...Array(20)].map((_, i) => card(`Vampire ${i}`, {
    type_line: 'Creature — Vampire', subtypes: 'Vampire', color_identity: 'B',
  }));
  const vampireLord = card('Vampire Lord', {
    type_line: 'Creature — Vampire', subtypes: 'Vampire', color_identity: 'B',
    oracle_text: 'Other Vampires you control get +1/+1.',
  });

  test('a real tribe scores on its payoffs', () => {
    const result = analyzeTheme([...vampires, vampireLord], tribeTheme('Vampire'));
    assert.equal(result.enablers, 21);
    assert.equal(result.payoffs, 1);
    assert.equal(result.strength, 1);
    assert.equal(result.tribe, 'Vampire');
  });

  test('the Human problem: many creatures, no payoffs, no theme', () => {
    // Human is the most common creature type in the game and is not a tribe.
    // Counting creatures would make it the strongest theme in most
    // collections; counting payoffs correctly makes it nothing.
    const humans = [...Array(30)].map((_, i) => card(`Human ${i}`, { color_identity: 'W' }));
    const result = analyzeTheme(humans, tribeTheme('Human'));

    assert.equal(result.enablers, 30);
    assert.equal(result.payoffs, 0);
    assert.equal(result.strength, 0);
    assert.equal(result.viable, false);
  });

  test('candidateTribes finds what the pool holds, biggest first', () => {
    const pool = [
      ...vampires,
      ...[...Array(9)].map((_, i) => card(`Elf ${i}`, {
        type_line: 'Creature — Elf', subtypes: 'Elf', color_identity: 'G',
      })),
      card('Lone Sliver', { type_line: 'Creature — Sliver', subtypes: 'Sliver' }),
    ];
    const tribes = candidateTribes(pool);
    assert.deepEqual(tribes, ['Vampire', 'Elf']);
    // One Sliver is not a tribe and must not be offered as one.
    assert.ok(!tribes.includes('Sliver'));
  });
});

describe('rankThemes', () => {
  /** A pool with a genuinely deep graveyard theme and a shallow lifegain one. */
  const pool = [
    ...[...Array(12)].map((_, i) => card(`Miller ${i}`, {
      color_identity: 'B',
      oracle_text: 'When this creature enters, mill three cards.',
    })),
    ...[...Array(12)].map((_, i) => card(`Reanimator ${i}`, {
      color_identity: 'B',
      oracle_text: 'Return target creature card from your graveyard to the battlefield.',
    })),
    ...[...Array(20)].map((_, i) => card(`Lifegainer ${i}`, {
      color_identity: 'W',
      oracle_text: 'You gain 3 life.',
    })),
  ];

  test('the deep theme outranks the abundant-but-lopsided one', () => {
    const ranked = rankThemes(pool, { includeTribes: false });
    const graveyard = ranked.find((t) => t.key === 'graveyard');
    const lifegain = ranked.find((t) => t.key === 'lifegain');

    assert.equal(graveyard.strength, 12);
    // Twenty lifegain enablers, no payoff.
    assert.equal(lifegain.strength, 0);
    assert.ok(ranked.indexOf(graveyard) < ranked.indexOf(lifegain));
  });

  test('identity filters the pool before measuring, not after', () => {
    // The white lifegain cards are not legal in mono-black, so they cannot
    // contribute to any theme measured in that identity.
    const ranked = rankThemes(pool, { identity: 'B', includeTribes: false });
    const lifegain = ranked.find((t) => t.key === 'lifegain');
    assert.equal(lifegain.enablers, 0);

    const graveyard = ranked.find((t) => t.key === 'graveyard');
    assert.equal(graveyard.strength, 12);
  });

  test('viableThemes drops what cannot fill a deck and never pads', () => {
    const viable = viableThemes(pool, { includeTribes: false });
    assert.ok(viable.every((t) => t.strength >= MIN_VIABLE_STRENGTH));
    assert.ok(viable.some((t) => t.key === 'graveyard'));
    assert.ok(!viable.some((t) => t.key === 'lifegain'));
  });

  test('a collection with no dense theme returns nothing rather than the least bad', () => {
    const thin = [bloodArtist, vikingLonghouse];
    assert.deepEqual(viableThemes(thin, { includeTribes: false }), []);
  });
});
