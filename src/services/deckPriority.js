/**
 * Whose claim on a card wins.
 *
 * A deck's status is its owner's statement about how real it is, and until
 * this existed the app ignored that: every deck's claim on a card counted the
 * same, so a list imported from EDHREC and left as an idea could report a
 * sleeved, finished deck as short of cards sitting in its own box. The deck
 * that could not be built was the import, and the app blamed the deck that
 * was already built.
 *
 * The rule: a deck's cards are contested only by decks **at least as
 * committed as it is**. Ready is contested only by Ready; Building by Ready
 * and Building; Idea by everything above it. A less committed deck never
 * takes a card away from a more committed one.
 *
 * Retired sits at the bottom, below Idea. A retired deck is out of rotation
 * and its cards read as available to everything else — the same judgement the
 * deck list already makes when it dims retired decks as not a problem to be
 * solved. It still gets a readiness verdict of its own, so "could I rebuild
 * this?" remains answerable; it simply stops making that everyone else's
 * problem.
 *
 * Equal statuses still contest each other. Two Ready decks fighting over one
 * copy is a real shortfall and the whole reason this is a priority order
 * rather than a rule exempting Ready decks outright.
 *
 * Import-free, like deckReadiness.js and shoppingMerge.js, so the SQL and the
 * arithmetic can share one definition.
 */

/** Lower is more committed. A deck missing a status reads as 'building'. */
export const DECK_PRIORITY = {
  ready: 1,
  building: 2,
  idea: 3,
  retired: 4,
};

const DEFAULT_PRIORITY = DECK_PRIORITY.building;

/** The priority of one status, for callers holding a row rather than SQL. */
export function priorityOf(status) {
  return DECK_PRIORITY[status] ?? DEFAULT_PRIORITY;
}

/**
 * The same mapping as a SQL expression over a `decks` alias.
 *
 * Written as a CASE rather than a lookup table so adding a fifth status stays
 * a change to this file and nothing else — the same reasoning that kept the
 * status vocabulary out of a CHECK constraint (see deckService.js). An
 * unrecognised or NULL status falls to the 'building' default here exactly as
 * it does in priorityOf, so the two cannot disagree.
 */
export function deckPrioritySql(alias) {
  const cases = Object.entries(DECK_PRIORITY)
    .map(([status, rank]) => `WHEN '${status}' THEN ${rank}`)
    .join(' ');

  return `(CASE ${alias}.status ${cases} ELSE ${DEFAULT_PRIORITY} END)`;
}
