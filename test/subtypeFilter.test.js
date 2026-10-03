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
db.exec(`CREATE TABLE cards (name TEXT, type_line TEXT, subtypes TEXT, keywords TEXT);`);
const insert = db.prepare('INSERT INTO cards VALUES (?, ?, ?, ?)');
insert.run('Llanowar Elves', 'Creature — Elf Druid', 'Elf,Druid', null);
insert.run('Elvish Warrior', 'Creature — Elf Warrior', 'Elf, Warrior', null);
insert.run('Ancient Silverback', 'Creature — Ape', 'Ape', 'Regenerate');
insert.run('Changeling Outcast', 'Creature — Shapeshifter Rogue', 'Shapeshifter, Rogue', 'Changeling');
insert.run('Bonesplitter', 'Artifact — Equipment', 'Equipment', 'Equip');
insert.run('Equipped Golem', 'Artifact Creature — Equipment Golem', 'Equipment, Golem', null);
insert.run('Lightning Bolt', 'Instant', null, null);

function names(list) {
  const { clause, params } = subtypeFilterSql(list, 'c');
  const sql = `SELECT name FROM cards c ${clause ? `WHERE ${clause}` : ''} ORDER BY name`;
  return db.prepare(sql).all(...params).map((r) => r.name);
}

test('matches a whole type, either storage shape, any case — changelings included', () => {
  assert.deepEqual(names(['elf']), ['Changeling Outcast', 'Elvish Warrior', 'Llanowar Elves']);
});

test('does not match a type inside a longer one', () => {
  assert.deepEqual(names(['Ape']), ['Ancient Silverback', 'Changeling Outcast']);
});

test('several types must all match', () => {
  assert.deepEqual(names(['Elf', 'Warrior']), ['Changeling Outcast', 'Elvish Warrior']);
});

test('changelings are not every non-creature type', () => {
  assert.deepEqual(names(['Equipment']), ['Bonesplitter', 'Equipped Golem']);
});

test('a type no creature has is not a creature type', () => {
  assert.deepEqual(names(['Dragon']), []);
});

test('no terms means no clause', () => {
  assert.equal(subtypeFilterSql([]).clause, null);
  assert.equal(subtypeFilterSql(['  ']).clause, null);
});

test('wildcards in a term are not wildcards', () => {
  assert.deepEqual(names(['%']), names([]));
  assert.deepEqual(names(['E_f']), []);
});
