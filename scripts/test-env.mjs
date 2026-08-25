#!/usr/bin/env node
/**
 * The test environment: the real app, running against a scrubbed copy of the
 * real database, on a port of its own.
 *
 * Unit tests cover the pure modules and the integration tests cover the SQL,
 * but neither answers "does this actually work" — a page renders, a badge says
 * the right thing, a migration applies to a database shaped like production
 * rather than one built by a fixture. That is what this is for.
 *
 * ── The pristine copy is never touched ──────────────────────────────────────
 *
 * data/deck-lotus-test.db is the master. The server never opens it. Every run
 * works on data/test-run/deck-lotus.db, copied from the master by `reset`.
 *
 * That indirection is the whole design. The app migrates its database on
 * startup, and this one arrives already migrated — so the *first* thing a test
 * run does is write to it. Without a disposable copy the master would drift
 * away from what was handed over, one run at a time, and the day a migration
 * went wrong it would take the fixture with it. Resetting is a file copy.
 *
 * ── What is switched off ────────────────────────────────────────────────────
 *
 * DISABLE_SCHEDULED_JOBS. The weekly sync clears `printings` and rebuilds it
 * from a multi-gigabyte download; the price checker calls live APIs. Neither
 * belongs anywhere near a fixture.
 *
 * Usage:
 *   npm run test:env:reset     — fresh copy from the master
 *   npm run test:env           — start the server on :3100
 *   npm run test:env:fresh     — both, in that order
 */
import { existsSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const MASTER = join(ROOT, 'data', 'deck-lotus-test.db');
const RUN_DIR = join(ROOT, 'data', 'test-run');
const RUN_DB = join(RUN_DIR, 'deck-lotus.db');

// The live database, so we can refuse to go anywhere near it.
const LIVE_DB = join(ROOT, 'data', 'deck-lotus.db');

const PORT = process.env.TEST_PORT || '3100';

// What every account in the fixture logs in with. Matches scrub-db.js.
const TEST_PASSWORD = 'test';

function bail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function humanSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/**
 * Replace the working copy with a fresh one from the master.
 *
 * The -wal and -shm sidecars go too. SQLite in WAL mode keeps committed data
 * in the -wal file until a checkpoint, so a stale sidecar next to a fresh
 * database would reintroduce writes from the previous run — the exact
 * contamination this command exists to prevent.
 */
function reset() {
  if (!existsSync(MASTER)) {
    bail(
      `No master database at ${MASTER}\n` +
      `  Put a scrubbed copy there first (see scripts/scrub-db.js).`
    );
  }

  if (!existsSync(RUN_DIR)) mkdirSync(RUN_DIR, { recursive: true });

  for (const suffix of ['', '-wal', '-shm']) {
    const stale = `${RUN_DB}${suffix}`;
    if (existsSync(stale)) rmSync(stale);
  }

  copyFileSync(MASTER, RUN_DB);

  console.log(`✓ Fresh test database (${humanSize(statSync(RUN_DB).size)})`);
  console.log(`  from ${MASTER}`);
  console.log(`  to   ${RUN_DB}`);

  ensureKnownPassword();
}

/**
 * Guarantee that every account really does have the password this environment
 * advertises.
 *
 * scripts/scrub-db.js sets one, but an early version of it wrote a hardcoded
 * string that was described as bcrypt("test") and was not a hash of "test" or
 * of anything else — see the comment at the top of that file. A fixture
 * scrubbed by that version has valid-looking, identical, unusable hashes, and
 * the failure shows up as "Invalid credentials" at a login page that has just
 * told you what the password is.
 *
 * Checking rather than always rewriting keeps this quiet when the fixture is
 * already correct, and keeps the master file untouched either way: this runs
 * against the disposable copy.
 */
function ensureKnownPassword() {
  const db = new Database(RUN_DB);

  try {
    const sample = db.prepare('SELECT password_hash FROM users LIMIT 1').get();

    if (sample?.password_hash && bcrypt.compareSync(TEST_PASSWORD, sample.password_hash)) {
      return;
    }

    const hash = bcrypt.hashSync(TEST_PASSWORD, 10);
    const { changes } = db.prepare('UPDATE users SET password_hash = ?').run(hash);

    console.log(
      `↻ Reset ${changes} password${changes === 1 ? '' : 's'} to "${TEST_PASSWORD}" ` +
      `(the fixture was scrubbed by an older scrub-db.js)`
    );
  } finally {
    db.close();
  }
}

async function start() {
  if (!existsSync(RUN_DB)) {
    console.log('No working copy yet — creating one.');
    reset();
  }

  // Belt and braces. Nothing above can produce this path, but the cost of a
  // check is nothing and the cost of being wrong is the real database.
  if (resolve(RUN_DB) === resolve(LIVE_DB)) {
    bail('Refusing to start: the test path resolved to the live database.');
  }

  process.env.DATABASE_PATH = RUN_DB;
  process.env.PORT = PORT;

  // Production mode, because that is what the Unraid container runs — and
  // because Express only serves client/dist when NODE_ENV is 'production',
  // so anything else would leave the test environment without a UI.
  process.env.NODE_ENV = 'production';

  process.env.DISABLE_SCHEDULED_JOBS = 'true';
  // Belt and braces again: this one triggers a full reimport on startup.
  process.env.FORCE_REIMPORT = 'false';

  // A fixed secret, so tokens survive a restart and you are not logged out
  // every time the server reloads. It is a test environment; this is not a
  // credential worth protecting, and hardcoding it here keeps it out of .env
  // where it might get copied somewhere that matters.
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-environment-not-a-secret';

  // Registration off: the fixture's four accounts are the point, and a stray
  // signup would change what the next person testing sees.
  process.env.REGISTRATION_ENABLED = 'false';

  if (!existsSync(join(ROOT, 'client', 'dist', 'index.html'))) {
    bail('client/dist is missing — run `npm run client:build` first.');
  }

  console.log('');
  console.log('┌─ Deck Lotus test environment ─────────────────────────────');
  console.log(`│  URL       http://localhost:${PORT}`);
  console.log(`│  Database  ${RUN_DB}`);
  console.log('│  Logins    admin, Valoxi, MacTheCat, Viewaskewfool');
  console.log(`│  Password  ${TEST_PASSWORD}   (every account — scrubbed fixture)`);
  console.log('│  Jobs      sync, price checks and backups disabled');
  console.log('└───────────────────────────────────────────────────────────');
  console.log('');

  await import('../src/server.js');
}

const command = process.argv[2] || 'start';

if (command === 'reset') {
  reset();
} else if (command === 'start') {
  await start();
} else if (command === 'fresh') {
  reset();
  await start();
} else {
  bail(`Unknown command "${command}". Use: reset | start | fresh`);
}
