/**
 * Proposing a deck from what somebody already owns.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 *
 * It is not a solver, and deliberately not. The published approach to this
 * problem reaches for CP-SAT and maximises a weighted sum of card scores; that
 * needs a second language runtime in the container, and it optimises the wrong
 * thing. A sum ranks a theme by its abundant half and will happily return 66
 * lifegain cards and two payoffs — see the note at the top of
 * `cardSynergyService.js`. What a deck needs is *balance*, and balance is a
 * shape, not a maximum.
 *
 * So: bucketed greedy fill against the role targets in `deckProfiles`, ranked
 * within each bucket by fit with the chosen theme, then the theme's own slots
 * filled while holding the enabler-to-payoff ratio. Plain arithmetic, no new
 * runtime, and every choice can be explained to the person reading it.
 *
 * ── It proposes, it never asserts ───────────────────────────────────────────
 *
 * Everything here rests on heuristics over English oracle text, which will
 * misclassify. So the output is a *proposal* carrying its reasoning: which
 * theme was chosen and on what evidence, which role each card was picked to
 * fill, and — the part that matters most — every quota the collection could
 * not meet. It never throws for an unbuildable request. A collection that
 * cannot fill 8 removal slots gets a deck with 5 and a shortfall saying so,
 * because "here is what you have and here is the gap" is useful and "could not
 * assemble a legal deck" is not.
 *
 * ── Availability ────────────────────────────────────────────────────────────
 *
 * The pure core takes an `available` count per card and never questions it.
 * Working out that number is the database layer's job, and it is not a simple
 * subtraction: per `deckPriority.js`, a generated deck is an idea and may only
 * claim cards that decks *at least as committed as an idea* have not taken.
 * Basic lands are free and are added by the mana base, not drawn from stock.
 *
 * The core is pure — rows in, proposal out — so it runs where better-sqlite3
 * will not build. Rows keep their database column names (`type_line`,
 * `oracle_text`, `color_identity`, ...) so they can be passed straight from a
 * query into `cardRoleService` and `cardSynergyService` without translation.
 */

import {
  isLand, isRamp, isCardAdvantage, isSelection,
  isCreatureRemoval, isPermanentRemoval, isSweeper, costPips, hasAlternativeCost,
} from './cardRoleService.js';

import {
  THEMES, tribeTheme, synergyScore, themeRole,
  withinColorIdentity, viableThemes, rankThemes,
} from './cardSynergyService.js';

import { isBasicLand } from './basicLands.js';
import { getRoleTargets, getFormatProfile, colorSourcesWanted } from '../config/deckProfiles.js';

const COLORS = ['W', 'U', 'B', 'R', 'G'];
const COLOR_NAMES = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
const BASIC_FOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

const mvOf = (card) => Number(card.cmc) || 0;

/**
 * The role codes in `ROLE_TARGETS`, mapped to the predicates that fill them.
 *
 * Order is the order they are filled in, and it is not arbitrary: the scarcest
 * job goes first. Sweepers are the rarest thing in most collections, and a
 * deck that spends its last slots on them ends up with whatever sweeper was
 * left rather than the best one. Ramp goes last because ramp is abundant
 * everywhere and picking it early would strand cheap cards that also count as
 * ramp but do a better job elsewhere.
 */
const ROLE_PREDICATES = [
  ['sweeper', 'board wipes', isSweeper],
  ['removal', 'spot removal', (card) => isCreatureRemoval(card) || isPermanentRemoval(card)],
  ['draw', 'card draw', (card) => isCardAdvantage(card) || isSelection(card)],
  ['ramp', 'mana ramp', isRamp],
];

/**
 * What colours a land can tap for.
 *
 * Read from the type line first — a Sacred Foundry is a "Mountain Plains" and
 * says nothing else about mana — then from the text, which covers the rest.
 * The dual-land types are checked before the text because a fetchland's text
 * names lands it searches for rather than mana it makes.
 */
export function landProduces(card) {
  const produced = new Set();
  const typeLine = String(card.type_line || '');

  for (const [color, basic] of Object.entries(BASIC_FOR)) {
    if (new RegExp(`\\b${basic}\\b`).test(typeLine)) produced.add(color);
  }
  if (produced.size > 0) return produced;

  const text = String(card.oracle_text || '');
  // "{T}: Add {W}." and the many variants, including "Add one mana of any
  // color", which is every colour at once.
  if (/add one mana of any color|add one mana of any type/i.test(text)) {
    for (const color of COLORS) produced.add(color);
    return produced;
  }
  for (const match of text.matchAll(/add[^.]{0,40}?\{([WUBRG])\}/gi)) {
    produced.add(match[1].toUpperCase());
  }
  return produced;
}

/**
 * The colour demands of a set of spells, as the Karsten tables want them.
 *
 * The pips and the turn have to come from the *same card*. Taking the most
 * pips of a colour anywhere in the deck together with the earliest turn any
 * card of that colour is cast produces a requirement no card actually makes: a
 * one-drop asking for {B} and a five-drop asking for {B}{B} combine into "two
 * black pips on turn one", which wants 33 sources in a 100-card deck and
 * cannot be satisfied by construction. That is not a strict reading of the
 * deck, it is a wrong one, and it reports every mana base as broken.
 *
 * So each card proposes its own (turn, pips) pair and the pair demanding the
 * most sources wins — the same approach `colorRequirements` takes in
 * `deckAdvisorService`, for the same reason.
 */
export function colorDemands(cards, deckSize = 100) {
  const demands = {};

  for (const card of cards) {
    // A card castable without paying its cost makes no claim on the mana
    // base: Force of Will's {U}{U} is never paid.
    if (hasAlternativeCost(card)) continue;

    const pips = costPips(card.mana_cost);
    // Mana value stands in for the turn it is cast, capped at the last turn
    // the Karsten tables describe.
    const turn = Math.max(1, Math.min(5, Math.ceil(mvOf(card)) || 1));

    for (const [color, count] of Object.entries(pips)) {
      const wanted = colorSourcesWanted(turn, count, deckSize);
      const seen = demands[color];

      if (!seen) {
        demands[color] = { pips: count, turn, cards: 1, wanted };
        continue;
      }

      seen.cards += 1;
      // The pair demanding the most sources wins — see the note above about
      // why the two halves may not be maximised separately.
      if (wanted > seen.wanted) {
        seen.pips = count;
        seen.turn = turn;
        seen.wanted = wanted;
      }
    }
  }

  return demands;
}

/**
 * Rank the cards competing for one slot.
 *
 * Theme fit first — that is the whole point of choosing a theme. Cheaper next,
 * because a curve that skews expensive is the most common way a generated deck
 * is unplayable and the cheapest card that does the job is nearly always the
 * right one. `edhrec_rank` is the last resort only, and it is popularity
 * rather than power: with a thousand cards there will be genuine ties, and
 * breaking them by what most people play is better than breaking them by
 * whatever order SQLite returned.
 */
function rankCandidates(cards, theme) {
  return [...cards].sort((a, b) => {
    if (theme) {
      const fit = synergyScore(b, theme) - synergyScore(a, theme);
      if (fit !== 0) return fit;
    }
    const cost = mvOf(a) - mvOf(b);
    if (cost !== 0) return cost;

    const rankA = Number.isFinite(Number(a.edhrec_rank)) ? Number(a.edhrec_rank) : Infinity;
    const rankB = Number.isFinite(Number(b.edhrec_rank)) ? Number(b.edhrec_rank) : Infinity;
    if (rankA !== rankB) return rankA - rankB;

    return String(a.name).localeCompare(String(b.name));
  });
}

/** Resolve a theme key against the built-in themes and the pool's tribes. */
export function resolveTheme(themeKey, pool) {
  if (!themeKey) return null;
  if (THEMES[themeKey]) return { key: themeKey, ...THEMES[themeKey] };
  if (String(themeKey).startsWith('tribe:')) return tribeTheme(String(themeKey).slice(6));

  // A key naming a creature type directly, which is what a caller is likeliest
  // to send by hand.
  const named = rankThemes(pool).find((t) => t.tribe === themeKey);
  return named ? tribeTheme(named.tribe) : null;
}

/**
 * Build a deck from a pool.
 *
 * @param pool     card rows with database column names, each carrying an
 *                 `available` count of copies free to spend.
 * @param options  commander (a card row, Commander only), format, identity,
 *                 themeKey, and overrides for land count and deck size.
 */
export function buildDeck(pool, {
  commander = null,
  format = 'commander',
  identity = null,
  themeKey = null,
  landCount = null,
  deckSize = null,
} = {}) {
  const targets = getRoleTargets(format);
  const profile = getFormatProfile(format);
  const size = deckSize || targets.deckSize;
  const lands = landCount ?? targets.lands;
  const maxCopies = targets.singleton ? 1 : (targets.maxCopies || 4);

  // The commander sets the colour identity unless one was given outright.
  const colorIdentity = identity
    ?? (commander ? String(commander.color_identity || '').toUpperCase() : null);

  const shortfalls = [];
  const notes = [];

  // --- The legal pool ------------------------------------------------------
  //
  // Basic lands are dropped here and re-added by the mana base. They are free
  // and unlimited (see basicLands.js), so leaving them in the spell pool would
  // let the generator fill removal slots with Islands that scored zero on
  // everything and happened to sort first.
  const legal = pool.filter((card) => {
    if (!card || !card.name) return false;
    if (commander && card.card_id != null && card.card_id === commander.card_id) return false;
    if (commander && card.name === commander.name) return false;
    if (isBasicLand(card)) return false;
    if (colorIdentity != null && !withinColorIdentity(card, colorIdentity)) return false;
    return (card.available ?? 0) > 0;
  });

  const spellPool = legal.filter((card) => !isLand(card));
  const landPool = legal.filter((card) => isLand(card));

  // --- The theme -----------------------------------------------------------
  let theme = resolveTheme(themeKey, spellPool);
  if (!theme) {
    const best = viableThemes(spellPool, { identity: colorIdentity, limit: 1 })[0];
    if (best) {
      theme = best.key && best.key.startsWith('tribe:')
        ? tribeTheme(best.tribe)
        : { key: best.key, ...THEMES[best.key] };
    }
  }

  const themeReport = theme
    ? rankThemes(spellPool, { identity: colorIdentity }).find((t) => t.label === theme.label) || null
    : null;

  if (!theme) {
    notes.push(
      'No theme in these colours was dense enough to build around, so cards were '
      + 'chosen for their role alone.'
    );
  }

  // --- Fill --------------------------------------------------------------
  const spellSlots = Math.max(0, size - lands - (commander ? 1 : 0));
  const chosen = [];
  const taken = new Map(); // name -> copies chosen
  const reasons = new Map(); // name -> why it was picked

  const copiesLeft = (card) => Math.min(maxCopies, card.available ?? 0) - (taken.get(card.name) || 0);

  const take = (card, reason) => {
    if (chosen.length >= spellSlots || copiesLeft(card) <= 0) return false;
    chosen.push(card);
    taken.set(card.name, (taken.get(card.name) || 0) + 1);
    if (!reasons.has(card.name)) reasons.set(card.name, reason);
    return true;
  };

  // Role quotas first. These are what stop a themed deck from being a theme
  // and nothing else — a graveyard deck still has to answer a creature.
  const roleCounts = {};
  for (const [code, label, matches] of ROLE_PREDICATES) {
    const want = targets.roles[code] || 0;
    roleCounts[code] = 0;
    if (want <= 0) continue;

    for (const card of rankCandidates(spellPool.filter(matches), theme)) {
      if (roleCounts[code] >= want || chosen.length >= spellSlots) break;
      if (copiesLeft(card) <= 0) continue;
      if (take(card, label)) roleCounts[code] += 1;
    }

    if (roleCounts[code] < want) {
      shortfalls.push({
        kind: 'role',
        code,
        label,
        wanted: want,
        found: roleCounts[code],
        // Said as a gap in the collection, not as a fault in the deck.
        message: `Wanted ${want} ${label}, found ${roleCounts[code]} in your collection.`,
      });
    }
  }

  // Then the theme's own slots, holding the enabler-to-payoff ratio rather
  // than maximising either. Roughly two enablers per payoff: a deck of
  // payoffs has nothing to trigger them, and a deck of enablers has nothing to
  // reward it.
  if (theme) {
    const remaining = () => spellSlots - chosen.length;
    const unchosen = () => spellPool.filter((card) => copiesLeft(card) > 0);

    let enablers = chosen.filter((c) => ['enabler', 'both'].includes(themeRole(c, theme))).length;
    let payoffs = chosen.filter((c) => ['payoff', 'both'].includes(themeRole(c, theme))).length;

    while (remaining() > 0) {
      // Whichever half is further behind its share of the ratio gets the slot.
      const wantPayoff = payoffs * 2 <= enablers;
      const wanted = wantPayoff ? ['payoff', 'both'] : ['enabler', 'both'];

      const candidates = rankCandidates(
        unchosen().filter((card) => wanted.includes(themeRole(card, theme))),
        theme
      );

      const picked = candidates.find((card) => copiesLeft(card) > 0);
      if (!picked) break;

      take(picked, `${theme.label} (${wantPayoff ? 'payoff' : 'enabler'})`);
      const role = themeRole(picked, theme);
      if (role === 'both') { enablers += 1; payoffs += 1; }
      else if (role === 'payoff') payoffs += 1;
      else enablers += 1;
    }

    if (spellSlots - chosen.length > 0) {
      shortfalls.push({
        kind: 'theme',
        code: theme.key || 'theme',
        label: theme.label,
        wanted: spellSlots,
        found: chosen.length,
        message: `Ran out of ${theme.label} cards ${spellSlots - chosen.length} slots short; `
          + 'the rest were filled with the best remaining cards.',
      });
    }
  }

  // Anything still empty is filled with the best cards left, so a thin
  // collection still gets a complete deck rather than a truncated one.
  for (const card of rankCandidates(spellPool, theme)) {
    if (chosen.length >= spellSlots) break;
    if (copiesLeft(card) <= 0) continue;
    take(card, 'filling out the deck');
  }

  if (chosen.length < spellSlots) {
    shortfalls.push({
      kind: 'size',
      code: 'spells',
      wanted: spellSlots,
      found: chosen.length,
      message: `Only ${chosen.length} of ${spellSlots} spell slots could be filled from your `
        + 'collection in these colours.',
    });
  }

  // --- Mana base -----------------------------------------------------------
  const manaBase = buildManaBase({
    spells: chosen,
    landPool,
    landCount: lands,
    deckSize: size,
    colorIdentity,
    maxCopies,
  });

  // --- Report --------------------------------------------------------------
  const averageMv = chosen.length
    ? chosen.reduce((sum, c) => sum + mvOf(c), 0) / chosen.length
    : 0;

  if (averageMv > profile.avgMv[1]) {
    notes.push(
      `Average mana value is ${averageMv.toFixed(2)}, above the ${profile.avgMv[1]} that is `
      + `usual for ${format}. Your collection may be short of cheap cards in these colours.`
    );
  }

  const groupedSpells = groupByName(chosen, reasons);

  return {
    format,
    colorIdentity,
    commander: commander ? { name: commander.name, cardId: commander.card_id ?? null } : null,
    theme: theme
      ? {
        key: theme.key || null,
        label: theme.label,
        tribe: theme.tribe || null,
        // The evidence, per the rule that nothing built on these heuristics is
        // stated without it.
        enablers: themeReport ? themeReport.enablers : null,
        payoffs: themeReport ? themeReport.payoffs : null,
        strength: themeReport ? themeReport.strength : null,
      }
      : null,
    mainboard: groupedSpells,
    lands: manaBase.lands,
    summary: {
      totalCards: chosen.length + manaBase.total + (commander ? 1 : 0),
      spells: chosen.length,
      lands: manaBase.total,
      averageMv: Number(averageMv.toFixed(2)),
      roles: roleCounts,
      curve: curveOf(chosen),
    },
    shortfalls: [...shortfalls, ...manaBase.shortfalls],
    notes,
  };
}

/** Copies of each distinct card, with the reason it was chosen. */
function groupByName(cards, reasons) {
  const grouped = new Map();
  for (const card of cards) {
    const seen = grouped.get(card.name);
    if (seen) { seen.quantity += 1; continue; }
    grouped.set(card.name, {
      name: card.name,
      cardId: card.card_id ?? null,
      printingId: card.printing_id ?? null,
      manaCost: card.mana_cost || null,
      cmc: mvOf(card),
      typeLine: card.type_line || null,
      quantity: 1,
      reason: reasons.get(card.name) || null,
    });
  }
  return [...grouped.values()];
}

/** How many spells sit at each mana value, 7+ collapsed. */
function curveOf(cards) {
  const curve = {};
  for (const card of cards) {
    const bucket = Math.min(7, Math.floor(mvOf(card)));
    curve[bucket] = (curve[bucket] || 0) + 1;
  }
  return curve;
}

/**
 * Lands for a chosen set of spells.
 *
 * Owned nonbasic lands go in first, preferring the ones producing the most
 * colours the deck actually asks for — a dual land is worth more than an extra
 * basic precisely because it covers two demands with one slot. Basics fill the
 * rest, split by how much each colour is wanted rather than evenly, and the
 * result is checked against the Karsten targets so a colour that came out short
 * is reported rather than silently shipped.
 *
 * A land producing a colour the deck does not want is skipped: it is a
 * colourless land in this deck, and there is no reason to prefer it over a
 * basic that casts something.
 */
export function buildManaBase({
  spells, landPool, landCount, deckSize, colorIdentity, maxCopies = 1,
}) {
  const demands = colorDemands(spells, deckSize);
  const wantedColors = Object.keys(demands);
  const shortfalls = [];
  const chosen = [];
  const taken = new Map();

  const useful = (card) => {
    const produces = landProduces(card);
    return [...produces].filter((color) => wantedColors.includes(color)).length;
  };

  const ranked = [...landPool]
    .filter((card) => useful(card) > 0 || landProduces(card).size === 0)
    .sort((a, b) => {
      // Most useful colours first; a land that makes no colour at all (a
      // utility land) sorts last but is still ahead of nothing.
      const byUse = useful(b) - useful(a);
      if (byUse !== 0) return byUse;
      return String(a.name).localeCompare(String(b.name));
    });

  for (const card of ranked) {
    if (chosen.length >= landCount) break;
    const limit = Math.min(maxCopies, card.available ?? 0);
    if ((taken.get(card.name) || 0) >= limit) continue;
    chosen.push(card);
    taken.set(card.name, (taken.get(card.name) || 0) + 1);
  }

  const nonbasics = groupByName(chosen, new Map());

  // Basics, split by each colour's share of the demand.
  const basicSlots = Math.max(0, landCount - chosen.length);
  const weights = {};
  let weightTotal = 0;
  for (const color of wantedColors) {
    weights[color] = demands[color].cards;
    weightTotal += weights[color];
  }

  const basics = [];
  let assigned = 0;
  for (const color of wantedColors) {
    if (basicSlots <= 0 || weightTotal <= 0) break;
    const share = Math.round((weights[color] / weightTotal) * basicSlots);
    if (share <= 0) continue;
    basics.push({ name: BASIC_FOR[color], quantity: share, isBasic: true, color });
    assigned += share;
  }

  // Rounding leaves a slot or two either way; put them on the most-wanted
  // colour rather than leaving the deck at 35 lands.
  if (basics.length > 0 && assigned !== basicSlots) {
    const heaviest = basics.reduce((a, b) => (a.quantity >= b.quantity ? a : b));
    heaviest.quantity = Math.max(0, heaviest.quantity + (basicSlots - assigned));
  }

  // A colourless deck, or one whose spells ask for nothing, still needs lands.
  if (basics.length === 0 && basicSlots > 0 && colorIdentity) {
    const fallback = [...colorIdentity].filter((c) => COLORS.includes(c));
    if (fallback.length > 0) {
      const each = Math.floor(basicSlots / fallback.length);
      for (const color of fallback) basics.push({ name: BASIC_FOR[color], quantity: each, isBasic: true, color });
      basics[0].quantity += basicSlots - each * fallback.length;
    }
  }

  // --- Does the mana actually work? ----------------------------------------
  const sources = {};
  for (const color of wantedColors) sources[color] = 0;

  for (const land of chosen) {
    for (const color of landProduces(land)) {
      if (sources[color] != null) sources[color] += 1;
    }
  }
  for (const basic of basics) {
    if (sources[basic.color] != null) sources[basic.color] += basic.quantity;
  }

  for (const color of wantedColors) {
    const want = colorSourcesWanted(demands[color].turn, demands[color].pips, deckSize);
    if (sources[color] < want) {
      shortfalls.push({
        kind: 'mana',
        code: `sources-${color}`,
        label: `${COLOR_NAMES[color]} sources`,
        wanted: want,
        found: sources[color],
        message: `${sources[color]} ${COLOR_NAMES[color]} sources, against the ${want} usually `
          + `wanted for a ${demands[color].pips}-pip card on turn ${demands[color].turn}.`,
      });
    }
  }

  const basicTotal = basics.reduce((sum, b) => sum + b.quantity, 0);

  return {
    lands: [...nonbasics, ...basics.filter((b) => b.quantity > 0)],
    total: chosen.length + basicTotal,
    sources,
    demands,
    shortfalls,
  };
}
