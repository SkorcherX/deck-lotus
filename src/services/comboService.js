import crypto from 'crypto';
import db from '../db/connection.js';
import { selectBracketCombos } from '../shared/comboFilter.js';

/**
 * Two-card combos for the Commander bracket, from Commander Spellbook.
 *
 * Looked up per deck, on demand, and cached by a hash of the deck's played
 * card names. The alternative, their bulk export, is ~700 MB of JSON — too
 * much to pull into the container every week for one feature. Reading a deck
 * never waits on Spellbook: `getDeck` uses whatever the cache holds and says
 * whether it is current, and the page asks for a lookup when it is not.
 *
 * Only card names leave the server, the same list anyone would paste into
 * Spellbook's own site.
 */

const FIND_MY_COMBOS = process.env.SPELLBOOK_URL
  || 'https://backend.commanderspellbook.com/find-my-combos';
const TIMEOUT_MS = 15000;

/** Mainboard and commander names, unique — what Spellbook is asked about. */
export function playedNames(cards) {
  const commanders = new Set();
  const main = new Set();
  for (const c of cards || []) {
    const board = c.board_type || (c.is_sideboard ? 'sideboard' : 'mainboard');
    if (c.is_commander) commanders.add(c.name);
    else if (board === 'mainboard') main.add(c.name);
  }
  return { commanders: [...commanders].sort(), main: [...main].sort() };
}

function hashOf({ commanders, main }) {
  return crypto.createHash('sha1')
    .update(JSON.stringify([commanders, main]))
    .digest('hex');
}

/**
 * What the cache knows for this list: `current` when it was looked up for
 * exactly these cards, `stale` when the deck has changed since (combos from
 * the old list are still returned — usually most of them still hold), `none`
 * when it was never looked up.
 */
export function getCachedCombos(deckId, cards) {
  const row = db.get(`SELECT card_hash, combos FROM deck_combo_cache WHERE deck_id = ?`, [deckId]);
  if (!row) return { status: 'none', combos: [] };
  let combos = [];
  try { combos = JSON.parse(row.combos); } catch { /* treat as empty */ }
  return { status: row.card_hash === hashOf(playedNames(cards)) ? 'current' : 'stale', combos };
}

/**
 * Ask Spellbook about this list and cache the answer.
 * Throws on a network or service failure; nothing is cached then.
 */
export async function refreshDeckCombos(deckId, cards) {
  const names = playedNames(cards);
  const body = {
    commanders: names.commanders.map((card) => ({ card })),
    main: names.main.map((card) => ({ card })),
  };

  const res = await fetch(FIND_MY_COMBOS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Commander Spellbook answered ${res.status}`);
  const json = await res.json();

  const cmcByName = new Map((cards || []).map((c) => [c.name, c.cmc]));
  const combos = selectBracketCombos(json?.results?.included, cmcByName);

  db.run(
    `INSERT INTO deck_combo_cache (deck_id, card_hash, combos, fetched_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(deck_id) DO UPDATE SET
       card_hash = excluded.card_hash, combos = excluded.combos, fetched_at = excluded.fetched_at`,
    [deckId, hashOf(names), JSON.stringify(combos)]
  );
  return combos;
}
