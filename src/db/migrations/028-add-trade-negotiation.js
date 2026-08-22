export function up(db) {
  // A trade can now be built in two passes rather than one.
  //
  // The one-pass flow stays: fill in both sides yourself and send it. The new
  // one starts with a shopping trip — you browse someone's collection, pick
  // what you want, and send that across as a request. They then shop yours
  // and pick what they want back, which turns the request into a full trade
  // for you to accept. Two people each choose their own half, which is how a
  // trade works at a kitchen table.
  //
  // That means a trade is no longer always waiting on its recipient, so who
  // holds it becomes a column rather than something inferred from the roles.
  // Inferring it was already the rule ("only the person a trade was sent to
  // can accept it") and it stops being true the moment the ball comes back.

  db.exec(`
    ALTER TABLE trades ADD COLUMN awaiting_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
  `);

  // Existing trades all follow the old rule: the recipient is the one who has
  // to answer. Anything already resolved keeps a null, since nobody is
  // waiting on a finished trade.
  const updated = db.prepare(`
    UPDATE trades SET awaiting_user_id = to_user_id WHERE status = 'pending'
  `).run();

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_trades_awaiting ON trades(awaiting_user_id, status);
  `);

  console.log(`✓ Added trade negotiation state (${updated.changes} open trade(s) assigned)`);
}

export function down(db) {
  // SQLite can drop a column in modern versions; the index has to go first.
  db.exec(`
    DROP INDEX IF EXISTS idx_trades_awaiting;
    ALTER TABLE trades DROP COLUMN awaiting_user_id;
  `);

  // Requests that never got a counter-offer have no meaning without the
  // column that says whose turn it is, so retire them rather than leave them
  // looking like ordinary pending trades nobody can act on.
  db.prepare(`
    UPDATE trades SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP
     WHERE status = 'awaiting_counter'
  `).run();

  console.log('✓ Removed trade negotiation state');
}
