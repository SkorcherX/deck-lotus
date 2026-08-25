/**
 * Give SQLite's query planner statistics to plan with.
 *
 * `ANALYZE` had never been run on this database, so `sqlite_stat1` did not
 * exist and the planner had nothing but its built-in guesses for how big each
 * table is. It guessed wrong about `owned_printings`, and the readiness query
 * in deckReadinessService.js paid for it: its OWNED_TOTAL correlated subquery
 * was driven from `owned_printings`, scanning the whole collection once per
 * (deck, card) row. On a 50-deck account that is tens of millions of lookups —
 * `GET /api/decks`, the app's home page, took over two minutes. And because
 * better-sqlite3 is synchronous on a single-threaded process, those minutes
 * are minutes in which *nobody else* is served either. One large collection
 * takes the instance down.
 *
 * With statistics present the planner flips to
 * `SEARCH op_p USING COVERING INDEX idx_printings_card_id` — an index that
 * already existed and was simply never chosen — and the same request lands in
 * milliseconds.
 *
 * No schema change and no new index. A purpose-built covering index on
 * `owned_printings(printing_id, user_id, quantity)` was measured and made no
 * further difference once statistics existed, so there is nothing here to
 * maintain: this migration only asks SQLite to look at the data it already has.
 *
 * ── Why a migration, and not startup ────────────────────────────────────────
 *
 * ANALYZE is a full pass over the indexes — around half a second here, but it
 * grows with the database, and startup is exactly when the app is least able
 * to afford a synchronous stall of unknown length. Statistics do not need to
 * be exact to fix this; they need to exist, and be in the right order of
 * magnitude. Row counts drift as a collection grows, but the *shape* of the
 * data does not, so re-deriving them on every boot buys nothing.
 *
 * The one event that genuinely invalidates them is the weekly MTGJSON sync,
 * which rebuilds `printings` wholesale — so `scripts/import-mtgjson.js` runs
 * ANALYZE again at the end of its run. That is where the staleness comes from,
 * and that is where it is answered.
 *
 * `scripts/check-integrity.mjs` reports whether `sqlite_stat1` exists, which
 * is the quickest way to confirm this took on a given database.
 */
export function up(db) {
  db.exec('ANALYZE;');

  console.log('✓ Ran ANALYZE — query planner statistics are now available');
}

export function down(db) {
  // ⚠ The migration runner never calls down(), so this is documentation.
  //
  // Rolling back would mean `DROP TABLE sqlite_stat1` — deliberately breaking
  // the deck list for every account large enough to notice. Statistics are not
  // data anyone can lose by keeping them, and any later ANALYZE simply
  // overwrites them, so the correct rollback is to do nothing.
  console.log('✓ Nothing to roll back (query statistics intentionally left in place)');
}
