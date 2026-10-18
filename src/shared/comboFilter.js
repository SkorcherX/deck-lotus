/**
 * Which of a deck's Commander Spellbook combos count for brackets.
 *
 * Spellbook's find-my-combos returns every combo the list contains, and most
 * do not matter here: plenty loop forever to no effect, and many need a third
 * piece described as a template ("a sacrifice outlet"). Brackets care about
 * two-card combos with a game-defining result, so this keeps only those:
 *
 *  - exactly two named cards and no template requirements;
 *  - producing a win or loss, or infinite mana, life, cards, tokens, damage
 *    or life loss. "Near-infinite" counts — it ends games the same way.
 *
 * Total mana is what the write-up calls the cost of the combo, activations
 * included. Spellbook's `manaValueNeeded` covers pieces cast from hand and
 * activations, but not pieces that start on the battlefield, so their mana
 * value is added from our own card data. Late game is 8 or more
 * (LATE_COMBO_MANA in commanderBrackets.js).
 *
 * Import-free, like commanderBrackets.js, so it tests without SQLite.
 */

const GAME_DEFINING = [
  /\bwin the game\b/i,
  /\bloses? the game\b/i,
  /\binfinite\b.*\bmana\b/i,
  /\binfinite (?:life ?gain|lifegain)$/i,
  /\binfinite (?:card )?draw\b/i,
  /\binfinite\b.*\btokens?\b/i,
  /\binfinite\b.*\bdamage\b/i,
  /\binfinite (?:life ?loss|lifeloss)\b/i,
];

export function isGameDefining(featureName) {
  return GAME_DEFINING.some((re) => re.test(String(featureName || '')));
}

/**
 * @param variants  `results.included` from find-my-combos
 * @param cmcByName Map of card name → mana value, for battlefield pieces
 * @returns [{ id, cards: [a, b], produces: [..], totalMana, bracketTag }]
 */
export function selectBracketCombos(variants, cmcByName = new Map()) {
  const out = [];
  for (const v of variants || []) {
    const uses = v.uses || [];
    if (uses.length !== 2) continue;
    if ((v.requires || []).length) continue;

    const produces = (v.produces || []).map((p) => p.feature?.name).filter(Boolean);
    const decisive = produces.filter(isGameDefining);
    if (!decisive.length) continue;

    const startsInPlay = uses
      .filter((u) => (u.zoneLocations || []).every((z) => z === 'B'))
      .reduce((sum, u) => sum + (Number(cmcByName.get(u.card?.name)) || 0), 0);

    out.push({
      id: v.id,
      cards: uses.map((u) => u.card?.name).sort(),
      produces: decisive,
      totalMana: (Number(v.manaValueNeeded) || 0) + startsInPlay,
      bracketTag: v.bracketTag || null,
    });
  }
  return out.sort((a, b) => a.totalMana - b.totalMana);
}
