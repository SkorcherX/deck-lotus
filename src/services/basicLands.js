/**
 * Basic lands are not inventory anybody tracks.
 *
 * Nobody counts how many Islands they own, every shop hands them out of a
 * shoebox, and a Commander deck asking for 24 of them is not "short 24". So
 * they are exempt from availability accounting, from readiness, and from the
 * shopping list — a deck that only lacks basics is finished.
 *
 * Deliberately *basic* lands, not lands: a Verdant Catacombs is a card you
 * have to own or buy like any other, and dropping every land off the buy list
 * would quietly hide the most expensive things on it.
 *
 * The predicate lived in three copies (inventoryService, tradeService, and
 * then readiness and shopping) before it lived here. Three copies of a rule
 * this load-bearing drifting apart means two pages disagreeing about whether
 * a deck is finished.
 *
 * `alias` is the `cards` alias in the query being written; the columns are
 * `supertypes` (a comma-joined string, see scripts/import-mtgjson.js) and
 * `type_line`. The second arm catches rows imported before supertypes was
 * populated, where the type line is all there is.
 */
export const isBasicLandSql = (alias = 'c') => `(
  (${alias}.supertypes IS NOT NULL AND ${alias}.supertypes LIKE '%Basic%' AND ${alias}.type_line LIKE '%Land%')
  OR ${alias}.type_line LIKE 'Basic %Land%'
)`;

/** The same rule against a row already in hand. */
export function isBasicLand(card) {
  if (!card) return false;
  const supertypes = card.supertypes || '';
  const typeLine = card.type_line || card.typeLine || '';
  return (
    (supertypes.includes('Basic') && typeLine.includes('Land')) ||
    /^Basic .*Land/.test(typeLine)
  );
}
