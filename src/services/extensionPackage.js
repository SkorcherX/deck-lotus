import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtensionLookup } from '../shared/localShop.js';

/**
 * The store-price browser extension (src/extension) as a zip, with lookup.js
 * generated from src/shared/localShop.js so the extension and the console
 * script can never disagree about how a card is matched or priced.
 *
 * A stored (uncompressed) zip is a few dozen lines and saves a dependency
 * for a download of a few kilobytes.
 */

const EXTENSION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipFiles(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Firefox takes the same extension with a different manifest: an event-page
 * `background.scripts` in place of Chrome's service worker (Firefox has no
 * extension service workers), and an add-on id, which it needs for storage
 * and for Mozilla to sign it. The id must never change once someone has
 * installed it, or Firefox treats the next version as a different add-on.
 */
export const FIREFOX_ID = 'store-prices@deck-lotus';

function manifestFor(browser) {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  if (browser !== 'firefox') return manifest;
  manifest.background = { scripts: ['sw.js'] };
  manifest.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ID,
      // 140 is the first Firefox that reads data_collection_permissions,
      // which addons.mozilla.org now requires; 142 on Android.
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: '142.0' },
  };
  return manifest;
}

/** `browser` is 'chrome' (also Edge and other Chromium browsers) or 'firefox'. */
export function buildExtensionZip(browser = 'chrome') {
  // Firefox wants the files at the root of the archive; Chrome's Load
  // unpacked wants a folder, which the zip unpacks into.
  const prefix = browser === 'firefox' ? '' : 'deck-lotus-store-prices/';
  const files = fs.readdirSync(EXTENSION_DIR)
    .filter((name) => name !== 'lookup.js' && name !== 'manifest.json')
    .map((name) => ({ name: prefix + name, data: fs.readFileSync(path.join(EXTENSION_DIR, name)) }));
  files.push({ name: `${prefix}manifest.json`, data: Buffer.from(JSON.stringify(manifestFor(browser), null, 2), 'utf8') });
  files.push({ name: `${prefix}lookup.js`, data: Buffer.from(buildExtensionLookup(), 'utf8') });
  return zipFiles(files);
}

export function extensionVersion() {
  return JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8')).version;
}

/**
 * The Mozilla-signed Firefox build, if one has been dropped into
 * src/extension-signed/ as deck-lotus-store-prices-<version>.xpi. Firefox
 * keeps only signed add-ons, so this is what lets a household member install
 * with one click instead of signing the zip themselves. Signing happens on
 * addons.mozilla.org ("On your own"); a new extension version needs a new
 * signed file, and until one is added the newest older one is served.
 * Returns { version, file } or null.
 */
const SIGNED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension-signed');

export function signedFirefoxBuild() {
  let names;
  try {
    names = fs.readdirSync(SIGNED_DIR);
  } catch {
    return null;
  }
  const builds = names
    .map((name) => ({ name, m: /^deck-lotus-store-prices-(\d+(?:\.\d+)*)\.xpi$/.exec(name) }))
    .filter((b) => b.m)
    .map((b) => ({ version: b.m[1], file: path.join(SIGNED_DIR, b.name) }))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return builds[0] || null;
}
