/**
 * Local stores become the household's, not one user's.
 *
 * Somebody finds a store with a TCGplayer Pro storefront and everyone can
 * price against it. So a store is one row per address (`base_url` UNIQUE),
 * `created_by` only records who added it (SET NULL, so deleting that user
 * does not take the store from everyone else), and each user's own say over
 * it lives in `local_store_prefs`: `checking` = include it in price checks
 * and comparisons, `hidden` = take it off their view. No row means visible
 * and checking, which is how a store someone else just added arrives.
 *
 * Quotes stay per user — a lookup is of that user's list, so another
 * member's would price the wrong cards — keyed (store_id, user_id).
 *
 * Users who had added the same store separately are merged onto the oldest
 * row; each keeps their own quote. The parent table is rebuilt, and dropping
 * it with foreign keys on would cascade the quotes away, so they are copied
 * out to a temp table first. The runner wraps this in a transaction.
 */
export function up(db) {
  const before = db.prepare(`SELECT COUNT(DISTINCT base_url) AS n FROM local_stores`).get().n;

  db.exec(`
    CREATE TEMP TABLE old_stores AS SELECT id, user_id, name, base_url, created_at FROM local_stores;
    CREATE TEMP TABLE old_quotes AS
      SELECT s.base_url, s.user_id, q.fetched_at, q.payload, q.imported_at
      FROM local_store_quotes q JOIN local_stores s ON s.id = q.store_id;

    DROP TABLE local_store_quotes;
    DROP TABLE local_stores;

    CREATE TABLE local_stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE local_store_quotes (
      store_id INTEGER NOT NULL REFERENCES local_stores(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fetched_at DATETIME NOT NULL,
      payload TEXT NOT NULL,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (store_id, user_id)
    );

    CREATE TABLE local_store_prefs (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      store_id INTEGER NOT NULL REFERENCES local_stores(id) ON DELETE CASCADE,
      hidden INTEGER NOT NULL DEFAULT 0,
      checking INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, store_id)
    );

    INSERT INTO local_stores (id, created_by, name, base_url, created_at)
      SELECT id, user_id, name, base_url, created_at FROM old_stores o
      WHERE o.id = (SELECT MIN(id) FROM old_stores WHERE base_url = o.base_url);

    INSERT INTO local_store_quotes (store_id, user_id, fetched_at, payload, imported_at)
      SELECT s.id, q.user_id, q.fetched_at, q.payload, q.imported_at
      FROM old_quotes q JOIN local_stores s ON s.base_url = q.base_url;

    DROP TABLE old_stores;
    DROP TABLE old_quotes;
  `);

  const after = db.prepare(`SELECT COUNT(*) AS n FROM local_stores`).get().n;
  if (before !== after) throw new Error(`Local store migration aborted: ${before} addresses before, ${after} after`);
  console.log(`✓ Shared local stores across the household (${after} stores)`);
}

export function down() {
  // ⚠ The migration runner never calls down(), so this is documentation.
}
