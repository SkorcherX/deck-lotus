/**
 * Export the collection, wipe it, paste the export back, and check you got the
 * same rows.
 *
 * The export exists to be re-imported, so that is what is asserted here rather
 * than the shape of any particular line. The two halves are written in
 * different places — `exportInventory` in the service, `parseCardLine` in
 * `src/shared/cardLines.js` — and nothing but this test makes them agree. A
 * format change on either side that the other does not follow shows up as a
 * collection that comes back subtly wrong, which is exactly the failure an
 * export nobody re-imports never reveals.
 *
 * Foil is the case worth the fixture: finish is half the unique key of
 * `owned_printings`, so an export that folds a foil in with its non-foil does
 * not lose a detail, it restores the wrong rows.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-export-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { exportInventory, bulkAddToInventory } = await import('../../src/services/inventoryService.js');
const { parseCardLine } = await import('../../src/shared/cardLines.js');

let userId;
const printings = {};

/** The collection as comparable rows: name, set, collector, finish, quantity. */
function collectionRows() {
  return db.all(`
    SELECT c.name, p.set_code, p.collector_number, op.is_foil, op.quantity
    FROM owned_printings op
    JOIN printings p ON op.printing_id = p.id
    JOIN cards c ON p.card_id = c.id
    WHERE op.user_id = ?
    ORDER BY c.name, p.set_code, p.collector_number, op.is_foil
  `, [userId]);
}

/** Feed exported text back through the parser the bulk-add box uses. */
function reimport(text) {
  const items = text
    .split('\n')
    .map((line) => parseCardLine(line))
    .filter(Boolean);
  return bulkAddToInventory(userId, items, { source: 'bulk_add' });
}

before(async () => {
  await runMigrations();

  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('owner','o@example.test','hash')`);
  userId = db.get(`SELECT id FROM users WHERE username='owner'`).id;

  db.run(`INSERT INTO sets (code, name) VALUES ('TST','Test Set')`);
  db.run(`INSERT INTO sets (code, name) VALUES ('OTH','Other Set')`);

  // Counterspell is printed twice, so a "names only" export has something to
  // sum across printings and a precise export has something to keep apart.
  const fixtures = [
    { name: 'Sol Ring', set: 'TST', collector: '1' },
    { name: 'Counterspell', set: 'TST', collector: '2' },
    { name: 'Counterspell', set: 'OTH', collector: '7' },
    { name: 'Brainstorm', set: 'TST', collector: '3' },
  ];

  for (const fixture of fixtures) {
    let card = db.get(`SELECT id FROM cards WHERE name = ?`, [fixture.name]);
    if (!card) {
      db.run(
        `INSERT INTO cards (name, name_normalized, type_line, color_identity) VALUES (?,?,?,?)`,
        [fixture.name, fixture.name.toLowerCase(), 'Artifact', '']
      );
      card = db.get(`SELECT id FROM cards WHERE name = ?`, [fixture.name]);
    }
    const uuid = `uuid-${fixture.set}-${fixture.collector}`;
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity)
       VALUES (?,?,?,?,'rare')`,
      [card.id, uuid, fixture.set, fixture.collector]
    );
    printings[uuid] = db.get(`SELECT id FROM printings WHERE uuid=?`, [uuid]).id;
  }

  const own = (uuid, quantity, isFoil) => db.run(
    `INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,?,?)`,
    [userId, printings[uuid], quantity, isFoil]
  );

  own('uuid-TST-1', 1, 0);
  // The same printing owned in both finishes, at different quantities, so a
  // collapse shows up as a wrong number rather than a plausible one.
  own('uuid-TST-2', 4, 0);
  own('uuid-TST-2', 2, 1);
  own('uuid-OTH-7', 3, 0);
  own('uuid-TST-3', 2, 1);
});

after(() => {
  closeDb();
  fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });
});

describe('inventory export', () => {
  test('precise export re-imports to the same collection', () => {
    const before = collectionRows();
    const exported = exportInventory(userId, { shape: 'precise' });

    db.run(`DELETE FROM owned_printings WHERE user_id = ?`, [userId]);
    assert.equal(collectionRows().length, 0);

    reimport(exported.text);

    assert.deepEqual(collectionRows(), before);
  });

  test('every line carries its printing and its finish', () => {
    const { text } = exportInventory(userId, { shape: 'precise' });
    const lines = text.split('\n').filter((line) => !line.startsWith('//'));

    assert.ok(lines.includes('4 Counterspell (TST) 2'));
    assert.ok(lines.includes('2 Counterspell (TST) 2 *F*'));
    assert.ok(lines.includes('3 Counterspell (OTH) 7'));
  });

  test('the header is dropped by the parser it is pasted into', () => {
    const { text } = exportInventory(userId, { shape: 'precise' });
    const header = text.split('\n').filter((line) => line.startsWith('//'));

    assert.ok(header.length > 0, 'export should be labelled');
    for (const line of header) assert.equal(parseCardLine(line), null);
  });

  test('names-only export sums printings but not finishes', () => {
    const { text } = exportInventory(userId, { shape: 'simple' });
    const lines = text.split('\n').filter((line) => !line.startsWith('//'));

    // 4 in TST plus 3 in OTH, with the two foils still on their own line.
    assert.ok(lines.includes('7 Counterspell'));
    assert.ok(lines.includes('2 Counterspell *F*'));
    assert.ok(!lines.some((line) => line.includes('(TST)')));
  });

  test('counts describe the collection, not the line count', () => {
    const precise = exportInventory(userId, { shape: 'precise' });
    const simple = exportInventory(userId, { shape: 'simple' });

    assert.equal(precise.cards, 3);
    assert.equal(precise.copies, 12);
    assert.equal(precise.lines, 5);

    // Same collection, same totals, fewer lines.
    assert.equal(simple.cards, precise.cards);
    assert.equal(simple.copies, precise.copies);
    assert.ok(simple.lines < precise.lines);
  });

  test('an empty collection exports a header and nothing else', () => {
    db.run(`INSERT INTO users (username, email, password_hash) VALUES ('empty','e@example.test','hash')`);
    const emptyId = db.get(`SELECT id FROM users WHERE username='empty'`).id;

    const result = exportInventory(emptyId, { shape: 'precise' });
    assert.equal(result.lines, 0);
    assert.equal(result.copies, 0);
    assert.ok(result.text.split('\n').every((line) => line.startsWith('//')));
  });
});
