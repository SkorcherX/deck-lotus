#!/usr/bin/env node
/**
 * Pack the puller's newline-delimited output into the binary that ships.
 *
 * The second half of the two-step in Part A of the scan plan:
 * build-card-hashes.mjs spends hours producing data/card-hashes.raw.jsonl, and
 * this turns it into data/card-hashes.bin — the ~6MB file committed to the repo
 * and loaded by the server at boot. See src/services/cardHashFile.js for the
 * layout and for why it is binary and keyed on uuid.
 *
 * Split into two scripts rather than one because the expensive half is the one
 * you do not want to repeat: the format can change, the widths can change, the
 * packing can be got wrong — and every one of those is a one-second re-run from
 * the .jsonl instead of another afternoon against Scryfall.
 *
 *   node scripts/pack-card-hashes.mjs
 *   node scripts/pack-card-hashes.mjs --in other.jsonl --out other.bin --verify
 */
import { createReadStream, existsSync, writeFileSync, statSync } from 'fs';
import { createInterface } from 'readline';
import {
  packHashes,
  readPackedHashes,
  PACKED_PATH,
} from '../src/services/cardHashFile.js';
import { ART_HASH_HEX, FRAME_HASH_HEX } from '../src/shared/cardHash.js';

const DEFAULT_IN = 'data/card-hashes.raw.jsonl';

function parseArgs(argv) {
  const options = { in: DEFAULT_IN, out: PACKED_PATH, verify: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--in') options.in = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

const HELP = `
Pack the raw hash output into the binary that ships.

  --in PATH    Newline-delimited JSON from build-card-hashes.mjs
               (default ${DEFAULT_IN}).
  --out PATH   Binary to write (default ${PACKED_PATH}).
  --verify     Read the result back and check it round-trips.
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  if (!existsSync(options.in)) {
    console.error(`No input at ${options.in}. Run scripts/build-card-hashes.mjs first.`);
    process.exitCode = 1;
    return;
  }

  const rows = [];
  const seen = new Map();
  let duplicates = 0;
  let malformed = 0;

  const lines = createInterface({ input: createReadStream(options.in), crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      // A run killed mid-write leaves a torn last line. Counted, not fatal.
      malformed++;
      continue;
    }

    if (
      !row.uuid ||
      typeof row.artHash !== 'string' || row.artHash.length !== ART_HASH_HEX ||
      typeof row.frameHash !== 'string' || row.frameHash.length !== FRAME_HASH_HEX
    ) {
      malformed++;
      continue;
    }

    // --resume appends, so re-running over a set already hashed genuinely does
    // produce repeats. Last write wins: a later run is the more recent read of
    // that card, and a uuid is a primary key on the way into the file.
    if (seen.has(row.uuid)) {
      duplicates++;
      rows[seen.get(row.uuid)] = row;
    } else {
      seen.set(row.uuid, rows.length);
      rows.push(row);
    }
  }

  if (!rows.length) {
    console.error(`No usable rows in ${options.in}.`);
    process.exitCode = 1;
    return;
  }

  const buffer = packHashes(rows);
  writeFileSync(options.out, buffer);

  const megabytes = (statSync(options.out).size / 1024 / 1024).toFixed(2);
  console.log(`Packed ${rows.length} printing(s) into ${options.out} (${megabytes} MB)`);
  if (duplicates) console.log(`  ${duplicates} duplicate uuid(s) collapsed, keeping the later read`);
  if (malformed) console.log(`  ${malformed} malformed line(s) skipped`);

  if (options.verify) {
    const readBack = readPackedHashes(options.out);

    if (readBack.length !== rows.length) {
      throw new Error(`Wrote ${rows.length} rows but read back ${readBack.length}`);
    }

    const byUuid = new Map(rows.map((row) => [row.uuid, row]));
    for (const row of readBack) {
      const original = byUuid.get(row.uuid);
      if (!original) throw new Error(`Read back a uuid that was never written: ${row.uuid}`);
      if (original.artHash !== row.artHash || original.frameHash !== row.frameHash) {
        throw new Error(`Hashes did not survive the round trip for ${row.uuid}`);
      }
    }

    console.log(`  verified: ${readBack.length} row(s) round-tripped exactly`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
