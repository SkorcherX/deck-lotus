import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  computeBracket, isMassLandDenial, isExtraTurn,
} from '../src/shared/commanderBrackets.js';

/**
 * The bracket floor. The text filters are the part most likely to drift: a
 * false positive pushes a casual deck into bracket 4 and makes the whole
 * number look wrong, so the near-misses matter as much as the hits.
 */
const card = (name, oracle_text, extra = {}) => ({ name, oracle_text, board_type: 'mainboard', ...extra });

describe('mass land denial', () => {
  const hits = [
    ['Armageddon', 'Destroy all lands.'],
    ['Jokulhaups', 'Destroy all artifacts, creatures, and lands. They can\'t be regenerated.'],
    ['Ruination', 'Destroy all nonbasic lands.'],
    ['Flashfires', 'Destroy all Plains.'],
    ['Winter Orb', 'As long as Winter Orb is untapped, players can\'t untap more than one land during their untap steps.'],
    ['Back to Basics', 'Nonbasic lands don\'t untap during their controllers\' untap steps.'],
    ['Blood Moon', 'Nonbasic lands are Mountains.'],
    ['Thalia, Guardian of Thraben', 'First strike\nNoncreature spells cost {1} more to cast.'],
    ['Sphere of Resistance', 'Spells cost {1} more to cast.'],
    ['Grand Arbiter Augustin IV', 'White spells you cast cost {1} less to cast.\nBlue spells you cast cost {1} less to cast.\nSpells your opponents cast cost {1} more to cast.'],
    ['Sunder', 'Return all lands to their owners\' hands.'], // by name list
    ['Dovin Baan', '[−7]: You get an emblem with "Your opponents can\'t untap more than two permanents during their untap steps."'],
    ['Thalia, the Survivor', 'Lifelink\nNoncreature spells your opponents cast cost {1} more to cast.'],
  ];
  for (const [name, text] of hits) {
    test(`${name} is MLD`, () => assert.equal(isMassLandDenial(card(name, text)), true));
  }

  const misses = [
    ['Wrath of God', 'Destroy all creatures. They can\'t be regenerated.'],
    ['Austere Command', 'Choose two —\n• Destroy all artifacts.\n• Destroy all enchantments.'],
    ['Cyclonic Rift', 'Return target nonland permanent you don\'t control to its owner\'s hand.\nOverload {6}{U}'],
    ['Strip Mine', '{T}: Add {C}.\n{T}, Sacrifice Strip Mine: Destroy target land.'],
    ['Thalia\'s Lieutenant', 'When Thalia\'s Lieutenant enters, put a +1/+1 counter on each other Human you control.'],
    ['Aura of Silence', 'Artifact and enchantment spells your opponents cast cost {2} more to cast.'],
    ['Kopala, Warden of Waves', 'Spells your opponents cast that target a Merfolk you control cost {2} more to cast.'],
    ['Rishadan Port', '{T}: Add {C}.\n{1}, {T}: Tap target land.'],
    ['Settle the Wreckage', 'Exile all attacking creatures target player controls. That player may search for that many basic land cards.'],
    ['Zuran Orb', 'Sacrifice a land: You gain 2 life.'],
    // Found by sweeping every Commander-legal card through the filters.
    ['Elspeth Tirel', '[−5]: Destroy all other permanents except for lands and tokens.'],
    ['Scourglass', 'Sacrifice Scourglass: Destroy all permanents except for artifacts and lands.'],
    ['Smoke', 'Players can\'t untap more than one creature during their untap steps.'],
    ['Imi Statue', 'Players can\'t untap more than one artifact during their untap steps.'],
    ['Mungha Wurm', 'You can\'t untap more than one land during your untap step.'],
    ['Stormtide Leviathan', 'Islandwalk\nAll lands are Islands in addition to their other types.'],
    ['Return of the Nightstalkers', 'Return all Nightstalker permanent cards from your graveyard to the battlefield. Then destroy all Swamps you control.'],
    ['Hinata, Dawn-Crowned', 'Spells you cast cost {1} less to cast for each target.\nSpells your opponents cast cost {1} more to cast for each target.'],
  ];
  for (const [name, text] of misses) {
    test(`${name} is not MLD`, () => assert.equal(isMassLandDenial(card(name, text)), false));
  }

  test('a creature-spell tax counts, per the write-up', () => {
    assert.equal(isMassLandDenial(card('Feroz\'s Ban', 'Creature spells cost {2} more to cast.')), true);
  });
});

describe('extra turns', () => {
  test('Time Warp', () => assert.equal(isExtraTurn(card('Time Warp', 'Target player takes an extra turn after this one.')), true));
  test('Karn\'s Temporal Sundering', () => assert.equal(isExtraTurn(card('Karn\'s Temporal Sundering', '(You may cast a legendary sorcery only if you control a legendary creature or planeswalker.)\nTarget player takes an extra turn after this one. Return up to one target nonland permanent to its owner\'s hand. Exile Karn\'s Temporal Sundering.')), true));
  test('Time Stretch takes two', () => assert.equal(isExtraTurn(card('Time Stretch', 'Target player takes two extra turns after this one.')), true));
  test('Stranglehold denies them', () => assert.equal(isExtraTurn(card('Stranglehold', 'Your opponents can\'t search libraries.\nIf an opponent would begin an extra turn, that player skips that turn instead.')), false));
  test('Ugin\'s Nexus denies them', () => assert.equal(isExtraTurn(card('Ugin\'s Nexus', 'If a player would begin an extra turn, that player skips that turn instead.')), false));
  test('"can\'t take extra turns" is not one', () => assert.equal(isExtraTurn(card('X', 'Players can\'t take extra turns.')), false));
});

describe('computeBracket', () => {
  const filler = Array.from({ length: 10 }, (_, i) => card(`Bear ${i}`, 'Vanilla.'));

  test('nothing tripped reads 1–2', () => {
    const r = computeBracket(filler);
    assert.equal(r.minBracket, 1);
    assert.equal(r.label, 'Bracket 1–2');
    assert.deepEqual(r.reasons, []);
  });

  test('one to three Game Changers is bracket 3, four is 4', () => {
    const gc = (n) => Array.from({ length: n }, (_, i) => card(`GC ${i}`, '', { is_game_changer: 1 }));
    assert.equal(computeBracket([...filler, ...gc(1)]).minBracket, 3);
    assert.equal(computeBracket([...filler, ...gc(3)]).minBracket, 3);
    assert.equal(computeBracket([...filler, ...gc(4)]).minBracket, 4);
  });

  test('extra turns step 2 → 3 → 4 by count', () => {
    const et = (n) => Array.from({ length: n }, (_, i) => card(`Turn ${i}`, 'You take an extra turn after this one.'));
    assert.equal(computeBracket(et(2)).minBracket, 2);
    assert.equal(computeBracket(et(3)).minBracket, 3);
    assert.equal(computeBracket(et(4)).minBracket, 4);
  });

  test('a chaining card is bracket 4 on its own', () => {
    const r = computeBracket([card('Time Warp', 'Target player takes an extra turn after this one.')]);
    assert.equal(r.minBracket, 4);
    assert.equal(r.reasons[0].rule, 'extra_turn_chaining');
  });

  test('sideboard and maybeboard are not played', () => {
    const r = computeBracket([
      card('Armageddon', 'Destroy all lands.', { board_type: 'maybeboard' }),
      card('Sol Ring', '', { is_game_changer: 1, board_type: 'sideboard' }),
    ]);
    assert.equal(r.minBracket, 1);
  });

  test('the commander counts', () => {
    const r = computeBracket([card('Urza, Lord High Artificer', '', { is_game_changer: 1, board_type: 'commander', is_commander: 1 })]);
    assert.equal(r.minBracket, 3);
  });

  test('two printings of one card count once', () => {
    const t = 'You take an extra turn after this one.';
    const r = computeBracket([card('A', t), card('A', t, { is_foil: 1 }), card('B', t)]);
    assert.equal(r.reasons.find((x) => x.rule === 'extra_turns').cards.length, 2);
    assert.equal(r.minBracket, 2);
  });

  test('combos: early is 4, late (8+ mana) is 3', () => {
    assert.equal(computeBracket([], { combos: [{ cards: ['A', 'B'], totalMana: 4 }] }).minBracket, 4);
    assert.equal(computeBracket([], { combos: [{ cards: ['A', 'B'], totalMana: 8 }] }).minBracket, 3);
  });

  test('reasons come highest bracket first and the label names it', () => {
    const r = computeBracket([
      card('Sol Ring', '', { is_game_changer: 1 }),
      card('Armageddon', 'Destroy all lands.'),
    ]);
    assert.deepEqual(r.reasons.map((x) => x.bracket), [4, 3]);
    assert.equal(r.label, 'Bracket 4+ · Optimized');
  });
});
