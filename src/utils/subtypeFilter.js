/**
 * The SQL for "show me cards of this creature type" (or any subtype —
 * Equipment, Aura, Island all live in the same column).
 *
 * `cards.subtypes` is MTGJSON's list joined with commas. A plain
 * `LIKE '%Ape%'` matches Shapeshifter and `'%Elf%'` would pick up any
 * longer type containing it. So the column is wrapped in commas and each term has to match a whole entry.
 * Spaces after the commas are stripped first so either storage shape works.
 *
 * Several terms must all match — "Elf" + "Warrior" is Elf Warriors, the same
 * narrowing the name chips do. Case-insensitive, as SQLite's LIKE is for ASCII.
 *
 * @param subtypeList  subtype names
 * @param prefix       table alias for the column, e.g. 'c' for `c.subtypes`
 * @returns {{ clause: string|null, params: string[] }}
 */
export function subtypeFilterSql(subtypeList, prefix = '') {
  const list = (Array.isArray(subtypeList) ? subtypeList : String(subtypeList || '').split(','))
    .map((term) => String(term).trim())
    // A comma or wildcard inside a term would break the whole-entry match.
    .map((term) => term.replace(/[,%_]/g, ''))
    .filter(Boolean);

  if (list.length === 0) return { clause: null, params: [] };

  const col = prefix ? `${prefix}.subtypes` : 'subtypes';
  const wrapped = `(',' || REPLACE(COALESCE(${col}, ''), ', ', ',') || ',')`;

  return {
    clause: `(${list.map(() => `${wrapped} LIKE ?`).join(' AND ')})`,
    params: list.map((term) => `%,${term},%`)
  };
}
