/**
 * Shaping for the analytics page, kept free of imports for the same reason as
 * shoppingMerge.js: it can be tested where the SQLite driver will not build.
 * The SQL in analyticsService.js groups; this decides what the groups mean.
 */

/** Color buckets, in the order the chart draws them. */
export const COLOR_CATEGORIES = [
  { key: 'W', label: 'White' },
  { key: 'U', label: 'Blue' },
  { key: 'B', label: 'Black' },
  { key: 'R', label: 'Red' },
  { key: 'G', label: 'Green' },
  { key: 'multi', label: 'Multicolor' },
  { key: 'colorless', label: 'Colorless' },
  { key: 'nonbasic_land', label: 'Nonbasic lands' },
  { key: 'basic_land', label: 'Basic lands' },
];

/**
 * Which bucket a card belongs in.
 *
 * Lands are tested first: a land's `colors` is empty, so without that it would
 * be counted as colorless, and the basic/nonbasic split is the one people ask
 * about. Basic-ness is decided by the caller with isBasicLand, so the rule
 * stays in basicLands.js.
 *
 * `colors` is the comma-joined string the MTGJSON import writes ("W,U").
 */
export function colorCategory({ colors, typeLine, isBasic }) {
  if (isBasic) return 'basic_land';
  if (/\bLand\b/.test(typeLine || '') && !/\bCreature\b/.test(typeLine || '')) {
    return 'nonbasic_land';
  }
  const list = String(colors || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (list.length === 0) return 'colorless';
  if (list.length > 1) return 'multi';
  return list[0];
}

/**
 * Sum per-card rows into COLOR_CATEGORIES order. Every category is present,
 * zero or not, so the chart's colors never shift between collections.
 */
export function summariseColors(rows) {
  const totals = new Map(COLOR_CATEGORIES.map((c) => [c.key, { copies: 0, value: 0 }]));
  for (const row of rows) {
    const bucket = totals.get(colorCategory(row));
    if (!bucket) continue;
    bucket.copies += row.copies || 0;
    bucket.value += row.value || 0;
  }
  return COLOR_CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    copies: totals.get(c.key).copies,
    value: round2(totals.get(c.key).value),
  }));
}

/**
 * Turn sparse `{ month: 'YYYY-MM', added, removed }` rows into a continuous
 * run of months, oldest first. A month with no activity is a real zero on a
 * timeline — leaving it out would draw March next to June as if adjacent.
 *
 * `through` is the last month to include (normally the current one), so the
 * chart runs up to today even after a quiet spell.
 */
export function fillMonths(rows, through) {
  if (!rows.length) return [];
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const sorted = [...byMonth.keys()].sort();
  const last = through && through > sorted[sorted.length - 1] ? through : sorted[sorted.length - 1];

  const out = [];
  let [y, m] = sorted[0].split('-').map(Number);
  for (let guard = 0; guard < 1200; guard++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const row = byMonth.get(key);
    out.push({ month: key, added: row?.added || 0, removed: row?.removed || 0 });
    if (key === last) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Keep the top `n` items by `field` and fold the rest into one "Other" entry,
 * so a chart of 80 sets stays readable. Fields listed in `sumFields` are
 * summed into Other.
 */
export function foldTopN(items, n, field, sumFields = [field]) {
  const sorted = [...items].sort((a, b) => (b[field] || 0) - (a[field] || 0));
  if (sorted.length <= n) return sorted;
  const top = sorted.slice(0, n);
  const rest = sorted.slice(n);
  const other = { code: null, name: `Other (${rest.length} sets)`, isOther: true };
  for (const f of sumFields) {
    other[f] = round2(rest.reduce((s, r) => s + (r[f] || 0), 0));
  }
  return [...top, other];
}

export function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

/**
 * Card-type buckets, in the deck builder's order (deckBuilder.js groups by
 * type the same way), so a card is filed under the same heading on both
 * pages. First match wins: an Artifact Creature is a Creature.
 */
export const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Land'];

export function primaryType(typeLine) {
  const line = typeLine || '';
  return TYPE_ORDER.find((t) => line.includes(t)) || 'Other';
}

/** Rarity buckets. MTGJSON's 'special' and 'bonus' are few enough to share one. */
export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'mythic', 'special'];

export function rarityBucket(rarity) {
  const r = String(rarity || '').toLowerCase();
  return RARITY_ORDER.includes(r) ? r : 'special';
}

/** Mana value buckets 0–6 and 7+. Lands are left out by the caller. */
export const CURVE_BUCKETS = ['0', '1', '2', '3', '4', '5', '6', '7+'];

export function curveBucket(cmc) {
  const n = Math.max(0, Math.floor(Number(cmc) || 0));
  return n >= 7 ? '7+' : String(n);
}

/**
 * Fold per-card rows ({ typeLine, rarity, cmc, copies, value }) into the three
 * composition breakdowns. Every bucket is present, zero or not, so bars keep
 * their positions between collections.
 */
export function summariseComposition(rows) {
  const init = (keys) => new Map(keys.map((k) => [k, { copies: 0, value: 0 }]));
  const types = init([...TYPE_ORDER, 'Other']);
  const rarities = init(RARITY_ORDER);
  const curve = init(CURVE_BUCKETS);

  for (const row of rows) {
    const add = (map, key) => {
      const b = map.get(key);
      b.copies += row.copies || 0;
      b.value += row.value || 0;
    };
    const type = primaryType(row.typeLine);
    add(types, type);
    add(rarities, rarityBucket(row.rarity));
    // A land has no place on a curve: it is the thing the curve is paid with.
    if (type !== 'Land') add(curve, curveBucket(row.cmc));
  }

  const out = (map) => [...map].map(([key, b]) => ({ key, copies: b.copies, value: round2(b.value) }));
  return { types: out(types), rarities: out(rarities), curve: out(curve) };
}

/**
 * Split each card's owned copies into in decks / lent out / idle, and total
 * them. Rows are per card: { name, owned, inDecks, lent, value, isBasic },
 * where `value` is what all owned copies are worth together.
 *
 * The split follows the Inventory page's `available` (owned − in decks − lent
 * out), so the two pages agree. A card listed by more decks than there are
 * copies is simply fully in decks — the shortfall is the shopping list's
 * business, not this page's. Basic lands are left out altogether: nobody
 * tracks them, and 60 idle Islands would otherwise read as dead weight.
 *
 * `spare` is idle copies beyond a playset of four, the usual trade fodder.
 */
export function summariseDeckUse(rows, { playset = 4, topIdle = 10 } = {}) {
  const totals = {
    copies: 0, inDecks: 0, lent: 0, idle: 0, spare: 0,
    value: 0, inDecksValue: 0, lentValue: 0, idleValue: 0, spareValue: 0,
    cardsInNoDeck: 0,
  };
  const idleCards = [];

  for (const row of rows) {
    if (row.isBasic || !row.owned) continue;
    const perCopy = (row.value || 0) / row.owned;
    const inDecks = Math.min(row.owned, row.inDecks || 0);
    const lent = Math.min(row.owned - inDecks, row.lent || 0);
    const idle = row.owned - inDecks - lent;
    const spare = Math.max(0, idle - Math.max(0, playset - inDecks - lent));

    totals.copies += row.owned;
    totals.inDecks += inDecks;
    totals.lent += lent;
    totals.idle += idle;
    totals.spare += spare;
    totals.value += row.value || 0;
    totals.inDecksValue += inDecks * perCopy;
    totals.lentValue += lent * perCopy;
    totals.idleValue += idle * perCopy;
    totals.spareValue += spare * perCopy;
    if (!row.inDecks) totals.cardsInNoDeck++;

    if (idle > 0 && perCopy > 0) {
      idleCards.push({ name: row.name, idle, perCopy: round2(perCopy), total: round2(idle * perCopy) });
    }
  }

  for (const k of ['value', 'inDecksValue', 'lentValue', 'idleValue', 'spareValue']) {
    totals[k] = round2(totals[k]);
  }
  idleCards.sort((a, b) => b.total - a.total);
  return { ...totals, topIdle: idleCards.slice(0, topIdle) };
}

/**
 * Rank price moves on held cards. Rows: { name, setCode, collectorNumber,
 * isFoil, quantity, then, now }, one per printing and finish.
 *
 * Ranked by what the move did to the collection (change per copy × copies
 * held), not by percent: a penny card doubling is +100% and means nothing,
 * while a $40 card slipping 10% is the thing worth knowing. Moves under
 * `minChange` per copy are dropped as noise.
 */
export function rankMovers(rows, { limit = 10, minChange = 0.05 } = {}) {
  const moves = rows
    .filter((r) => r.then != null && r.now != null && Math.abs(r.now - r.then) >= minChange)
    .map((r) => ({
      name: r.name,
      setCode: r.setCode,
      collectorNumber: r.collectorNumber,
      isFoil: !!r.isFoil,
      quantity: r.quantity,
      then: round2(r.then),
      now: round2(r.now),
      change: round2(r.now - r.then),
      percent: r.then > 0 ? round2(((r.now - r.then) / r.then) * 100) : null,
      totalChange: round2((r.now - r.then) * r.quantity),
    }));

  return {
    gainers: moves.filter((m) => m.totalChange > 0).sort((a, b) => b.totalChange - a.totalChange).slice(0, limit),
    losers: moves.filter((m) => m.totalChange < 0).sort((a, b) => a.totalChange - b.totalChange).slice(0, limit),
    netChange: round2(moves.reduce((s, m) => s + m.totalChange, 0)),
  };
}
