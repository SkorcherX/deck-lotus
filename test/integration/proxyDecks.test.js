/**
 * Proxy decks claim nothing from the real collection.
 *
 * A proxy pre-con's cards live in its own box and never in owned_printings,
 * so the deck must not count as holding copies (inventory), must not make a
 * real deck look short (readiness), must not be shopped for, and must read
 * as ready itself. A real deck listing the same card is the control.
 *
 * Run with `npm run test:integration`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-proxy-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { getInventoryStats } = await import('../../src/services/inventoryService.js');
const { getDeckReadiness } = await import('../../src/services/deckReadinessService.js');
const { getShoppingList } = await import('../../src/services/shoppingService.js');
const { importDeck } = await import('../../src/services/importService.js');
const { updateDeck } = await import('../../src/services/deckService.js');

let userId;
let realDeck;
let proxyDeck;

before(async () => {
  await runMigrations();

  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('proxy','px@example.com','x')`);
  userId = db.get(`SELECT id FROM users WHERE username='proxy'`).id;
  db.run(`INSERT INTO sets (code, name) VALUES ('AAA','Set A')`);
  db.run(`INSERT INTO cards (name, name_normalized, type_line, color_identity) VALUES ('Sol Ring','sol ring','Artifact','')`);
  const cardId = db.get(`SELECT id FROM cards WHERE name='Sol Ring'`).id;
  db.run(`INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity) VALUES (?,'uuid-sol','AAA','1','uncommon')`, [cardId]);
  const printingId = db.get(`SELECT id FROM printings WHERE uuid='uuid-sol'`).id;

  // One real copy, held by one real ready deck.
  db.run(`INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,1,0)`, [userId, printingId]);
  const deck = (name, isProxy) => {
    db.run(`INSERT INTO decks (user_id, name, format, status, is_proxy) VALUES (?,?,'casual','ready',?)`, [userId, name, isProxy]);
    const id = db.get(`SELECT id FROM decks WHERE name = ?`, [name]).id;
    db.run(`INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, board_type, is_foil) VALUES (?,?,1,0,'mainboard',0)`, [id, printingId]);
    return id;
  };
  realDeck = deck('Real', 0);
  proxyDeck = deck('Proxy', 1);
});

after(() => closeDb?.());

test('a proxy deck holds no copies of the collection', () => {
  const stats = getInventoryStats(userId);
  assert.equal(stats.inDecks, 1);
  assert.equal(stats.available, 0);
});

test('a proxy deck does not make a real deck look short', () => {
  const r = getDeckReadiness(userId, realDeck);
  assert.equal(r.state, 'ready');
  assert.equal(r.contestedCopies, 0);
});

test('a proxy deck reads as ready though none of its cards are owned', () => {
  db.run(`UPDATE owned_printings SET quantity = 0 WHERE user_id = ?`, [userId]);
  try {
    assert.equal(getDeckReadiness(userId, proxyDeck).state, 'ready');
    assert.equal(getDeckReadiness(userId, realDeck).state, 'needs_buying');
  } finally {
    db.run(`UPDATE owned_printings SET quantity = 1 WHERE user_id = ?`, [userId]);
  }
});

test('a proxy deck is never shopped for', () => {
  db.run(`UPDATE owned_printings SET quantity = 0 WHERE user_id = ?`, [userId]);
  try {
    const names = ({ sets }) => sets.flatMap((s) => s.cards.map((c) => c.name));
    assert.deepEqual(names(getShoppingList(userId, [proxyDeck], { includeWanted: false })), []);
    assert.deepEqual(names(getShoppingList(userId, [realDeck], { includeWanted: false })), ['Sol Ring']);
  } finally {
    db.run(`UPDATE owned_printings SET quantity = 1 WHERE user_id = ?`, [userId]);
  }
});

test('importing as proxy creates a ready proxy deck, and the flag can be toggled', () => {
  const result = importDeck(userId, 'Imported proxy', 'casual', [{ quantity: 1, name: 'Sol Ring' }], { isProxy: true });
  const deckId = result.deckId ?? result.deck?.id ?? result.id;
  const row = db.get(`SELECT status, is_proxy FROM decks WHERE id = ?`, [deckId]);
  assert.deepEqual({ ...row }, { status: 'ready', is_proxy: 1 });

  updateDeck(deckId, userId, { isProxy: false });
  assert.equal(db.get(`SELECT is_proxy FROM decks WHERE id = ?`, [deckId]).is_proxy, 0);
});
