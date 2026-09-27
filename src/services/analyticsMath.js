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
