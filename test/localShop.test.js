import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocate, nameMatches, conditionRank, lookupCards, buildLookupScript,
  parseLookupResult, planPurchases, storeCoverage, RESULT_FORMAT, addCartItems, buildExtensionLookup,
} from '../src/shared/localShop.js';

// Captured from a real TCGplayer Pro storefront (Nov 2026).
const SOL_RING_PRODUCTS = [
  { id: 221310, name: 'Sol Ring', setName: 'Commander Collection: Green' },
  { id: 1571, name: 'Sol Ring', setName: 'Revised Edition' },
  { id: 555449, name: 'Sol Ring (1604) (Rainbow Foil)', setName: 'Secret Lair Drop Series' },
];
const SOL_RING_SKUS = {
  221310: [{ skuId: 4535376, conditionName: 'Near Mint', languageName: 'English', price: 10.66, quantity: 1, isFoil: false }],
  1571: [
    { skuId: 364650, conditionName: 'Lightly Played', languageName: 'English', price: 21.52, quantity: 1, isFoil: false },
    { skuId: 333134, conditionName: 'Moderately Played', languageName: 'English', price: 11.13, quantity: 1, isFoil: false },
    { skuId: 348892, conditionName: 'Heavily Played', languageName: 'English', price: 8.53, quantity: 1, isFoil: false },
  ],
  555449: [{ skuId: 7989729, conditionName: 'Near Mint Foil', languageName: 'English', price: 106.5, quantity: 1, isFoil: true }],
};

const total = (rows) => Math.round(rows.reduce((s, r) => s + r.price * r.qty, 0) * 100) / 100;

test('allocate takes the cheapest copies at or above the minimum condition', () => {
  const card = { name: 'Sol Ring', quantity: 2, foil: false };
  const lp = allocate(card, SOL_RING_PRODUCTS, SOL_RING_SKUS, { minCondition: 'LP', allowFoil: false });
  assert.equal(total(lp.rows), 32.18);
  assert.deepEqual(lp.rows.map((r) => r.set), ['Commander Collection: Green', 'Revised Edition']);

  const hp = allocate(card, SOL_RING_PRODUCTS, SOL_RING_SKUS, { minCondition: 'HP', allowFoil: false });
  assert.equal(total(hp.rows), 19.19);
  assert.deepEqual(hp.rows.map((r) => r.condition), ['Heavily Played', 'Near Mint']);
});

test('allocate reports a shortfall and keeps foils to foil lines', () => {
  const short = allocate({ name: 'Sol Ring', quantity: 5 }, SOL_RING_PRODUCTS, SOL_RING_SKUS, { minCondition: 'NM', allowFoil: false });
  assert.equal(short.taken, 1);
  assert.equal(short.short, 4);

  const foil = allocate({ name: 'Sol Ring', quantity: 1, foil: true }, SOL_RING_PRODUCTS, SOL_RING_SKUS, { minCondition: 'NM' });
  assert.equal(foil.rows[0].skuId, 7989729);
  assert.equal(foil.rows[0].condition, 'Near Mint');
});

test('nameMatches strips variants and refuses tokens', () => {
  assert.ok(nameMatches('Sol Ring', 'Sol Ring'));
  assert.ok(nameMatches('sol ring', 'Sol Ring (1604) (Rainbow Foil)'));
  assert.ok(nameMatches('Sol Ring', 'Sol Ring - Dwarven (0409)'));
  assert.ok(!nameMatches('Sol Ring', 'Sol Ring Token'));
  assert.ok(nameMatches('Fire // Ice', 'Fire // Ice (Borderless)'));
  assert.ok(nameMatches('Fire', 'Fire // Ice'));
});

test('conditionRank reads TCGplayer wording', () => {
  assert.equal(conditionRank('Lightly Played Foil'), 1);
  assert.equal(conditionRank('Damaged'), 4);
  assert.equal(conditionRank('Mystery'), 99);
});

test('lookupCards runs requests one at a time and survives a failing card', async () => {
  const calls = [];
  const io = {
    sleep: async () => {},
    fetchJson: async (path, body) => {
      calls.push(path);
      if (body?.query === 'Broken') { const e = new Error('HTTP 403'); e.status = 403; throw e; }
      if (body) return { products: { totalItems: 4, items: [...SOL_RING_PRODUCTS, { id: 9, name: 'Sol Ring Token' }] } };
      const ids = new URLSearchParams(path.split('?')[1]).get('productIds').split(',').map(Number);
      return ids.map((id) => ({ productId: id, skus: SOL_RING_SKUS[id] || [] }));
    },
  };
  const results = await lookupCards(
    [{ name: 'Sol Ring', quantity: 2 }, { name: 'Broken', quantity: 1 }],
    { minCondition: 'LP' }, io,
  );
  assert.equal(results[0].status, 'ok');
  assert.equal(total(results[0].rows), 32.18);
  assert.equal(results[1].status, 'error');
  assert.equal(calls.length, 3);
});

test('the built script is valid JavaScript with the cards inside', () => {
  const script = buildLookupScript([{ name: "Atraxa, Praetors' Voice", quantity: 1 }]);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /Praetors' Voice/);
});

test('parseLookupResult rejects foreign JSON and tidies rows', () => {
  assert.throws(() => parseLookupResult('{"a":1}'));
  const parsed = parseLookupResult(JSON.stringify({
    format: RESULT_FORMAT, origin: 'https://shop.tcgplayerpro.com/path', fetchedAt: '2026-11-01T00:00:00Z',
    cards: [{ name: 'Sol Ring', quantity: 2, rows: [{ price: '10.66', qty: 1, extra: 'x' }, { price: 3, qty: 0 }] }],
  }));
  assert.equal(parsed.origin, 'https://shop.tcgplayerpro.com');
  assert.equal(parsed.cards[0].rows.length, 1);
  assert.equal(parsed.cards[0].rows[0].price, 10.66);
  assert.equal(parsed.cards[0].rows[0].extra, undefined);
});

test('planPurchases pools stores and online, and lists the online remainder', () => {
  const a = { cards: [{ name: 'Sol Ring', rows: [{ price: 10.66, qty: 1 }, { price: 21.52, qty: 1 }] }] };
  const b = { cards: [{ name: 'sol ring', rows: [{ price: 12, qty: 1 }] }, { name: 'Bolt', rows: [{ price: 5, qty: 1 }] }] };
  const plan = planPurchases(
    [{ name: 'Sol Ring', quantity: 3, onlineUnit: 15 }, { name: 'Bolt', quantity: 1, onlineUnit: 0.5 }, { name: 'Rare', quantity: 1, onlineUnit: null }],
    [{ id: 1, name: 'A', result: a }, { id: 2, name: 'B', result: b }],
  );
  assert.deepEqual(plan.totals[1], { copies: 1, cost: 10.66 });
  assert.deepEqual(plan.totals[2], { copies: 1, cost: 12 });
  assert.deepEqual(plan.online, [{ name: 'Sol Ring', quantity: 1 }, { name: 'Bolt', quantity: 1 }, { name: 'Rare', quantity: 1 }]);
  assert.equal(plan.onlineEstimate, 15.5);
  assert.deepEqual(plan.uncovered, [{ name: 'Rare', quantity: 1 }]);

  assert.deepEqual(storeCoverage([{ name: 'Sol Ring', quantity: 3 }], a), { copies: 2, needed: 3, cost: 32.18 });
});

test('the extension lookup runs in a store page and returns an importable result', async () => {
  const { buildExtensionLookup } = await import('../src/shared/localShop.js');
  const page = {
    location: { origin: 'https://moxvalleygames.tcgplayerpro.com' },
    setTimeout: (f) => f(),
    fetch: async (path, init) => ({ ok: true, json: async () => (init?.method === 'POST'
      ? { products: { totalItems: 3, items: SOL_RING_PRODUCTS } }
      : SOL_RING_PRODUCTS.map((p) => ({ productId: p.id, skus: SOL_RING_SKUS[p.id] }))) }),
  };
  page.globalThis = page;
  new Function(...Object.keys(page), buildExtensionLookup())(...Object.values(page));
  const progress = [];
  const result = await page.__deckLotusLookup([{ name: 'Sol Ring', quantity: 2 }], { minCondition: 'LP' }, (i) => progress.push(i));
  const parsed = parseLookupResult(JSON.stringify(result));
  assert.equal(parsed.origin, 'https://moxvalleygames.tcgplayerpro.com');
  assert.equal(total(parsed.cards[0].rows), 32.18);
  assert.deepEqual(progress, [0, 1]);
});

test("lookup.js ends on a value Firefox can clone back to the extension", async () => {
  const { buildExtensionLookup } = await import('../src/shared/localShop.js');
  const vm = await import('node:vm');
  const completion = vm.runInNewContext(buildExtensionLookup(), { location: { origin: 'https://x.test' } });
  assert.doesNotThrow(() => structuredClone(completion));
});

test('planPurchases sends a slightly dearer store copy to the store within the allowance', () => {
  const cards = [{ name: 'Sol Ring', quantity: 1, onlineUnit: 1.5 }];
  const stores = [{ id: 1, result: { cards: [{ name: 'Sol Ring', rows: [{ skuId: 9, price: 1.6, qty: 1 }] }] } }];
  assert.equal(planPurchases(cards, stores).totals[1].copies, 0, 'no allowance: online wins');
  assert.equal(planPurchases(cards, stores, { localPremium: 0.1 }).totals[1].copies, 1, '10 cents over is within 10 cents');
  assert.equal(planPurchases(cards, stores, { localPremium: 0.05 }).totals[1].copies, 0);
});

test('addCartItems adds to what is already in the cart, re-checks stock and uses the store\'s condition wording', async () => {
  const posts = [];
  const io = {
    sleep: async () => {},
    async fetchJson(path, body) {
      if (path === '/api/cart') return { itemCount: 1, cartItems: [{ skuId: 364650, storePriceCustomId: null, condition: 'Lightly Played', quantity: 1 }] };
      if (path.startsWith('/api/inventory/skus')) {
        return [
          { productId: 1571, skus: [
            { skuId: 364650, conditionName: 'Lightly Played', price: 21.52, quantity: 3 },
            { skuId: 348892, conditionName: 'Heavily Played', price: 9.0, quantity: 1 },
          ] },
          { productId: 221310, skus: [{ skuId: 4535376, conditionName: 'Near Mint', price: 10.66, quantity: 0 }] },
        ];
      }
      if (path === '/api/cart/items') { posts.push(body); return { itemCount: 3 }; }
      throw new Error('unexpected ' + path);
    },
  };
  const results = await addCartItems([
    { name: 'Sol Ring', productId: 1571, skuId: 364650, qty: 1, price: 21.52 },
    { name: 'Sol Ring', productId: 1571, skuId: 348892, qty: 2, price: 8.53 },
    { name: 'Sol Ring', productId: 221310, skuId: 4535376, qty: 1, price: 10.66 },
  ], io);

  assert.deepEqual(posts, [
    { skuId: 364650, storePriceCustomId: null, condition: 'Lightly Played', quantity: 2 },
    { skuId: 348892, storePriceCustomId: null, condition: 'Heavily Played', quantity: 1 },
  ]);
  assert.deepEqual(results.map((r) => [r.status, r.added]), [['added', 1], ['partial', 1], ['gone', 0]]);
  assert.equal(results[1].price, 9.0, 'the current price is reported');
});

test('the extension lookup carries the cart function; the console script does not', () => {
  assert.match(buildExtensionLookup(), /__deckLotusCart/);
  assert.doesNotMatch(buildLookupScript([{ name: 'Sol Ring', quantity: 1 }]), /api\/cart/);
});
