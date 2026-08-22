import db from '../db/connection.js';
import { checkDeckLegality } from './deckService.js';

/**
 * The hard rules of a format: the things that make a deck unplayable rather
 * than merely questionable.
 *
 * Kept strictly apart from guidance. A deck that breaks a rule here cannot be
 * played; a deck that ignores advice may simply be doing something deliberate,
 * and conflating the two is what makes a deck checker nagging rather than
 * useful.
 */

export const FORMAT_RULES = {
  standard:  { label: 'Standard',  minDeck: 60,  maxCopies: 4, sideboardMax: 15 },
  modern:    { label: 'Modern',    minDeck: 60,  maxCopies: 4, sideboardMax: 15 },
  legacy:    { label: 'Legacy',    minDeck: 60,  maxCopies: 4, sideboardMax: 15 },
  vintage:   { label: 'Vintage',   minDeck: 60,  maxCopies: 4, sideboardMax: 15, restrictedMax: 1 },
  pauper:    { label: 'Pauper',    minDeck: 60,  maxCopies: 4, sideboardMax: 15, commonsOnly: true },
  commander: {
    label: 'Commander',
    exactDeck: 100,
    maxCopies: 1,
    sideboardMax: 0,
    singleton: true,
    requiresCommander: true,
    enforcesColorIdentity: true
  }
};

export function getFormatRules(format) {
  return FORMAT_RULES[String(format || '').toLowerCase()] || null;
}

/** Basic lands are exempt from copy limits — any number may be played. */
function isBasicLand(card) {
  const supertypes = card.supertypes || '';
  const typeLine = card.type_line || '';
  return (supertypes.includes('Basic') && typeLine.includes('Land')) || /^Basic .*Land/.test(typeLine);
}

/**
 * May this card be a commander? Mirrors the check the deck builder makes:
 * MTGJSON's leadership data when present, then the printed rules that make a
 * card eligible.
 */
export function canBeCommander(card) {
  if (card.leadership_skills) {
    try {
      const skills = typeof card.leadership_skills === 'string'
        ? JSON.parse(card.leadership_skills)
        : card.leadership_skills;
      if (skills && skills.commander) return true;
    } catch { /* fall through to the printed rules */ }
  }

  const type = card.type_line || '';
  if (/legendary/i.test(type) && /creature/i.test(type)) return true;
  if (/\bBackground\b/i.test(type)) return true;
  if (card.oracle_text && /can be your commander/i.test(card.oracle_text)) return true;

  return false;
}

/** The colours a card carries, from its stored comma-joined identity. */
function identityOf(card) {
  return (card.color_identity || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

function boardOf(card) {
  return card.board_type || (card.is_sideboard ? 'sideboard' : 'mainboard');
}

const isLand = (card) => /land/i.test(card.type_line || '');

/**
 * How many lands a deck of this size usually wants.
 *
 * A heuristic, not a rule. The received wisdom is around 17 in a 60-card deck
 * and 36 in Commander, shifted by how expensive the spells are — a deck full
 * of one-drops floods on 18, and a deck full of five-drops stumbles on 16.
 */
function suggestedLandCount(deckSize, averageSpellCost) {
  const base = deckSize >= 100 ? 36 : 17;

  if (averageSpellCost <= 1.9) return base - 1;
  if (averageSpellCost <= 2.6) return base;
  if (averageSpellCost <= 3.3) return base + 1;
  return base + 2;
}

/**
 * Which colours a card's mana cost actually asks for, as opposed to its
 * colour identity, which also counts reminder text and abilities.
 */
function costColors(manaCost) {
  const found = new Set();
  for (const match of String(manaCost || '').matchAll(/\{([^}]+)\}/g)) {
    for (const color of match[1].toUpperCase().split('/')) {
      if ('WUBRG'.includes(color) && color.length === 1) found.add(color);
    }
  }
  return [...found];
}

/**
 * Advice, kept firmly apart from the rules above. Every item says what to
 * consider and carries the filter that would show the cards to consider it
 * with, so the client can offer a way to act rather than just a sentence.
 */
function buildGuidance(mainboard, rules) {
  const guidance = [];
  const total = mainboard.reduce((sum, c) => sum + c.quantity, 0);

  // Nothing useful to say about a deck that has barely been started.
  if (total < 20) return guidance;

  const lands = mainboard.filter(isLand);
  const spells = mainboard.filter((c) => !isLand(c));
  const landCount = lands.reduce((sum, c) => sum + c.quantity, 0);
  const spellCount = spells.reduce((sum, c) => sum + c.quantity, 0);

  const deckSize = rules?.exactDeck || rules?.minDeck || 60;
  const averageCost = spellCount > 0
    ? spells.reduce((sum, c) => sum + (c.cmc || 0) * c.quantity, 0) / spellCount
    : 0;

  // The colours this deck actually casts, so land advice points somewhere.
  const deckColors = [...new Set(spells.flatMap((c) => costColors(c.mana_cost)))];

  // --- Land count ----------------------------------------------------------
  const wantedLands = suggestedLandCount(deckSize, averageCost);
  const landGap = wantedLands - landCount;

  // Two off is noise; three is worth mentioning.
  if (Math.abs(landGap) >= 3) {
    guidance.push({
      code: 'land-count',
      message: landGap > 0
        ? `Consider ${landGap} more land${landGap === 1 ? '' : 's'} — around ${wantedLands} suits an average cost of ${averageCost.toFixed(1)}.`
        : `Consider ${-landGap} fewer lands — around ${wantedLands} suits an average cost of ${averageCost.toFixed(1)}.`,
      // No colour filter here on purpose: picking colours means "produces all
      // of these", so a three-colour deck would match no single land. Show
      // every land they own and let them narrow with the colour chips.
      action: landGap > 0 ? { label: 'Show your lands', filter: { type: 'Land' } } : null
    });
  }

  // --- Curve ---------------------------------------------------------------
  if (spellCount >= 15) {
    const expensive = spells.filter((c) => (c.cmc || 0) >= 4).reduce((sum, c) => sum + c.quantity, 0);
    const cheap = spells.filter((c) => (c.cmc || 0) <= 2).reduce((sum, c) => sum + c.quantity, 0);

    if (expensive / spellCount > 0.4 && cheap / spellCount < 0.3) {
      guidance.push({
        code: 'curve-top-heavy',
        message: `Top-heavy: ${expensive} of ${spellCount} spells cost 4 or more, and only ${cheap} cost 2 or less.`,
        // Same reason as the land action: colours here would AND together.
        action: { label: 'Show cheap spells', filter: { maxCmc: 2 } }
      });
    }
  }

  // --- Colour support ------------------------------------------------------
  // A land is treated as producing the colours in its identity, which is a
  // decent proxy without parsing oracle text.
  for (const color of deckColors) {
    const needing = spells
      .filter((c) => costColors(c.mana_cost).includes(color))
      .reduce((sum, c) => sum + c.quantity, 0);

    if (needing < 3) continue;

    const sources = lands
      .filter((c) => (c.color_identity || '').includes(color))
      .reduce((sum, c) => sum + c.quantity, 0);

    // Rough guide: a colour you cast from regularly wants a decent share of
    // the mana base behind it.
    if (landCount > 0 && sources / landCount < 0.25) {
      guidance.push({
        code: 'color-support',
        message: `${needing} cards need ${color}, but only ${sources} of ${landCount} lands produce it.`,
        action: { label: `Show ${color} lands`, filter: { type: 'Land', colors: [color] } }
      });
    }
  }

  return guidance;
}

/**
 * Check a deck against its format's hard rules.
 *
 * Returns the counts the deck is measured against and a list of violations,
 * each naming the cards responsible so the client can act on it rather than
 * just report it.
 */
export function checkFormatRules(deckId, userId, formatOverride = null) {
  const deck = db.get(
    `SELECT id, name, format FROM decks WHERE id = ? AND user_id = ?`,
    [deckId, userId]
  );

  if (!deck) {
    throw new Error('Deck not found or access denied');
  }

  const format = String(formatOverride || deck.format || '').toLowerCase();
  const rules = getFormatRules(format);

  const cards = db.all(
    `SELECT dc.quantity, dc.is_sideboard, dc.is_commander, dc.board_type,
            c.name, c.type_line, c.supertypes, c.color_identity,
            c.oracle_text, c.leadership_skills, c.cmc, c.mana_cost,
            p.rarity
       FROM deck_cards dc
       JOIN printings p ON dc.printing_id = p.id
       JOIN cards c ON p.card_id = c.id
      WHERE dc.deck_id = ?`,
    [deckId]
  );

  const mainboard = cards.filter((c) => boardOf(c) === 'mainboard');
  const sideboard = cards.filter((c) => boardOf(c) === 'sideboard');
  const total = (list) => list.reduce((sum, c) => sum + c.quantity, 0);

  const counts = {
    mainboard: total(mainboard),
    sideboard: total(sideboard),
    maybeboard: total(cards.filter((c) => boardOf(c) === 'maybeboard'))
  };

  if (!rules) {
    return {
      format: format || null,
      formatLabel: null,
      known: false,
      counts,
      targets: null,
      violations: [],
      // Advice does not need a known format — a deck still wants lands.
      guidance: buildGuidance(mainboard, null),
      isLegal: true
    };
  }

  const violations = [];
  const add = (code, message, offenders = []) => violations.push({ code, message, cards: offenders });

  // --- Deck size -----------------------------------------------------------
  if (rules.exactDeck && counts.mainboard !== rules.exactDeck) {
    const diff = rules.exactDeck - counts.mainboard;
    add(
      'deck-size',
      diff > 0
        ? `${rules.label} decks are exactly ${rules.exactDeck} cards — ${diff} short.`
        : `${rules.label} decks are exactly ${rules.exactDeck} cards — ${-diff} over.`
    );
  }

  if (rules.minDeck && counts.mainboard < rules.minDeck) {
    add('deck-size', `${rules.label} needs at least ${rules.minDeck} cards — ${rules.minDeck - counts.mainboard} short.`);
  }

  if (rules.sideboardMax !== undefined && counts.sideboard > rules.sideboardMax) {
    add(
      'sideboard-size',
      rules.sideboardMax === 0
        ? `${rules.label} has no sideboard, but this deck lists ${counts.sideboard}.`
        : `Sideboards are at most ${rules.sideboardMax} cards — ${counts.sideboard - rules.sideboardMax} over.`
    );
  }

  // --- Copy limits ---------------------------------------------------------
  // Counted by card name across printings: the same card from two sets is
  // still the same card, and deck_cards keys on printing.
  const byName = new Map();
  for (const card of mainboard) {
    const entry = byName.get(card.name) || { name: card.name, quantity: 0, card };
    entry.quantity += card.quantity;
    byName.set(card.name, entry);
  }

  const overLimit = [...byName.values()].filter(
    (entry) => !isBasicLand(entry.card) && entry.quantity > rules.maxCopies
  );

  if (overLimit.length > 0) {
    add(
      rules.singleton ? 'singleton' : 'copy-limit',
      rules.singleton
        ? `${rules.label} is singleton — only one copy of each card outside basic lands.`
        : `At most ${rules.maxCopies} copies of a card, basic lands aside.`,
      overLimit.map((e) => ({ name: e.name, quantity: e.quantity, limit: rules.maxCopies }))
    );
  }

  // --- Commander -----------------------------------------------------------
  let commanders = [];

  if (rules.requiresCommander) {
    commanders = mainboard.filter((c) => c.is_commander);

    if (commanders.length === 0) {
      add('commander-missing', 'No commander chosen.');
    } else {
      const ineligible = commanders.filter((c) => !canBeCommander(c));
      if (ineligible.length > 0) {
        add(
          'commander-ineligible',
          'Chosen commander cannot lead a deck.',
          ineligible.map((c) => ({ name: c.name }))
        );
      }
      if (commanders.length > 2) {
        add('commander-count', 'A deck may have at most two commanders, and only in specific pairings.');
      }
    }
  }

  // --- Colour identity -----------------------------------------------------
  if (rules.enforcesColorIdentity && commanders.length > 0) {
    // Partners union their identities.
    const allowed = new Set(commanders.flatMap(identityOf));

    const outside = mainboard.filter((card) =>
      identityOf(card).some((color) => !allowed.has(color))
    );

    if (outside.length > 0) {
      const allowedLabel = allowed.size > 0 ? [...allowed].join('') : 'colourless';
      add(
        'color-identity',
        `Every card must sit inside the commander's colour identity (${allowedLabel}).`,
        outside.map((c) => ({ name: c.name, identity: identityOf(c).join('') }))
      );
    }
  }

  // --- Rarity --------------------------------------------------------------
  if (rules.commonsOnly) {
    const notCommon = [...mainboard, ...sideboard].filter(
      (c) => c.rarity && c.rarity.toLowerCase() !== 'common'
    );

    if (notCommon.length > 0) {
      add(
        'rarity',
        `${rules.label} allows commons only.`,
        notCommon.map((c) => ({ name: c.name, rarity: c.rarity }))
      );
    }
  }

  // --- Ban list ------------------------------------------------------------
  // The existing legality check already reads the stored legalities, including
  // the restricted status Vintage needs.
  const legality = checkDeckLegality(deckId, userId, format);

  const banned = legality.illegalCards.filter((c) => c.status !== 'Restricted');
  if (banned.length > 0) {
    add(
      'not-legal',
      `Not legal in ${rules.label}.`,
      banned.map((c) => ({ name: c.name, reason: c.reason }))
    );
  }

  if (rules.restrictedMax !== undefined) {
    const overRestricted = legality.illegalCards
      .filter((c) => c.status === 'Restricted')
      .filter((c) => (byName.get(c.name)?.quantity || 0) > rules.restrictedMax);

    if (overRestricted.length > 0) {
      add(
        'restricted',
        `Restricted cards are limited to ${rules.restrictedMax} copy.`,
        overRestricted.map((c) => ({ name: c.name, quantity: byName.get(c.name)?.quantity || 0 }))
      );
    }
  }

  return {
    format,
    formatLabel: rules.label,
    known: true,
    counts,
    targets: {
      mainboard: rules.exactDeck ?? rules.minDeck ?? null,
      mainboardExact: Boolean(rules.exactDeck),
      sideboardMax: rules.sideboardMax ?? null
    },
    violations,
    guidance: buildGuidance(mainboard, rules),
    // Legality is about the rules only. Ignoring advice never makes a deck
    // illegal, and folding it in here would make the two indistinguishable.
    isLegal: violations.length === 0
  };
}
