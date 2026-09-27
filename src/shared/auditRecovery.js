/**
 * Turning audit rows back into a card list, for putting removed cards back.
 *
 * Lives in `src/shared` beside `cardLines.js`, whose parser is what reads the
 * output, and like it takes no imports: the round trip — remove, pick the
 * rows, paste into Bulk Add, land on the same printings and finishes — is
 * tested from Node in `test/integration/removeAndRecover.test.js`.
 */

/**
 * Whether an entry can go back in through Bulk Add.
 *
 * Only copies that left the collection, and not by trade: a traded card now
 * sits in the partner's collection, and re-adding it here would count it
 * twice — the thing `acceptTrade` exists to prevent. It also needs something
 * a Bulk Add line can resolve, a name or a set and collector number.
 */
export function isRecoverable(entry) {
  return entry.entity_type === 'inventory'
    && entry.quantity_delta < 0
    && entry.source !== 'trade'
    && !!(entry.card_name || (entry.set_code && entry.collector_number));
}

/**
 * The ticked removals as a Moxfield list, the format Bulk Add reads.
 *
 * Summed per printing and finish, so a card removed in two steps comes back
 * as one line with both counts. Set and collector number are always written
 * when known: "4 Lightning Bolt" alone would land on whatever printing the
 * add path guesses, and the point is to restore the rows that were there.
 */
export function buildImportList(entries) {
  const lines = new Map();

  for (const entry of entries) {
    const quantity = -entry.quantity_delta;
    if (!(quantity > 0)) continue;

    const key = [entry.card_name || '', entry.set_code || '',
      entry.collector_number || '', entry.is_foil ? 1 : 0].join('|');
    const line = lines.get(key);

    if (line) {
      line.quantity += quantity;
    } else {
      lines.set(key, { ...entry, quantity });
    }
  }

  return [...lines.values()]
    .sort((a, b) => (a.card_name || '').localeCompare(b.card_name || '')
      || (a.is_foil ? 1 : 0) - (b.is_foil ? 1 : 0))
    .map((line) => {
      const foil = line.is_foil ? ' *F*' : '';

      if (!line.card_name) {
        return `${line.quantity} ${line.set_code} ${line.collector_number}${foil}`;
      }

      const set = line.set_code ? ` (${line.set_code})` : '';
      const number = line.set_code && line.collector_number ? ` ${line.collector_number}` : '';
      return `${line.quantity} ${line.card_name}${set}${number}${foil}`;
    })
    .join('\n');
}
