export function up(db) {
  // A record of who changed what, kept so a bad bulk import can be found and
  // corrected after the fact.
  //
  // The failure this exists for: someone pastes a hundred lines into the bulk
  // adder with the wrong set code, or fat-fingers a collector number, and the
  // wrong printings land in the collection. Without a log the only evidence is
  // the collection itself, which by then looks exactly like a collection
  // somebody meant to have. With one, the batch is a contiguous run of rows
  // sharing a timestamp and a source, and it can be read back line by line.
  //
  // The card identity is DENORMALISED ON PURPOSE. `scripts/import-mtgjson.js`
  // clears `printings` on every weekly sync, and a foreign key to it — with or
  // without ON DELETE CASCADE — would either take the history with it or block
  // the import outright. `printing_id` is therefore a plain integer with no
  // constraint, and the fields a human actually reads (card name, set code,
  // collector number, finish) are copied in at write time. `printing_uuid` is
  // the stable MTGJSON identifier and survives a reimport, so it is what to
  // re-join on when a row needs to point at a live printing again.
  //
  // `user_id` is whose collection or deck moved; `actor_user_id` is who caused
  // it. They differ for the far side of a trade. Scoping a user's own log to
  // `user_id` is what keeps a trade from leaking the partner's deck names —
  // deck_id/deck_name are only ever written for the row's own user.
  //
  // Purely additive: one new table, no existing table is touched or rebuilt.

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      user_id INTEGER NOT NULL,
      actor_user_id INTEGER,

      -- 'inventory' | 'deck' | 'trade'
      entity_type TEXT NOT NULL,
      -- dotted verb, e.g. 'inventory.add', 'deck.card_remove', 'trade.accept'
      action TEXT NOT NULL,
      -- where the change came in from: 'bulk_add', 'quick_add', 'card_page',
      -- 'deck_builder', 'deck_import', 'trade', 'scan', 'api'
      source TEXT NOT NULL,

      -- Card identity, copied rather than referenced. See note above.
      printing_id INTEGER,
      printing_uuid TEXT,
      card_name TEXT,
      set_code TEXT,
      collector_number TEXT,
      is_foil INTEGER,

      quantity_before INTEGER,
      quantity_after INTEGER,
      quantity_delta INTEGER,

      deck_id INTEGER,
      deck_name TEXT,
      trade_id INTEGER,

      -- Free-form JSON for anything that does not deserve a column.
      detail TEXT,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- The default view is one user's history newest-first.
    CREATE INDEX IF NOT EXISTS idx_audit_log_user_time
      ON audit_log(user_id, created_at DESC);

    -- Admins read across users, still newest-first.
    CREATE INDEX IF NOT EXISTS idx_audit_log_time
      ON audit_log(created_at DESC);

    -- "Show me everything that touched this card / this set" is the query that
    -- turns a suspected bad batch into a list of rows to fix.
    CREATE INDEX IF NOT EXISTS idx_audit_log_card
      ON audit_log(card_name);

    CREATE INDEX IF NOT EXISTS idx_audit_log_set
      ON audit_log(set_code);

    CREATE INDEX IF NOT EXISTS idx_audit_log_action
      ON audit_log(action);
  `);

  console.log('✓ Added audit_log table');
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_audit_log_action;
    DROP INDEX IF EXISTS idx_audit_log_set;
    DROP INDEX IF EXISTS idx_audit_log_card;
    DROP INDEX IF EXISTS idx_audit_log_time;
    DROP INDEX IF EXISTS idx_audit_log_user_time;
    DROP TABLE IF EXISTS audit_log;
  `);

  console.log('✓ Removed audit_log table');
}
