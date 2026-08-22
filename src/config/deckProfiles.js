/**
 * What "normal" looks like, per format and per archetype.
 *
 * Every threshold the deck advisor uses lives here as data rather than being
 * scattered through the checks, so the numbers can be argued with and tuned
 * without touching any logic. They are all received wisdom, not rules — the
 * source for most of them is Reid Duke's eight-part Legacy guide, distilled in
 * docs/DECK_ANALYSIS_PRINCIPLES.md.
 */

/**
 * `clock` is the turn by which a deck must have meaningfully affected the
 * game. It is what makes a curve good or bad: an average cost of 3.4 is
 * unremarkable in Standard and unplayable in Legacy.
 *
 * `expensive` is the cost above which a card has to justify itself — by ending
 * the game on its own, by being discounted, or by being cheated into play.
 */
export const FORMAT_PROFILES = {
  legacy:    { clock: 3,  avgMv: [1.4, 2.3], expensive: 4, cheapShare: 0.60, deckSize: 60 },
  vintage:   { clock: 2,  avgMv: [1.2, 2.0], expensive: 4, cheapShare: 0.65, deckSize: 60 },
  modern:    { clock: 4,  avgMv: [1.8, 2.6], expensive: 4, cheapShare: 0.55, deckSize: 60 },
  pioneer:   { clock: 5,  avgMv: [2.0, 3.0], expensive: 5, cheapShare: 0.50, deckSize: 60 },
  standard:  { clock: 6,  avgMv: [2.2, 3.4], expensive: 5, cheapShare: 0.45, deckSize: 60 },
  pauper:    { clock: 5,  avgMv: [1.8, 2.8], expensive: 4, cheapShare: 0.55, deckSize: 60 },
  commander: { clock: 10, avgMv: [2.8, 4.0], expensive: 6, cheapShare: 0.30, deckSize: 100 }
};

/** Used when the deck has no format set — deliberately permissive. */
export const DEFAULT_PROFILE = { clock: 5, avgMv: [1.8, 3.2], expensive: 5, cheapShare: 0.45, deckSize: 60 };

export function getFormatProfile(format) {
  return FORMAT_PROFILES[String(format || '').toLowerCase()] || DEFAULT_PROFILE;
}

/**
 * Coloured sources wanted for a given colour requirement, by the turn you need
 * it, for a 60-card deck. Frank Karsten's numbers, rounded.
 *
 * This replaces a flat "a quarter of your lands" rule, which is far too
 * forgiving for a double-pip two-drop and far too strict for a light splash.
 */
export const COLOR_SOURCE_TARGETS = {
  1: { 1: 14, 2: 20, 3: 23 },
  2: { 1: 13, 2: 20, 3: 23 },
  3: { 1: 12, 2: 18, 3: 23 },
  4: { 1: 11, 2: 16, 3: 20 },
  5: { 1: 10, 2: 15, 3: 19 }
};

/**
 * How many sources a colour requirement wants, scaled to the deck size.
 *
 * @param turn   the earliest turn a card needing this colour is cast
 * @param pips   the most pips of this colour demanded at that turn
 */
export function colorSourcesWanted(turn, pips, deckSize = 60) {
  const byTurn = COLOR_SOURCE_TARGETS[Math.min(Math.max(turn, 1), 5)] || COLOR_SOURCE_TARGETS[3];
  const base = byTurn[Math.min(Math.max(pips, 1), 3)] || byTurn[1];
  return Math.round(base * (deckSize / 60));
}

/**
 * Cards whose text states a requirement on the rest of the deck.
 *
 * This is Part 7's lesson generalised: Delver wants a high density of instants
 * and sorceries, and so does every other payoff that counts something. Each
 * minimum is a share of the mainboard rather than a raw count, so it scales
 * from 60 cards to 100 without needing a second table.
 */
export const DECK_REQUIREMENTS = [
  {
    code: 'instants-sorceries',
    // Delver of Secrets and its many descendants.
    pattern: /reveal an instant or sorcery card|instant or sorcery card from it/,
    needs: 'instantsSorceries',
    label: 'instants and sorceries',
    share: 0.40,
    filter: { role: 'instant-sorcery' }
  },
  {
    code: 'high-mana-value',
    // Up the Beanstalk and friends: payoffs that count expensive spells.
    pattern: /mana value 5 or greater/,
    needs: 'highManaValue',
    label: 'cards with mana value 5 or more',
    share: 0.17,
    filter: null
  },
  {
    code: 'artifacts',
    pattern: /metalcraft|three or more artifacts/,
    needs: 'artifacts',
    label: 'artifacts',
    share: 0.27,
    filter: { type: 'Artifact' }
  },
  {
    code: 'graveyard-fill',
    pattern: /threshold|seven or more cards in your graveyard/,
    needs: 'cheapSpells',
    label: 'cheap spells to fill the graveyard',
    share: 0.37,
    filter: { maxCmc: 2 }
  },
  {
    code: 'lands-landfall',
    pattern: /landfall|whenever a land you control enters/,
    needs: 'lands',
    label: 'lands',
    share: 0.40,
    filter: { type: 'Land' }
  },
  {
    code: 'spell-count',
    pattern: /whenever you cast (your first |your second )?(a )?(noncreature )?spell|storm\b/,
    needs: 'cheapSpells',
    label: 'cheap spells',
    share: 0.43,
    filter: { maxCmc: 2 }
  }
];

/**
 * Symmetric lock cards, and what they would also hit in your own deck.
 *
 * Part 6 is explicit that these only work if the deck is "designed to play
 * conveniently around" them. A new player cannot see the cost; this table can.
 */
export const SYMMETRY_HAZARDS = [
  {
    code: 'mana-value-lock',
    pattern: /mana value equal to the number of/,
    describe: 'counters spells by mana value',
    // Reported against the deck's own curve buckets, which the check fills in.
    selfHits: 'curveBuckets'
  },
  {
    code: 'nonbasic-lock',
    pattern: /nonbasic lands are mountains|lands are mountains in addition/,
    describe: 'turns off nonbasic lands',
    selfHits: 'nonbasicLands'
  },
  {
    code: 'spell-tax',
    pattern: /spells? cost \{\d+\} more to cast/,
    describe: 'taxes every spell',
    selfHits: 'spellCount'
  },
  {
    code: 'attack-lock',
    pattern: /creatures? (with power greater than|can't attack unless)/,
    describe: 'stops creatures attacking',
    selfHits: 'attackers'
  },
  {
    code: 'draw-lock',
    pattern: /can't draw more than one card each turn/,
    describe: 'caps card draw',
    selfHits: 'extraDraw'
  },
  {
    code: 'one-spell-lock',
    pattern: /can't cast more than one spell each turn/,
    describe: 'caps spells per turn',
    selfHits: 'cheapSpells'
  }
];

/**
 * Archetype signatures, checked in order — the first match wins.
 *
 * Gating matters more than accuracy here. Part 5 is blunt that a combo deck
 * has no plan B by design, so telling one it needs more removal is exactly the
 * noise that makes a deck checker something people switch off.
 */
export const ARCHETYPES = {
  combo:     { label: 'combo' },
  prison:    { label: 'prison' },
  graveyard: { label: 'graveyard' },
  aggro:     { label: 'aggro' },
  control:   { label: 'control' },
  midrange:  { label: 'midrange' },
  unknown:   { label: 'unclear' }
};
