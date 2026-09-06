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
