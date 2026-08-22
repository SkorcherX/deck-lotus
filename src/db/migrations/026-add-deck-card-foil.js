export function up(db) {
  // Track which finish a deck uses.
  //
  // owned_printings has been keyed UNIQUE(user_id, printing_id, is_foil) since
  // 021, so a collection can hold a foil and a non-foil of the same printing as
  // separate rows. deck_cards had no matching column: a deck could name a
  // printing but not a finish, so where both are owned there was no way to say
  // which copy the deck uses — and no way to count what is still free.
  //
  // SQLite cannot alter a constraint in place, so the table is rebuilt with the
  // finish included in the key. The migration runner wraps this in a
  // transaction, so either the whole rebuild lands or none of it does.

  const before = db.prepare(`SELECT COUNT(*) as count FROM deck_cards`).get().count;

  db.exec(`
    CREATE TABLE deck_cards_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_id INTEGER NOT NULL,
      printing_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      is_sideboard INTEGER DEFAULT 0,
      is_commander INTEGER DEFAULT 0,
      is_foil INTEGER NOT NULL DEFAULT 0,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      board_type TEXT DEFAULT 'mainboard',
      FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE,
      FOREIGN KEY (printing_id) REFERENCES printings(id) ON DELETE CASCADE,
      UNIQUE(deck_id, printing_id, is_sideboard, is_foil)
    );

    INSERT INTO deck_cards_new
      (id, deck_id, printing_id, quantity, is_sideboard, is_commander, is_foil, added_at, board_type)
      SELECT id, deck_id, printing_id, quantity, is_sideboard, is_commander, 0, added_at, board_type
      FROM deck_cards;

    DROP TABLE deck_cards;
    ALTER TABLE deck_cards_new RENAME TO deck_cards;

    CREATE INDEX idx_deck_cards_deck_id ON deck_cards(deck_id);
    CREATE INDEX idx_deck_cards_printing_id ON deck_cards(printing_id);
    CREATE INDEX idx_deck_cards_board_type ON deck_cards(board_type);
  `);

  const after = db.prepare(`SELECT COUNT(*) as count FROM deck_cards`).get().count;

  // Refuse to commit a rebuild that lost rows — the transaction rolls back and
  // the migration is not recorded, leaving the original table untouched.
  if (before !== after) {
    throw new Error(
      `Deck card foil migration aborted: deck_cards had ${before} rows before the rebuild and ${after} after`
    );
  }

  console.log(`✓ Added is_foil to deck_cards (${after} rows preserved)`);
}

export function down(db) {
  // Collapsing back to one row per printing and board would have to discard
  // either the foil or the non-foil row where a deck lists both, so merge the
  // quantities rather than silently dropping copies.
  db.exec(`
    CREATE TABLE deck_cards_old (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_id INTEGER NOT NULL,
      printing_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      is_sideboard INTEGER DEFAULT 0,
      is_commander INTEGER DEFAULT 0,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      board_type TEXT DEFAULT 'mainboard',
      FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE,
      FOREIGN KEY (printing_id) REFERENCES printings(id) ON DELETE CASCADE,
      UNIQUE(deck_id, printing_id, is_sideboard)
    );

    INSERT INTO deck_cards_old
      (deck_id, printing_id, quantity, is_sideboard, is_commander, added_at, board_type)
      SELECT deck_id, printing_id, SUM(quantity), is_sideboard, MAX(is_commander),
             MIN(added_at), MIN(board_type)
      FROM deck_cards
      GROUP BY deck_id, printing_id, is_sideboard;

    DROP TABLE deck_cards;
    ALTER TABLE deck_cards_old RENAME TO deck_cards;

    CREATE INDEX idx_deck_cards_deck_id ON deck_cards(deck_id);
    CREATE INDEX idx_deck_cards_printing_id ON deck_cards(printing_id);
    CREATE INDEX idx_deck_cards_board_type ON deck_cards(board_type);
  `);

  console.log('✓ Removed is_foil from deck_cards (foil and non-foil quantities merged)');
}
