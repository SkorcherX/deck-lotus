/**
 * The device-side reader of the packed hash index.
 *
 * There are now two things that read `card-hashes.bin`: the server's index and
 * a browser one. Two readers of one binary format is exactly the arrangement
 * that drifts — a field widened on one side, a byte order assumed on the other
 * — and the failure would be silent, because a misread index does not throw, it
 * just matches the wrong cards.
 *
 * So these compare the two directly, over the real file, on real hashes.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import * as local from '../../client/src/utils/localIndex.js';
import { packHashes, readPackedHashes } from '../../src/services/cardHashFile.js';
import { ART_HASH_HEX, FRAME_HASH_HEX } from '../../src/shared/cardHash.js';

const uuidFor = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const zeros = (width) => '0'.repeat(width);

/** A hash exactly `bits` from zeros, so a distance can be asserted exactly. */
function hashAtDistance(bits, width) {
  let value = 0n;
  for (let i = 0; i < bits; i++) value |= 1n << BigInt(i);
  return value.toString(16).padStart(width, '0').slice(-width);
}

const buffer = (node) => node.buffer.slice(node.byteOffset, node.byteOffset + node.byteLength);

describe('the on-device hash index', () => {
  before(() => {
    local.parse(
      buffer(
        packHashes([
          { uuid: uuidFor(1), artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
          {
            uuid: uuidFor(2),
            artHash: hashAtDistance(20, ART_HASH_HEX),
            frameHash: hashAtDistance(4, FRAME_HASH_HEX),
          },
          {
            uuid: uuidFor(3),
            artHash: hashAtDistance(200, ART_HASH_HEX),
            frameHash: zeros(FRAME_HASH_HEX),
          },
        ])
      )
    );
  });

  test('reads the packed file the server writes', () => {
    assert.equal(local.isLoaded(), true);
    assert.equal(local.stats().count, 3);
  });

  test('distances are exact, and the far reference is refused', () => {
    const found = local.search(zeros(ART_HASH_HEX), zeros(FRAME_HASH_HEX));

    assert.equal(found.length, 2, 'the 200-bit reference is far outside the threshold');
    assert.equal(found[0].uuid, uuidFor(1));
    assert.equal(found[0].artDistance, 0);
    assert.equal(found[1].uuid, uuidFor(2));
    assert.equal(found[1].artDistance, 20);
  });

  test('uuids survive the round trip through raw bytes', () => {
    // The uuid is the identifier that outlives the weekly import, so a reader
    // that mangles it produces matches pointing at nothing.
    const found = local.search(hashAtDistance(20, ART_HASH_HEX));
    assert.equal(found[0].uuid, uuidFor(2));
    assert.match(found[0].uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('the framing ladder picks the nearest probe, and says which', () => {
    // The first probe must match *nothing*: 120 bits from the zero reference,
    // 100 from the 20-bit one and 80 from the 200-bit one, all outside the
    // threshold. Reaching for a value that happens to be a reference — as this
    // test first did — measures a probe finding itself.
    const result = local.searchProbes([
      { artHash: hashAtDistance(120, ART_HASH_HEX), frameHash: null },
      { artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    ]);

    assert.equal(result.probeIndex, 1);
    assert.equal(result.matches[0].uuid, uuidFor(1));
  });

  test('a file from a build with different hash widths is refused, not read', () => {
    const wrong = new Uint8Array(64);
    const view = new DataView(wrong.buffer);
    view.setUint32(0, 0x444c4348);
    view.setUint16(4, 1);
    view.setUint8(6, 8); // an art hash a quarter the width this build uses
    view.setUint8(7, 8);
    view.setUint32(8, 0);

    assert.throws(() => local.parse(wrong.buffer), /byte hashes/);
  });

  test('a truncated file is refused, not read as garbage', () => {
    const packed = packHashes([
      { uuid: uuidFor(1), artHash: zeros(ART_HASH_HEX), frameHash: zeros(FRAME_HASH_HEX) },
    ]);
    assert.throws(() => local.parse(buffer(packed.subarray(0, packed.length - 8))), /truncated/);
  });

  test('it reads the shipped index the same way the server does', () => {
    // The real file, both readers, real rows. A synthetic fixture only proves
    // the two agree about a fixture; this is what catches a byte order or a
    // field width diverging between them.
    const path = 'data/card-hashes.bin';
    if (!fs.existsSync(path)) {
      console.log('    (skipped: no data/card-hashes.bin in this checkout)');
      return;
    }

    const file = fs.readFileSync(path);
    const count = local.parse(buffer(file));
    const rows = readPackedHashes(path);

    assert.equal(count, rows.length, 'both readers must see the same number of references');

    // Spread across the file rather than the first few: a reader that got the
    // row stride wrong is right at the start and wrong by the end.
    for (const row of [0, 1, Math.floor(rows.length / 2), rows.length - 1]) {
      const reference = rows[row];
      const found = local.search(reference.artHash, reference.frameHash, { limit: 60 });
      const self = found.find((match) => match.uuid === reference.uuid);

      assert.ok(self, `row ${row} (${reference.uuid}) could not find itself`);
      assert.equal(self.artDistance, 0, `row ${row} must be zero bits from its own hash`);
      assert.equal(self.frameDistance, 0);
    }
  });
});
