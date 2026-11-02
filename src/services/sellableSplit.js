/**
 * Split a printing's free copies across the condition rows that hold them.
 *
 * Availability is counted per printing and finish, but a sale is per
 * condition. Free copies go to the best condition first: a deck plays the same
 * with a Lightly Played copy, while a buyer pays more for Near Mint. Copies
 * whose condition was never recorded come last, since nobody can list them
 * honestly until someone looks.
 *
 * Import-free on purpose, so it can be tested where the SQLite driver will not
 * build.
 */
const ORDER = ['NM', 'LP', 'MP', 'HP', 'DMG', ''];

export function splitFreeAcrossConditions(rows, free) {
  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.condition) - ORDER.indexOf(b.condition));
  let left = Math.max(0, free);

  return sorted.map((row) => {
    const sellable = Math.min(row.quantity, left);
    left -= sellable;
    return { ...row, sellable };
  });
}
