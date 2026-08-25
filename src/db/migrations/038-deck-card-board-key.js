/**
 * Key a deck card on the board it is actually on.
 *
 * The app has three boards — mainboard, sideboard, maybeboard — and `board_type`
 * has carried all three since migration 016. The unique key never caught up:
 * `UNIQUE(deck_id, printing_id, is_sideboard, is_foil)` is keyed on a *boolean*,
 * which has no third state. Mainboard and maybeboard both mean `is_sideboard = 0`,
 * so a card on your mainboard could not also be on your maybeboard — and
 * "I am playing this, and I am considering another copy" is the entire point of
 * a maybeboard.
 *
 * It failed the worst possible way, too. `addCardToDeck` looked for an existing
 * row by `board_type` and inserted `is_sideboard` from a separate argument, so
 * the check and the constraint disagreed about what makes a row unique: the
 * check found nothing, the insert hit the key, and the user got a 500 with raw
 * SQLite internals in the body.
 *
 * ── The two columns now have to agree ───────────────────────────────────────
 *
 * `is_sideboard` predates `board_type` and cannot simply be dropped: the backup
 * format stores it, and queries across readiness, shopping and the deck pages
 * read `COALESCE(board_type, CASE WHEN is_sideboard = 1 ...)`. So it stays, but
 * as a derived value rather than an independent one, enforced by a CHECK.
 *
 * That matters because rows already exist where the two disagree — sending
 * `boardType: 'sideboard'` without `isSideboard: true` wrote
 * `board_type='sideboard', is_sideboard=0`. Every reader today follows
 * `board_type` and stays right, but the *key* followed `is_sideboard`, and any
 * future code reading it directly would have disagreed with all of them. The
 * backfill below settles those rows in favour of `board_type`, which is what
 * the whole app already believes.
 *
 * ── Why no row can collide ──────────────────────────────────────────────────
 *
 * The new key is strictly finer than the old one. Two rows differing only by
 * mainboard-versus-maybeboard shared `is_sideboard = 0` and so could never have
 * both existed under the old key; everything else is unchanged. The row count is
 * asserted anyway — a rebuild that quietly dropped a card is the failure worth
 * refusing, and the runner's transaction makes that an all-or-nothing refusal.
 */
export function up(db) {
  const before = db.prepare(`SELECT COUNT(*) as count FROM deck_cards`).get().count;

  // Settle the disagreements first, so the CHECK on the new table cannot be
  // tripped by history. board_type wins because it is what every reader in the
  // app already follows.
  db.exec(`
    UPDATE deck_cards
       SET board_type = COALESCE(board_type, CASE WHEN is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END);

    UPDATE deck_cards
       SET board_type = 'mainboard'
     WHERE board_type NOT IN ('mainboard', 'sideboard', 'maybeboard');

    UPDATE deck_cards
       SET is_sideboard = CASE WHEN board_type = 'sideboard' THEN 1 ELSE 0 END
     WHERE is_sideboard IS NOT (CASE WHEN board_type = 'sideboard' THEN 1 ELSE 0 END);
  `);

  db.exec(`
    CREATE TABLE deck_cards_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_id INTEGER NOT NULL,
      printing_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      is_sideboard INTEGER NOT NULL DEFAULT 0,
      is_commander INTEGER DEFAULT 0,
      is_foil INTEGER NOT NULL DEFAULT 0,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      board_type TEXT NOT NULL DEFAULT 'mainboard'
        CHECK (board_type IN ('mainboard', 'sideboard', 'maybeboard')),
      FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE,
      FOREIGN KEY (printing_id) REFERENCES printings(id) ON DELETE CASCADE,
      -- The board, not a boolean standing in for it. Finish stays in the key
      -- for the reason it was added in 026: a foil copy is a different card to
      -- own, and the collection keys on it too.
      UNIQUE(deck_id, printing_id, board_type, is_foil),
      -- is_sideboard is a mirror of board_type, not a second opinion.
      CHECK (is_sideboard = (CASE WHEN board_type = 'sideboard' THEN 1 ELSE 0 END))
    );

    INSERT INTO deck_cards_new
      (id, deck_id, printing_id, quantity, is_sideboard, is_commander, is_foil, added_at, board_type)
      SELECT id, deck_id, printing_id, quantity, is_sideboard, is_commander, is_foil, added_at, board_type
      FROM deck_cards;

    DROP TABLE deck_cards;
    ALTER TABLE deck_cards_new RENAME TO deck_cards;

    CREATE INDEX idx_deck_cards_deck_id ON deck_cards(deck_id);
    CREATE INDEX idx_deck_cards_printing_id ON deck_cards(printing_id);
    CREATE INDEX idx_deck_cards_board_type ON deck_cards(board_type);
  `);

  const after = db.prepare(`SELECT COUNT(*) as count FROM deck_cards`).get().count;

  if (before !== after) {
    throw new Error(
      `Deck card board key migration aborted: deck_cards had ${before} rows before the rebuild and ${after} after`
    );
  }

  // Statistics describe a table that no longer exists in this shape. Cheap
  // here, and the alternative is the planner working from a stale picture of
  // the one table this migration rewrote — see 037.
  db.exec('ANALYZE;');

  console.log(`✓ deck_cards is keyed on board_type (${after} rows preserved)`);
}

export function down(db) {
  // ⚠ The migration runner never calls down(), so this is documentation.
  //
  // Going back means keying on is_sideboard again, which cannot represent a
  // card on both the mainboard and the maybeboard — the rollback would have to
  // choose one and delete the other. Merging the quantities is not available
  // either: they are copies on different boards, and a maybeboard copy is not
  // a copy the deck plays. Since nothing predating this migration is broken by
  // the finer key, the correct rollback is to leave it.
  console.log('✓ Nothing to roll back (the board key intentionally left in place)');
}
