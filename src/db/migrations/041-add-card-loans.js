/**
 * Card loans: a card lent from one user to another without changing hands.
 *
 * A trade moves ownership; a loan deliberately does not. The lender's
 * owned_printings row is never touched, so the household total stays honest
 * and the lender's collection still lists the card as theirs. What changes is
 * where the card *is*: while a loan is live, deck readiness and the shopping
 * list count the copy toward the borrower's decks and away from the lender's
 * (see loanHoldings.js).
 *
 * The printing is held by `printing_uuid` with no foreign key, the same
 * reasoning as audit_log: scripts/import-mtgjson.js clears `printings` every
 * sync, and a FK would either cascade every open loan away or block the
 * import. The uuid survives a reimport; re-join on it.
 *
 * `status` walks: requested → active → return_requested → returned, with
 * declined/cancelled as the ways out before anything is lent.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lender_user_id INTEGER NOT NULL,
      borrower_user_id INTEGER NOT NULL,
      printing_uuid TEXT NOT NULL,
      is_foil INTEGER NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL,
      card_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested',
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      lent_at DATETIME,
      return_requested_at DATETIME,
      resolved_at DATETIME,
      FOREIGN KEY (lender_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (borrower_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_card_loans_lender ON card_loans(lender_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_card_loans_borrower ON card_loans(borrower_user_id, status);
  `);

  console.log('✓ Created card_loans table');
}

export function down(db) {
  // ⚠ The migration runner never calls down(), so this is documentation.
  db.exec(`DROP TABLE IF EXISTS card_loans;`);
  console.log('✓ Dropped card_loans');
}
