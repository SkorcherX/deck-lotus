import api from '../services/api.js';

/**
 * One definition of "may this card lead a deck", shared by every surface that
 * offers the toggle. Kept out of deckBuilder so the inventory panel cannot
 * drift into a second, subtly different answer.
 *
 * Callers pass whatever shape they have: the deck rows use snake_case straight
 * from SQLite, the inventory feed uses camelCase from the API.
 */
const typeOf = (c) => c.type_line || c.typeLine || '';
const textOf = (c) => (c.oracle_text || c.oracleText || '').replace(/\r/g, '');

// A legendary creature qualifies; so does any card whose rules text says
// "... can be your commander" — which is how planeswalker commanders (Daretti,
// Teferi, Freyalise, etc.) are printed. If MTGJSON leadership-skills data is
// present it wins (it also covers edge cases like Grist that lack the printed
// text), but the oracle-text check is the reliable signal.
export function canBeCommander(card) {
  const skillsRaw = card.leadership_skills ?? card.leadershipSkills;
  if (skillsRaw) {
    try {
      const skills = typeof skillsRaw === 'string' ? JSON.parse(skillsRaw) : skillsRaw;
      if (skills && skills.commander) return true;
    } catch { /* fall through to heuristic */ }
  }

  const type = typeOf(card);
  if (/legendary/i.test(type) && /creature/i.test(type)) return true;
  // Backgrounds are commanders (paired with a "Choose a Background" legend).
  if (/\bBackground\b/i.test(type)) return true;
  if (/can be your commander/i.test(textOf(card))) return true;
  return false;
}

// ---- Two-commander pairings (Partner / Backgrounds / Doctor's companion) ----
const hasPartner = (c) =>
  /(^|\n)Partner\b(?!\s+with)/i.test(textOf(c)) ||
  /have two commanders if both have partner/i.test(textOf(c).replace(/\n/g, ' '));
const partnerWithName = (c) => {
  const m = textOf(c).match(/Partner with ([^\n(.]+)/i);
  return m ? m[1].trim().replace(/[.,]+$/, '') : null;
};
const hasFriendsForever = (c) => /friends forever/i.test(textOf(c));
const hasChooseABackground = (c) => /choose a background/i.test(textOf(c));
const isBackground = (c) => /\bBackground\b/i.test(typeOf(c));
const hasDoctorsCompanion = (c) => /doctor.?s companion/i.test(textOf(c));
const isTimeLordDoctor = (c) => /Time Lord/i.test(typeOf(c)) && /Doctor/i.test(typeOf(c));

/** May cards `a` and `b` legally be commanders together? */
export function canPairCommanders(a, b) {
  if (!a || !b || a.deck_card_id === b.deck_card_id) return false;
  if (hasPartner(a) && hasPartner(b)) return true;
  const aw = partnerWithName(a), bw = partnerWithName(b);
  if (aw && (b.name || '').toLowerCase().includes(aw.toLowerCase())) return true;
  if (bw && (a.name || '').toLowerCase().includes(bw.toLowerCase())) return true;
  if (hasFriendsForever(a) && hasFriendsForever(b)) return true;
  if (hasChooseABackground(a) && isBackground(b)) return true;
  if (hasChooseABackground(b) && isBackground(a)) return true;
  if (hasDoctorsCompanion(a) && isTimeLordDoctor(b)) return true;
  if (hasDoctorsCompanion(b) && isTimeLordDoctor(a)) return true;
  return false;
}

/** Is this deck one that has commanders at all? */
export const isCommanderDeck = (deck) =>
  (deck?.format || '').toLowerCase() === 'commander';

/**
 * Flag or unflag one deck card as the commander.
 *
 * When setting one, an existing commander survives only if the two form a legal
 * pair (Partner / Partner with / Friends forever / Background / Doctor's
 * companion); otherwise the new pick replaces it. Returns the updated deck and
 * whether it landed as a partner, so callers can word their own toast.
 */
export async function setCommander(deckId, deck, deckCardId, isCommander) {
  const card = (deck.cards || []).find((c) => c.deck_card_id == deckCardId);
  let pairedWithPartner = false;

  if (isCommander && card) {
    const existing = (deck.cards || []).filter(
      (c) => c.is_commander && c.deck_card_id != deckCardId
    );
    const partner = existing.find((c) => canPairCommanders(c, card));
    pairedWithPartner = !!partner;
    const toUnmark = partner
      ? existing.filter((c) => c.deck_card_id != partner.deck_card_id)
      : existing;

    for (const c of toUnmark) {
      await api.updateDeckCard(deckId, c.deck_card_id, { isCommander: false });
    }
  }

  const updated = await api.updateDeckCard(deckId, deckCardId, { isCommander });
  return { deck: updated.deck, pairedWithPartner };
}
