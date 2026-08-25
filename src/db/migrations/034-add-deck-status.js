/**
 * What the owner intends a deck to be, as opposed to what it currently is.
 *
 * Readiness is already derived on every read — whether the cards exist, and
 * whether they are free or committed to another deck (src/services/
 * deckReadiness.js). That is fact, and it is never stored, because a cached
 * count and the collection it came from can disagree.
 *
 * This column is the other half, and it is the half no query can work out:
 * whether you consider the deck finished, are actively building it, jotted it
 * down as an idea, or have retired it. A deck can be perfectly buildable and
 * still be an idea you never sleeved; a retired deck whose cards you sold is
 * not a problem to be fixed.
 *
 * The two are shown side by side and neither overwrites the other. That is
 * also why the vocabulary here avoids the derived states' words — a manual
 * "Needs Buying" sitting next to a computed "Ready" would just look broken.
 *
 * 'building' is the default rather than NULL so every existing deck lands
 * somewhere sensible and the client never has to distinguish "unset" from
 * "in progress" — the same reasoning as 032's theme column.
 *
 * Not validated by a CHECK constraint: the value is checked in the service
 * before it is written (src/services/deckService.js), and a CHECK would mean
 * a table rebuild to ever add a fifth status.
 */
export function up(db) {
  db.exec(`
    ALTER TABLE decks ADD COLUMN status TEXT NOT NULL DEFAULT 'building';

    -- The deck list filters on this, scoped to one user.
    CREATE INDEX IF NOT EXISTS idx_decks_user_status ON decks(user_id, status);
  `);

  console.log('✓ Added status column to decks table');
}

export function down(db) {
  // ⚠ The migration runner never calls down(), so this is documentation
  // rather than a code path. SQLite has no practical DROP COLUMN, but unlike
  // 023 and 032 this table is referenced by foreign keys from deck_cards,
  // deck_games, deck_card_disruptions and trade_items — a rebuild via
  // CREATE TABLE ... AS SELECT would drop the PRIMARY KEY those depend on and
  // take the referencing rows with it.
  //
  // Leaving the column in place is the safer rollback. It has a default, so
  // nothing that predates this migration is broken by its presence.
  db.exec(`DROP INDEX IF EXISTS idx_decks_user_status;`);

  console.log('✓ Removed deck status index (status column intentionally left in place)');
}
