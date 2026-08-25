/**
 * Checks for deck readiness.
 *
 * The cases below are almost all about the split between "you do not have it"
 * and "you have it but it is in another deck", because that split is the only
 * reason this is a module rather than a COUNT(*). Getting it wrong in the
 * cannibalisation direction is the dangerous one: it tells you a deck is
 * playable when sleeving it up would gut another deck.
 *
 * Pure by design — see deckReadiness.js — so it runs anywhere, including
 * where the SQLite driver will not build.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { assessDecks, describeState, stateRank } from '../src/services/deckReadiness.js';

const row = (over = {}) => ({
  deck_id: 1,
  card_id: 100,
  name: 'Lightning Bolt',
  needed: 4,
  owned: 4,
  elsewhere: 0,
  ...over,
});

const deck = (rows, deckIds = [1]) => assessDecks(rows, deckIds).get(1);

test('a deck whose cards are all owned and uncommitted is ready', () => {
  const d = deck([row()]);

  assert.equal(d.state, 'ready');
  assert.equal(d.missingCopies, 0);
  assert.equal(d.contestedCopies, 0);
  assert.equal(describeState(d), 'Ready');
});

test('copies that are not in the collection at all count as missing', () => {
  const d = deck([row({ needed: 4, owned: 1 })]);

  assert.equal(d.state, 'needs_buying');
  assert.equal(d.missingCopies, 3);
  assert.equal(d.contestedCopies, 0);
  assert.equal(d.missingCards, 1);
});

test('copies owned but committed to another deck count as contested, not missing', () => {
  // Own the full playset, but three of them are in another deck.
  const d = deck([row({ needed: 4, owned: 4, elsewhere: 3 })]);

  assert.equal(d.state, 'needs_assembly');
  assert.equal(d.missingCopies, 0);
  assert.equal(d.contestedCopies, 3);
  assert.equal(describeState(d), 'Short 3, in other decks');
});

test('a card can be part missing and part contested at once', () => {
  // Need 4, own 3, one of those is elsewhere: one to buy, one to reclaim.
  const d = deck([row({ needed: 4, owned: 3, elsewhere: 1 })]);

  assert.equal(d.missingCopies, 1);
  assert.equal(d.contestedCopies, 1);
  assert.equal(d.cards[0].usable, 2);
  // Buying is the blocking half, so that is the state — but the badge still
  // has to mention the teardown or the shop trip looks like the whole job.
  assert.equal(d.state, 'needs_buying');
  assert.equal(describeState(d), 'Short 1 to buy · 1 in other decks');
});

test('the deck being measured never competes with itself', () => {
  // `elsewhere` excludes this deck at the call site. A deck whose own claim
  // leaked into that number would report a perfectly built deck as needing
  // cannibalisation — the failure this test exists to catch.
  const d = deck([row({ needed: 4, owned: 4, elsewhere: 0 })]);

  assert.equal(d.state, 'ready');
});

test('over-commitment across decks does not produce negative counts', () => {
  // Two other decks between them claim more copies than exist.
  const d = deck([row({ needed: 2, owned: 3, elsewhere: 9 })]);

  assert.equal(d.cards[0].free, 0);
  assert.equal(d.missingCopies, 0);
  assert.equal(d.contestedCopies, 2);
});

test('a card listed in both mainboard and sideboard is one claim, not two', () => {
  // Own 3, want 3 across two boards. Judged per row, the sideboard copy would
  // be compared against the same 3 owned copies and called free a second time.
  const d = deck([
    row({ needed: 2, owned: 3, elsewhere: 0 }),
    row({ needed: 2, owned: 3, elsewhere: 0 }),
  ]);

  assert.equal(d.cards.length, 1);
  assert.equal(d.cards[0].needed, 4);
  assert.equal(d.missingCopies, 1);
  assert.equal(d.state, 'needs_buying');
});

test('an empty deck is empty, not ready', () => {
  const decks = assessDecks([], [42]);

  assert.equal(decks.get(42).state, 'empty');
  assert.equal(describeState(decks.get(42)), 'Empty');
});

test('several decks are assessed independently in one pass', () => {
  const decks = assessDecks(
    [
      row({ deck_id: 1, card_id: 100, needed: 4, owned: 4 }),
      row({ deck_id: 2, card_id: 100, needed: 4, owned: 4, elsewhere: 4 }),
      row({ deck_id: 3, card_id: 101, name: 'Counterspell', needed: 2, owned: 0 }),
    ],
    [1, 2, 3]
  );

  assert.equal(decks.get(1).state, 'ready');
  assert.equal(decks.get(2).state, 'needs_assembly');
  assert.equal(decks.get(3).state, 'needs_buying');
});

test('shortfalls sort ahead of the cards that are fine', () => {
  const d = deck([
    row({ card_id: 1, name: 'Arid Mesa', needed: 1, owned: 1 }),
    row({ card_id: 2, name: 'Brainstorm', needed: 4, owned: 4, elsewhere: 4 }),
    row({ card_id: 3, name: 'Counterspell', needed: 2, owned: 0 }),
  ]);

  assert.deepEqual(
    d.cards.map((c) => c.name),
    ['Counterspell', 'Brainstorm', 'Arid Mesa']
  );
});

test('states rank worst-first so callers can surface the decks needing work', () => {
  assert.ok(stateRank('needs_buying') > stateRank('needs_assembly'));
  assert.ok(stateRank('needs_assembly') > stateRank('ready'));
  assert.ok(stateRank('ready') > stateRank('empty'));
});
