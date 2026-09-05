/**
 * The pool the generator picks from, and the availability rule behind it.
 *
 * This is the half that cannot be tested purely: `available` is a claim about
 * what other decks have taken, and the rule is `deckPriority`'s — a generated
 * deck is an idea, so retired decks release their cards and everything else
 * holds on to them. Getting that wrong in either direction is quiet: too
 * strict and a full collection looks empty, too loose and the generator
 * proposes decks built out of sleeved ones.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-genpool-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { getGeneratorPool } = await import('../../src/services/inventoryService.js');

let userId;
const printings = {};

const poolBy = (rows) => new Map(rows.map((row) => [row.name, row]));

before(async () => {
  await runMigrations();

  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('owner','o@example.test','h')`);
  userId = db.get(`SELECT id FROM users WHERE username='owner'`).id;
  db.run(`INSERT INTO sets (code, name) VALUES ('TST','Test Set')`);

  const add = (name, typeLine, supertypes = '') => {
    db.run(
      `INSERT INTO cards (name, name_normalized, type_line, supertypes, color_identity, cmc)
       VALUES (?,?,?,?,'B',2)`,
      [name, name.toLowerCase(), typeLine, supertypes]
    );
    const cardId = db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
    const uuid = `uuid-${name.replace(/\s+/g, '-')}`;
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity)
       VALUES (?,?,?,?,'rare')`,
      [cardId, uuid, 'TST', String(Object.keys(printings).length + 1)]
    );
    printings[name] = db.get(`SELECT id FROM printings WHERE uuid=?`, [uuid]).id;
  };

  add('Free Card', 'Creature — Zombie');
  add('Claimed Card', 'Creature — Zombie');
  add('Retired Card', 'Creature — Zombie');
  add('Swamp', 'Basic Land — Swamp', 'Basic');

  for (const name of ['Free Card', 'Claimed Card', 'Retired Card', 'Swamp']) {
    db.run(`INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,2,0)`,
      [userId, printings[name]]);
  }

  // A ready deck holds one Claimed Card; a retired one holds both Retired Cards.
  db.run(`INSERT INTO decks (user_id, name, format, status) VALUES (?,'Built','commander','ready')`, [userId]);
  db.run(`INSERT INTO decks (user_id, name, format, status) VALUES (?,'Old','commander','retired')`, [userId]);
  const built = db.get(`SELECT id FROM decks WHERE name='Built'`).id;
  const old = db.get(`SELECT id FROM decks WHERE name='Old'`).id;

  db.run(`INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_foil, board_type)
          VALUES (?,?,1,0,0,'mainboard')`, [built, printings['Claimed Card']]);
  db.run(`INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_foil, board_type)
          VALUES (?,?,2,0,0,'mainboard')`, [old, printings['Retired Card']]);
});

after(() => {
  closeDb();
  fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });
});

describe('getGeneratorPool', () => {
  test('a card no deck has taken is fully available', () => {
    const pool = poolBy(getGeneratorPool(userId));
    assert.equal(pool.get('Free Card').available, 2);
    assert.equal(pool.get('Free Card').committed, 0);
  });

  test('a committed copy is not offered twice', () => {
    const pool = poolBy(getGeneratorPool(userId));
    assert.equal(pool.get('Claimed Card').committed, 1);
    assert.equal(pool.get('Claimed Card').available, 1);
  });

  test('a retired deck releases its cards', () => {
    // Retired sits below idea in deckPriority, so it takes nothing away.
    const pool = poolBy(getGeneratorPool(userId));
    assert.equal(pool.get('Retired Card').committed, 0);
    assert.equal(pool.get('Retired Card').available, 2);
  });

  test('basic lands are not in the pool at all', () => {
    const pool = poolBy(getGeneratorPool(userId));
    assert.equal(pool.has('Swamp'), false);
  });

  test('includeCommitted widens availability but still reports the claim', () => {
    const pool = poolBy(getGeneratorPool(userId, { includeCommitted: true }));
    assert.equal(pool.get('Claimed Card').available, 2);
    // The caller can still see it would come out of a built deck.
    assert.equal(pool.get('Claimed Card').committed, 1);
  });

  test('a card entirely spoken for drops out unless committed cards are included', () => {
    const deckId = db.get(`SELECT id FROM decks WHERE name='Built'`).id;
    db.run(`UPDATE deck_cards SET quantity = 2 WHERE deck_id = ? AND printing_id = ?`,
      [deckId, printings['Claimed Card']]);

    assert.equal(poolBy(getGeneratorPool(userId)).has('Claimed Card'), false);
    assert.equal(poolBy(getGeneratorPool(userId, { includeCommitted: true })).has('Claimed Card'), true);

    db.run(`UPDATE deck_cards SET quantity = 1 WHERE deck_id = ? AND printing_id = ?`,
      [deckId, printings['Claimed Card']]);
  });
});
