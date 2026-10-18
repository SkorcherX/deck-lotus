/**
 * The Commander Spellbook cache, against a real schema and a stubbed fetch.
 *
 * What has to hold: reading a deck never calls out; a lookup is cached for
 * exactly the list it was made for; changing the list marks it stale rather
 * than dropping it; a failed lookup caches nothing; and the bracket picks the
 * cached combos up.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-combos-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { getDeckById, addCardToDeck } = await import('../../src/services/deckService.js');
const { refreshDeckCombos } = await import('../../src/services/comboService.js');

let userId, deckId;
const printing = {};
const realFetch = globalThis.fetch;
let calls = 0;

function addCard(name, cmc) {
  db.run(`INSERT INTO cards (name, name_normalized, type_line, oracle_text, cmc) VALUES (?,?,?,?,?)`,
    [name, name.toLowerCase(), 'Instant', '', cmc]);
  const cardId = db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
  db.run(`INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity) VALUES (?,?, 'TST', '1', 'rare')`,
    [cardId, `uuid-${name}`]);
  printing[name] = db.get(`SELECT id FROM printings WHERE uuid = ?`, [`uuid-${name}`]).id;
}

const spellbookAnswer = {
  results: {
    included: [{
      id: '1-2',
      uses: [{ card: { name: "Thassa's Oracle" }, zoneLocations: ['H'] },
             { card: { name: 'Demonic Consultation' }, zoneLocations: ['H'] }],
      requires: [],
      produces: [{ feature: { name: 'Win the game' } }],
      manaValueNeeded: 3,
      bracketTag: 'R',
    }],
  },
};

before(async () => {
  await runMigrations();
  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('owner','o@example.test','h')`);
  userId = db.get(`SELECT id FROM users WHERE username='owner'`).id;
  db.run(`INSERT INTO sets (code, name) VALUES ('TST','Test Set')`);
  addCard("Thassa's Oracle", 2);
  addCard('Demonic Consultation', 1);
  addCard('Opt', 1);
  db.run(`INSERT INTO decks (user_id, name, format) VALUES (?, 'Combo', 'commander')`, [userId]);
  deckId = db.get(`SELECT id FROM decks WHERE name = 'Combo'`).id;
  addCardToDeck(deckId, userId, printing["Thassa's Oracle"], 1, false, false, 'mainboard');
  addCardToDeck(deckId, userId, printing['Demonic Consultation'], 1, false, false, 'mainboard');

  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => spellbookAnswer };
  };
});

after(() => {
  globalThis.fetch = realFetch;
  closeDb();
});

describe('deck combo cache', () => {
  test('reading a deck never calls out, and reports nothing looked up', () => {
    const deck = getDeckById(deckId, userId);
    assert.equal(calls, 0);
    assert.equal(deck.bracket.combosStatus, 'none');
    assert.equal(deck.bracket.minBracket, 1);
  });

  test('a lookup is cached and the bracket counts it', async () => {
    await refreshDeckCombos(deckId, getDeckById(deckId, userId).cards);
    assert.equal(calls, 1);
    const deck = getDeckById(deckId, userId);
    assert.equal(deck.bracket.combosStatus, 'current');
    assert.equal(deck.bracket.minBracket, 4);
    assert.equal(deck.bracket.reasons[0].rule, 'early_combos');
    assert.deepEqual(deck.bracket.reasons[0].cards, ["Demonic Consultation + Thassa's Oracle"]);
  });

  test('changing the list keeps the combos but marks them stale', () => {
    addCardToDeck(deckId, userId, printing.Opt, 1, false, false, 'mainboard');
    const deck = getDeckById(deckId, userId);
    assert.equal(deck.bracket.combosStatus, 'stale');
    assert.equal(deck.bracket.minBracket, 4);
  });

  test('a failed lookup caches nothing', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(refreshDeckCombos(deckId, getDeckById(deckId, userId).cards), /503/);
    assert.equal(getDeckById(deckId, userId).bracket.combosStatus, 'stale');
  });
});
