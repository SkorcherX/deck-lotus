import test from 'node:test';
import assert from 'node:assert/strict';
import { commanderSlug, parseCommanderPage } from '../src/shared/edhrecPage.js';

test('commanderSlug matches EDHREC for names and URLs', () => {
  assert.equal(commanderSlug("Atraxa, Praetors' Voice"), 'atraxa-praetors-voice');
  assert.equal(commanderSlug('Éowyn, Lady of Rohan'), 'eowyn-lady-of-rohan');
  assert.equal(commanderSlug('https://edhrec.com/commanders/kenrith-the-returned-king'), 'kenrith-the-returned-king');
  assert.equal(commanderSlug('https://edhrec.com/budget/commanders/kenrith-the-returned-king/'), 'kenrith-the-returned-king');
  assert.equal(commanderSlug('Tymna the Weaver // Thrasios, Triton Hero'), 'tymna-the-weaver-thrasios-triton-hero');
  assert.equal(commanderSlug('  '), '');
});

test('parseCommanderPage keeps categories and de-duplicates cards', () => {
  const page = parseCommanderPage({
    container: { json_dict: {
      card: { name: 'Atraxa', num_decks: 100, color_identity: ['W', 'U', 'B', 'G'] },
      cardlists: [
        { tag: 'topcards', header: 'Top Cards', cardviews: [{ name: 'Sol Ring', num_decks: 90, potential_decks: 100, synergy: -0.02 }] },
        { tag: 'manaartifacts', header: 'Mana Artifacts', cardviews: [
          { name: 'Sol Ring', num_decks: 90, potential_decks: 100 },
          { name: 'Arcane Signet', num_decks: 50, potential_decks: 0 },
          { num_decks: 1 },
        ] },
        { tag: 'empty', header: 'Empty', cardviews: [] },
      ],
    } },
  });
  assert.equal(page.commander.name, 'Atraxa');
  assert.equal(page.lists.length, 2);
  assert.deepEqual(page.cards.map((c) => [c.name, c.category]), [['Sol Ring', 'Top Cards'], ['Arcane Signet', 'Mana Artifacts']]);
  assert.equal(page.cards[0].inclusion, 0.9);
  assert.equal(page.cards[1].inclusion, null);
});

test('parseCommanderPage survives a page with nothing in it', () => {
  assert.deepEqual(parseCommanderPage(null).cards, []);
});
