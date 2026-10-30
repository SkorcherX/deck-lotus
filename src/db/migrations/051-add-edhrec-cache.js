/**
 * EDHREC commander pages, cached by slug.
 *
 * Holds the parsed page — card names and percentages, never ids — so the
 * weekly MTGJSON import leaves it alone. A cache of an outside site, not user
 * data: backupService does not carry it, and losing it costs one lookup.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edhrec_cache (
      slug TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✓ Added edhrec_cache');
}
