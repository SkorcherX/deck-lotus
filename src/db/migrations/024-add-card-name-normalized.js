import { normalizeSql } from '../../utils/cardNameMatch.js';

/**
 * Quick-add search matched on the raw name, so a missing apostrophe ("Urzas
 * Tower") or an accent typed as plain ASCII ("Jotun Grunt") returned nothing.
 *
 * The punctuation-and-accent-stripped name lives in its own column. It is
 * stored rather than generated: a VIRTUAL generated column re-runs its REPLACE
 * chain for every row of every scan, which measured ~100x slower than matching
 * a stored string, and SQLite cannot ADD COLUMN a STORED one. Triggers keep it
 * in step with `name` instead, so MTGJSON imports stay correct without the
 * importer knowing about this column.
 */
export function up(db) {
  db.exec(`ALTER TABLE cards ADD COLUMN name_normalized TEXT;`);

  db.exec(`UPDATE cards SET name_normalized = ${normalizeSql('name')};`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cards_name_normalized
      ON cards(name_normalized);
  `);

  db.exec(`
    CREATE TRIGGER cards_name_normalized_insert
    AFTER INSERT ON cards
    BEGIN
      UPDATE cards SET name_normalized = ${normalizeSql('NEW.name')}
      WHERE id = NEW.id;
    END;
  `);

  // Scoped to UPDATE OF name, so the trigger's own write does not re-fire it.
  db.exec(`
    CREATE TRIGGER cards_name_normalized_update
    AFTER UPDATE OF name ON cards
    BEGIN
      UPDATE cards SET name_normalized = ${normalizeSql('NEW.name')}
      WHERE id = NEW.id;
    END;
  `);

  console.log('✓ Added normalized name column, index and triggers on cards');
}

export function down(db) {
  db.exec(`DROP TRIGGER IF EXISTS cards_name_normalized_insert;`);
  db.exec(`DROP TRIGGER IF EXISTS cards_name_normalized_update;`);
  db.exec(`DROP INDEX IF EXISTS idx_cards_name_normalized;`);
  db.exec(`ALTER TABLE cards DROP COLUMN name_normalized;`);

  console.log('✓ Removed normalized name column from cards');
}
