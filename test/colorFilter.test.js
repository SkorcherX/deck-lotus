/**
 * Checks for the shared colour filter.
 *
 * This one runs the SQL for real against an in-memory table, because the bug it
 * exists to prevent was a SQL bug: filtering the inventory to Land plus a
 * colour returned nothing, since a Forest's `colors` column is empty and only
 * its colour identity says green.
 *
 * node:sqlite is used here for the test only, over a hand-made two-column
 * table. It is deliberately not wired into anything the application loads — a
 * shim standing in for better-sqlite3 in production is what previously hid a
 * migration bug and took the site down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { colorFilterSql } from '../src/utils/colorFilter.js';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE cards (
    name TEXT,
    type_line TEXT,
    colors TEXT,
    color_identity TEXT
  );
`);

const rows = [
  // A basic land: no colours of its own, green only by identity.
  ['Forest', 'Basic Land — Forest', '', 'G'],
  ['Island', 'Basic Land — Island', '', 'U'],
  // A dual land taps for two colours.
  ['Breeding Pool', 'Land — Forest Island', '', 'G,U'],
  // A land that taps for no colour at all is genuinely colourless.
  ['Wastes', 'Basic Land — Wastes', '', ''],
  // Ordinary spells carry their colours directly.
  ['Llanowar Elves', 'Creature — Elf Druid', 'G', 'G'],
  ['Counterspell', 'Instant', 'U', 'U'],
  ['Simic Charm', 'Instant', 'G,U', 'G,U'],
  // A colourless artifact.
  ['Sol Ring', 'Artifact', '', '']
];

const insert = db.prepare('INSERT INTO cards VALUES (?, ?, ?, ?)');
for (const row of rows) insert.run(...row);

/** Run the filter and return matching card names. */
function query(colors, { landsOnly = false } = {}) {
  const { clause, params } = colorFilterSql(colors, 'c');
  const where = [clause, landsOnly ? `c.type_line LIKE '%Land%'` : null]
    .filter(Boolean)
    .map((c) => `(${c})`)
    .join(' AND ');

  const sql = `SELECT name FROM cards c${where ? ` WHERE ${where}` : ''} ORDER BY name`;
  return db.prepare(sql).all(...params).map((r) => r.name);
}

test('the regression: filtering to lands plus a colour returns those lands', () => {
  const green = query(['G'], { landsOnly: true });
  assert.deepEqual(green, ['Breeding Pool', 'Forest']);
  assert.notEqual(green.length, 0, 'this returned zero rows before the fix');
});

test('a colour matches both spells that are it and lands that make it', () => {
  assert.deepEqual(query(['G']), ['Breeding Pool', 'Forest', 'Llanowar Elves', 'Simic Charm']);
});

test('two colours means carrying both, not either', () => {
  assert.deepEqual(query(['G', 'U']), ['Breeding Pool', 'Simic Charm']);
});

test('a land that taps for no colour counts as colourless; one that taps for a colour does not', () => {
  const colorless = query(['C']);
  assert.ok(colorless.includes('Wastes'), 'Wastes makes no colour');
  assert.ok(colorless.includes('Sol Ring'));
  assert.ok(!colorless.includes('Forest'), 'a Forest is not a colourless card');
  assert.ok(!colorless.includes('Breeding Pool'));
});

test('colourless combined with a colour matches either', () => {
  const found = query(['C', 'U']);
  assert.ok(found.includes('Island'), 'a blue land');
  assert.ok(found.includes('Counterspell'), 'a blue spell');
  assert.ok(found.includes('Sol Ring'), 'and colourless cards too');
  assert.ok(!found.includes('Llanowar Elves'), 'but not a green card');
});

test('no colours selected applies no filter at all', () => {
  assert.equal(colorFilterSql([], 'c').clause, null);
  assert.equal(query([]).length, rows.length);
});

test('the clause works without a table alias, as the deck builder uses it', () => {
  const { clause, params } = colorFilterSql(['G'], '');
  const found = db.prepare(`SELECT name FROM cards WHERE ${clause} ORDER BY name`).all(...params);
  assert.deepEqual(found.map((r) => r.name), ['Breeding Pool', 'Forest', 'Llanowar Elves', 'Simic Charm']);
});

test('placeholders and parameters stay in step', () => {
  for (const colors of [['G'], ['G', 'U'], ['C'], ['C', 'U'], ['W', 'U', 'B']]) {
    const { clause, params } = colorFilterSql(colors, 'c');
    const placeholders = (clause.match(/\?/g) || []).length;
    assert.equal(placeholders, params.length, `mismatch for ${colors.join('')}`);
  }
});
