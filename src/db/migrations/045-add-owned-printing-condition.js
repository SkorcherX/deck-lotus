/**
 * Optional card condition (TCGplayer scale — see src/shared/conditions.js) on
 * owned copies.
 *
 * Condition joins the key, like finish did in 021: one printing held as two
 * NM and one LP is two rows. It is NOT NULL with `''` meaning "not recorded"
 * because SQLite treats NULLs as distinct in a UNIQUE constraint, which would
 * let the unrecorded row duplicate itself. Every existing row becomes `''`, so
 * the collection reads exactly as it did.
 *
 * SQLite cannot alter a constraint in place, so the table is rebuilt; the
 * runner wraps this in a transaction.
 */
export function up(db) {
  const before = db.prepare(`SELECT COUNT(*) as count FROM owned_printings`).get().count;

  db.exec(`
    CREATE TABLE owned_printings_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      printing_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 1,
      is_foil INTEGER NOT NULL DEFAULT 0,
      condition TEXT NOT NULL DEFAULT '' CHECK (condition IN ('', 'NM', 'LP', 'MP', 'HP', 'DMG')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (printing_id) REFERENCES printings(id) ON DELETE CASCADE,
      UNIQUE(user_id, printing_id, is_foil, condition)
    );

    INSERT INTO owned_printings_new (id, user_id, printing_id, quantity, is_foil, condition, created_at, updated_at)
      SELECT id, user_id, printing_id, quantity, is_foil, '', created_at, updated_at
      FROM owned_printings;

    DROP TABLE owned_printings;
    ALTER TABLE owned_printings_new RENAME TO owned_printings;

    CREATE INDEX idx_owned_printings_user_id ON owned_printings(user_id);
    CREATE INDEX idx_owned_printings_printing_id ON owned_printings(printing_id);
  `);

  const after = db.prepare(`SELECT COUNT(*) as count FROM owned_printings`).get().count;
  if (before !== after) {
    throw new Error(`Condition migration aborted: ${before} rows before, ${after} after`);
  }

  console.log(`✓ Added condition to owned_printings (${after} rows preserved)`);
}

export function down() {
  // ⚠ The migration runner never calls down(), so this is documentation.
}
