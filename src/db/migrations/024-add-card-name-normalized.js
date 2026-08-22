import { backfillNormalizedColumn } from '../../utils/cardNameMatch.js';

/**
 * Quick-add search matched on the raw name, so a missing apostrophe ("Urzas
 * Tower") or an accent typed as plain ASCII ("Jotun Grunt") returned nothing.
 *
 * The punctuation-and-accent-stripped name lives in its own column, filled in
 * by whoever writes the row: the MTGJSON importer for new rows, this migration
 * for rows that already exist. Not a generated column (VIRTUAL re-runs the
 * transform on every row of every scan, and SQLite cannot ADD COLUMN a STORED
 * one) and not trigger-maintained — both would need the normalization
 * expressed in SQL, where a REPLACE per accent nests deep enough to overflow
 * SQLite's parser.
 */
export function up(db) {
  db.exec(`ALTER TABLE cards ADD COLUMN name_normalized TEXT;`);

  const updated = backfillNormalizedColumn(db, {
    table: 'cards',
    sourceColumn: 'name',
    targetColumn: 'name_normalized'
  });

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cards_name_normalized
      ON cards(name_normalized);
  `);

  console.log(`✓ Added normalized name column on cards (${updated} rows)`);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_cards_name_normalized;`);
  db.exec(`ALTER TABLE cards DROP COLUMN name_normalized;`);

  console.log('✓ Removed normalized name column from cards');
}
