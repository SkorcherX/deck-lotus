/**
 * What a card *does*, worked out from its printed text.
 *
 * Every function here is pure and takes a card row as it comes back from the
 * cards table — name, type_line, oracle_text, keywords, cmc, mana_cost. No
 * database, no network, so this is the one part of the deck advisor that can
 * be exercised on a machine where better-sqlite3 refuses to build.
 *
 * These are heuristics over English oracle text and they will misclassify.
 * That is tolerable only because every finding built on them carries the card
 * names it was based on, so a player can see the reasoning and disagree with
 * it. Nothing here may ever be phrased to the player as a fact.
 */

const textOf = (card) => String(card.oracle_text || '').toLowerCase();
const typeOf = (card) => String(card.type_line || '').toLowerCase();
const mvOf = (card) => Number(card.cmc) || 0;

/** The card's own name, escaped, so self-references can be stripped. */
function selfReference(card) {
  const name = String(card.name || '');
  if (!name) return null;
  return new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
}

/**
 * Oracle text with the card's own name removed.
 *
 * Cards refer to themselves by name constantly ("Whenever Chalice of the Void
 * ..."), and leaving that in makes patterns match on the name rather than the
 * effect — a card called "Counterspell Collector" should not read as removal.
 */
export function effectText(card) {
  const self = selfReference(card);
  const raw = textOf(card);
  const named = self ? raw.replace(self, 'this') : raw;

  // Reminder text goes too, and it is worth being precise about why. The
  // parenthetical after a keyword is a definition of the keyword, not a thing
  // the card does in the deck you are putting it in. Read literally it makes
  // every cycling land a card-selection spell — "(Discard this card: Draw a
  // card.)" — and every basic landcycler a ramp spell. Measured over the
  // 34,656 cards with rules text, that was 202 of 1,518 selection matches and
  // 129 of 1,048 ramp matches; removal was untouched, because removal never
  // hides in reminder text.
  //
  // The cost is the handful of tokens whose abilities live only in reminders —
  // Treasure and Powerstone — so the predicates that care name those tokens
  // directly instead.
  return named.replace(/\([^)]*\)/g, ' ');
}

const keywordsOf = (card) => {
  const raw = card.keywords;
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) return parsed.map((k) => String(k).toLowerCase());
  } catch { /* keywords may be a plain comma-joined string */ }
  return String(raw).split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
};

const hasKeyword = (card, keyword) => keywordsOf(card).includes(keyword.toLowerCase());

// --- Type predicates -------------------------------------------------------

export const isLand = (card) => /\bland\b/.test(typeOf(card));
export const isBasicLand = (card) => isLand(card) && /\bbasic\b/.test(typeOf(card));
export const isCreature = (card) => /\bcreature\b/.test(typeOf(card));
export const isInstantOrSorcery = (card) => /\b(instant|sorcery)\b/.test(typeOf(card));
export const isArtifact = (card) => /\bartifact\b/.test(typeOf(card));
export const isPlaneswalker = (card) => /\bplaneswalker\b/.test(typeOf(card));

/** The broad card types this card has, used by delirium-style requirements. */
export function cardTypes(card) {
  const found = new Set();
  const type = typeOf(card);
  for (const name of ['land', 'creature', 'artifact', 'enchantment', 'instant', 'sorcery', 'planeswalker', 'battle']) {
    if (new RegExp(`\\b${name}\\b`).test(type)) found.add(name);
  }
  return found;
}

// --- Cost predicates -------------------------------------------------------

/**
 * Can this be cast without paying its mana cost — the Force of Will pattern?
 *
 * Part 2 of the guide treats these as their own category: they are the only
 * interaction that works on turn one on the draw, and they are also the reason
 * a deck can quietly be down several cards by turn three.
 */
export function hasAlternativeCost(card) {
  const text = effectText(card);
  return /without paying its mana cost/.test(text)
    || /rather than pay this spell's mana cost/.test(text)
    || /you may (exile|discard|pay|sacrifice|reveal)[^.]{0,60}rather than pay/.test(text);
}

/** Costs less under a condition — delve, affinity, "costs {1} less", and friends. */
export function hasCostReduction(card) {
  const text = effectText(card);
  if (/costs? \{\d+\} less/.test(text)) return true;
  return ['delve', 'convoke', 'improvise', 'affinity', 'emerge', 'evoke', 'madness', 'escape', 'foretell', 'miracle']
    .some((keyword) => hasKeyword(card, keyword) || new RegExp(`\\b${keyword}\\b`).test(text));
}

/**
 * Playable before you have lands: Leylines, Chancellors, and anything else that
 * starts the game in play or works from the opening hand.
 */
export function isTurnZero(card) {
  const text = effectText(card);
  return /you may begin the game with this on the battlefield/.test(text)
    || /if this is in your opening hand/.test(text);
}

/** Castable on turn one off a single land, or for free. */
export function isTurnOnePlay(card) {
  if (isLand(card)) return false;
  return hasAlternativeCost(card) || mvOf(card) <= 1;
}

// --- Role predicates -------------------------------------------------------

export function isPermission(card) {
  return /counter target/.test(effectText(card));
}

export function isCreatureRemoval(card) {
  const text = effectText(card);
  return /(destroy|exile) target[^.]{0,40}creature/.test(text)
    || /(destroy|exile) target[^.]{0,40}(nonland )?permanent/.test(text)
    // The toughness has to actually come down. Fleeting Distraction's -1/-0 is
    // a combat trick, and counting it as removal let it fill a removal slot.
    || /target creature[^.]{0,30}gets -(\d+|x)\/-(?!0\b)(\d+|x)/.test(text)
    || /deals \d+ damage to (target creature|any target)/.test(text)
    || /target creature.{0,40}(fights|its controller sacrifices)/.test(text);
}

/** Removal that reaches past creatures — the Part 6 lesson about Prismatic Ending. */
export function isPermanentRemoval(card) {
  const text = effectText(card);
  return /(destroy|exile) target[^.]{0,40}(artifact|enchantment|planeswalker|nonland permanent|permanent)/.test(text)
    || /(destroy|exile) target[^.]{0,40}land\b/.test(text)
    || /return target (nonland )?permanent[^.]{0,30}to (its owner's|their owner's) hand/.test(text)
    // Tucking answers a permanent as completely as destroying it, and answers
    // the indestructible ones it cannot destroy — Chaos Warp is the staple.
    || /shuffles? (it|target[^.]{0,30}permanent) into (their|its owner's|that player's) library/.test(text);
}

/**
 * A board wipe: something that removes several permanents at once.
 *
 * The first version of this ended with `each (creature|player sacrifices)`,
 * and that one clause matched 1,127 cards on its own — almost all of them
 * "put a +1/+1 counter on each creature you control" and other pump. It made
 * `isSweeper` fire on 4.7% of every card printed, so the deck generator filled
 * its three board-wipe slots with Abzan Falconer and Plumb the Forbidden.
 * Counting creatures is not sweeping them, and the clause is gone.
 *
 * What replaced it names what has to be swept rather than excluding the zones
 * it must not touch. The exclusion approach threw away Farewell, whose modes
 * include exiling all graveyards *and* all creatures; requiring a board noun
 * keeps it while still passing over Rest in Peace ("exile all graveyards") and
 * Divining Witch ("exile all other cards revealed this way").
 *
 * Measured over the 34,656 cards with rules text: 779 matches against the old
 * 1,641, catching 36 of 36 hand-labelled sweepers with none of 24 hand-labelled
 * non-sweepers.
 */
export function isSweeper(card) {
  const text = effectText(card);

  // Overload rewrites "target" as "each", so an overloaded removal spell hits
  // the whole board — Damn and Cyclonic Rift read as spot removal until the
  // keyword. It has to be removal though: Teleportal is overloaded too and
  // pumps your own team.
  if (/\boverload\b/.test(text)
    && /\b(destroy|exile) target|deals? \d+ damage to target|return target|target [^.]{0,30}gets? -\d+\/-\d+/.test(text)) return true;

  // Mass destruction or exile of things on the board.
  if (/\b(destroy|exile) (all|each)[^.]{0,40}\b(creature|permanent|artifact|enchantment|planeswalker|land|token|nonland|nontoken|blocking|attacking)/.test(text)) return true;

  // Mass bounce — Evacuation, River's Rebuke, Flood of Tears.
  if (/\breturn all\b[^.]{0,60}\bto (its|their) owner/.test(text)) return true;

  // Mass sacrifice. Living Death and Slaughter the Strong empty the board
  // without destroying anything, and a symmetric edict taking several apiece
  // is a wipe where one apiece is only removal.
  if (/sacrifices? all\b[^.]{0,60}\b(creature|permanent|artifact|enchantment|land)/.test(text)) return true;
  if (/each player sacrifices (two|three|four|five|six|seven|eight|nine|ten|\d+)\b/.test(text)) return true;

  // Mass shrink. X rather than a digit so Toxic Deluge counts, and the
  // one-sided wording so Massacre Wurm does. The toughness has to actually
  // come down: Cumber Stone's -1/-0 kills nothing and is an anthem in reverse,
  // not a wipe.
  if (/\b(all creatures|creatures (you|your opponents?|target player)[^.]{0,20}control)\b[^.]{0,30}\bgets? -(\d+|x)\/-(?!0\b)(\d+|x)/.test(text)) return true;

  // Mass damage — Blasphemous Act, Anger of the Gods. X as well as a digit,
  // for Fault Line and the other scaling burn.
  if (/deals? (\d+|x) damage to (each|all) creature/.test(text)) return true;

  return false;
}

export function isDiscard(card) {
  const text = effectText(card);
  return /target (player|opponent)[^.]{0,40}discards/.test(text)
    || /each opponent discards/.test(text)
    || /(target player|that player) reveals their hand[^.]{0,60}(you choose|choose a)/.test(text);
}

/**
 * Graveyard hate, in the Part 4 sense: cards brought in specifically to shut a
 * graveyard deck off, not merely cards that mention graveyards.
 */
export function isGraveyardHate(card) {
  const text = effectText(card);
  return /exile[^.]{0,50}(all cards from|target card from|each|a|their|that player's)[^.]{0,20}graveyard/.test(text)
    || /if a card would be put into (a|an opponent's|their) graveyard[^.]{0,40}exile it instead/.test(text)
    || /players can't cast (spells|cards) from graveyards/.test(text)
    || /cards in graveyards (lose all|can't)/.test(text)
    || /exile (all|target player's) graveyard/.test(text);
}

/**
 * Card selection: smooths what you draw without adding to it.
 *
 * Part 2 makes the point that this is what lets a deck run fewer lands, and
 * Part 8 makes the point that it is emphatically not card advantage. The two
 * are counted separately everywhere in this codebase for that reason.
 */
export function isSelection(card) {
  const text = effectText(card);
  if (/\bscry\b|\bsurveil\b/.test(text)) return true;
  if (/look at the top \w+ cards? of your library/.test(text)) return true;
  // A cheap spell whose whole job is replacing itself while digging.
  return mvOf(card) <= 2 && !isCreature(card) && /draw (a|two) cards?/.test(text)
    && /(put|return|reveal|look at|shuffle|discard)/.test(text);
}

/** Net extra cards — the thing Part 8 says is genuinely hard to come by. */
export function isCardAdvantage(card) {
  const text = effectText(card);

  // More than one card at once. The count was `\w+`, which matches any word at
  // all — "draw no cards" and "draw those cards" counted the same as "draw
  // three cards".
  // `draws` as well as `draw`: Sign in Blood reads "target player draws two
  // cards", and the missing s was enough to lose it.
  const many = /draws? (two|three|four|five|six|seven|x|that many) cards?|draws? cards equal to/;
  // "discards their hand, then draws seven" is a wheel: it refills a hand it
  // emptied, and nobody is up a card.
  const manyDiscard = /discards? (two|three|four|five|six|seven|x|that many|your hand|their hand)/;
  if (many.test(text) && !manyDiscard.test(text)) return true;

  // A recurring draw is an engine even at one card a turn, but only when it
  // actually recurs. The old arm accepted any trigger within eighty characters
  // of "draw a card", which made card advantage out of "whenever this creature
  // becomes blocked, you may draw a card" — a conditional that fires when an
  // opponent allows it. An upkeep or end-step trigger fires by itself.
  if (/at the beginning of[^.]{0,60}draw a card/.test(text)) return true;

  // Triggers broad enough to fire most turns in most decks. Enumerated rather
  // than accepting any "whenever", because the difference between an engine
  // and a lottery ticket is how often the trigger happens.
  // The window is wide because the condition sits between the trigger and the
  // draw: Guardian Project spends sixty characters on "if it doesn't have the
  // same name as..." before it gets to drawing. `casts` covers the Rhystic
  // Study family, where the trigger is an opponent's spell rather than yours.
  if (/whenever[^.]{0,60}\b(you cast|casts|enters|dies|attacks|deals combat damage to a player)\b[^.]{0,120}draws? a card/.test(text)) return true;

  // Deliberately not caught: Fact or Fiction and its family, which reveal a
  // pile and take it without ever saying "draw". Every pattern loose enough to
  // reach across its three sentences also matches "reveal the top four cards,
  // put a creature card into your hand" — a tutor, which is one card for one
  // card. Part 8's whole point is that selection and advantage are different
  // things, and conflating them here would undo that everywhere the advisor
  // counts them separately. A handful of missed cards is the cheaper error.

  // Regrowth: a card back from the graveyard is a card gained.
  return /return[^.]{0,40}from your graveyard to your hand/.test(text);
}

export function isTutor(card) {
  const text = effectText(card);
  return /search your library for a[^.]{0,60}card/.test(text) && !/basic land/.test(text);
}

export function isRamp(card) {
  if (isLand(card)) return false;
  const text = effectText(card);

  // Mana this card makes itself: rocks, dorks and rituals alike. Both the
  // symbol form and the words, since Birds of Paradise and Arcane Signet say
  // "add one mana of any color" and never print a symbol. "Spend this mana
  // only to..." is the exception — a source that cannot cast the deck's
  // spells is not acceleration.
  if (/\badd \{|add one mana of any/.test(text)
    && !/spend this mana only to\b/.test(text)) return true;

  // Treasure and Powerstone are deliberately not counted. They tap for mana,
  // so the case for including them is real, but 431 of the cards that make one
  // are creatures that sometimes produce a Treasure off a conditional trigger
  // — "whenever this attacks, roll a d20; on 1-9 create a Treasure" — and that
  // is not a mana source. Separating those from the spells cast *for* their
  // Treasures needs to know which clause the trigger governs, and clause
  // splitting gets it wrong whenever the trigger and the effect are separate
  // sentences, which is most of them. The rest of this function already offers
  // the generator some 1,300 candidates, so the honest trade is to leave the
  // ambiguous ones out rather than to guess at them.

  // Putting a land onto the battlefield is ramp. Searching one to *hand* is
  // fixing — it costs a card and a turn and accelerates nothing — which is
  // what basic landcycling does, and it used to count here. The land is named
  // by type as often as by the word "land": Farseek and Three Visits never say
  // "land card" at all.
  const LAND = '(land|forest|island|swamp|mountain|plains) card';
  if (new RegExp(`search your library for[^.]{0,50}${LAND}[^.]{0,80}onto the battlefield`).test(text)) return true;
  if (new RegExp(`put[^.]{0,30}${LAND}[^.]{0,40}from your hand onto the battlefield`).test(text)) return true;

  // Extra land drops. "two additional lands" is the same effect as one.
  if (/play (an|one|two|three) additional land/.test(text)) return true;

  return false;
}

/** Fast mana: ramp cheap enough to deploy something the turn it lands. */
export function isFastMana(card) {
  return isRamp(card) && mvOf(card) <= 1;
}

export function isTax(card) {
  return /costs? \{\d+\} more/.test(effectText(card));
}

export function isManaDenial(card) {
  const text = effectText(card);
  return /destroy target land/.test(text)
    || /sacrifices? a land/.test(text)
    || /target land[^.]{0,30}doesn't untap/.test(text);
}

export function isRecursion(card) {
  return /return[^.]{0,60}from (your|a) graveyard to (your hand|the battlefield)/.test(effectText(card));
}

export function isProtection(card) {
  const text = effectText(card);
  return /counter target spell[^.]{0,40}that targets/.test(text)
    || /gains? (hexproof|shroud|indestructible|protection)/.test(text);
}

/** An alternate-win line, or a threat big or evasive enough to end things. */
export function isFinisher(card) {
  const text = effectText(card);
  if (/you win the game/.test(text)) return true;
  if (/loses the game/.test(text)) return true;
  if (!isCreature(card)) return false;

  const power = Number(card.power);
  if (!Number.isFinite(power)) return /\*/.test(String(card.power || '')); // Tarmogoyf-likes
  const evasive = /\b(flying|trample|menace|shadow|fear|intimidate|unblockable|can't be blocked)\b/.test(text)
    || ['flying', 'trample', 'menace'].some((k) => hasKeyword(card, k));
  return power >= 5 || (power >= 3 && evasive);
}

/** Any card that answers something the opponent is doing. */
export function isInteraction(card) {
  return isPermission(card) || isCreatureRemoval(card) || isPermanentRemoval(card)
    || isSweeper(card) || isDiscard(card) || isGraveyardHate(card) || isManaDenial(card);
}

/** Interaction that still works when the opponent kills you on turn one or two. */
export function isFreeInteraction(card) {
  return isInteraction(card) && (hasAlternativeCost(card) || mvOf(card) <= 1);
}

/**
 * Which permanent types this card's answers can reach.
 *
 * Part 6's warning is that a deck whose only answer type is "creature" simply
 * loses to Chalice of the Void, Blood Moon or Ensnaring Bridge, so the set
 * matters more than the count.
 */
export function answerTargets(card) {
  const text = effectText(card);
  const found = new Set();

  if (isCreatureRemoval(card) || isSweeper(card)) found.add('creature');
  if (/(destroy|exile) target[^.]{0,40}artifact/.test(text)) found.add('artifact');
  if (/(destroy|exile) target[^.]{0,40}enchantment/.test(text)) found.add('enchantment');
  if (/(destroy|exile) target[^.]{0,40}planeswalker/.test(text)) found.add('planeswalker');
  if (/(destroy|exile) target[^.]{0,40}land\b/.test(text) || isManaDenial(card)) found.add('land');
  if (isGraveyardHate(card)) found.add('graveyard');
  if (isPermission(card)) found.add('stack');

  // "Target permanent" and "target nonland permanent" reach nearly everything,
  // so they cover the categories a creature-only removal suite misses.
  if (/(destroy|exile) target[^.]{0,20}(nonland )?permanent/.test(text)) {
    for (const target of ['creature', 'artifact', 'enchantment', 'planeswalker']) found.add(target);
  }

  return found;
}

/**
 * The colours a card's mana cost actually asks for, and how many pips of each.
 *
 * Colour identity is the wrong measure for a mana base — it counts reminder
 * text and activated abilities, so a card you can always cast reads as though
 * it needs a colour you never have to produce.
 */
export function costPips(manaCost) {
  const pips = {};
  for (const match of String(manaCost || '').matchAll(/\{([^}]+)\}/g)) {
    const symbol = match[1].toUpperCase();
    // A hybrid symbol can be paid several ways, so it demands no single colour.
    const options = symbol.split('/').filter((s) => 'WUBRG'.includes(s) && s.length === 1);
    if (options.length !== 1) continue;
    pips[options[0]] = (pips[options[0]] || 0) + 1;
  }
  return pips;
}

/**
 * Role filters shared with the inventory panel.
 *
 * The SQL is an approximation of the predicate beside it — good enough to put
 * plausible cards in front of someone, and deliberately kept next to the
 * predicate it mirrors so the two do not quietly drift apart.
 */
export const ROLE_FILTERS = {
  'removal-permanent': {
    label: 'removal that hits non-creatures',
    matches: isPermanentRemoval,
    sql: `(oracle_text LIKE '%destroy target artifact%'
        OR oracle_text LIKE '%destroy target enchantment%'
        OR oracle_text LIKE '%destroy target permanent%'
        OR oracle_text LIKE '%exile target permanent%'
        OR oracle_text LIKE '%destroy target nonland permanent%'
        OR oracle_text LIKE '%exile target nonland permanent%')`
  },
  'graveyard-hate': {
    label: 'graveyard hate',
    matches: isGraveyardHate,
    sql: `(oracle_text LIKE '%graveyard%' AND oracle_text LIKE '%exile%')`
  },
  'card-advantage': {
    label: 'card advantage',
    matches: isCardAdvantage,
    sql: `(oracle_text LIKE '%draw two cards%'
        OR oracle_text LIKE '%draw three cards%'
        OR oracle_text LIKE '%draw that many cards%')`
  },
  'interaction': {
    label: 'interaction',
    matches: isInteraction,
    sql: `(oracle_text LIKE '%counter target%'
        OR oracle_text LIKE '%destroy target%'
        OR oracle_text LIKE '%exile target%'
        OR oracle_text LIKE '%discards%')`
  },
  'instant-sorcery': {
    label: 'instants and sorceries',
    matches: isInstantOrSorcery,
    sql: `(type_line LIKE '%Instant%' OR type_line LIKE '%Sorcery%')`
  },
  'finisher': {
    label: 'ways to win',
    matches: isFinisher,
    sql: `(oracle_text LIKE '%you win the game%'
        OR (type_line LIKE '%Creature%' AND CAST(power AS INTEGER) >= 5))`
  }
};
