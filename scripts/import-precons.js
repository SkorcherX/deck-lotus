#!/usr/bin/env node
/**
 * Fetch preconstructed decklists from MTGJSON, so a deck bought off a shelf
 * can be recognised as one.
 *
 * ── Why this is its own script, and cached ─────────────────────────────────
 *
 * MTGJSON serves one file per deck and each is around 650KB, because it embeds
 * the whole card object — every printing detail and every translation — for
 * cards we already have. The ~190 Commander decks are therefore about 124MB of
 * transfer to extract roughly 19,000 names and counts.
 *
 * That is only tolerable because a decklist is immutable: Witherbloom
 * Witchcraft shipped in 2021 and will never gain a card. So the download
 * happens once. Every run reads MTGJSON's index, compares it to what is
 * already stored, and fetches only decks it has never seen — which after the
 * first run is the handful released since. `--refresh` forces the lot.
 *
 * The cache lives in `precon_decks`, which the weekly card sync does not
 * touch (see migration 039). If it did, every sync would re-download 124MB.
 *
 * Usage:
 *   node scripts/import-precons.js              only decks not already stored
 *   node scripts/import-precons.js --refresh    re-fetch everything
 *   node scripts/import-precons.js --limit 5    stop after five, for a smoke test
 */
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.DATABASE_PATH = process.env.DATABASE_PATH
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'deck-lotus.db');

const { default: db } = await import('../src/db/connection.js');
const { normalizeForSearch } = await import('../src/utils/cardNameMatch.js');

const DECK_LIST_URL = 'https://mtgjson.com/api/v5/DeckList.json';
const DECK_URL = (fileName) => `https://mtgjson.com/api/v5/decks/${fileName}.json`;

/**
 * Which of MTGJSON's deck types are worth storing.
 *
 * The index carries 3,029 decks across 48 types, and most of them are not
 * decks. Rather than guess from the names, one of each candidate type was
 * fetched and its mainboard counted; these are the ones that came back as
 * actual constructed decks:
 *
 *   Commander Deck 190      100 cards
 *   Theme Deck 220           60
 *   Duel Deck 52             60
 *   Planeswalker Deck 41     60
 *   World Championship 32    60 + 15
 *   Event Deck 26            60 + 15
 *   Challenger Deck 22       60 + 15
 *   Enhanced Deck 20         60 + 15
 *   Game Night Deck 15       60
 *   Advanced Deck 12         60 + 15
 *   Starter Kit 12           60
 *   Guild Kit 10             60
 *   Clash Pack 9             60
 *   Pioneer Challenger 8     60 + 15
 *   Spellslinger Kit 4       60
 *   Premium Deck 3           60
 *   Modern Event Deck 1      60 + 15
 *
 * And these are the ones left out, with the count the sample returned:
 *
 *   Secret Lair Drop 739     not a deck
 *   Jumpstart 570            20-card halves, not a deck
 *   MTGO Redemption 197      a set redemption, not a deck
 *   Intro Pack 167           41 cards, and inconsistent across the line
 *   Deck Builder's Toolkit   10 cards; a box of singles
 *   Bundle Land Pack 89      lands only
 *   Box Set 71               15 cards
 *   Arena Starter Deck 101   60 cards, but Arena-only — nobody owns it on
 *                            paper, so matching a paper collection to it is
 *                            noise
 *   Welcome / Sample / Starter Deck   30-40 cards
 *
 * The sixty-card files are *smaller* than the Commander ones — around 180KB
 * against 650KB — because a sixty-card deck holds far fewer distinct cards.
 * The whole set is roughly 210MB once, against 124MB for Commander alone.
 */
const WANTED_TYPES = new Set([
  'Commander Deck',
  'Theme Deck',
  'Duel Deck',
  'Planeswalker Deck',
  'World Championship Deck',
  'Event Deck',
  'Challenger Deck',
  'Enhanced Deck',
  'Game Night Deck',
  'Advanced Deck',
  'Starter Kit',
  'Guild Kit',
  'Clash Pack',
  'Pioneer Challenger Deck',
  'Spellslinger Starter Kit',
  'Premium Deck',
  'Modern Event Deck',
]);

/** Be a good guest: MTGJSON is free infrastructure and this is a bulk read. */
const CONCURRENCY = 4;
const RETRIES = 3;

function fetchJson(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'deck-lotus/1.0 precon-import' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        return fetchJson(res.headers.location, attempt).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        // A deck the index lists but the API has not published is a gap in
        // their data, not an error worth stopping a 190-deck run for.
        return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', (error) => {
      if (attempt < RETRIES) {
        setTimeout(() => fetchJson(url, attempt + 1).then(resolve, reject), 500 * attempt);
        return;
      }
      reject(error);
    });
  });
}

/**
 * Store one deck, replacing whatever was there under the same file name.
 *
 * Written in a transaction so a deck is never half-imported: a partial
 * decklist would match a user's deck at some meaningless percentage and there
 * would be nothing to show it was wrong.
 */
function saveDeck(entry, payload) {
  const boards = [
    ['commander', payload.commander || [], 1, 0],
    ['mainBoard', payload.mainBoard || [], 0, 0],
    ['sideBoard', payload.sideBoard || [], 0, 1],
  ];

  const rows = [];
  for (const [, cards, isCommander, isSideboard] of boards) {
    for (const card of cards) {
      if (!card || !card.name) continue;
      rows.push({
        name: card.name,
        normalized: normalizeForSearch(card.name),
        uuid: card.uuid || null,
        quantity: Number(card.count) || 1,
        isCommander,
        isSideboard,
      });
    }
  }

  const total = rows.reduce((sum, row) => sum + row.quantity, 0);

  // The connection wrapper's transaction() runs the function and returns its
  // result, rather than returning a callable the way better-sqlite3 does.
  db.transaction(() => {
    db.run(`DELETE FROM precon_decks WHERE file_name = ?`, [entry.fileName]);
    db.run(
      `INSERT INTO precon_decks (file_name, name, set_code, type, release_date, total_cards)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.fileName, payload.name || entry.name, payload.code || entry.code,
        payload.type || entry.type, payload.releaseDate || entry.releaseDate, total]
    );
    const deckId = db.get(`SELECT id FROM precon_decks WHERE file_name = ?`, [entry.fileName]).id;

    for (const row of rows) {
      // A deck can list the same card in two boards; the unique key keeps them
      // apart. Same card twice in one board is one row with the counts summed,
      // which is what INSERT ... ON CONFLICT does here.
      db.run(
        `INSERT INTO precon_deck_cards
           (precon_deck_id, card_name, card_name_normalized, printing_uuid, quantity, is_commander, is_sideboard)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(precon_deck_id, card_name_normalized, is_commander, is_sideboard)
         DO UPDATE SET quantity = quantity + excluded.quantity`,
        [deckId, row.name, row.normalized, row.uuid, row.quantity, row.isCommander, row.isSideboard]
      );
    }
  });

  return { cards: rows.length, total };
}

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const limitAt = args.indexOf('--limit');
  const limit = limitAt >= 0 ? Number(args[limitAt + 1]) || 0 : 0;

  console.log('Reading MTGJSON deck index...');
  const index = await fetchJson(DECK_LIST_URL);
  const all = index.data || [];
  const wanted = all.filter((entry) => WANTED_TYPES.has(entry.type));

  console.log(`  ${all.length} decks listed, ${wanted.length} of the types we store`);

  const have = new Set(
    refresh ? [] : db.all(`SELECT file_name FROM precon_decks`).map((row) => row.file_name)
  );
  let todo = wanted.filter((entry) => !have.has(entry.fileName));
  if (limit > 0) todo = todo.slice(0, limit);

  if (todo.length === 0) {
    console.log('✓ Nothing to fetch — every decklist is already stored.');
    return;
  }

  console.log(`  ${have.size} already stored, fetching ${todo.length}`);
  console.log(`  (about ${Math.round((todo.length * 650) / 1024)}MB; decklists never change, so this is one-off)\n`);

  let done = 0;
  let cards = 0;
  const failures = [];

  const queue = [...todo];
  const worker = async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      try {
        const payload = await fetchJson(DECK_URL(entry.fileName));
        const saved = saveDeck(entry, payload.data || {});
        cards += saved.total;
        done += 1;
        if (done % 10 === 0 || done === todo.length) {
          console.log(`  ${done}/${todo.length}  ${entry.name}`);
        }
      } catch (error) {
        // One unavailable deck must not lose the other 189 already fetched.
        failures.push({ name: entry.name, reason: error.message });
      }
    }
  };

  await Promise.all([...Array(Math.min(CONCURRENCY, queue.length))].map(worker));

  console.log(`\n✓ Stored ${done} decklists, ${cards} cards`);
  if (failures.length > 0) {
    console.log(`⚠ ${failures.length} could not be fetched and will be retried next run:`);
    for (const failure of failures.slice(0, 10)) {
      console.log(`   - ${failure.name}: ${failure.reason}`);
    }
  }

  const stored = db.get(`SELECT COUNT(*) AS n FROM precon_decks`).n;
  console.log(`  ${stored} decklists in total`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Precon import failed:', error.message);
    process.exit(1);
  });
