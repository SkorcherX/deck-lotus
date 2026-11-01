import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtensionZip, extensionVersion } from '../src/services/extensionPackage.js';

test('the extension zip holds the manifest and a generated lookup.js', () => {
  const zip = buildExtensionZip();
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  const text = zip.toString('latin1');
  for (const name of ['manifest.json', 'sw.js', 'bridge.js', 'popup.html', 'popup.js', 'lookup.js']) {
    assert.ok(text.includes(`deck-lotus-store-prices/${name}`), name);
  }
  assert.match(text, /__deckLotusLookup/);
  assert.match(extensionVersion(), /^\d+\.\d+\.\d+$/);
});
