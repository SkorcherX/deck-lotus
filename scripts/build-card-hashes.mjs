#!/usr/bin/env node
/**
 * Build the perceptual-hash reference database.
 *
 * This is a *developer* tool. It is never run by the server and never run in
 * the container: it fetches ~112k card images from Scryfall over several hours,
 * hashes each one and throws the image away. The output is packed by
 * scripts/pack-card-hashes.mjs into a small binary that ships with the repo, so
 * a deployment gets the fingerprints without ever touching the network. See
 * docs/CAMERA_SCAN_IMPORT_PLAN.md for why the hashes exist at all.
 *
 * The work list comes from our own `printings` table rather than Scryfall's
 * bulk JSON. Every row already carries `scryfall_id` (checked: 112815 of
 * 112815), so the bulk file would be two gigabytes of download to re-learn what
 * the database already knows — and worse, it would key the output on Scryfall's
 * ids when the thing we join on is MTGJSON's `uuid`. Driving from `printings`
 * makes the output aligned by construction.
 *
 * Output is newline-delimited JSON, appended as it goes. That shape is chosen
 * for the interruption, not for elegance: a multi-hour run over someone else's
 * CDN will be stopped, rate-limited or dropped at least once, and --resume has
 * to be able to pick up from whatever survived. A JSON array could not be
 * appended to safely, and a crash mid-write would take the whole file with it.
 *
 *   node scripts/build-card-hashes.mjs --set DMU --set WAR   # subset, for testing
 *   node scripts/build-card-hashes.mjs --limit 200
 *   node scripts/build-card-hashes.mjs --resume              # the full run
 *   node scripts/build-card-hashes.mjs --resume              # ...and the top-up
 *
 * --resume is both the crash recovery and the top-up path, and that is not a
 * coincidence — it is the same question either way ("which uuids do we not have
 * yet?"). There was a --since flag here first; it was removed after testing
 * showed `released_at` is NULL for all 112815 rows, MTGJSON not populating it
 * through our import. A date filter over an empty column selects nothing, and
 * would have looked like a working top-up that quietly hashed zero new cards.
 */
import Database from 'better-sqlite3';
import jpeg from 'jpeg-js';
import { createWriteStream, existsSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { hashRectified } from '../src/shared/cardHash.js';
import { readPackedUuids, PACKED_PATH } from '../src/services/cardHashFile.js';

const DEFAULT_DB = process.env.DATABASE_PATH || 'data/deck-lotus.db';
const DEFAULT_OUT = 'data/card-hashes.raw.jsonl';

/**
 * Scryfall asks for 50-100ms between requests and for a real User-Agent. This
 * run is long and entirely for our own convenience, so it sits at the polite
 * end: being throttled or blocked half way through costs far more than the
 * extra hour, and there is nobody waiting on the result.
 */
const REQUEST_DELAY_MS = 100;
const USER_AGENT = 'deck-lotus-hash-builder/1.0 (+https://github.com/SkorcherX/deck-lotus)';

/**
 * `small` is 146x204, against `normal` at 488x680. Over 112k cards that is
 * ~2GB of fetching rather than ~20GB, which is why the first run used it.
 *
 * It is not free, though, and the earlier claim here that the two "agree
 * exactly" was only ever true of the 64-bit frame hash. Measured across 30
 * random printings, hashing the same card at both sizes:
 *
 *   art hash,  small vs normal:  mean 15.9/256 bits (6.2%), max 26 (10.2%)
 *   art hash,  normal vs large:  mean  3.9/256 bits (1.5%), max  8
 *   frame hash, small vs normal: mean  1.7/64 bits,         max  6
 *
 * The art hash averages a 123x90 window down to a 32x32 grid at `small` — under
 * four source pixels a cell — so it is quantisation, and it comes out of the
 * same budget a real photograph needs for glare, white balance and angle:
 * ART_STRONG_THRESHOLD is 16%, and up to 10 of those points can be gone before
 * the camera is even involved.
 *
 * The shipped file was rebuilt at `normal` for exactly that reason. Measured
 * over 40 printings probed at `large` — deliberately neither reference size, so
 * the index is not being asked to recognise an image it was built from:
 *
 *                      truth ranked 1st   mean distance   worst
 *   references small        32/40          16.0 (6.3%)     24
 *   references normal       36/40           3.4 (1.3%)      8
 *
 * That hands ~13 bits of the 41-bit strong-match budget back to the camera,
 * which is what a hand-held capture spends on glare, white balance and angle.
 * The four that still rank second are reprints sharing an illustration, where
 * the art hash cannot separate them by construction and the frame hash orders
 * them — not a precision problem, and not one more pixels would fix.
 */
const IMAGE_SIZE = 'normal';

/** Sizes Scryfall serves that are worth asking for. See the note above. */
const IMAGE_SIZES = new Set(['small', 'normal', 'large']);

/**
 * The size the *shipped* data/card-hashes.bin was built from.
 *
 * --resume seeds from that file so someone with only the repo can top up a new
 * set without re-fetching 112k images. That seeding is only valid when the run
 * is using the same size, because hashes from two sizes are not comparable —
 * seeding a `normal` rebuild from a `small` file would skip every row and
 * produce a binary that was never rebuilt at all, silently.
 *
 * Move this whenever the shipped file is rebuilt at a different size.
 */
const PACKED_IMAGE_SIZE = 'normal';

function parseArgs(argv) {
  const options = {
    sets: [], limit: null, resume: false, out: DEFAULT_OUT, db: DEFAULT_DB, size: IMAGE_SIZE,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };

    if (arg === '--set') options.sets.push(next().toUpperCase());
    else if (arg === '--limit') options.limit = Number(next());
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--out') options.out = next();
    else if (arg === '--db') options.db = next();
    else if (arg === '--size') {
      options.size = next();
      if (!IMAGE_SIZES.has(options.size)) {
        throw new Error(`--size must be one of ${[...IMAGE_SIZES].join(', ')}`);
      }
    }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

const HELP = `
Build the perceptual-hash reference database.

  --set CODE     Only this set. Repeatable. For testing on a subset.
  --limit N      Stop after N printings.
  --resume       Append to the output, skipping uuids already hashed — read from
                 the output file and from data/card-hashes.bin if present. This
                 is both crash recovery and the top-up path after a new set.
  --out PATH     Output file (default ${DEFAULT_OUT}).
  --db PATH      SQLite database to read printings from (default ${DEFAULT_DB}).
  --size NAME    Scryfall image size: small, normal or large (default ${IMAGE_SIZE}).
                 Hashes from different sizes are NOT interchangeable — see the
                 measurements above — so a --resume must use the size the
                 existing rows were built with.
`;

/**
 * uuids already hashed, read back from a previous run's output.
 *
 * Read line by line rather than parsed as a whole: the file reaches ~15MB and,
 * more importantly, a run killed mid-write leaves a torn final line. Skipping
 * an unparseable line costs one re-fetch; refusing to start costs the run.
 */
async function alreadyDone(path, packedPath) {
  const done = new Set();

  // The packed file is what ships; the raw jsonl is a build artifact and a
  // fresh clone will not have one. Seeding from the .bin is what lets someone
  // who only has the repo run a top-up without re-fetching all 112k images.
  if (packedPath && existsSync(packedPath)) {
    for (const uuid of readPackedUuids(packedPath)) done.add(uuid);
    console.log(`  (${done.size} already in ${packedPath})`);
  }

  if (!existsSync(path)) return done;

  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let torn = 0;

  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.uuid) done.add(row.uuid);
    } catch {
      torn++;
    }
  }

  if (torn) console.log(`  (skipped ${torn} unparseable line(s) from an interrupted run)`);
  return done;
}

/** The image URL, derived exactly as scripts/import-mtgjson.js derives it. */
function imageUrl(scryfallId, size = IMAGE_SIZE) {
  return `https://cards.scryfall.io/${size}/front/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch with backoff.
 *
 * A 404 is final — Scryfall genuinely has no front image for some rows, and
 * retrying one is just a slower 404. Everything else gets three tries, because
 * over a run this long a transient failure is the common case and a permanent
 * one is not worth aborting 100k cards for.
 */
async function fetchImage(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'image/jpeg' } });

      if (response.status === 404) return { missing: true };
      if (response.status === 429) {
        // Backed off hard: being rate-limited means we are already too fast.
        await sleep(5000 * attempt);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      return { buffer: Buffer.from(await response.arrayBuffer()) };
    } catch (error) {
      if (attempt === 3) return { error: error.message };
      await sleep(1000 * attempt);
    }
  }

  return { error: 'exhausted retries' };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  if (!existsSync(options.db)) {
    console.error(`No database at ${options.db}. Pass --db, or set DATABASE_PATH.`);
    process.exitCode = 1;
    return;
  }

  const db = new Database(options.db, { readonly: true });

  const where = [`scryfall_id IS NOT NULL`, `scryfall_id <> ''`];
  const params = [];

  if (options.sets.length) {
    where.push(`set_code IN (${options.sets.map(() => '?').join(', ')})`);
    params.push(...options.sets);
  }

  // Ordered so a subset run and the full run visit rows in the same sequence,
  // which is what makes --resume meaningful across a change of flags.
  const rows = db.prepare(`
    SELECT uuid, scryfall_id, set_code, collector_number
    FROM printings
    WHERE ${where.join(' AND ')}
    ORDER BY set_code, collector_number, uuid
  `).all(...params);

  db.close();

  console.log(`${rows.length} printing(s) selected from ${options.db}`);

  const done = options.resume
    ? await alreadyDone(options.out, options.size === PACKED_IMAGE_SIZE ? PACKED_PATH : null)
    : new Set();
  if (done.size) console.log(`${done.size} already hashed, skipping those`);

  let work = rows.filter((row) => !done.has(row.uuid));
  if (options.limit) work = work.slice(0, options.limit);

  if (!work.length) {
    console.log('Nothing to do.');
    return;
  }

  const estimate = ((work.length * REQUEST_DELAY_MS) / 1000 / 60).toFixed(0);
  console.log(`${work.length} to fetch — roughly ${estimate} minute(s) at ${REQUEST_DELAY_MS}ms apart\n`);

  const out = createWriteStream(options.out, { flags: options.resume ? 'a' : 'w' });

  const failures = [];
  let hashed = 0;
  let missing = 0;
  const started = Date.now();

  for (const [index, row] of work.entries()) {
    const result = await fetchImage(imageUrl(row.scryfall_id, options.size));

    if (result.missing) {
      missing++;
    } else if (result.error) {
      failures.push({ ...row, reason: result.error });
    } else {
      try {
        // useTArray keeps the decode in a Uint8Array rather than a Buffer of
        // objects; the hash only reads it, and this is 112k decodes.
        const image = jpeg.decode(result.buffer, { useTArray: true });
        const { artHash, frameHash } = hashRectified(image);

        out.write(`${JSON.stringify({
          uuid: row.uuid,
          setCode: row.set_code,
          collectorNumber: row.collector_number,
          artHash,
          frameHash,
        })}\n`);

        hashed++;
      } catch (error) {
        failures.push({ ...row, reason: `decode/hash: ${error.message}` });
      }
    }

    if ((index + 1) % 250 === 0 || index + 1 === work.length) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = (index + 1) / elapsed;
      const remaining = ((work.length - index - 1) / rate / 60).toFixed(1);
      console.log(
        `  ${index + 1}/${work.length}  hashed ${hashed}  missing ${missing}  ` +
        `failed ${failures.length}  ~${remaining}m left`
      );
    }

    await sleep(REQUEST_DELAY_MS);
  }

  await new Promise((resolve) => out.end(resolve));

  console.log(`\nHashed ${hashed}, no image for ${missing}, failed ${failures.length}`);
  console.log(`Wrote ${options.out}`);

  // Listed, not thrown. A handful of failures out of 112k is expected and the
  // run is still worth keeping; re-running with --resume picks exactly these up.
  if (failures.length) {
    console.log('\nFailures (re-run with --resume to retry):');
    for (const failure of failures.slice(0, 20)) {
      console.log(`  ${failure.set_code} ${failure.collector_number} ${failure.uuid} — ${failure.reason}`);
    }
    if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
