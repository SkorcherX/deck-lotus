#!/usr/bin/env node
/**
 * Strip the secrets out of a copy of the database, so it can be handed to
 * somebody debugging without handing them the keys as well.
 *
 * Works on a COPY. It refuses to run against the live path by default, because
 * the whole point is to produce a shareable artefact and the failure mode —
 * scrubbing production — is not one you can undo.
 *
 * What it removes:
 *   - password hashes, replaced with a known bcrypt hash of "test"
 *   - API keys, deleted outright: they are live credentials
 *   - email addresses, rewritten to user{id}@example.test
 *   - deck share tokens, regenerated: a real one is a working public URL
 *
 * What it deliberately KEEPS, because it is the whole reason for sharing:
 *   - every deck, card, printing, price, trade, audit row and inventory row
 *   - usernames and deck names, which is what makes a bug report legible
 *
 * Usage:
 *   cp data/deck-lotus.db /tmp/share.db
 *   node scripts/scrub-db.js /tmp/share.db
 *
 * Add --vacuum to shrink the file afterwards, and --drop-prices to throw away
 * price history, which is usually the bulk of the size and is rebuilt by the
 * next sync anyway.
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

// bcrypt hash of "test". A real hash rather than a placeholder so the rows
// still look like what the app expects, and logging in as anybody is trivial.
const KNOWN_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const target = process.argv[2];
const vacuum = process.argv.includes('--vacuum');
const dropPrices = process.argv.includes('--drop-prices');

if (!target) {
  console.error('Usage: node scripts/scrub-db.js <path-to-copy.db> [--vacuum] [--drop-prices]');
  process.exit(1);
}

if (!fs.existsSync(target)) {
  console.error(`No such file: ${target}`);
  process.exit(1);
}

// The guard that matters. Scrubbing the live database would destroy the
// logins of everyone using it, and there is no undo.
const live = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'deck-lotus.db');
if (path.resolve(target) === path.resolve(live)) {
  console.error(
    `Refusing to scrub ${target}: that is the live database.\n` +
    `Copy it somewhere else first, then scrub the copy.`
  );
  process.exit(1);
}

const db = new Database(target);
const has = (table) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);

const counts = {};

db.transaction(() => {
  const users = db.prepare(`SELECT id FROM users`).all();
  counts.users = users.length;

  const setUser = db.prepare(`UPDATE users SET password_hash = ?, email = ? WHERE id = ?`);
  for (const user of users) {
    setUser.run(KNOWN_HASH, `user${user.id}@example.test`, user.id);
  }

  if (has('api_keys')) {
    counts.api_keys = db.prepare(`SELECT COUNT(*) c FROM api_keys`).get().c;
    db.prepare(`DELETE FROM api_keys`).run();
  }

  if (has('deck_shares')) {
    const shares = db.prepare(`SELECT id FROM deck_shares`).all();
    counts.deck_shares = shares.length;

    const setToken = db.prepare(`UPDATE deck_shares SET share_token = ? WHERE id = ?`);
    for (const share of shares) {
      setToken.run(crypto.randomBytes(16).toString('hex'), share.id);
    }
  }

  if (dropPrices && has('prices')) {
    counts.prices_dropped = db.prepare(`SELECT COUNT(*) c FROM prices`).get().c;
    db.prepare(`DELETE FROM prices`).run();
  }
})();

if (vacuum) {
  // Outside the transaction: SQLite will not vacuum inside one.
  db.exec('VACUUM');
}

db.close();

const size = (fs.statSync(target).size / (1024 * 1024)).toFixed(1);

console.log(`Scrubbed ${target} (${size} MB)`);
for (const [what, n] of Object.entries(counts)) {
  console.log(`  ${what}: ${n}`);
}
console.log(`\nEvery password is now "test".`);
