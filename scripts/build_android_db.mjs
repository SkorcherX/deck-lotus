/**
 * Build the Android companion app's offline identity database.
 *
 * The phone holds two files: `card-hashes.bin`, which says *which row* a
 * capture matched, and this one, which says what that row is. Together they
 * are the whole matcher, and a device holding both names a card in about
 * fifteen milliseconds with the radio off — see docs/ON_DEVICE_MATCHING.md
 * and scanIdentityService.js, which serves the same table to the web client
 * over the wire.
 *
 * Run it after anything that rebuilds `printings` or `prices`: the weekly
 * MTGJSON sync and the daily price refresh both invalidate what is in here.
 *
 *   node scripts/build_android_db.mjs
 *
 * SOURCE_DB, HASH_PATH and OUT_PATH override the paths it guesses.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import {
  HEADER_BYTES,
  ROW_BYTES,
  readHeader,
  unpackUuid,
} from '../src/services/cardHashFile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// How much of the index has to find an identity before the result is worth
// shipping. The two files are joined on uuid and are rebuilt by the same sync,
// so in the normal case this is ~100%; a few rows may legitimately drop when a
// printing disappears between the pack and the build. Anything below this means
// the pair have drifted apart — a hash file from a previous sync, or a database
// mid-import — and the alternative to stopping is an 8.7MB asset of
// 'Unknown Card' that installs cleanly and resolves nothing.
const MIN_MATCH_RATIO = 0.99;

const candidateDbs = [
  process.env.SOURCE_DB,
  path.join(projectRoot, 'data', 'deck-lotus.db'),
  path.join(projectRoot, 'data', 'deck-lotus-test.db'),
].filter((p) => p && fs.existsSync(p));

// The first candidate that has printings *in* it, not merely a table to hold
// them. scripts/import-mtgjson.js empties that table for the minutes it runs,
// and an empty real database would otherwise beat a populated test one on
// filename order alone.
let sourceDbPath = candidateDbs[0];
for (const p of candidateDbs) {
  try {
    const d = new Database(p, { readonly: true });
    const populated = d
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='printings'")
      .get()
      && d.prepare('SELECT 1 FROM printings LIMIT 1').get();
    d.close();
    if (populated) {
      sourceDbPath = p;
      break;
    }
  } catch (_) {
    // Unreadable or locked — try the next one.
  }
}

const hashPath = process.env.HASH_PATH || path.join(projectRoot, 'data', 'card-hashes.bin');
const outPath = process.env.OUT_PATH
  || path.resolve(projectRoot, '..', 'deck-lotus-android', 'app', 'src', 'main', 'assets', 'card-identities.db');

console.log('Source DB:', sourceDbPath);
console.log('Hash binary:', hashPath);
console.log('Output asset:', outPath);

const sourceDb = new Database(sourceDbPath, { readonly: true });
const hashBuffer = fs.readFileSync(hashPath);

// Magic, format version and both hash widths, validated rather than assumed.
// A file packed at a different hash width still parses at fixed offsets and
// still yields rows — uniformly wrong ones — so this refuses instead of
// guessing. Same reason cardHashIndex.js goes through it.
const { count } = readHeader(hashBuffer, hashPath);
console.log('Building identity db for rows:', count);

const printings = sourceDb.prepare(`
  SELECT
    p.id,
    p.uuid,
    c.name,
    p.set_code,
    p.collector_number,
    -- The COALESCE scanIdentityService quotes, ending in nothing on purpose: a
    -- printing nobody has priced has no price, and inventing one is worse than
    -- saying so. 10,972 of 112,815 printings have no normal price and they are
    -- the showcase and serialised ones, so the foil row is the most inflated
    -- figure available — which is why what it came from travels beside it.
    COALESCE(
      (SELECT price FROM prices
        WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal' LIMIT 1),
      (SELECT price FROM prices
        WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'foil' LIMIT 1)
    ) AS price,
    CASE
      WHEN EXISTS (SELECT 1 FROM prices
        WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal') THEN 'normal'
      WHEN EXISTS (SELECT 1 FROM prices
        WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'foil') THEN 'foil'
    END AS price_type
  FROM printings p
  JOIN cards c ON c.id = p.card_id
`).all();

const byUuid = new Map(printings.map((p) => [p.uuid, p]));

// Rows the index carries but the database cannot name stay in as placeholders,
// so row_id remains the index's own row number — the whole point of this table
// is that `row_id` is an offset into card-hashes.bin, not a key of its own.
const batch = [];
let matched = 0;

for (let row = 0; row < count; row++) {
  const info = byUuid.get(unpackUuid(hashBuffer, HEADER_BYTES + row * ROW_BYTES));

  if (info) {
    matched++;
    batch.push([
      row,
      info.id,
      info.name,
      info.set_code,
      info.collector_number,
      info.price === null || info.price === undefined ? null : Math.round(info.price * 100),
      info.price_type ?? null,
    ]);
  } else {
    // `printing_id = 0` is the sentinel, and the other columns are left null
    // rather than filled with 'Unknown Card' / 'UNK'. UNK is a real set code —
    // Unknown Event, 520 printings — so a placeholder wearing it is
    // indistinguishable from a card that genuinely lives there.
    batch.push([row, 0, null, null, null, null, null]);
  }
}

const ratio = count === 0 ? 0 : matched / count;

if (ratio < MIN_MATCH_RATIO) {
  console.error(
    `Only ${matched} of ${count} index rows (${(ratio * 100).toFixed(1)}%) found an identity in ` +
    `${sourceDbPath}. The hash file and the database have drifted apart — re-run ` +
    'scripts/pack-card-hashes.mjs after the sync finishes, or wait for an import to complete. ' +
    'Nothing written.'
  );
  process.exit(1);
}

if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
const outDb = new Database(outPath);

outDb.exec('PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY;');
outDb.exec(`
  CREATE TABLE printings (
    row_id INTEGER PRIMARY KEY,
    printing_id INTEGER,
    name TEXT,
    set_code TEXT,
    collector_number TEXT,
    price_cents INTEGER,
    price_type TEXT
  );
`);

const insert = outDb.prepare(`
  INSERT INTO printings (row_id, printing_id, name, set_code, collector_number, price_cents, price_type)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertMany = outDb.transaction((rows) => {
  for (const r of rows) insert.run(...r);
});

insertMany(batch);
outDb.exec('CREATE INDEX idx_name ON printings(name);');
outDb.exec('CREATE INDEX idx_set_collector ON printings(set_code, collector_number);');
outDb.close();

const stat = fs.statSync(outPath);
const unpriced = batch.filter((r) => r[5] === null).length;

console.log(
  'Created card-identities.db: size =', (stat.size / 1024 / 1024).toFixed(2), 'MB,',
  'matched =', matched, `(${(ratio * 100).toFixed(2)}%),`,
  'unpriced =', unpriced
);
