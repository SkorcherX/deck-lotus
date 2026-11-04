/**
 * The conditions a price watch accepts, stored in `price_watches.condition` as
 * a comma-separated list ("nm,lp").
 *
 * Mana Pool's /prices/singles feed publishes three prices per printing: Near
 * Mint, LP or better, and overall cheapest. Those are the only sets a watch can
 * price honestly, so any other combination is refused rather than quoted from
 * a price that may be for a copy the user did not tick.
 *
 * Import-free on purpose, so the client and the tests can share it.
 */
export const WATCH_CONDITIONS = [
  { code: 'nm', label: 'NM' },
  { code: 'lp', label: 'LP' },
  { code: 'mp', label: 'MP' },
  { code: 'hp', label: 'HP' },
  { code: 'dm', label: 'DMG' },
];

const ALL_CODES = WATCH_CONDITIONS.map((c) => c.code);

// Single values from before watches took a list. mp and hp were always priced
// as LP or better, so that is what they stay; dm "or better" is everything.
const LEGACY = {
  any: ALL_CODES,
  nm: ['nm'],
  lp: ['nm', 'lp'],
  mp: ['nm', 'lp'],
  hp: ['nm', 'lp'],
  dm: ALL_CODES,
};

/** The codes in a stored value or a request's list, in best-to-worst order. */
export function parseWatchConditions(value) {
  if (typeof value === 'string' && LEGACY[value]) return LEGACY[value];
  const given = Array.isArray(value) ? value : String(value ?? '').split(',');
  return ALL_CODES.filter((code) => given.includes(code));
}

/** The feed price answering these codes: 'nm', 'lp', 'any', or null if none does. */
export function priceTier(codes) {
  const key = ALL_CODES.filter((code) => codes.includes(code)).join(',');
  if (key === 'nm') return 'nm';
  if (key === 'nm,lp') return 'lp';
  if (key === ALL_CODES.join(',')) return 'any';
  return null;
}

/** "NM, LP" for display, or "Any" when every condition is accepted. */
export function formatWatchConditions(value) {
  const codes = parseWatchConditions(value);
  if (codes.length === ALL_CODES.length) return 'Any';
  return WATCH_CONDITIONS.filter((c) => codes.includes(c.code)).map((c) => c.label).join(', ');
}
