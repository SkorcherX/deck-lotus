/**
 * Which physical copy a generated deck is built out of.
 *
 * The generator chooses cards; this is the step that turns each one into a row
 * in `deck_cards`, and it has to name a copy the collection actually contains.
 * Both halves of that matter, and only one of them is obvious:
 *
 *   - the printing has to be one they own. Binding by name picks whatever the
 *     cards table returns first, which is routinely a set they have never
 *     opened.
 *   - the *finish* has to be one they own too. Finish is half the unique key of
 *     `owned_printings`, so a deck row written non-foil against a card somebody
 *     holds only in foil claims a copy that does not exist. Against the fixture
 *     that was 32 of one collection's 538 cards.
 *
 * Beyond correctness, the choice among owned copies is a judgement: non-foil
 * first, then cheapest, so the expensive printing stays free to sell and
 * nobody's foils get sleeved into a deck a program invented.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-binding-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { getGeneratorPool } = await import('../../src/services/inventoryService.js');
const { acceptProposal } = await import('../../src/services/deckProposalService.js');

let userId;
const printings = {};

/** A card with three printings, none owned until a test says so. */
function addCard(name) {
  db.run(
    `INSERT INTO cards (name, name_normalized, type_line, color_identity, cmc, mana_cost)
     VALUES (?,?,'Creature — Zombie','B',2,'{1}{B}')`,
    [name, name.toLowerCase()]
  );
  const cardId = db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;

  for (const [set, price] of [['AAA', 20.0], ['BBB', 0.25], ['CCC', 5.0]]) {
    const uuid = `uuid-${set}-${name}`.replace(/\s+/g, '-');
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity)
       VALUES (?,?,?,'1','rare')`,
      [cardId, uuid, set]
    );
    const id = db.get(`SELECT id FROM printings WHERE uuid = ?`, [uuid]).id;
    printings[`${set}:${name}`] = { id, uuid };

    db.run(
      `INSERT INTO prices (printing_uuid, provider, price_type, price)
       VALUES (?,'tcgplayer','normal',?)`,
      [uuid, price]
    );
    db.run(
      `INSERT INTO prices (printing_uuid, provider, price_type, price)
       VALUES (?,'tcgplayer','foil',?)`,
      [uuid, price * 3]
    );
  }
  return cardId;
}

// Four copies rather than one, so that a test which accepts a proposal does
// not exhaust the card and drop it out of the pool for the next test — the
// pool only offers what is still free, which is correct and is not what these
// tests are about.
const own = (name, set, { foil = false, quantity = 4 } = {}) => db.run(
  `INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,?,?)`,
  [userId, printings[`${set}:${name}`].id, quantity, foil ? 1 : 0]
);

const poolFor = (name) => getGeneratorPool(userId).find((row) => row.name === name);

before(async () => {
  await runMigrations();
  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('owner','o@example.test','h')`);
  userId = db.get(`SELECT id FROM users WHERE username='owner'`).id;
  for (const set of ['AAA', 'BBB', 'CCC']) {
    db.run(`INSERT INTO sets (code, name) VALUES (?,?)`, [set, `Set ${set}`]);
  }

  addCard('Foil Only');
  addCard('Cheap And Dear');
  addCard('Foil And Normal');
  addCard('Single Copy');

  // Owned in foil and nothing else. The case that was being written wrong.
  own('Foil Only', 'AAA', { foil: true });

  // Three non-foil printings at $20, $0.25 and $5.
  own('Cheap And Dear', 'AAA');
  own('Cheap And Dear', 'BBB');
  own('Cheap And Dear', 'CCC');

  // The dear printing is the non-foil one; the cheap printing is only foil.
  own('Foil And Normal', 'AAA');
  own('Foil And Normal', 'BBB', { foil: true });

  own('Single Copy', 'CCC');
});

after(() => {
  closeDb();
  fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });
});

describe('getGeneratorPool picks a copy that exists', () => {
  test('a card owned only in foil is bound as foil', () => {
    const row = poolFor('Foil Only');
    assert.equal(row.printing_id, printings['AAA:Foil Only'].id);
    assert.equal(row.is_foil, 1, 'binding this non-foil claims a copy that does not exist');
  });

  test('the cheapest owned printing wins, so the dear one stays sellable', () => {
    const row = poolFor('Cheap And Dear');
    assert.equal(row.printing_id, printings['BBB:Cheap And Dear'].id);
    assert.equal(row.is_foil, 0);
  });

  test('non-foil beats cheaper foil', () => {
    // BBB is the cheaper printing but only owned in foil; AAA is dearer and
    // non-foil. Nobody's foils get sleeved into a generated deck.
    const row = poolFor('Foil And Normal');
    assert.equal(row.printing_id, printings['AAA:Foil And Normal'].id);
    assert.equal(row.is_foil, 0);
  });

  test('the printing and the finish come from the same owned row', () => {
    // Chosen independently, these can name a combination nobody owns.
    for (const name of ['Foil Only', 'Cheap And Dear', 'Foil And Normal', 'Single Copy']) {
      const row = poolFor(name);
      const owned = db.get(
        `SELECT quantity FROM owned_printings
          WHERE user_id = ? AND printing_id = ? AND is_foil = ?`,
        [userId, row.printing_id, row.is_foil]
      );
      assert.ok(owned && owned.quantity > 0, `${name} bound to a copy that is not owned`);
    }
  });
});

describe('acceptProposal stores that copy', () => {
  test('the deck row carries the finish the pool found', () => {
    const foilRow = poolFor('Foil Only');
    const plainRow = poolFor('Single Copy');

    const result = acceptProposal(userId, {
      name: 'Finish Test',
      cards: [
        { name: foilRow.name, printingId: foilRow.printing_id, isFoil: Boolean(foilRow.is_foil), quantity: 1 },
        { name: plainRow.name, printingId: plainRow.printing_id, isFoil: Boolean(plainRow.is_foil), quantity: 1 },
      ],
    });

    const rows = db.all(
      `SELECT c.name, dc.is_foil FROM deck_cards dc
         JOIN printings p ON p.id = dc.printing_id
         JOIN cards c ON c.id = p.card_id
        WHERE dc.deck_id = ?`,
      [result.deckId]
    );

    assert.equal(rows.find((r) => r.name === 'Foil Only').is_foil, 1);
    assert.equal(rows.find((r) => r.name === 'Single Copy').is_foil, 0);
  });

  test('every stored row names a copy the user owns', () => {
    const cards = ['Foil Only', 'Cheap And Dear', 'Foil And Normal', 'Single Copy']
      .map(poolFor)
      .map((row) => ({
        name: row.name, printingId: row.printing_id, isFoil: Boolean(row.is_foil), quantity: 1,
      }));

    const result = acceptProposal(userId, { name: 'Ownership Test', cards });

    const unowned = db.all(
      `SELECT c.name FROM deck_cards dc
         JOIN printings p ON p.id = dc.printing_id
         JOIN cards c ON c.id = p.card_id
        WHERE dc.deck_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM owned_printings op
             WHERE op.user_id = ? AND op.printing_id = dc.printing_id
               AND op.is_foil = dc.is_foil AND op.quantity > 0
          )`,
      [result.deckId, userId]
    );

    assert.deepEqual(unowned, [], 'a generated deck must not list copies nobody owns');
  });

  test('the same printing in two finishes stays two rows', () => {
    const row = poolFor('Foil And Normal');
    const result = acceptProposal(userId, {
      name: 'Two Finishes',
      cards: [
        { name: row.name, printingId: row.printing_id, isFoil: false, quantity: 1 },
        { name: row.name, printingId: row.printing_id, isFoil: true, quantity: 1 },
      ],
    });

    const rows = db.all(
      `SELECT is_foil, quantity FROM deck_cards WHERE deck_id = ? ORDER BY is_foil`,
      [result.deckId]
    );
    assert.equal(rows.length, 2, 'the unique key is on finish as well as printing');
    assert.deepEqual(rows.map((r) => r.quantity), [1, 1]);
  });
});
