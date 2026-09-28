/**
 * Card condition, on TCGplayer's scale.
 *
 * Condition is optional. `''` means "not recorded", which is what every copy
 * held before conditions existed and what any caller that does not mention
 * one still writes — so nothing that worked without conditions changes. A
 * recorded condition is part of an owned row's identity, the same way finish
 * is: two Near Mint and one Lightly Played copy of one printing are two rows.
 *
 * Import-free on purpose, so the client and the tests can share it.
 */
export const CONDITIONS = [
  { code: 'NM', label: 'Near Mint' },
  { code: 'LP', label: 'Lightly Played' },
  { code: 'MP', label: 'Moderately Played' },
  { code: 'HP', label: 'Heavily Played' },
  { code: 'DMG', label: 'Damaged' },
];

export const UNSPECIFIED = '';

const ALIASES = new Map([
  ['nm', 'NM'], ['near mint', 'NM'], ['mint', 'NM'], ['m', 'NM'],
  ['lp', 'LP'], ['lightly played', 'LP'], ['light play', 'LP'], ['sp', 'LP'], ['slightly played', 'LP'], ['excellent', 'LP'], ['ex', 'LP'],
  ['mp', 'MP'], ['moderately played', 'MP'], ['moderate play', 'MP'], ['played', 'MP'], ['pl', 'MP'],
  ['hp', 'HP'], ['heavily played', 'HP'], ['heavy play', 'HP'], ['poor', 'HP'],
  ['dmg', 'DMG'], ['d', 'DMG'], ['damaged', 'DMG'],
]);

/**
 * Turn anything a person or an export might say into a code, or `''`.
 * Throws on text it does not recognise when `strict`, so an API caller
 * learns about a typo rather than silently storing "not recorded".
 */
export function normalizeCondition(value, { strict = false } = {}) {
  if (value === undefined || value === null) return UNSPECIFIED;
  const text = String(value).trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!text || text === 'unspecified' || text === 'unknown' || text === 'none') return UNSPECIFIED;
  const code = ALIASES.get(text);
  if (code) return code;
  if (strict) throw new Error(`Unknown card condition "${value}" — use NM, LP, MP, HP or DMG`);
  return UNSPECIFIED;
}

export function conditionLabel(code) {
  return CONDITIONS.find((c) => c.code === code)?.label || '';
}

/**
 * The order copies are taken from when a removal does not say which: copies
 * with no recorded condition first (they are what every condition-unaware path
 * wrote), then worst to best, so the copies someone bothered to grade Near
 * Mint are the last to go.
 */
export const REMOVAL_ORDER = [UNSPECIFIED, 'DMG', 'HP', 'MP', 'LP', 'NM'];
