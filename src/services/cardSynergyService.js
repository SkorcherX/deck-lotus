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

// "create two 1/1 white Soldier creature tokens", but not Treasure or Clue.
const makesCreatureTokens = (text) => /create[^.]{0,60}creature tokens?/.test(text);

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
 *
 * Alongside the two predicates each theme carries three strings that exist
 * only to be read by a person: `blurb` says in plain English what a deck built
 * this way is trying to do, and `enablerName`/`payoffName` name the two halves
 * in that theme's own terms. "27 enablers, 20 payoffs" means nothing to
 * somebody who has been playing for a week; "27 ways to make tokens, 20 cards
 * that reward having them" is the same number saying something. They live
 * beside the predicates on purpose — a theme whose text drifts from what its
 * regexes match is worse than one with no text at all, and here the two are
 * impossible to edit separately by accident.
 */
/**
 * Who a mill effect is aimed at. Opponent-only phrasings ("target opponent
 * mills", "each opponent mills") are a win condition, not a way to fill your
 * own graveyard; a bare "mill three cards" is you. "Target player" and "each
 * player" can be either, and count as both.
 */
const OPPONENT_MILL = /(target opponent|each opponent|that player|defending player|an opponent|they)\s+(would\s+)?mills?\b[^.]*/g;
const EITHER_MILL = /(target player|each player)\s+mills?\b/;

export function millsOpponent(text) {
  return new RegExp(OPPONENT_MILL.source).test(text) || EITHER_MILL.test(text);
}

export function millsYou(text) {
  if (EITHER_MILL.test(text)) return true;
  // What is left once the opponent-only phrasings are cut out: any mill still
  // in the text is one the card's controller does to themselves.
  return /\bmill(s|ed)?\b/.test(text.replace(OPPONENT_MILL, ' '));
}

export const THEMES = {
  aristocrats: {
    label: 'sacrifice and death triggers',
    blurb: 'Your creatures are ammunition. You sacrifice them yourself — for value, to dodge removal, to trigger something — and a second set of cards turns each of those deaths into damage, life or cards. It grinds a long game down rather than racing.',
    enablerName: 'ways to make or sacrifice creatures',
    payoffName: 'cards that pay you when something dies',
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
    blurb: 'Creatures that grow. You spend cards putting +1/+1 counters on things, then play cards that care how many counters are out there, so a modest creature becomes the reason you win.',
    enablerName: 'ways to put counters on creatures',
    payoffName: 'cards that reward counters',
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
    blurb: 'Your graveyard is a second hand. You deliberately put cards into it — milling, discarding, cheap spells traded off early — and then spend the game buying them back or casting them from there.',
    enablerName: 'ways to fill your graveyard',
    payoffName: 'cards that use your graveyard',
    enabler: (card) => {
      const text = effectText(card);
      return millsYou(text)
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
        // Lhurgoyf and its kin count every graveyard, yours included, so they
        // grow off self-mill exactly as a "your graveyard" card does.
        || /(cards?|card types) (among cards )?in all graveyards/.test(text)
        || /\b(delve|escape|flashback|disturb|unearth|embalm|eternalize|threshold|delirium)\b/.test(text);
    },
  },

  // Split from graveyard value, which used to count every mill card as one of
  // its enablers. Milling an opponent is a way to win — they lose drawing from
  // an empty library — and does nothing for a creature that counts your own
  // graveyard, so a deck mixing the two was scored as one plan while half of
  // it worked against the other half. "Target player mills" can be pointed
  // either way and counts for both.
  mill: {
    label: 'milling your opponent',
    blurb: "You win by emptying your opponent's library instead of their life total. Most of the deck puts their cards into their graveyard a few at a time; the rest rewards you for it, or makes sure they run out first.",
    enablerName: 'ways to mill an opponent',
    payoffName: "cards that reward an opponent's full graveyard",
    enabler: (card) => millsOpponent(effectText(card)),
    payoff: (card) => {
      const text = effectText(card);
      return /cards? in (an opponent's|target opponent's|that player's|their|your opponents'|each opponent's) graveyards?/.test(text)
        || /library has (no|twenty or fewer|ten or fewer) cards/.test(text)
        || /(if|whenever) (an opponent|a player|one or more opponents) would mill/.test(text)
        || /whenever (an opponent|a player|one or more opponents) mills?/.test(text)
        || /cards? (is|are) put into (an opponent's|a player's|their) graveyard from (their|a) library/.test(text)
        || /from (an opponent's|their) graveyard/.test(text);
    },
  },

  tokens: {
    label: 'token swarm',
    blurb: 'Quantity over quality. You make lots of small creature tokens, then play the cards that make a wide board frightening — anthems, effects counting your creatures, ways to cash the whole team in at once.',
    enablerName: 'ways to make creature tokens',
    payoffName: 'cards that reward a wide board',
    // Creature tokens only: "create a Treasure token" is ramp, and used to
    // count as a token-swarm enabler.
    enabler: (card) => makesCreatureTokens(effectText(card)),
    payoff: (card) => {
      const text = effectText(card);
      return /whenever[^.]{0,50}token[^.]{0,30}(enters|attacks)/.test(text)
        || /tokens? you control (get|have)/.test(text)
        || /for each (creature|token) you control/.test(text)
        || /creatures you control get \+\d+\/\+\d+/.test(text)
        || /twice that many[^.]{0,30}tokens/.test(text)
        || /\b(convoke|populate)\b/.test(text);
    },
  },

  // Token swarm is one way to go wide; this is the other. The bodies are
  // cheap creatures cast two a turn as often as tokens, so the enabler is
  // "a creature costing 2 or less" as well as a token maker. The payoffs
  // overlap with token swarm on purpose — anthems reward either board.
  goWide: {
    label: 'go wide',
    blurb: 'Lots of cheap creatures, fast. The deck is packed with one- and two-drops and token makers so the board fills in the first few turns, then an anthem or a mass pump turns a crowd of small bodies into lethal damage.',
    enablerName: 'cheap creatures and creature-token makers',
    payoffName: 'cards that reward having many creatures',
    enabler: (card) => (isCreature(card) && (Number(card.cmc) || 0) <= 2)
      || makesCreatureTokens(effectText(card)),
    // The part of the enabler that is about what a card does rather than what
    // it costs. Mimic reads this so that two cheap creatures are not called a
    // theme match on mana value alone.
    textEnabler: (card) => makesCreatureTokens(effectText(card)),
    payoff: (card) => {
      const text = effectText(card);
      return /creatures you control get \+\d+\/\+\d+/.test(text)
        || /other creatures you control get/.test(text)
        || /creatures you control (gain|have)[^.]{0,40}(trample|double strike|first strike|vigilance)/.test(text)
        || /for each (other )?(creature|token) you control/.test(text)
        || /whenever (a|another|one or more)( other)?( nontoken)? creatures? (you control )?enters?/.test(text)
        || /whenever (you attack|one or more creatures you control attack)/.test(text)
        || /(three|four|five) or more creatures/.test(text)
        || /\b(battalion|raid|mentor|convoke|coven)\b/.test(text);
    },
  },

  spellslinger: {
    label: 'instants and sorceries matter',
    blurb: 'You are the one casting spells all game. The deck is heavy on instants and sorceries, and the creatures are the ones that grow or draw or burn every time you cast one, so cheap spells stop being one-shot answers.',
    enablerName: 'instants and sorceries',
    payoffName: 'cards that trigger off casting them',
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
    blurb: 'Gaining life is the trigger, not the point. On its own life does not win a game, so the deck pairs steady lifegain with cards that turn each gain into damage, creatures or cards.',
    enablerName: 'ways to gain life',
    payoffName: 'cards that pay you for gaining it',
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
    blurb: 'A deck made of objects. Artifacts are colourless, so they stack up regardless of what you are playing, and the payoffs count them, cheapen them, or bring them back — the board builds itself into a machine.',
    enablerName: 'artifacts and artifact makers',
    payoffName: 'cards that count artifacts',
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
    blurb: 'Permanents that stay put. Enchantments are hard for most decks to remove, so the deck builds a board that is difficult to interact with and plays the cards that trigger whenever another one lands.',
    enablerName: 'enchantments',
    payoffName: 'cards that reward enchantments',
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
    blurb: 'You keep re-reading the same good cards. Creatures whose best line is the moment they enter play, paired with effects that exile and return them, so the same arrival trigger happens over and over.',
    enablerName: 'ways to flicker your permanents',
    payoffName: 'creatures worth re-entering play',
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
    blurb: 'Lands are the engine. You play extra lands, fetch them out of the library and return them to your hand, while payoff cards fire every time one comes down — so the most ordinary thing in Magic starts winning games.',
    enablerName: 'ways to play extra lands',
    payoffName: 'cards that trigger on lands',
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
 * A Commander deck is 99 cards: roughly 36 lands and 63 spells, of which
 * `ROLE_TARGETS.commander` in `deckProfiles` claims 31 (10 ramp, 10 draw,
 * 8 removal, 3 wipes). That leaves about 32 slots for the theme itself, and a
 * theme cannot fill them from fewer than ten cards on its thinner side without
 * repeating itself into a deck that does one thing badly.
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
/**
 * A theme written by the person building the deck, from phrases of card text.
 *
 * The built-in themes are a small fixed set; any deck plan they do not cover
 * — "cards in your graveyard", "whenever you cycle", "Equipment" — could not
 * be asked for at all. So a theme can be two phrases: what the payoffs say,
 * and (optionally) what the cards feeding them say. Commas separate
 * alternatives, so "mill, surveil" is either.
 *
 * Matched as whole words, case-insensitively, against the same self-reference
 * -stripped, reminder-free text every other theme reads, plus the type line,
 * so "Equipment" and "Zombie" work as phrases too. With one phrase, every
 * match counts as both halves: there is nothing else to pair it with, and the
 * min(enablers, payoffs) strength would otherwise always be zero.
 *
 * The phrases live in the key itself — `custom:<payoff>|<enabler>`,
 * URI-encoded — so a custom theme travels through every place that already
 * carries a theme key, deck plans included, without anything new to store.
 */
const CUSTOM_PREFIX = 'custom:';
const MAX_PHRASES = 5;

function phrasesOf(text) {
  return [...new Set(String(text || '')
    .split(',')
    .map((p) => p.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((p) => p.length >= 2 && p.length <= 60))]
    .slice(0, MAX_PHRASES);
}

function phraseMatcher(phrases) {
  if (phrases.length === 0) return null;
  const patterns = phrases.map((phrase) => {
    const body = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    // Word edges only where the phrase starts or ends with a word character,
    // so "+1/+1" still matches inside "+1/+1 counter". A phrase ending in a
    // word also takes the usual endings: somebody typing "mill" means "mills"
    // and "milled" too, and Thought Scour says "mills".
    return new RegExp(`${/^\w/.test(phrase) ? '\\b' : ''}${body}${/\w$/.test(phrase) ? '(?:s|es|ed|ing)?\\b' : ''}`);
  });
  return (card) => {
    const text = `${effectText(card)}\n${String(card.type_line || '').toLowerCase()}`;
    return patterns.some((pattern) => pattern.test(text));
  };
}

/** The key for a custom theme, or null when the payoff phrase is empty. */
export function customThemeKey(payoffText, enablerText = '') {
  const payoff = phrasesOf(payoffText);
  if (payoff.length === 0) return null;
  const enabler = phrasesOf(enablerText);
  return `${CUSTOM_PREFIX}${encodeURIComponent(payoff.join(', '))}|${encodeURIComponent(enabler.join(', '))}`;
}

export const isCustomThemeKey = (key) => typeof key === 'string' && key.startsWith(CUSTOM_PREFIX);

/** A custom theme from its key, or null when the key does not parse. */
export function customTheme(key) {
  if (!isCustomThemeKey(key) || key.length > 600) return null;
  const [rawPayoff, rawEnabler = ''] = key.slice(CUSTOM_PREFIX.length).split('|');
  let payoffText;
  let enablerText;
  try {
    payoffText = decodeURIComponent(rawPayoff);
    enablerText = decodeURIComponent(rawEnabler);
  } catch {
    return null;
  }

  const payoff = phrasesOf(payoffText);
  const enabler = phrasesOf(enablerText);
  if (payoff.length === 0) return null;

  const quote = (list) => list.map((p) => `“${p}”`).join(' or ');
  const payoffMatches = phraseMatcher(payoff);
  const enablerMatches = enabler.length ? phraseMatcher(enabler) : payoffMatches;

  return {
    // Rebuilt from the cleaned phrases, so two spellings of one theme share a key.
    key: customThemeKey(payoffText, enablerText),
    label: enabler.length ? `your theme: ${quote(payoff)} fed by ${quote(enabler)}` : `your theme: ${quote(payoff)}`,
    // For sentences that name the theme in passing — a swap's reason — where
    // the full phrase list would be most of the sentence.
    shortLabel: 'your theme',
    blurb: enabler.length
      ? `Your own theme. The deck is built around cards whose text says ${quote(payoff)}, `
        + `fed by cards that say ${quote(enabler)}. Matched on the words alone, so check the examples.`
      : `Your own theme. The deck is built around cards whose text says ${quote(payoff)}. `
        + 'With one phrase every match counts as both halves. Matched on the words alone, so check the examples.',
    enablerName: enabler.length ? `cards that say ${quote(enabler)}` : `cards that say ${quote(payoff)}`,
    payoffName: enabler.length ? `cards that say ${quote(payoff)}` : 'of them, counted as both halves',
    custom: { payoff, enabler },
    enabler: enablerMatches,
    payoff: payoffMatches,
  };
}

export function tribeTheme(subtype) {
  const name = String(subtype);
  const needle = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(
    `(${needle}s? you control|other ${needle}s?\\b|each ${needle}\\b|${needle} creatures?\\b|${needle}s? you)`
  );

  return {
    key: `tribe:${name}`,
    label: `${name} tribal`,
    // Written from the type rather than picked from a table: there are
    // hundreds of creature types and any list of hand-written blurbs would be
    // missing the one somebody's collection is deepest in. Nothing here
    // pluralises the type — English does not agree with itself about Elves,
    // Dwarves and Sphinxes, and "Elfs" in the first line of an explanation
    // costs more trust than the phrasing saves.
    blurb: `A deck of one creature type. You play as much ${name} as your `
      + `collection holds and then the cards that specifically reward `
      + `${name} — the ones that pump every one of them, or trigger when `
      + `another arrives, or search your library for the next. The type is `
      + `the deck's glue, so cards that would be unremarkable on their own `
      + `get much better together.`,
    enablerName: `${name} creatures you own`,
    payoffName: `cards that name ${name}`,
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
    // Carried through rather than looked up again by the caller: a tribal
    // theme is built on the fly and exists nowhere for a caller to look it up
    // in, so the wording has to travel with the analysis or it is lost.
    blurb: theme.blurb || '',
    enablerName: theme.enablerName || 'enablers',
    payoffName: theme.payoffName || 'payoffs',
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
