/**
 * Advice about a deck, as distinct from the rules that make it legal.
 *
 * The checks here come from docs/DECK_ANALYSIS_PRINCIPLES.md, which distils
 * Reid Duke's eight-part Legacy guide into things a program can count. Two
 * rules govern everything in this file:
 *
 *   1. A finding is an observation with numbers attached, never a verdict.
 *      "14 of your own cards cost 1" is useful; "your deck is bad" is not.
 *   2. Every finding carries the cards it was built from, because the role
 *      classification behind it is heuristic and will sometimes be wrong. A
 *      player who can see the reasoning can dismiss it; one who can't will
 *      stop reading the panel altogether.
 *
 * `analyzeDeck` is pure — rows in, analysis out. That keeps it testable on a
 * machine where the SQLite driver will not build.
 */

import {
  isLand, isBasicLand, isCreature, isInstantOrSorcery, isArtifact,
  isPermission, isCreatureRemoval, isPermanentRemoval, isSweeper, isDiscard,
  isGraveyardHate, isSelection, isCardAdvantage, isManaDenial, isFinisher,
  isInteraction, isFreeInteraction, isTax, isTurnZero, isTurnOnePlay,
  hasAlternativeCost, hasCostReduction, answerTargets, costPips
} from './cardRoleService.js';

import {
  getFormatProfile, colorSourcesWanted, DECK_REQUIREMENTS, SYMMETRY_HAZARDS
} from '../config/deckProfiles.js';

const OPENING_HAND = 7;

// --- Small helpers ---------------------------------------------------------

const qty = (list) => list.reduce((sum, c) => sum + (c.quantity || 1), 0);
const mvOf = (card) => Number(card.cmc) || 0;
const names = (list, limit = 8) => list.slice(0, limit).map((c) => ({
  name: c.name,
  quantity: c.quantity || 1
}));

/** C(n, k), stable for the deck sizes we deal with. */
function choose(n, k) {
  if (k < 0 || k > n || n < 0) return 0;
  let result = 1;
  for (let i = 0; i < k; i += 1) result = (result * (n - i)) / (i + 1);
  return result;
}

/** Probability of drawing none of `hits` in an opening hand. */
function pNone(deckSize, hits, handSize = OPENING_HAND) {
  if (deckSize < handSize) return 0;
  return choose(deckSize - hits, handSize) / choose(deckSize, handSize);
}

/**
 * Probability an opening seven contains at least one land and at least one
 * play for turn one. Inclusion-exclusion over two disjoint groups — exact, and
 * cheaper than simulating.
 */
function pLandAndPlay(deckSize, lands, plays) {
  if (deckSize < OPENING_HAND || lands === 0 || plays === 0) return 0;
  const p = 1 - pNone(deckSize, lands) - pNone(deckSize, plays) + pNone(deckSize, lands + plays);
  return Math.max(0, Math.min(1, p));
}

/** Probability of a keepable land count (2–5) in an opening seven. */
function pKeepableLands(deckSize, lands) {
  if (deckSize < OPENING_HAND) return 0;
  const total = choose(deckSize, OPENING_HAND);
  if (total === 0) return 0;
  let hits = 0;
  for (let k = 2; k <= 5; k += 1) {
    hits += choose(lands, k) * choose(deckSize - lands, OPENING_HAND - k);
  }
  return Math.max(0, Math.min(1, hits / total));
}

/**
 * Expand quantities into one entry per copy.
 *
 * Probabilities and density ratios are about cards in the library, so a
 * four-of has to count four times. Role counts use the same expansion so the
 * two can never disagree about what "12 cantrips" means.
 */
function expand(cards) {
  const out = [];
  for (const card of cards) {
    for (let i = 0; i < (card.quantity || 1); i += 1) out.push(card);
  }
  return out;
}

// --- Metrics ---------------------------------------------------------------

/**
 * How many lands a deck of this size wants.
 *
 * Average cost is the starting point, then card selection pulls it down: Part
 * 2 of the guide is explicit that cantrips are why an efficient deck can run
 * fourteen lands and still cast its spells, because a one-land opener is
 * keepable when half your deck digs.
 */
function suggestedLandCount(deckSize, averageSpellCost, selectionDensity) {
  let base = deckSize >= 100 ? 36 : 17;

  if (averageSpellCost <= 1.9) base -= 1;
  else if (averageSpellCost <= 2.6) base += 0;
  else if (averageSpellCost <= 3.3) base += 1;
  else base += 2;

  if (selectionDensity >= 0.25) base -= 2;
  else if (selectionDensity >= 0.15) base -= 1;

  return base;
}

/**
 * Per-colour mana requirements: the most demanding thing each colour is asked
 * to do, and whether the mana base can do it.
 */
function colorRequirements(spellCopies, landCopies, deckSize) {
  const byColor = new Map();

  for (const card of spellCopies) {
    // A pitched spell never pays its coloured pips, so Force of Will's {U}{U}
    // is not a demand on the mana base at all.
    if (hasAlternativeCost(card)) continue;

    const pips = costPips(card.mana_cost);
    for (const [color, count] of Object.entries(pips)) {
      const entry = byColor.get(color) || { color, needing: 0, turn: 99, pips: 1, examples: [] };
      entry.needing += 1;

      // Mana value stands in for "the turn you want to cast this" — except for
      // a discounted card, whose printed cost says nothing about when it lands.
      // Murktide Regent reads as a seven-drop and is cast on turn three.
      // A discounted card is cast earlier than its printed cost but is rarely
      // the card you must have on curve, so it is treated as a later, softer
      // requirement than a card you actually intend to hard-cast.
      const printedTurn = Math.max(1, Math.min(5, Math.ceil(mvOf(card)) || 1));
      const turn = hasCostReduction(card) ? Math.min(printedTurn, 4) : printedTurn;
      const wanted = colorSourcesWanted(turn, count, deckSize);
      const currentWanted = colorSourcesWanted(entry.turn === 99 ? 5 : entry.turn, entry.pips, deckSize);

      if (entry.turn === 99 || wanted > currentWanted) {
        entry.turn = turn;
        entry.pips = count;
        entry.examples = [card];
      }
      byColor.set(color, entry);
    }
  }

  const results = [];
  for (const entry of byColor.values()) {
    const sources = landCopies.filter((l) => (l.color_identity || '').includes(entry.color)).length;
    results.push({
      ...entry,
      sources,
      wanted: colorSourcesWanted(entry.turn, entry.pips, deckSize)
    });
  }

  return results.sort((a, b) => b.needing - a.needing);
}

/** Payoffs that state a requirement on the rest of the deck (Part 7 and 8). */
function checkRequirements(spells, counts, mainboardSize) {
  const results = [];

  for (const rule of DECK_REQUIREMENTS) {
    const payoffs = spells.filter((c) => rule.pattern.test(String(c.oracle_text || '').toLowerCase()));
    if (payoffs.length === 0) continue;

    const wanted = Math.round(rule.share * mainboardSize);
    const have = counts[rule.needs] || 0;

    results.push({ ...rule, payoffs, wanted, have, met: have >= wanted });
  }

  return results;
}

/** Lock cards that would also hit the deck playing them (Part 6). */
function checkSymmetry(cards, metrics) {
  const results = [];

  for (const hazard of SYMMETRY_HAZARDS) {
    const offenders = cards.filter((c) => hazard.pattern.test(String(c.oracle_text || '').toLowerCase()));
    if (offenders.length === 0) continue;

    let selfHits = 0;
    let detail = '';

    if (hazard.selfHits === 'curveBuckets') {
      // Chalice-likes are set to whichever number hurts most, so report the
      // biggest bucket the deck would be shutting off.
      let worst = 0;
      let worstMv = 0;
      for (const [value, count] of Object.entries(metrics.curveBuckets)) {
        const numeric = Number(value);
        if (numeric >= 1 && numeric <= 3 && count > worst) { worst = count; worstMv = numeric; }
      }
      selfHits = worst;
      detail = `set to ${worstMv}`;
    } else {
      selfHits = metrics[hazard.selfHits] || 0;
    }

    if (selfHits > 0) results.push({ ...hazard, offenders, selfHits, detail });
  }

  return results;
}

/**
 * What the deck is trying to do.
 *
 * Inference is coarse on purpose. Its job is not to label the deck accurately
 * for the player's benefit, but to stop irrelevant advice: a combo deck has no
 * plan B by design, and telling it to add removal is noise.
 */
function inferArchetype(metrics) {
  const { spellCount, creatureCount, interactionCount, avgMv, lockCount, graveyardCount, cheapShare } = metrics;
  if (spellCount === 0) return 'unknown';

  // Distinct cards, not copies: four Chalices is a splash of prison in an
  // otherwise normal deck, whereas four *different* lock pieces is a plan.
  if (lockCount >= 3) return 'prison';
  if (graveyardCount / spellCount >= 0.25) return 'graveyard';

  // A deck whose payoffs demand a critical mass, or which is very cheap with
  // very little interaction, is playing its own game rather than yours.
  if (metrics.requirementsCount > 0 && interactionCount / spellCount < 0.2 && cheapShare >= 0.7) return 'combo';

  const creatureShare = creatureCount / spellCount;
  const interactionShare = interactionCount / spellCount;

  if (interactionShare > 0.4 && creatureShare < 0.25) return 'control';
  if (creatureShare > 0.4 && avgMv < 2.4) return 'aggro';
  if (creatureShare > 0.25 && interactionCount >= 6) return 'midrange';

  return 'unknown';
}

/**
 * Measure a deck.
 *
 * @param mainboard  card rows with a `quantity`
 * @param sideboard  card rows with a `quantity`
 * @param format     format key, used only to pick expectations
 */
export function analyzeDeck(mainboard = [], sideboard = [], format = null) {
  const profile = getFormatProfile(format);

  const copies = expand(mainboard);
  const sideCopies = expand(sideboard);

  const landCopies = copies.filter(isLand);
  const spellCopies = copies.filter((c) => !isLand(c));

  const mainboardSize = copies.length;
  const landCount = landCopies.length;
  const spellCount = spellCopies.length;

  const totalMv = spellCopies.reduce((sum, c) => sum + mvOf(c), 0);
  const avgMv = spellCount > 0 ? totalMv / spellCount : 0;

  const curveBuckets = {};
  for (const card of spellCopies) {
    const bucket = Math.min(7, Math.floor(mvOf(card)));
    curveBuckets[bucket] = (curveBuckets[bucket] || 0) + 1;
  }

  const selectionCopies = spellCopies.filter(isSelection);
  const advantageCopies = spellCopies.filter(isCardAdvantage);
  const interactionCopies = spellCopies.filter(isInteraction);
  const freeInteractionCopies = spellCopies.filter(isFreeInteraction);
  const finisherCopies = spellCopies.filter(isFinisher);
  const turnOneCopies = spellCopies.filter(isTurnOnePlay);
  const turnZeroCopies = spellCopies.filter(isTurnZero);

  const selectionDensity = spellCount > 0 ? selectionCopies.length / spellCount : 0;
  const cheapShare = spellCount > 0
    ? spellCopies.filter((c) => mvOf(c) <= 2).length / spellCount
    : 0;

  // Which kinds of disruption the deck has, as distinct from how much. Part 5:
  // "Permission spells won't do the job on their own."
  const axes = {
    permission: spellCopies.filter(isPermission).length,
    removal: spellCopies.filter(isCreatureRemoval).length,
    permanentRemoval: spellCopies.filter(isPermanentRemoval).length,
    sweepers: spellCopies.filter(isSweeper).length,
    discard: spellCopies.filter(isDiscard).length,
    graveyardHate: spellCopies.filter(isGraveyardHate).length,
    manaDenial: spellCopies.filter(isManaDenial).length
  };
  const disruptionAxes = Object.values(axes).filter((n) => n > 0).length;

  // Breadth is measured over every card, lands included: Wasteland answers a
  // land and Urza's Saga answers an artifact, and a deck holding them is not
  // as narrow as its spell list alone suggests.
  const answerBreadth = new Set();
  for (const card of copies) {
    for (const target of answerTargets(card)) answerBreadth.add(target);
  }

  // Cards expensive enough to need an excuse, that do not have one.
  const cheatEnabler = copies.some((c) => {
    const text = String(c.oracle_text || '').toLowerCase();
    return /put[^.]{0,40}onto the battlefield/.test(text)
      || /return target[^.]{0,40}from (a|your) graveyard to the battlefield/.test(text);
  });

  const expensiveUnexcused = spellCopies.filter((c) =>
    mvOf(c) >= profile.expensive
    && !hasAlternativeCost(c)
    && !hasCostReduction(c)
    && !isFinisher(c)
    && !(cheatEnabler && isCreature(c))
  );

  const counts = {
    instantsSorceries: spellCopies.filter(isInstantOrSorcery).length,
    artifacts: spellCopies.filter(isArtifact).length,
    lands: landCount,
    cheapSpells: spellCopies.filter((c) => mvOf(c) <= 2).length,
    highManaValue: spellCopies.filter((c) => mvOf(c) >= 5).length
  };

  const requirements = checkRequirements(spellCopies, counts, mainboardSize);

  const metrics = {
    format: format || null,
    profile,
    mainboardSize,
    landCount,
    spellCount,
    basicCount: landCopies.filter(isBasicLand).length,
    nonbasicLands: landCopies.filter((c) => !isBasicLand(c)).length,
    creatureCount: spellCopies.filter(isCreature).length,
    attackers: spellCopies.filter(isCreature).length,
    avgMv,
    curveBuckets,
    cheapShare,
    selectionCount: selectionCopies.length,
    selectionDensity,
    advantageCount: advantageCopies.length,
    extraDraw: advantageCopies.length,
    interactionCount: interactionCopies.length,
    freeInteractionCount: freeInteractionCopies.length,
    disruptionAxes,
    axes,
    answerBreadth: [...answerBreadth],
    winConditionCount: finisherCopies.length,
    turnZeroCount: turnZeroCopies.length,
    turnOneCount: turnOneCopies.length,
    lockCount: new Set(
      copies
        .filter((c) => isTax(c) || SYMMETRY_HAZARDS.some((h) => h.pattern.test(String(c.oracle_text || '').toLowerCase())))
        .map((c) => c.name)
    ).size,
    graveyardCount: spellCopies.filter((c) => /graveyard/.test(String(c.oracle_text || '').toLowerCase())).length,
    requirementsCount: requirements.length,
    sideboard: {
      size: sideCopies.length,
      graveyardHate: sideCopies.filter(isGraveyardHate).length
    },
    pTurnOnePlay: pLandAndPlay(mainboardSize, landCount, turnOneCopies.length),
    pKeepable: pKeepableLands(mainboardSize, landCount),
    suggestedLands: suggestedLandCount(
      profile.deckSize,
      avgMv,
      selectionDensity
    ),
    // Colour targets are scaled to the deck as it stands rather than to the
    // finished size, so a half-built deck is asked "are you on pace?" instead
    // of being told it is short of a total it was never going to have yet.
    colors: colorRequirements(spellCopies, landCopies, Math.max(mainboardSize, 20)),
    expensiveUnexcused,
    requirements
  };

  metrics.symmetry = checkSymmetry(copies, metrics);
  metrics.archetype = inferArchetype(metrics);

  return metrics;
}

// --- Findings --------------------------------------------------------------

/**
 * Turn measurements into things worth saying.
 *
 * Ordered strengths-last so the panel reads as "here is what to look at, and
 * here is what you already have right" rather than as a list of complaints.
 */
export function buildFindings(metrics) {
  const findings = [];
  const { profile, archetype, mainboardSize, spellCount } = metrics;

  const add = (finding) => findings.push({ action: null, evidence: [], ...finding });
  const scaled = (per60) => Math.round(per60 * (profile.deckSize / 60));

  // A deck barely begun has nothing useful to say about it.
  if (mainboardSize < 20 || spellCount === 0) return findings;

  // --- Mana base ----------------------------------------------------------
  const landGap = metrics.suggestedLands - metrics.landCount;

  if (Math.abs(landGap) >= 3) {
    const because = metrics.selectionDensity >= 0.15
      ? `an average cost of ${metrics.avgMv.toFixed(1)} and ${metrics.selectionCount} cards that dig`
      : `an average cost of ${metrics.avgMv.toFixed(1)}`;

    add({
      code: 'land-count',
      category: 'mana',
      severity: 'consider',
      message: landGap > 0
        ? `Consider ${landGap} more land${landGap === 1 ? '' : 's'} — around ${metrics.suggestedLands} suits ${because}.`
        : `Consider ${-landGap} fewer lands — around ${metrics.suggestedLands} suits ${because}.`,
      action: landGap > 0 ? { label: 'Show your lands', filter: { type: 'Land' } } : null
    });
  }

  // Part 2 and Part 6 both land on the same point: mana denial is something
  // opponents actively do, and a deck with no basics simply loses to it.
  if (metrics.basicCount === 0 && metrics.landCount >= 8 && ['legacy', 'vintage', 'modern'].includes(String(metrics.format))) {
    add({
      code: 'no-basics',
      category: 'mana',
      severity: 'consider',
      message: `No basic lands. Blood Moon, Back to Basics and land destruction turn all ${metrics.landCount} of your lands off at once.`
    });
  }

  const shortColors = metrics.colors.filter(
    (c) => c.needing >= 3 && metrics.landCount > 0 && c.sources < c.wanted
  );

  // Three or more colours coming up short is one problem — too many colours —
  // not three problems. Reporting it once says something the player can act on;
  // reporting it five times buries every other finding in the panel.
  if (shortColors.length >= 3) {
    add({
      code: 'color-support-spread',
      category: 'mana',
      severity: 'warn',
      message: `This deck casts spells in ${metrics.colors.length} colours and none of them has enough sources (${shortColors.map((c) => `${c.color} ${c.sources}/${c.wanted}`).join(', ')}). Cutting a colour is usually easier than fixing the mana.`,
      action: { label: 'Show your lands', filter: { type: 'Land' } }
    });
  } else {
    for (const color of shortColors) {
      const pipLabel = color.pips >= 2 ? `${color.pips} pips of ${color.color}` : `${color.color}`;
      add({
        code: 'color-support',
        category: 'mana',
        severity: color.sources < color.wanted * 0.7 ? 'warn' : 'consider',
        message: `Casting ${pipLabel} on turn ${color.turn} wants about ${color.wanted} sources; you have ${color.sources}.`,
        evidence: names(color.examples),
        action: { label: `Show ${color.color} lands`, filter: { type: 'Land', colors: [color.color] } }
      });
    }
  }

  // --- Turn 0 and turn 1 --------------------------------------------------
  // Opening-hand odds only mean something once the deck is close to its final
  // size; quoting them at 40 cards describes a deck that will never be played.
  const nearlyBuilt = mainboardSize >= profile.deckSize * 0.9;

  if (nearlyBuilt && metrics.landCount > 0) {
    const percent = Math.round(metrics.pTurnOnePlay * 100);

    if (metrics.pTurnOnePlay < 0.45 && profile.clock <= 4) {
      add({
        code: 'turn-one',
        category: 'speed',
        severity: 'warn',
        message: `Only a ${percent}% chance your opening hand has a land and something to do on turn 1. In this format that is usually a turn you cannot spare.`,
        action: { label: 'Show 1-drops', filter: { maxCmc: 1 } }
      });
    } else if (metrics.pTurnOnePlay >= 0.7) {
      add({
        code: 'turn-one-strong',
        category: 'speed',
        severity: 'info',
        message: `${percent}% of opening hands have a land and a turn-1 play${metrics.turnZeroCount > 0 ? `, plus ${metrics.turnZeroCount} cards that work before your first land` : ''}.`
      });
    }

    // A deck full of cantrips keeps one-land hands on purpose, so the bar for
    // "too few lands to keep" moves with how much the deck digs. This is the
    // same reasoning that lets such decks run fourteen lands in the first place.
    const keepableFloor = metrics.selectionDensity >= 0.15 ? 0.55 : 0.68;

    if (metrics.pKeepable < keepableFloor) {
      add({
        code: 'keepable-hands',
        category: 'mana',
        severity: 'consider',
        message: `${Math.round(metrics.pKeepable * 100)}% of opening hands have 2–5 lands. You will be mulliganing more than you would like.`,
        action: { label: 'Show your lands', filter: { type: 'Land' } }
      });
    }
  }

  // --- Curve --------------------------------------------------------------
  const [, mvCeiling] = profile.avgMv;

  if (metrics.avgMv > mvCeiling) {
    add({
      code: 'curve-expensive',
      category: 'curve',
      severity: metrics.avgMv > mvCeiling + 0.5 ? 'warn' : 'consider',
      message: `Average cost is ${metrics.avgMv.toFixed(1)}. Games here are usually decided around turn ${profile.clock}, which suits an average nearer ${mvCeiling.toFixed(1)}.`,
      action: { label: 'Show cheap spells', filter: { maxCmc: 2 } }
    });
  }

  if (metrics.cheapShare < profile.cheapShare - 0.15 && spellCount >= 15) {
    add({
      code: 'curve-top-heavy',
      category: 'curve',
      severity: 'consider',
      message: `${Math.round(metrics.cheapShare * 100)}% of your spells cost 2 or less; decks in this format usually want nearer ${Math.round(profile.cheapShare * 100)}%.`,
      action: { label: 'Show cheap spells', filter: { maxCmc: 2 } }
    });
  }

  if (metrics.expensiveUnexcused.length > scaled(6)) {
    const unique = [...new Map(metrics.expensiveUnexcused.map((c) => [c.name, c])).values()];
    add({
      code: 'expensive-unexcused',
      category: 'curve',
      severity: 'consider',
      message: `${metrics.expensiveUnexcused.length} cards cost ${profile.expensive} or more without a discount, a way to cheat them in, or the ability to end the game on their own.`,
      evidence: names(unique),
      action: { label: 'Show cheap spells', filter: { maxCmc: 2 } }
    });
  }

  // --- Payoffs that need a critical mass ----------------------------------
  // Part 7's central deckbuilding lesson, and the one most likely to be a
  // genuine discovery for someone new.
  for (const requirement of metrics.requirements) {
    const unique = names([...new Map(requirement.payoffs.map((c) => [c.name, c])).values()]);
    // Stated as a share as well as a count, because the count moves while the
    // deck is being built and the share is the thing that actually matters.
    const wantShare = Math.round(requirement.share * 100);
    const haveShare = Math.round((requirement.have / mainboardSize) * 100);
    const atFullSize = Math.round(requirement.share * profile.deckSize);

    if (requirement.met) {
      add({
        code: `requirement-met-${requirement.code}`,
        category: 'synergy',
        severity: 'info',
        message: `${requirement.payoffs[0].name} wants around ${wantShare}% of the deck to be ${requirement.label}; you are at ${haveShare}%.`,
        evidence: unique
      });
      continue;
    }

    add({
      code: `requirement-${requirement.code}`,
      category: 'synergy',
      severity: 'warn',
      message: `${requirement.payoffs[0].name} wants around ${wantShare}% of the deck to be ${requirement.label} — about ${atFullSize} cards at ${profile.deckSize}. You are at ${haveShare}% (${requirement.have}).`,
      evidence: unique,
      action: requirement.filter ? { label: `Show ${requirement.label}`, filter: requirement.filter } : null
    });
  }

  // --- Symmetric locks ----------------------------------------------------
  for (const hazard of metrics.symmetry) {
    const unique = [...new Map(hazard.offenders.map((c) => [c.name, c])).values()];
    add({
      code: `symmetry-${hazard.code}`,
      category: 'symmetry',
      severity: 'warn',
      message: `${unique[0].name} ${hazard.describe}${hazard.detail ? ` — ${hazard.detail}` : ''}, and would hit ${hazard.selfHits} of your own cards.`,
      evidence: names(unique)
    });
  }

  // --- Answer breadth -----------------------------------------------------
  // Suppressed for combo: a deck with no plan B is not supposed to answer
  // things, and saying so every time is how a suggestions panel gets ignored.
  if (archetype !== 'combo' && metrics.interactionCount >= 4) {
    const breadth = new Set(metrics.answerBreadth);
    const missing = ['artifact', 'enchantment', 'planeswalker'].filter((t) => !breadth.has(t));

    if (breadth.has('creature') && missing.length === 3 && !breadth.has('stack')) {
      add({
        code: 'answer-breadth',
        category: 'interaction',
        severity: 'warn',
        message: `All ${metrics.interactionCount} of your answers only hit creatures. A resolved artifact or enchantment — Chalice of the Void, Blood Moon, Ensnaring Bridge — would be game over.`,
        action: { label: 'Show broader removal', filter: { role: 'removal-permanent' } }
      });
    }
  }

  if (archetype !== 'combo' && metrics.interactionCount >= 8 && metrics.disruptionAxes === 1) {
    const only = Object.entries(metrics.axes).find(([, n]) => n > 0);
    add({
      code: 'disruption-axes',
      category: 'interaction',
      severity: 'consider',
      message: `All of your disruption is one kind of card (${only ? only[0] : 'the same effect'}). Mixing in a second kind means one resilient threat doesn't beat you on its own.`,
      action: { label: 'Show interaction', filter: { role: 'interaction' } }
    });
  }

  // --- The four ways games are lost ---------------------------------------
  // Part 2's checklist, and the finding most likely to answer a new player's
  // actual question, which is "why did I lose that game?"
  const gyHateTotal = metrics.axes.graveyardHate + metrics.sideboard.graveyardHate;
  const covers = {
    combo: metrics.freeInteractionCount >= 2 || metrics.axes.discard >= 3 || gyHateTotal >= 3,
    mana: metrics.landCount >= metrics.suggestedLands - 2,
    threat: metrics.interactionCount >= scaled(6),
    grind: metrics.advantageCount >= scaled(3)
  };

  if (archetype !== 'combo') {
    if (!covers.combo) {
      add({
        code: 'loss-mode-combo',
        category: 'coverage',
        severity: 'consider',
        message: 'Nothing here interacts with a deck that wins on turn 1 or 2 — no free answers, little discard, no graveyard hate.',
        action: { label: 'Show graveyard hate', filter: { role: 'graveyard-hate' } }
      });
    }

    if (!covers.threat) {
      add({
        code: 'loss-mode-threat',
        category: 'coverage',
        severity: 'consider',
        message: `${metrics.interactionCount} cards answer anything the opponent does. A single resolved threat you can't remove ends most games.`,
        action: { label: 'Show interaction', filter: { role: 'interaction' } }
      });
    }

    if (!covers.grind) {
      add({
        code: 'loss-mode-grind',
        category: 'coverage',
        severity: 'consider',
        message: `${metrics.advantageCount === 0 ? 'Nothing here draws you extra cards' : `Only ${metrics.advantageCount} cards draw you extra cards`}${metrics.selectionCount > 0 ? ` — card selection (${metrics.selectionCount}) finds your best card but doesn't give you more of them` : ''}. In a long game you run out first.`,
        action: { label: 'Show card advantage', filter: { role: 'card-advantage' } }
      });
    }
  }

  // Held back until the deck is nearly built, or it just restates the land
  // count finding above for every deck that is still being assembled.
  if (!covers.mana && nearlyBuilt) {
    add({
      code: 'loss-mode-mana',
      category: 'coverage',
      severity: 'consider',
      message: 'Between the land count and the colours asked for, the most likely way you lose is simply not casting your spells.'
    });
  }

  // --- Can this deck actually win? ----------------------------------------
  if (metrics.winConditionCount <= 1) {
    add({
      code: 'win-conditions',
      category: 'coverage',
      severity: metrics.winConditionCount === 0 ? 'warn' : 'consider',
      message: metrics.winConditionCount === 0
        ? 'Nothing in this deck obviously ends a game on its own.'
        : 'One card here ends the game on its own. If it is answered, you have no way to close.',
      action: { label: 'Show ways to win', filter: { role: 'finisher' } }
    });
  }

  // --- Strengths ----------------------------------------------------------
  // Naming what a deck already does right is half the point of the panel.
  if (metrics.selectionDensity >= 0.15) {
    add({
      code: 'selection-strength',
      category: 'strength',
      severity: 'info',
      message: `${metrics.selectionCount} cards dig for what you need, which smooths your draws and lets you run a land or two fewer than the curve alone suggests.`
    });
  }

  if (metrics.disruptionAxes >= 3 && metrics.cheapShare >= profile.cheapShare) {
    add({
      code: 'pressure-strength',
      category: 'strength',
      severity: 'info',
      message: `A cheap curve plus ${metrics.disruptionAxes} different kinds of disruption — pressure makes every answer you hold worth more, because the opponent has fewer turns to find one.`
    });
  }

  if (archetype === 'unknown' && mainboardSize >= 40) {
    add({
      code: 'archetype-unclear',
      category: 'coverage',
      severity: 'consider',
      message: 'It is hard to tell what this deck is trying to do — it is not fast enough to race, not interactive enough to control, and has no engine to grind. Picking one of those is usually the biggest single improvement.'
    });
  }

  return findings;
}

const SEVERITY_ORDER = { warn: 0, consider: 1, info: 2 };

/**
 * The whole advisory pass: measurements plus what to say about them.
 *
 * Kept as one entry point so callers cannot accidentally show findings built
 * from a different set of metrics than the ones they render.
 */
export function adviseDeck(mainboard = [], sideboard = [], format = null) {
  const metrics = analyzeDeck(mainboard, sideboard, format);
  const findings = buildFindings(metrics)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    archetype: metrics.archetype,
    findings,
    // A compact snapshot for the header strip — the numbers a player would
    // otherwise have to work out by hand.
    snapshot: {
      mainboardSize: metrics.mainboardSize,
      lands: metrics.landCount,
      suggestedLands: metrics.suggestedLands,
      averageCost: Number(metrics.avgMv.toFixed(2)),
      cheapShare: Number(metrics.cheapShare.toFixed(2)),
      curve: metrics.curveBuckets,
      turnOneChance: Number(metrics.pTurnOnePlay.toFixed(3)),
      keepableChance: Number(metrics.pKeepable.toFixed(3)),
      interaction: metrics.interactionCount,
      freeInteraction: metrics.freeInteractionCount,
      selection: metrics.selectionCount,
      cardAdvantage: metrics.advantageCount,
      winConditions: metrics.winConditionCount,
      answerBreadth: metrics.answerBreadth,
      colors: metrics.colors.map(({ color, needing, turn, pips, sources, wanted }) =>
        ({ color, needing, turn, pips, sources, wanted }))
    }
  };
}
