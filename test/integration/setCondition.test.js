/**
 * Regrading in bulk and in part.
 *
 * "Set condition" exists for one case above all — a new collection that is
 * all Near Mint — and what would quietly go wrong is it undoing grading done
 * by hand. So the default touches only unrecorded copies, and that is what
 * is pinned first. A partial regrade ("1 of my 4 NM is LP") must leave the
 * rest where they were, finish included.
 *
 * Run with `npm run test:integration`.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-setcond-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { addOwnedPrintingQuantity, changeOwnedCondition } = await import('../../src/services/cardService.js');
const { setConditionForCards } = await import('../../src/services/inventoryService.js');

let user;
let other;
let shock;
let bolt;
let shockCard;

const rows = (userId, printingId) => db.all(
  `SELECT condition, is_foil, quantity FROM owned_printings
    WHERE user_id = ? AND printing_id = ? ORDER BY is_foil, condition`,
  [userId, printingId]
);

before(async () => {
  await runMigrations();
  const mk = (name) => {
    db.run(`INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')`, [name, `${name}@example.com`]);
    return db.get(`SELECT id FROM users WHERE username = ?`, [name]).id;
  };
  user = mk('owner');
  other = mk('other');
  db.run(`INSERT INTO sets (code, name) VALUES ('FDN', 'Foundations')`);
  const card = (name) => {
    db.run(`INSERT INTO cards (name, name_normalized, type_line) VALUES (?, ?, 'Instant')`, [name, name.toLowerCase()]);
    return db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
  };
  shockCard = card('Shock');
  const printing = (cardId, uuid, num) => {
    db.run(`INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity) VALUES (?, ?, 'FDN', ?, 'common')`,
      [cardId, uuid, num]);
    return db.get(`SELECT id FROM printings WHERE uuid = ?`, [uuid]).id;
  };
  shock = printing(shockCard, 'u-shock', '1');
  bolt = printing(card('Burst Lightning'), 'u-burst', '2');
});

test('whole collection: only unrecorded copies change, hand grading survives', () => {
  addOwnedPrintingQuantity(user, shock, 3, false);
  addOwnedPrintingQuantity(user, shock, 1, true);
  addOwnedPrintingQuantity(user, bolt, 2, false, { condition: 'LP' });
  addOwnedPrintingQuantity(other, shock, 2, false);

  const result = setConditionForCards(user, { to: 'NM' });
  assert.equal(result.copies, 4);
  assert.deepEqual(rows(user, shock), [
    { condition: 'NM', is_foil: 0, quantity: 3 },
    { condition: 'NM', is_foil: 1, quantity: 1 },
  ]);
  assert.deepEqual(rows(user, bolt), [{ condition: 'LP', is_foil: 0, quantity: 2 }]);
  assert.deepEqual(rows(other, shock), [{ condition: '', is_foil: 0, quantity: 2 }], 'another user is untouched');
});

test('selected cards with overwrite regrade graded copies too, and only those cards', () => {
  setConditionForCards(user, { cardIds: [shockCard], to: 'MP', overwrite: true });
  assert.deepEqual(rows(user, shock), [
    { condition: 'MP', is_foil: 0, quantity: 3 },
    { condition: 'MP', is_foil: 1, quantity: 1 },
  ]);
  assert.deepEqual(rows(user, bolt), [{ condition: 'LP', is_foil: 0, quantity: 2 }]);
});

test('one batchId stamps every audit row of a bulk regrade', () => {
  const { batchId } = setConditionForCards(user, { cardIds: [shockCard], to: 'NM', overwrite: true });
  const audit = db.all(`SELECT source, detail FROM audit_log WHERE user_id = ? AND detail LIKE ?`, [user, `%${batchId}%`]);
  assert.ok(audit.length >= 2);
  assert.ok(audit.every((a) => a.source === 'bulk_condition'));
});

test('a partial regrade moves only that many copies', () => {
  changeOwnedCondition(user, shock, false, 'NM', 'LP', { quantity: 1 });
  assert.deepEqual(rows(user, shock), [
    { condition: 'LP', is_foil: 0, quantity: 1 },
    { condition: 'NM', is_foil: 0, quantity: 2 },
    { condition: 'NM', is_foil: 1, quantity: 1 },
  ]);
});

test('a partial regrade refuses more copies than the row holds', () => {
  assert.throws(() => changeOwnedCondition(user, shock, false, 'NM', 'LP', { quantity: 5 }), /Cannot regrade/);
  assert.throws(() => changeOwnedCondition(user, shock, false, 'NM', 'LP', { quantity: 0 }), /Cannot regrade/);
});
