/**
 * Preconstructed decklists, so a deck the player bought off a shelf can be
 * recognised as one.
 *
 * The deck advisor treats every deck as something its owner built and is free
 * to change. A precon is not that: Wizards built it, it is a coherent thing
 * already, and burying its owner in findings about its mana base tells them
 * their purchase is broken. Knowing "this is Witherbloom Witchcraft, 96%
 * stock" changes what is worth saying about it.
 *
 * ── Nothing here references cards or printings ─────────────────────────────
 *
 * `scripts/import-mtgjson.js` clears `cards` and `printings` on every weekly
 * sync, so a foreign key would either cascade this away or block the import —
 * the same reason `audit_log` and `found_cards` hold plain integers. Cards are
 * stored by **name**, which is what survives a reimport and what the matching
 * compares anyway, with the MTGJSON `uuid` kept beside it for reference only.
 *
 * That the sync cannot touch these tables is not merely safe, it is the point:
 * the decklists are ~124MB of downloads to assemble and they never change
 * once published, so the cache has to outlive the weekly rebuild or every
 * sync would re-fetch all of it.
 *
 * ── Reference data, so not backed up ───────────────────────────────────────
 *
 * `backupService.js` is for things a user cannot get back. These are public
 * decklists that `scripts/import-precons.js` will re-fetch, and they are
 * identical for every user, so putting them in a backup would bloat it with
 * data that is not the user's.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS precon_decks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- MTGJSON's file name, e.g. 'WitherbloomWitchcraft_C21'. Stable across
      -- releases and unique, so it is what the importer checks before
      -- deciding it already has a deck and can skip the download.
      file_name TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      set_code TEXT,
      type TEXT,
      release_date TEXT,
      -- Total cards, so a match percentage can be worked out without
      -- summing the card rows every time.
      total_cards INTEGER NOT NULL DEFAULT 0,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX idx_precon_decks_set_code ON precon_decks(set_code);
    CREATE INDEX idx_precon_decks_type ON precon_decks(type);

    CREATE TABLE IF NOT EXISTS precon_deck_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      precon_deck_id INTEGER NOT NULL,
      -- The identifier that survives a card reimport. Normalised alongside so
      -- matching does not turn into a LIKE over punctuation and case.
      card_name TEXT NOT NULL,
      card_name_normalized TEXT NOT NULL,
      -- Reference only. Not a foreign key: see the note above.
      printing_uuid TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      is_commander INTEGER NOT NULL DEFAULT 0,
      is_sideboard INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (precon_deck_id) REFERENCES precon_decks(id) ON DELETE CASCADE,
      UNIQUE(precon_deck_id, card_name_normalized, is_commander, is_sideboard)
    );

    CREATE INDEX idx_precon_deck_cards_deck ON precon_deck_cards(precon_deck_id);
    -- The index the matching leans on: given the names in a user's deck, find
    -- every precon containing them.
    CREATE INDEX idx_precon_deck_cards_name ON precon_deck_cards(card_name_normalized);
  `);

  console.log('✓ Added precon_decks and precon_deck_cards tables');
}

export function down(db) {
  db.exec(`
    DROP TABLE IF EXISTS precon_deck_cards;
    DROP TABLE IF EXISTS precon_decks;
  `);
  console.log('✓ Removed precon deck tables');
}
