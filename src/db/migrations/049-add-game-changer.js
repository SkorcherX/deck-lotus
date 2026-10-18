/**
 * Wizards' Game Changer list, as MTGJSON flags it (`isGameChanger`, v5.2.2+).
 *
 * Read by the Commander bracket floor (src/shared/commanderBrackets.js). It
 * lives on `cards`, which the weekly import rebuilds, so the import fills it
 * and nothing else has to: an existing install reads 0 everywhere until its
 * next card sync, and the bracket reports that rather than a clean bill.
 */
export function up(db) {
  const columns = db.prepare(`PRAGMA table_info(cards)`).all();
  if (!columns.some((c) => c.name === 'is_game_changer')) {
    db.exec(`ALTER TABLE cards ADD COLUMN is_game_changer INTEGER NOT NULL DEFAULT 0`);
  }
  console.log('✓ Added is_game_changer to cards');
}
