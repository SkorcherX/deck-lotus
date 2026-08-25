#!/usr/bin/env node
/**
 * Collection integrity check.
 *
 * The questions this asks are the ones a card-loss bug answers wrongly, and
 * every one of them came out of the functional review (see
 * docs/REVIEW_FINDINGS.md). It reads only — it never writes — so it is safe
 * to point at the live database.
 *
 * The important idea is that **copies are the invariant, not rows**. A row
 * disappears legitimately when a quantity reaches zero and reappears on the
 * other side of a trade; the number of copies the household holds is what must
 * not change unless somebody meant it to. Stage 4 of the review used exactly
 * these queries to prove that seven trades moved 1,921 copies without losing
 * one.
 *
 * Usage:
 *   node scripts/check-integrity.mjs                 # the app's database
 *   node scripts/check-integrity.mjs --db path.db    # some other one
 *   node scripts/check-integrity.mjs --json          # machine-readable
 *
 * Exit code is 0 when everything passes and 1 when anything fails, so this
 * can sit in CI or a cron without anyone reading the output.
 */
import Database from 'better-sqlite3';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const dbFlag = argv.indexOf('--db');

const dbPath = dbFlag !== -1 && argv[dbFlag + 1]
  ? resolve(argv[dbFlag + 1])
  : process.env.DATABASE_PATH || join(__dirname, '../data/deck-lotus.db');

const db = new Database(dbPath, { readonly: true });
const all = (sql, p = []) => db.prepare(sql).all(p);
const one = (sql, p = []) => db.prepare(sql).get(p);

const results = [];
/** A check that must return zero rows. Anything it returns is the evidence. */
const mustBeEmpty = (name, why, sql) => {
  const rows = all(sql);
  results.push({ name, why, ok: rows.length === 0, count: rows.length, sample: rows.slice(0, 5) });
};

// ---------------------------------------------------------------------------
// Referential integrity. `printings` is rebuilt by the weekly MTGJSON import,
// so a row pointing at a printing that no longer exists means the import's
// backup/restore dropped something.
// ---------------------------------------------------------------------------
mustBeEmpty('owned_printings -> printings',
  'a collection row pointing at a printing that no longer exists',
  `SELECT op.id, op.user_id, op.printing_id FROM owned_printings op
    WHERE NOT EXISTS (SELECT 1 FROM printings p WHERE p.id = op.printing_id)`);

mustBeEmpty('deck_cards -> printings',
  'a deck listing a printing that no longer exists',
  `SELECT dc.id, dc.deck_id, dc.printing_id FROM deck_cards dc
    WHERE NOT EXISTS (SELECT 1 FROM printings p WHERE p.id = dc.printing_id)`);

mustBeEmpty('trade_items -> printings',
  'a trade referring to a printing that no longer exists',
  `SELECT ti.id, ti.trade_id, ti.printing_id FROM trade_items ti
    WHERE NOT EXISTS (SELECT 1 FROM printings p WHERE p.id = ti.printing_id)`);

// ---------------------------------------------------------------------------
// Uniqueness. Finish is half the key in both tables; a duplicate here means
// something wrote around the constraint and two rows now describe one pile.
// ---------------------------------------------------------------------------
mustBeEmpty('owned_printings unique (user, printing, foil)',
  'two collection rows describing the same printing and finish',
  `SELECT user_id, printing_id, is_foil, COUNT(*) n FROM owned_printings
    GROUP BY user_id, printing_id, is_foil HAVING n > 1`);

mustBeEmpty('deck_cards unique (deck, printing, sideboard, foil)',
  'two deck rows describing the same card in the same place',
  `SELECT deck_id, printing_id, is_sideboard, is_foil, COUNT(*) n FROM deck_cards
    GROUP BY deck_id, printing_id, is_sideboard, is_foil HAVING n > 1`);

// ---------------------------------------------------------------------------
// Quantities. Zero means the row should have been deleted; negative means
// something subtracted without checking.
// ---------------------------------------------------------------------------
mustBeEmpty('owned_printings quantity > 0',
  'a collection row at or below zero copies',
  `SELECT id, user_id, printing_id, quantity FROM owned_printings WHERE quantity <= 0`);

mustBeEmpty('deck_cards quantity > 0',
  'a deck row at or below zero copies',
  `SELECT id, deck_id, printing_id, quantity FROM deck_cards WHERE quantity <= 0`);

mustBeEmpty('trade_items quantity > 0',
  'a trade line at or below zero copies',
  `SELECT id, trade_id, printing_id, quantity FROM trade_items WHERE quantity <= 0`);

// ---------------------------------------------------------------------------
// board_type and is_sideboard must agree. See S3-2: the UNIQUE key follows
// is_sideboard while readiness and shopping follow board_type, so a row where
// they disagree is counted differently by different parts of the app.
// ---------------------------------------------------------------------------
mustBeEmpty('board_type agrees with is_sideboard',
  'a deck row whose two notions of which board it is on disagree',
  `SELECT id, deck_id, printing_id, board_type, is_sideboard FROM deck_cards
    WHERE (board_type = 'sideboard') <> (is_sideboard = 1)`);

// ---------------------------------------------------------------------------
// Open trades must be answerable by somebody, or they are stuck forever.
// ---------------------------------------------------------------------------
mustBeEmpty('open trades have a turn',
  'an open trade with nobody whose turn it is',
  `SELECT id, status, from_user_id, to_user_id FROM trades
    WHERE status IN ('pending', 'awaiting_counter') AND awaiting_user_id IS NULL`);

mustBeEmpty('open trades are not empty',
  'an open trade with no cards left on it',
  `SELECT t.id, t.status FROM trades t
    WHERE t.status IN ('pending', 'awaiting_counter')
      AND NOT EXISTS (SELECT 1 FROM trade_items ti WHERE ti.trade_id = t.id AND ti.declined = 0)`);

// ---------------------------------------------------------------------------
// The audit log is the only way a mis-click is recoverable, so a row that
// cannot be tied back to a card is a row that cannot undo one. printing_uuid
// is the handle that survives a reimport; printing_id is not.
// ---------------------------------------------------------------------------
mustBeEmpty('audit rows can identify their card',
  'an inventory audit row with neither a uuid nor a card name',
  `SELECT id, action, source FROM audit_log
    WHERE entity_type = 'inventory' AND printing_uuid IS NULL AND card_name IS NULL`);

// ---------------------------------------------------------------------------
// The planner needs statistics. Without them the readiness query picks a plan
// that is ~4,900x slower on a large collection — see S7-1/S7-2. This is a
// health check, not an integrity one, but it belongs where people will see it.
// ---------------------------------------------------------------------------
const hasStats = !!one(`SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'`);
results.push({
  name: 'ANALYZE has been run',
  why: 'without sqlite_stat1 the deck list degrades superlinearly (S7-1)',
  ok: hasStats,
  count: hasStats ? 0 : 1,
  sample: hasStats ? [] : [{ fix: 'run ANALYZE; re-run it after every MTGJSON import' }],
});

// ---------------------------------------------------------------------------
// Context, so the numbers above have something to sit against.
// ---------------------------------------------------------------------------
const summary = {
  database: dbPath,
  users: one(`SELECT COUNT(*) c FROM users`).c,
  decks: one(`SELECT COUNT(*) c FROM decks`).c,
  collectionRows: one(`SELECT COUNT(*) c FROM owned_printings`).c,
  collectionCopies: one(`SELECT COALESCE(SUM(quantity), 0) c FROM owned_printings`).c,
  foilCopies: one(`SELECT COALESCE(SUM(quantity), 0) c FROM owned_printings WHERE is_foil = 1`).c,
  openTrades: one(`SELECT COUNT(*) c FROM trades WHERE status IN ('pending','awaiting_counter')`).c,
  unacknowledgedDisruptions: one(`SELECT COUNT(*) c FROM deck_card_disruptions WHERE acknowledged_at IS NULL`).c,
};

const failed = results.filter((r) => !r.ok);

if (asJson) {
  console.log(JSON.stringify({ summary, results, failed: failed.length }, null, 2));
} else {
  console.log(`\nDeck Lotus integrity check`);
  console.log(`  ${summary.database}`);
  console.log(`  ${summary.users} users · ${summary.decks} decks · ` +
    `${summary.collectionCopies} copies in ${summary.collectionRows} rows ` +
    `(${summary.foilCopies} foil)`);
  console.log(`  ${summary.openTrades} open trade(s) · ` +
    `${summary.unacknowledgedDisruptions} unacknowledged disruption(s)\n`);

  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  — ${r.count} row(s)`}`);
    if (!r.ok) {
      console.log(`      ${r.why}`);
      for (const s of r.sample) console.log(`      ${JSON.stringify(s)}`);
      if (r.count > r.sample.length) console.log(`      ...and ${r.count - r.sample.length} more`);
    }
  }

  console.log(failed.length === 0
    ? `\n✓ All ${results.length} checks passed.\n`
    : `\n✗ ${failed.length} of ${results.length} checks failed.\n`);
}

db.close();
process.exit(failed.length === 0 ? 0 : 1);
