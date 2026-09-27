/**
 * A deck can be left short by a loan coming home, not only by a trade.
 *
 * deck_card_disruptions gains `loan_id`, set instead of `trade_id` when the
 * shortfall came from returning a borrowed card. No foreign key: card_loans
 * rows are never deleted by the app, and a restore that skips a loan should
 * leave the disruption standing without its link, same as trades.
 */
export function up(db) {
  const columns = db.prepare(`PRAGMA table_info(deck_card_disruptions)`).all();

  if (!columns.some((c) => c.name === 'loan_id')) {
    db.exec(`ALTER TABLE deck_card_disruptions ADD COLUMN loan_id INTEGER`);
  }

  console.log('✓ Added loan_id to deck_card_disruptions');
}

export function down() {
  // ⚠ The migration runner never calls down(), so this is documentation.
}
