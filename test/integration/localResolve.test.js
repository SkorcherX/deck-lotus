/**
 * The device and the server must reach the same verdict.
 *
 * This is the test the whole on-device matching exercise rests on. The point of
 * moving the ranking into `src/shared/scanFusion.js` was that there would be
 * *one* copy of the rules, so a card matched on a phone is tiered, ordered and
 * biased exactly as one matched over the network — and the failure mode if that
 * ever stops being true is not an error, it is a session of cards quietly filed
 * under the wrong printings by whichever half answered.
 *
 * So: one fixture, one packed index, one identity table, and every assertion
 * below is device against server rather than device against a hand-written
 * expectation. A change that alters both in the same way is a change to the
 * scanner; a change that alters one of them is a bug this file exists to catch.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-local-'));
const DB_PATH = path.join(workDir, 'test.db');
const HASH_PATH = path.join(workDir, 'card-hashes.bin');

process.env.DATABASE_PATH = DB_PATH;
process.env.CARD_HASH_PATH = HASH_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { packHashes } = await import('../../src/services/cardHashFile.js');
const { ART_HASH_HEX, FRAME_HASH_HEX } = await import('../../src/shared/cardHash.js');
const hashIndex = await import('../../src/services/cardHashIndex.js');
const { identityPayload } = await import('../../src/services/scanIdentityService.js');
const { resolveScanFused, SCAN_TIERS } = await import('../../src/services/scanService.js');
const local = await import('../../client/src/utils/localIndex.js');

const zeros = (hexWidth) => '0'.repeat(hexWidth);

function hashAtDistance(bits, hexWidth) {
  let value = 0n;
  for (let i = 0; i < bits; i++) value |= 1n << BigInt(i);
  return value.toString(16).padStart(hexWidth, '0').slice(-hexWidth);
}

const uuidFor = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const printings = {};

function insertPrinting(cardId, key, setCode, collectorNumber) {
  const result = db.run(
    `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity, language, image_url)
     VALUES (?, ?, ?, ?, 'rare', 'en', ?)`,
    [cardId, uuidFor(key), setCode, collectorNumber, `https://example.test/${key}.jpg`]
  );
  printings[key] = { id: result.lastInsertRowid, uuid: uuidFor(key), setCode, collectorNumber };
  return printings[key];
}

/** The buffer shape a browser hands `parse` — an ArrayBuffer, not a Node view. */
const buffer = (node) => node.buffer.slice(node.byteOffset, node.byteOffset + node.byteLength);

before(async () => {
  await runMigrations();

  const bolt = db.run(`INSERT INTO cards (name, mana_cost, type_line) VALUES (?, ?, ?)`, [
    'Test Bolt', '{R}', 'Instant',
  ]).lastInsertRowid;
  // Two printings of one card, four bits apart: a reprint, which is the case
  // where the art names the card and has nothing to say about the printing.
  insertPrinting(bolt, 1, 'AAA', '11');
  insertPrinting(bolt, 2, 'BBB', '22');

  const ogre = db.run(`INSERT INTO cards (name, mana_cost, type_line) VALUES (?, ?, ?)`, [
    'Test Ogre', '{3}{R}', 'Creature — Ogre',
  ]).lastInsertRowid;
  insertPrinting(ogre, 3, 'CCC', '33');

  // A price on one of them, because the price band is the pulse colour and the
  // device is expected to know it without asking.
  db.run(
    `INSERT INTO prices (printing_uuid, provider, price_type, price)
     VALUES (?, 'tcgplayer', 'normal', 12.5)`,
    [uuidFor(1)]
  );
  // And a foil-only price on its reprint, which is the shape that produced the
  // bug these tests pin: a printing with no normal price at all falls back to
  // the foil one, and foil-only printings are the showcase and serialised
  // ones. Flusterstorm is $9.78 as SOA 18 and $208.59 as the foil-only SOA 148,
  // and a scan of the cheap one was pricing it at the dear one's figure.
  db.run(
    `INSERT INTO prices (printing_uuid, provider, price_type, price)
     VALUES (?, 'tcgplayer', 'foil', 208.59)`,
    [uuidFor(2)]
  );

  fs.writeFileSync(
    HASH_PATH,
    packHashes([
      { uuid: uuidFor(1), artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
      {
        uuid: uuidFor(2),
        artHash: hashAtDistance(4, ART_HASH_HEX),
        frameHash: hashAtDistance(30, FRAME_HASH_HEX),
      },
      {
        uuid: uuidFor(3),
        artHash: hashAtDistance(60, ART_HASH_HEX),
        frameHash: zeros(FRAME_HASH_HEX),
      },
    ])
  );

  hashIndex.load({ path: HASH_PATH, quiet: true });

  // The device gets exactly what the endpoint would have served it.
  local.parse(buffer(fs.readFileSync(HASH_PATH)));
  await local.loadIdentity(async () => JSON.parse(identityPayload().body));
});

after(() => {
  hashIndex.unload();
  closeDb();
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Both resolvers over one capture, for comparing field by field. */
function bothWays(probes, setBias = null) {
  return {
    device: local.resolve({ probes, setBias, limit: 25 }),
    server: resolveScanFused({
      artHashes: probes.map((probe) => probe.artHash),
      frameHashes: probes.map((probe) => probe.frameHash),
      setBias,
      limit: 25,
    }),
  };
}

/** What a candidate is, stripped to what both sides claim to know. */
const shape = (candidate) => ({
  printingId: candidate.printingId,
  cardId: candidate.cardId,
  name: candidate.name,
  setCode: candidate.setCode,
  collectorNumber: candidate.collectorNumber,
  artDistance: candidate.artDistance,
  frameDistance: candidate.frameDistance,
  confidence: candidate.confidence,
});

describe('matching on the device', () => {
  test('the identity table is aligned to the index it came with', () => {
    assert.equal(local.isReady(), true);
    assert.equal(local.identityStats().count, hashIndex.stats().count);
  });

  test('an identity table from another build is refused, not used', async () => {
    // The alignment is the whole design: row `i` of one is row `i` of the
    // other. A table one row short would not throw on its own — it would name
    // every card after the gap as its neighbour, confidently.
    await assert.rejects(
      () => local.loadIdentity(async () => ({ count: 2, printingIds: [], names: [] })),
      /not the same build/
    );
    // And the good table it already had is still in place.
    assert.equal(local.isReady(), true);
  });

  test('a clean capture reaches the same verdict on both sides', () => {
    const { device, server } = bothWays([
      { artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    ]);

    assert.equal(device.tier, server.tier);
    assert.equal(device.signals.nameCertain, server.signals.nameCertain);
    assert.equal(device.signals.printingsOfBest, server.signals.printingsOfBest);
    assert.equal(device.signals.bestArtDistance, server.signals.bestArtDistance);
    assert.deepEqual(device.candidates.map(shape), server.candidates.map(shape));
  });

  test('a reprint is a printing choice on both sides, in the same order', () => {
    // Two printings of one card, four bits apart. The card is settled and the
    // printing is not, which is the commonest real result and the one where a
    // divergence in ordering would be least visible.
    const { device, server } = bothWays([
      { artHash: zeros(ART_HASH_HEX), frameHash: hashAtDistance(30, FRAME_HASH_HEX) },
    ]);

    assert.equal(device.signals.printingsOfBest, 2);
    assert.equal(device.signals.printingsOfBest, server.signals.printingsOfBest);
    assert.equal(device.tier, server.tier);
    // Not asserted as `true`: the third fixture card sits 60 bits away, inside
    // the 77-bit match threshold, so the name is genuinely not settled here.
    // What matters is that both sides say so.
    assert.equal(device.signals.nameCertain, server.signals.nameCertain);
    assert.deepEqual(
      device.candidates.map((candidate) => candidate.setCode),
      server.candidates.map((candidate) => candidate.setCode)
    );
  });

  test('a session tally orders tied printings the same way on both sides', () => {
    const { device, server } = bothWays(
      [{ artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) }],
      { BBB: 3 }
    );

    assert.equal(device.candidates[0].setCode, 'BBB', 'the tally has to reach the device');
    assert.equal(device.candidates[0].setCode, server.candidates[0].setCode);
    assert.equal(device.signals.setBiased, server.signals.setBiased);
  });

  test('the framing ladder picks the same probe', () => {
    const probes = [
      { artHash: hashAtDistance(120, ART_HASH_HEX), frameHash: null },
      { artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    ];
    const { device, server } = bothWays(probes);

    assert.equal(device.signals.probeIndex, 1);
    assert.equal(device.signals.probeIndex, server.signals.probeIndex);
    assert.equal(device.query.artHash, server.query.artHash);
  });

  test('a capture matching nothing says so, and says how far off it was', () => {
    const { device, server } = bothWays([
      { artHash: 'f'.repeat(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    ]);

    assert.equal(device.tier, server.tier);
    assert.equal(device.candidates.length, 0);
    assert.equal(device.signals.nameCertain, false);
    // How far off it was, which is the difference between "reframe it" and
    // "that was not a card". A second full pass of the index, paid for only
    // once a resolve has already come back empty.
    assert.equal(device.signals.nearest.artDistance, server.signals.nearest.artDistance);
    assert.equal(device.signals.nearest.printingId, server.signals.nearest.printingId);
    assert.equal(device.signals.nearest.matchWithin, server.signals.nearest.matchWithin);
  });

  test('the device knows a price without asking, and knows it has no picture', () => {
    // The price band is the pulse colour round the capture window — the fastest
    // cue the scanner has, and worthless a round trip late. The image URL is
    // the opposite trade: it nearly triples the identity table to serve one
    // thumbnail on the review screen, so it is fetched there instead.
    const { device } = bothWays([
      { artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    ]);

    const best = device.candidates[0];
    assert.equal(best.price, 12.5);
    assert.equal(best.imageUrl, null);
    assert.equal(best.uuid, uuidFor(1), 'the uuid is what a match means off this device');
  });

  test('a price that is really a foil price says so, on both sides', () => {
    // Otherwise the two are indistinguishable on screen, and the substituted
    // figure is the one most likely to be wildly wrong for the card in hand.
    const { device, server } = bothWays([
      { artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    ]);

    const byId = (result, key) =>
      result.candidates.find((candidate) => candidate.printingId === printings[key].id);

    for (const result of [device, server]) {
      assert.equal(byId(result, 1).priceType, 'normal');
      assert.equal(byId(result, 2).price, 208.59);
      assert.equal(byId(result, 2).priceType, 'foil');
    }
  });

  test('an undecided printing reports the spread, not one of its ends', () => {
    // The art names the card and cannot separate two printings of it. Quoting
    // whichever led the list is a coin flip presented as a fact, and across a
    // reprint the ends are an order of magnitude apart.
    const { device, server } = bothWays([
      { artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    ]);

    for (const result of [device, server]) {
      assert.ok(result.signals.printingsOfBest > 1, 'both printings are still in play');
      assert.deepEqual(result.signals.priceRange, { low: 12.5, high: 208.59 });
    }
  });

  test('among printings the art tied, the cheaper one leads', () => {
    // The capture sits on the dear printing's art and 4 bits off the cheap
    // one's — inside the tie width, so that gap is resampling noise rather
    // than evidence. Both are offered either way; which leads decides what a
    // reviewer accepts without thinking, and the common printing is the
    // likelier card to be holding.
    const { device, server } = bothWays([
      { artHash: hashAtDistance(4, ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    ]);

    for (const result of [device, server]) {
      assert.equal(result.candidates[0].printingId, printings[1].id);
      assert.equal(result.candidates[0].price, 12.5);
      assert.equal(result.signals.priceBiased, true);
      // Never a promotion: the printing is still the reviewer's to choose.
      assert.notEqual(result.tier, SCAN_TIERS.CONFIDENT);
    }
  });

  test('a set the session has seen still beats the cheaper printing', () => {
    // Somebody looking at the box knows what is in it. A guess that the common
    // printing is likelier is the weaker claim of the two and must not override
    // it — the tally sorts first and the price only separates what it tied.
    const { device, server } = bothWays(
      [{ artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) }],
      { BBB: 3 }
    );

    for (const result of [device, server]) {
      assert.equal(result.candidates[0].printingId, printings[2].id, 'the tallied set leads');
      assert.equal(result.signals.priceBiased, false, 'the tally moved it, not the price');
    }
  });

  test('price never reorders printings the art actually separated', () => {
    // The dear printing is the only one the art matched at all here. Nothing is
    // tied, so there is nothing for the price to say.
    const { device, server } = bothWays([
      { artHash: hashAtDistance(60, ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    ]);

    for (const result of [device, server]) {
      assert.equal(result.signals.priceBiased, false);
    }
  });

  test('a settled printing has no range to report', () => {
    // The other card has exactly one printing, so there is nothing to disagree
    // about and the caller shows a figure rather than a span.
    const { device, server } = bothWays([
      { artHash: hashAtDistance(60, ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    ]);

    for (const result of [device, server]) {
      assert.equal(result.signals.printingsOfBest, 1);
      assert.equal(result.signals.priceRange, null);
    }
  });
});
