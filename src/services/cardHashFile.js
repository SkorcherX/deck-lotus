/**
 * The packed perceptual-hash file: `data/card-hashes.bin`.
 *
 * One binary blob holding a hash pair for every printing, committed to the repo
 * and shipped in the image. That is a deliberate trade. The alternative was
 * having the server build its own by fetching 112k images from Scryfall on
 * first boot — hours of someone else's bandwidth, on every fresh deployment,
 * for a result that is identical every time. Shipping it costs ~6MB in git and
 * one re-run of scripts/build-card-hashes.mjs when a new set arrives.
 *
 * Binary rather than JSON because of what reads it: the whole file is loaded
 * into a flat typed array at boot and searched word-by-word on every scan. JSON
 * would be ~4x the size, and parsing it would produce 112k short-lived objects
 * to immediately throw away.
 *
 * Keyed on `uuid`, never on `printing_id`. scripts/import-mtgjson.js clears
 * `printings` on every weekly sync and the integer ids are reassigned; the uuid
 * is the only identifier that survives, which is the same rule `audit_log` and
 * `found_cards` follow.
 *
 * ── Layout ───────────────────────────────────────────────────────────────────
 *   Header, 16 bytes:
 *     0  u32  magic 'DLCH'
 *     4  u16  format version
 *     6  u8   art hash bytes
 *     7  u8   frame hash bytes
 *     8  u32  row count
 *    12  u32  reserved (zero)
 *
 *   Then `count` fixed-width rows, sorted by uuid:
 *     16 bytes  uuid, dashes stripped, hex-decoded
 *     32 bytes  art hash    (255 bits + a pad bit)
 *      8 bytes  frame hash  (63 bits + a pad bit)
 *
 * The hash widths are in the header rather than assumed, because the two are
 * different sizes on purpose (see cardHash.js) and a file written before a width
 * changed must be rejected loudly instead of read as garbage.
 */
import { readFileSync, openSync, readSync, closeSync, statSync } from 'fs';
import { ART_HASH_BYTES, FRAME_HASH_BYTES } from '../../client/src/utils/cardHash.js';

export const PACKED_PATH = process.env.CARD_HASH_PATH || 'data/card-hashes.bin';

export const MAGIC = 0x444c4348; // 'DLCH'
export const VERSION = 1;

export const HEADER_BYTES = 16;
export const UUID_BYTES = 16;
export const ROW_BYTES = UUID_BYTES + ART_HASH_BYTES + FRAME_HASH_BYTES;

/** A 36-character UUID to its 16 raw bytes. */
export function packUuid(uuid, target, offset) {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`Not a UUID: ${uuid}`);
  for (let i = 0; i < UUID_BYTES; i++) {
    target[offset + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
}

/** Inverse of packUuid, restoring the dashes MTGJSON's uuids carry. */
export function unpackUuid(source, offset) {
  let hex = '';
  for (let i = 0; i < UUID_BYTES; i++) {
    hex += source[offset + i].toString(16).padStart(2, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Hex string to raw bytes, at a fixed expected width. */
export function packHex(hex, bytes, target, offset) {
  if (hex.length !== bytes * 2) {
    throw new Error(`Expected a ${bytes * 2}-character hash, got ${hex.length}: ${hex}`);
  }
  for (let i = 0; i < bytes; i++) {
    target[offset + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
}

/** Raw bytes back to a hex string. */
export function unpackHex(source, offset, bytes) {
  let hex = '';
  for (let i = 0; i < bytes; i++) {
    hex += source[offset + i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Build the whole file from rows of `{ uuid, artHash, frameHash }`.
 *
 * Rows are sorted by uuid on the way in. Nothing depends on the order today,
 * but a stable one means re-running the packer over the same data produces a
 * byte-identical file — which is what keeps a top-up from showing as a rewrite
 * of all 6MB in git.
 */
export function packHashes(rows) {
  const sorted = [...rows].sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));

  const buffer = Buffer.alloc(HEADER_BYTES + sorted.length * ROW_BYTES);

  buffer.writeUInt32BE(MAGIC, 0);
  buffer.writeUInt16BE(VERSION, 4);
  buffer.writeUInt8(ART_HASH_BYTES, 6);
  buffer.writeUInt8(FRAME_HASH_BYTES, 7);
  buffer.writeUInt32BE(sorted.length, 8);
  buffer.writeUInt32BE(0, 12);

  let offset = HEADER_BYTES;
  for (const row of sorted) {
    packUuid(row.uuid, buffer, offset);
    packHex(row.artHash, ART_HASH_BYTES, buffer, offset + UUID_BYTES);
    packHex(row.frameHash, FRAME_HASH_BYTES, buffer, offset + UUID_BYTES + ART_HASH_BYTES);
    offset += ROW_BYTES;
  }

  return buffer;
}

/** Read and validate the 16-byte header. */
export function readHeader(buffer, path = PACKED_PATH) {
  if (buffer.length < HEADER_BYTES) throw new Error(`${path} is truncated`);

  const magic = buffer.readUInt32BE(0);
  if (magic !== MAGIC) throw new Error(`${path} is not a card-hash file`);

  const version = buffer.readUInt16BE(4);
  if (version !== VERSION) {
    throw new Error(`${path} is format version ${version}, this build reads ${VERSION}`);
  }

  const artBytes = buffer.readUInt8(6);
  const frameBytes = buffer.readUInt8(7);

  // The widths are the thing most likely to drift, because changing them is a
  // one-line edit in cardHash.js with no other visible consequence. A file
  // hashed at the old width would still load and would still return matches —
  // just uniformly wrong ones — so this refuses rather than warns.
  if (artBytes !== ART_HASH_BYTES || frameBytes !== FRAME_HASH_BYTES) {
    throw new Error(
      `${path} holds ${artBytes}/${frameBytes}-byte hashes but this build produces ` +
      `${ART_HASH_BYTES}/${FRAME_HASH_BYTES}. Re-run scripts/pack-card-hashes.mjs.`
    );
  }

  return { version, artBytes, frameBytes, count: buffer.readUInt32BE(8) };
}

/** Every row, as `{ uuid, artHash, frameHash }`. Used by tests and tooling. */
export function readPackedHashes(path = PACKED_PATH) {
  const buffer = readFileSync(path);
  const { count } = readHeader(buffer, path);

  const rows = new Array(count);
  for (let i = 0; i < count; i++) {
    const offset = HEADER_BYTES + i * ROW_BYTES;
    rows[i] = {
      uuid: unpackUuid(buffer, offset),
      artHash: unpackHex(buffer, offset + UUID_BYTES, ART_HASH_BYTES),
      frameHash: unpackHex(buffer, offset + UUID_BYTES + ART_HASH_BYTES, FRAME_HASH_BYTES),
    };
  }

  return rows;
}

/**
 * Just the uuids, read without pulling the hashes into memory.
 *
 * This exists for the puller's --resume, which needs to answer "have we got
 * this one?" for 112k rows and does not care what the hashes are. Reading the
 * uuid out of each row in place skips ~4.5MB of hash bytes and, more to the
 * point, skips building 112k hex strings that would be discarded immediately.
 */
export function readPackedUuids(path = PACKED_PATH) {
  const fd = openSync(path, 'r');

  try {
    const header = Buffer.alloc(HEADER_BYTES);
    readSync(fd, header, 0, HEADER_BYTES, 0);
    const { count } = readHeader(header, path);

    const size = statSync(path).size;
    const expected = HEADER_BYTES + count * ROW_BYTES;
    if (size < expected) {
      throw new Error(`${path} claims ${count} rows but holds ${size} bytes, not ${expected}`);
    }

    const body = Buffer.alloc(count * ROW_BYTES);
    readSync(fd, body, 0, body.length, HEADER_BYTES);

    const uuids = new Array(count);
    for (let i = 0; i < count; i++) {
      uuids[i] = unpackUuid(body, i * ROW_BYTES);
    }

    return uuids;
  } finally {
    closeSync(fd);
  }
}
