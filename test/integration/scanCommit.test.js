/**
 * Committing a scan session, and the line between the two destinations.
 *
 * The single most important assertion in this file is that Scan-to-Deck leaves
 * `owned_printings` untouched. Scanning a sleeved deck is recording what you
 * already own, not acquiring a hundred cards; a destination that quietly did
 * both would double every card in every deck the feature was used on, and it
 * would look like it was working the whole time.
 *
 * Foil is the other thing pinned hard here. Both `owned_printings` and
 * `deck_cards` treat finish as part of the unique key, so a commit that drops
 * `is_foil` does not fail — it lands on the wrong row.
 */
import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-commit-'));
process.env.DATABASE_PATH = path.join(workDir, 'test.db');

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const {
  commitScanToCollection,
  commitScanToDeck,
  ownershipShortfall,
} = await import('../../src/services/scanCommitService.js');

let userId;
let strangerId;
let deckId;
let strangerDeckId;
const printings = {};

function insertPrinting(key, name, setCode, collectorNumber) {
  const card = db.run(
    `INSERT INTO cards (name, mana_cost, type_line) VALUES (?, '{R}', 'Instant')`,
    [name]
  );
  const printing = db.run(
    `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity, language)
     VALUES (?, ?, ?, ?, 'rare', 'en')`,
    [card.lastInsertRowid, `0000-${key}`, setCode, collectorNumber]
  );
  printings[key] = printing.lastInsertRowid;
  return printings[key];
}

const ownedRows = (user = userId) =>
  db.all(`SELECT printing_id, quantity, is_foil FROM owned_printings WHERE user_id = ?`, [user]);

const deckRows = (deck = deckId) =>
  db.all(
    `SELECT printing_id, quantity, is_foil, board_type, is_commander
     FROM deck_cards WHERE deck_id = ? ORDER BY printing_id, is_foil`,
    [deck]
  );

before(async () => {
  await runMigrations();

  userId = db.run(
    `INSERT INTO users (username, email, password_hash) VALUES ('scanner', 's@example.com', 'x')`
  ).lastInsertRowid;

  strangerId = db.run(
    `INSERT INTO users (username, email, password_hash) VALUES ('stranger', 'x@example.com', 'x')`
  ).lastInsertRowid;

  deckId = db.run(
    `INSERT INTO decks (user_id, name, format) VALUES (?, 'Burn', 'modern')`,
    [userId]
  ).lastInsertRowid;

  strangerDeckId = db.run(
    `INSERT INTO decks (user_id, name, format) VALUES (?, 'Not Yours', 'modern')`,
    [strangerId]
  ).lastInsertRowid;

  insertPrinting('a', 'Scan Bolt', 'AAA', '1');
  insertPrinting('b', 'Scan Shock', 'AAA', '2');
  insertPrinting('c', 'Scan Ogre', 'BBB', '3');
});

beforeEach(() => {
  db.run(`DELETE FROM owned_printings WHERE user_id IN (?, ?)`, [userId, strangerId]);
  db.run(`DELETE FROM owned_cards WHERE user_id IN (?, ?)`, [userId, strangerId]);
  db.run(`DELETE FROM deck_cards WHERE deck_id IN (?, ?)`, [deckId, strangerDeckId]);
  db.run(`DELETE FROM audit_log WHERE user_id IN (?, ?)`, [userId, strangerId]);
});

after(() => {
  closeDb();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('committing to the collection', () => {
  test('adds quantities and reports the batch', () => {
    const result = commitScanToCollection(userId, [
      { printingId: printings.a, quantity: 2 },
      { printingId: printings.b, quantity: 1 },
    ]);

    assert.equal(result.cards, 2);
    assert.equal(result.committed, 3);
    assert.match(result.batchId, /^scan-/);

    assert.deepEqual(
      ownedRows().map((row) => [row.printing_id, row.quantity, row.is_foil]).sort(),
      [[printings.a, 2, 0], [printings.b, 1, 0]].sort()
    );
  });

  test('is additive, never a set', () => {
    // A second session of the same card is two more copies, not a correction to
    // two. This is why the commit uses addOwnedPrintingQuantity and not the
    // setter — scanning a stack twice should be visibly wrong, not silently
    // idempotent.
    commitScanToCollection(userId, [{ printingId: printings.a, quantity: 2 }]);
    commitScanToCollection(userId, [{ printingId: printings.a, quantity: 3 }]);

    assert.equal(ownedRows()[0].quantity, 5);
  });

  test('foil and non-foil are separate rows', () => {
    commitScanToCollection(userId, [
      { printingId: printings.a, quantity: 1, isFoil: false },
      { printingId: printings.a, quantity: 1, isFoil: true },
    ]);

    const rows = ownedRows().sort((x, y) => x.is_foil - y.is_foil);
    assert.equal(rows.length, 2, 'a foil copy must not merge into the non-foil row');
    assert.deepEqual(rows.map((row) => row.is_foil), [0, 1]);
  });

  test('stamps the batch id into the audit log', () => {
    // This is what makes reviewing a batch rather than each card recoverable.
    const { batchId } = commitScanToCollection(userId, [
      { printingId: printings.a, quantity: 1 },
      { printingId: printings.b, quantity: 1 },
    ]);

    const rows = db.all(
      `SELECT source, detail FROM audit_log WHERE user_id = ? AND source = 'scan'`,
      [userId]
    );

    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(JSON.parse(row.detail).batchId, batchId);
    }
  });

  test('rejects a bad row before writing anything', () => {
    assert.throws(
      () => commitScanToCollection(userId, [
        { printingId: printings.a, quantity: 1 },
        { printingId: printings.b, quantity: 0 },
      ]),
      /quantity must be a whole number/
    );

    assert.equal(ownedRows().length, 0, 'the valid row must not have landed either');
  });

  test('rejects a printing that no longer exists', () => {
    // A session held open across a weekly MTGJSON sync carries reassigned ids.
    assert.throws(
      () => commitScanToCollection(userId, [{ printingId: 999999, quantity: 1 }]),
      /no longer exist/
    );
  });

  test('rejects an empty session', () => {
    assert.throws(() => commitScanToCollection(userId, []), /at least one card/);
  });
});

describe('committing to a deck', () => {
  test('does not touch inventory', () => {
    // The assertion this whole destination exists for.
    commitScanToDeck(userId, deckId, [
      { printingId: printings.a, quantity: 4 },
      { printingId: printings.b, quantity: 2 },
    ]);

    assert.equal(ownedRows().length, 0, 'scanning a built deck must not add to the collection');
    assert.deepEqual(
      deckRows().map((row) => [row.printing_id, row.quantity]),
      [[printings.a, 4], [printings.b, 2]]
    );
  });

  test('carries foil onto its own deck row', () => {
    // deck_cards is unique on (deck_id, printing_id, is_sideboard, is_foil);
    // dropping the finish lands the copy on the wrong row rather than failing.
    commitScanToDeck(userId, deckId, [
      { printingId: printings.a, quantity: 1, isFoil: false },
      { printingId: printings.a, quantity: 1, isFoil: true },
    ]);

    const rows = deckRows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.is_foil), [0, 1]);
  });

  test('honours the board a card was reviewed onto', () => {
    commitScanToDeck(userId, deckId, [
      { printingId: printings.a, quantity: 1, boardType: 'mainboard' },
      { printingId: printings.b, quantity: 1, boardType: 'sideboard' },
      // A commander is a flag on a mainboard row, not a board of its own.
      { printingId: printings.c, quantity: 1, boardType: 'mainboard', isCommander: true },
    ]);

    const byPrinting = new Map(deckRows().map((row) => [row.printing_id, row]));
    assert.equal(byPrinting.get(printings.a).board_type, 'mainboard');
    assert.equal(byPrinting.get(printings.b).board_type, 'sideboard');
    assert.equal(byPrinting.get(printings.c).is_commander, 1);
  });

  test('refuses a deck the caller does not own', () => {
    assert.throws(
      () => commitScanToDeck(userId, strangerDeckId, [{ printingId: printings.a, quantity: 1 }]),
      /access denied/
    );

    assert.equal(deckRows(strangerDeckId).length, 0);
  });

  test('rejects an unknown board rather than guessing', () => {
    assert.throws(
      () => commitScanToDeck(userId, deckId, [
        { printingId: printings.a, quantity: 1, boardType: 'nonsense' },
      ]),
      /unknown board/
    );
  });
});

describe('the ownership shortfall', () => {
  test('reports only what is missing, per finish', () => {
    commitScanToCollection(userId, [{ printingId: printings.a, quantity: 1 }]);

    const shortfalls = ownershipShortfall(userId, [
      { printingId: printings.a, quantity: 4 },              // own 1, short 3
      { printingId: printings.b, quantity: 2 },              // own 0, short 2
      { printingId: printings.a, quantity: 1, isFoil: true },// foil is its own row
    ]);

    const byKey = new Map(
      shortfalls.map((row) => [`${row.printingId}:${row.isFoil ? 1 : 0}`, row])
    );

    assert.equal(byKey.get(`${printings.a}:0`).short, 3);
    assert.equal(byKey.get(`${printings.b}:0`).short, 2);
    assert.equal(
      byKey.get(`${printings.a}:1`).short, 1,
      'a non-foil copy must not satisfy a foil listing'
    );
  });

  test('says nothing when the collection already covers the deck', () => {
    commitScanToCollection(userId, [{ printingId: printings.a, quantity: 4 }]);

    assert.deepEqual(
      ownershipShortfall(userId, [{ printingId: printings.a, quantity: 4 }]),
      []
    );
  });

  test('sums repeats of one printing before comparing', () => {
    // A deck listing the same printing on two boards wants both copies.
    commitScanToCollection(userId, [{ printingId: printings.a, quantity: 3 }]);

    const shortfalls = ownershipShortfall(userId, [
      { printingId: printings.a, quantity: 2, boardType: 'mainboard' },
      { printingId: printings.a, quantity: 2, boardType: 'sideboard' },
    ]);

    assert.equal(shortfalls.length, 1);
    assert.equal(shortfalls[0].short, 1, 'wanted 4, own 3');
  });

  test('is read-only', () => {
    ownershipShortfall(userId, [{ printingId: printings.a, quantity: 4 }]);
    assert.equal(ownedRows().length, 0);
  });
});
