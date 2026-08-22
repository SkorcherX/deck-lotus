export function up(db) {
  // Answering a shopping request is no longer all-or-nothing.
  //
  // Someone who asks for six cards may well be told no on two of them and
  // yes on the other four. Until now the only answers were "accept the whole
  // list" or "decline the trade", which turns a normal negotiation into a
  // dead end and makes the asker guess which card was the problem.
  //
  // A declined card is marked rather than deleted. The row has to survive so
  // the person who asked can see *what* was turned down — cards quietly
  // vanishing from their own request is the confusing version of this — and
  // so the trade keeps an honest record of what was negotiated.

  db.exec(`
    ALTER TABLE trade_items ADD COLUMN declined INTEGER NOT NULL DEFAULT 0;
  `);

  console.log('✓ Trade items can be declined individually');
}

export function down(db) {
  // Dropping the column would silently reinstate every declined card as part
  // of the trade, so remove those rows instead of resurrecting them.
  const removed = db.prepare(`DELETE FROM trade_items WHERE declined = 1`).run();

  db.exec(`
    ALTER TABLE trade_items DROP COLUMN declined;
  `);

  console.log(`✓ Removed per-item declines (${removed.changes} declined item(s) dropped)`);
}
