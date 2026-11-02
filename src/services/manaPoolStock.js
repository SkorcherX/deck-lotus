/**
 * What Mana Pool actually has in stock, per printing.
 *
 * Mana Pool's optimizer needs a printing for every line (a bare name is
 * rejected), and a printing nobody on Mana Pool is selling comes back as "no
 * seller" — even when a dozen other printings of the same card are listed.
 * That is how Vampiric Tutor read as unavailable while Mana Pool had fifteen
 * printings of it in stock: the list asked for the one printing they lacked.
 *
 * Their public `/prices/singles` feed lists every in-stock printing with its
 * set, number, quantity and price. It needs no credentials and is ~50 MB, so
 * it is fetched at most every few hours and reduced to what the optimizer
 * needs. Non-foil only, matching the `NF` finish the optimizer is sent.
 */

const FEED_URL = process.env.MANAPOOL_SINGLES_URL || 'https://manapool.com/api/v1/prices/singles';
const TTL_MS = 6 * 60 * 60 * 1000;

let cache = null; // { at, byName: Map<lowerName, Row[]> }
let loading = null;

const key = (name) => String(name || '').trim().toLowerCase();

/** Rows sorted cheapest first: { setCode, number, price, available, url }. */
export function indexSingles(rows) {
  const byName = new Map();
  for (const r of rows || []) {
    if (!r?.name || !(r.available_quantity > 0) || !(r.price_cents > 0)) continue;
    const row = {
      setCode: r.set_code,
      number: r.number,
      price: r.price_cents / 100,
      available: r.available_quantity,
      url: r.url || null,
    };
    for (const name of new Set([key(r.name), key(r.name.split('//')[0])])) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(row);
    }
  }
  for (const list of byName.values()) list.sort((a, b) => a.price - b.price);
  return byName;
}

export async function getManaPoolStock({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.byName;
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch(FEED_URL, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Mana Pool price feed returned ${res.status}`);
      const body = await res.json();
      cache = { at: Date.now(), byName: indexSingles(Array.isArray(body) ? body : body.data) };
      return cache.byName;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** The stock already held, without fetching. */
export function cachedManaPoolStock() {
  return cache?.byName || null;
}

/**
 * Turn list lines into optimizer lines on printings Mana Pool stocks.
 *
 * A line asking for a specific printing (`exactPrinting`, the user picked
 * it) is left alone. Every other line is spread over that card's in-stock
 * printings, cheapest first, as far as their quantities go — four copies of
 * a card stocked at 2 + 5 become two lines. Copies no printing can cover are
 * returned in `unavailable` rather than sent, so the optimizer is never asked
 * for something that cannot exist.
 */
export function expandToStock(items, byName, { excludedSets = new Set() } = {}) {
  const lines = [];
  const unavailable = [];
  for (const item of items) {
    if (item.exactPrinting || item.foil) {
      lines.push(item);
      continue;
    }
    const stock = (byName.get(key(item.name)) || byName.get(key(String(item.name).split('//')[0])) || [])
      .filter((row) => !excludedSets.has(String(row.setCode).toUpperCase()));
    let left = item.quantity ?? 1;
    for (const row of stock) {
      if (left <= 0) break;
      const quantity = Math.min(left, row.available);
      lines.push({ ...item, setCode: row.setCode, collectorNumber: row.number, quantity });
      left -= quantity;
    }
    if (left > 0) unavailable.push({ name: item.name, quantity: left });
  }
  return { lines, unavailable };
}

/** "2 Vampiric Tutor (CMR) 156" lines, for pasting into Mana Pool's Mass Entry. */
export function massEntryText(lines) {
  return lines
    .map((l) => `${l.quantity ?? 1} ${l.name}${l.setCode ? ` (${String(l.setCode).toUpperCase()}) ${l.collectorNumber ?? ''}`.trimEnd() : ''}`)
    .join('\n');
}
