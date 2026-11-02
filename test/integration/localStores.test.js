/**
 * Local stores: shared across the household, each user with their own
 * hidden/checking say and their own pasted lookup, filed by origin.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-stores-')), 'test.db');

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const stores = await import('../../src/services/localStoreService.js');
const { RESULT_FORMAT } = await import('../../src/shared/localShop.js');

let me;
let them;

const result = (origin, price) => JSON.stringify({
  format: RESULT_FORMAT, origin, fetchedAt: '2026-11-01T12:00:00Z',
  cards: [{ name: 'Sol Ring', quantity: 1, status: 'ok', rows: [{ price, qty: 1, set: 'Revised Edition' }] }],
});

before(async () => {
  await runMigrations();
  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('a','a@example.test','h'), ('b','b@example.test','h')`);
  me = db.get(`SELECT id FROM users WHERE username='a'`).id;
  them = db.get(`SELECT id FROM users WHERE username='b'`).id;
});

after(() => closeDb());

test('store addresses are normalised to an https origin', () => {
  const store = stores.addStore(me, { name: 'Mox Valley', baseUrl: 'moxvalleygames.tcgplayerpro.com/search?q=x' });
  assert.equal(store.baseUrl, 'https://moxvalleygames.tcgplayerpro.com');
  assert.throws(() => stores.addStore(me, { name: 'Plain', baseUrl: 'http://example.com' }), /https/);
});

test("a store one member adds shows up for everyone, credited to them", () => {
  const [seen] = stores.listStores(them);
  assert.equal(seen.name, 'Mox Valley');
  assert.equal(seen.addedBy, 'a');
  assert.equal(seen.checking, true);
  assert.equal(seen.hidden, false);
  // Adding the same address again is the same shop, not a second row.
  stores.addStore(them, { name: 'Mox', baseUrl: 'https://moxvalleygames.tcgplayerpro.com/' });
  assert.equal(db.get(`SELECT COUNT(*) c FROM local_stores`).c, 1);
});

test('lookups are per member and re-pasting replaces the last one', () => {
  stores.importResult(me, result('https://moxvalleygames.tcgplayerpro.com', 8.53));
  const updated = stores.importResult(me, result('https://moxvalleygames.tcgplayerpro.com', 9));
  assert.equal(updated.result.cards[0].rows[0].price, 9);
  assert.equal(stores.listStores(them)[0].result, null);
  stores.importResult(them, result('https://moxvalleygames.tcgplayerpro.com', 7));
  assert.equal(stores.listStores(me)[0].result.cards[0].rows[0].price, 9);
  assert.equal(db.get(`SELECT COUNT(*) c FROM local_store_quotes`).c, 2);
});

test('a result from a store nobody added is refused', () => {
  assert.throws(() => stores.importResult(me, result('https://other.tcgplayerpro.com', 1)), /not one of your stores/);
});

test('leaving a store out of price checks is your own setting', () => {
  const [store] = stores.listStores(me);
  stores.setStorePrefs(them, store.id, { checking: false });
  assert.equal(stores.listStores(them)[0].checking, false);
  assert.equal(stores.listStores(me)[0].checking, true);
});

test('removing hides it for you only; the row goes once nobody sees it', () => {
  const [store] = stores.listStores(me);
  stores.removeStore(them, store.id);
  assert.equal(stores.listStores(them)[0].hidden, true);
  assert.equal(stores.listStores(them)[0].result, null);
  assert.equal(stores.listStores(me)[0].hidden, false);
  // Adding it again brings it back.
  assert.equal(stores.addStore(them, { name: 'x', baseUrl: store.baseUrl }).hidden, false);
  stores.removeStore(them, store.id);
  stores.removeStore(me, store.id);
  assert.equal(db.get(`SELECT COUNT(*) c FROM local_stores`).c, 0);
});

test('changing the address drops the old snapshots', () => {
  const store = stores.addStore(me, { name: 'Mox Valley', baseUrl: 'https://moxvalleygames.tcgplayerpro.com' });
  stores.importResult(me, result(store.baseUrl, 9));
  const moved = stores.updateStore(them, store.id, { baseUrl: 'https://moved.tcgplayerpro.com' });
  assert.equal(moved.result, null);
  assert.equal(stores.listStores(me)[0].result, null);
  assert.throws(() => stores.removeStore(me, 9999), /not found/);
});

test('the script carries the cards', () => {
  const { script, cards } = stores.buildScript({ cards: [{ name: 'Sol Ring', quantity: 2 }, { name: ' ' }] });
  assert.equal(cards, 1);
  assert.match(script, /"Sol Ring","quantity":2/);
});
