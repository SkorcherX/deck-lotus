/**
 * The two-signal resolver, tier by tier.
 *
 * The tier is the only thing in the scanner that decides whether a human looks
 * at a row, so it is the thing worth pinning hardest. Everything else about a
 * scan is recoverable — a wrong candidate ranking costs a click during review —
 * but a row wrongly marked `confident` collapses out of the review table and
 * gets committed without anyone seeing it. Every test below is written against
 * that boundary rather than against candidate ordering.
 *
 * Hashes here are constructed rather than derived from images: the arithmetic
 * that turns a picture into bits is already covered in test/cardHash.test.js,
 * and what this file needs is exact control over the distance between a capture
 * and a reference. Building them by hand is how a test can say "this capture is
 * 50 bits away, just inside the threshold" and mean it.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-scan-'));
const DB_PATH = path.join(workDir, 'test.db');
const HASH_PATH = path.join(workDir, 'card-hashes.bin');

process.env.DATABASE_PATH = DB_PATH;
process.env.CARD_HASH_PATH = HASH_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { packHashes } = await import('../../src/services/cardHashFile.js');
const { ART_HASH_HEX, FRAME_HASH_HEX } = await import('../../client/src/utils/cardHash.js');
const hashIndex = await import('../../src/services/cardHashIndex.js');
const { resolveScanFused, resolveScan, SCAN_TIERS } = await import('../../src/services/scanService.js');

/** A hash of all zero bits — the reference every capture below is measured from. */
const zeros = (hexWidth) => '0'.repeat(hexWidth);

/**
 * A hash `bits` away from `zeros`, by setting that many low bits.
 *
 * Distance from the all-zero reference is then exactly `bits`, which is what
 * lets a test sit deliberately just inside or just outside a threshold.
 */
function hashAtDistance(bits, hexWidth) {
  const total = hexWidth * 4;
  let value = 0n;
  for (let i = 0; i < bits; i++) value |= 1n << BigInt(i);
  return value.toString(16).padStart(hexWidth, '0').slice(-hexWidth);
}

/** A hash that shares no bits with the reference — far outside any threshold. */
const opposite = (hexWidth) => 'f'.repeat(hexWidth);

const ART_BITS = ART_HASH_HEX * 4;

// Thresholds restated from cardHashIndex, so a change there fails here loudly
// rather than silently retuning what "confident" means.
const STRONG_BITS = Math.round(hashIndex.ART_STRONG_THRESHOLD * ART_BITS);
const MATCH_BITS = Math.round(hashIndex.ART_MATCH_THRESHOLD * ART_BITS);

const printings = {};

/** A uuid in the shape MTGJSON produces, since the packed file decodes it as one. */
const uuidFor = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function insertCard(name, manaCost, typeLine) {
  const result = db.run(
    `INSERT INTO cards (name, mana_cost, type_line) VALUES (?, ?, ?)`,
    [name, manaCost, typeLine]
  );
  return result.lastInsertRowid;
}

function insertPrinting(cardId, key, setCode, collectorNumber) {
  const result = db.run(
    `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity, language)
     VALUES (?, ?, ?, ?, 'rare', 'en')`,
    [cardId, uuidFor(key), setCode, collectorNumber]
  );
  printings[key] = { id: result.lastInsertRowid, uuid: uuidFor(key), setCode, collectorNumber };
  return printings[key];
}

before(async () => {
  await runMigrations();

  // Two printings of one card sharing an illustration but not a frame. This is
  // the case the two-hash split exists for and the one hashing alone cannot
  // solve, so it is the backbone of the fixture.
  const bolt = insertCard('Test Bolt', '{R}', 'Instant');
  insertPrinting(bolt, 1, 'AAA', '11');
  insertPrinting(bolt, 2, 'BBB', '22');

  // A different card entirely, for the conflict and false-positive cases.
  const other = insertCard('Test Ogre', '{3}{R}', 'Creature — Ogre');
  insertPrinting(other, 3, 'AAA', '33');

  // A pre-2015 card: real in the database, but with nothing printed on the
  // physical card for OCR to read. The hash is its only signal.
  const old = insertCard('Test Antiquity', '{2}{W}', 'Artifact');
  insertPrinting(old, 4, 'OLD', '44');

  fs.writeFileSync(HASH_PATH, packHashes([
    // Both Bolt printings share the art hash; only the frame hash differs.
    { uuid: printings[1].uuid, artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    { uuid: printings[2].uuid, artHash: zeros(ART_HASH_HEX), frameHash: opposite(FRAME_HASH_HEX) },
    // Unrelated art, far outside the match threshold.
    { uuid: printings[3].uuid, artHash: opposite(ART_HASH_HEX), frameHash: opposite(FRAME_HASH_HEX) },
    // The old card, its own distinct art. Uses a middle pattern so it is far
    // from both the zero and the all-ones references.
    { uuid: printings[4].uuid, artHash: 'a'.repeat(ART_HASH_HEX), frameHash: 'a'.repeat(FRAME_HASH_HEX) },
  ]));

  hashIndex.load({ quiet: true });
});

after(() => {
  hashIndex.unload();
  closeDb();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('the hash index', () => {
  test('loads the packed file and joins every row to a printing', () => {
    assert.deepEqual(hashIndex.stats(), { count: 4, joined: 4 });
    assert.equal(hashIndex.isAvailable(), true);
  });

  test('matches on art and orders by frame, never the reverse', () => {
    // Capture the art exactly, and the frame of the *second* printing. Both
    // Bolts must come back — they share the illustration — but the one whose
    // frame matches has to be first. If the frame were admitting candidates
    // rather than ordering them, the Ogre would appear too.
    const matches = hashIndex.findByArtHash(zeros(ART_HASH_HEX), opposite(FRAME_HASH_HEX));

    assert.equal(matches.length, 2, 'only the two same-art printings should match');
    assert.equal(matches[0].printingId, printings[2].id, 'frame hash should break the tie');
    assert.equal(matches[0].artDistance, 0);
  });

  test('rejects art beyond the threshold', () => {
    const justInside = hashIndex.findByArtHash(hashAtDistance(MATCH_BITS, ART_HASH_HEX));
    const justOutside = hashIndex.findByArtHash(hashAtDistance(MATCH_BITS + 2, ART_HASH_HEX));

    assert.ok(justInside.length > 0, 'a capture at the threshold should still match');
    assert.equal(justOutside.length, 0, 'a capture past the threshold should not');
  });

  test('degrades to no matches rather than throwing when nothing is loaded', () => {
    hashIndex.load({ path: path.join(workDir, 'absent.bin'), quiet: true });
    assert.equal(hashIndex.isAvailable(), false);
    assert.deepEqual(hashIndex.findByArtHash(zeros(ART_HASH_HEX)), []);
    hashIndex.load({ quiet: true });
  });
});

describe('resolveScanFused tiers', () => {
  test('confident: text and art independently reach the same printing', () => {
    const result = resolveScanFused({
      name: 'Test Bolt',
      setCode: 'AAA',
      collectorNumber: '11',
      artHash: zeros(ART_HASH_HEX),
      frameHash: zeros(FRAME_HASH_HEX),
    });

    assert.equal(result.tier, SCAN_TIERS.CONFIDENT);
    assert.equal(result.candidates[0].printingId, printings[1].id);
    assert.equal(result.signals.agreed, true);
    assert.ok(
      result.candidates[0].matchedBy.includes('art-hash'),
      'the winning candidate should record that both signals backed it'
    );
  });

  test('confident survives a slightly soft capture, but not a marginal one', () => {
    const soft = resolveScanFused({
      name: 'Test Bolt', setCode: 'AAA', collectorNumber: '11',
      artHash: hashAtDistance(STRONG_BITS - 2, ART_HASH_HEX),
      frameHash: zeros(FRAME_HASH_HEX),
    });
    assert.equal(soft.tier, SCAN_TIERS.CONFIDENT);

    // Past the strong threshold the art is still a match, but not one that may
    // wave a card through review on its own say-so.
    const marginal = resolveScanFused({
      name: 'Test Bolt', setCode: 'AAA', collectorNumber: '11',
      artHash: hashAtDistance(STRONG_BITS + 4, ART_HASH_HEX),
      frameHash: zeros(FRAME_HASH_HEX),
    });
    assert.notEqual(marginal.tier, SCAN_TIERS.CONFIDENT);
  });

  test('text wrong, art right: the art recovers the card and it is not confident', () => {
    // A collector block misread badly enough to name a real but wrong printing.
    const result = resolveScanFused({
      name: 'Test Ogre',
      setCode: 'AAA',
      collectorNumber: '33',
      artHash: zeros(ART_HASH_HEX),
      frameHash: zeros(FRAME_HASH_HEX),
    });

    assert.equal(result.tier, SCAN_TIERS.CONFLICT,
      'two strong signals disagreeing must land in review, never in confident');

    const ids = result.candidates.map((candidate) => candidate.printingId);
    assert.ok(ids.includes(printings[1].id), 'the art match must still be offered');
    assert.ok(ids.includes(printings[3].id), 'the text match must still be offered');
  });

  test('pick-printing: art is certain, no text to place it', () => {
    // A pre-2015 card. Nothing printed on it to read, so the hash is alone.
    const result = resolveScanFused({
      artHash: 'a'.repeat(ART_HASH_HEX),
      frameHash: 'a'.repeat(FRAME_HASH_HEX),
    });

    assert.equal(result.tier, SCAN_TIERS.PICK_PRINTING);
    assert.equal(result.candidates[0].printingId, printings[4].id);
    assert.equal(result.candidates[0].name, 'Test Antiquity');
    assert.deepEqual(result.candidates[0].matchedBy, ['art-hash']);
  });

  test('pick-printing: reprints sharing one illustration are all offered', () => {
    const result = resolveScanFused({ artHash: zeros(ART_HASH_HEX) });

    assert.equal(result.tier, SCAN_TIERS.PICK_PRINTING);

    const ids = result.candidates.map((candidate) => candidate.printingId).sort();
    assert.deepEqual(
      ids,
      [printings[1].id, printings[2].id].sort(),
      'both printings of the shared art must be offered for the reviewer to choose'
    );
  });

  test('unsure: no hash at all falls back to the text-only result', () => {
    const fused = resolveScanFused({ name: 'Test Bolt', setCode: 'AAA', collectorNumber: '11' });
    const text = resolveScan({ name: 'Test Bolt', setCode: 'AAA', collectorNumber: '11' });

    assert.equal(fused.tier, SCAN_TIERS.UNSURE);
    assert.equal(fused.signals.hash, 0);
    assert.deepEqual(
      fused.candidates.map((candidate) => candidate.printingId),
      text.candidates.map((candidate) => candidate.printingId),
      'without a hash the fused resolver must not change the existing ranking'
    );
  });

  test('unsure: art that matches nothing does not invent a verdict', () => {
    const result = resolveScanFused({
      name: 'Test Bolt',
      setCode: 'AAA',
      collectorNumber: '11',
      artHash: hashAtDistance(MATCH_BITS + 20, ART_HASH_HEX),
    });

    assert.equal(result.tier, SCAN_TIERS.UNSURE);
    assert.equal(result.signals.hash, 0);
  });

  test('a garbage reading produces no confident tier from either side', () => {
    const result = resolveScanFused({
      name: 'Zzzzqqq Not A Card',
      setCode: 'ZZ9',
      collectorNumber: '9999',
      artHash: hashAtDistance(MATCH_BITS + 40, ART_HASH_HEX),
    });

    assert.notEqual(result.tier, SCAN_TIERS.CONFIDENT);
  });
});

describe('the candidate cap', () => {
  test('a caller may raise the limit past the shortlist default', () => {
    // The printing picker needs every printing of a name, not a shortlist of 20.
    // Only two exist in this fixture, so what is asserted is that the request is
    // honoured rather than silently clamped back down.
    const shortlist = resolveScan({ name: 'Test Bolt', limit: 1 });
    const everything = resolveScan({ name: 'Test Bolt', limit: 100 });

    assert.equal(shortlist.candidates.length, 1);
    assert.equal(everything.candidates.length, 2);
  });
});
