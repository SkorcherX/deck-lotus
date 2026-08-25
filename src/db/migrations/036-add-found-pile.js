/**
 * The found pile: cards ticked off while standing at a shop.
 *
 * "Found it!" used to add the card to the collection outright, and that is the
 * wrong claim. What you find in a bulk box is a card with the right *name* —
 * almost never the printing the deck happens to list. Writing it straight into
 * `owned_printings` records a specific set and collector number nobody chose,
 * and the mistake is invisible until a printing-sensitive page disagrees with
 * the shoebox.
 *
 * So the tick is stored as its own thing: a pile of names and counts, saved on
 * every press so a phone dying in a shop does not lose the trip, and reversible
 * because the button is pressed one-handed over a box and gets misclicked.
 * Turning the pile into inventory is a separate, deliberate step at home,
 * where the printings can actually be chosen.
 *
 * `card_id` is a plain integer with no foreign key, and the name is
 * denormalised beside it — the same shape and the same reason as `audit_log`:
 * scripts/import-mtgjson.js clears `printings` on every weekly sync, and a
 * real FK would either cascade a shopping trip away mid-rummage or block the
 * import. The name is what the review screen resolves against anyway.
 *
 * UNIQUE(user_id, card_id) makes the button a toggle rather than a counter:
 * pressing it twice unfinds, it does not find two.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS found_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id INTEGER NOT NULL,
      card_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, card_id)
    );

    CREATE INDEX IF NOT EXISTS idx_found_cards_user ON found_cards(user_id);
  `);

  console.log('✓ Created found_cards table');
}

export function down(db) {
  // ⚠ The migration runner never calls down(), so this is documentation.
  db.exec(`DROP TABLE IF EXISTS found_cards;`);
  console.log('✓ Dropped found_cards');
}
