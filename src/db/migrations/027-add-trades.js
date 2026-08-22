export function up(db) {
  // Trades between users, and the deck fallout they cause.
  //
  // The problem this solves is double-counting: two people trade a card in
  // real life, the receiver adds it, the giver forgets to remove it, and the
  // house now believes it owns two. A trade moves both sides in one
  // transaction, so the total across the household cannot drift.
  //
  // Every quantity here is keyed by printing *and finish*, matching
  // owned_printings' UNIQUE(user_id, printing_id, is_foil) and deck_cards'
  // UNIQUE(deck_id, printing_id, is_sideboard, is_foil). Dropping is_foil
  // anywhere in this feature would move the wrong copies.
  //
  // Purely additive — no table is rebuilt, so nothing existing can be lost.

  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_trades_from_user ON trades(from_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_trades_to_user ON trades(to_user_id, status);

    -- direction is relative to from_user_id (the proposer): 'give' leaves
    -- their collection, 'receive' enters it. A one-way gift is a trade with
    -- items in a single direction — same code path, no special case.
    CREATE TABLE IF NOT EXISTS trade_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER NOT NULL,
      printing_id INTEGER NOT NULL,
      is_foil INTEGER NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL,
      direction TEXT NOT NULL,
      FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE,
      FOREIGN KEY (printing_id) REFERENCES printings(id) ON DELETE CASCADE,
      UNIQUE(trade_id, printing_id, is_foil, direction)
    );

    CREATE INDEX IF NOT EXISTS idx_trade_items_trade ON trade_items(trade_id);

    -- A card that left a collection while a deck still lists it. Written in
    -- the same transaction as the inventory move, so the decks always know.
    -- Nothing is removed from the deck automatically: the owner acknowledges
    -- it and chooses whether the deck shrinks or keeps listing a card they no
    -- longer own.
    --
    -- Identified by deck + printing + finish + board rather than by
    -- deck_cards.id, so an unacknowledged disruption survives the user
    -- editing that row in the meantime.
    CREATE TABLE IF NOT EXISTS deck_card_disruptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_id INTEGER NOT NULL,
      trade_id INTEGER,
      printing_id INTEGER NOT NULL,
      is_foil INTEGER NOT NULL DEFAULT 0,
      board_type TEXT NOT NULL DEFAULT 'mainboard',
      quantity INTEGER NOT NULL,
      card_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      acknowledged_at DATETIME,
      resolution TEXT,
      FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE,
      FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE SET NULL,
      FOREIGN KEY (printing_id) REFERENCES printings(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_disruptions_deck ON deck_card_disruptions(deck_id, acknowledged_at);
  `);

  console.log('✓ Added trades, trade_items and deck_card_disruptions tables');
}

export function down(db) {
  db.exec(`
    DROP TABLE IF EXISTS deck_card_disruptions;
    DROP TABLE IF EXISTS trade_items;
    DROP TABLE IF EXISTS trades;
  `);

  console.log('✓ Removed trade tables');
}
