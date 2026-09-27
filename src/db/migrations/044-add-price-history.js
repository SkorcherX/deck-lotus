/**
 * Daily TCGplayer prices for printings somebody owns, so the analytics page
 * can say what moved.
 *
 * `prices` holds today only — every refresh overwrites it — so without this
 * there is nothing to compare against. Recording every printing would be
 * ~300k rows a day for cards nobody here holds; recording what is owned
 * (anyone's collection, both finishes) is a few thousand. A printing starts
 * being tracked the day someone adds it, which is also the first day its
 * movement could matter to anyone.
 *
 * Keyed by `printing_uuid` with no foreign key, same reason as audit_log: the
 * MTGJSON import clears `printings` every week, and the uuid is what survives.
 * Not user data — it is market data about printings — so backupService does
 * not carry it; a restore simply starts the history again.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
      printing_uuid TEXT NOT NULL,
      price_type TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      price REAL NOT NULL,
      PRIMARY KEY (printing_uuid, price_type, snapshot_date)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_price_history_date ON price_history(snapshot_date);
  `);

  console.log('✓ Added price_history');
}

export function down() {
  // ⚠ The migration runner never calls down(), so this is documentation.
}
