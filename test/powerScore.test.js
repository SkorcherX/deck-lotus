import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  priceRating, popularityRating, powerLevel, scoreDeck,
} from '../src/shared/powerScore.js';

/**
 * The curves are read off published charts, so the points themselves are
 * pinned; the scoring is pinned by shape (cheaper and stronger scores higher)
 * rather than exact figures, which are expected to be tuned.
 */
describe('curves', () => {
  test('price: chart points, capped at $100, unpriced is 0', () => {
    assert.equal(priceRating(10), 5);
    assert.equal(priceRating(100), 10);
    assert.equal(priceRating(300), 10);
    assert.equal(priceRating(null), 0);
    assert.ok(Math.abs(priceRating(12.5) - 5.5) < 1e-9);
  });

  test('popularity: rank 1 is 10, past 27,000 is 0, missing is 0', () => {
    assert.equal(popularityRating(1), 10);
    assert.equal(popularityRating(5100), 5);
    assert.equal(popularityRating(30000), 0);
    assert.equal(popularityRating(null), 0);
  });

  test('power: chart points', () => {
    assert.equal(powerLevel(420), 5);
    assert.equal(powerLevel(1000), 10);
    assert.equal(powerLevel(5000), 10);
    assert.equal(powerLevel(-1), 0);
  });
});

describe('scoreDeck', () => {
  const spell = (name, cmc, price, rank) => ({ name, cmc, price, edhrecRank: rank, isLand: false });

  test('basic lands are ignored, other lands count toward Impact only', () => {
    const r = scoreDeck([
      spell('A', 2, 10, 5100),
      { name: 'Island', isLand: true, isBasicLand: true, quantity: 30, price: 0.1, edhrecRank: 1 },
      { name: 'Polluted Delta', isLand: true, price: 25, edhrecRank: 1700 },
    ]);
    assert.equal(r.impact, 10 + 14);
    assert.equal(r.avgCmc, 2);
  });

  test('tipping point is where cheap cards pass 65% of spell Impact', () => {
    const r = scoreDeck([
      spell('cheap', 1, 100, 1),   // 20
      spell('mid', 3, 6, 7300),    // 8
      spell('top', 6, 6, 7300),    // 8
    ]);
    // 20/36 = 56% at 1, 28/36 = 78% at 3.
    assert.equal(r.tippingPoint, 3);
  });

  test('the same cards cast cheaper score higher', () => {
    const at = (cmc) => scoreDeck(Array.from({ length: 60 }, (_, i) => spell(`c${i}`, cmc, 5, 4000)));
    assert.ok(at(2).score > at(4).score);
    assert.equal(at(1).efficiency, 10);
  });

  test('stronger cards at the same curve score higher', () => {
    const deck = (price, rank) => scoreDeck(Array.from({ length: 60 }, (_, i) => spell(`c${i}`, 3, price, rank)));
    assert.ok(deck(30, 500).score > deck(1, 15000).score);
  });

  test('an empty deck scores zero', () => {
    const r = scoreDeck([]);
    assert.equal(r.score, 0);
    assert.equal(r.powerLevel, 0);
  });
});
