/**
 * Commander Brackets: the lowest bracket a deck's card list allows.
 *
 * Wizards' bracket system (beta, Feb 2025; tutors dropped Oct 2025) is a
 * description of intent with four countable requirements hung off it. This
 * module counts those four and nothing else, so what it reports is a floor —
 * "this list cannot be played below bracket N" — never a verdict on how
 * strong the deck is. A no-Game-Changer deck can still belong in bracket 4;
 * Wizards say so themselves. Bracket 1 and 2 differ mostly in intent, which
 * a card list cannot show, so a deck that trips nothing reads "1–2".
 *
 * Interpretations, following the Red String write-up the feature was planned
 * from:
 *  - Mass land denial includes blanket spell taxes (Thalia, Sphere of
 *    Resistance). Wizards' wording does not name them; it is a call about
 *    the spirit of brackets 1–3 and is labelled as such in the reasons.
 *  - Extra turns: 1–2 is bracket 2, 3 is bracket 3, more is "chaining" and
 *    bracket 4. A short list of cards built for chaining is bracket 4 alone.
 *  - Two-card combos are an input (`combos`) the caller may pass; nothing
 *    detects them here yet. Late game means 8+ total mana.
 *
 * Deliberately import-free, like shoppingMerge.js, so it tests without the
 * SQLite driver and could run in the browser.
 */

export const BRACKET_LABELS = {
  1: 'Exhibition',
  2: 'Core',
  3: 'Upgraded',
  4: 'Optimized',
  5: 'cEDH',
};

/** MLD in effect whose wording the text filters below do not catch. */
export const MLD_CARDS = [
  'Vorinclex, Voice of Hunger', 'Hall of Gemstone', 'Contamination', 'Cataclysm',
  'Dimensional Breach', 'Epicenter', 'Global Ruin', 'Hokori, Dust Drinker',
  "Razia's Purification", 'Rising Waters', 'Soulscour', 'Sunder', 'Apocalypse',
  'Bearer of the Heavens', 'Conversion', 'Glaciers', 'Pox', 'Death Cloud',
  'Tangle Wire', 'Restore Balance', 'Realm Razer', 'Spreading Algae',
  'Numot, the Devastator', 'Kudzu', 'Demonic Hordes', "Urza's Sylex",
  'Infernal Darkness', 'Trinisphere', 'Worldfire', 'Worldslayer',
  'Gilt-Leaf Archdruid', 'Worldpurge', 'Stasis',
];

/** Extra-turn cards built to be reused or chained: bracket 4 on their own. */
export const CHAINING_EXTRA_TURN_CARDS = [
  'Time Warp', 'Temporal Manipulation', 'Walk the Aeons', 'Capture of Jingzhou',
  'Expropriate', 'Time Stretch', 'Nexus of Fate', 'Timestream Navigator',
  'Sage of Hours', 'Lighthouse Chronologist', 'Time Sieve', 'Magosi, the Waterveil',
];

/** Late game, per the write-up: a combo needing this much mana in total. */
export const LATE_COMBO_MANA = 8;

const BASIC_TYPES = '(?:plains|islands|swamps|mountains|forests)';

// Each is tested against one sentence at a time, so a "destroy all" in one
// sentence never pairs with "lands" in the next.
const MLD_PATTERNS = [
  // Armageddon, Ravages of War, Jokulhaups ("artifacts, creatures, and
  // lands"), Ruination ("nonbasic lands"). Not "lands you control", and not
  // a wipe that spares them (Elspeth Tirel, Scourglass: "except … lands").
  /^(?!.*\bexcept\b).*\b(?:destroy|exile)s? all\b[^.]*\blands\b(?! you control)/i,
  // Flashfires, Boil: one basic type. Not your own (Return of the
  // Nightstalkers).
  new RegExp(`\\b(?:destroy|exile)s? all ${BASIC_TYPES}\\b(?! you control)`, 'i'),
  // Winter Orb, Dovin Baan's emblem. Lands or permanents, and other players:
  // a creature or artifact limit (Smoke, Imi Statue) or one that binds only
  // you (Mungha Wurm) is not land denial.
  /\b(?:players|opponents) can't untap more than \w+ (?:nonbasic )?(?:lands?|permanents)\b/i,
  // Back to Basics.
  /\blands (?:don't|do not) untap\b/i,
  // Blood Moon, Magus of the Moon, Harbinger of the Seas. Not "in addition to
  // their other types" (Stormtide Leviathan), which takes nothing away.
  new RegExp(`\\blands are ${BASIC_TYPES}\\b(?! in addition)`, 'i'),
  // Blanket taxes: Sphere of Resistance, Thalia, Grand Arbiter Augustin IV.
  // Anchored to the start of the sentence, with the tax right after
  // "spells", so targeted taxes ("spells that target …", Hinata's "for each
  // target") and narrower ones ("Artifact and enchantment spells …", "Red
  // spells …") stay out.
  /^\s*(?:noncreature |creature )?spells(?: your opponents cast)? cost \{\d+\} more(?! to cast for each)\b/i,
];

const EXTRA_TURN_PATTERN = /\btakes? (?:an|two|three|\w+) extra turns?\b/i;
// "Players can't take extra turns", "If a player would take an extra turn".
const EXTRA_TURN_DENIAL = /\b(?:can't|cannot|would) take (?:an )?extra turns?\b/i;

function sentences(text) {
  return String(text || '').split(/(?<=[.\n])/);
}

export function isMassLandDenial(card) {
  if (!card) return false;
  if (MLD_CARDS.includes(card.name)) return true;
  return sentences(card.oracle_text).some((s) => MLD_PATTERNS.some((re) => re.test(s)));
}

export function isExtraTurn(card) {
  if (!card) return false;
  return sentences(card.oracle_text).some(
    (s) => EXTRA_TURN_PATTERN.test(s) && !EXTRA_TURN_DENIAL.test(s)
  );
}

export function isGameChanger(card) {
  return Boolean(card && (card.is_game_changer === 1 || card.is_game_changer === true));
}

/** Mainboard and commander only: sideboard and maybeboard are not played. */
function playedCards(cards) {
  const seen = new Map();
  for (const c of cards || []) {
    const board = c.board_type || (c.is_sideboard ? 'sideboard' : 'mainboard');
    if (board !== 'mainboard' && !c.is_commander) continue;
    // Printings and finishes are separate rows; the rules count cards.
    if (!seen.has(c.name)) seen.set(c.name, c);
  }
  return [...seen.values()];
}

/**
 * @param cards  deck rows: name, oracle_text, is_game_changer, board_type,
 *               is_commander
 * @param combos optional [{ cards: [name, name], totalMana }]
 * @returns { minBracket, label, reasons: [{ rule, bracket, cards, note }] }
 */
export function computeBracket(cards, { combos = [] } = {}) {
  const played = playedCards(cards);
  const names = (list) => list.map((c) => c.name).sort();
  const reasons = [];

  const gameChangers = played.filter(isGameChanger);
  if (gameChangers.length) {
    reasons.push({
      rule: 'game_changers',
      bracket: gameChangers.length > 3 ? 4 : 3,
      cards: names(gameChangers),
      note: gameChangers.length > 3
        ? `${gameChangers.length} Game Changers — bracket 3 allows 3`
        : `${gameChangers.length} Game Changer${gameChangers.length === 1 ? '' : 's'} — none allowed below bracket 3`,
    });
  }

  const mld = played.filter(isMassLandDenial);
  if (mld.length) {
    reasons.push({
      rule: 'mass_land_denial',
      bracket: 4,
      cards: names(mld),
      note: 'Mass land denial (including blanket spell taxes) — bracket 4 only',
    });
  }

  const extraTurns = played.filter(isExtraTurn);
  const chainers = extraTurns.filter((c) => CHAINING_EXTRA_TURN_CARDS.includes(c.name));
  if (chainers.length) {
    reasons.push({
      rule: 'extra_turn_chaining',
      bracket: 4,
      cards: names(chainers),
      note: 'Extra turns built for chaining — bracket 4 only',
    });
  }
  // The count only adds something when the chaining line has not already
  // put the deck in bracket 4; otherwise it repeats the same cards.
  if (extraTurns.length && (!chainers.length || extraTurns.length > 3)) {
    const n = extraTurns.length;
    reasons.push({
      rule: 'extra_turns',
      bracket: n > 3 ? 4 : n > 2 ? 3 : 2,
      cards: names(extraTurns),
      note: n > 3
        ? `${n} extra-turn cards — enough to chain`
        : `${n} extra-turn card${n === 1 ? '' : 's'} — ${n > 2 ? 'bracket 3 allows 3' : 'bracket 2 allows 2'}`,
    });
  }

  const early = combos.filter((c) => !(c.totalMana >= LATE_COMBO_MANA));
  const late = combos.filter((c) => c.totalMana >= LATE_COMBO_MANA);
  if (early.length) {
    reasons.push({
      rule: 'early_combos',
      bracket: 4,
      cards: early.map((c) => c.cards.join(' + ')),
      note: `Two-card combos under ${LATE_COMBO_MANA} mana — bracket 4 only`,
    });
  }
  if (late.length) {
    reasons.push({
      rule: 'late_combos',
      bracket: 3,
      cards: late.map((c) => c.cards.join(' + ')),
      note: `Two-card combos needing ${LATE_COMBO_MANA}+ mana — none below bracket 3`,
    });
  }

  reasons.sort((a, b) => b.bracket - a.bracket);
  const minBracket = reasons.reduce((m, r) => Math.max(m, r.bracket), 1);

  return {
    minBracket,
    // Nothing tripped: 1 and 2 differ in intent, which a list can't show.
    label: reasons.length === 0
      ? 'Bracket 1–2'
      : `Bracket ${minBracket}+ · ${BRACKET_LABELS[minBracket]}`,
    reasons,
  };
}
