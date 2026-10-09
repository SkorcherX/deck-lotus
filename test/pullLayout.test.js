/**
 * Grouping a pull list the way the cards sit in storage.
 *
 * What has to hold: colour sections in walking order, rarity within them,
 * and a type split only for the rarities a section is split by — commons in
 * the mono-coloured sections, uncommons in Multicolour by default.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupPullRows, sectionOf, typeOf, normalizeLayout, DEFAULT_PULL_LAYOUT,
} from '../src/shared/pullLayout.js';

const card = (name, colors, type_line, rarity) => ({ name, colors, type_line, rarity });

describe('pull layout', () => {
  test('colour is printed colour; lands and gold cards get their own sections', () => {
    assert.equal(sectionOf(card('A', 'G', 'Creature — Elf', 'common')), 'G');
    assert.equal(sectionOf(card('B', 'W,U', 'Instant', 'uncommon')), 'multicolor');
    assert.equal(sectionOf(card('C', '', 'Artifact', 'rare')), 'colorless');
    assert.equal(sectionOf(card('D', '', 'Land', 'rare')), 'land');
  });

  test('an artifact creature files under creature', () => {
    assert.equal(typeOf(card('Golem', '', 'Artifact Creature — Golem', 'common')), 'creature');
  });

  test('default layout: mono commons split by type, uncommons not', () => {
    const piles = groupPullRows([
      card('Pacifism', 'W', 'Enchantment — Aura', 'common'),
      card('Divine Verdict', 'W', 'Instant', 'common'),
      card('Raise the Alarm', 'W', 'Instant', 'common'),
      card('Swords', 'W', 'Instant', 'uncommon'),
      card('Wrath', 'W', 'Sorcery', 'rare'),
    ], DEFAULT_PULL_LAYOUT);
    assert.deepEqual(piles.map((p) => p.label), [
      'White · Rare', 'White · Uncommon', 'White · Common · Instant', 'White · Common · Enchantment',
    ]);
    assert.deepEqual(piles[2].rows.map((r) => r.name), ['Divine Verdict', 'Raise the Alarm']);
  });

  test('default layout: multicolour splits uncommons, not commons', () => {
    const piles = groupPullRows([
      card('Gold Instant', 'U,R', 'Instant', 'uncommon'),
      card('Gold Bear', 'G,W', 'Creature — Bear', 'uncommon'),
      card('Gold Common', 'B,G', 'Sorcery', 'common'),
    ]);
    assert.deepEqual(piles.map((p) => p.label), [
      'Multicolour · Uncommon · Creature', 'Multicolour · Uncommon · Instant', 'Multicolour · Common',
    ]);
  });

  test('sections come in walking order: WUBRG, multicolour, colourless, lands', () => {
    const piles = groupPullRows([
      card('L', '', 'Land', 'rare'), card('G', 'G', 'Sorcery', 'rare'), card('W', 'W', 'Sorcery', 'rare'),
      card('M', 'W,B', 'Sorcery', 'rare'), card('C', '', 'Artifact', 'rare'),
    ]);
    assert.deepEqual(piles.map((p) => p.section), ['W', 'G', 'multicolor', 'colorless', 'land']);
  });

  test('a stored layout is cleaned of unknown keys and fills in missing sections', () => {
    const clean = normalizeLayout({ splitByType: { W: ['common', 'bogus'], nonsense: ['rare'] } });
    assert.deepEqual(clean.splitByType.W, ['common']);
    assert.equal(clean.splitByType.nonsense, undefined);
    assert.deepEqual(clean.splitByType.multicolor, ['uncommon']);
  });
});
