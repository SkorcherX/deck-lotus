import { backfillNormalizedColumn } from '../../utils/cardNameMatch.js';

/**
 * The deck builder searches foreign printings too, where accents are the rule
 * rather than the exception ("Épée du Corps et de l'Esprit"). Give
 * card_foreign_data the same normalized column cards got in 024, so typing
 * plain ASCII finds them.
 *
 * Filled in the same way, and for the same reasons: see 024.
 */
export function up(db) {
  db.exec(`ALTER TABLE card_foreign_data ADD COLUMN foreign_name_normalized TEXT;`);

  const updated = backfillNormalizedColumn(db, {
    table: 'card_foreign_data',
    sourceColumn: 'foreign_name',
    targetColumn: 'foreign_name_normalized'
  });

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_foreign_name_normalized
      ON card_foreign_data(foreign_name_normalized);
  `);

  console.log(`✓ Added normalized foreign name column (${updated} rows)`);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_foreign_name_normalized;`);
  db.exec(`ALTER TABLE card_foreign_data DROP COLUMN foreign_name_normalized;`);

  console.log('✓ Removed normalized foreign name column');
}
