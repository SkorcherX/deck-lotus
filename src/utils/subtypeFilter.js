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
 * Changelings count as every creature type, but MTGJSON lists only
 * Shapeshifter on them, so a card with the Changeling keyword matches too —
 * for creature types only. Whether a term is a creature type is asked of the
 * data: a creature carries it and nothing else does, apart from Kindred
 * cards. "A creature carries it" alone is not enough — there are Equipment
 * creatures and Forest creatures — and without the check, searching
 * Equipment would fill up with Shapeshifters. The subquery does not depend on the
 * outer row, so SQLite runs it once per term.
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

  const col = (name) => (prefix ? `${prefix}.${name}` : name);
  const wrap = (expr) => `(',' || REPLACE(COALESCE(${expr}, ''), ', ', ',') || ',')`;

  const one = `(${wrap(col('subtypes'))} LIKE ?
    OR (${wrap(col('keywords'))} LIKE '%,Changeling,%'
        AND EXISTS (SELECT 1 FROM cards ct
                     WHERE ct.type_line LIKE '%Creature%'
                       AND ${wrap('ct.subtypes')} LIKE ?)
        AND NOT EXISTS (SELECT 1 FROM cards cn
                         WHERE cn.type_line NOT LIKE '%Creature%'
                           AND cn.type_line NOT LIKE '%Kindred%'
                           AND cn.type_line NOT LIKE '%Tribal%'
                           -- Un-set jokes typed "Summon — Specter"
                           AND cn.type_line NOT LIKE 'Summon%'
                           AND ${wrap('cn.subtypes')} LIKE ?)))`;

  return {
    clause: `(${list.map(() => one).join(' AND ')})`,
    params: list.flatMap((term) => Array(3).fill(`%,${term},%`))
  };
}
