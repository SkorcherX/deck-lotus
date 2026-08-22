import { normalizeSql } from '../../utils/cardNameMatch.js';

/**
 * The deck builder searches foreign printings too, where accents are the rule
 * rather than the exception ("Épée du Corps et de l'Esprit"). Give
 * card_foreign_data the same normalized column cards got in 024, so typing
 * plain ASCII finds them.
 *
 * Stored and trigger-maintained for the same reason as 024: a VIRTUAL
 * generated column re-runs its REPLACE chain on every row of every scan.
 */
export function up(db) {
  db.exec(`ALTER TABLE card_foreign_data ADD COLUMN foreign_name_normalized TEXT;`);

  db.exec(`
    UPDATE card_foreign_data
    SET foreign_name_normalized = ${normalizeSql('foreign_name')}
    WHERE foreign_name IS NOT NULL;
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_foreign_name_normalized
      ON card_foreign_data(foreign_name_normalized);
  `);

  db.exec(`
    CREATE TRIGGER foreign_name_normalized_insert
    AFTER INSERT ON card_foreign_data
    BEGIN
      UPDATE card_foreign_data
      SET foreign_name_normalized = ${normalizeSql('NEW.foreign_name')}
      WHERE id = NEW.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER foreign_name_normalized_update
    AFTER UPDATE OF foreign_name ON card_foreign_data
    BEGIN
      UPDATE card_foreign_data
      SET foreign_name_normalized = ${normalizeSql('NEW.foreign_name')}
      WHERE id = NEW.id;
    END;
  `);

  console.log('✓ Added normalized foreign name column, index and triggers');
}

export function down(db) {
  db.exec(`DROP TRIGGER IF EXISTS foreign_name_normalized_insert;`);
  db.exec(`DROP TRIGGER IF EXISTS foreign_name_normalized_update;`);
  db.exec(`DROP INDEX IF EXISTS idx_foreign_name_normalized;`);
  db.exec(`ALTER TABLE card_foreign_data DROP COLUMN foreign_name_normalized;`);

  console.log('✓ Removed normalized foreign name column');
}
