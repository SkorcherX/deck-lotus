/**
 * Checks for the shared creature-type filter, run for real against an
 * in-memory table — the point of it is the SQL: a type has to match a whole
 * entry in `subtypes`, so "Ape" must not find a Shapeshifter.
 *
 * node:sqlite is for the test only, as in colorFilter.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { subtypeFilterSql } from '../src/utils/subtypeFilter.js';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE cards (name TEXT, subtypes TEXT);`);
const insert = db.prepare('INSERT INTO cards VALUES (?, ?)');
insert.run('Llanowar Elves', 'Elf,Druid');
insert.run('Elvish Warrior', 'Elf, Warrior');
insert.run('Ancient Silverback', 'Ape');
insert.run('Changeling Outcast', 'Shapeshifter,Rogue');
insert.run('Lightning Bolt', null);

function names(list) {
  const { clause, params } = subtypeFilterSql(list, 'c');
  const sql = `SELECT name FROM cards c ${clause ? `WHERE ${clause}` : ''} ORDER BY name`;
  return db.prepare(sql).all(...params).map((r) => r.name);
}

test('matches a whole type, either storage shape, any case', () => {
  assert.deepEqual(names(['elf']), ['Elvish Warrior', 'Llanowar Elves']);
});

test('does not match a type inside a longer one', () => {
  assert.deepEqual(names(['Ape']), ['Ancient Silverback']);
});

test('several types must all match', () => {
  assert.deepEqual(names(['Elf', 'Warrior']), ['Elvish Warrior']);
});

test('no terms means no clause', () => {
  assert.equal(subtypeFilterSql([]).clause, null);
  assert.equal(subtypeFilterSql(['  ']).clause, null);
});

test('wildcards in a term are not wildcards', () => {
  assert.deepEqual(names(['%']), names([]));
  assert.deepEqual(names(['E_f']), []);
});
