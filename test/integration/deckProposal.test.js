/**
 * The database side of the generator: where the pool comes from, and what
 * happens when a proposal is accepted.
 *
 * The arithmetic is covered in test/deckGenerator.test.js, which is pure. What
 * has to hold here is everything that touches the database:
 *
 *   - generating writes nothing at all, so a proposal somebody closed without
 *     reading never becomes a deck
 *   - an accepted deck is an idea, so its claim on cards yields to decks that
 *     are actually built
 *   - cards bind to a printing the user owns, not to whatever printing a name
 *     lookup returns first
 *   - the commander is a mainboard card carrying is_commander, because
 *     `board_type` is CHECKed and there is no 'commander' board
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-proposal-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const {
  commanderOptions, themeOptions, proposeDeck, acceptProposal,
  suggestForGaps, addGapsToShoppingList, revisableDecks,
} = await import('../../src/services/deckProposalService.js');

let userId;
let commanderCardId;
const printings = {};

function addCard(name, typeLine, { oracle = '', identity = 'B', cmc = 2, manaCost = '{1}{B}', supertypes = '' } = {}) {
  db.run(
    `INSERT INTO cards (name, name_normalized, type_line, oracle_text, color_identity, cmc, mana_cost, supertypes)
     VALUES (?,?,?,?,?,?,?,?)`,
    [name, name.toLowerCase(), typeLine, oracle, identity, cmc, manaCost, supertypes]
  );
  const cardId = db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;

  // Two printings, so "bound to the one they own" is a claim with teeth: the
  // lower id is the one they do not own.
  for (const [set, number] of [['UNO', '1'], ['OWN', '2']]) {
    const uuid = `uuid-${set}-${name}`.replace(/\s+/g, '-');
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity)
       VALUES (?,?,?,?, 'rare')`,
      [cardId, uuid, set, number]
    );
    printings[`${set}:${name}`] = db.get(`SELECT id FROM printings WHERE uuid = ?`, [uuid]).id;
  }

  db.run(
    `INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,4,0)`,
    [userId, printings[`OWN:${name}`]]
  );
  return cardId;
}

before(async () => {
  await runMigrations();
  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('owner','o@example.test','h')`);
  userId = db.get(`SELECT id FROM users WHERE username='owner'`).id;
  db.run(`INSERT INTO sets (code, name) VALUES ('UNO','Unowned Set')`);
  db.run(`INSERT INTO sets (code, name) VALUES ('OWN','Owned Set')`);

  commanderCardId = addCard('Test Commander', 'Legendary Creature — Zombie Wizard');

  for (let i = 0; i < 20; i += 1) {
    addCard(`Miller ${i}`, 'Creature — Zombie', { oracle: 'When this creature enters, mill three cards.' });
  }
  for (let i = 0; i < 20; i += 1) {
    addCard(`Reanimator ${i}`, 'Sorcery', {
      oracle: 'Return target creature card from your graveyard to the battlefield.',
    });
  }
  for (let i = 0; i < 12; i += 1) {
    addCard(`Killer ${i}`, 'Instant', { oracle: 'Destroy target creature.' });
  }
  addCard('Swamp', 'Basic Land — Swamp', { identity: '', cmc: 0, manaCost: '', supertypes: 'Basic' });
});

after(() => {
  closeDb();
  fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });
});

describe('commanderOptions', () => {
  test('offers legendary creatures the user owns', () => {
    const names = commanderOptions(userId).map((c) => c.name);
    assert.ok(names.includes('Test Commander'));
    assert.ok(!names.includes('Miller 0'), 'a plain creature is not a commander');
  });
});

describe('themeOptions', () => {
  test('ranks what could be built around, with its evidence', () => {
    const themes = themeOptions(userId, commanderCardId);
    const graveyard = themes.find((t) => t.key === 'graveyard');

    assert.ok(graveyard, 'the graveyard theme should be found');
    assert.ok(graveyard.enablers > 0 && graveyard.payoffs > 0);
    assert.equal(graveyard.strength, Math.min(graveyard.enablers, graveyard.payoffs));
    assert.ok(Array.isArray(graveyard.examples) && graveyard.examples.length > 0,
      'a theme has to be able to show the cards behind it');
  });
});

describe('proposeDeck', () => {
  test('writes nothing', () => {
    const before = db.get(`SELECT COUNT(*) AS n FROM decks`).n;
    proposeDeck(userId, { commanderCardId, format: 'commander' });
    assert.equal(db.get(`SELECT COUNT(*) AS n FROM decks`).n, before);
  });

  test('reports the pool it chose from', () => {
    const proposal = proposeDeck(userId, { commanderCardId, format: 'commander' });
    assert.ok(proposal.pool.cards > 0);
    // On by default: a collection is usually already built into decks, and the
    // strict reading leaves too little to propose from.
    assert.equal(proposal.pool.includeCommitted, true);
    assert.equal(proposal.commanderCard.name, 'Test Commander');
  });

  test('the strict reading is still available, and says so', () => {
    const proposal = proposeDeck(userId, {
      commanderCardId, format: 'commander', includeCommitted: false,
    });
    assert.equal(proposal.pool.includeCommitted, false);
  });

  test('a commander the user does not own is refused by name', () => {
    assert.throws(
      () => proposeDeck(userId, { commanderCardId: 999999 }),
      /not in your collection/
    );
  });
});

describe('acceptProposal', () => {
  const proposalCards = () => {
    const proposal = proposeDeck(userId, { commanderCardId, format: 'commander' });
    return {
      commander: {
        name: proposal.commanderCard.name,
        printingId: proposal.commanderCard.printingId,
        quantity: 1,
      },
      cards: [
        ...proposal.mainboard.map((c) => ({
          name: c.name, printingId: c.printingId, quantity: c.quantity,
        })),
        ...proposal.lands.map((l) => ({
          name: l.name, printingId: l.printingId || null, quantity: l.quantity,
        })),
      ],
    };
  };

  test('creates the deck as an idea, never as built', () => {
    const { commander, cards } = proposalCards();
    const result = acceptProposal(userId, { name: 'Accepted Deck', commander, cards });

    const deck = db.get(`SELECT name, status, format FROM decks WHERE id = ?`, [result.deckId]);
    // deckPriority: an idea yields its cards to every deck above it, so a
    // generated list cannot report a built deck as short.
    assert.equal(deck.status, 'idea');
    assert.equal(deck.format, 'commander');
    assert.equal(deck.name, 'Accepted Deck');
  });

  test('the commander is a mainboard card carrying is_commander', () => {
    const { commander, cards } = proposalCards();
    const result = acceptProposal(userId, { name: 'Commander Shape', commander, cards });

    const row = db.get(
      `SELECT board_type, is_commander, quantity FROM deck_cards
        WHERE deck_id = ? AND is_commander = 1`,
      [result.deckId]
    );
    assert.ok(row, 'the commander should be stored');
    assert.equal(row.board_type, 'mainboard');
    assert.equal(row.quantity, 1);
  });

  test('cards bind to a printing the user actually owns', () => {
    const { commander, cards } = proposalCards();
    const result = acceptProposal(userId, { name: 'Owned Printings', commander, cards });

    const foreign = db.all(
      `SELECT p.set_code FROM deck_cards dc
         JOIN printings p ON p.id = dc.printing_id
        WHERE dc.deck_id = ? AND p.set_code = 'UNO'`,
      [result.deckId]
    );
    // Every non-basic came from the pool, which only carries owned printings.
    // Basics are the exception: they are not tracked as inventory and fall
    // back to a lookup by name.
    const basics = db.all(
      `SELECT c.name FROM deck_cards dc
         JOIN printings p ON p.id = dc.printing_id
         JOIN cards c ON c.id = p.card_id
        WHERE dc.deck_id = ? AND p.set_code = 'UNO'`,
      [result.deckId]
    );
    assert.ok(
      foreign.length === 0 || basics.every((b) => b.name === 'Swamp'),
      'only basic lands may come from a printing the user does not own'
    );
  });

  test('a card that resolves to no printing is reported, not silently dropped', () => {
    const result = acceptProposal(userId, {
      name: 'With A Ghost',
      cards: [
        { name: 'Miller 0', printingId: printings['OWN:Miller 0'], quantity: 1 },
        { name: 'A Card That Does Not Exist', printingId: null, quantity: 2 },
      ],
    });

    assert.equal(result.added, 1);
    assert.deepEqual(result.unresolved, [{ name: 'A Card That Does Not Exist', quantity: 2 }]);
  });

  test('it records who built the deck, and as one batch', () => {
    const { commander, cards } = proposalCards();
    const result = acceptProposal(userId, { name: 'Audited', commander, cards });

    const row = db.get(
      `SELECT source, detail FROM audit_log
        WHERE user_id = ? AND action = 'deck.create'
        ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    assert.equal(row.source, 'deck_generator');
    const detail = JSON.parse(row.detail);
    assert.ok(detail.batchId.startsWith('deck-generate-'));
    assert.equal(detail.cards, result.added);
  });

  test('a nameless or empty proposal is refused', () => {
    assert.throws(() => acceptProposal(userId, { name: '  ', cards: [{ name: 'x' }] }), /name is required/);
    assert.throws(() => acceptProposal(userId, { name: 'Empty', cards: [] }), /no cards/);
  });
});

describe('suggestForGaps', () => {
  test('names cards that would fill a role the collection cannot', () => {
    // The fixture has no sweepers at all, so that gap is guaranteed.
    const { gaps } = suggestForGaps(userId, { commanderCardId, format: 'commander' });
    const sweepers = gaps.find((g) => g.code === 'sweeper');

    assert.ok(sweepers, 'the empty sweeper role should come back as a gap');
    assert.equal(sweepers.found, 0);
    assert.equal(sweepers.short, sweepers.wanted);
  });

  test('never suggests a card already owned', () => {
    // A buy list with cards from your own boxes on it is worse than useless.
    const { gaps } = suggestForGaps(userId, { commanderCardId, format: 'commander' });
    const ownedNames = new Set(
      db.all(
        `SELECT DISTINCT c.name FROM owned_printings op
           JOIN printings p ON p.id = op.printing_id
           JOIN cards c ON c.id = p.card_id
          WHERE op.user_id = ?`,
        [userId]
      ).map((row) => row.name)
    );

    for (const gap of gaps) {
      for (const s of gap.suggestions) {
        assert.ok(!ownedNames.has(s.name), `${s.name} is already owned`);
      }
    }
  });

  test('every suggestion carries a printing to buy and its price slot', () => {
    const { gaps } = suggestForGaps(userId, { commanderCardId, format: 'commander' });
    for (const gap of gaps) {
      for (const s of gap.suggestions) {
        assert.ok(Number.isInteger(s.printingId), 'a suggestion with no printing cannot be bought');
        assert.ok('price' in s, 'the price has to travel with it so the choice stays the buyer\'s');
      }
    }
  });

  test('a proposal with no role gaps suggests nothing', () => {
    const { gaps } = suggestForGaps(userId, { commanderCardId, format: 'commander' });
    // Whatever the fixture yields, a gap listed must be a real shortfall.
    for (const gap of gaps) assert.ok(gap.short > 0);
  });
});

describe('addGapsToShoppingList', () => {
  test('adds as wanted cards, with a note saying where they came from', () => {
    const printingId = db.get(
      `SELECT p.id FROM printings p JOIN cards c ON c.id = p.card_id
        WHERE c.name = 'Killer 0' LIMIT 1`
    ).id;

    const result = addGapsToShoppingList(userId, { items: [{ printingId, quantity: 2 }] });
    assert.equal(result.added.length, 1);
    assert.equal(result.failed.length, 0);

    const row = db.get(
      `SELECT quantity, note, is_foil FROM shopping_list_items
        WHERE user_id = ? AND printing_id = ?`,
      [userId, printingId]
    );
    assert.equal(row.quantity, 2);
    assert.equal(row.is_foil, 0);
    assert.match(row.note, /generator/i);
  });

  test('one bad printing does not lose the rest of a selection', () => {
    const printingId = db.get(
      `SELECT p.id FROM printings p JOIN cards c ON c.id = p.card_id
        WHERE c.name = 'Miller 3' LIMIT 1`
    ).id;

    const result = addGapsToShoppingList(userId, {
      items: [{ printingId: 999999, quantity: 1 }, { printingId, quantity: 1 }],
    });

    assert.equal(result.added.length, 1);
    assert.equal(result.failed.length, 1);
  });

  test('an empty selection is refused', () => {
    assert.throws(() => addGapsToShoppingList(userId, { items: [] }), /Nothing was selected/);
  });
});

/**
 * Revising a deck that already exists.
 *
 * The claim being tested is not "a deck comes back" — it always does — but
 * that the deck being revised is treated differently from every other deck:
 * its cards are available to it, and what comes back is described as a change
 * to it rather than as a pile. And that none of it is written: a suggestion
 * that edited the deck it was a suggestion about would be indefensible.
 */
describe('revising a deck', () => {
  let deckId;

  before(() => {
    const proposal = proposeDeck(userId, { commanderCardId, format: 'commander' });
    const saved = acceptProposal(userId, {
      name: 'Sleeved Deck',
      format: 'commander',
      commander: {
        name: proposal.commanderCard.name,
        printingId: proposal.commanderCard.printingId,
        isFoil: proposal.commanderCard.isFoil,
        quantity: 1,
      },
      cards: proposal.mainboard.map((c) => ({
        name: c.name, printingId: c.printingId, isFoil: c.isFoil, quantity: c.quantity,
      })),
    });
    deckId = saved.deckId ?? saved.deck?.id ?? saved.id;
    // Built, not an idea: a revision has to work on a deck that is holding its
    // cards against everything else.
    db.run(`UPDATE decks SET status = 'ready' WHERE id = ?`, [deckId]);

    // Earlier tests in this file accepted proposals of their own, and every
    // one of those decks is holding a copy of everything. Left in place they
    // decide the strict reading on their own, and these tests would be
    // measuring them rather than the deck being revised. This describe runs
    // last, so clearing them takes nothing away from anybody.
    db.run(`DELETE FROM deck_cards WHERE deck_id != ?`, [deckId]);
    db.run(`DELETE FROM decks WHERE id != ?`, [deckId]);
  });

  test('the deck is offered as somewhere to start from', () => {
    const offered = revisableDecks(userId).find((d) => d.id === deckId);
    assert.ok(offered, 'a deck the user owns should be revisable');
    assert.equal(offered.commanderName, 'Test Commander');
    assert.ok(offered.cards > 0);
  });

  test('the deck gets its own cards back, and the strict reading proves it', () => {
    // One copy owned, one copy sleeved into this deck: under the strict
    // reading that card is entirely spoken for and drops out of the pool.
    // Revising the deck holding it is the one case where it must not.
    const sleeved = db.get(
      `SELECT p.id AS printing_id, c.name
         FROM deck_cards dc
         JOIN printings p ON dc.printing_id = p.id
         JOIN cards c ON p.card_id = c.id
        WHERE dc.deck_id = ? AND dc.is_commander = 0
        LIMIT 1`,
      [deckId]
    );

    const owned = db.get(
      `SELECT quantity FROM owned_printings WHERE user_id = ? AND printing_id = ?`,
      [userId, sleeved.printing_id]
    ).quantity;

    db.run(`UPDATE owned_printings SET quantity = 1 WHERE user_id = ? AND printing_id = ?`,
      [userId, sleeved.printing_id]);
    db.run(`UPDATE deck_cards SET quantity = 1 WHERE deck_id = ? AND printing_id = ?`,
      [deckId, sleeved.printing_id]);

    try {
      const fromScratch = proposeDeck(userId, { commanderCardId, includeCommitted: false });
      const revising = proposeDeck(userId, { reviseDeckId: deckId, includeCommitted: false });

      assert.equal(revising.pool.cards, fromScratch.pool.cards + 1,
        'the card this deck is holding has to come back to it, and only to it');
    } finally {
      db.run(`UPDATE owned_printings SET quantity = ? WHERE user_id = ? AND printing_id = ?`,
        [owned, userId, sleeved.printing_id]);
    }
  });

  test('what comes back is described as a change to that deck', () => {
    const revision = proposeDeck(userId, { reviseDeckId: deckId }).revision;

    assert.equal(revision.deckId, deckId);
    assert.equal(revision.deckName, 'Sleeved Deck');
    assert.ok(Array.isArray(revision.added) && Array.isArray(revision.cut));
  });

  test('revising the deck it was built from keeps nearly all of it', () => {
    // The pool has not changed since the deck was made from it, so the
    // proposal should land back on the same cards. This is what the in_deck
    // tiebreak in rankCandidates is for: without it the diff fills with swaps
    // between cards the heuristics cannot tell apart.
    const revision = proposeDeck(userId, { reviseDeckId: deckId }).revision;
    assert.ok(revision.keptCount > revision.added.length,
      'a revision of an unchanged collection must not be a rebuild');
  });

  test('a revision inherits the format and the commander it was not given', () => {
    const proposal = proposeDeck(userId, { reviseDeckId: deckId });
    assert.equal(proposal.format, 'commander');
    assert.equal(proposal.commanderCard.name, 'Test Commander');
  });

  test('revising writes nothing, including to the deck being revised', () => {
    const decksBefore = db.get(`SELECT COUNT(*) AS n FROM decks`).n;
    const cardsBefore = db.get(`SELECT COUNT(*) AS n FROM deck_cards WHERE deck_id = ?`, [deckId]).n;

    proposeDeck(userId, { reviseDeckId: deckId });

    assert.equal(db.get(`SELECT COUNT(*) AS n FROM decks`).n, decksBefore);
    assert.equal(db.get(`SELECT COUNT(*) AS n FROM deck_cards WHERE deck_id = ?`, [deckId]).n, cardsBefore);
  });

  test("another user's deck is refused", () => {
    db.run(`INSERT INTO users (username, email, password_hash) VALUES ('other','x@example.test','h')`);
    const otherId = db.get(`SELECT id FROM users WHERE username='other'`).id;

    assert.throws(() => proposeDeck(otherId, { reviseDeckId: deckId }), /not one of yours/);
  });

  test('nothing is said about a revision when none was asked for', () => {
    // Null rather than an empty diff, so a caller can tell "built from
    // scratch" apart from "revised and changed nothing".
    assert.equal(proposeDeck(userId, { commanderCardId }).revision, null);
  });
});
