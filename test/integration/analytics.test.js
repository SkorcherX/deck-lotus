/**
 * The analytics queries against a real schema: value per copy with its
 * finish, the color buckets, and the timeline read from the audit log.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-analytics-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const analytics = await import('../../src/services/analyticsService.js');

let userId;

function addCard(name, { colors = '', typeLine, supertypes = null, set = 'AAA', normal = null, foil = null }) {
  db.run(
    `INSERT INTO cards (name, name_normalized, type_line, colors, color_identity, supertypes) VALUES (?,?,?,?,?,?)`,
    [name, name.toLowerCase(), typeLine, colors, colors, supertypes]
  );
  const cardId = db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
  const uuid = `uuid-${name.replace(/\s+/g, '-')}`;
  db.run(`INSERT INTO printings (card_id, uuid, set_code, collector_number) VALUES (?,?,?,'1')`, [cardId, uuid, set]);
  if (normal != null) db.run(`INSERT INTO prices (printing_uuid, provider, price_type, price) VALUES (?, 'tcgplayer', 'normal', ?)`, [uuid, normal]);
  if (foil != null) db.run(`INSERT INTO prices (printing_uuid, provider, price_type, price) VALUES (?, 'tcgplayer', 'foil', ?)`, [uuid, foil]);
  return db.get(`SELECT id FROM printings WHERE uuid = ?`, [uuid]).id;
}

function own(printingId, quantity, isFoil = 0) {
  db.run(`INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,?,?)`,
    [userId, printingId, quantity, isFoil]);
}

function audit(delta, createdAt, source = 'bulk_add') {
  db.run(
    `INSERT INTO audit_log (user_id, actor_user_id, entity_type, action, source, quantity_delta, created_at)
     VALUES (?, ?, 'inventory', 'inventory.add', ?, ?, ?)`,
    [userId, userId, source, delta, createdAt]
  );
}

before(async () => {
  await runMigrations();
  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('u','u@example.test','h')`);
  userId = db.get(`SELECT id FROM users WHERE username='u'`).id;
  db.run(`INSERT INTO sets (code, name) VALUES ('AAA','Alpha Test'), ('BBB','Beta Test')`);

  const bolt = addCard('Bolt', { colors: 'R', typeLine: 'Instant', normal: 1, foil: 5 });
  const guild = addCard('Charm', { colors: 'W,U', typeLine: 'Instant', set: 'BBB', normal: 10 });
  const island = addCard('Island', { typeLine: 'Basic Land — Island', supertypes: 'Basic', normal: 0.1 });
  const dual = addCard('Dual', { typeLine: 'Land', set: 'BBB', normal: 100 });
  const rock = addCard('Rock', { typeLine: 'Artifact' });

  own(bolt, 4);        // 4 × $1
  own(bolt, 1, 1);     // 1 × $5 foil
  own(guild, 2, 1);    // foil with no foil price: falls back to $10 each
  own(island, 10);     // 10 × $0.10
  own(dual, 1);        // $100
  own(rock, 3);        // unpriced

  audit(5, '2026-01-15 10:00:00');
  audit(-2, '2026-01-20 10:00:00', 'card_page');
  audit(3, '2026-03-02 10:00:00');
});

after(() => {
  try { closeDb(); } catch { /* already closed */ }
  try { fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true }); } catch { /* temp */ }
});

describe('analytics', () => {
  test('value counts every copy at its own finish, falling back to normal', () => {
    const s = analytics.getSummary(userId);
    assert.equal(s.totalCards, 21);
    assert.equal(s.uniqueCards, 5);
    assert.equal(s.foilCards, 3);
    assert.equal(s.totalValue, 4 + 5 + 20 + 1 + 100);
  });

  test('sets report copies and total value', () => {
    const sets = analytics.getSets(userId);
    const bbb = sets.find((x) => x.code === 'BBB');
    assert.equal(bbb.name, 'Beta Test');
    assert.equal(bbb.copies, 3);
    assert.equal(bbb.value, 120);
    assert.equal(sets[0].code, 'BBB', 'sorted by value');
  });

  test('colors split lands, multicolor and colorless', () => {
    const byKey = Object.fromEntries(analytics.getColors(userId).map((c) => [c.key, c]));
    assert.equal(byKey.R.copies, 5);
    assert.equal(byKey.multi.copies, 2);
    assert.equal(byKey.basic_land.copies, 10);
    assert.equal(byKey.nonbasic_land.value, 100);
    assert.equal(byKey.colorless.copies, 3);
  });

  test('the timeline splits adds from removals and fills quiet months', () => {
    const t = analytics.getTimeline(userId);
    assert.deepEqual(t.months.slice(0, 3), [
      { month: '2026-01', added: 5, removed: 2 },
      { month: '2026-02', added: 0, removed: 0 },
      { month: '2026-03', added: 3, removed: 0 },
    ]);
    assert.ok(t.trackingSince.startsWith('2026-01-15'));
    assert.equal(t.bySource.find((r) => r.source === 'card_page').removed, 2);
  });

  test('composition keeps lands off the curve and buckets rarity', () => {
    const c = analytics.getComposition(userId);
    const type = (k) => c.types.find((b) => b.key === k);
    assert.equal(type('Instant').copies, 7);
    assert.equal(type('Land').copies, 11);
    assert.equal(type('Artifact').copies, 3);
    const curveTotal = c.curve.reduce((s, b) => s + b.copies, 0);
    assert.equal(curveTotal, 10, 'lands are not on the curve');
  });

  test('top cards rank by the price of one copy and skip unpriced ones', () => {
    const top = analytics.getTopCards(userId);
    assert.equal(top[0].name, 'Dual');
    assert.equal(top[1].name, 'Charm');
    assert.equal(top[1].total, 20);
    assert.ok(!top.some((r) => r.name === 'Rock'));
  });

  test('set completion counts cards owned over cards printed', () => {
    addCard('Unowned', { typeLine: 'Instant', set: 'BBB' });
    const bbb = analytics.getSetCompletion(userId).find((s) => s.code === 'BBB');
    assert.equal(bbb.owned, 2);
    assert.equal(bbb.total, 3);
    assert.equal(bbb.percent, 66.67);
  });

  test('daily activity is only the days something happened', () => {
    audit(4, new Date().toISOString().slice(0, 10) + ' 09:00:00');
    const days = analytics.getDailyActivity(userId);
    const today = days.find((d) => d.date === new Date().toISOString().slice(0, 10));
    assert.equal(today.added, 4);
    assert.ok(days.every((d) => d.added || d.removed));
  });

  test('a snapshot is one row per user per day, replaced on a rerun', () => {
    analytics.recordValueSnapshots();
    analytics.recordValueSnapshots();
    const rows = analytics.getValueHistory(userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 130);
  });
});
