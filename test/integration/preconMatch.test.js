/**
 * Recognising a deck that came out of a box.
 *
 * The cases that matter are the ones the obvious implementation gets wrong:
 *
 *   - a precon whose commander has been swapped is still a precon. This is the
 *     real case: C21's "Witherbloom Witchcraft" ships with Willowdusk as its
 *     face commander, and the copy this feature was written for runs Beledros
 *     Witherbloom instead. Matching on the commander would miss it entirely.
 *   - two unrelated Commander decks share Sol Ring, Command Tower and twenty
 *     basic lands. That overlap is not provenance, and reporting it as one
 *     would be a false claim about where a deck came from.
 *   - a precon used as a starting point and half rebuilt is not a precon.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-precon-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const {
  findPreconMatch, compareToPrecon, describeMatch, hasPrecons, STOCK_THRESHOLD,
} = await import('../../src/services/preconService.js');
const { normalizeForSearch } = await import('../../src/utils/cardNameMatch.js');

/** The staples and basics every Commander deck shares. */
const SHARED = [
  { name: 'Sol Ring', quantity: 1 },
  { name: 'Command Tower', quantity: 1 },
  { name: 'Arcane Signet', quantity: 1 },
  { name: 'Forest', quantity: 12 },
  { name: 'Swamp', quantity: 12 },
];

const themed = (prefix, n, from = 0) =>
  [...Array(n)].map((_, i) => ({ name: `${prefix} ${i + from}`, quantity: 1 }));

function storePrecon(fileName, name, setCode, cards) {
  db.run(
    `INSERT INTO precon_decks (file_name, name, set_code, type, release_date, total_cards)
     VALUES (?,?,?,'Commander Deck','2021-04-23',?)`,
    [fileName, name, setCode, cards.reduce((s, c) => s + c.quantity, 0)]
  );
  const id = db.get(`SELECT id FROM precon_decks WHERE file_name = ?`, [fileName]).id;
  for (const card of cards) {
    db.run(
      `INSERT INTO precon_deck_cards
         (precon_deck_id, card_name, card_name_normalized, quantity, is_commander, is_sideboard)
       VALUES (?,?,?,?,?,0)`,
      [id, card.name, normalizeForSearch(card.name), card.quantity, card.isCommander ? 1 : 0]
    );
  }
  return id;
}

// 100 cards: a face commander, staples/basics, and 72 deck-specific cards.
const WITHERBLOOM = [
  { name: 'Willowdusk, Essence Seer', quantity: 1, isCommander: true },
  ...SHARED,
  ...themed('Witherbloom Card', 72),
];

const DRACONIC = [
  { name: 'Vrondiss, Rage of Ancients', quantity: 1, isCommander: true },
  ...SHARED,
  ...themed('Draconic Card', 72),
];

before(async () => {
  await runMigrations();
  storePrecon('WitherbloomWitchcraft_C21', 'Witherbloom Witchcraft', 'C21', WITHERBLOOM);
  storePrecon('DraconicRage_VOC', 'Draconic Rage', 'VOC', DRACONIC);
});

after(() => {
  closeDb();
  fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });
});

describe('compareToPrecon', () => {
  test('an untouched deck is entirely stock', () => {
    const result = compareToPrecon(WITHERBLOOM, WITHERBLOOM);
    assert.equal(result.stock, 1);
    assert.equal(result.added.length, 0);
    assert.equal(result.removed.length, 0);
  });

  test('extra copies beyond the precon count as the owner\'s own', () => {
    const deck = [{ name: 'Forest', quantity: 20 }];
    const result = compareToPrecon(deck, [{ name: 'Forest', quantity: 12 }]);
    // Twelve came out of the box; eight did not.
    assert.equal(result.shared, 12);
    assert.deepEqual(result.added, [{ name: 'Forest', quantity: 8 }]);
  });

  test('stock and coverage answer different questions', () => {
    // Half a precon inside a full deck: most of the deck is not the precon,
    // and most of the precon is not in the deck.
    const deck = [...themed('Witherbloom Card', 36), ...themed('Mine', 64)];
    const result = compareToPrecon(deck, WITHERBLOOM);
    assert.ok(Math.abs(result.stock - 0.36) < 0.01);
    assert.ok(Math.abs(result.coverage - 0.36) < 0.01);
  });
});

describe('findPreconMatch', () => {
  test('an untouched precon matches completely and collapses', () => {
    const match = findPreconMatch(WITHERBLOOM);
    assert.equal(match.name, 'Witherbloom Witchcraft');
    assert.equal(match.stock, 1);
    assert.equal(match.isStock, true);
    assert.match(describeMatch(match), /unchanged/);
  });

  test('a swapped commander is still the same precon', () => {
    // The case this feature exists for. Beledros is printed in the same box
    // but is not the face commander, so the deck matches on its other 99.
    const deck = WITHERBLOOM
      .filter((c) => !c.isCommander)
      .concat({ name: 'Beledros Witherbloom', quantity: 1 });

    const match = findPreconMatch(deck);
    assert.equal(match.name, 'Witherbloom Witchcraft');
    assert.ok(match.stock >= 0.98, `expected near-stock, got ${match.stock}`);
    assert.equal(match.isStock, true);
    assert.deepEqual(match.added, [{ name: 'Beledros Witherbloom', quantity: 1 }]);
    assert.deepEqual(match.removed, [{ name: 'Willowdusk, Essence Seer', quantity: 1 }]);
  });

  test('the summary names what changed rather than claiming it is untouched', () => {
    const deck = WITHERBLOOM
      .filter((c) => !c.isCommander)
      .concat({ name: 'Beledros Witherbloom', quantity: 1 });

    const summary = describeMatch(findPreconMatch(deck));
    assert.match(summary, /Witherbloom Witchcraft/);
    assert.match(summary, /added/);
    assert.ok(!/unchanged/.test(summary));
  });

  test('shared staples and basics are not provenance', () => {
    // An unrelated deck with the same staples and basics overlaps a precon
    // substantially and must not be reported as one.
    const unrelated = [...SHARED, ...themed('Something Else', 73)];
    assert.equal(findPreconMatch(unrelated), null);
  });

  test('a precon half rebuilt is no longer treated as one', () => {
    const rebuilt = [
      ...WITHERBLOOM.filter((c) => !c.isCommander).slice(0, 45),
      ...themed('My Own Card', 55),
    ];
    const match = findPreconMatch(rebuilt);
    // It may still be recognisable, but must not collapse the findings.
    if (match) assert.equal(match.isStock, false);
  });

  test('it picks the closer of two precons', () => {
    const deck = [...DRACONIC];
    assert.equal(findPreconMatch(deck).name, 'Draconic Rage');
  });

  test('an empty deck matches nothing', () => {
    assert.equal(findPreconMatch([]), null);
  });

  test('the threshold is reported, not just the verdict', () => {
    const match = findPreconMatch(WITHERBLOOM);
    assert.equal(typeof match.stock, 'number');
    assert.equal(match.isStock, match.stock >= STOCK_THRESHOLD);
  });
});

describe('hasPrecons', () => {
  test('true once decklists are stored', () => {
    assert.equal(hasPrecons(), true);
  });
});
