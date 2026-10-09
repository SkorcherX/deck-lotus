/**
 * The SQL for "show me cards of this colour".
 *
 * This lives in one place because it was previously written twice and the two
 * copies disagreed. A land counts as the colours it *produces*, not the colours
 * it *is*: a Forest's `colors` is empty, and only its `color_identity` says
 * green. The deck builder's panel knew that; the inventory page did not, so
 * filtering it to Land plus green returned nothing at all.
 *
 * Picking two colours means cards carrying both. 'C' means colourless, and a
 * land that taps for a colour is deliberately not colourless even though its
 * `colors` column is empty.
 *
 * `mode` says how the picked colours relate to the card's:
 *   - 'includes' (default): the card carries every picked colour, and may
 *     carry others — Black finds Dimir cards too.
 *   - 'exactly': the card carries the picked colours and no others — Black
 *     is mono-black. Adding 'C' also lets colourless cards through.
 *   - 'atmost': the card carries no colour outside the picks — what a deck of
 *     those colours can cast, so colourless cards always pass. Black is
 *     mono-black plus artifacts; Black + Blue adds mono-blue and Dimir.
 * The same land rule applies in every mode: a Watery Grave is Dimir.
 *
 * @param colorList  colour letters, optionally including 'C'
 * @param prefix     table alias for the columns, e.g. 'c' for `c.colors`
 * @param mode       'includes' | 'exactly' | 'atmost'
 * @returns {{ clause: string|null, params: string[] }}
 */
export const COLOR_MODES = ['includes', 'exactly', 'atmost'];

export function colorFilterSql(colorList, prefix = '', mode = 'includes') {
  const list = Array.isArray(colorList)
    ? colorList
    : String(colorList || '').split(',').filter(Boolean);

  if (list.length === 0) return { clause: null, params: [] };
  if (!COLOR_MODES.includes(mode)) mode = 'includes';

  const col = (name) => (prefix ? `${prefix}.${name}` : name);
  const LAND = `${col('type_line')} LIKE '%Land%'`;

  const COLORLESS = `(
      (${col('colors')} IS NULL OR ${col('colors')} = '' OR ${col('colors')} = '[]')
      AND NOT (${LAND} AND ${col('color_identity')} IS NOT NULL AND ${col('color_identity')} <> '')
    )`;

  const wantsColorless = list.includes('C');
  const actual = list.filter((c) => c !== 'C');

  if (wantsColorless && actual.length === 0) {
    return { clause: COLORLESS, params: [] };
  }

  // COALESCE so a NULL column reads as "no colour" — NOT (NULL LIKE ?) is
  // NULL, which would quietly drop every colourless card from "at most".
  const has = `(COALESCE(${col('colors')}, '') LIKE ? OR (${LAND} AND COALESCE(${col('color_identity')}, '') LIKE ?))`;
  const hasParams = (c) => [`%${c}%`, `%${c}%`];
  const others = ['W', 'U', 'B', 'R', 'G'].filter((c) => !actual.includes(c));

  const parts = [];
  const params = [];
  if (mode !== 'atmost') {
    for (const c of actual) { parts.push(has); params.push(...hasParams(c)); }
  }
  if (mode !== 'includes') {
    for (const c of others) { parts.push(`NOT ${has}`); params.push(...hasParams(c)); }
  }
  const carries = parts.length ? `(${parts.join(' AND ')})` : '1';

  // 'atmost' already lets colourless through; the others add it on request.
  return wantsColorless && mode !== 'atmost'
    ? { clause: `(${carries} OR ${COLORLESS})`, params }
    : { clause: carries, params };
}
