/**
 * Bulk remove is the destructive twin of bulk add, so the things worth pinning
 * are the ones that would quietly take away the wrong copies: a nameless line
 * landing on a printing that is not owned, a foil row absorbing a non-foil
 * removal, and a line asking for more than is there emptying the row and
 * calling it a failure.
 *
 * Run with `npm run test:integration`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-remove-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { bulkAddToInventory, bulkRemoveFromInventory, resolveBulkRemoveItems } =
  await import('../../src/services/inventoryService.js');

let userId;
const printings = {};

const owned = (key, isFoil = false) => db.get(
  `SELECT quantity FROM owned_printings WHERE user_id = ? AND printing_id = ? AND is_foil = ?`,
  [userId, printings[key].printingId, isFoil ? 1 : 0]
)?.quantity ?? 0;

before(async () => {
  await runMigrations();

  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('remover','r@example.com','x')`);
  userId = db.get(`SELECT id FROM users WHERE username='remover'`).id;

  db.run(`INSERT INTO sets (code, name) VALUES ('AAA','Cheap Set')`);
  db.run(`INSERT INTO sets (code, name) VALUES ('BBB','Other Set')`);

  db.run(
    `INSERT INTO cards (name, name_normalized, type_line, color_identity)
     VALUES ('Lightning Bolt','lightning bolt','Instant','R')`
  );
  const cardId = db.get(`SELECT id FROM cards WHERE name='Lightning Bolt'`).id;

  // Two printings of one card, priced so the cheapest — the one bulk *add*
  // would pick for a nameless line — is the one nothing is owned of.
  const printing = (key, setCode, collector, price) => {
    const uuid = `uuid-${key}`;
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity)
       VALUES (?,?,?,?,'common')`,
      [cardId, uuid, setCode, collector]
    );
    db.run(
      `INSERT INTO prices (printing_uuid, provider, price_type, price)
       VALUES (?,'tcgplayer','normal',?)`,
      [uuid, price]
    );
    printings[key] = { cardId, printingId: db.get(`SELECT id FROM printings WHERE uuid = ?`, [uuid]).id };
  };

  printing('cheap', 'AAA', '1', 0.10);
  printing('pricey', 'BBB', '2', 9.99);

  db.run(
    `INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,4,0)`,
    [userId, printings.pricey.printingId]
  );
  db.run(
    `INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,2,1)`,
    [userId, printings.pricey.printingId]
  );
  db.run(
    `INSERT INTO owned_cards (user_id, card_id, quantity) VALUES (?,?,1)`,
    [userId, cardId]
  );
});

after(() => {
  closeDb();
  fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });
});

test('a nameless line removes from a printing that is owned, not the cheapest one', () => {
  const [preview] = resolveBulkRemoveItems(userId, [{ cardName: 'Lightning Bolt', quantity: 1 }]);

  assert.equal(preview.resolved, true);
  assert.equal(preview.printingId, printings.pricey.printingId);
  assert.equal(preview.owned, 4);

  const result = bulkRemoveFromInventory(userId, [{ cardName: 'Lightning Bolt', quantity: 1 }]);

  assert.equal(result.removed, 1);
  assert.equal(result.failed, 0);
  assert.equal(owned('pricey'), 3);
  assert.equal(owned('cheap'), 0);
});

test('foil and non-foil rows are removed from separately', () => {
  const result = bulkRemoveFromInventory(userId, [
    { cardName: 'Lightning Bolt', quantity: 2, isFoil: true },
  ]);

  assert.equal(result.removed, 2);
  assert.equal(owned('pricey', true), 0, 'the foil row is emptied');
  assert.equal(owned('pricey'), 3, 'the non-foil row is untouched');
});

test('asking for more copies than are owned removes what is there and warns', () => {
  const result = bulkRemoveFromInventory(userId, [
    { cardName: 'Lightning Bolt', setCode: 'BBB', collectorNumber: '2', quantity: 10 },
  ]);

  assert.equal(result.removed, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /Only 3 of 10/);
  assert.equal(owned('pricey'), 0);
});

test('emptying the last printing clears owned_cards too', () => {
  const row = db.get(
    `SELECT COUNT(*) as count FROM owned_cards WHERE user_id = ? AND card_id = ?`,
    [userId, printings.pricey.cardId]
  );

  assert.equal(row.count, 0);
});

test('a card that is not in the collection is a failure, not a silent no-op', () => {
  const result = bulkRemoveFromInventory(userId, [{ cardName: 'Lightning Bolt', quantity: 1 }]);

  assert.equal(result.removed, 0);
  assert.equal(result.failed, 1);
});

test('a removal is written to the audit log as its own batch', () => {
  bulkAddToInventory(userId, [{ setCode: 'AAA', collectorNumber: '1', quantity: 2 }]);
  const result = bulkRemoveFromInventory(userId, [
    { setCode: 'AAA', collectorNumber: '1', quantity: 2 },
  ]);

  assert.equal(result.removed, 2);
  assert.equal(owned('cheap'), 0);

  const entry = db.get(
    `SELECT source, quantity_before, quantity_after, detail FROM audit_log
      WHERE user_id = ? AND source = 'bulk_remove' ORDER BY id DESC LIMIT 1`,
    [userId]
  );

  assert.ok(entry, 'the removal is in the history');
  assert.equal(entry.quantity_before, 2);
  assert.equal(entry.quantity_after, 0);
  assert.equal(JSON.parse(entry.detail).batchId, result.batchId);
});
