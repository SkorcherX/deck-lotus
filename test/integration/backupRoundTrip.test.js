/**
 * Back it up, destroy it, restore it, and check you got the same thing back.
 *
 * This is the test that was missing. Version 1 of the backup format shipped
 * believing it saved the collection; it saved `owned_cards`, a legacy presence
 * table whose quantity is always the literal 1, and left `owned_printings` —
 * the actual inventory, quantities and foils and all — on the floor. It also
 * dropped `is_foil` from `deck_cards`, where finish is half the unique key.
 *
 * Nothing caught it because nothing ever restored a backup and compared. Every
 * assertion below is written against the round trip rather than against the
 * shape of the JSON, because the JSON looked entirely reasonable.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-backup-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { createBackup, restoreBackup } = await import('../../src/services/backupService.js');

let userId;
let partnerId;
let deckId;
const printings = {};

/** Wipe every table a restore is supposed to refill, leaving reference data. */
function wipeUserData() {
  for (const table of [
    'deck_card_disruptions', 'deck_games', 'deck_cards', 'deck_shares', 'decks',
    'trade_items', 'trades', 'api_keys', 'owned_cards', 'owned_printings',
    'shopping_list_items', 'found_cards', 'price_watches', 'audit_log',
  ]) {
    db.run(`DELETE FROM ${table}`);
  }
}

before(async () => {
  await runMigrations();

  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('owner','o@example.test','hash-owner')`);
  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('partner','p@example.test','hash-partner')`);
  userId = db.get(`SELECT id FROM users WHERE username='owner'`).id;
  partnerId = db.get(`SELECT id FROM users WHERE username='partner'`).id;

  db.run(`UPDATE users SET bulk_price_threshold = 2.5, theme = 'verdant' WHERE id = ?`, [userId]);

  db.run(`INSERT INTO sets (code, name) VALUES ('TST','Test Set')`);

  for (const name of ['Sol Ring', 'Counterspell', 'Brainstorm']) {
    db.run(
      `INSERT INTO cards (name, name_normalized, type_line, color_identity) VALUES (?,?,?,?)`,
      [name, name.toLowerCase(), 'Artifact', '']
    );
    const cardId = db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
    const uuid = `uuid-${name.replace(/\s+/g, '-')}`;
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity)
       VALUES (?,?,?,?,'rare')`,
      [cardId, uuid, 'TST', '1']
    );
    printings[name] = { cardId, uuid, id: db.get(`SELECT id FROM printings WHERE uuid=?`, [uuid]).id };
  }

  db.run(`INSERT INTO decks (user_id, name, format, status) VALUES (?,'Test Deck','commander','ready')`, [userId]);
  deckId = db.get(`SELECT id FROM decks WHERE name='Test Deck'`).id;

  // The case version 1 destroyed: the same printing listed twice in one deck,
  // once foil and once not. UNIQUE(deck_id, printing_id, is_sideboard, is_foil)
  // makes these two legitimate rows; a backup without is_foil restores one.
  db.run(
    `INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_foil, board_type)
     VALUES (?,?,1,0,0,'mainboard')`, [deckId, printings['Sol Ring'].id]
  );
  db.run(
    `INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_foil, board_type)
     VALUES (?,?,1,0,1,'mainboard')`, [deckId, printings['Sol Ring'].id]
  );

  // The collection: a normal copy and a foil of the same printing, at
  // different quantities, so a collapse is visible rather than plausible.
  db.run(`INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,4,0)`,
    [userId, printings['Counterspell'].id]);
  db.run(`INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,2,1)`,
    [userId, printings['Counterspell'].id]);

  db.run(`INSERT INTO owned_cards (user_id, card_id, quantity) VALUES (?,?,1)`,
    [userId, printings['Counterspell'].cardId]);

  db.run(`INSERT INTO shopping_list_items (user_id, printing_id, quantity, is_foil, note)
          VALUES (?,?,3,1,'foil playset')`, [userId, printings['Brainstorm'].id]);

  db.run(`INSERT INTO found_cards (user_id, card_id, card_name, quantity) VALUES (?,?,?,2)`,
    [userId, printings['Sol Ring'].cardId, 'Sol Ring']);

  db.run(`INSERT INTO deck_games (deck_id, user_id, result, played_at) VALUES (?,?,'win','2026-08-01')`,
    [deckId, userId]);
  db.run(`INSERT INTO deck_games (deck_id, user_id, result, played_at) VALUES (?,?,'loss','2026-08-02')`,
    [deckId, userId]);

  db.run(`INSERT INTO trades (from_user_id, to_user_id, status, note) VALUES (?,?,'pending','swap')`,
    [userId, partnerId]);
  const tradeId = db.get(`SELECT id FROM trades LIMIT 1`).id;
  db.run(`INSERT INTO trade_items (trade_id, printing_id, is_foil, quantity, direction, declined)
          VALUES (?,?,1,1,'offer',0)`, [tradeId, printings['Sol Ring'].id]);

  db.run(
    `INSERT INTO deck_card_disruptions (deck_id, trade_id, printing_id, is_foil, board_type, quantity, card_name)
     VALUES (?,?,?,1,'mainboard',1,'Sol Ring')`,
    [deckId, tradeId, printings['Sol Ring'].id]
  );

  db.run(
    `INSERT INTO audit_log (user_id, actor_user_id, entity_type, action, source, printing_uuid,
                            card_name, is_foil, quantity_before, quantity_after, quantity_delta)
     VALUES (?,?,'inventory','inventory.add','api',?,?,1,0,2,2)`,
    [userId, userId, printings['Counterspell'].uuid, 'Counterspell']
  );

  db.run(`INSERT INTO api_keys (user_id, key_hash, name) VALUES (?,'khash','laptop')`, [userId]);
  db.run(`INSERT INTO price_watches (user_id, card_name, max_price, condition, is_active)
          VALUES (?,'Sol Ring',1.5,'any',1)`, [userId]);
});

after(() => {
  try { closeDb(); } catch { /* already closed */ }
  try { fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true }); } catch { /* temp */ }
});

describe('backup and restore round trip', () => {
  test('the collection survives, quantities and foils intact', () => {
    const backup = createBackup();
    wipeUserData();

    assert.equal(db.get(`SELECT COUNT(*) c FROM owned_printings`).c, 0, 'wipe did not take');

    const results = restoreBackup(backup, { overwrite: false });
    assert.deepEqual(results.errors, []);

    const owned = db.all(
      `SELECT op.quantity, op.is_foil FROM owned_printings op
       JOIN printings p ON op.printing_id = p.id
       WHERE p.uuid = ? ORDER BY op.is_foil`,
      [printings['Counterspell'].uuid]
    );

    assert.deepEqual(owned, [
      { quantity: 4, is_foil: 0 },
      { quantity: 2, is_foil: 1 },
    ], 'the collection did not come back as it went in');
  });

  test('a foil and a non-foil of one card stay two deck rows', () => {
    const backup = createBackup();
    wipeUserData();
    restoreBackup(backup, { overwrite: false });

    const rows = db.all(
      `SELECT dc.quantity, dc.is_foil FROM deck_cards dc
       JOIN printings p ON dc.printing_id = p.id
       WHERE dc.deck_id = ? AND p.uuid = ? ORDER BY dc.is_foil`,
      [deckId, printings['Sol Ring'].uuid]
    );

    assert.equal(rows.length, 2, 'the foil and non-foil rows collapsed into one');
    assert.deepEqual(rows.map((r) => r.is_foil), [0, 1]);
  });

  test('deck status is not silently reset to building', () => {
    const backup = createBackup();
    wipeUserData();
    restoreBackup(backup, { overwrite: false });

    assert.equal(db.get(`SELECT status FROM decks WHERE id = ?`, [deckId]).status, 'ready');
  });

  test('the wanted list, found pile and price watches come back', () => {
    const backup = createBackup();
    wipeUserData();
    restoreBackup(backup, { overwrite: false });

    const wanted = db.get(`SELECT quantity, is_foil, note FROM shopping_list_items`);
    assert.deepEqual(wanted, { quantity: 3, is_foil: 1, note: 'foil playset' });

    assert.equal(db.get(`SELECT card_name, quantity FROM found_cards`).quantity, 2);
    assert.equal(db.get(`SELECT COUNT(*) c FROM price_watches`).c, 1);
  });

  test('match records come back as a log, so the derived total still holds', () => {
    const backup = createBackup();
    wipeUserData();
    restoreBackup(backup, { overwrite: false });

    const games = db.all(`SELECT result FROM deck_games ORDER BY played_at`);
    assert.deepEqual(games.map((g) => g.result), ['win', 'loss']);
  });

  test('trades, their items and the disruption they caused all return', () => {
    const backup = createBackup();
    wipeUserData();
    const results = restoreBackup(backup, { overwrite: false });

    assert.equal(results.trades, 1);
    assert.equal(results.trade_items, 1);

    const item = db.get(`SELECT is_foil, quantity, direction, declined FROM trade_items`);
    assert.deepEqual(item, { is_foil: 1, quantity: 1, direction: 'offer', declined: 0 });

    const disruption = db.get(`SELECT card_name, is_foil, resolution FROM deck_card_disruptions`);
    assert.equal(disruption.card_name, 'Sol Ring');
    assert.equal(disruption.resolution, null, 'an unacknowledged disruption must stay unacknowledged');
  });

  test('the audit log returns keyed on uuid, not on a reassigned integer', () => {
    const backup = createBackup();
    wipeUserData();
    restoreBackup(backup, { overwrite: false });

    const entry = db.get(`SELECT printing_uuid, printing_id, card_name, quantity_delta FROM audit_log`);
    assert.equal(entry.printing_uuid, printings['Counterspell'].uuid);
    assert.equal(entry.card_name, 'Counterspell');
    assert.equal(entry.quantity_delta, 2);
    // printing_id is not restored on purpose: the weekly MTGJSON rebuild
    // reassigns it, so a number carried over from the old database would point
    // at an unrelated card.
    assert.equal(entry.printing_id, null);
  });

  test('per-user settings survive', () => {
    const backup = createBackup();
    wipeUserData();
    restoreBackup(backup, { overwrite: false });

    const user = db.get(`SELECT theme, bulk_price_threshold FROM users WHERE id = ?`, [userId]);
    assert.equal(user.theme, 'verdant');
    assert.equal(user.bulk_price_threshold, 2.5);
  });

  test('a printing the reimport dropped is reported, not swallowed', () => {
    const backup = createBackup();

    // Simulate a uuid that no longer exists, the way a reimport can retire one.
    for (const row of backup.data.owned_printings) {
      if (row.printing_uuid === printings['Counterspell'].uuid) row.printing_uuid = 'uuid-gone';
    }

    wipeUserData();
    const results = restoreBackup(backup, { overwrite: false });

    assert.ok(
      results.errors.some((e) => e.includes('uuid-gone')),
      'a row that could not be restored vanished without saying so'
    );
  });
});

describe('version 1 backups', () => {
  test('still restore, without claiming a finish nobody chose', () => {
    // What version 1 actually produced: no owned_printings, no is_foil, no
    // status, and a deck_cards row shaped the old way.
    const v1 = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      data: {
        users: [{
          id: userId, username: 'owner', email: 'o@example.test',
          password_hash: 'hash-owner', is_admin: 0,
          created_at: null, updated_at: null,
        }],
        owned_cards: [],
        decks: [{
          id: deckId, user_id: userId, name: 'Test Deck', format: 'commander',
          description: null, created_at: null, updated_at: null,
        }],
        deck_cards: [{
          id: 1, deck_id: deckId, quantity: 1, is_sideboard: 0, is_commander: 0,
          board_type: 'mainboard', added_at: null,
          printing_uuid: printings['Sol Ring'].uuid,
        }],
        deck_shares: [],
      },
    };

    wipeUserData();
    const results = restoreBackup(v1, { overwrite: false });

    assert.deepEqual(results.errors, []);
    assert.equal(results.deck_cards, 1);

    // The columns that did not exist then get their defaults rather than a
    // null written over them by INSERT OR REPLACE.
    assert.equal(db.get(`SELECT is_foil FROM deck_cards`).is_foil, 0);
    assert.equal(db.get(`SELECT status FROM decks WHERE id = ?`, [deckId]).status, 'building');
    assert.equal(db.get(`SELECT bulk_price_threshold FROM users WHERE id = ?`, [userId]).bulk_price_threshold, 1.0);
  });
});
