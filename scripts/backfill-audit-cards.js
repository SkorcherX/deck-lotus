#!/usr/bin/env node
/**
 * Backfill the card identity that `audit_log` rows written before commit
 * 951ddd1 are missing.
 *
 * `describePrinting` in src/services/auditService.js used to return
 * column-style keys (`card_name`, `set_code`, …) into a function that
 * destructures camelCase, so every row written through
 * recordInventoryChange/recordDeckEvent landed with a `printing_id` and no
 * name, set code, collector number or uuid. The audit page then rendered
 * those rows as a bare "Trade #10 with <partner>".
 *
 * Why this cannot simply be done on read: `listAuditEntries` recovers a
 * missing name by joining on `printing_uuid`, deliberately never on
 * `printing_id`, because `scripts/import-mtgjson.js` clears and rebuilds
 * `printings` every weekly sync and reassigns its ids. These rows have no
 * uuid, so `printing_id` is the only handle left — and it is exactly the
 * handle that a sync may have invalidated. That is the whole risk this script
 * has to manage, and nothing in the schema records when the last import ran,
 * so it cannot be settled by asking the database.
 *
 * What it does instead is corroborate each row against a table that the
 * import restores *by uuid* and therefore holds current ids:
 *
 *   - a row with a trade_id, against that trade's `trade_items`
 *   - a row with a deck_id, against that deck's `deck_cards`
 *   - an inventory row, against that user's `owned_printings`
 *
 * If the stale `printing_id` still appears where the row says the card was,
 * the id has survived — or points at the same printing regardless. Rows that
 * corroborate are "verified" and written by default. Rows that do not are
 * left alone unless --include-unverified is passed: naming the wrong card in
 * a history is worse than naming none, because the reader has no way to tell.
 *
 * Usage:
 *   node scripts/backfill-audit-cards.js                        # dry run
 *   node scripts/backfill-audit-cards.js --apply
 *   node scripts/backfill-audit-cards.js --apply --include-unverified
 *   node scripts/backfill-audit-cards.js --limit 20             # sample only
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../data/deck-lotus.db');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const includeUnverified = args.includes('--include-unverified');
const limitArg = args.indexOf('--limit');
const limit = limitArg === -1 ? null : parseInt(args[limitArg + 1], 10);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Only rows that lost their identity: a printing_id with nothing readable
// beside it. A row that already has a name or a uuid is either fine or
// recoverable on read, and is not touched.
const candidates = db.prepare(
  `SELECT id, user_id, entity_type, action, printing_id, deck_id, trade_id, created_at
     FROM audit_log
    WHERE printing_id IS NOT NULL
      AND printing_uuid IS NULL
      AND card_name IS NULL
    ORDER BY id
    ${limit ? 'LIMIT ?' : ''}`
).all(...(limit ? [limit] : []));

if (candidates.length === 0) {
  console.log('Nothing to backfill — no audit rows are missing their card identity.');
  db.close();
  process.exit(0);
}

const describe = db.prepare(
  `SELECT p.uuid, p.set_code, p.collector_number, c.name
     FROM printings p
     JOIN cards c ON p.card_id = c.id
    WHERE p.id = ?`
);

const inTrade = db.prepare(
  `SELECT 1 FROM trade_items WHERE trade_id = ? AND printing_id = ? LIMIT 1`
);
const inDeck = db.prepare(
  `SELECT 1 FROM deck_cards WHERE deck_id = ? AND printing_id = ? LIMIT 1`
);
const inCollection = db.prepare(
  `SELECT 1 FROM owned_printings WHERE user_id = ? AND printing_id = ? LIMIT 1`
);

/**
 * Does anything that survived the last import still associate this printing
 * id with the place the audit row says the change happened?
 *
 * Returns the corroborating table, or null. An inventory row is the weakest
 * of the three — the card may legitimately have left the collection since —
 * so a miss there means "unverified", not "wrong".
 */
function corroborate(row) {
  if (row.trade_id && inTrade.get(row.trade_id, row.printing_id)) return 'trade_items';
  if (row.deck_id && inDeck.get(row.deck_id, row.printing_id)) return 'deck_cards';
  if (inCollection.get(row.user_id, row.printing_id)) return 'owned_printings';
  return null;
}

const update = db.prepare(
  `UPDATE audit_log
      SET printing_uuid = ?, card_name = ?, set_code = ?, collector_number = ?
    WHERE id = ?`
);

const plan = [];
let missingPrinting = 0;

for (const row of candidates) {
  const printing = describe.get(row.printing_id);

  if (!printing) {
    // The id points at nothing at all — either mid-import, or the id really
    // was reassigned away. Either way there is nothing to copy in.
    missingPrinting += 1;
    continue;
  }

  plan.push({ row, printing, via: corroborate(row) });
}

const verified = plan.filter((entry) => entry.via !== null);
const unverified = plan.filter((entry) => entry.via === null);
const toWrite = includeUnverified ? plan : verified;

console.log(`Database: ${DB_PATH}`);
console.log(`Rows missing card identity: ${candidates.length}${limit ? ` (limited to ${limit})` : ''}`);
console.log(`  corroborated:   ${verified.length}`);
console.log(`  uncorroborated: ${unverified.length}`);
console.log(`  printing id no longer resolves: ${missingPrinting}`);
console.log('');

const sample = toWrite.slice(0, 15);
for (const { row, printing, via } of sample) {
  const where = row.trade_id ? `trade #${row.trade_id}` : row.deck_id ? `deck #${row.deck_id}` : 'inventory';
  console.log(
    `  #${row.id} ${row.action} ${where} → ${printing.name} ` +
    `${printing.set_code} ${printing.collector_number}` +
    (via ? ` [via ${via}]` : ' [UNCORROBORATED]')
  );
}
if (toWrite.length > sample.length) {
  console.log(`  … and ${toWrite.length - sample.length} more`);
}
console.log('');

if (!apply) {
  console.log(`Dry run — nothing written. ${toWrite.length} row(s) would be updated.`);
  if (unverified.length > 0 && !includeUnverified) {
    console.log(
      `${unverified.length} uncorroborated row(s) skipped. Pass --include-unverified ` +
      `to fill them too — only do that if no MTGJSON import has run since they were written.`
    );
  }
  console.log('Re-run with --apply to write.');
  db.close();
  process.exit(0);
}

// One transaction: a half-filled history is harder to reason about than an
// empty one, and this is small enough that holding the write lock briefly
// costs nothing.
const written = db.transaction((entries) => {
  for (const { row, printing } of entries) {
    update.run(printing.uuid, printing.name, printing.set_code, printing.collector_number, row.id);
  }
  return entries.length;
})(toWrite);

console.log(`✓ Backfilled ${written} audit row(s).`);
if (unverified.length > 0 && !includeUnverified) {
  console.log(`  ${unverified.length} uncorroborated row(s) left untouched.`);
}

db.close();
