/**
 * The price that comes back from adding a card — the toast after a quick add
 * and the receipt after a bulk add.
 *
 * Priced the way the collection value prices a copy: the finish's own
 * tcgplayer price, a foil falling back to normal. An unpriced printing comes
 * back as null rather than 0, because the receipt's "no price" band and its
 * "under $1" band are different claims.
 *
 * Run with `npm run test:integration`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-receipt-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { bulkAddToInventory, describeAddedPrinting } =
  await import('../../src/services/inventoryService.js');
const { priceBand } = await import('../../src/shared/priceBands.js');

let userId;
const ids = {};

before(async () => {
  await runMigrations();

  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('receipt','rcpt@example.com','x')`);
  userId = db.get(`SELECT id FROM users WHERE username='receipt'`).id;
  db.run(`INSERT INTO sets (code, name) VALUES ('AAA','Set A')`);

  const card = (key, name, collector, { normal = null, foil = null } = {}) => {
    db.run(
      `INSERT INTO cards (name, name_normalized, type_line, color_identity) VALUES (?,?,'Instant','R')`,
      [name, name.toLowerCase()]
    );
    const cardId = db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
    const uuid = `uuid-${collector}`;
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity) VALUES (?,?,'AAA',?,'rare')`,
      [cardId, uuid, collector]
    );
    ids[key] = db.get(`SELECT id FROM printings WHERE uuid = ?`, [uuid]).id;
    if (normal != null) db.run(`INSERT INTO prices (printing_uuid, provider, price_type, price) VALUES (?, 'tcgplayer', 'normal', ?)`, [uuid, normal]);
    if (foil != null) db.run(`INSERT INTO prices (printing_uuid, provider, price_type, price) VALUES (?, 'tcgplayer', 'foil', ?)`, [uuid, foil]);
  };

  card('bolt', 'Lightning Bolt', '1', { normal: 2.5, foil: 12 });
  card('opt', 'Opt', '2', { normal: 0.25 });
  card('mystery', 'Mystery Card', '3');
});

after(() => {
  closeDb();
});

test('a foil is priced at its foil price, and falls back to normal when it has none', () => {
  assert.deepEqual(
    { price: describeAddedPrinting(ids.bolt, true, 1).price, type: describeAddedPrinting(ids.bolt, true, 1).priceType },
    { price: 12, type: 'foil' }
  );
  const optFoil = describeAddedPrinting(ids.opt, true, 1);
  assert.equal(optFoil.price, 0.25);
  assert.equal(optFoil.priceType, 'normal');
});

test('an unpriced printing reads as unknown, not as cheap', () => {
  const mystery = describeAddedPrinting(ids.mystery, false, 1);
  assert.equal(mystery.price, null);
  assert.equal(priceBand(mystery.price).key, 'unknown');
  assert.equal(priceBand(0.25).key, 'grey');
  assert.equal(priceBand(0).key, 'grey');
});

test('bands match the companion app thresholds', () => {
  assert.deepEqual(
    [20, 19.99, 10, 5, 4.99, 1, 0.99].map((p) => priceBand(p).key),
    ['purple', 'blue', 'blue', 'green', 'yellow', 'yellow', 'grey']
  );
});

test('bulk add returns one priced line per entry that landed', () => {
  const result = bulkAddToInventory(userId, [
    { cardName: 'Lightning Bolt', quantity: 2, isFoil: true },
    { setCode: 'AAA', collectorNumber: '2', quantity: 4 },
    { cardName: 'Mystery Card' },
    { cardName: 'No Such Card' },
  ]);

  assert.equal(result.added, 7);
  assert.equal(result.failed, 1);
  assert.deepEqual(
    result.cards.map((c) => [c.name, c.quantity, c.isFoil, c.price]),
    [
      ['Lightning Bolt', 2, true, 12],
      ['Opt', 4, false, 0.25],
      ['Mystery Card', 1, false, null],
    ]
  );
});
