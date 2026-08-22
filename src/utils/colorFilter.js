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
 * @param colorList  colour letters, optionally including 'C'
 * @param prefix     table alias for the columns, e.g. 'c' for `c.colors`
 * @returns {{ clause: string|null, params: string[] }}
 */
export function colorFilterSql(colorList, prefix = '') {
  const list = Array.isArray(colorList)
    ? colorList
    : String(colorList || '').split(',').filter(Boolean);

  if (list.length === 0) return { clause: null, params: [] };

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

  const carries = actual
    .map(() => `(${col('colors')} LIKE ? OR (${LAND} AND ${col('color_identity')} LIKE ?))`)
    .join(' AND ');
  const params = actual.flatMap((c) => [`%${c}%`, `%${c}%`]);

  return wantsColorless
    ? { clause: `((${carries}) OR ${COLORLESS})`, params }
    : { clause: carries, params };
}
