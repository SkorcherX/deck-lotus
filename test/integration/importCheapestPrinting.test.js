/**
 * A deck-list line that names only a card asks for the card, not a printing:
 * it must land on the cheapest English printing, never whichever row the
 * table happened to list first (a showcase priced at fifty times the card) and
 * never a cheaper Japanese one. A line that names its set keeps exactly what
 * it asked for, Japanese included.
 *
 * Run with `npm run test:integration`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-import-')), 'test.db');

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { importDeck, parseDeckList } = await import('../../src/services/importService.js');
const shopping = await import('../../src/services/shoppingService.js');

let userId;
const p = {};

before(async () => {
  await runMigrations();
  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('a','a@example.test','x')`);
  userId = db.get(`SELECT id FROM users WHERE username='a'`).id;
  db.run(`INSERT INTO sets (code, name, type) VALUES ('SHO','Showcase','expansion'), ('CHP','Cheap','expansion'), ('JPN','Japanese','expansion'), ('STA','Archive','masterpiece')`);
  db.run(`INSERT INTO cards (name, name_normalized, type_line) VALUES ('Sol Ring','sol ring','Artifact')`);
  const cardId = db.get(`SELECT id FROM cards WHERE name='Sol Ring'`).id;

  // Inserted showcase-first, so a bare "LIMIT 1" lands on the dearest row.
  for (const [key, set, number, price, language] of [
    ['showcase', 'SHO', '400', 120, 'en'],
    ['cheap', 'CHP', '1', 1.5, 'en'],
    ['japanese', 'JPN', '1', 0.5, 'Japanese'],
    ['jpstar', 'CHP', '1★', 0.25, 'en'],
  ]) {
    db.run(`INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity, language) VALUES (?,?,?,?,'uncommon',?)`,
      [cardId, key, set, number, language]);
    db.run(`INSERT INTO prices (printing_uuid, provider, price_type, price) VALUES (?,'tcgplayer','normal',?)`, [key, price]);
    p[key] = db.get(`SELECT id FROM printings WHERE uuid = ?`, [key]).id;
  }
});

after(() => closeDb());

const printingOf = (deckId) => db.get(`SELECT printing_id FROM deck_cards WHERE deck_id = ?`, [deckId]).printing_id;

test('a bare name lands on the cheapest English printing', () => {
  const { deckId } = importDeck(userId, 'Bare', 'commander', parseDeckList('1 Sol Ring'));
  assert.equal(printingOf(deckId), p.cheap);
});

test('a line naming its set keeps the printing it asked for, Japanese included', () => {
  const { deckId: shown } = importDeck(userId, 'Set', 'commander', parseDeckList('1 Sol Ring (SHO) 400'));
  assert.equal(printingOf(shown), p.showcase);
  const { deckId: jp } = importDeck(userId, 'JP', 'commander', parseDeckList('1 Sol Ring (JPN) 1'));
  assert.equal(printingOf(jp), p.japanese);
});

test('the shopping page paste box resolves a bare name the same way', () => {
  const { added, unresolved } = shopping.addWantedCardsBulk(userId, '1 Sol Ring');
  assert.equal(unresolved.length, 0);
  assert.equal(added.length, 1);
  assert.equal(db.get(`SELECT printing_id FROM shopping_list_items WHERE user_id = ?`, [userId]).printing_id, p.cheap);
});
