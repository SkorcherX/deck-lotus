import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeDeckParam, massEntryUrl } from '../client/src/utils/manaPoolHandoff.js';

test("the deck parameter matches EDHREC's Buy on Mana Pool links", () => {
  // The opening of a real EDHREC link: unpadded base64 of the plain list.
  const edhrec = 'MSBTaGVvbGRyZWQsIHRoZSBBcG9jYWx5cHNlCjEgQXJjYW5lIFNpZ25ldAoxIEFyZ2VudHVtIEFybW9y';
  assert.equal(encodeDeckParam('1 Sheoldred, the Apocalypse\n1 Arcane Signet\n1 Argentum Armor'), edhrec);
});

test('names outside ASCII and base64 symbols survive the link', () => {
  const text = '1 Lim-Dûl the Necromancer\n1 Æther Vial (MMA) 199';
  const url = new URL(massEntryUrl(text));
  assert.equal(url.pathname, '/add-deck');
  const back = Buffer.from(url.searchParams.get('deck'), 'base64').toString('utf8');
  assert.equal(back, text);
});
