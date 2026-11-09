/**
 * Proxy decks: decks built from proxies rather than real cards, played as a
 * themed "pre-con" and never mixed with the real collection.
 *
 * The flag is per deck, not per card, because a proxy deck is proxies all
 * the way through. A proxy deck's cards are never in `owned_printings`, so
 * they cannot reach collection counts or value; what the flag adds is that
 * the deck claims none of the real collection either — every "copies in
 * decks" count skips it — and its readiness is "ready" because its cards are
 * in its own box. Brackets, power and legality are unchanged: a proxy plays
 * like the real card. backupService carries the column.
 */
export function up(db) {
  const columns = db.prepare(`PRAGMA table_info(decks)`).all();
  if (!columns.some((c) => c.name === 'is_proxy')) {
    db.exec(`ALTER TABLE decks ADD COLUMN is_proxy INTEGER NOT NULL DEFAULT 0`);
  }
  console.log('✓ Added is_proxy to decks');
}
