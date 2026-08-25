/**
 * URL ↔ route, the half of the router that needs no DOM.
 *
 * The interesting cases are all the ones a person creates by hand: a
 * bookmark to a deck that has since been deleted, a trailing slash, a pasted
 * link with a typo. None of them may throw, because there is no 404 page to
 * land on and a router that throws takes the whole app down with it.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { parsePath, pathFor, DEFAULT_PAGE, isExternalPath } from '../client/src/utils/router.js';

describe('parsing a URL into a route', () => {
  test('the app root is the deck list', () => {
    assert.deepEqual(parsePath('/'), { page: 'decks' });
    assert.equal(DEFAULT_PAGE, 'decks');
  });

  test('each nav page has its own path', () => {
    assert.deepEqual(parsePath('/inventory'), { page: 'inventory' });
    assert.deepEqual(parsePath('/shopping'), { page: 'shopping' });
    assert.deepEqual(parsePath('/price-monitoring'), { page: 'price-monitoring' });
  });

  test('a deck id opens the builder', () => {
    assert.deepEqual(parsePath('/decks/42'), { page: 'deck-builder', deckId: 42 });
  });

  test('the id comes back as a number, not the string from the URL', () => {
    // The deck builder passes this straight to the API and compares it to ids
    // from the database, where '42' and 42 are not the same thing.
    assert.equal(typeof parsePath('/decks/42').deckId, 'number');
  });

  test('a trailing slash is the same page', () => {
    assert.deepEqual(parsePath('/inventory/'), { page: 'inventory' });
    assert.deepEqual(parsePath('/decks/42/'), { page: 'deck-builder', deckId: 42 });
  });

  test('nonsense lands on the default rather than throwing', () => {
    // There is no 404 page to send this to, and a router that throws takes
    // the app down on a mistyped bookmark.
    assert.deepEqual(parsePath('/nope'), { page: 'decks' });
    assert.deepEqual(parsePath('/decks/not-a-number'), { page: 'decks' });
    assert.deepEqual(parsePath(''), { page: 'decks' });
    assert.deepEqual(parsePath(undefined), { page: 'decks' });
  });

  test('the trade shop has a path', () => {
    assert.deepEqual(parsePath('/trades/shop'), { page: 'trade-shop' });
    assert.equal(pathFor('trade-shop'), '/trades/shop');
  });

  test('the trade shop path does not swallow the trades list', () => {
    assert.deepEqual(parsePath('/trades'), { page: 'trades' });
  });

  test('shared decks are not this router\'s business', () => {
    // A public page reached by people with no account. Routing it would put
    // it behind the auth check.
    assert.equal(isExternalPath('/share/abc123'), true);
    assert.equal(isExternalPath('/decks'), false);
  });
});

describe('building a URL from a route', () => {
  test('round trips every page', () => {
    for (const page of ['decks', 'cards', 'inventory', 'shopping', 'scan', 'trades', 'trade-shop', 'price-monitoring', 'settings', 'audit']) {
      assert.deepEqual(parsePath(pathFor(page)), { page }, `${page} did not survive the round trip`);
    }
  });

  test('the deck builder round trips with its id', () => {
    assert.equal(pathFor('deck-builder', { deckId: 7 }), '/decks/7');
    assert.deepEqual(parsePath('/decks/7'), { page: 'deck-builder', deckId: 7 });
  });

  test('a deck builder with no id addresses the list instead', () => {
    // Rather than inventing /decks/undefined, which would resolve back to the
    // default page and quietly lose the user.
    assert.equal(pathFor('deck-builder', {}), '/decks');
    assert.equal(pathFor('deck-builder', { deckId: null }), '/decks');
  });

  test('an unknown page falls back rather than producing undefined', () => {
    assert.equal(pathFor('not-a-page'), '/decks');
  });
});
