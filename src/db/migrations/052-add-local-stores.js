/**
 * Local game stores with a TCGplayer Pro storefront, and the latest price
 * lookup the user ran against each.
 *
 * The lookup itself runs in the user's browser on the store's site (see
 * src/shared/localShop.js); `local_store_quotes` only keeps what was pasted
 * back, one snapshot per store. It is keyed by card name, never an id, so
 * the weekly MTGJSON import leaves both tables alone. backupService carries
 * the stores but not the quotes: a quote is a dated copy of someone else's
 * shelf, and re-running it is the way to get a fresh one.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, base_url)
    );

    CREATE TABLE IF NOT EXISTS local_store_quotes (
      store_id INTEGER PRIMARY KEY REFERENCES local_stores(id) ON DELETE CASCADE,
      fetched_at DATETIME NOT NULL,
      payload TEXT NOT NULL,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✓ Added local_stores and local_store_quotes');
}
