import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const candidateDbs = [
  process.env.SOURCE_DB,
  path.join(projectRoot, 'data', 'deck-lotus.db'),
  path.join(projectRoot, 'data', 'deck-lotus-test.db')
].filter(p => p && fs.existsSync(p));

let sourceDbPath = candidateDbs[0];
for (const p of candidateDbs) {
  try {
    const d = new Database(p, { readonly: true });
    const hasPrintings = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='printings'").get();
    d.close();
    if (hasPrintings) {
      sourceDbPath = p;
      break;
    }
  } catch (_) {}
}

const hashPath = process.env.HASH_PATH || path.join(projectRoot, 'data', 'card-hashes.bin');
const outPath = process.env.OUT_PATH || path.resolve(projectRoot, '..', 'deck-lotus-android', 'app', 'src', 'main', 'assets', 'card-identities.db');

console.log('Source DB:', sourceDbPath);
console.log('Hash binary:', hashPath);
console.log('Output asset:', outPath);

const sourceDb = new Database(sourceDbPath, { readonly: true });
const hashBuffer = fs.readFileSync(hashPath);
const count = hashBuffer.readUInt32BE(8);
console.log('Building identity db for rows:', count);

if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
const outDb = new Database(outPath);

outDb.exec('PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY;');
outDb.exec('CREATE TABLE printings (row_id INTEGER PRIMARY KEY, printing_id INTEGER, name TEXT, set_code TEXT, collector_number TEXT, price_cents INTEGER);');

const printings = sourceDb.prepare(`
  SELECT
    p.id,
    p.uuid,
    c.name,
    p.set_code,
    p.collector_number,
    COALESCE(
      (SELECT price FROM prices WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal' LIMIT 1),
      (SELECT price FROM prices WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'foil' LIMIT 1),
      0.26
    ) AS price
  FROM printings p
  JOIN cards c ON c.id = p.card_id
`).all();

const byUuid = new Map();
for (const p of printings) {
  byUuid.set(p.uuid.toLowerCase().replace(/-/g, ''), p);
}

const insert = outDb.prepare('INSERT INTO printings (row_id, printing_id, name, set_code, collector_number, price_cents) VALUES (?, ?, ?, ?, ?, ?)');
const insertMany = outDb.transaction((rows) => {
  for (const r of rows) insert.run(r[0], r[1], r[2], r[3], r[4], r[5]);
});

const batch = [];
let matched = 0;
for (let row = 0; row < count; row++) {
  const offset = 16 + row * 56;
  const rawUuid = hashBuffer.slice(offset, offset + 16).toString('hex').toLowerCase();
  const info = byUuid.get(rawUuid);
  if (info) {
    matched++;
    batch.push([row, info.id, info.name, info.set_code, info.collector_number, Math.round((info.price || 0.26) * 100)]);
  } else {
    batch.push([row, 0, 'Unknown Card', 'UNK', '0', 26]);
  }
}

insertMany(batch);
outDb.exec('CREATE INDEX idx_name ON printings(name);');
outDb.exec('CREATE INDEX idx_set_collector ON printings(set_code, collector_number);');
outDb.close();

const stat = fs.statSync(outPath);
console.log('Created card-identities.db: size =', (stat.size / 1024 / 1024).toFixed(2), 'MB, matched =', matched);