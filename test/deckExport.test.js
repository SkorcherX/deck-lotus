/**
 * Checks for the deck-list export.
 *
 * Every one of these is a line another site has to accept: the failures worth
 * catching are a commander printed twice, a header sent to a site that reads
 * it as a card, and a foil that stopped being marked because the export read a
 * column the deck rows do not have.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { formatDeckExport, exportFilename, EXPORT_FORMATS } from '../client/src/utils/deckExport.js';

const deck = {
  name: 'Atraxa Superfriends',
  cards: [
    { name: 'Atraxa, Praetors\' Voice', quantity: 1, set_code: 'cmr', collector_number: '267', is_commander: 1, board_type: 'mainboard' },
    { name: 'Sol Ring', quantity: 1, set_code: 'c21', collector_number: '263', board_type: 'mainboard', is_foil: 1 },
    { name: 'Forest', quantity: 8, set_code: 'fdn', collector_number: '281', board_type: 'mainboard' },
    { name: 'Pithing Needle', quantity: 1, set_code: 'm21', collector_number: '234', board_type: 'sideboard' },
    { name: 'Doubling Season', quantity: 1, set_code: '2xm', collector_number: '162', board_type: 'maybeboard' },
  ],
};

describe('formatDeckExport', () => {
  test('Moxfield gets sections, printings and a foil marker', () => {
    const text = formatDeckExport(deck, 'moxfield');
    assert.equal(text, [
      'Commander',
      "1 Atraxa, Praetors' Voice (CMR) 267",
      '',
      'Deck',
      '1 Sol Ring (C21) 263 *F*',
      '8 Forest (FDN) 281',
      '',
      'Sideboard',
      '1 Pithing Needle (M21) 234',
      '',
      'Maybeboard',
      '1 Doubling Season (2XM) 162',
    ].join('\n'));
  });

  test('Archidekt counts with an x', () => {
    const text = formatDeckExport(deck, 'archidekt');
    assert.match(text, /^1x Sol Ring \(C21\) 263 \*F\*$/m);
  });

  test('the commander is listed once, not in both sections', () => {
    for (const { id } of EXPORT_FORMATS) {
      const text = formatDeckExport(deck, id);
      // Card lines only: the plain-text export titles itself with the deck
      // name, which here happens to be the commander's.
      const hits = text.split('\n').filter((line) => /^\d/.test(line) && line.includes('Atraxa'));
      assert.equal(hits.length, 1, `${id} listed the commander ${hits.length} times`);
    }
  });

  test('EDHREC gets names only, commander first, no headers', () => {
    const text = formatDeckExport(deck, 'edhrec');
    assert.equal(text, [
      "1 Atraxa, Praetors' Voice",
      '1 Sol Ring',
      '8 Forest',
    ].join('\n'));
  });

  test('Arena has no commander header and no foil marker', () => {
    const text = formatDeckExport(deck, 'arena');
    assert.doesNotMatch(text, /^Commander$/m);
    assert.doesNotMatch(text, /\*F\*/);
    assert.match(text, /^Deck$/m);
    assert.match(text, /^1 Sol Ring \(C21\) 263$/m);
  });

  test('MTGO separates the sideboard with a blank line and nothing else', () => {
    const text = formatDeckExport(deck, 'mtgo');
    assert.equal(text, [
      "1 Atraxa, Praetors' Voice",
      '1 Sol Ring',
      '8 Forest',
      '',
      '1 Pithing Needle',
    ].join('\n'));
  });

  test('an empty section is left out rather than left standing', () => {
    const text = formatDeckExport({ name: 'Mono', cards: [{ name: 'Island', quantity: 4, set_code: 'fdn' }] }, 'moxfield');
    assert.equal(text, 'Deck\n4 Island (FDN)');
  });

  test('an empty deck exports as nothing, not as headers', () => {
    assert.equal(formatDeckExport({ name: 'New', cards: [] }, 'moxfield'), '');
  });

  test('an unknown format is refused rather than silently exported wrong', () => {
    assert.throws(() => formatDeckExport(deck, 'tappedout'), /Unknown export format/);
  });
});

describe('exportFilename', () => {
  test('leads with the deck name', () => {
    assert.equal(exportFilename(deck, 'moxfield'), 'atraxa-superfriends-moxfield.txt');
  });

  test('survives a name made entirely of punctuation', () => {
    assert.equal(exportFilename({ name: '???' }, 'arena'), 'deck-arena.txt');
  });
});
