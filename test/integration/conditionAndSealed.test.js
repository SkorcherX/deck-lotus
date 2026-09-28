/**
 * Card condition is optional and part of an owned row's key; sealed product
 * is tracked in lots. What is pinned here is what would quietly go wrong:
 * condition-unaware paths no longer behaving as they did, a trade dropping a
 * grade, a CardCastle import losing condition or finish, and sealed rows
 * failing to find their catalog entry.
 *
 * Run with `npm run test:integration`.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-condition-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { setOwnedPrintingQuantity, addOwnedPrintingQuantity, takeOwnedCopies, ownedPrintingTotal } =
  await import('../../src/services/cardService.js');
const { bulkRemoveFromInventory } = await import('../../src/services/inventoryService.js');
const { importCardCastleSingles } = await import('../../src/services/cardCastleImport.js');
const { importSealedCsv, listSealed, addSealed } = await import('../../src/services/sealedService.js');

let alice;
let bob;
let bolt;
let fox;

const rows = (userId, printingId) => db.all(
  `SELECT condition, is_foil, quantity FROM owned_printings
    WHERE user_id = ? AND printing_id = ? ORDER BY is_foil, condition`,
  [userId, printingId]
);

before(async () => {
  await runMigrations();
  const user = (name) => {
    db.run(`INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')`, [name, `${name}@example.com`]);
    return db.get(`SELECT id FROM users WHERE username = ?`, [name]).id;
  };
  alice = user('alice');
  bob = user('bob');

  db.run(`INSERT INTO sets (code, name) VALUES ('NEO', 'Kamigawa: Neon Dynasty')`);
  db.run(`INSERT INTO sets (code, name) VALUES ('AKH', 'Amonkhet Invocations')`);
  const card = (name) => {
    db.run(`INSERT INTO cards (name, name_normalized, type_line) VALUES (?, ?, 'Creature')`, [name, name.toLowerCase()]);
    return db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
  };
  const printing = (cardId, uuid, set, num, sfid) => {
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity, scryfall_id)
       VALUES (?, ?, ?, ?, 'common', ?)`,
      [cardId, uuid, set, num, sfid]
    );
    return db.get(`SELECT id FROM printings WHERE uuid = ?`, [uuid]).id;
  };
  bolt = printing(card('Armguard Familiar'), 'u-bolt', 'NEO', '46', 'sf-armguard');
  fox = printing(card('Rhonas the Indomitable'), 'u-rhonas', 'AKH', '28', 'sf-rhonas');

  db.run(`INSERT INTO sealed_products (uuid, name, name_normalized, set_code, category)
          VALUES ('s-neo-set', 'Kamigawa: Neon Dynasty Set Booster Box', 'kamigawa neon dynasty set box', 'NEO', 'booster_box')`);
  db.run(`INSERT INTO sealed_products (uuid, name, name_normalized, set_code, category)
          VALUES ('s-neo-draft', 'Kamigawa: Neon Dynasty Draft Booster Box', 'kamigawa neon dynasty draft box', 'NEO', 'booster_box')`);
  db.run(`INSERT INTO sealed_prices (sealed_uuid, price) VALUES ('s-neo-draft', 250)`);
});

test('without a condition, the setter behaves exactly as before', () => {
  setOwnedPrintingQuantity(alice, bolt, 3, false);
  assert.deepEqual(rows(alice, bolt), [{ condition: '', is_foil: 0, quantity: 3 }]);
  setOwnedPrintingQuantity(alice, bolt, 0, false);
  assert.deepEqual(rows(alice, bolt), []);
});

test('conditions are separate rows, and the total setter spends unrecorded copies first', () => {
  addOwnedPrintingQuantity(alice, bolt, 2, false, { condition: 'NM' });
  addOwnedPrintingQuantity(alice, bolt, 1, false, { condition: 'Heavily Played' });
  addOwnedPrintingQuantity(alice, bolt, 1, false);
  assert.equal(ownedPrintingTotal(alice, bolt, false), 4);

  // Total 4 -> 2: the unrecorded copy goes, then the HP one; NM is kept.
  setOwnedPrintingQuantity(alice, bolt, 2, false);
  assert.deepEqual(rows(alice, bolt), [{ condition: 'NM', is_foil: 0, quantity: 2 }]);

  // Growth through the total setter lands unrecorded.
  setOwnedPrintingQuantity(alice, bolt, 3, false);
  assert.deepEqual(rows(alice, bolt), [
    { condition: '', is_foil: 0, quantity: 1 },
    { condition: 'NM', is_foil: 0, quantity: 2 },
  ]);
});

test('a named condition sets only its own row, and expectedQuantity checks that row', () => {
  setOwnedPrintingQuantity(alice, bolt, 1, false, { condition: 'LP' });
  assert.throws(
    () => setOwnedPrintingQuantity(alice, bolt, 5, false, { condition: 'NM', expectedQuantity: 3 }),
    /now holds 2/
  );
  assert.throws(() => addOwnedPrintingQuantity(alice, bolt, 1, false, { condition: 'Gem Mint' }), /Unknown card condition/);
});

test('taking copies reports which conditions they came from', () => {
  const taken = takeOwnedCopies(alice, bolt, false, 2);
  assert.deepEqual(taken, [{ condition: '', quantity: 1 }, { condition: 'LP', quantity: 1 }]);
  assert.throws(() => takeOwnedCopies(alice, bolt, false, 5), /Only 2/);
});

test('bulk remove without a condition takes across conditions', () => {
  const result = bulkRemoveFromInventory(alice, [{ setCode: 'NEO', collectorNumber: '46', quantity: 1 }]);
  assert.equal(result.removed, 1);
  assert.deepEqual(rows(alice, bolt), [{ condition: 'NM', is_foil: 0, quantity: 1 }]);
});

test('CardCastle singles keep condition and finish, folding identical copies', () => {
  const csv = [
    'Card Name,Set Name,Collector Number,Condition,Foil,Language,Multiverse ID,JSON ID,Price USD,Photo URL,TCGPlayer Id,TCGPlayer Product Id',
    'Rhonas the Indomitable,Amonkhet Invocations,28,Near Mint,Foil,en,1,sf-rhonas,49.25,,1,1',
    'Rhonas the Indomitable,Amonkhet Invocations,28,Near Mint,Foil,en,1,sf-rhonas,49.25,,1,1',
    'Armguard Familiar,Kamigawa: Neon Dynasty,46,Lightly Played,Normal,en,1,bad-id,0.16,,1,1',
  ].join('\n');

  const dry = importCardCastleSingles(bob, csv, { dryRun: true });
  assert.equal(dry.lines, 2);
  assert.deepEqual(rows(bob, fox), []);

  const result = importCardCastleSingles(bob, csv);
  assert.equal(result.added, 3);
  assert.deepEqual(rows(bob, fox), [{ condition: 'NM', is_foil: 1, quantity: 2 }]);
  // The bad Scryfall id falls back to set name + collector number.
  assert.deepEqual(rows(bob, bolt), [{ condition: 'LP', is_foil: 0, quantity: 1 }]);
});

test('CardCastle sealed rows match the catalog and keep cost and reference price', () => {
  const csv = [
    'Portfolio Name,Category,Set,Product Name,Card Number,Rarity,Variance,Grade,Card Condition,Average Cost Paid,Quantity,Market Price (As of 2026-09-28),Price Override,Watchlist,Date Added,Notes',
    'Main,Magic: The Gathering,Kamigawa: Neon Dynasty,Kamigawa: Neon Dynasty - Draft Booster Box,,,Normal,Ungraded,Near Mint,171.4300,2,232.6,0,false,2026-08-09,',
    'Main,Magic: The Gathering,Kamigawa: Neon Dynasty,Kamigawa: Neon Dynasty - Set Booster Display,,,Normal,Ungraded,Near Mint,85.7100,1,"2,062.34",0,false,2026-08-09,',
    'Main,Magic: The Gathering,Kamigawa: Neon Dynasty,Kamigawa: Neon Dynasty - Bundle,,,Normal,Ungraded,Near Mint,40,1,50,0,false,2026-08-09,',
    'Main,Pokemon,Base,Booster Box,,,Normal,Ungraded,Near Mint,1,1,1,0,false,2026-08-09,',
  ].join('\n');

  const result = importSealedCsv(bob, csv);
  assert.equal(result.imported, 3);
  assert.equal(result.matched, 2);
  assert.equal(result.skipped.length, 1);

  const { lots, totals } = listSealed(bob);
  const draft = lots.find((l) => l.sealed_uuid === 's-neo-draft');
  assert.equal(draft.quantity, 2);
  assert.equal(draft.value_source, 'tcgplayer');
  assert.equal(draft.total_value, 500);
  const setBox = lots.find((l) => l.sealed_uuid === 's-neo-set');
  assert.equal(setBox.value_source, 'reference');
  assert.equal(setBox.unit_value, 2062.34);
  assert.equal(setBox.reference_price_date, '2026-09-28');
  const bundle = lots.find((l) => l.name.endsWith('Bundle'));
  assert.equal(bundle.sealed_uuid, null);
  assert.equal(totals.items, 4);
  assert.equal(totals.cost, 171.43 * 2 + 85.71 + 40);

  // The catalog gaining the product later links the lot on the next read.
  db.run(`INSERT INTO sealed_products (uuid, name, name_normalized, set_code, category)
          VALUES ('s-neo-bundle', 'Kamigawa: Neon Dynasty Bundle', 'kamigawa neon dynasty bundle', 'NEO', 'bundle')`);
  assert.equal(listSealed(bob).lots.find((l) => l.name.endsWith('Bundle')).sealed_uuid, 's-neo-bundle');

  const overridden = addSealed(bob, { sealedUuid: 's-neo-draft', priceOverride: 300 });
  assert.equal(overridden.value_source, 'override');
  assert.equal(overridden.name, 'Kamigawa: Neon Dynasty Draft Booster Box');
});
