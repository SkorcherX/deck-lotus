import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseWatchConditions, priceTier, formatWatchConditions } from '../src/shared/watchConditions.js';
import { getLowestPrice } from '../src/services/manaPoolService.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFeed(rows) {
  process.env.MANAPOOL_API_TOKEN = 'test';
  process.env.MANAPOOL_USER_EMAIL = 'test@example.test';
  globalThis.fetch = async () => new Response(JSON.stringify({ data: rows }));
}

test('ticked sets map to the feed price that answers them', () => {
  assert.equal(priceTier(['nm']), 'nm');
  assert.equal(priceTier(['lp', 'nm']), 'lp');
  assert.equal(priceTier(['nm', 'lp', 'mp', 'hp', 'dm']), 'any');
});

test('sets the feed cannot answer have no tier', () => {
  for (const codes of [[], ['lp'], ['mp'], ['nm', 'lp', 'mp'], ['nm', 'dm']]) {
    assert.equal(priceTier(codes), null, codes.join());
  }
});

test('single values saved before lists keep a priceable meaning', () => {
  for (const legacy of ['any', 'nm', 'lp', 'mp', 'hp', 'dm']) {
    assert.notEqual(priceTier(parseWatchConditions(legacy)), null, legacy);
  }
  assert.deepEqual(parseWatchConditions('lp'), ['nm', 'lp']);
  assert.equal(formatWatchConditions('any'), 'Any');
  assert.equal(formatWatchConditions('nm,lp'), 'NM, LP');
});

test('each tier reads its own price', async () => {
  stubFeed([{ name: 'Sol Ring', price_cents: 100, price_cents_lp_plus: 200, price_cents_nm: 300 }]);
  assert.equal((await getLowestPrice('Sol Ring', 'any')).lowPrice, 1);
  assert.equal((await getLowestPrice('Sol Ring', 'lp')).lowPrice, 2);
  assert.equal((await getLowestPrice('Sol Ring', 'nm')).lowPrice, 3);
});

test('a worse copy never stands in for a condition that was not ticked', async () => {
  stubFeed([{ name: 'Sol Ring', price_cents: 100, price_cents_lp_plus: null, price_cents_nm: null }]);
  assert.equal(await getLowestPrice('Sol Ring', 'nm'), null);
  assert.equal(await getLowestPrice('Sol Ring', 'lp'), null);
});

test('a card missing from the feed is unpriced unless any condition will do', async () => {
  stubFeed([]);
  assert.equal(await getLowestPrice('Sol Ring', 'lp'), null);
});
