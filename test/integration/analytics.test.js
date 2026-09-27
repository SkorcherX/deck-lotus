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

  test('deck use counts in decks, lent out and idle, and ignores basics', () => {
    db.run(`INSERT INTO users (username, email, password_hash) VALUES ('p','p@example.test','h')`);
    const partnerId = db.get(`SELECT id FROM users WHERE username='p'`).id;
    const printing = (name) => db.get(
      `SELECT p.id, p.uuid FROM printings p JOIN cards c ON c.id = p.card_id WHERE c.name = ?`, [name]
    );

    db.run(`INSERT INTO decks (user_id, name, format, status) VALUES (?, 'D', 'commander', 'ready')`, [userId]);
    const deckId = db.get(`SELECT id FROM decks WHERE name = 'D'`).id;
    // Bolt: 5 owned (4 normal + 1 foil); a deck lists 2, one copy is lent out.
    db.run(`INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_foil, board_type)
            VALUES (?, ?, 2, 0, 0, 'mainboard')`, [deckId, printing('Bolt').id]);
    // Island in a deck changes nothing: basics are out of the count entirely.
    db.run(`INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_foil, board_type)
            VALUES (?, ?, 10, 0, 0, 'mainboard')`, [deckId, printing('Island').id]);
    db.run(`INSERT INTO card_loans (lender_user_id, borrower_user_id, printing_uuid, is_foil, quantity, card_name, status)
            VALUES (?, ?, ?, 0, 1, 'Bolt', 'active')`, [userId, partnerId, printing('Bolt').uuid]);
    // A returned loan is history, not a copy that is out.
    db.run(`INSERT INTO card_loans (lender_user_id, borrower_user_id, printing_uuid, is_foil, quantity, card_name, status)
            VALUES (?, ?, ?, 0, 1, 'Dual', 'returned')`, [userId, partnerId, printing('Dual').uuid]);

    const use = analytics.getDeckUse(userId);
    assert.equal(use.copies, 11, '21 owned less 10 Islands');
    assert.equal(use.inDecks, 2);
    assert.equal(use.lent, 1);
    assert.equal(use.idle, 8);
    assert.equal(use.cardsInNoDeck, 3);
    assert.equal(use.topIdle[0].name, 'Dual');

    // Trades: the caller proposed, gave 2 and received 3 — one received item declined.
    db.run(`INSERT INTO trades (from_user_id, to_user_id, status) VALUES (?, ?, 'accepted')`, [userId, partnerId]);
    const tradeId = db.get(`SELECT MAX(id) AS id FROM trades`).id;
    db.run(`INSERT INTO trade_items (trade_id, printing_id, is_foil, quantity, direction, declined) VALUES (?, ?, 0, 2, 'give', 0)`,
      [tradeId, printing('Rock').id]);
    db.run(`INSERT INTO trade_items (trade_id, printing_id, is_foil, quantity, direction, declined) VALUES (?, ?, 0, 3, 'receive', 0)`,
      [tradeId, printing('Charm').id]);
    db.run(`INSERT INTO trade_items (trade_id, printing_id, is_foil, quantity, direction, declined) VALUES (?, ?, 0, 9, 'receive', 1)`,
      [tradeId, printing('Dual').id]);
    // And one the partner proposed, still open.
    db.run(`INSERT INTO trades (from_user_id, to_user_id, status) VALUES (?, ?, 'pending')`, [partnerId, userId]);

    const tl = analytics.getTradesAndLoans(userId);
    assert.deepEqual(tl.trades, { accepted: 1, open: 1, closed: 0, cardsIn: 3, cardsOut: 2, withinGroup: 0 });
    assert.deepEqual(tl.loans, { lentNow: 1, borrowedNow: 0, made: 2, taken: 0, withinGroup: 0 });

    // The partner sees the same trade from the other side.
    const theirs = analytics.getTradesAndLoans(partnerId);
    assert.equal(theirs.trades.cardsIn, 2);
    assert.equal(theirs.trades.cardsOut, 3);
    assert.equal(theirs.loans.borrowedNow, 1);
  });

  test('a household scope counts trades and loans between its members as staying inside', () => {
    const partnerId = db.get(`SELECT id FROM users WHERE username='p'`).id;
    const household = [userId, partnerId];

    const tl = analytics.getTradesAndLoans(household);
    assert.equal(tl.trades.cardsIn, 0, 'nothing came from outside the household');
    assert.equal(tl.trades.cardsOut, 0);
    assert.equal(tl.trades.withinGroup, 1);
    assert.equal(tl.loans.lentNow, 0, 'a loan to a housemate is not lent out of the household');
    assert.equal(tl.loans.withinGroup, 2);

    assert.equal(analytics.getDeckUse(household).lent, 0);
  });

  test('a household scope adds collections together and counts shared cards once', () => {
    const partnerId = db.get(`SELECT id FROM users WHERE username='p'`).id;
    const bolt = db.get(`SELECT p.id FROM printings p JOIN cards c ON c.id = p.card_id WHERE c.name = 'Bolt'`).id;
    db.run(`INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?, ?, 2, 0)`, [partnerId, bolt]);

    const mine = analytics.getSummary(userId);
    const both = analytics.getSummary([userId, partnerId]);
    assert.equal(both.totalCards, mine.totalCards + 2);
    assert.equal(both.uniqueCards, mine.uniqueCards, 'Bolt is one card however many people own it');

    // Top cards group across people: one Bolt row, not one per owner.
    const bolts = analytics.getTopCards([userId, partnerId], 50).filter((r) => r.name === 'Bolt' && !r.isFoil);
    assert.equal(bolts.length, 1);
    assert.equal(bolts[0].quantity, 6);
  });

  test('price movers compare held printings against the history baseline', () => {
    assert.equal(analytics.getPriceMovers(userId).since, null, 'no history, no movers');

    const recorded = analytics.recordPriceHistory();
    assert.ok(recorded > 0);
    const untracked = db.get(`
      SELECT COUNT(*) AS n FROM price_history ph
       WHERE ph.printing_uuid NOT IN (
         SELECT p.uuid FROM owned_printings op JOIN printings p ON p.id = op.printing_id)`).n;
    assert.equal(untracked, 0, 'only printings someone owns are tracked');

    // Pretend that was eight days ago, then move the market.
    db.run(`UPDATE price_history SET snapshot_date = date('now', '-8 days')`);
    const setPrice = (name, type, price) => db.run(
      `UPDATE prices SET price = ? WHERE provider = 'tcgplayer' AND price_type = ?
         AND printing_uuid = (SELECT p.uuid FROM printings p JOIN cards c ON c.id = p.card_id WHERE c.name = ?)`,
      [price, type, name]
    );
    setPrice('Dual', 'normal', 90);    // 1 held: −10
    setPrice('Charm', 'normal', 12);   // 2 foils with no foil price, priced at normal: +4
    setPrice('Bolt', 'foil', 6);       // 1 foil: +1

    const m = analytics.getPriceMovers(userId, 7);
    assert.equal(m.since, db.get(`SELECT date('now', '-8 days') AS d`).d);
    assert.deepEqual(m.gainers.map((g) => [g.name, g.isFoil, g.totalChange]), [['Charm', true, 4], ['Bolt', true, 1]]);
    assert.deepEqual(m.losers.map((l) => [l.name, l.totalChange]), [['Dual', -10]]);
    assert.equal(m.netChange, -5);

    // The household holds the partner's two non-foil Bolts too, which did not move.
    const partnerId = db.get(`SELECT id FROM users WHERE username='p'`).id;
    assert.equal(analytics.getPriceMovers([userId, partnerId]).netChange, -5);
  });

  test('price history past the retention window is pruned', () => {
    db.run(`INSERT INTO price_history (printing_uuid, price_type, snapshot_date, price)
            VALUES ('uuid-Bolt', 'normal', date('now', '-500 days'), 1)`);
    analytics.recordPriceHistory();
    const old = db.get(`SELECT COUNT(*) AS n FROM price_history WHERE snapshot_date < date('now', '-400 days')`).n;
    assert.equal(old, 0);
  });

  test('a snapshot is one row per user per day, replaced on a rerun', () => {
    analytics.recordValueSnapshots();
    analytics.recordValueSnapshots();
    const rows = analytics.getValueHistory(userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, analytics.getSummary(userId).totalValue);
  });
});

describe('analytics scope', async () => {
  const { resolveScope } = await import('../../src/routes/analytics.js');

  test('a regular user always gets their own collection, whatever they ask for', () => {
    const req = { user: { id: userId, is_admin: 0 }, query: { userIds: '1,2,3' } };
    assert.deepEqual(resolveScope(req), [userId]);
  });

  test('an admin can pick users, and ids that are not users are dropped', () => {
    const partnerId = db.get(`SELECT id FROM users WHERE username='p'`).id;
    const req = { user: { id: userId, is_admin: 1 }, query: { userIds: `${partnerId},${userId},9999,abc,${partnerId}` } };
    assert.deepEqual(resolveScope(req), [partnerId, userId]);
  });

  test('an admin asking for nothing valid sees their own', () => {
    const req = { user: { id: userId, is_admin: true }, query: { userIds: '9999' } };
    assert.deepEqual(resolveScope(req), [userId]);
  });
});
