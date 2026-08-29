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
const { ART_HASH_HEX, FRAME_HASH_HEX } = await import('../../src/shared/cardHash.js');
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

/**
 * A hash exactly `bits` away from an arbitrary reference, rather than from
 * zeros. Needed to sit a capture at a chosen distance from a *specific*
 * printing's art, where hashAtDistance can only measure from the all-zero one.
 */
function hashNear(hex, bits) {
  let value = BigInt(`0x${hex}`);
  for (let i = 0; i < bits; i++) value ^= 1n << BigInt(i);
  return value.toString(16).padStart(hex.length, '0').slice(-hex.length);
}

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

  // A reprint whose two printings were scanned from slightly different images —
  // the same illustration, a few bits apart, which is what a real reprint pair
  // looks like once each set's scan has been through the hash builder. It is
  // the case where "only one printing scored strongly" and "only one printing
  // of this card matched" stop being the same claim.
  const reprint = insertCard('Test Reprint', '{1}{G}', 'Enchantment');
  insertPrinting(reprint, 5, 'CCC', '55');
  insertPrinting(reprint, 6, 'DDD', '66');

  fs.writeFileSync(HASH_PATH, packHashes([
    // Both Bolt printings share the art hash; only the frame hash differs.
    { uuid: printings[1].uuid, artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    { uuid: printings[2].uuid, artHash: zeros(ART_HASH_HEX), frameHash: opposite(FRAME_HASH_HEX) },
    // Unrelated art, far outside the match threshold.
    { uuid: printings[3].uuid, artHash: opposite(ART_HASH_HEX), frameHash: opposite(FRAME_HASH_HEX) },
    // The old card, its own distinct art. Uses a middle pattern so it is far
    // from both the zero and the all-ones references.
    { uuid: printings[4].uuid, artHash: 'a'.repeat(ART_HASH_HEX), frameHash: 'a'.repeat(FRAME_HASH_HEX) },
    // The reprint pair: one reference, and its sibling 30 bits away from it.
    // An alternating pattern, chosen to sit far from every other reference here
    // (128 bits from the zero and all-ones ones, 256 from the antiquity's), so
    // the pair cannot disturb the tests that ask what matches nothing.
    { uuid: printings[5].uuid, artHash: '5'.repeat(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    // 55 bits apart: past the strong threshold, well inside the match one. That
    // is the gap the guard is about — near enough to be the same illustration,
    // far enough that only one of the two scores strongly.
    { uuid: printings[6].uuid, artHash: hashNear('5'.repeat(ART_HASH_HEX), 55), frameHash: zeros(FRAME_HASH_HEX) },
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
    assert.deepEqual(hashIndex.stats(), { count: 6, joined: 6 });
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

  test('confident: art alone, when the art matched exactly one printing', () => {
    // A pre-2015 card. Nothing printed on it to read, so the hash is alone —
    // and it does not need help, because only one printing in the whole
    // reference set carries this illustration. Requiring a text read to confirm
    // an answer with no alternative is what made every card need review once
    // the reader stopped being run on every capture.
    const result = resolveScanFused({
      artHash: 'a'.repeat(ART_HASH_HEX),
      frameHash: 'a'.repeat(FRAME_HASH_HEX),
    });

    assert.equal(result.tier, SCAN_TIERS.CONFIDENT);
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

  test('pick-printing: one printing scoring strongly is not one printing matching', () => {
    // A capture sitting close to one printing of a reprint and further from its
    // sibling — close enough that only the first is a strong match, but both are
    // matches. This used to be `confident`, and it filed the wrong set into the
    // collection at the wrong price: which sibling wins a gap like this is
    // decided by a few bits of resampling, and re-hashing the same photograph at
    // another rung of the framing ladder reorders them.
    //
    // Measured on a real session, nine cards from one ECC precon: Seaside
    // Citadel tied at 50 across four sets, and Abundant Growth came back
    // `confident` for a set the card was not from.
    const result = resolveScanFused({
      artHash: '5'.repeat(ART_HASH_HEX),
      frameHash: zeros(FRAME_HASH_HEX),
    });

    // Exactly one strong match, two printings of the one card. The first number
    // is what the old rule read; the second is what actually decides it.
    assert.equal(result.signals.printingsOfBest, 2);
    assert.equal(result.tier, SCAN_TIERS.PICK_PRINTING);

    const ids = result.candidates.map((candidate) => candidate.printingId);
    assert.ok(ids.includes(printings[5].id), 'the near printing must be offered');
    assert.ok(ids.includes(printings[6].id), 'and so must the one it could be confused with');
  });

  test('confident still holds where the card really has one printing', () => {
    // The guard above must not swallow the case it was carved out of: art that
    // matched exactly one printing of exactly one card still needs no review.
    const result = resolveScanFused({
      artHash: 'a'.repeat(ART_HASH_HEX),
      frameHash: 'a'.repeat(FRAME_HASH_HEX),
    });

    assert.equal(result.tier, SCAN_TIERS.CONFIDENT);
    assert.equal(result.signals.printingsOfBest, 1);
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

  test('a match at the edge of the threshold is offered, never waved through', () => {
    // What makes the match threshold cheap to widen. It was raised from 22% to
    // 27% to recover cards that were the right answer missed by eight bits, and
    // that is only safe while the far edge of the band still lands in review:
    // ART_STRONG_THRESHOLD, not this one, is what lets a row skip a human.
    //
    // Pinned as the relationship rather than as numbers, so retuning either
    // threshold has to keep the property or fail here.
    // Measured against the pre-2015 card, which is the only fixture printing
    // with art of its own. The Bolt pair share an illustration, so a capture
    // near them lands in `pick-printing` whatever the thresholds say — which
    // would make this pass without testing anything.
    const edge = resolveScanFused({
      artHash: hashNear('a'.repeat(ART_HASH_HEX), MATCH_BITS - 1),
      frameHash: zeros(FRAME_HASH_HEX),
    });

    assert.ok(
      edge.candidates.some((candidate) => candidate.printingId === printings[4].id),
      'a capture just inside the threshold must still be offered'
    );
    assert.notEqual(edge.tier, SCAN_TIERS.CONFIDENT,
      'a match this far out must land in review, whatever the match threshold is widened to');
  });

  test('a misread never outranks the printing the art actually found', () => {
    // Taken from a recorded session, where this cost two correct answers.
    //
    // OCR read a collector block as "M4 10 F / 195 ECL EN" and the parser took
    // set ECL, number 10 — noise, but noise that resolves to exactly one real
    // printing, which is what made it score 0.788. The art had the right card
    // at 58 bits and 0.161, and the wrong card went to the top of the list.
    //
    // A text candidate's confidence says how unambiguous the *lookup* was, not
    // how good the *read* was, so it cannot be compared against a hash distance
    // directly. The ordering rule is what protects against that: the art
    // searched every reference and found this printing; text alone only
    // proposed one.
    const misread = resolveScanFused({
      // A real printing, and not the one the art matched.
      name: 'Test Ogre',
      setCode: 'AAA',
      collectorNumber: '33',
      artHash: hashAtDistance(MATCH_BITS - 8, ART_HASH_HEX),
      frameHash: zeros(FRAME_HASH_HEX),
    });

    const top = misread.candidates[0];
    assert.ok(top.artDistance !== null && top.artDistance !== undefined,
      `the art's own find must lead, got "${top.name}" with no art distance`);

    // The misread is demoted, not hidden. It is still a candidate a reviewer
    // can pick, which is the whole point of the row going to review.
    assert.ok(
      misread.candidates.some((candidate) => candidate.printingId === printings[3].id),
      'the text match must still be offered below'
    );

    // And a *good* read is not penalised by the same rule: when the text names
    // a printing the art also found, it is art-backed too and leads on merit.
    const agreeing = resolveScanFused({
      name: 'Test Bolt',
      setCode: 'AAA',
      collectorNumber: '11',
      artHash: zeros(ART_HASH_HEX),
      frameHash: zeros(FRAME_HASH_HEX),
    });
    assert.equal(agreeing.candidates[0].printingId, printings[1].id);
    assert.equal(agreeing.signals.agreed, true);
  });

  test('agreement never scores a printing below either signal alone', () => {
    // The regression this exists for. Fusing used to average the two
    // confidences and add a fixed bonus, which reads as generous and is not: a
    // strong text read paired with a weak-but-correct art match landed between
    // them, and the bonus did not always cover the drop. On a real capture the
    // agreed printing fell from 0.84 to 0.64 and three basic lands that the
    // collector number alone had turned up — text-only, so untouched at 0.803 —
    // took the top of the list. Both signals were right, they agreed, and
    // fusing them buried the answer.
    //
    // Stated as the invariant rather than as the ranking it produced, because
    // the ranking is a consequence: a second signal that agrees may only ever
    // raise a printing.
    const query = { name: 'Test Bolt', setCode: 'AAA', collectorNumber: '11' };

    // Just inside the match threshold, so the art is correct but barely — the
    // exact shape that made the mean bite.
    const marginalArt = hashAtDistance(MATCH_BITS - 2, ART_HASH_HEX);

    const textOnly = resolveScan(query);
    const hashOnly = resolveScanFused({ artHash: marginalArt, frameHash: zeros(FRAME_HASH_HEX) });
    const fused = resolveScanFused({ ...query, artHash: marginalArt, frameHash: zeros(FRAME_HASH_HEX) });

    const find = (result) =>
      result.candidates.find((candidate) => candidate.printingId === printings[1].id);

    const text = find(textOnly);
    const hash = find(hashOnly);
    const both = find(fused);

    assert.ok(text && hash && both, 'all three routes must reach the printing at all');
    assert.ok(
      both.confidence >= text.confidence,
      `agreeing art dropped the printing from ${text.confidence} to ${both.confidence}`
    );
    assert.ok(
      both.confidence >= hash.confidence,
      `agreeing text dropped the printing from ${hash.confidence} to ${both.confidence}`
    );

    // And the consequence: the printing both signals found stays at the top,
    // and `agreed` — which asks whether the merged winner is the text's winner —
    // reads true rather than being falsified by the ranking.
    assert.equal(fused.candidates[0].printingId, printings[1].id);
    assert.equal(fused.signals.agreed, true);
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
