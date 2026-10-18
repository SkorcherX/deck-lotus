/**
 * A data-driven power score for a Commander deck, after Red String's method.
 *
 * Each card gets an Impact of 0–20: a Price rating (lowest USD price, capped
 * at $100, on a curve that spreads out the cheap end) plus a Popularity
 * rating (EDHREC rank, on a curve that spreads out the top ranks). The deck's
 * total Impact is scaled by Efficiency — how cheaply that Impact can be cast —
 * into a Score, and a final curve maps Score onto a familiar 1–10.
 *
 * The three curves are read off Red String's published charts. Efficiency
 * and how it scales Impact are not published; the constants for those are
 * ours, tuned against the stored precons and reference cEDH lists (see
 * scripts/power-score-report.mjs). They are what to adjust, not the curves.
 *
 * What it cannot see, by construction: synergy, combos, interaction balance.
 * A deck of 99 tutors scores high and plays badly. It compares real decks;
 * it does not judge construction.
 *
 * Import-free, like commanderBrackets.js.
 */

/** Piecewise-linear lookup over [x, y] points sorted by x. */
function interpolate(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

/** Lowest USD price → 0–10. */
export const PRICE_CURVE = [
  [0, 0], [0.8, 1], [1.8, 2], [3.5, 3], [6, 4], [10, 5],
  [15, 6], [25, 7], [40, 8], [65, 9], [100, 10],
];

/** EDHREC rank → 0–10, as [rank, rating] with rank ascending. */
export const POPULARITY_CURVE = [
  [1, 10], [300, 9], [800, 8], [1700, 7], [3300, 6], [5100, 5],
  [7300, 4], [10000, 3], [13500, 2], [18500, 1], [27000, 0],
];

/** Score → power level. */
export const POWER_CURVE = [
  [0, 0], [250, 1], [320, 2], [350, 3], [380, 4], [420, 5],
  [470, 6], [560, 7], [760, 8], [890, 9], [1000, 10],
];

/** Share of non-land Impact that defines the tipping point. */
export const TIPPING_SHARE = 0.65;

/**
 * Our constants (unpublished in the original). Efficiency is 10 at or below
 * the "ideal" curve and loses points per mana above it; Score multiplies
 * Impact by BASE + PER_EFFICIENCY × Efficiency.
 */
export const EFFICIENCY = {
  idealAvgCmc: 1.5,
  perAvgCmc: 2,
  idealTipping: 2,
  perTipping: 1,
};
export const SCORE_SCALE = { base: 0.6, perEfficiency: 0.02 };

/**
 * Power level → the bracket it suggests, highest threshold first. Below the
 * last one the score suggests nothing: it never pulls a deck *down*, and
 * telling 1 from 2 is about intent. Calibrated on the stored precons — a
 * modern precon (median 5–6) is bracket 2, as Wizards place them; the
 * strongest (6.5–7.2) reach 3; the reference cEDH list is 10.
 */
export const BRACKET_FROM_POWER = [[9.5, 5], [8, 4], [6.5, 3]];

export function bracketFromPower(power) {
  const hit = BRACKET_FROM_POWER.find(([min]) => power >= min);
  return hit ? hit[1] : null;
}

export function priceRating(price) {
  if (price == null || !(price >= 0)) return 0;
  return interpolate(PRICE_CURVE, Math.min(price, 100));
}

export function popularityRating(rank) {
  if (!(rank >= 1)) return 0;
  return interpolate(POPULARITY_CURVE, rank);
}

export function cardImpact(card) {
  return priceRating(card.price) + popularityRating(card.edhrecRank);
}

export function powerLevel(score) {
  return interpolate(POWER_CURVE, Math.max(0, score));
}

/**
 * @param cards [{ name, cmc, isLand, isBasicLand, price, edhrecRank, quantity }]
 *              one row per card name; basics are ignored entirely
 */
export function scoreDeck(cards) {
  const rows = (cards || [])
    .filter((c) => !c.isBasicLand)
    .map((c) => ({ ...c, impact: cardImpact(c), quantity: c.quantity || 1 }));

  const impact = rows.reduce((s, c) => s + c.impact * c.quantity, 0);
  const spells = rows.filter((c) => !c.isLand);
  const spellCount = spells.reduce((s, c) => s + c.quantity, 0);
  const spellImpact = spells.reduce((s, c) => s + c.impact * c.quantity, 0);

  const avgCmc = spellCount
    ? spells.reduce((s, c) => s + (Number(c.cmc) || 0) * c.quantity, 0) / spellCount
    : 0;

  // The least mana at which cards costing that much or less hold more than
  // TIPPING_SHARE of the non-land Impact.
  let tippingPoint = 0;
  if (spellImpact > 0) {
    const maxCmc = Math.max(...spells.map((c) => Math.ceil(Number(c.cmc) || 0)));
    for (let m = 0; m <= maxCmc; m++) {
      const upTo = spells
        .filter((c) => (Number(c.cmc) || 0) <= m)
        .reduce((s, c) => s + c.impact * c.quantity, 0);
      if (upTo > spellImpact * TIPPING_SHARE) { tippingPoint = m; break; }
    }
  }

  const e = EFFICIENCY;
  const efficiency = Math.min(10, Math.max(1,
    10 - e.perAvgCmc * Math.max(0, avgCmc - e.idealAvgCmc)
       - e.perTipping * Math.max(0, tippingPoint - e.idealTipping)
  ));

  const score = impact * (SCORE_SCALE.base + SCORE_SCALE.perEfficiency * efficiency);

  return {
    impact,
    avgCmc,
    tippingPoint,
    efficiency,
    score,
    powerLevel: powerLevel(score),
    // Highest Impact first: what is carrying the number.
    cards: rows.map(({ name, impact: i, price, edhrecRank }) => ({ name, impact: i, price, edhrecRank }))
      .sort((a, b) => b.impact - a.impact),
  };
}
