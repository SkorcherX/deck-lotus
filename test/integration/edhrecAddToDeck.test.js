/**
 * EDHREC picks added to an existing deck: a card the user owns goes in at the
 * printing they hold (so it reads as owned), anything else at the cheapest
 * printing, and a card the deck already lists is skipped rather than doubled —
 * EDHREC is Commander, where a second copy is an error.
 *
 * Run with `npm run test:integration`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-edhrec-')), 'test.db');

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { addCardsToDeck } = await import('../../src/services/edhrecService.js');

let userId;
let otherUser;
let deckId;
const p = {};

before(async () => {
  await runMigrations();
  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('a','a@example.test','x'), ('b','b@example.test','x')`);
  userId = db.get(`SELECT id FROM users WHERE username='a'`).id;
  otherUser = db.get(`SELECT id FROM users WHERE username='b'`).id;
  db.run(`INSERT INTO sets (code, name) VALUES ('AAA','Cheap'), ('BBB','Dear')`);

  for (const name of ['Sol Ring', 'Arcane Signet', 'Command Tower']) {
    db.run(`INSERT INTO cards (name, name_normalized, type_line) VALUES (?, ?, 'Artifact')`, [name, name.toLowerCase()]);
    const cardId = db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
    for (const [set, price] of [['AAA', 1], ['BBB', 50]]) {
      const uuid = `${name}-${set}`;
      db.run(`INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity) VALUES (?,?,?,'1','rare')`, [cardId, uuid, set]);
      db.run(`INSERT INTO prices (printing_uuid, provider, price_type, price) VALUES (?,'tcgplayer','normal',?)`, [uuid, price]);
      p[`${name}-${set}`] = db.get(`SELECT id FROM printings WHERE uuid = ?`, [uuid]).id;
    }
  }

  // Owns the dear Sol Ring, as a foil.
  db.run(`INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,1,1)`, [userId, p['Sol Ring-BBB']]);

  db.run(`INSERT INTO decks (user_id, name, format, status) VALUES (?, 'In progress', 'commander', 'building')`, [userId]);
  deckId = db.get(`SELECT id FROM decks WHERE name='In progress'`).id;
  db.run(`INSERT INTO deck_cards (deck_id, printing_id, quantity, board_type) VALUES (?,?,1,'mainboard')`, [deckId, p['Command Tower-BBB']]);
});

after(() => closeDb());

const row = (name) => db.get(`
  SELECT dc.printing_id, dc.is_foil, dc.quantity FROM deck_cards dc JOIN printings pr ON pr.id = dc.printing_id
  JOIN cards c ON c.id = pr.card_id WHERE dc.deck_id = ? AND c.name = ?`, [deckId, name]);

test('owned cards go in at the printing held, others at the cheapest; listed cards are skipped', () => {
  const result = addCardsToDeck(userId, { deckId, cardNames: ['Sol Ring', 'Arcane Signet', 'Command Tower', 'No Such Card'] });

  assert.deepEqual(result.added.map((a) => a.name), ['Sol Ring', 'Arcane Signet']);
  assert.deepEqual(result.skipped, ['Command Tower']);
  assert.deepEqual(result.unresolved, ['No Such Card']);

  assert.deepEqual(row('Sol Ring'), { printing_id: p['Sol Ring-BBB'], is_foil: 1, quantity: 1 });
  assert.equal(row('Arcane Signet').printing_id, p['Arcane Signet-AAA']);
  assert.equal(row('Command Tower').quantity, 1);
});

test('adding again changes nothing and every addition is audited under one batch', () => {
  const again = addCardsToDeck(userId, { deckId, cardNames: ['Sol Ring'] });
  assert.equal(again.added.length, 0);
  assert.equal(row('Sol Ring').quantity, 1);

  const audits = db.all(`SELECT source, detail FROM audit_log WHERE deck_id = ?`, [deckId]);
  assert.equal(audits.length, 2);
  assert.ok(audits.every((a) => a.source === 'edhrec'));
  assert.equal(new Set(audits.map((a) => JSON.parse(a.detail).batchId)).size, 1);
});

test("someone else's deck is refused", () => {
  assert.throws(() => addCardsToDeck(otherUser, { deckId, cardNames: ['Sol Ring'] }), /not found/);
});
