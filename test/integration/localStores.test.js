/**
 * Local stores: a pasted result files under the store at its origin, never
 * under another user's store, and re-pasting replaces the snapshot.
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
  assert.throws(() => stores.addStore(me, { name: 'Dup', baseUrl: 'https://moxvalleygames.tcgplayerpro.com/' }), /already/);
  assert.throws(() => stores.addStore(me, { name: 'Plain', baseUrl: 'http://example.com' }), /https/);
});

test('a result files under the store at its origin and replaces the last one', () => {
  stores.importResult(me, result('https://moxvalleygames.tcgplayerpro.com', 8.53));
  const updated = stores.importResult(me, result('https://moxvalleygames.tcgplayerpro.com', 9));
  assert.equal(updated.result.cards[0].rows[0].price, 9);
  assert.equal(db.get(`SELECT COUNT(*) c FROM local_store_quotes`).c, 1);
});

test("a result from someone else's store is refused", () => {
  stores.addStore(them, { name: 'Other', baseUrl: 'https://other.tcgplayerpro.com' });
  assert.throws(() => stores.importResult(me, result('https://other.tcgplayerpro.com', 1)), /not one of your stores/);
  assert.equal(stores.listStores(them)[0].result, null);
});

test('changing the address drops the old snapshot', () => {
  const [store] = stores.listStores(me);
  const moved = stores.updateStore(me, store.id, { baseUrl: 'https://moved.tcgplayerpro.com' });
  assert.equal(moved.result, null);
  assert.throws(() => stores.removeStore(them, store.id), /not found/);
});

test('the script carries the cards', () => {
  const { script, cards } = stores.buildScript({ cards: [{ name: 'Sol Ring', quantity: 2 }, { name: ' ' }] });
  assert.equal(cards, 1);
  assert.match(script, /"Sol Ring","quantity":2/);
});
