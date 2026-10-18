/**
 * Commander Spellbook's answer for a deck, cached.
 *
 * `card_hash` is a hash of the played card names (commander included): when
 * the list changes the hash stops matching and the deck is looked up again.
 * Combos are stored as card names, never ids, so the weekly MTGJSON import
 * leaves this alone. It is a cache of an outside service, not user data:
 * backupService does not carry it, and losing it costs one lookup.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deck_combo_cache (
      deck_id INTEGER PRIMARY KEY REFERENCES decks(id) ON DELETE CASCADE,
      card_hash TEXT NOT NULL,
      combos TEXT NOT NULL,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✓ Added deck_combo_cache');
}
