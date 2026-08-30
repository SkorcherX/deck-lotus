/**
 * The identity table that goes with the hash index.
 *
 * The index says *which row* matched; this says what that row is. The two
 * together are the whole matcher, and the device that holds both can name a
 * card in about twelve milliseconds instead of the six hundred and forty a
 * round trip costs it. See docs/ON_DEVICE_MATCHING.md.
 *
 * ── Aligned to the index, not keyed by uuid ──────────────────────────────────
 * The obvious shape is a map from uuid to identity, and it is the expensive
 * one: 112,815 uuids are 4MB of the payload on their own, and the client has
 * just been handed all of them inside the index it downloaded. So this is a set
 * of parallel columns in *index row order* — `names[i]` belongs to index row
 * `i` — and the client looks up by the row its search already returned.
 *
 * That coupling is real, so it is checked rather than assumed: the payload
 * carries the row count and the client refuses to use a table whose count does
 * not match the index it loaded. The two are rebuilt by the same weekly sync,
 * and this cache is dropped when the index re-joins.
 *
 * ── What is deliberately not here ────────────────────────────────────────────
 * Image URLs. They are 32-hex Scryfall ids, and carrying them nearly triples
 * the payload — 1.25MB gzipped to 3.54MB, measured — to serve a thumbnail on
 * the review screen, which is one batch request away and not on the path that
 * needed making fast. `POST /api/scan/printings` hydrates those when a session
 * is actually reviewed.
 *
 * Prices *are* here, because the price band is the pulse colour round the
 * capture window: the fastest cue the scanner has, and useless if it arrives a
 * round trip late. They are as fresh as the last sync, which is where prices
 * come from in the first place.
 */
import { createHash } from 'crypto';
import db from '../db/connection.js';
import { printingIdsByRow } from './cardHashIndex.js';

let cached = null;

/** Drop the cache. Called when the index re-joins after a sync. */
export function invalidate() {
  cached = null;
}

/**
 * The identity table as a JSON string and its etag.
 *
 * Built once and held: it is ~5.8MB of JSON, and rebuilding it per request
 * would turn a 304 — the common case, since a client revalidates every time
 * the scanner opens — into a full table scan.
 */
export function identityPayload() {
  if (cached) return cached;

  const rows = printingIdsByRow();

  // One query for the whole table, then an indexed walk. 112,815 individual
  // lookups is the other way to write this and it is thirty seconds slower.
  const printings = db.all(`
    SELECT
      p.id,
      p.card_id,
      c.name,
      p.set_code,
      p.collector_number,
      p.is_promo,
      -- The same COALESCE the fused resolver quotes, so a locally matched card
      -- and a server-matched one never disagree about what a card is worth.
      COALESCE(
        (SELECT price FROM prices
          WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal' LIMIT 1),
        (SELECT price FROM prices
          WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'foil' LIMIT 1)
      ) AS price
    FROM printings p
    JOIN cards c ON c.id = p.card_id
  `);

  const byId = new Map(printings.map((row) => [row.id, row]));

  const count = rows.length;
  const printingIds = new Array(count);
  const cardIds = new Array(count);
  const names = new Array(count);
  const sets = new Array(count);
  const collectors = new Array(count);
  const promos = [];
  const prices = new Array(count);

  for (let row = 0; row < count; row++) {
    const printing = rows[row] >= 0 ? byId.get(rows[row]) : null;

    // A row the index holds but this database does not — the packed file is
    // built from Scryfall and outlives any one import. Nulled rather than
    // dropped, because dropping one would shift every row after it and the
    // alignment is the whole design.
    if (!printing) {
      printingIds[row] = null;
      cardIds[row] = null;
      names[row] = null;
      sets[row] = null;
      collectors[row] = null;
      prices[row] = null;
      continue;
    }

    printingIds[row] = printing.id;
    cardIds[row] = printing.card_id;
    names[row] = printing.name;
    sets[row] = printing.set_code;
    collectors[row] = printing.collector_number;
    // Promos are a few thousand rows in 112k, so a list of row numbers is far
    // smaller than a column of zeroes.
    if (printing.is_promo) promos.push(row);
    // Cents, as an integer. A float column is JSON's longest number and the
    // client divides once.
    prices[row] = printing.price == null ? null : Math.round(printing.price * 100);
  }

  const body = JSON.stringify({
    version: 1,
    count,
    printingIds,
    cardIds,
    names,
    sets,
    collectors,
    promos,
    prices,
  });

  cached = {
    body,
    etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
  };

  return cached;
}
