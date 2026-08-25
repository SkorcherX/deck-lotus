import { getDb } from '../db/index.js';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { getSettings, updateSettings } from './settingsService.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Backup configuration
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, '../../data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// node-cron reads a bare cron expression in the *process's* timezone, which in
// a container with no TZ set is UTC. "Daily at 2 AM" therefore fired at 2 AM
// UTC — 6 or 7 PM the previous day on the US west coast — so the schedule did
// not mean what the settings page said it meant.
//
// Same fix and same env vars as the weekly MTGJSON sync (syncService.js), so
// one setting governs both and they cannot drift into different days.
// BACKUP_TIMEZONE overrides, SYNC_TIMEZONE and TZ are the fallbacks.
const BACKUP_TIMEZONE =
  process.env.BACKUP_TIMEZONE || process.env.SYNC_TIMEZONE || process.env.TZ || 'UTC';

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Scheduled backup state. The config itself is persisted in app-settings.json —
// holding it only in memory meant every container rebuild silently turned the
// schedule off — and is loaded back here at startup by initScheduledBackups().
let scheduledBackupJob = null;
let backupConfig = { ...getSettings().scheduledBackups };

function persistBackupConfig() {
  try {
    updateSettings({ scheduledBackups: backupConfig });
  } catch (err) {
    // A schedule that is running but unsaved beats refusing to schedule at all.
    console.error('Failed to persist backup config:', err.message);
  }
}

/**
 * A backup of everything a user would lose.
 *
 * Two rules govern what is in here, and both come from the weekly MTGJSON
 * sync (scripts/import-mtgjson.js), which wipes and rebuilds `cards` and
 * `printings`:
 *
 *   1. The card tables are NOT backed up. They are reference data, rebuilt
 *      from MTGJSON on every sync, and they are the overwhelming bulk of the
 *      database.
 *   2. Nothing may be stored as a `printing_id` or a `card_id`, because those
 *      integers are reassigned by that rebuild. A printing is identified by
 *      its `uuid` and a card by its `name`, both of which survive. Anything
 *      backed up by integer id would restore as a different card, which is
 *      worse than not restoring at all.
 *
 * Format version 2 exists because version 1 silently missed most of this. It
 * captured `owned_cards` — a legacy presence table whose quantity is written
 * as a literal 1 (see cardService.js) — and called it the collection, while
 * the real inventory in `owned_printings` went unsaved. It also dropped
 * `is_foil` from `deck_cards`, where finish is part of the unique key, so a
 * restore collapsed a foil and a non-foil onto one row. Trades, disruptions,
 * the wanted list, match records, the audit log and price watches were all
 * absent.
 *
 * Version 1 files still restore: every list is read with `|| []`, and the
 * columns added since are defaulted at the call site rather than assumed.
 */
export function createBackup(userId = null) {
  const db = getDb();

  const backup = {
    version: '2.0',
    timestamp: new Date().toISOString(),
    data: {}
  };

  const userFilter = userId ? `WHERE id = ${userId}` : '';

  backup.data.users = db.prepare(`
    SELECT id, username, email, password_hash, is_admin, theme, avatar_type, avatar_value,
           bulk_price_threshold, created_at, updated_at
    FROM users
    ${userFilter}
  `).all();

  const userIds = backup.data.users.map(u => u.id);

  if (userIds.length === 0) {
    return backup; // No users to backup
  }

  const userIdsStr = userIds.join(',');

  backup.data.api_keys = db.prepare(`
    SELECT id, user_id, key_hash, name, last_used, created_at
    FROM api_keys
    WHERE user_id IN (${userIdsStr})
  `).all();

  // The legacy presence table. Kept so a version 2 backup can still rebuild
  // what version 1 held, and because parts of the app still read it — but it
  // is not the collection. owned_printings below is.
  backup.data.owned_cards = db.prepare(`
    SELECT oc.id, oc.user_id, oc.quantity, oc.created_at, oc.updated_at,
           c.name as card_name
    FROM owned_cards oc
    JOIN cards c ON oc.card_id = c.id
    WHERE oc.user_id IN (${userIdsStr})
  `).all();

  // The actual collection. Foil copies are a separate row keyed on
  // UNIQUE(user_id, printing_id, is_foil), so is_foil has to travel with the
  // quantity or two rows restore as one.
  backup.data.owned_printings = db.prepare(`
    SELECT op.id, op.user_id, op.quantity, op.is_foil, op.created_at, op.updated_at,
           p.uuid as printing_uuid
    FROM owned_printings op
    JOIN printings p ON op.printing_id = p.id
    WHERE op.user_id IN (${userIdsStr})
  `).all();

  // Cards wanted on their own account. The other half of the shopping list is
  // derived from decks on every read and so needs no backup.
  backup.data.shopping_list_items = db.prepare(`
    SELECT sli.id, sli.user_id, sli.quantity, sli.is_foil, sli.note,
           sli.created_at, sli.updated_at,
           p.uuid as printing_uuid
    FROM shopping_list_items sli
    JOIN printings p ON sli.printing_id = p.id
    WHERE sli.user_id IN (${userIdsStr})
  `).all();

  // Cards ticked off at a shop but not yet owned. Already denormalised by
  // card name in the table itself, so it needs no join.
  backup.data.found_cards = db.prepare(`
    SELECT id, user_id, card_name, quantity, created_at
    FROM found_cards
    WHERE user_id IN (${userIdsStr})
  `).all();

  backup.data.price_watches = db.prepare(`
    SELECT id, user_id, card_name, max_price, condition, notes, is_active,
           expires_at, last_checked, last_price, last_notified, created_at,
           set_code, set_name
    FROM price_watches
    WHERE user_id IN (${userIdsStr})
  `).all();

  // The audit log already carries what it needs about a card — it denormalises
  // name, set and collector number precisely because the card tables are
  // rebuilt weekly — so it is copied as it stands.
  //
  // `printing_id` comes too, despite being the one column a rebuild
  // invalidates. Rows written before commit 951ddd1 have no `printing_uuid`
  // and no name, and that stale integer is the only handle left for
  // recovering what they were about (see scripts/backfill-audit-cards.js,
  // which corroborates it against a table the import restores by uuid before
  // trusting it). Dropping it here would make those rows permanently
  // unidentifiable the first time somebody restored a backup. Carrying it
  // preserves exactly the situation in the live database rather than
  // degrading it — nothing reads this column directly, and nothing should.
  backup.data.audit_log = db.prepare(`
    SELECT id, user_id, actor_user_id, entity_type, action, source,
           printing_id, printing_uuid, card_name, set_code, collector_number, is_foil,
           quantity_before, quantity_after, quantity_delta,
           deck_id, deck_name, trade_id, detail, created_at
    FROM audit_log
    WHERE user_id IN (${userIdsStr})
  `).all();

  // Trades have two sides. Both are captured whichever user is being backed
  // up, because a trade restored with only one end is not a trade.
  backup.data.trades = db.prepare(`
    SELECT id, from_user_id, to_user_id, status, note, created_at, resolved_at,
           awaiting_user_id
    FROM trades
    WHERE from_user_id IN (${userIdsStr}) OR to_user_id IN (${userIdsStr})
  `).all();

  const tradeIds = backup.data.trades.map(t => t.id);

  backup.data.trade_items = tradeIds.length
    ? db.prepare(`
        SELECT ti.id, ti.trade_id, ti.is_foil, ti.quantity, ti.direction, ti.declined,
               p.uuid as printing_uuid
        FROM trade_items ti
        JOIN printings p ON ti.printing_id = p.id
        WHERE ti.trade_id IN (${tradeIds.join(',')})
      `).all()
    : [];

  backup.data.decks = db.prepare(`
    SELECT id, user_id, name, format, description, status, created_at, updated_at
    FROM decks
    WHERE user_id IN (${userIdsStr})
  `).all();

  const deckIds = backup.data.decks.map(d => d.id);

  if (deckIds.length > 0) {
    const deckIdsStr = deckIds.join(',');

    // is_foil is part of UNIQUE(deck_id, printing_id, is_sideboard, is_foil).
    // Version 1 omitted it, so a deck listing a card in both finishes restored
    // as one row and the second was discarded.
    backup.data.deck_cards = db.prepare(`
      SELECT dc.id, dc.deck_id, dc.quantity, dc.is_sideboard, dc.is_commander,
             dc.is_foil, dc.board_type, dc.added_at,
             p.uuid as printing_uuid
      FROM deck_cards dc
      JOIN printings p ON dc.printing_id = p.id
      WHERE dc.deck_id IN (${deckIdsStr})
    `).all();

    backup.data.deck_shares = db.prepare(`
      SELECT id, deck_id, user_id, share_token, is_active, created_at, expires_at
      FROM deck_shares
      WHERE deck_id IN (${deckIdsStr})
    `).all();

    // A deck left short by a trade, awaiting its owner's decision. An
    // unacknowledged one is the whole point of the row, so losing it in a
    // restore loses a decision somebody still has to make.
    backup.data.deck_card_disruptions = db.prepare(`
      SELECT dcd.id, dcd.deck_id, dcd.trade_id, dcd.is_foil, dcd.board_type,
             dcd.quantity, dcd.card_name, dcd.created_at, dcd.acknowledged_at,
             dcd.resolution,
             p.uuid as printing_uuid
      FROM deck_card_disruptions dcd
      JOIN printings p ON dcd.printing_id = p.id
      WHERE dcd.deck_id IN (${deckIdsStr})
    `).all();

    // Records are a log, never a stored total, so the log is the backup.
    backup.data.deck_games = db.prepare(`
      SELECT id, deck_id, user_id, result, played_at, opponent, opponent_deck,
             format, notes, created_at
      FROM deck_games
      WHERE deck_id IN (${deckIdsStr})
    `).all();
  } else {
    backup.data.deck_cards = [];
    backup.data.deck_shares = [];
    backup.data.deck_card_disruptions = [];
    backup.data.deck_games = [];
  }

  return backup;
}

/**
 * Restore user data from a backup JSON object
 *
 * Options:
 * - overwrite: if true, delete existing data before restore (default: false)
 * - userId: if provided, only restore data for this user
 *
 * Reads both format versions. Version 1 files simply have fewer keys, and
 * every list is read with `|| []`; columns that did not exist then are
 * defaulted here rather than assumed present, because INSERT OR REPLACE
 * writes a column rather than letting its default apply.
 *
 * Rows whose card or printing cannot be found are reported, not skipped
 * silently: after a reimport a handful of uuids legitimately vanish, and the
 * difference between "restored, minus these four" and "restored" is the
 * difference between a backup you can trust and one you cannot.
 */
export function restoreBackup(backupData, options = {}) {
  const db = getDb();
  const { overwrite = false, userId = null } = options;

  const results = {
    users: 0,
    api_keys: 0,
    owned_cards: 0,
    owned_printings: 0,
    shopping_list_items: 0,
    found_cards: 0,
    price_watches: 0,
    audit_log: 0,
    trades: 0,
    trade_items: 0,
    decks: 0,
    deck_cards: 0,
    deck_shares: 0,
    deck_card_disruptions: 0,
    deck_games: 0,
    errors: []
  };

  if (!backupData.version || !backupData.data) {
    throw new Error('Invalid backup format');
  }

  let usersToRestore = backupData.data.users || [];
  if (userId) {
    usersToRestore = usersToRestore.filter(u => u.id === userId);
    if (usersToRestore.length === 0) {
      throw new Error(`User ${userId} not found in backup`);
    }
  }

  const restore = db.transaction(() => {
    if (overwrite && userId) {
      db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM owned_cards WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM owned_printings WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM shopping_list_items WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM found_cards WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM price_watches WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM audit_log WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM trades WHERE from_user_id = ? OR to_user_id = ?').run(userId, userId);
      db.prepare('DELETE FROM deck_games WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM deck_card_disruptions WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)').run(userId);
      db.prepare('DELETE FROM deck_cards WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)').run(userId);
      db.prepare('DELETE FROM deck_shares WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)').run(userId);
      db.prepare('DELETE FROM decks WHERE user_id = ?').run(userId);
      // Don't delete the user itself, just update it
    } else if (overwrite && !userId) {
      db.prepare('DELETE FROM deck_card_disruptions').run();
      db.prepare('DELETE FROM deck_games').run();
      db.prepare('DELETE FROM deck_cards').run();
      db.prepare('DELETE FROM deck_shares').run();
      db.prepare('DELETE FROM decks').run();
      db.prepare('DELETE FROM trade_items').run();
      db.prepare('DELETE FROM trades').run();
      db.prepare('DELETE FROM api_keys').run();
      db.prepare('DELETE FROM owned_cards').run();
      db.prepare('DELETE FROM owned_printings').run();
      db.prepare('DELETE FROM shopping_list_items').run();
      db.prepare('DELETE FROM found_cards').run();
      db.prepare('DELETE FROM price_watches').run();
      db.prepare('DELETE FROM audit_log').run();
      db.prepare('DELETE FROM users').run();
    }

    // ---- Lookups that turn stable identifiers back into current ids -------
    //
    // Memoised: a large collection asks for the same few thousand uuids across
    // owned_printings, deck_cards and the wanted list, and the restore runs
    // inside one transaction where every one of those is a round trip.
    const getCardStmt = db.prepare(`SELECT id FROM cards WHERE name = ? LIMIT 1`);
    const getPrintingStmt = db.prepare(`SELECT id FROM printings WHERE uuid = ? LIMIT 1`);

    const cardCache = new Map();
    const printingCache = new Map();

    const cardIdFor = (name) => {
      if (!cardCache.has(name)) cardCache.set(name, getCardStmt.get(name)?.id ?? null);
      return cardCache.get(name);
    };

    const printingIdFor = (uuid) => {
      if (!printingCache.has(uuid)) printingCache.set(uuid, getPrintingStmt.get(uuid)?.id ?? null);
      return printingCache.get(uuid);
    };

    /**
     * Run one insert per row, counting successes and collecting failures.
     *
     * Every table below restores the same way and the loop was copied per
     * table in version 1, which is how three of them ended up with subtly
     * different error handling.
     */
    const restoreRows = (key, rows, insert, describe) => {
      for (const row of rows) {
        try {
          if (insert(row) !== false) results[key]++;
        } catch (e) {
          results.errors.push(`${describe(row)}: ${e.message}`);
        }
      }
    };

    // ---- Users -----------------------------------------------------------
    const insertUser = db.prepare(`
      INSERT OR REPLACE INTO users (id, username, email, password_hash, is_admin, theme,
                                    avatar_type, avatar_value, bulk_price_threshold,
                                    created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    restoreRows('users', usersToRestore, (user) => {
      insertUser.run(
        user.id,
        user.username,
        user.email,
        user.password_hash,
        user.is_admin || 0,
        // Backups taken before these columns existed have no value here, and
        // INSERT OR REPLACE writes the column rather than defaulting it, so
        // each fallback has to be spelled out.
        user.theme || 'arcane',
        user.avatar_type || 'gravatar',
        user.avatar_value ?? null,
        user.bulk_price_threshold ?? 1.0,
        user.created_at,
        user.updated_at
      );
    }, (u) => `User ${u.username}`);

    const restoredUserIds = usersToRestore.map(u => u.id);
    const mine = (row) => restoredUserIds.includes(row.user_id);

    // ---- API keys --------------------------------------------------------
    const insertApiKey = db.prepare(`
      INSERT OR REPLACE INTO api_keys (id, user_id, key_hash, name, last_used, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    restoreRows('api_keys', (backupData.data.api_keys || []).filter(mine), (key) => {
      insertApiKey.run(key.id, key.user_id, key.key_hash, key.name, key.last_used, key.created_at);
    }, (k) => `API key ${k.name}`);

    // ---- The collection --------------------------------------------------
    const insertOwnedCard = db.prepare(`
      INSERT OR REPLACE INTO owned_cards (user_id, card_id, quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    restoreRows('owned_cards', (backupData.data.owned_cards || []).filter(mine), (row) => {
      const cardId = cardIdFor(row.card_name);
      if (!cardId) {
        results.errors.push(`Card "${row.card_name}" not found in database`);
        return false;
      }
      insertOwnedCard.run(row.user_id, cardId, row.quantity, row.created_at, row.updated_at);
    }, (r) => `Owned card ${r.card_name}`);

    const insertOwnedPrinting = db.prepare(`
      INSERT OR REPLACE INTO owned_printings (user_id, printing_id, quantity, is_foil, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    restoreRows('owned_printings', (backupData.data.owned_printings || []).filter(mine), (row) => {
      const printingId = printingIdFor(row.printing_uuid);
      if (!printingId) {
        results.errors.push(`Printing UUID ${row.printing_uuid} not found (owned printing)`);
        return false;
      }
      insertOwnedPrinting.run(
        row.user_id, printingId, row.quantity, row.is_foil ? 1 : 0,
        row.created_at, row.updated_at
      );
    }, (r) => `Owned printing ${r.printing_uuid}`);

    // ---- The wanted list, the found pile, price watches -------------------
    const insertWanted = db.prepare(`
      INSERT OR REPLACE INTO shopping_list_items (id, user_id, printing_id, quantity, is_foil, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    restoreRows('shopping_list_items', (backupData.data.shopping_list_items || []).filter(mine), (row) => {
      const printingId = printingIdFor(row.printing_uuid);
      if (!printingId) {
        results.errors.push(`Printing UUID ${row.printing_uuid} not found (wanted list)`);
        return false;
      }
      insertWanted.run(
        row.id, row.user_id, printingId, row.quantity, row.is_foil ? 1 : 0,
        row.note, row.created_at, row.updated_at
      );
    }, (r) => `Wanted card ${r.printing_uuid}`);

    // found_cards holds card_id as a plain integer with the name beside it,
    // so the name is what restores and the id is looked up fresh.
    const insertFound = db.prepare(`
      INSERT OR REPLACE INTO found_cards (id, user_id, card_id, card_name, quantity, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    restoreRows('found_cards', (backupData.data.found_cards || []).filter(mine), (row) => {
      const cardId = cardIdFor(row.card_name);
      if (!cardId) {
        results.errors.push(`Card "${row.card_name}" not found (found pile)`);
        return false;
      }
      insertFound.run(row.id, row.user_id, cardId, row.card_name, row.quantity, row.created_at);
    }, (r) => `Found card ${r.card_name}`);

    const insertWatch = db.prepare(`
      INSERT OR REPLACE INTO price_watches (id, user_id, card_name, max_price, condition, notes,
                                            is_active, expires_at, last_checked, last_price,
                                            last_notified, created_at, set_code, set_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    restoreRows('price_watches', (backupData.data.price_watches || []).filter(mine), (row) => {
      insertWatch.run(
        row.id, row.user_id, row.card_name, row.max_price, row.condition ?? 'any', row.notes,
        row.is_active ?? 1, row.expires_at, row.last_checked, row.last_price,
        row.last_notified, row.created_at, row.set_code, row.set_name
      );
    }, (r) => `Price watch ${r.card_name}`);

    // ---- Decks -----------------------------------------------------------
    const insertDeck = db.prepare(`
      INSERT OR REPLACE INTO decks (id, user_id, name, format, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const decks = (backupData.data.decks || []).filter(mine);

    restoreRows('decks', decks, (deck) => {
      insertDeck.run(
        deck.id, deck.user_id, deck.name, deck.format, deck.description,
        deck.status || 'building',
        deck.created_at, deck.updated_at
      );
    }, (d) => `Deck ${d.name}`);

    const restoredDeckIds = decks.map(d => d.id);
    const inDeck = (row) => restoredDeckIds.includes(row.deck_id);

    const insertDeckCard = db.prepare(`
      INSERT OR REPLACE INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_commander,
                                         is_foil, board_type, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    restoreRows('deck_cards', (backupData.data.deck_cards || []).filter(inDeck), (row) => {
      const printingId = printingIdFor(row.printing_uuid);
      if (!printingId) {
        results.errors.push(`Printing UUID ${row.printing_uuid} not found in database`);
        return false;
      }
      insertDeckCard.run(
        row.deck_id, printingId, row.quantity, row.is_sideboard, row.is_commander,
        // Version 1 backups have no finish. Non-foil is the safe assumption:
        // it is what the deck builder defaults to, and the alternative marks
        // every card in the deck as a foil nobody owns.
        row.is_foil ? 1 : 0,
        row.board_type || 'mainboard',
        row.added_at
      );
    }, () => 'Deck card');

    const insertDeckShare = db.prepare(`
      INSERT OR REPLACE INTO deck_shares (id, deck_id, user_id, share_token, is_active, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    restoreRows('deck_shares', (backupData.data.deck_shares || []).filter(inDeck), (share) => {
      insertDeckShare.run(
        share.id, share.deck_id, share.user_id, share.share_token,
        share.is_active, share.created_at, share.expires_at
      );
    }, () => 'Deck share');

    const insertGame = db.prepare(`
      INSERT OR REPLACE INTO deck_games (id, deck_id, user_id, result, played_at, opponent,
                                         opponent_deck, format, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    restoreRows('deck_games', (backupData.data.deck_games || []).filter(inDeck), (game) => {
      insertGame.run(
        game.id, game.deck_id, game.user_id, game.result, game.played_at, game.opponent,
        game.opponent_deck, game.format, game.notes, game.created_at
      );
    }, () => 'Deck game');

    // ---- Trades ----------------------------------------------------------
    //
    // A trade needs both of its users to exist. Restoring one user's data out
    // of a whole-instance backup legitimately leaves the counterparty behind,
    // and a trade with a dangling user is a row nobody can act on — so it is
    // skipped and said out loud, the same way the MTGJSON import cancels a
    // trade that comes back empty rather than leaving it in a shape nobody
    // agreed to.
    const userExists = db.prepare(`SELECT 1 FROM users WHERE id = ?`);
    const haveUser = (id) => id == null || !!userExists.get(id);

    const insertTrade = db.prepare(`
      INSERT OR REPLACE INTO trades (id, from_user_id, to_user_id, status, note, created_at,
                                     resolved_at, awaiting_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const trades = (backupData.data.trades || []).filter(
      (t) => restoredUserIds.includes(t.from_user_id) || restoredUserIds.includes(t.to_user_id)
    );
    const restoredTradeIds = [];

    restoreRows('trades', trades, (trade) => {
      if (!haveUser(trade.from_user_id) || !haveUser(trade.to_user_id)) {
        results.errors.push(`Trade ${trade.id} skipped: the other party is not in this restore`);
        return false;
      }
      insertTrade.run(
        trade.id, trade.from_user_id, trade.to_user_id, trade.status, trade.note,
        trade.created_at, trade.resolved_at, trade.awaiting_user_id
      );
      restoredTradeIds.push(trade.id);
    }, (t) => `Trade ${t.id}`);

    const insertTradeItem = db.prepare(`
      INSERT OR REPLACE INTO trade_items (id, trade_id, printing_id, is_foil, quantity, direction, declined)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    restoreRows('trade_items', (backupData.data.trade_items || []).filter(
      (ti) => restoredTradeIds.includes(ti.trade_id)
    ), (item) => {
      const printingId = printingIdFor(item.printing_uuid);
      if (!printingId) {
        results.errors.push(`Printing UUID ${item.printing_uuid} not found (trade item)`);
        return false;
      }
      insertTradeItem.run(
        item.id, item.trade_id, printingId, item.is_foil ? 1 : 0,
        item.quantity, item.direction, item.declined ?? 0
      );
    }, () => 'Trade item');

    // ---- Disruptions -----------------------------------------------------
    //
    // Restored after both decks and trades, because the row points at each.
    const insertDisruption = db.prepare(`
      INSERT OR REPLACE INTO deck_card_disruptions (id, deck_id, trade_id, printing_id, is_foil,
                                                    board_type, quantity, card_name, created_at,
                                                    acknowledged_at, resolution)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    restoreRows('deck_card_disruptions', (backupData.data.deck_card_disruptions || []).filter(inDeck), (row) => {
      const printingId = printingIdFor(row.printing_uuid);
      if (!printingId) {
        results.errors.push(`Printing UUID ${row.printing_uuid} not found (disruption)`);
        return false;
      }
      insertDisruption.run(
        row.id, row.deck_id,
        // The trade may have been skipped above; the disruption still matters
        // without it, so it is kept and merely loses its link.
        restoredTradeIds.includes(row.trade_id) ? row.trade_id : null,
        printingId, row.is_foil ? 1 : 0, row.board_type, row.quantity, row.card_name,
        row.created_at, row.acknowledged_at, row.resolution
      );
    }, (r) => `Disruption ${r.card_name}`);

    // ---- Audit log -------------------------------------------------------
    //
    // `printing_uuid` is the identifier that survives a rebuild and the only
    // one anything should join on. `printing_id` is restored anyway, as-is,
    // because pre-951ddd1 rows have no uuid and it is their last handle — see
    // the note in createBackup. Restoring it changes nothing about how
    // trustworthy it is; dropping it would end the possibility of ever
    // recovering those rows.
    const insertAudit = db.prepare(`
      INSERT OR REPLACE INTO audit_log (id, user_id, actor_user_id, entity_type, action, source,
                                        printing_id, printing_uuid, card_name, set_code,
                                        collector_number, is_foil, quantity_before, quantity_after,
                                        quantity_delta, deck_id, deck_name, trade_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    restoreRows('audit_log', (backupData.data.audit_log || []).filter(mine), (row) => {
      insertAudit.run(
        row.id, row.user_id, row.actor_user_id, row.entity_type, row.action, row.source,
        row.printing_id ?? null,
        row.printing_uuid, row.card_name, row.set_code, row.collector_number, row.is_foil,
        row.quantity_before, row.quantity_after, row.quantity_delta,
        row.deck_id, row.deck_name, row.trade_id, row.detail, row.created_at
      );
    }, () => 'Audit entry');
  });

  restore();
  return results;
}


/**
 * Export backup to a file
 */
export function exportBackupToFile(backupData, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2), 'utf8');
}

/**
 * Import backup from a file
 */
export function importBackupFromFile(filePath) {
  const data = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(data);
}

/**
 * Create and save a backup to the backups directory
 */
export function createScheduledBackup() {
  const backup = createBackup(); // Backup all users
  const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const filename = `scheduled-backup-${timestamp}-${Date.now()}.json`;
  const filepath = path.join(BACKUP_DIR, filename);

  exportBackupToFile(backup, filepath);
  backupConfig.lastRun = new Date().toISOString();
  persistBackupConfig();

  console.log(`✓ Scheduled backup created: ${filename}`);

  // Clean up old backups based on retention policy
  cleanupOldBackups();

  return { filename, filepath, timestamp: backup.timestamp };
}

/**
 * Clean up old backups, keeping only the most recent N backups
 */
export function cleanupOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('scheduled-backup-') && f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime); // Sort by modified time, newest first

    const toDelete = files.slice(backupConfig.retainCount);

    toDelete.forEach(file => {
      fs.unlinkSync(file.path);
      console.log(`  🗑️  Deleted old backup: ${file.name}`);
    });

    if (toDelete.length > 0) {
      console.log(`✓ Cleaned up ${toDelete.length} old backup(s), kept ${Math.min(files.length, backupConfig.retainCount)}`);
    }
  } catch (error) {
    console.error('Error cleaning up old backups:', error.message);
  }
}

/**
 * Get list of available backup files
 */
export function listBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filepath = path.join(BACKUP_DIR, f);
        const stats = fs.statSync(filepath);
        return {
          filename: f,
          size: stats.size,
          created: stats.mtime.toISOString(),
          type: f.startsWith('scheduled-backup-') ? 'scheduled' :
                f.startsWith('pre-sync-safety') ? 'pre-sync' : 'manual'
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created)); // Newest first

    return files;
  } catch (error) {
    console.error('Error listing backups:', error.message);
    return [];
  }
}

/**
 * Load a backup file by filename
 */
export function loadBackupFile(filename) {
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Backup file not found: ${filename}`);
  }
  return importBackupFromFile(filepath);
}

/**
 * Delete a backup file
 */
export function deleteBackupFile(filename) {
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Backup file not found: ${filename}`);
  }
  fs.unlinkSync(filepath);
  console.log(`✓ Deleted backup: ${filename}`);
  return { success: true };
}

/**
 * Configure scheduled backups
 */
export function configureScheduledBackups(config, { persist = true } = {}) {
  const { enabled, frequency, retainCount } = config;

  if (enabled !== undefined) backupConfig.enabled = enabled;
  if (frequency !== undefined) backupConfig.frequency = frequency;
  if (retainCount !== undefined) backupConfig.retainCount = retainCount;

  if (persist) persistBackupConfig();

  // Stop existing job if any
  if (scheduledBackupJob) {
    scheduledBackupJob.stop();
    scheduledBackupJob = null;
  }

  // Start new job if enabled
  if (backupConfig.enabled) {
    let cronExpression;

    switch (backupConfig.frequency) {
      case '6hours':
        cronExpression = '0 */6 * * *'; // Every 6 hours
        break;
      case '12hours':
        cronExpression = '0 */12 * * *'; // Every 12 hours
        break;
      case 'daily':
        cronExpression = '0 2 * * *'; // Every day at 2 AM
        break;
      case 'weekly':
        cronExpression = '0 2 * * 0'; // Every Sunday at 2 AM
        break;
      default:
        cronExpression = '0 2 * * *'; // Default to daily
    }

    scheduledBackupJob = cron.schedule(cronExpression, () => {
      console.log(`\n⏰ Running scheduled backup (${backupConfig.frequency})...`);
      try {
        createScheduledBackup();
      } catch (error) {
        console.error('Scheduled backup failed:', error.message);
      }
    }, { timezone: BACKUP_TIMEZONE });

    // The resolved zone is logged, not just the frequency: a schedule that
    // silently runs in UTC looks identical to one running locally until you
    // notice the timestamps, and this line is the quickest way to check.
    console.log(
      `✓ Scheduled backups enabled: ${backupConfig.frequency} ${BACKUP_TIMEZONE}` +
      ` (keeping last ${backupConfig.retainCount})`
    );
  } else {
    console.log('✓ Scheduled backups disabled');
  }

  return backupConfig;
}

/**
 * Re-arm the saved schedule at startup. Called from server.js alongside the other
 * cron setups; passes persist: false because nothing has changed yet.
 */
export function initScheduledBackups() {
  return configureScheduledBackups({}, { persist: false });
}

/**
 * Get current backup configuration
 */
export function getBackupConfig() {
  // The timezone rides along read-only. It is deployment configuration rather
  // than a per-install preference, but the settings page has to be able to say
  // which zone "2 AM" means or the times it shows are a guess.
  return { ...backupConfig, timezone: BACKUP_TIMEZONE };
}
