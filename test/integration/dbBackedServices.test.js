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
const { addOwnedPrintingQuantity, setOwnedPrintingQuantity } =
  await import('../../src/services/cardService.js');

let userId;
let deckA;
let deckB;
const printings = {};
const statusDecks = {};

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

  // A separate cast for the status-priority tests, on cards no other test
  // touches, so adding them cannot quietly change what the tests above mean.
  for (const name of ['Llanowar Elves', 'Giant Growth']) {
    db.run(
      `INSERT INTO cards (name, name_normalized, type_line, color_identity) VALUES (?,?,'Creature — Elf','G')`,
      [name, name.toLowerCase()]
    );
    const cardId = db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
    const uuid = `uuid-${name.replace(/\s+/g, '-')}`;
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity)
       VALUES (?,?,'TST','2','common')`,
      [cardId, uuid]
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

  for (const [name, status] of [
    ['Sleeved Deck', 'ready'],
    ['Half Built', 'building'],
    ['EDHREC Import', 'idea'],
    ['Old Deck', 'retired'],
  ]) {
    db.run(`INSERT INTO decks (user_id, name, format, status) VALUES (?,?,'commander',?)`,
      [userId, name, status]);
    statusDecks[status] = db.get(`SELECT id FROM decks WHERE name = ?`, [name]).id;
  }

  // Every one of them wants the single Llanowar Elves that exists.
  for (const deckId of Object.values(statusDecks)) {
    db.run(
      `INSERT INTO deck_cards (deck_id, printing_id, quantity, board_type)
       VALUES (?,?,1,'mainboard')`,
      [deckId, printings['Llanowar Elves'].printingId]
    );
  }
  own('Llanowar Elves', 1);
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

/*
 * Whose claim on a card wins.
 *
 * A deck's status is its owner's statement about how real it is, and the app
 * used to ignore it: a list imported from EDHREC and left as an idea reported
 * a sleeved, finished deck as short of cards sitting in its own box. The deck
 * that could not be built was the import; the app blamed the deck that was
 * already built.
 *
 * Fixture: one Llanowar Elves owned, and four decks — ready, building, idea,
 * retired — each listing a copy.
 */
describe('deck status decides whose claim wins', () => {
  const readinessFor = (deckId) => getDeckReadiness(userId, deckId);

  test('a Ready deck is untouched by an idea nobody has built', () => {
    const readiness = readinessFor(statusDecks.ready);
    const elves = readiness.shortfalls.find((c) => c.name === 'Llanowar Elves');

    assert.equal(elves, undefined, 'a less committed deck took a card from a Ready one');
    assert.equal(readiness.state, 'ready');
  });

  test('the idea deck is the one that comes up short', () => {
    const readiness = readinessFor(statusDecks.idea);
    const elves = readiness.shortfalls.find((c) => c.name === 'Llanowar Elves');

    assert.equal(elves.contested, 1);
    // Contested, not missing: the copy exists, it is just spoken for by decks
    // that mean it more.
    assert.equal(elves.missing, 0);
  });

  test('Building loses to Ready but not to Idea', () => {
    const readiness = readinessFor(statusDecks.building);
    const elves = readiness.shortfalls.find((c) => c.name === 'Llanowar Elves');

    // The Ready deck outranks it, so the one copy is spoken for...
    assert.equal(elves.contested, 1);
    // ...but the count is 1, not 2 — the idea deck below it does not add to
    // the claim, or the shortfall would double-count decks that cannot take
    // the card in the first place.
    assert.equal(elves.elsewhere, 1);
  });

  test('a retired deck takes nothing from anybody', () => {
    // Retired sits below Idea: out of rotation, so its cards read as
    // available. It still gets a verdict of its own — "could I rebuild this?"
    // stays answerable — it just stops being everyone else's problem.
    const readiness = readinessFor(statusDecks.retired);
    const elves = readiness.shortfalls.find((c) => c.name === 'Llanowar Elves');

    assert.equal(elves.contested, 1, 'the retired deck should still know it cannot be rebuilt');
    assert.equal(readinessFor(statusDecks.ready).state, 'ready');
  });

  test('two decks of equal status still contest each other', () => {
    // The whole reason this is a priority order and not a rule exempting
    // Ready decks: two finished decks fighting over one copy is a real
    // shortfall and must keep showing up.
    db.run(`INSERT INTO decks (user_id, name, format, status) VALUES (?,'Second Sleeved','commander','ready')`, [userId]);
    const rivalId = db.get(`SELECT id FROM decks WHERE name='Second Sleeved'`).id;
    db.run(
      `INSERT INTO deck_cards (deck_id, printing_id, quantity, board_type) VALUES (?,?,1,'mainboard')`,
      [rivalId, printings['Llanowar Elves'].printingId]
    );

    const elves = readinessFor(statusDecks.ready).shortfalls.find((c) => c.name === 'Llanowar Elves');
    assert.equal(elves.contested, 1, 'two Ready decks over one copy is a real shortfall');

    db.run(`DELETE FROM deck_cards WHERE deck_id = ?`, [rivalId]);
    db.run(`DELETE FROM decks WHERE id = ?`, [rivalId]);
  });

  test('the shopping list agrees with the deck page', () => {
    // The two pages answering differently about the same card is the reason
    // this rule is shared rather than implemented twice.
    const forReady = getBulkBinList(userId, [statusDecks.ready], { threshold: 5 });
    assert.equal(
      forReady.cards.some((c) => c.name === 'Llanowar Elves'),
      false,
      'shopping for a Ready deck quoted a card an idea deck was sitting on'
    );

    const forIdea = getBulkBinList(userId, [statusDecks.idea], { threshold: 5 });
    const elves = forIdea.cards.find((c) => c.name === 'Llanowar Elves');
    assert.equal(elves.contested, 1);
    assert.deepEqual(elves.heldBy.map((d) => d.deckName).sort(), ['Half Built', 'Sleeved Deck']);
  });
});


/**
 * The bug this guards against did not look like a bug: quick-add called a
 * *setter* with a hardcoded 1, so adding one copy of a card you owned five of
 * left you owning one — and the toast said "Card added to inventory!".
 * Nothing failed, nothing was logged as an error, and four copies were gone.
 */
describe('adding copies adds, and does not overwrite', () => {
  const ownedOf = (name, isFoil = 0) =>
    db.get(
      `SELECT quantity FROM owned_printings WHERE user_id = ? AND printing_id = ? AND is_foil = ?`,
      [userId, printings[name].printingId, isFoil]
    )?.quantity ?? 0;

  test('a stack of copies grows by one rather than collapsing to one', () => {
    setOwnedPrintingQuantity(userId, printings['Opt'].printingId, 5, false);

    const result = addOwnedPrintingQuantity(userId, printings['Opt'].printingId, 1, false, {
      source: 'quick_add',
    });

    assert.equal(ownedOf('Opt'), 6, 'adding one copy did not leave six');
    assert.equal(result.quantity, 6, 'the response has to carry the new total, not the delta');
    assert.equal(result.added, 1);
  });

  test('a printing owned by nobody starts at what was added', () => {
    addOwnedPrintingQuantity(userId, printings['Grizzly Bears'].printingId, 3, false);
    assert.equal(ownedOf('Grizzly Bears'), 3);
  });

  test('foil stays a row of its own, as everywhere else', () => {
    const before = ownedOf('Opt');
    addOwnedPrintingQuantity(userId, printings['Opt'].printingId, 2, true);

    assert.equal(ownedOf('Opt', 1), 2, 'the foil row did not take the copies');
    assert.equal(ownedOf('Opt'), before, 'adding a foil moved the non-foil row');
  });

  test('the audit row records the stack it grew from, not zero', () => {
    const before = ownedOf('Opt');
    addOwnedPrintingQuantity(userId, printings['Opt'].printingId, 1, false, { source: 'quick_add' });

    const entry = db.get(
      `SELECT source, quantity_before, quantity_after FROM audit_log
        WHERE printing_id = ? AND is_foil = 0 ORDER BY id DESC LIMIT 1`,
      [printings['Opt'].printingId]
    );
    assert.equal(entry.source, 'quick_add');
    assert.equal(entry.quantity_before, before);
    assert.equal(entry.quantity_after, before + 1);
  });

  test('taking copies away is a different function', () => {
    const before = ownedOf('Opt');
    assert.throws(() => addOwnedPrintingQuantity(userId, printings['Opt'].printingId, 0, false));
    assert.throws(() => addOwnedPrintingQuantity(userId, printings['Opt'].printingId, -2, false));
    assert.equal(ownedOf('Opt'), before, 'a rejected add still moved the row');
  });

  test('the setter still sets, because the card page needs it to', () => {
    setOwnedPrintingQuantity(userId, printings['Opt'].printingId, 2, false);
    assert.equal(ownedOf('Opt'), 2);
  });
});
