/**
 * Checks for the rules-text search, run against an in-memory table — the
 * phrasings are the point, so they are tested as real SQL.
 *
 * node:sqlite is for the test only, as in subtypeFilter.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { cardTextFilterSql, parseTextTerms } from '../src/utils/cardTextFilter.js';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE cards (name TEXT, type_line TEXT, oracle_text TEXT, keywords TEXT);`);
const insert = db.prepare('INSERT INTO cards VALUES (?, ?, ?, ?)');
insert.run('Divination', 'Sorcery', 'Draw two cards.', null);
insert.run('Words of Wisdom', 'Instant', 'Target player draws two cards, then each other player draws a card.', null);
insert.run('Mind Rot', 'Sorcery', 'Target player discards two cards.', null);
insert.run('Thought Scour', 'Instant', 'Target player mills two cards.\nDraw a card.', null);
insert.run('Millstone', 'Artifact', '{2}, {T}: Target player puts the top two cards of their library into their graveyard.', null);
insert.run('Forest', 'Basic Land — Forest', '({T}: Add {G}.)', null);
insert.run('Llanowar Elves', 'Creature — Elf Druid', '{T}: Add {G}.', null);
insert.run('Polluted Delta', 'Land', '{T}, Pay 1 life, Sacrifice Polluted Delta: Search your library for an Island or Swamp card, put it onto the battlefield.', null);
insert.run('Demonic Tutor', 'Sorcery', 'Search your library for a card, put that card into your hand, then shuffle.', null);
insert.run('Vampire Nighthawk', 'Creature — Vampire Shaman', 'Flying\nDeathtouch\nLifelink', 'Deathtouch, Flying, Lifelink');
insert.run('Grizzly Bears', 'Creature — Bear', null, null);

function names(text, abilities = []) {
  const { clause, params } = cardTextFilterSql(text, abilities, 'c');
  const sql = `SELECT name FROM cards c ${clause ? `WHERE ${clause}` : ''} ORDER BY name`;
  return db.prepare(sql).all(...params).map((r) => r.name);
}

test('every word must appear, in any order', () => {
  assert.deepEqual(names('draw card'), ['Divination', 'Thought Scour', 'Words of Wisdom']);
});

test('a quoted phrase must appear as written', () => {
  assert.deepEqual(names('"target player draws"'), ['Words of Wisdom']);
  assert.deepEqual(parseTextTerms('mill "target player" x'), ['mill', 'target player', 'x']);
});

test('draw finds every phrasing of it', () => {
  assert.deepEqual(names('', ['draw']), ['Divination', 'Thought Scour', 'Words of Wisdom']);
});

test('mill finds the keyword and the old wording', () => {
  assert.deepEqual(names('', ['mill']), ['Millstone', 'Thought Scour']);
});

test('discard', () => {
  assert.deepEqual(names('', ['discard']), ['Mind Rot']);
});

test('ramp counts mana creatures, not lands', () => {
  assert.deepEqual(names('', ['ramp']), ['Llanowar Elves']);
});

test('tutor is not a fetch land', () => {
  assert.deepEqual(names('', ['tutor']), ['Demonic Tutor']);
});

test('lifegain reads the keyword list', () => {
  assert.deepEqual(names('', ['lifegain']), ['Vampire Nighthawk']);
});

test('abilities and text combine', () => {
  assert.deepEqual(names('mills', ['draw']), ['Thought Scour']);
});

test('nothing asked means no clause; unknown abilities are ignored', () => {
  assert.equal(cardTextFilterSql('', []).clause, null);
  assert.equal(cardTextFilterSql('  ', ['nonsense']).clause, null);
});

test('wildcards in the box are not wildcards', () => {
  assert.deepEqual(names('%'), names(''));
});
