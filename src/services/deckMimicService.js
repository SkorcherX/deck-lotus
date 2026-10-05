/**
 * Rebuilding someone else's deck out of your own collection.
 *
 * A list imported from a deck site is a plan written in cards you mostly do
 * not own. The generator answers "what deck do my cards make?"; this answers
 * a narrower question — "how close can my cards get to *that* deck?" — so it
 * walks the list card by card instead of filling role quotas.
 *
 * ── Every card gets one of three answers ────────────────────────────────────
 *
 *   owned       you have it, and a copy is free to use
 *   stand-in    you do not, and this card from your collection does the most
 *               similar job — with the reasons it was picked
 *   missing     nothing you own is close enough to call a replacement
 *
 * "Close" is built from things that can be checked rather than guessed: the
 * same role predicates the generator and revisionSwaps use (removal, draw,
 * ramp, …), the same theme enabler/payoff split from cardSynergyService (mill,
 * sacrifice, tokens, …), the card type, the mana value, keywords, creature
 * types and size. A stand-in that shares none of the jobs is labelled `loose`
 * — it keeps the curve and the card count honest, and says so, rather than
 * passing itself off as an answer.
 *
 * ── Assignment is global ─────────────────────────────────────────────────────
 *
 * Same reason as `pairSwaps`: every (missing card, owned card) pair is scored
 * and the best taken first. Card by card, the first removal spell in the list
 * would take your only Murder even when a later one needed it more.
 *
 * Pure — rows in, result out — so it is testable where better-sqlite3 will
 * not build. Rows keep their database column names.
 */

import {
  isLand, isCreature, isRamp, isCardAdvantage, isSelection, isCreatureRemoval,
  isPermanentRemoval, isSweeper, isPermission, isDiscard, isGraveyardHate,
  isTutor, isRecursion, isProtection, isFinisher,
} from './cardRoleService.js';
import { THEMES, themeRole, subtypesOf, withinColorIdentity, rankThemes } from './cardSynergyService.js';
import { isLegalIn, landProduces } from './deckGeneratorService.js';
import { isBasicLand } from './basicLands.js';

const mvOf = (card) => Number(card.cmc) || 0;
const COLOR_NAMES = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colourless' };

/**
 * The jobs a card can share with another. Broader than the generator's four
 * quota roles: a mimic is asked to match a specific card, and "a counterspell
 * for a counterspell" is a much better answer than "interaction for
 * interaction".
 */
const MIMIC_ROLES = [
  ['sweeper', 'board wipe', isSweeper],
  ['creature-removal', 'creature removal', isCreatureRemoval],
  ['permanent-removal', 'removal for non-creatures', isPermanentRemoval],
  ['counter', 'counterspell', isPermission],
  ['discard', 'discard', isDiscard],
  ['draw', 'card draw', isCardAdvantage],
  ['selection', 'card selection', isSelection],
  ['ramp', 'mana ramp', isRamp],
  ['tutor', 'tutor', isTutor],
  ['recursion', 'recursion', isRecursion],
  ['protection', 'protection', isProtection],
  ['graveyard-hate', 'graveyard hate', isGraveyardHate],
  ['finisher', 'way to win', isFinisher],
];
const ROLE_LABEL = Object.fromEntries(MIMIC_ROLES.map(([code, label]) => [code, label]));

const CARD_TYPES = ['creature', 'planeswalker', 'instant', 'sorcery', 'artifact', 'enchantment', 'battle', 'land'];

function mainType(card) {
  const line = String(card.type_line || '').toLowerCase();
  return CARD_TYPES.find((type) => line.includes(type)) || null;
}

function keywordsOf(card) {
  const raw = card.keywords;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return list.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
}

const stat = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Everything the scoring reads, worked out once per card. */
function profile(card, format) {
  const land = isLand(card);
  const themes = {};
  if (!land) {
    for (const [key, theme] of Object.entries(THEMES)) {
      const role = themeRole(card, theme);
      if (role) themes[key] = role;
    }
  }
  return {
    card,
    land,
    type: mainType(card),
    mv: mvOf(card),
    roles: land ? [] : MIMIC_ROLES.filter(([, , matches]) => matches(card)).map(([code]) => code),
    themes,
    keywords: keywordsOf(card),
    subtypes: isCreature(card) ? subtypesOf(card) : [],
    power: stat(card.power),
    toughness: stat(card.toughness),
    produces: land ? [...landProduces(card, format)] : [],
  };
}

const themeName = (key) => THEMES[key]?.shortLabel || THEMES[key]?.label || key;
const sideName = (key, role) => {
  const theme = THEMES[key];
  if (!theme) return key;
  if (role === 'payoff') return theme.payoffName || `${themeName(key)} payoff`;
  if (role === 'enabler') return theme.enablerName || `${themeName(key)} enabler`;
  return `${themeName(key)} (both halves)`;
};

/**
 * How well `cand` stands in for `src`, with the reasons. Null when the two
 * should never pair: a land for a spell, or the reverse.
 */
export function scoreStandIn(src, cand, deckThemes = []) {
  if (src.land !== cand.land) return null;

  const why = [];
  let score = 0;
  let strong = false;

  if (src.land) {
    const shared = src.produces.filter((c) => cand.produces.includes(c));
    score += shared.length * 3;
    if (shared.length) {
      strong = true;
      why.push(`also makes ${shared.map((c) => COLOR_NAMES[c] || c).join(', ')}`);
    }
    if (cand.produces.length >= 2 && src.produces.length >= 2) score += 1;
    return { score, strong, why: why.length ? why : ['a land in your colours'] };
  }

  const sharedRoles = src.roles.filter((code) => cand.roles.includes(code));
  if (sharedRoles.length) {
    score += sharedRoles.length * 5;
    strong = true;
    why.push(`both ${sharedRoles.map((code) => ROLE_LABEL[code]).join(', ')}`);
  }

  for (const [key, role] of Object.entries(src.themes)) {
    const theirs = cand.themes[key];
    if (!theirs) continue;
    const sameSide = theirs === role || theirs === 'both' || role === 'both';
    score += sameSide ? 4 : 1.5;
    strong = true;
    why.push(sameSide ? `both ${sideName(key, role === 'both' ? theirs : role)}` : `also part of ${themeName(key)}`);
  }

  // The deck's own plan: a card serving it is worth something even where the
  // card being replaced was doing something else.
  for (const key of deckThemes) {
    if (cand.themes[key] && !src.themes[key]) {
      score += 1.5;
      why.push(`fits the deck's ${themeName(key)} plan`);
    }
  }

  if (src.type && src.type === cand.type) {
    score += 2;
  }

  if (src.type === 'creature' && cand.type === 'creature'
      && src.power != null && cand.power != null && src.toughness != null && cand.toughness != null) {
    const gap = Math.abs(src.power - cand.power) + Math.abs(src.toughness - cand.toughness);
    score += Math.max(-2, 1.5 - gap * 0.5);
    if (gap <= 1) why.push(`similar body (${cand.power}/${cand.toughness} for ${src.power}/${src.toughness})`);
  }

  const sharedKeywords = src.keywords.filter((k) => cand.keywords.includes(k));
  if (sharedKeywords.length) {
    // Keywords are jobs too: flying for flying is the evasion the list was built on.
    score += Math.min(5, sharedKeywords.length * 2.5);
    why.push(`both have ${sharedKeywords.slice(0, 3).join(', ')}`);
  }

  const sharedTypes = src.subtypes.filter((t) => cand.subtypes.includes(t));
  if (sharedTypes.length) {
    score += 1.5;
    why.push(`both ${sharedTypes.slice(0, 2).join(' ')}`);
  }

  const diff = cand.mv - src.mv;
  score -= Math.abs(diff) * 0.75;
  if (diff === 0) why.push(`same mana value (${src.mv})`);
  else why.push(`${Math.abs(diff)} ${diff < 0 ? 'cheaper' : 'more expensive'}`);

  if (!strong) {
    why.unshift(`nothing you own does what ${src.card.name} does; closest by type and cost`);
  }

  return { score, strong, why };
}

/** Non-land cards by mana value, 0–7+, for comparing curves. */
function curveOf(entries) {
  const curve = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const { card, quantity } of entries) {
    if (isLand(card)) continue;
    curve[Math.min(7, Math.floor(mvOf(card)))] += quantity;
  }
  return curve;
}

function roleCounts(entries) {
  const counts = {};
  for (const { card, quantity } of entries) {
    if (isLand(card)) continue;
    for (const [code, , matches] of MIMIC_ROLES) {
      if (matches(card)) counts[code] = (counts[code] || 0) + quantity;
    }
  }
  return counts;
}

/** Loose stand-ins below this are not worth calling a replacement. */
export const MIN_STAND_IN_SCORE = -1;

/**
 * @param source  [{ card, quantity }] — the deck being copied, mainboard only,
 *                commander excluded (it is handled by the caller)
 * @param pool    owned card rows with `available` (getGeneratorPool's shape)
 * @param options { format, identity } — identity null means unrestricted
 */
export function mimicDeck(source, pool, { format = null, identity = null } = {}) {
  const singleton = ['commander', 'brawl', 'standardbrawl', 'oathbreaker', 'duel'].includes(String(format || '').toLowerCase());
  const maxCopies = singleton ? 1 : 4;

  const left = new Map(pool.map((row) => [row.name, Math.max(0, Number(row.available) || 0)]));
  const poolByName = new Map(pool.map((row) => [row.name, row]));
  const sourceNames = new Set(source.map((entry) => entry.card.name));

  const owned = [];
  const basics = [];
  const open = [];

  // 1. Exact copies first. Basics pass straight through: they are free.
  for (const { card, quantity } of source) {
    if (isBasicLand(card)) {
      basics.push({ card, quantity });
      continue;
    }
    const have = poolByName.get(card.name);
    const take = have ? Math.min(quantity, left.get(card.name) || 0) : 0;
    if (take > 0) {
      left.set(card.name, left.get(card.name) - take);
      owned.push({ card: have, quantity: take });
    }
    if (quantity - take > 0) {
      open.push({ src: profile(card, format), want: quantity - take, partial: take > 0 });
    }
  }

  // The deck's plan, read off the list as written, so stand-ins can lean
  // towards it.
  const deckThemes = rankThemes(source.map((e) => e.card), { includeTribes: false })
    .filter((t) => t.viable || t.strength >= 3)
    .slice(0, 2)
    .map((t) => t.key);

  // 2. Everything else you own that may legally go in.
  const candidates = pool
    .filter((row) => !sourceNames.has(row.name) && (left.get(row.name) || 0) > 0)
    .filter((row) => !identity || withinColorIdentity(row, identity))
    .filter((row) => isLegalIn(row, format))
    .map((row) => ({ prof: profile(row, format), left: Math.min(maxCopies, left.get(row.name)) }));

  const pairs = [];
  for (const o of open) {
    for (const c of candidates) {
      const scored = scoreStandIn(o.src, c.prof, deckThemes);
      if (scored && scored.score >= MIN_STAND_IN_SCORE) pairs.push({ o, c, ...scored });
    }
  }
  pairs.sort((x, y) => y.score - x.score
    || x.o.src.card.name.localeCompare(y.o.src.card.name)
    || x.c.prof.card.name.localeCompare(y.c.prof.card.name));

  const standIns = [];
  for (const { o, c, score, strong, why } of pairs) {
    const quantity = Math.min(o.want, c.left);
    if (quantity <= 0) continue;
    o.want -= quantity;
    c.left -= quantity;
    standIns.push({
      for: o.src.card,
      card: c.prof.card,
      quantity,
      match: strong ? 'close' : 'loose',
      score: Math.round(score * 10) / 10,
      why,
    });
  }

  const missing = open
    .filter((o) => o.want > 0)
    .map((o) => ({ card: o.src.card, quantity: o.want }));

  const built = [
    ...owned,
    ...standIns.map((s) => ({ card: s.card, quantity: s.quantity })),
    ...basics,
  ];
  const sourceEntries = source;

  const before = roleCounts(sourceEntries);
  const after = roleCounts(built);
  const roleComparison = MIMIC_ROLES
    .map(([code, label]) => ({ code, label, original: before[code] || 0, mimic: after[code] || 0 }))
    .filter((r) => r.original > 0 || r.mimic > 0);

  const count = (entries) => entries.reduce((sum, e) => sum + e.quantity, 0);

  return {
    owned,
    standIns,
    missing,
    basics,
    deckThemes: deckThemes.map((key) => ({ key, label: themeName(key) })),
    summary: {
      originalCards: count(sourceEntries),
      ownedCards: count(owned) + count(basics),
      standInCards: count(standIns),
      closeStandIns: count(standIns.filter((s) => s.match === 'close')),
      missingCards: count(missing),
      curve: { original: curveOf(sourceEntries), mimic: curveOf(built) },
      roles: roleComparison,
    },
  };
}
