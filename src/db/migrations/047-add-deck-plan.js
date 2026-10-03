/**
 * A deck's plan: what it is built around, kept on the deck so revisions and
 * the builder's "Fits this deck" panel start from the owner's choices instead
 * of re-guessing them from the card text every time.
 *
 * One JSON column rather than a table — it is a handful of settings read and
 * written whole, never queried by field:
 *
 *   { themeKey, secondaryThemeKey, secondaryShare, keep: [card names] }
 *
 * Kept cards are names, not card ids: `cards` is rebuilt by the weekly MTGJSON
 * import, which is the same reason backupService never stores a card_id.
 * NULL means no plan has been saved. backupService carries the column.
 */
export function up(db) {
  const columns = db.prepare(`PRAGMA table_info(decks)`).all();
  if (!columns.some((c) => c.name === 'plan')) {
    db.exec(`ALTER TABLE decks ADD COLUMN plan TEXT`);
  }
  console.log('✓ Added plan to decks');
}
