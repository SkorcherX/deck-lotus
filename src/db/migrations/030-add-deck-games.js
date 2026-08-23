export function up(db) {
  // Win/loss tracking for decks, stored as one row per game rather than as a
  // pair of counters on `decks`.
  //
  // Counters cannot answer the questions people actually ask of a record —
  // "is this deck still losing since I rebuilt the mana base?", "which of us
  // did I lose to?" — and they cannot be corrected: a mis-tapped loss is
  // indistinguishable from a real one once it has been folded into a total.
  // A game log gives both, and the totals are a SUM over it.
  //
  // `played_at` is a date the user can set, separate from `created_at`, so a
  // game night can be entered the morning after without lying about when it
  // happened.
  //
  // Rows hang off `decks`, which `scripts/import-mtgjson.js` never clears, so
  // nothing here is at risk from the weekly card-data rebuild.

  db.exec(`
    CREATE TABLE IF NOT EXISTS deck_games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'draw')),
      played_at DATE NOT NULL,
      opponent TEXT,
      opponent_deck TEXT,
      format TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- The record panel reads a single deck newest-first; the deck list reads
    -- every deck's totals at once. Both are covered here.
    CREATE INDEX IF NOT EXISTS idx_deck_games_deck ON deck_games(deck_id, played_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deck_games_user ON deck_games(user_id);
  `);

  console.log('✓ Added deck_games table');
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_deck_games_user;
    DROP INDEX IF EXISTS idx_deck_games_deck;
    DROP TABLE IF EXISTS deck_games;
  `);

  console.log('✓ Removed deck_games table');
}
