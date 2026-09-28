/**
 * Sealed product: a catalog from MTGJSON and each user's holdings.
 *
 * `sealed_products` is MTGJSON's sealedProduct list, rebuilt by every weekly
 * import exactly like `printings` — so nothing may hold a foreign key to it.
 * `owned_sealed` references it by `sealed_uuid` with no FK, the same shape and
 * reason as audit_log's printing_uuid, and may leave it NULL: a box the
 * catalog does not know is still a box somebody owns.
 *
 * `owned_sealed` is one row per *lot*, not per product, because two boxes of
 * one product bought at different prices are two cost bases. It is user data,
 * so backupService carries it.
 *
 * Value is `price_override` if set, else a live TCGplayer price for the uuid
 * if the price feed carries one, else `reference_price` — the last market
 * figure somebody told us (an import's "Market Price" column), with its date.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sealed_products (
      uuid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_normalized TEXT NOT NULL,
      set_code TEXT,
      category TEXT,
      subtype TEXT,
      release_date TEXT,
      tcgplayer_product_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sealed_products_set ON sealed_products(set_code);
    CREATE INDEX IF NOT EXISTS idx_sealed_products_name ON sealed_products(name_normalized);

    -- Live TCGplayer price per sealed product, when AllPricesToday carries
    -- one. Separate from prices, which has a foreign key to printings.
    CREATE TABLE IF NOT EXISTS sealed_prices (
      sealed_uuid TEXT PRIMARY KEY,
      price REAL NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS owned_sealed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sealed_uuid TEXT,
      name TEXT NOT NULL,
      set_name TEXT,
      set_code TEXT,
      category TEXT,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      cost_paid REAL,
      reference_price REAL,
      reference_price_date TEXT,
      price_override REAL,
      notes TEXT,
      acquired_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_owned_sealed_user ON owned_sealed(user_id);
  `);

  console.log('✓ Added sealed_products and owned_sealed');
}

export function down() {
  // ⚠ The migration runner never calls down(), so this is documentation.
}
