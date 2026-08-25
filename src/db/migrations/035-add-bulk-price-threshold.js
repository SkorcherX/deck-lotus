/**
 * The price ceiling for the bulk-bin shopping view.
 *
 * Local game shops keep boxes of bulk cards you rummage through by hand, and
 * the useful question there is not "what do my decks need" but "what do my
 * decks need that is cheap enough to turn up in a bin". Where that line sits
 * depends on the shops you actually go to, so it is a preference rather than
 * a constant.
 *
 * On `users` rather than in app-settings.json, unlike the backup schedule:
 * that file holds deployment-wide configuration, and this is one person's
 * habit. Two people sharing an install shop at different shops.
 *
 * REAL, not INTEGER cents. Prices throughout this app are REAL — the `prices`
 * table, every estimate on the shopping page — and storing this one as cents
 * would mean a conversion at every comparison, which is where the rounding
 * bugs would come from.
 *
 * 1.0 as the default because that is the figure people quote for bulk. It is
 * editable inline on the page, so nobody has to go looking for a settings
 * screen to change it.
 */
export function up(db) {
  db.exec(`
    ALTER TABLE users ADD COLUMN bulk_price_threshold REAL NOT NULL DEFAULT 1.0;
  `);

  console.log('✓ Added bulk_price_threshold column to users table');
}

export function down(db) {
  // ⚠ The migration runner never calls down(), so this is documentation.
  // SQLite has no practical DROP COLUMN and rebuilding `users` would drop the
  // PRIMARY KEY that decks, owned_printings, trades and the rest reference —
  // see the note in 034. The column has a default and nothing that predates
  // this migration is broken by its presence, so leaving it is the safer
  // rollback.
  console.log('✓ Nothing to roll back (bulk_price_threshold intentionally left in place)');
}
