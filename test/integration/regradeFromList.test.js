/**
 * Bulk Add's "Update condition only": regrade owned copies from a pasted list.
 *
 * What would quietly go wrong: adding cards (it must never), undoing hand
 * grading by default, two lines claiming the same copies, and a repeat paste
 * regrading more copies the second time. Each is pinned here.
 *
 * Run with `npm run test:integration`.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-regrade-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { addOwnedPrintingQuantity } = await import('../../src/services/cardService.js');
const { regradeFromList } = await import('../../src/services/inventoryService.js');
const { parseCardLine } = await import('../../src/shared/cardLines.js');

let user;
let shockA; // FDN 1
let shockB; // M21 5
let bolt;   // FDN 2

const rows = (printingId) => db.all(
  `SELECT condition, is_foil, quantity FROM owned_printings
    WHERE user_id = ? AND printing_id = ? AND quantity > 0 ORDER BY is_foil, condition`,
  [user, printingId]
);
const total = () => db.get(`SELECT SUM(quantity) AS n FROM owned_printings WHERE user_id = ?`, [user]).n;

/** Same shape the Bulk Add box sends. */
const items = (text) => text.split('\n').map(parseCardLine).filter(Boolean)
  .map(({ name, setCode, collectorNumber, quantity, isFoil, condition }) => ({
    cardName: name, setCode, collectorNumber, quantity, isFoil, ...(condition ? { condition } : {}),
  }));

before(async () => {
  await runMigrations();
  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('u', 'u@example.com', 'x')`);
  user = db.get(`SELECT id FROM users WHERE username = 'u'`).id;
  db.run(`INSERT INTO sets (code, name) VALUES ('FDN', 'Foundations'), ('M21', 'Core Set 2021')`);
  const card = (name) => {
    db.run(`INSERT INTO cards (name, name_normalized, type_line) VALUES (?, ?, 'Instant')`, [name, name.toLowerCase()]);
    return db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
  };
  const printing = (cardId, uuid, set, num) => {
    db.run(`INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity) VALUES (?, ?, ?, ?, 'common')`,
      [cardId, uuid, set, num]);
    return db.get(`SELECT id FROM printings WHERE uuid = ?`, [uuid]).id;
  };
  const shock = card('Shock');
  shockA = printing(shock, 'u-shock-a', 'FDN', '1');
  shockB = printing(shock, 'u-shock-b', 'M21', '5');
  bolt = printing(card('Burst Lightning'), 'u-burst', 'FDN', '2');

  addOwnedPrintingQuantity(user, shockA, 3, false);
  addOwnedPrintingQuantity(user, shockA, 1, false, { condition: 'NM' });
  addOwnedPrintingQuantity(user, shockB, 1, false);
  addOwnedPrintingQuantity(user, bolt, 2, false);
});

test('dry run writes nothing', () => {
  const before = JSON.stringify(rows(shockA));
  const plan = regradeFromList(user, items('2 *HP* FDN 1'), { dryRun: true });
  assert.equal(plan.regraded, 2);
  assert.equal(JSON.stringify(rows(shockA)), before);
});

test('the marker after the quantity works, ungraded copies move, graded ones stay, nothing is added', () => {
  const start = total();
  const result = regradeFromList(user, items('2 *HP* FDN 1'));
  assert.equal(result.regraded, 2);
  assert.deepEqual(rows(shockA), [
    { condition: '', is_foil: 0, quantity: 1 },
    { condition: 'HP', is_foil: 0, quantity: 2 },
    { condition: 'NM', is_foil: 0, quantity: 1 },
  ]);
  assert.equal(total(), start);
});

test('pasting the same list again changes nothing', () => {
  const result = regradeFromList(user, items('2 *HP* FDN 1'));
  assert.equal(result.regraded, 0);
  assert.equal(result.lines[0].already, 2);
  assert.equal(result.lines[0].problem, null);
});

test('a shortfall is reported, mentioning graded copies left alone', () => {
  // FDN 1 holds 2 HP, 1 ungraded, 1 NM: asking for 4 MP gets the 1 ungraded.
  const plan = regradeFromList(user, items('4 *MP* FDN 1'), { dryRun: true });
  assert.equal(plan.regraded, 1);
  assert.match(plan.lines[0].problem, /Only 1 of 4.*3 more are already graded/);
});

test('includeGraded takes graded copies too, worst first', () => {
  const plan = regradeFromList(user, items('3 *MP* FDN 1'), { dryRun: true, includeGraded: true });
  assert.deepEqual(plan.lines[0].moves.map((m) => [m.from, m.count]), [['', 1], ['HP', 2]]);
});

test('a bare name spreads over owned printings, and two lines cannot claim the same copy', () => {
  // Shock ungraded: 1 on FDN 1, 1 on M21 5.
  const result = regradeFromList(user, items('1 Shock *LP*\n1 Shock *LP*\n1 Shock *LP*'));
  assert.equal(result.regraded, 2);
  assert.equal(result.lines[2].done, 0);
  assert.ok(result.lines[2].problem);
  assert.deepEqual(rows(shockB), [{ condition: 'LP', is_foil: 0, quantity: 1 }]);
});

test('problem lines: no condition, not owned, foil not owned', () => {
  const plan = regradeFromList(user, items('1 FDN 2\n1 *HP* FDN 99\n1 *HP* *F* FDN 2'), { dryRun: true });
  assert.match(plan.lines[0].problem, /No condition/);
  assert.ok(plan.lines[1].problem);
  assert.match(plan.lines[2].problem, /as a foil/);
  assert.equal(plan.regraded, 0);
});

test('one batchId, source bulk_condition', () => {
  const { batchId } = regradeFromList(user, items('2 *DMG* FDN 2'));
  const audit = db.all(`SELECT source FROM audit_log WHERE user_id = ? AND detail LIKE ?`, [user, `%${batchId}%`]);
  assert.ok(audit.length >= 2);
  assert.ok(audit.every((a) => a.source === 'bulk_condition'));
  assert.deepEqual(rows(bolt), [{ condition: 'DMG', is_foil: 0, quantity: 2 }]);
});
