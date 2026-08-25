import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isBasicLand, isBasicLandSql } from '../src/services/basicLands.js';

/**
 * The rule that decides what never appears on a shopping list.
 *
 * Worth pinning down because both directions are expensive to get wrong: too
 * loose and a $40 fetchland silently drops off the list you shop from, too
 * tight and every Commander deck reads as short two dozen Islands.
 */
describe('basic lands', () => {
  test('a basic land is one', () => {
    assert.equal(isBasicLand({ supertypes: 'Basic', type_line: 'Basic Land — Island' }), true);
  });

  test('the type line alone is enough, for rows imported before supertypes', () => {
    assert.equal(isBasicLand({ type_line: 'Basic Land — Mountain' }), true);
  });

  test('Snow-Covered basics count — they are still basics', () => {
    assert.equal(isBasicLand({ supertypes: 'Basic,Snow', type_line: 'Basic Snow Land — Forest' }), true);
  });

  test('a fetchland is a card you have to buy', () => {
    assert.equal(isBasicLand({ supertypes: null, type_line: 'Land' }), false);
  });

  test('a dual is a card you have to buy, supertype or not', () => {
    assert.equal(isBasicLand({ supertypes: 'Legendary', type_line: 'Legendary Land' }), false);
  });

  test('a Basic supertype without a land type is not a land', () => {
    // No such card today, but the predicate ANDs the two for a reason and a
    // future one should not turn free.
    assert.equal(isBasicLand({ supertypes: 'Basic', type_line: 'Basic Artifact' }), false);
  });

  test('a missing card is not a basic land', () => {
    assert.equal(isBasicLand(null), false);
    assert.equal(isBasicLand({}), false);
  });

  test('the SQL form aliases every column it touches', () => {
    const sql = isBasicLandSql('zz');
    assert.match(sql, /zz\.supertypes/);
    assert.match(sql, /zz\.type_line/);
    assert.ok(!/[^z]c\.(supertypes|type_line)/.test(sql), 'no unaliased column leaked through');
  });
});
