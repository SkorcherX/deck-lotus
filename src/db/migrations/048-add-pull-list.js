/**
 * The pull list: a checklist for taking a deck's cards out of physical
 * storage.
 *
 * `users.pull_layout` is how that user's storage is arranged (see
 * src/shared/pullLayout.js) as JSON; NULL means the default layout.
 *
 * `deck_pull_progress` is how far through pulling a deck somebody is, so a
 * pull spread over several evenings — or started on a phone at the shelf and
 * finished at the desk — is not lost. Ticking changes nothing in the deck or
 * the collection; it records progress through a physical task, nothing more.
 *
 * The printing is held by `printing_uuid` with no foreign key, same as
 * audit_log and card_loans: `scripts/import-mtgjson.js` clears `printings`
 * every week, and the uuid is what survives it. It hangs off `decks`, which
 * the import never clears, and backupService carries it.
 */
export function up(db) {
  const columns = db.prepare(`PRAGMA table_info(users)`).all();
  if (!columns.some((c) => c.name === 'pull_layout')) {
    db.exec(`ALTER TABLE users ADD COLUMN pull_layout TEXT`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS deck_pull_progress (
      deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      printing_uuid TEXT NOT NULL,
      is_foil INTEGER NOT NULL DEFAULT 0,
      pulled INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (deck_id, printing_uuid, is_foil)
    )
  `);
  console.log('✓ Added pull_layout to users and deck_pull_progress');
}
