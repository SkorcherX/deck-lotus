#!/usr/bin/env node
/**
 * Score every Commander deck, every stored precon and a reference cEDH list
 * with src/shared/powerScore.js, and print the spread.
 *
 * This is how the unpublished constants in powerScore.js (EFFICIENCY,
 * SCORE_SCALE) are tuned: unmodified precons are broadly agreed to sit
 * around 4–6 and a tuned cEDH list at 10, so the constants should put them
 * there. When deck_games has enough Commander games, win rate joins the
 * table and becomes the better check.
 *
 * Read-only. Usage:
 *   node scripts/power-score-report.mjs [path/to/deck-lotus.db]
 */
import Database from 'better-sqlite3';
import { scoreDeck } from '../src/shared/powerScore.js';
import { isBasicLand } from '../src/services/basicLands.js';

const dbPath = process.argv[2] || process.env.DATABASE_PATH || 'data/deck-lotus.db';
const db = new Database(dbPath, { readonly: true });

// Lowest USD price for the card across all printings: TCGplayer and Card
// Kingdom (Cardmarket is EUR). Normal first; a foil-only card falls back to
// its foil price.
const cardRow = db.prepare(`
  SELECT c.name, c.cmc, c.type_line, c.supertypes, c.edhrec_rank,
    (SELECT MIN(pr.price) FROM printings p JOIN prices pr ON pr.printing_uuid = p.uuid
      WHERE p.card_id = c.id AND pr.provider IN ('tcgplayer','cardkingdom')
        AND pr.price_type = 'normal' AND pr.price > 0) AS normal_price,
    (SELECT MIN(pr.price) FROM printings p JOIN prices pr ON pr.printing_uuid = p.uuid
      WHERE p.card_id = c.id AND pr.provider IN ('tcgplayer','cardkingdom')
        AND pr.price_type = 'foil' AND pr.price > 0) AS foil_price
  FROM cards c WHERE c.name = ?
`);

// Double-faced cards are stored under "Front // Back"; lists often name the
// front face alone.
const fullName = db.prepare(`SELECT name FROM cards WHERE name LIKE ? LIMIT 1`);

const cache = new Map();
function lookup(name) {
  if (!cache.has(name)) {
    const full = fullName.get(`${name} // %`)?.name;
    cache.set(name, cardRow.get(name) || (full && cardRow.get(full)) || null);
  }
  return cache.get(name);
}

function score(names) {
  const rows = [];
  let missing = 0;
  for (const [name, quantity] of names) {
    const c = lookup(name);
    if (!c) { missing++; continue; }
    rows.push({
      name: c.name,
      cmc: c.cmc,
      quantity,
      isLand: /\bLand\b/.test(c.type_line || ''),
      isBasicLand: isBasicLand(c),
      price: c.normal_price ?? c.foil_price,
      edhrecRank: c.edhrec_rank,
    });
  }
  return { ...scoreDeck(rows), missing };
}

const fmt = (r) => [
  r.powerLevel.toFixed(1).padStart(4),
  Math.round(r.score).toString().padStart(5),
  Math.round(r.impact).toString().padStart(5),
  r.avgCmc.toFixed(2).padStart(5),
  String(r.tippingPoint).padStart(3),
  r.efficiency.toFixed(1).padStart(5),
].join('  ');
const header = 'power  score  impact  avgMV  tip   eff';

// ── Your decks ──────────────────────────────────────────────────────────────
console.log('\nYOUR COMMANDER DECKS');
console.log(`${header}  games  deck`);
const decks = db.prepare(`SELECT d.id, d.name, d.status FROM decks d WHERE d.format = 'commander'`).all();
const deckCards = db.prepare(`
  SELECT c.name, SUM(dc.quantity) AS quantity FROM deck_cards dc
  JOIN printings p ON p.id = dc.printing_id JOIN cards c ON c.id = p.card_id
  WHERE dc.deck_id = ? AND (dc.board_type = 'mainboard' OR dc.is_commander = 1 OR dc.board_type IS NULL AND dc.is_sideboard = 0)
  GROUP BY c.name`);
const games = db.prepare(`SELECT COUNT(*) AS n, SUM(result = 'win') AS w FROM deck_games WHERE deck_id = ?`);
for (const d of decks) {
  const r = score(deckCards.all(d.id).map((x) => [x.name, x.quantity]));
  const g = games.get(d.id);
  const rec = g.n ? `${g.w}/${g.n}` : '-';
  console.log(`${fmt(r)}  ${rec.padStart(5)}  ${d.name} [${d.status}]`);
}

// ── Precons, by year ────────────────────────────────────────────────────────
const precons = db.prepare(`
  SELECT id, name, set_code, substr(release_date, 1, 4) AS year FROM precon_decks
  WHERE type = 'Commander Deck' ORDER BY release_date`).all();
const preconCards = db.prepare(`
  SELECT card_name AS name, SUM(quantity) AS quantity FROM precon_deck_cards
  WHERE precon_deck_id = ? AND is_sideboard = 0 GROUP BY card_name`);
const byYear = new Map();
const all = [];
for (const p of precons) {
  const r = score(preconCards.all(p.id).map((x) => [x.name, x.quantity]));
  all.push({ ...p, r });
  if (!byYear.has(p.year)) byYear.set(p.year, []);
  byYear.get(p.year).push(r);
}
const pct = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
console.log(`\nPRECONS BY YEAR (${precons.length} Commander Decks) — power: min / median / max`);
for (const [year, rs] of byYear) {
  const p = rs.map((r) => r.powerLevel).sort((a, b) => a - b);
  const s = rs.map((r) => r.score).sort((a, b) => a - b);
  console.log(`${year}  n=${String(rs.length).padStart(3)}  power ${p[0].toFixed(1)} / ${pct(p, 0.5).toFixed(1)} / ${p[p.length - 1].toFixed(1)}   score median ${Math.round(pct(s, 0.5))}`);
}
const sorted = all.sort((a, b) => b.r.score - a.r.score);
console.log('\nStrongest precons');
for (const p of sorted.slice(0, 5)) console.log(`${fmt(p.r)}  ${p.name} (${p.set_code} ${p.year})`);
console.log('Weakest precons');
for (const p of sorted.slice(-5)) console.log(`${fmt(p.r)}  ${p.name} (${p.set_code} ${p.year})`);

// ── Reference cEDH list (Kinnan, representative, 2025-era) ──────────────────
const CEDH = `Kinnan, Bonder Prodigy|Basalt Monolith|Rings of Brighthearth|Sol Ring|Mana Crypt|Mana Vault|Chrome Mox|Mox Diamond|Mox Opal|Lotus Petal|Jeweled Lotus|Arcane Signet|Fellwar Stone|Grim Monolith|Birds of Paradise|Llanowar Elves|Elvish Mystic|Fyndhorn Elves|Delighted Halfling|Ignoble Hierarch|Noble Hierarch|Gilded Goose|Utopia Sprawl|Wild Growth|Elves of Deep Shadow|Bloom Tender|Priest of Titania|Incubation Druid|Devoted Druid|Biomancer's Familiar|Training Grounds|Forensic Gadgeteer|Thrasios, Triton Hero|Hullbreaker Horror|Tamiyo, Inquisitive Student|Rhystic Study|Mystic Remora|Sylvan Library|Survival of the Fittest|Finale of Devastation|Worldly Tutor|Mystical Tutor|Green Sun's Zenith|Chord of Calling|Eldritch Evolution|Neoform|Gamble|Force of Will|Force of Negation|Fierce Guardianship|Pact of Negation|Mental Misstep|Swan Song|Flusterstorm|Mana Drain|Counterspell|An Offer You Can't Refuse|Spell Pierce|Dispel|Delay|Stern Scolding|Veil of Summer|Autumn's Veil|Nature's Claim|Snapback|Chain of Vapor|Cyclonic Rift|Pongify|Rapid Hybridization|Dramatic Reversal|Isochron Scepter|Displacer Kitten|Timetwister|Windfall|Gifts Ungiven|Intuition|Brainstorm|Ponder|Preordain|Command Tower|Breeding Pool|Misty Rainforest|Polluted Delta|Flooded Strand|Windswept Heath|Wooded Foothills|Scalding Tarn|Verdant Catacombs|Marsh Flats|Bloodstained Mire|Arid Mesa|Yavimaya Coast|Waterlogged Grove|Gemstone Caverns|Ancient Tomb|Otawara, Soaring City|Boseiju, Who Endures|Gaea's Cradle|Tropical Island|Island|Forest`;
const r = score(CEDH.split('|').map((n) => [n, 1]));
console.log('\nREFERENCE cEDH (Kinnan)');
console.log(`${header}  missing`);
console.log(`${fmt(r)}  ${r.missing}`);
