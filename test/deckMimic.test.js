/**
 * Rebuilding a deck from a collection.
 *
 * What has to hold: owned cards are used before anything is substituted; a
 * stand-in is chosen for the job it does (removal for removal, mill for mill)
 * over a card that merely costs the same; lands only stand in for lands;
 * colour identity and availability are respected; and what cannot be matched
 * is reported rather than padded.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { mimicDeck } from '../src/services/deckMimicService.js';

const card = (name, props = {}) => ({
  name,
  type_line: 'Instant',
  oracle_text: '',
  cmc: 2,
  color_identity: 'B',
  subtypes: '',
  keywords: '',
  ...props,
});
const owned = (c, available = 1) => ({ ...c, available });
const one = (c, quantity = 1) => ({ card: c, quantity });

const murder = card('Murder', { oracle_text: 'Destroy target creature.', cmc: 3 });
const doomBlade = card('Doom Blade', { oracle_text: 'Destroy target nonblack creature.', cmc: 2 });
const divination = card('Divination', { type_line: 'Sorcery', oracle_text: 'Draw two cards.', cmc: 3, color_identity: 'U' });
const glimpse = card('Night\'s Whisper', { type_line: 'Sorcery', oracle_text: 'You draw two cards and you lose 2 life.', cmc: 2 });
const millSpell = card('Mind Sculpt', { type_line: 'Sorcery', oracle_text: 'Target opponent mills seven cards.', cmc: 2, color_identity: 'U' });
const otherMill = card('Thought Collapse', { type_line: 'Sorcery', oracle_text: 'Target player mills five cards.', cmc: 2, color_identity: 'U' });
const flier = card('Vampire Bat', { type_line: 'Creature — Bat', cmc: 1, power: '0', toughness: '1', keywords: 'Flying' });
const otherFlier = card('Dusk Imp', { type_line: 'Creature — Imp', cmc: 3, power: '2', toughness: '1', keywords: 'Flying' });
const bear = card('Grizzly Bears', { type_line: 'Creature — Bear', cmc: 2, power: '2', toughness: '2', color_identity: 'G' });
const swamp = card('Swamp', { type_line: 'Basic Land — Swamp', cmc: 0 });
const vault = card('Vault of Whispers', { type_line: 'Artifact Land', cmc: 0, oracle_text: '{T}: Add {B}.' });
const temple = card('Temple of Malady', { type_line: 'Land', cmc: 0, oracle_text: 'Temple of Malady enters tapped. {T}: Add {B} or {G}.' });

describe('mimicDeck', () => {
  test('uses owned copies before substituting', () => {
    const r = mimicDeck([one(murder, 2)], [owned(murder, 1), owned(doomBlade, 1)], { format: 'modern' });
    assert.equal(r.owned[0].card.name, 'Murder');
    assert.equal(r.owned[0].quantity, 1);
    assert.equal(r.standIns.length, 1);
    assert.equal(r.standIns[0].card.name, 'Doom Blade');
  });

  test('picks a stand-in by job, not just cost', () => {
    const r = mimicDeck([one(murder)], [owned(glimpse), owned(doomBlade)], { format: 'modern' });
    assert.equal(r.standIns[0].card.name, 'Doom Blade');
    assert.equal(r.standIns[0].match, 'close');
    assert.ok(r.standIns[0].why.some((w) => /removal/.test(w)), r.standIns[0].why.join(' | '));
  });

  test('matches theme halves such as mill', () => {
    const r = mimicDeck([one(millSpell)], [owned(divination), owned(otherMill)], { format: 'modern', identity: 'U' });
    assert.equal(r.standIns[0].card.name, 'Thought Collapse');
  });

  test('matches creatures on keywords and body', () => {
    const r = mimicDeck([one(flier)], [owned(otherFlier), owned(card('Skeleton', { type_line: 'Creature — Skeleton', cmc: 1, power: '1', toughness: '1' }))], { format: 'modern' });
    assert.equal(r.standIns[0].card.name, 'Dusk Imp');
    assert.ok(r.standIns.some((s) => s.why.some((w) => /flying/i.test(w))));
  });

  test('respects colour identity', () => {
    const r = mimicDeck([one(flier)], [owned(bear)], { format: 'modern', identity: 'B' });
    assert.equal(r.standIns.length, 0);
    assert.equal(r.missing[0].card.name, 'Vampire Bat');
  });

  test('lands stand in only for lands, and basics pass through', () => {
    const r = mimicDeck([one(vault), one(swamp, 10)], [owned(temple), owned(doomBlade)], { format: 'modern' });
    assert.equal(r.basics[0].quantity, 10);
    assert.equal(r.standIns.length, 1);
    assert.equal(r.standIns[0].card.name, 'Temple of Malady');
  });

  test('never uses more copies than are available, or more than one in commander', () => {
    const r = mimicDeck([one(murder), one(card('Hero\'s Downfall', { oracle_text: 'Destroy target creature or planeswalker.', cmc: 3 }))],
      [owned(doomBlade, 3)], { format: 'commander' });
    const used = r.standIns.reduce((sum, s) => sum + s.quantity, 0);
    assert.equal(used, 1);
    assert.equal(r.missing.length, 1);
  });

  test('summary compares curves and jobs', () => {
    const r = mimicDeck([one(murder), one(divination)], [owned(doomBlade)], { format: 'modern' });
    assert.equal(r.summary.originalCards, 2);
    assert.equal(r.summary.curve.original[3], 2);
    assert.equal(r.summary.curve.mimic[2], 1);
    assert.ok(r.summary.roles.find((x) => x.code === 'draw' && x.original === 1 && x.mimic === 0));
  });
});
