export function up(db) {
  // Cards somebody wants to buy that no deck asked for.
  //
  // The shopping list was derived and only derived: pick decks, get back what
  // those decks need and you do not own. That answers one question well and
  // the neighbouring one not at all — "I want a copy of this, it is not for
  // anything yet". The only way to shop for such a card was to invent a deck
  // to hold it, which then had to be remembered and deleted.
  //
  // So this table holds the undecided half, and the deck-derived half stays
  // derived. Nothing is copied in here from a deck; getShoppingList merges the
  // two on read. That split is deliberate: a wanted row that duplicated a
  // deck's requirement would go stale the moment the deck changed, and then
  // the list would disagree with the deck it came from.
  //
  // printing_id, not card_id. Price, set and collector number are all
  // printing-level, and the whole point of the list is the estimate at the
  // bottom of it. Browse Cards works at card level and picks the cheapest
  // printing on the way in — a default the user can change afterwards, not a
  // limitation of what can be stored.
  //
  // is_foil is part of the key for the same reason it is in owned_printings
  // and deck_cards: a foil and a non-foil of the same printing are different
  // things to buy at different prices, and collapsing them onto one key loses
  // one of them silently.
  //
  // The FK to printings is ON DELETE CASCADE and that is not an oversight:
  // scripts/import-mtgjson.js clears printings every weekly sync, so these
  // rows are backed up and restored there by printing uuid, exactly like
  // trade_items and deck_card_disruptions. A list that quietly emptied itself
  // every Sunday would be worse than no list.

  db.exec(`
    CREATE TABLE IF NOT EXISTS shopping_list_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      user_id INTEGER NOT NULL,
      printing_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      is_foil INTEGER NOT NULL DEFAULT 0,

      -- Why you wanted it, in your own words. Free-form and optional.
      note TEXT,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (printing_id) REFERENCES printings(id) ON DELETE CASCADE,

      UNIQUE(user_id, printing_id, is_foil)
    );

    -- The only read there is: one user's whole list.
    CREATE INDEX IF NOT EXISTS idx_shopping_list_user
      ON shopping_list_items(user_id);
  `);

  console.log('✓ Added shopping_list_items table');
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_shopping_list_user;
    DROP TABLE IF EXISTS shopping_list_items;
  `);

  console.log('✓ Removed shopping_list_items table');
}
