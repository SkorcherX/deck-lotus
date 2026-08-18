export function up(db) {
  // Track foil copies separately from non-foil ones.
  //
  // owned_printings was created with UNIQUE(user_id, printing_id), which allows
  // only one row per printing and so cannot represent owning both a foil and a
  // non-foil of the same printing. SQLite cannot alter a constraint in place, so
  // the table is rebuilt with the finish included in the key.
  //
  // The migration runner wraps this in a transaction, so either the whole
  // rebuild lands or none of it does.

  const before = db.prepare(`SELECT COUNT(*) as count FROM owned_printings`).get().count;

  db.exec(`
    CREATE TABLE owned_printings_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      printing_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 1,
      is_foil INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (printing_id) REFERENCES printings(id) ON DELETE CASCADE,
      UNIQUE(user_id, printing_id, is_foil)
    );

    INSERT INTO owned_printings_new (id, user_id, printing_id, quantity, is_foil, created_at, updated_at)
      SELECT id, user_id, printing_id, quantity, 0, created_at, updated_at
      FROM owned_printings;

    DROP TABLE owned_printings;
    ALTER TABLE owned_printings_new RENAME TO owned_printings;

    CREATE INDEX idx_owned_printings_user_id ON owned_printings(user_id);
    CREATE INDEX idx_owned_printings_printing_id ON owned_printings(printing_id);
  `);

  const after = db.prepare(`SELECT COUNT(*) as count FROM owned_printings`).get().count;

  // Refuse to commit a rebuild that lost rows — the transaction rolls back and
  // the migration is not recorded, leaving the original table untouched.
  if (before !== after) {
    throw new Error(
      `Foil migration aborted: owned_printings had ${before} rows before the rebuild and ${after} after`
    );
  }

  console.log(`✓ Added is_foil to owned_printings (${after} rows preserved)`);
}

export function down(db) {
  // Collapsing back to one row per printing would have to discard either the
  // foil or the non-foil row where a user owns both, so merge the quantities
  // rather than silently dropping copies.
  db.exec(`
    CREATE TABLE owned_printings_old (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      printing_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (printing_id) REFERENCES printings(id) ON DELETE CASCADE,
      UNIQUE(user_id, printing_id)
    );

    INSERT INTO owned_printings_old (user_id, printing_id, quantity, created_at, updated_at)
      SELECT user_id, printing_id, SUM(quantity), MIN(created_at), MAX(updated_at)
      FROM owned_printings
      GROUP BY user_id, printing_id;

    DROP TABLE owned_printings;
    ALTER TABLE owned_printings_old RENAME TO owned_printings;

    CREATE INDEX idx_owned_printings_user_id ON owned_printings(user_id);
    CREATE INDEX idx_owned_printings_printing_id ON owned_printings(printing_id);
  `);

  console.log('✓ Removed is_foil from owned_printings (foil and non-foil quantities merged)');
}
