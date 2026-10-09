/**
 * Pair a revision's cuts with its additions, so each change reads as a swap
 * with a reason rather than as two unrelated lists.
 *
 * A diff of "add 9, cut 9" answers what changes but not why, and the why is
 * what somebody needs to decide whether to agree. Most changes in a revision
 * are one card doing a job another card was doing worse — removal for
 * removal, a theme card for a card that fits nothing — so they are paired by
 * the job: the role predicates the generator filled its quotas with, then the
 * card type, then cost. Lands only ever pair with lands; a land cut for a
 * spell is not a swap anybody would make on purpose.
 *
 * Pure, like deckGeneratorService: rows in, swaps out, so it is testable
 * without the database.
 *
 * Pairing is global rather than cut-by-cut: every possible pair is scored and
 * the best are taken first. Taken in list order, an early cut would grab the
 * only removal spell on offer even when a later cut was removal too and the
 * early one was a creature.
 */
import { themeRole } from './cardSynergyService.js';
import { isLand } from './cardRoleService.js';
import { ROLE_PREDICATE_BY_CODE, ROLE_LABEL_BY_CODE } from './deckGeneratorService.js';

const mvOf = (card) => Number(card.cmc) || 0;

const CARD_TYPES = ['creature', 'planeswalker', 'instant', 'sorcery', 'artifact', 'enchantment', 'battle'];

/** The first of the main card types on a type line, for "same kind of card". */
function mainType(card) {
  const line = String(card.type_line || '').toLowerCase();
  return CARD_TYPES.find((type) => line.includes(type)) || null;
}

function rolesOf(card) {
  return Object.entries(ROLE_PREDICATE_BY_CODE)
    .filter(([, matches]) => matches(card))
    .map(([code]) => code);
}

/** How well `add` stands in for `cut`. Null when the two cannot be paired. */
function pairScore(cut, add) {
  if (isLand(cut) !== isLand(add)) return null;

  const shared = cut.roles.filter((code) => add.roles.includes(code));
  let score = shared.length * 4;
  if (mainType(cut) && mainType(cut) === mainType(add)) score += 1;
  score -= Math.abs(mvOf(cut) - mvOf(add)) * 0.5;
  return { score, shared };
}

/**
 * Why `add` replaces `cut`, as short clauses. Only what is true of the pair:
 * shared jobs, theme fit, and cost.
 */
function reasonsFor(cut, add, shared, themes) {
  const why = [];

  if (shared.length > 0) {
    why.push(`both ${shared.map((code) => ROLE_LABEL_BY_CODE[code] || code).join(' and ')}`);
  }

  for (const theme of themes) {
    const addFits = Boolean(themeRole(add, theme));
    const cutFits = Boolean(themeRole(cut, theme));
    const name = theme.shortLabel || theme.label;
    if (addFits && !cutFits) why.push(`${add.name} is part of ${name}; ${cut.name} is not`);
    else if (addFits && cutFits) why.push(`both part of ${name}`);
  }

  if (why.length === 0 && cut.roles.length === 0) {
    // Said plainly: the cut card did not register as any job this build
    // counts, which is the usual reason it lost its slot.
    why.push(`${cut.name} fills none of the roles or themes this build counts`);
  }

  // Nothing about the pair itself explains it, so say only what is known: the
  // build preferred the new card. Inventing a better-sounding reason would be
  // exactly the kind of claim these heuristics are not entitled to.
  if (why.length === 0) why.push(`ranked above ${cut.name} for this build`);

  const diff = mvOf(add) - mvOf(cut);
  if (diff !== 0) why.push(`${Math.abs(diff)} ${diff < 0 ? 'cheaper' : 'more expensive'}`);

  return why;
}

/**
 * @param cuts    [{ card, quantity }] — card is a row with card columns
 *                (name, type_line, oracle_text, cmc, …), plus whatever the
 *                caller wants carried through (printingId, isFoil)
 * @param adds    the same shape, for the cards being added
 * @param themes  resolved theme objects the proposal was built around
 * @returns { swaps: [{ cut, add, quantity, why }], cut: [...], added: [...] }
 *          where `cut` and `added` are what was left unpaired.
 */
export function pairSwaps(cuts, adds, themes = []) {
  const withRoles = (entry) => ({ ...entry, card: { ...entry.card, roles: rolesOf(entry.card) } });
  const cutLeft = cuts.map(withRoles).map((entry) => ({ ...entry, left: entry.quantity }));
  const addLeft = adds.map(withRoles).map((entry) => ({ ...entry, left: entry.quantity }));

  const candidates = [];
  for (const c of cutLeft) {
    for (const a of addLeft) {
      const scored = pairScore(c.card, a.card);
      if (scored) candidates.push({ c, a, ...scored });
    }
  }
  // Best first; ties broken by name so the same revision always pairs the
  // same way.
  candidates.sort((x, y) => y.score - x.score
    || x.c.card.name.localeCompare(y.c.card.name)
    || x.a.card.name.localeCompare(y.a.card.name));

  const swaps = [];
  for (const { c, a, shared } of candidates) {
    const quantity = Math.min(c.left, a.left);
    if (quantity <= 0) continue;
    c.left -= quantity;
    a.left -= quantity;
    swaps.push({
      cut: { ...strip(c), quantity },
      add: { ...strip(a), quantity },
      quantity,
      why: reasonsFor(c.card, a.card, shared, themes),
    });
  }

  const leftover = (entries) => entries
    .filter((entry) => entry.left > 0)
    .map((entry) => ({ ...strip(entry), quantity: entry.left }));

  return { swaps, cut: leftover(cutLeft), added: leftover(addLeft) };
}

/** What travels to the client: the name and the printing, not the card text. */
function strip(entry) {
  return {
    name: entry.card.name,
    printingId: entry.card.printing_id ?? null,
    isFoil: Boolean(entry.card.is_foil),
  };
}
