/**
 * Removing selected cards, and getting them back from the audit log.
 *
 * The recovery is only worth offering if it is a real round trip: the rows a
 * removal took away, turned into text and pasted into Bulk Add, land on the
 * same printings in the same finishes. Foil is the part most likely to fall
 * off — it is half the unique key on `owned_printings` — so the fixture owns
 * one printing in both.
 *
 * Run with `npm run test:integration`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-recover-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { bulkAddToInventory, removeCardsFromCollection } =
  await import('../../src/services/inventoryService.js');
const { listAuditEntries } = await import('../../src/services/auditService.js');
const { buildImportList, isRecoverable } = await import('../../src/shared/auditRecovery.js');
const { parseCardLine } = await import('../../src/shared/cardLines.js');

let userId;
const ids = {};

const owned = (key, isFoil = false) => db.get(
  `SELECT quantity FROM owned_printings WHERE user_id = ? AND printing_id = ? AND is_foil = ?`,
  [userId, ids[key], isFoil ? 1 : 0]
)?.quantity ?? 0;

before(async () => {
  await runMigrations();

  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('recoverer','rc@example.com','x')`);
  userId = db.get(`SELECT id FROM users WHERE username='recoverer'`).id;

  db.run(`INSERT INTO sets (code, name) VALUES ('AAA','Set A')`);

  const card = (name, collector) => {
    db.run(
      `INSERT INTO cards (name, name_normalized, type_line, color_identity) VALUES (?,?,'Instant','R')`,
      [name, name.toLowerCase()]
    );
    const cardId = db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity) VALUES (?,?,'AAA',?,'common')`,
      [cardId, `uuid-${collector}`, collector]
    );
    return { cardId, printingId: db.get(`SELECT id FROM printings WHERE uuid = ?`, [`uuid-${collector}`]).id };
  };

  const bolt = card('Lightning Bolt', '1');
  const shock = card('Shock', '2');
  const keep = card('Opt', '3');
  ids.bolt = bolt.printingId;
  ids.shock = shock.printingId;
  ids.keep = keep.printingId;
  ids.boltCard = bolt.cardId;
  ids.shockCard = shock.cardId;

  for (const [printingId, quantity, foil] of [
    [ids.bolt, 3, 0], [ids.bolt, 1, 1], [ids.shock, 2, 0], [ids.keep, 4, 0],
  ]) {
    db.run(
      `INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,?,?)`,
      [userId, printingId, quantity, foil]
    );
  }
});

after(() => {
  closeDb();
});

test('removing selected cards takes every finish, leaves the rest, and restores from the audit log', async () => {
  const result = removeCardsFromCollection(userId, [ids.boltCard, ids.shockCard]);

  assert.equal(result.removedCards, 2);
  assert.equal(result.removedCopies, 6);
  assert.equal(owned('bolt'), 0);
  assert.equal(owned('bolt', true), 0);
  assert.equal(owned('shock'), 0);
  assert.equal(owned('keep'), 4, 'an unselected card is untouched');

  const { entries } = listAuditEntries([userId], { batchId: result.batchId, limit: 200 });
  assert.equal(entries.length, 3, 'one audit row per printing and finish');
  assert.ok(entries.every(isRecoverable));

  const text = buildImportList(entries);
  assert.equal(text, [
    '3 Lightning Bolt (AAA) 1',
    '1 Lightning Bolt (AAA) 1 *F*',
    '2 Shock (AAA) 2',
  ].join('\n'));

  // Through the same parser and bulk-add path the Inventory page uses.
  const items = text.split('\n').map(parseCardLine).map(({ name, ...rest }) => ({ cardName: name, ...rest }));
  await bulkAddToInventory(userId, items);

  assert.equal(owned('bolt'), 3);
  assert.equal(owned('bolt', true), 1);
  assert.equal(owned('shock'), 2);
  assert.equal(owned('keep'), 4);
});

test('trade removals are not offered back', () => {
  assert.equal(isRecoverable({
    entity_type: 'inventory', quantity_delta: -1, source: 'trade', card_name: 'Opt',
  }), false);
});
