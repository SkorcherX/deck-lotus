export function up(db) {
  // Scan resolution looks printings up by (set_code, collector_number) with no
  // card name — the strongest signal a 2015+ card's collector block gives us.
  // Only set_code is indexed today, so that lookup scans every printing in the
  // set. The composite index makes it a direct hit.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_printings_set_collector
      ON printings(set_code, collector_number);
  `);

  console.log('✓ Added composite index on printings(set_code, collector_number)');
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_printings_set_collector;`);

  console.log('✓ Removed composite index on printings(set_code, collector_number)');
}
