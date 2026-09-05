/**
 * How cards work *together*, as distinct from what each one does on its own.
 *
 * `cardRoleService` answers "is this removal?". This answers "is there a deck
 * here?" — and the two are not the same question. A pile of the best cards in
 * a colour is not a deck; a theme with both halves present is.
 *
 * ── Synergy is directional, and that is the whole design ────────────────────
 *
 * The obvious model is to tag cards with themes and reward a deck for having
 * lots of cards sharing a tag. That model is wrong, and measurably so. Each
 * theme here is split in two:
 *
 *   ENABLER  makes the thing happen — a sacrifice outlet, a token maker
 *   PAYOFF   rewards the thing happening — "whenever a creature you control
 *            dies, each opponent loses 1 life"
 *
 * A theme is only as strong as its *weaker* half, so its strength is
 * `min(enablers, payoffs)`. Measured against three real collections, tag
 * counting and this disagree badly: one collection held 66 lifegain enablers
 * and 12 payoffs. Summed, lifegain looked like the biggest theme in the
 * collection at 78 cards. It is actually capped at 12 — build the other 54 and
 * you have a deck that gains life and never converts it. Worse, a sum treats
 * two payoffs as synergistic with each other, which is exactly the pile that
 * does nothing.
 *
 * ── Tribes are not special-cased ────────────────────────────────────────────
 *
 * A tribe is a theme whose enabler is "a creature of this type" and whose
 * payoff is "a card whose text names this type". Running them through the same
 * machinery is what makes them comparable to graveyard or tokens on one scale,
 * and it disposes of the Human problem by itself: Human is the largest creature
 * type in every collection tested (28 of them in one two-colour identity) and
 * has one payoff, so it scores 1. It is the default creature type, not a tribe,
 * and payoff count is the only thing that distinguishes the two.
 *
 * ── The same caveat as the role service ─────────────────────────────────────
 *
 * These are heuristics over English oracle text and they will misclassify.
 * That is tolerable only because every result here carries the cards it was
 * built from, so a player can see the reasoning and disagree with it. Nothing
 * in this module may ever be phrased to the player as a fact.
 *
 * Pure — rows in, analysis out, no database and no network — so it can be
 * exercised where better-sqlite3 will not build.
 */

import { effectText, isCreature, isLand, isInstantOrSorcery, isArtifact } from './cardRoleService.js';

const typeOf = (card) => String(card.type_line || '').toLowerCase();

/**
 * A card's creature subtypes.
 *
 * `cards.subtypes` arrives as a comma-joined string from MTGJSON, but callers
 * that have already parsed it should not have to un-parse it, so an array is
 * accepted too. Subtype coverage is effectively total — 19,146 of 19,150
 * creatures in the reference set carry them — so this is reliable data rather
 * than a signal that needs a fallback.
 */
export function subtypesOf(card) {
  const raw = card.subtypes;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return list.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * Is this card castable in a deck of the given colour identity?
 *
 * Colour identity, not colours: a card whose identity includes a colour the
 * commander does not have is illegal in Commander however it is cast. The
 * empty identity (colourless) fits everywhere, which is why the test is
 * "every symbol is allowed" rather than "the sets intersect".
 */
export function withinColorIdentity(card, identity) {
  const allowed = String(identity || '').toUpperCase();
  const own = String(card.color_identity || '').toUpperCase().replace(/[^WUBRG]/g, '');
  return [...own].every((symbol) => allowed.includes(symbol));
}

// --- Mechanical themes -----------------------------------------------------

/**
 * The themes, each as an enabler and a payoff predicate.
 *
 * Deliberately a small set. Every one of these was checked against real
 * collections for having both halves present; a theme that cannot reach
 * `MIN_VIABLE_STRENGTH` in any identity is a label, not a deck, and adding
 * more of those makes the ranking noisier without making it better.
 */
export const THEMES = {
  aristocrats: {
    label: 'sacrifice and death triggers',
    enabler: (card) => {
      const text = effectText(card);
      return /sacrifice (a|another) (creature|permanent|artifact)/.test(text)
        || /create .{0,40}creature token/.test(text);
    },
    payoff: (card) => {
      const text = effectText(card);
      // Deliberately broad on the death trigger. The obvious pattern —
      // "whenever a/another creature dies" — misses the card the whole
      // archetype is named for: Blood Artist reads "Whenever Blood Artist or
      // another creature dies", which the self-reference stripping turns into
      // "whenever this or another creature dies". Anchoring on "dies" alone
      // within one clause catches the phrasings without needing to enumerate
      // them.
      return /whenever[^.]{0,60}\bdies\b/.test(text)
        || /whenever you sacrifice/.test(text);
    },
  },

  counters: {
    label: '+1/+1 counters',
    enabler: (card) => {
      const text = effectText(card);
      return /(put|with|enters with) (a|two|three|four|x|\d+) \+1\/\+1 counter/.test(text);
    },
    payoff: (card) => {
      const text = effectText(card);
      return /whenever[^.]{0,60}\+1\/\+1 counter/.test(text)
        || /for each \+1\/\+1 counter/.test(text)
        || /creatures? you control with (a |one or more )?\+1\/\+1 counter/.test(text)
        || /\b(proliferate|evolve|adapt|bolster|mentor)\b/.test(text);
    },
  },

  graveyard: {
    label: 'graveyard value',
    enabler: (card) => {
      const text = effectText(card);
      return /\bmill(s|ed)?\b/.test(text)
        || /put[^.]{0,50}into your graveyard/.test(text)
        || /discard (a|your|two|three) card/.test(text)
        || /\b(surveil|dredge|self-mill)\b/.test(text);
    },
    payoff: (card) => {
      const text = effectText(card);
      return /return[^.]{0,60}from your graveyard/.test(text)
        || /from your graveyard to the battlefield/.test(text)
        || /for each[^.]{0,40}in your graveyard/.test(text)
        || /cards? in your graveyard/.test(text)
        || /\b(delve|escape|flashback|disturb|unearth|embalm|eternalize|threshold|delirium)\b/.test(text);
    },
  },

  tokens: {
    label: 'token swarm',
    enabler: (card) => /create[^.]{0,50}token/.test(effectText(card)),
    payoff: (card) => {
      const text = effectText(card);
      return /whenever[^.]{0,50}token[^.]{0,30}(enters|attacks)/.test(text)
        || /tokens? you control (get|have)/.test(text)
        || /for each (creature|token) you control/.test(text)
        || /creatures you control get \+\d+\/\+\d+/.test(text)
        || /\b(convoke|populate)\b/.test(text);
    },
  },

  spellslinger: {
    label: 'instants and sorceries matter',
    // The enabler here is the card's own type rather than its text: a
    // spellslinger deck is enabled by simply containing instants and
    // sorceries, which is not true of any other theme in this list.
    enabler: (card) => isInstantOrSorcery(card),
    payoff: (card) => {
      const text = effectText(card);
      return /whenever you cast (an instant|a sorcery|your first|a noncreature)/.test(text)
        || /instant (and|or) sorcery (spells|cards) you/.test(text)
        || /for each instant and sorcery/.test(text)
        || /\b(prowess|magecraft|storm)\b/.test(text);
    },
  },

  lifegain: {
    label: 'lifegain payoffs',
    enabler: (card) => {
      const text = effectText(card);
      return /you gain \d+ life/.test(text)
        || /gains? \d+ life/.test(text)
        || /\blifelink\b/.test(text);
    },
    payoff: (card) => {
      const text = effectText(card);
      return /whenever you gain life/.test(text)
        || /if you (would gain|gained) life/.test(text)
        || /whenever[^.]{0,40}life total (changes|is greater)/.test(text);
    },
  },

  artifacts: {
    label: 'artifacts matter',
    enabler: (card) => isArtifact(card) || /create[^.]{0,40}artifact token/.test(effectText(card)),
    payoff: (card) => {
      const text = effectText(card);
      return /artifacts? you control/.test(text)
        || /whenever an artifact/.test(text)
        || /for each artifact/.test(text)
        || /\b(affinity for artifacts|metalcraft|improvise)\b/.test(text);
    },
  },

  enchantments: {
    label: 'enchantments matter',
    enabler: (card) => /\benchantment\b/.test(typeOf(card)),
    payoff: (card) => {
      const text = effectText(card);
      return /enchantments? you control/.test(text)
        || /whenever an enchantment/.test(text)
        || /for each enchantment/.test(text)
        || /\bconstellation\b/.test(text);
    },
  },

  blink: {
    label: 'blink and enter-the-battlefield value',
    enabler: (card) => {
      const text = effectText(card);
      return /exile[^.]{0,50}return (it|them|that card|those cards) to the battlefield/.test(text)
        || /\bflicker\b/.test(text);
    },
    payoff: (card) => {
      const text = effectText(card);
      // "Enters tapped" is the most common enters-clause in the game and says
      // nothing about blinking, so it is excluded explicitly.
      if (/enters tapped/.test(text) && !/whenever/.test(text)) return false;
      return /when(ever)? this (creature )?enters/.test(text)
        || /whenever another creature you control enters/.test(text);
    },
  },

  landfall: {
    label: 'lands matter',
    enabler: (card) => {
      const text = effectText(card);
      return /search your library for a[^.]{0,30}land card/.test(text)
        || /play an additional land/.test(text)
        || /return[^.]{0,30}land[^.]{0,20}to your hand/.test(text);
    },
    payoff: (card) => {
      const text = effectText(card);
      return /\blandfall\b/.test(text)
        || /whenever a land (you control )?enters/.test(text)
        || /for each land you control/.test(text);
    },
  },
};

/**
 * A theme's strength has to clear this before it is worth calling a theme.
 *
 * A Commander deck is 99 cards: roughly 36 lands and 63 spells, of which the
 * role minimums in `deckProfiles` claim about 31 (ramp, draw, removal,
 * wipes). That leaves about 32 slots for the theme itself, and a theme cannot
 * fill them from fewer than ten cards on its thinner side without repeating
 * itself into a deck that does one thing badly.
 */
export const MIN_VIABLE_STRENGTH = 10;

/** How many creatures of a type before it is worth testing as a tribe. */
const MIN_TRIBE_CREATURES = 8;

/**
 * A theme built from a creature type.
 *
 * The payoff patterns look for the type named in text — "Vampires you
 * control", "other Elves", "each Goblin". They are not exhaustive and will
 * miss a lord that words itself unusually; the cost of that is a tribe scoring
 * lower than it deserves, which is the safe direction to be wrong in.
 */
export function tribeTheme(subtype) {
  const name = String(subtype);
  const needle = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(
    `(${needle}s? you control|other ${needle}s?\\b|each ${needle}\\b|${needle} creatures?\\b|${needle}s? you)`
  );

  return {
    key: `tribe:${name}`,
    label: `${name} tribal`,
    tribe: name,
    enabler: (card) => isCreature(card) && subtypesOf(card).includes(name),
    payoff: (card) => named.test(effectText(card)),
  };
}

/**
 * Which side of a theme a card sits on.
 *
 * A card can be both — a token maker that also rewards tokens — and that is
 * reported rather than collapsed, because a card doing both jobs is the most
 * valuable kind and a generator should be able to see it.
 */
export function themeRole(card, theme) {
  const enabler = Boolean(theme.enabler(card));
  const payoff = Boolean(theme.payoff(card));
  if (enabler && payoff) return 'both';
  if (payoff) return 'payoff';
  if (enabler) return 'enabler';
  return null;
}

/**
 * Measure one theme against one pool of cards.
 *
 * Lands are excluded from both counts. A theme is a claim about spells, and
 * counting lands inflates every theme in the same direction — a deck's 36
 * lands would make "lands matter" look like the strongest theme in every
 * collection ever assembled.
 */
export function analyzeTheme(cards, theme) {
  const enablers = [];
  const payoffs = [];
  const both = [];

  for (const card of cards) {
    if (isLand(card)) continue;
    const role = themeRole(card, theme);
    if (!role) continue;
    if (role === 'both') both.push(card);
    if (role === 'enabler' || role === 'both') enablers.push(card);
    if (role === 'payoff' || role === 'both') payoffs.push(card);
  }

  return {
    key: theme.key || null,
    label: theme.label,
    tribe: theme.tribe || null,
    enablers: enablers.length,
    payoffs: payoffs.length,
    // The binding constraint. See the note at the top of the file: a sum here
    // ranks a theme by its abundant half and builds the deck that does nothing.
    strength: Math.min(enablers.length, payoffs.length),
    viable: Math.min(enablers.length, payoffs.length) >= MIN_VIABLE_STRENGTH,
    // Evidence. Every finding built on these heuristics has to be able to show
    // its working, so the cards behind the numbers travel with them.
    enablerCards: enablers.map((c) => c.name),
    payoffCards: payoffs.map((c) => c.name),
    bothCards: both.map((c) => c.name),
  };
}

/**
 * The tribes worth testing in a pool, largest first.
 *
 * Derived from the pool rather than from a fixed list, because which tribes
 * exist is a fact about the collection. A fixed list would both miss the tribe
 * somebody actually owns and waste time on the fifty they do not.
 */
export function candidateTribes(cards, minCreatures = MIN_TRIBE_CREATURES) {
  const counts = new Map();
  for (const card of cards) {
    if (!isCreature(card)) continue;
    for (const subtype of subtypesOf(card)) {
      counts.set(subtype, (counts.get(subtype) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minCreatures)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

/**
 * Rank every theme — mechanical and tribal — against a pool of cards.
 *
 * `identity` filters the pool to what is legal in a Commander deck of that
 * colour identity before anything is measured. That order matters: measuring
 * first and filtering after is how a "tribe" of 62 Humans spread across all
 * five colours gets reported as the strongest theme in a collection, when no
 * legal deck can play more than a third of them.
 */
export function rankThemes(cards, { identity = null, includeTribes = true, minTribeCreatures = MIN_TRIBE_CREATURES } = {}) {
  const pool = identity ? cards.filter((card) => withinColorIdentity(card, identity)) : cards;

  const themes = Object.entries(THEMES).map(([key, theme]) => ({ key, ...theme }));

  if (includeTribes) {
    for (const subtype of candidateTribes(pool, minTribeCreatures)) {
      themes.push(tribeTheme(subtype));
    }
  }

  return themes
    .map((theme) => analyzeTheme(pool, theme))
    .sort((a, b) => b.strength - a.strength || b.enablers - a.enablers);
}

/**
 * The themes worth offering someone, with the weak ones dropped.
 *
 * Returns at most `limit`, and only themes that clear MIN_VIABLE_STRENGTH —
 * an empty result is a real answer ("nothing in these colours is dense enough
 * to build around") and must not be padded with the least bad option.
 */
export function viableThemes(cards, { identity = null, limit = 3, ...rest } = {}) {
  return rankThemes(cards, { identity, ...rest })
    .filter((theme) => theme.viable)
    .slice(0, limit);
}

/**
 * How well one card fits a theme that has already been chosen.
 *
 * Used to rank cards competing for the same slot, so it is deliberately a
 * small integer rather than a probability: 'both' beats 'payoff' beats
 * 'enabler' beats unrelated. Payoffs outrank enablers because they are the
 * scarcer half in every collection measured, so a deck that passes one up is
 * likelier to be the one that ends up unbalanced.
 */
export function synergyScore(card, theme) {
  switch (themeRole(card, theme)) {
    case 'both': return 3;
    case 'payoff': return 2;
    case 'enabler': return 1;
    default: return 0;
  }
}
