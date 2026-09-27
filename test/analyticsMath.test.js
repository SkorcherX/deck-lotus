import test from 'node:test';
import assert from 'node:assert/strict';

import {
  colorCategory, summariseColors, fillMonths, foldTopN,
} from '../src/services/analyticsMath.js';

test('lands are bucketed before colors, since a land has none', () => {
  assert.equal(colorCategory({ colors: '', typeLine: 'Basic Land — Island', isBasic: true }), 'basic_land');
  assert.equal(colorCategory({ colors: '', typeLine: 'Land', isBasic: false }), 'nonbasic_land');
  assert.equal(colorCategory({ colors: 'G', typeLine: 'Land Creature — Forest Dryad', isBasic: false }), 'G');
});

test('mono, multi and colorless', () => {
  assert.equal(colorCategory({ colors: 'R', typeLine: 'Instant' }), 'R');
  assert.equal(colorCategory({ colors: 'W,U', typeLine: 'Creature' }), 'multi');
  assert.equal(colorCategory({ colors: null, typeLine: 'Artifact' }), 'colorless');
});

test('summariseColors keeps every category, in order, even at zero', () => {
  const out = summariseColors([
    { colors: 'U', typeLine: 'Instant', copies: 3, value: 1.5 },
    { colors: 'U', typeLine: 'Sorcery', copies: 1, value: 0.25 },
  ]);
  assert.equal(out.length, 9);
  assert.equal(out[0].key, 'W');
  assert.deepEqual(out[1], { key: 'U', label: 'Blue', copies: 4, value: 1.75 });
  assert.equal(out[2].copies, 0);
});

test('fillMonths fills gaps and runs through the given month', () => {
  const out = fillMonths([
    { month: '2025-11', added: 5, removed: 1 },
    { month: '2026-02', added: 2, removed: 0 },
  ], '2026-03');
  assert.deepEqual(out.map((r) => r.month), ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
  assert.equal(out[1].added, 0);
  assert.equal(out[3].added, 2);
});

test('fillMonths on nothing is nothing', () => {
  assert.deepEqual(fillMonths([], '2026-03'), []);
});

test('foldTopN folds the tail into Other and sums it', () => {
  const sets = [
    { code: 'A', copies: 10, value: 1 },
    { code: 'B', copies: 5, value: 20 },
    { code: 'C', copies: 3, value: 2 },
    { code: 'D', copies: 1, value: 3 },
  ];
  const out = foldTopN(sets, 2, 'value', ['copies', 'value']);
  assert.deepEqual(out.map((s) => s.code), ['B', 'D', null]);
  assert.equal(out[2].copies, 13);
  assert.equal(out[2].value, 3);
  assert.ok(out[2].isOther);
});

import {
  primaryType, rarityBucket, curveBucket, summariseComposition,
} from '../src/services/analyticsMath.js';

test('primaryType files multi-typed cards the way the deck builder does', () => {
  assert.equal(primaryType('Artifact Creature — Golem'), 'Creature');
  assert.equal(primaryType('Legendary Enchantment Artifact'), 'Enchantment');
  assert.equal(primaryType('Basic Land — Forest'), 'Land');
  assert.equal(primaryType('Kindred Instant — Elf'), 'Instant');
  assert.equal(primaryType(null), 'Other');
});

test('rarity and curve buckets', () => {
  assert.equal(rarityBucket('Mythic'), 'mythic');
  assert.equal(rarityBucket('bonus'), 'special');
  assert.equal(curveBucket(0), '0');
  assert.equal(curveBucket(3.5), '3');
  assert.equal(curveBucket(12), '7+');
});

test('summariseComposition keeps lands off the curve but in types and rarity', () => {
  const out = summariseComposition([
    { typeLine: 'Land', rarity: 'rare', cmc: 0, copies: 2, value: 40 },
    { typeLine: 'Instant', rarity: 'common', cmc: 1, copies: 4, value: 1 },
  ]);
  assert.equal(out.curve.find((b) => b.key === '0').copies, 0);
  assert.equal(out.curve.find((b) => b.key === '1').copies, 4);
  assert.equal(out.types.find((b) => b.key === 'Land').value, 40);
  assert.equal(out.rarities.find((b) => b.key === 'rare').copies, 2);
  assert.equal(out.types.length, 9);
});

import { summariseDeckUse } from '../src/services/analyticsMath.js';

test('deck use splits copies the way the Inventory page counts available', () => {
  const out = summariseDeckUse([
    // 6 owned, 2 in decks, 1 lent: 3 idle, of which 2 are past a playset (4 − 2 − 1 = 1 kept).
    { name: 'Bolt', owned: 6, inDecks: 2, lent: 1, value: 6 },
    // Listed by more decks than owned: all in decks, nothing idle.
    { name: 'Ring', owned: 1, inDecks: 3, lent: 0, value: 2 },
    // In no deck.
    { name: 'Rock', owned: 2, inDecks: 0, lent: 0, value: 10 },
    // Basics are ignored entirely.
    { name: 'Island', owned: 40, inDecks: 0, lent: 0, value: 4, isBasic: true },
  ]);
  assert.equal(out.copies, 9);
  assert.equal(out.inDecks, 3);
  assert.equal(out.lent, 1);
  assert.equal(out.idle, 5);
  assert.equal(out.spare, 2);
  assert.equal(out.cardsInNoDeck, 1);
  assert.equal(out.idleValue, 13);
  assert.deepEqual(out.topIdle.map((c) => c.name), ['Rock', 'Bolt']);
});

import { rankMovers } from '../src/services/analyticsMath.js';

test('movers rank by effect on the collection, not percent, and drop noise', () => {
  const out = rankMovers([
    { name: 'Penny', quantity: 1, then: 0.10, now: 0.20 },   // +100% but +$0.10
    { name: 'Staple', quantity: 4, then: 5, now: 6 },        // +$4 held
    { name: 'Chase', quantity: 1, then: 40, now: 36 },       // −$4
    { name: 'Flat', quantity: 9, then: 1, now: 1.02 },       // under minChange
    { name: 'New', quantity: 1, then: null, now: 3 },        // no history yet
  ]);
  assert.deepEqual(out.gainers.map((m) => m.name), ['Staple', 'Penny']);
  assert.equal(out.gainers[0].totalChange, 4);
  assert.equal(out.gainers[1].percent, 100);
  assert.deepEqual(out.losers.map((m) => m.name), ['Chase']);
  assert.equal(out.losers[0].percent, -10);
  assert.equal(out.netChange, 0.1);
});
