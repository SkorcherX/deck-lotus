/**
 * The first tests in this repo that touch SQLite.
 *
 * Everything under test/ until now was import-free by necessity: better-sqlite3
 * would not build on every machine this repo is worked on, so the modules worth
 * testing were written to take rows in and give structure out, and the SQL
 * itself went unverified. That is exactly where the interesting bugs live — a
 * predicate that silently matches nothing looks identical to a feature that is
 * working.
 *
 * The driver bump that came with this file ships prebuilt binaries, so the SQL
 * can finally be exercised. These run against a throwaway database built by the
 * app's own migrations, so the schema under test is the real one rather than a
 * fixture that can drift from it.
 *
 * Not in test/*.test.js, so `npm test` stays fast and dependency-free; run with
 * `npm run test:integration`.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The connection module reads this once, at import, so it has to be set before
// anything below is pulled in.
const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-test-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { getDeckReadiness } = await import('../../src/services/deckReadinessService.js');
const { getBulkBinList } = await import('../../src/services/shoppingService.js');

let userId;
let deckA;
let deckB;
const printings = {};

/**
 * A collection with one of each interesting shape in it:
 *
 *   Grizzly Bears  — wanted by a deck, owned by nobody.      Buy it.
 *   Forest         — a basic land, listed 24 times.          Never mentioned.
 *   Arcane Signet  — owned once, but Deck B is using it.     Contested.
 *   Opt            — wanted and owned outright.              Silence.
 */
before(async () => {
  await runMigrations();

  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('tester','t@example.com','x')`);
  userId = db.get(`SELECT id FROM users WHERE username='tester'`).id;

  db.run(`INSERT INTO sets (code, name) VALUES ('TST','Test Set')`);

  const cards = [
    ['Grizzly Bears', 'Creature — Bear', null, 'G'],
    ['Forest', 'Basic Land — Forest', 'Basic', 'G'],
    ['Arcane Signet', 'Artifact', null, ''],
    ['Opt', 'Instant', null, 'U'],
  ];

  for (const [name, typeLine, supertypes, colorIdentity] of cards) {
    db.run(
      `INSERT INTO cards (name, name_normalized, type_line, supertypes, color_identity)
       VALUES (?,?,?,?,?)`,
      [name, name.toLowerCase(), typeLine, supertypes, colorIdentity]
    );
    const cardId = db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;

    const uuid = `uuid-${name}`;
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity)
       VALUES (?,?,?,?,'common')`,
      [cardId, uuid, 'TST', '1']
    );
    db.run(
      `INSERT INTO prices (printing_uuid, provider, price_type, price) VALUES (?,'tcgplayer','normal',0.25)`,
      [uuid]
    );

    printings[name] = {
      cardId,
      printingId: db.get(`SELECT id FROM printings WHERE uuid = ?`, [uuid]).id,
    };
  }

  db.run(`INSERT INTO decks (user_id, name, format) VALUES (?,'Deck A','commander')`, [userId]);
  db.run(`INSERT INTO decks (user_id, name, format) VALUES (?,'Deck B','commander')`, [userId]);
  deckA = db.get(`SELECT id FROM decks WHERE name='Deck A'`).id;
  deckB = db.get(`SELECT id FROM decks WHERE name='Deck B'`).id;

  const list = (deckId, name, quantity) =>
    db.run(
      `INSERT INTO deck_cards (deck_id, printing_id, quantity, board_type)
       VALUES (?,?,?,'mainboard')`,
      [deckId, printings[name].printingId, quantity]
    );

  list(deckA, 'Grizzly Bears', 2);
  list(deckA, 'Forest', 24);
  list(deckA, 'Arcane Signet', 1);
  list(deckA, 'Opt', 1);
  list(deckB, 'Arcane Signet', 1);

  const own = (name, quantity) =>
    db.run(
      `INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,?,0)`,
      [userId, printings[name].printingId, quantity]
    );

  own('Arcane Signet', 1);
  own('Opt', 1);
});

after(() => {
  // Windows will not unlink a file SQLite still has open, and the WAL keeps a
  // second handle besides. Close first, and treat a failure to tidy up as
  // nothing to do with whether the tests passed — a leftover temp directory is
  // not a broken build.
  try {
    closeDb();
  } catch {
    // Already closed.
  }

  try {
    fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });
  } catch {
    // The OS will clear the temp directory eventually.
  }
});

describe('deck readiness, against real SQL', () => {
  test('a card nobody owns is counted as missing', () => {
    const readiness = getDeckReadiness(userId, deckA);
    const bears = readiness.shortfalls.find((c) => c.name === 'Grizzly Bears');

    assert.equal(bears.missing, 2);
    assert.equal(bears.contested, 0);
    assert.equal(readiness.state, 'needs_buying');
  });

  test('a card owned but held by another deck is contested, not missing', () => {
    const readiness = getDeckReadiness(userId, deckA);
    const signet = readiness.shortfalls.find((c) => c.name === 'Arcane Signet');

    assert.equal(signet.missing, 0);
    assert.equal(signet.contested, 1);
  });

  test('24 basic lands are not a shortfall of any kind', () => {
    const readiness = getDeckReadiness(userId, deckA);

    assert.equal(
      readiness.shortfalls.some((c) => c.name === 'Forest'),
      false,
      'a basic land reached the shortfall list'
    );
    // The land is excluded from the totals too, not merely hidden from the
    // list: 2 bears is the whole of it.
    assert.equal(readiness.missingCopies, 2);
  });

  test('a card you own outright says nothing at all', () => {
    const readiness = getDeckReadiness(userId, deckA);
    assert.equal(readiness.shortfalls.some((c) => c.name === 'Opt'), false);
  });
});

describe('the bulk bin, against real SQL', () => {
  test('basic lands never reach the shopping list', () => {
    const list = getBulkBinList(userId, [deckA], { threshold: 5 });
    assert.equal(list.cards.some((c) => c.name === 'Forest'), false);
  });

  test('a contested row names the deck actually holding the copy', () => {
    const list = getBulkBinList(userId, [deckA], { threshold: 5 });
    const signet = list.cards.find((c) => c.name === 'Arcane Signet');

    assert.equal(signet.toBuy, 0);
    assert.equal(signet.contested, 1);
    assert.deepEqual(signet.heldBy.map((d) => d.deckName), ['Deck B']);
  });

  test('the deck being shopped for is never listed as holding the card', () => {
    // The whole point: shopping for Deck A, the row must not point back at
    // Deck A as the reason it is there.
    const list = getBulkBinList(userId, [deckA], { threshold: 5 });

    for (const card of list.cards) {
      assert.equal(
        card.heldBy.some((d) => d.deckId === deckA),
        false,
        `${card.name} named the deck being shopped for as its holder`
      );
    }
  });

  test('colour identity survives the trip from the database to the row', () => {
    const list = getBulkBinList(userId, [deckA], { threshold: 5 });

    assert.deepEqual(list.cards.find((c) => c.name === 'Grizzly Bears').colors, ['G']);
    assert.deepEqual(list.cards.find((c) => c.name === 'Arcane Signet').colors, []);
  });

  test('selecting both decks leaves nothing contested between them', () => {
    // Deck B is no longer "elsewhere" once you are shopping for it too, so the
    // copy it holds stops competing and the row drops off.
    const list = getBulkBinList(userId, [deckA, deckB], { threshold: 5 });
    const signet = list.cards.find((c) => c.name === 'Arcane Signet');

    // One copy owned, two decks listing it: one copy still has to be bought.
    assert.equal(signet.contested, 0);
    assert.equal(signet.toBuy, 1);
  });
});
