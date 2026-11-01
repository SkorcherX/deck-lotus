/**
 * Set types whose printings never stand in for "any copy of this card".
 *
 * When a list says a card rather than a printing, the cheapest printing is
 * what gets quoted and bought. Without this the cheapest Vampiric Tutor on
 * Mana Pool was a 1999 World Championship deck copy: gold-bordered, a
 * non-standard back, not tournament legal. Memorabilia covers those, the
 * Collectors' Editions and 30th Anniversary; the rest are not real cards for
 * a deck at all. Import-free so the client could use it too.
 */
export const NOT_A_STAND_IN = ['memorabilia', 'token', 'minigame', 'alchemy', 'vanguard'];
