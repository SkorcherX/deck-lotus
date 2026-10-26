/**
 * Cards that can lead a Commander deck: legendary creatures, plus anything
 * whose Oracle text says it can be your commander (some planeswalkers,
 * backgrounds' partners). Shared by Inventory and Browse Cards so the two
 * "Commander Eligible" filters cannot disagree. Expects `c` (cards) in scope.
 */
export const COMMANDER_ELIGIBLE_SQL = `(
  (c.type_line LIKE '%Legendary%' AND c.type_line LIKE '%Creature%')
  OR c.oracle_text LIKE '%can be your commander%'
)`;
