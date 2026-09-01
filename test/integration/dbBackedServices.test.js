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
const { getBulkBinList, getShoppingList } =
  await import('../../src/services/shoppingService.js');
const { addCardToDeck, updateDeckCard, getDeckById } =
  await import('../../src/services/deckService.js');
const { addOwnedPrintingQuantity, setOwnedPrintingQuantity, toggleCardOwnership, browseCards } =
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


/**
 * The ownership tick is a 32px icon rendered fifty times a page, and pressing
 * it on an owned card used to delete every printing and every finish of that
 * card — sixteen copies of Mountain across five rows, from one press, with no
 * confirmation and no undo. The guard belongs in the service, not the click
 * handler, because the API has the same one-press property.
 */
describe('the ownership toggle asks before it empties a shelf', () => {
  const cardIdOf = (name) => db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
  const rowsFor = (name) =>
    db.all(
      `SELECT op.quantity, op.is_foil FROM owned_printings op
         JOIN printings p ON op.printing_id = p.id
        WHERE op.user_id = ? AND p.card_id = ?`,
      [userId, cardIdOf(name)]
    );

  before(() => {
    // Arcane Signet, held the way a real collection holds a staple: several
    // copies, more than one printing, one of them foil.
    const cardId = cardIdOf('Arcane Signet');
    db.run(`DELETE FROM owned_printings WHERE user_id = ? AND printing_id IN
              (SELECT id FROM printings WHERE card_id = ?)`, [userId, cardId]);
    db.run(`INSERT INTO printings (card_id, set_code, collector_number, uuid)
            VALUES (?, 'TST', '999', 'uuid-signet-second')`, [cardId]);
    const second = db.get(`SELECT id FROM printings WHERE uuid = 'uuid-signet-second'`).id;
    setOwnedPrintingQuantity(userId, printings['Arcane Signet'].printingId, 4, false);
    setOwnedPrintingQuantity(userId, second, 2, true);
  });

  test('a stocked card is not removed, and nothing is written', () => {
    const before = rowsFor('Arcane Signet');
    const result = toggleCardOwnership(userId, cardIdOf('Arcane Signet'));

    assert.equal(result.requiresConfirmation, true);
    assert.equal(result.removed, false);
    assert.equal(result.owned, true, 'the card is still owned, and must still read as owned');
    assert.deepEqual(rowsFor('Arcane Signet'), before, 'rows moved on an unconfirmed toggle');
  });

  test('the counts come back, because the prompt has to say what it costs', () => {
    const result = toggleCardOwnership(userId, cardIdOf('Arcane Signet'));
    assert.equal(result.copyCount, 6);
    assert.equal(result.printingCount, 2);
    assert.equal(result.foilCount, 2);
  });

  test('confirming removes everything, and logs every row it took', () => {
    const cardId = cardIdOf('Arcane Signet');
    const result = toggleCardOwnership(userId, cardId, { confirmRemoveAll: true });

    assert.equal(result.owned, false);
    assert.equal(result.removed, true);
    assert.equal(rowsFor('Arcane Signet').length, 0);

    const logged = db.all(
      `SELECT quantity_before, is_foil FROM audit_log
        WHERE user_id = ? AND card_name = 'Arcane Signet' AND quantity_after = 0
        ORDER BY id DESC LIMIT 2`,
      [userId]
    );
    assert.equal(logged.length, 2, 'a deleted row went unlogged, so it cannot be put back');
    assert.deepEqual(logged.map((r) => r.quantity_before).sort(), [2, 4]);
  });

  test('undoing your own press needs no ceremony', () => {
    const cardId = cardIdOf('Arcane Signet');

    const added = toggleCardOwnership(userId, cardId);
    assert.equal(added.owned, true);
    assert.equal(rowsFor('Arcane Signet').length, 1);

    // One printing, one copy, not foil — exactly what the press above created.
    const removed = toggleCardOwnership(userId, cardId);
    assert.equal(removed.removed, true, 'the toggle asked about the single copy it had just added');
    assert.equal(rowsFor('Arcane Signet').length, 0);
  });

  test('two copies of one printing is already enough to ask', () => {
    const cardId = cardIdOf('Arcane Signet');
    setOwnedPrintingQuantity(userId, printings['Arcane Signet'].printingId, 2, false);

    assert.equal(toggleCardOwnership(userId, cardId).requiresConfirmation, true);
    assert.equal(rowsFor('Arcane Signet')[0].quantity, 2);
  });

  test('a single foil is asked about too — it is not what the toggle adds', () => {
    const cardId = cardIdOf('Arcane Signet');
    setOwnedPrintingQuantity(userId, printings['Arcane Signet'].printingId, 0, false);
    setOwnedPrintingQuantity(userId, printings['Arcane Signet'].printingId, 1, true);

    assert.equal(toggleCardOwnership(userId, cardId).requiresConfirmation, true);
    assert.equal(rowsFor('Arcane Signet').length, 1);
  });
});


/**
 * The main shopping list could not show a contested card at all: the option
 * existed in the service and only the bulk view ever passed it, so a deck
 * reading "Short 1, in other decks" led to a Shopping page that offered
 * nothing and explained nothing. Exposing it is only safe if a row that needs
 * no purchase carries a quantity of zero all the way out.
 */
describe('the shopping list can explain a contested card', () => {
  const findCard = (list, name) => {
    for (const set of list.sets) {
      const card = set.cards.find((c) => c.name === name);
      if (card) return card;
    }
    return null;
  };

  test('by default a card held by another deck is simply absent', () => {
    // Shopping for the idea deck: the ready and building decks hold the one
    // copy that exists, and no purchase makes the idea deck listable sooner.
    const list = getShoppingList(userId, [statusDecks.idea]);
    assert.equal(findCard(list, 'Llanowar Elves'), null);
  });

  test('asked for, it appears, and says nothing needs buying', () => {
    const list = getShoppingList(userId, [statusDecks.idea], { includeContested: true });
    const card = findCard(list, 'Llanowar Elves');

    assert.ok(card, 'the contested card did not appear even when asked for');
    assert.equal(card.quantityNeeded, 0, 'a contested row must not ask to be bought');
    assert.equal(card.contested, 1);
    assert.deepEqual(
      (card.heldBy || []).map((d) => d.deckName).sort(),
      ['Half Built', 'Sleeved Deck'],
      'the row has to name who is holding it, or it reads as a list error'
    );
  });

  test('a card genuinely short is still quoted, either way', () => {
    // Nobody owns Giant Growth, so it is a purchase under both settings.
    db.run(
      `INSERT INTO deck_cards (deck_id, printing_id, quantity, board_type) VALUES (?,?,2,'mainboard')`,
      [statusDecks.idea, printings['Giant Growth'].printingId]
    );

    for (const opts of [{}, { includeContested: true }]) {
      const card = findCard(getShoppingList(userId, [statusDecks.idea], opts), 'Giant Growth');
      assert.equal(card.quantityNeeded, 2, `wrong count with ${JSON.stringify(opts)}`);
    }

    db.run(`DELETE FROM deck_cards WHERE deck_id = ? AND printing_id = ?`,
      [statusDecks.idea, printings['Giant Growth'].printingId]);
  });
});


/**
 * deck_cards was keyed UNIQUE(deck_id, printing_id, is_sideboard, is_foil) — a
 * boolean standing in for three boards. Mainboard and maybeboard both mean
 * is_sideboard = 0, so a card you were playing could not also be a card you
 * were considering, and the attempt surfaced as a 500 carrying the constraint
 * text. Migration 038 keys on board_type and makes the two columns agree.
 */
describe('a card can be on more than one board', () => {
  const boardsOf = (deckId, name) =>
    db.all(
      `SELECT dc.board_type, dc.is_sideboard, dc.quantity FROM deck_cards dc
         JOIN printings p ON p.id = dc.printing_id
         JOIN cards c ON c.id = p.card_id
        WHERE dc.deck_id = ? AND c.name = ?
        ORDER BY dc.board_type`,
      [deckId, name]
    );

  let boardDeck;

  before(() => {
    db.run(`INSERT INTO decks (user_id, name, format, status) VALUES (?,'Board Test','commander','building')`,
      [userId]);
    boardDeck = db.get(`SELECT id FROM decks WHERE name = 'Board Test'`).id;
  });

  test('the same printing lands on all three boards', () => {
    const printingId = printings['Giant Growth'].printingId;

    addCardToDeck(boardDeck, userId, printingId, 1, false, false, 'mainboard', false);
    addCardToDeck(boardDeck, userId, printingId, 1, false, false, 'sideboard', false);
    addCardToDeck(boardDeck, userId, printingId, 1, false, false, 'maybeboard', false);

    assert.deepEqual(
      boardsOf(boardDeck, 'Giant Growth').map((r) => r.board_type),
      ['mainboard', 'maybeboard', 'sideboard']
    );
  });

  test('adding to a board it is already on adds up, rather than colliding', () => {
    const printingId = printings['Giant Growth'].printingId;
    addCardToDeck(boardDeck, userId, printingId, 2, false, false, 'mainboard', false);

    const main = boardsOf(boardDeck, 'Giant Growth').find((r) => r.board_type === 'mainboard');
    assert.equal(main.quantity, 3);
  });

  test('is_sideboard follows the board, whatever the caller sent', () => {
    // The old bug: boardType without isSideboard wrote a row saying both.
    const rows = boardsOf(boardDeck, 'Giant Growth');
    for (const row of rows) {
      assert.equal(
        row.is_sideboard,
        row.board_type === 'sideboard' ? 1 : 0,
        `${row.board_type} row disagrees with its own flag`
      );
    }
  });

  test('moving a card onto a board it is already on merges, rather than failing', () => {
    const printingId = printings['Giant Growth'].printingId;
    const maybe = db.get(
      `SELECT id, quantity FROM deck_cards
        WHERE deck_id = ? AND printing_id = ? AND board_type = 'maybeboard'`,
      [boardDeck, printingId]
    );
    const sideBefore = db.get(
      `SELECT id, quantity FROM deck_cards
        WHERE deck_id = ? AND printing_id = ? AND board_type = 'sideboard'`,
      [boardDeck, printingId]
    );

    // Deliberately contradictory input: the board says sideboard, the legacy
    // flag says otherwise. The board wins and the flag is derived.
    updateDeckCard(boardDeck, userId, maybe.id, { boardType: 'sideboard', isSideboard: false });

    assert.equal(
      db.get(`SELECT id FROM deck_cards WHERE id = ?`, [maybe.id]),
      undefined,
      'the moved row survived alongside the one it moved onto'
    );

    const sideAfter = db.get(`SELECT quantity, is_sideboard, board_type FROM deck_cards WHERE id = ?`,
      [sideBefore.id]);
    assert.equal(sideAfter.quantity, sideBefore.quantity + maybe.quantity, 'copies were lost in the move');
    assert.equal(sideAfter.board_type, 'sideboard');
    assert.equal(sideAfter.is_sideboard, 1);
  });

  test('a plain move to an empty board still just moves', () => {
    const printingId = printings['Giant Growth'].printingId;
    const main = db.get(
      `SELECT id, quantity FROM deck_cards
        WHERE deck_id = ? AND printing_id = ? AND board_type = 'mainboard'`,
      [boardDeck, printingId]
    );

    updateDeckCard(boardDeck, userId, main.id, { boardType: 'maybeboard' });

    const moved = db.get(`SELECT board_type, is_sideboard, quantity FROM deck_cards WHERE id = ?`,
      [main.id]);
    assert.equal(moved.board_type, 'maybeboard');
    assert.equal(moved.is_sideboard, 0);
    assert.equal(moved.quantity, main.quantity);
  });

  test('an unknown board is refused as a client error, not a 500', () => {
    const printingId = printings['Llanowar Elves'].printingId;
    assert.throws(
      () => addCardToDeck(boardDeck, userId, printingId, 1, false, false, 'sidebaord', false),
      (err) => err.statusCode === 400 && /Unknown board/.test(err.message)
    );

    assert.equal(boardsOf(boardDeck, 'Llanowar Elves').length, 0, 'a typo still wrote a row');
  });

  test('the database itself refuses a contradictory row', () => {
    // The guard is in the schema, not only in the service — a future writer
    // that forgets to derive the flag fails loudly instead of storing a row
    // that says two things.
    assert.throws(() =>
      db.run(
        `INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, board_type, is_foil)
         VALUES (?,?,1,0,'sideboard',0)`,
        [boardDeck, printings['Llanowar Elves'].printingId]
      )
    );
  });
});


/**
 * A write endpoint that reports success and does nothing is the shape of bug
 * that gets diagnosed as "the app lost my edit", days later, by somebody
 * looking in the wrong place. This one took a deck_cards row id while the
 * endpoint that adds a card takes a printingId, so passing the wrong one was
 * an easy mistake — and answered 200.
 */
describe('editing a card that is not in the deck', () => {
  let emptyDeck;

  before(() => {
    db.run(`INSERT INTO decks (user_id, name, format, status) VALUES (?,'No Such Card','commander','idea')`,
      [userId]);
    emptyDeck = db.get(`SELECT id FROM decks WHERE name = 'No Such Card'`).id;
  });

  test('an id that matches nothing is a 404, not a silent success', () => {
    assert.throws(
      () => updateDeckCard(emptyDeck, userId, 999999, { quantity: 99 }),
      (err) => err.statusCode === 404
    );
  });

  test('a row belonging to a different deck is not editable through this one', () => {
    // The id exists — just not in this deck. Scoping by deck is what stops one
    // deck's edit reaching into another's.
    const other = db.get(
      `SELECT id FROM deck_cards WHERE deck_id != ? LIMIT 1`,
      [emptyDeck]
    );

    assert.throws(
      () => updateDeckCard(emptyDeck, userId, other.id, { quantity: 4 }),
      (err) => err.statusCode === 404
    );

    const untouched = db.get(`SELECT quantity FROM deck_cards WHERE id = ?`, [other.id]);
    assert.notEqual(untouched.quantity, 4, "the other deck's row was edited anyway");
  });
});


/**
 * Both collection endpoints take an absolute quantity, so two tabs that each
 * read 4 and each add one both write 5: the second write was computed from a
 * row that had already moved, and the copy the first one added is gone. Both
 * requests answered 200 and nothing said a write had been discarded.
 *
 * The add path was made an increment already (see the quick-add tests above),
 * which is immune by construction. This covers the setter, where "set it to
 * exactly this" is the point and the caller has to say what it was setting
 * from.
 */
describe('a write computed from a stale number is refused', () => {
  const printingId = () => printings['Opt'].printingId;
  const quantityNow = () =>
    db.get(
      `SELECT quantity FROM owned_printings WHERE user_id = ? AND printing_id = ? AND is_foil = 0`,
      [userId, printingId()]
    )?.quantity ?? 0;

  before(() => {
    setOwnedPrintingQuantity(userId, printingId(), 4, false);
  });

  test('the second of two tabs is told, rather than overwriting the first', () => {
    // Both tabs render 4. The first adds one and lands.
    setOwnedPrintingQuantity(userId, printingId(), 5, false, { expectedQuantity: 4 });
    assert.equal(quantityNow(), 5);

    // The second still believes 4, and its 5 would silently undo the first.
    assert.throws(
      () => setOwnedPrintingQuantity(userId, printingId(), 5, false, { expectedQuantity: 4 }),
      (err) => err.statusCode === 409 && err.currentQuantity === 5
    );

    assert.equal(quantityNow(), 5, 'the refused write moved the row anyway');
  });

  test('the conflict names the number the row actually holds', () => {
    // Without it the page can only say "something went wrong", and the user's
    // next press repeats the same stale arithmetic.
    try {
      setOwnedPrintingQuantity(userId, printingId(), 99, false, { expectedQuantity: 1 });
      assert.fail('a stale write was accepted');
    } catch (error) {
      assert.equal(error.currentQuantity, 5);
      assert.match(error.message, /5 copies/);
    }
  });

  test('a write that matches what the caller saw goes through', () => {
    setOwnedPrintingQuantity(userId, printingId(), 6, false, { expectedQuantity: 5 });
    assert.equal(quantityNow(), 6);
  });

  test('omitting it keeps the unconditional write a restore needs', () => {
    setOwnedPrintingQuantity(userId, printingId(), 2, false);
    assert.equal(quantityNow(), 2);
  });

  test('zeroing a row is guarded too, since it discards the most', () => {
    assert.throws(
      () => setOwnedPrintingQuantity(userId, printingId(), 0, false, { expectedQuantity: 9 }),
      (err) => err.statusCode === 409
    );
    assert.equal(quantityNow(), 2, 'a refused removal removed the row anyway');

    setOwnedPrintingQuantity(userId, printingId(), 0, false, { expectedQuantity: 2 });
    assert.equal(quantityNow(), 0);
  });

  test('an absent row counts as zero, so two tabs cannot both create it', () => {
    // The row is gone. A tab that still believes it holds 2 must not be able
    // to write on top of whatever replaced it.
    assert.throws(
      () => setOwnedPrintingQuantity(userId, printingId(), 3, false, { expectedQuantity: 2 }),
      (err) => err.statusCode === 409 && err.currentQuantity === 0
    );

    setOwnedPrintingQuantity(userId, printingId(), 3, false, { expectedQuantity: 0 });
    assert.equal(quantityNow(), 3);
  });
});


/**
 * Sorting a browse list by price.
 *
 * The question a price sort answers is "what does this card cost", and a card
 * does not cost what its rarest printing goes for. Sorting on the dearest
 * printing put a $9 card above genuinely expensive ones on the strength of a
 * foil-only variant nobody is buying - the same mistake the scanner made when
 * it quoted one printing's price for a card it had not pinned down.
 */
describe('browsing by price', () => {
  before(() => {
    // Grizzly Bears gets a second printing worth two hundred times its first,
    // and a new card is added whose only printing costs $5 - dearer than any
    // copy of the Bears anyone would buy, and far below the Bears' showcase.
    // Sorted on the dearest printing the Bears lead; sorted on what a copy
    // actually costs, the $5 card does.
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity)
       VALUES (?, 'uuid-Grizzly Bears-showcase', 'TST', '301', 'mythic')`,
      [printings['Grizzly Bears'].cardId]
    );
    db.run(
      `INSERT INTO prices (printing_uuid, provider, price_type, price)
       VALUES ('uuid-Grizzly Bears-showcase','tcgplayer','normal',50)`
    );
    db.run(
      `INSERT INTO cards (name, name_normalized, type_line, color_identity)
       VALUES ('Steady Five','steady five','Artifact','')`
    );
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity)
       VALUES ((SELECT id FROM cards WHERE name='Steady Five'), 'uuid-Steady Five', 'TST', '302', 'rare')`
    );
    db.run(
      `INSERT INTO prices (printing_uuid, provider, price_type, price)
       VALUES ('uuid-Steady Five','tcgplayer','normal',5)`
    );
  });

  test('a cheap card with one dear printing does not lead the list', () => {
    const { cards } = browseCards({ sort: 'price', limit: 10 });
    const names = cards.map((card) => card.name);

    assert.ok(
      names.indexOf('Steady Five') < names.indexOf('Grizzly Bears'),
      `a $5 card must outrank a $0.25 one with a $50 printing - got ${names.join(', ')}`
    );
  });

  test('the price a card sorts on is the cheapest way to own it', () => {
    const { cards } = browseCards({ sort: 'price', limit: 10 });
    const bears = cards.find((card) => card.name === 'Grizzly Bears');
    assert.equal(bears.card_price, 0.25, 'not the $50 printing');
  });
});
