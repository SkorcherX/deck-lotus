/**
 * One row per user per day: what their collection was worth that day.
 *
 * Prices are overwritten by every refresh, so without this there is no way to
 * draw value over time — the history simply is not kept anywhere. The daily
 * price sync writes a row for every user once it finishes.
 *
 * Keyed on (user_id, snapshot_date) and nothing else. It references no
 * printing or card, so the MTGJSON import never touches it. It is user-scoped,
 * so backupService carries it.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_value_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      snapshot_date TEXT NOT NULL,
      total_value REAL NOT NULL DEFAULT 0,
      total_cards INTEGER NOT NULL DEFAULT 0,
      unique_cards INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, snapshot_date)
    );
  `);

  console.log('✓ Added collection_value_snapshots');
}

export function down() {
  // ⚠ The migration runner never calls down(), so this is documentation.
}
