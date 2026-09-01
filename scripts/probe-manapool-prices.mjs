/**
 * What is actually in Mana Pool's /prices/singles feed.
 *
 * Read-only. Fetches the feed, prints its shape and measures it against this
 * database's printings, and writes nothing anywhere.
 *
 * It exists because storing Mana Pool prices alongside the MTGJSON ones is
 * only an improvement if the mapping is right, and the one question that
 * decides it cannot be answered from the outside: whether a row is a *finish*
 * — foil against non-foil — or whether both collapse into one entry per
 * scryfall_id. Our `prices` table is keyed (printing_uuid, provider,
 * price_type), and price_type is the finish. Writing a foil listing into a
 * 'normal' row would not be a rounding error; it is the same class of mistake
 * as the foil fallback that priced a $9.78 Flusterstorm at $208.59, which is
 * what started this.
 *
 * So: run this once with credentials, read the FINISH section, and build the
 * importer on what it says.
 *
 *   MANAPOOL_USER_EMAIL=... MANAPOOL_API_TOKEN=... node scripts/probe-manapool-prices.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { isConfigured, getAllSinglePrices } from '../src/services/manaPoolService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../data/deck-lotus.db');

const money = (cents) => (typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : String(cents));
const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '—');

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

if (!isConfigured()) {
  console.error(
    'Mana Pool is not configured. Both MANAPOOL_USER_EMAIL and MANAPOOL_API_TOKEN are required.'
  );
  process.exit(1);
}

console.log('Fetching /prices/singles ...');
const singles = await getAllSinglePrices();
console.log(`${singles.length.toLocaleString()} rows.`);

if (!singles.length) {
  console.error('Nothing in the feed — cannot say anything about its shape.');
  process.exit(1);
}

section('FIELDS');
// Every key seen anywhere, not just on the first row: an optional field that
// only appears on foils is exactly the field this probe is looking for.
const fields = new Map();
for (const row of singles) {
  for (const [key, value] of Object.entries(row)) {
    if (!fields.has(key)) fields.set(key, { seen: 0, types: new Set(), sample: value });
    const field = fields.get(key);
    field.seen++;
    field.types.add(value === null ? 'null' : typeof value);
  }
}
for (const [key, field] of [...fields].sort((a, b) => b[1].seen - a[1].seen)) {
  console.log(
    `  ${key.padEnd(24)} ${String(field.seen).padStart(8)} rows  ${pct(field.seen, singles.length).padStart(6)}` +
      `  ${[...field.types].join('|').padEnd(10)} e.g. ${JSON.stringify(field.sample)}`
  );
}

section('FINISH — the question this probe exists for');
const byScryfall = new Map();
for (const row of singles) {
  if (!row.scryfall_id) continue;
  if (!byScryfall.has(row.scryfall_id)) byScryfall.set(row.scryfall_id, []);
  byScryfall.get(row.scryfall_id).push(row);
}
const multi = [...byScryfall.values()].filter((rows) => rows.length > 1);
console.log(`  ${byScryfall.size.toLocaleString()} distinct scryfall_ids`);
console.log(`  ${multi.length.toLocaleString()} of them appear more than once`);

if (!multi.length) {
  console.log(
    '\n  One row per printing. So the feed does NOT separate finishes, and its price\n' +
      "  is whatever is cheapest in stock — which for a printing sold in both finishes\n" +
      '  is the non-foil. Storing it as price_type = normal is defensible; storing it\n' +
      '  as a foil price is not, and a foil-only printing needs checking by hand.'
  );
} else {
  // What differs between two rows for one printing is the field that says
  // which is which.
  const [sample] = multi;
  const differing = new Set();
  for (const key of new Set(multi.flatMap((rows) => rows.flatMap((r) => Object.keys(r))))) {
    for (const rows of multi.slice(0, 200)) {
      if (new Set(rows.map((r) => JSON.stringify(r[key]))).size > 1) differing.add(key);
    }
  }
  console.log(`  fields that differ within one scryfall_id: ${[...differing].join(', ') || 'none'}`);
  console.log('\n  A worked example:');
  for (const row of sample) console.log(`    ${JSON.stringify(row)}`);
  console.log(
    '\n  Whichever of those fields names the finish is what maps to price_type.\n' +
      '  If none of them does, the duplicate is something else — a condition, a\n' +
      '  seller — and the finish still is not in this feed.'
  );
}

section('COVERAGE against this database');
const db = new Database(DB_PATH, { readonly: true });
const printings = db
  .prepare(`SELECT uuid, scryfall_id FROM printings WHERE scryfall_id IS NOT NULL`)
  .all();
const ours = new Map(printings.map((row) => [row.scryfall_id, row.uuid]));
let matched = 0;
for (const id of byScryfall.keys()) if (ours.has(id)) matched++;

const total = db.prepare(`SELECT COUNT(*) AS n FROM printings`).get().n;
console.log(`  ${total.toLocaleString()} printings, ${printings.length.toLocaleString()} with a scryfall_id`);
console.log(`  ${matched.toLocaleString()} of them are in the feed  (${pct(matched, printings.length)})`);
console.log(
  '  The rest would keep their MTGJSON price, so this is a preference in the\n' +
    '  COALESCE and never a replacement of it.'
);

section('THE GAP — where the two sources disagree');
const mtg = db.prepare(
  `SELECT price FROM prices WHERE printing_uuid = ? AND provider = 'tcgplayer' AND price_type = 'normal'`
);
const gaps = [];
for (const [scryfallId, rows] of byScryfall) {
  const uuid = ours.get(scryfallId);
  if (!uuid) continue;
  const mine = mtg.get(uuid);
  if (!mine?.price) continue;
  const theirs = Math.min(...rows.map((r) => r.price_cents_nm || r.price_cents).filter(Boolean));
  if (!Number.isFinite(theirs)) continue;
  gaps.push({ name: rows[0].name, mtgjson: mine.price, manapool: theirs / 100 });
}

if (gaps.length) {
  const ratios = gaps.map((g) => g.manapool / g.mtgjson).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  console.log(`  ${gaps.length.toLocaleString()} printings priced by both`);
  console.log(`  median Mana Pool / MTGJSON ratio: ${median.toFixed(3)}`);
  console.log('  the ten widest disagreements:');
  for (const gap of gaps
    .sort((a, b) => b.mtgjson / b.manapool - a.mtgjson / a.manapool)
    .slice(0, 10)) {
    console.log(
      `    ${gap.name.slice(0, 34).padEnd(34)} MTGJSON $${gap.mtgjson.toFixed(2).padStart(8)}` +
        `   Mana Pool $${gap.manapool.toFixed(2).padStart(8)}`
    );
  }
} else {
  console.log('  Nothing priced by both — nothing to compare.');
}

db.close();
console.log(`\nRead-only: nothing was written. Prices seen in cents, e.g. ${money(singles[0].price_cents)}.`);
