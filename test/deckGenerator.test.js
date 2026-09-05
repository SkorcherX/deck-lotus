/**
 * The generator, checked on the promises it makes rather than on the exact
 * deck it happens to produce.
 *
 * A generated 99 is not a stable artefact — tune one predicate and half the
 * list moves — so asserting a card list would be a test that fails whenever
 * anything improves. What must hold regardless:
 *
 *   - it never throws for a collection that cannot fill the deck; it reports
 *     the gap, because "here is the gap" is useful and "cannot assemble" is not
 *   - role quotas are honoured where the collection allows, and reported where
 *     it does not
 *   - colour identity is never violated, since an illegal deck is worthless
 *   - singleton is never violated in Commander
 *   - the mana base counts sources against the Karsten targets and says so
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeck, buildManaBase, colorDemands, landProduces, resolveTheme,
} from '../src/services/deckGeneratorService.js';

/** A pool row, shaped the way getGeneratorPool hands one over. */
const card = (name, props = {}) => ({
  card_id: Math.abs([...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)),
  name,
  mana_cost: '{1}{B}',
  cmc: 2,
  color_identity: 'B',
  type_line: 'Creature — Zombie',
  oracle_text: '',
  subtypes: 'Zombie',
  supertypes: '',
  keywords: '',
  edhrec_rank: 5000,
  available: 1,
  ...props,
});

const many = (n, make) => [...Array(n)].map((_, i) => make(i));

/** A collection deep enough to build a real graveyard deck out of. */
function graveyardCollection() {
  return [
    ...many(14, (i) => card(`Miller ${i}`, {
      oracle_text: 'When this creature enters, mill three cards.',
    })),
    ...many(14, (i) => card(`Reanimator ${i}`, {
      oracle_text: 'Return target creature card from your graveyard to the battlefield.',
      type_line: 'Sorcery', subtypes: '',
    })),
    ...many(12, (i) => card(`Ramper ${i}`, {
      oracle_text: 'Add {B}{B}.', type_line: 'Artifact', subtypes: '', mana_cost: '{2}', cmc: 2,
    })),
    ...many(12, (i) => card(`Drawer ${i}`, {
      oracle_text: 'Draw two cards.', type_line: 'Sorcery', subtypes: '',
    })),
    ...many(10, (i) => card(`Killer ${i}`, {
      oracle_text: 'Destroy target creature.', type_line: 'Instant', subtypes: '',
    })),
    ...many(4, (i) => card(`Wiper ${i}`, {
      oracle_text: 'Destroy all creatures.', type_line: 'Sorcery', subtypes: '',
      mana_cost: '{3}{B}{B}', cmc: 5,
    })),
    ...many(30, (i) => card(`Filler ${i}`, { oracle_text: 'Flying.' })),
    ...many(8, (i) => card(`Swampy ${i}`, {
      type_line: 'Land — Swamp', subtypes: 'Swamp', mana_cost: '', cmc: 0,
      color_identity: '', oracle_text: '',
    })),
  ];
}

const commander = card('The Commander', {
  type_line: 'Legendary Creature — Zombie Wizard',
  color_identity: 'B',
});

describe('landProduces', () => {
  test('reads the basic land types off the type line', () => {
    assert.deepEqual(
      [...landProduces({ type_line: 'Land — Swamp Island', oracle_text: '' })].sort(),
      ['B', 'U']
    );
  });

  test('falls back to the text for lands with no land types', () => {
    assert.deepEqual(
      [...landProduces({ type_line: 'Land', oracle_text: '{T}: Add {R}.' })],
      ['R']
    );
  });

  test('any-colour lands produce everything', () => {
    const produced = landProduces({ type_line: 'Land', oracle_text: '{T}: Add one mana of any color.' });
    assert.equal(produced.size, 5);
  });

  test('a land that makes no mana produces nothing, rather than guessing', () => {
    assert.equal(landProduces({ type_line: 'Land', oracle_text: '{T}: Draw a card.' }).size, 0);
  });
});

describe('colorDemands', () => {
  test('reports the strictest demand per colour, not an average', () => {
    const demands = colorDemands([
      { mana_cost: '{4}{B}', cmc: 5 },
      { mana_cost: '{B}{B}', cmc: 2 },
    ]);
    // The double-pip two-drop is what the mana base has to serve.
    assert.equal(demands.B.pips, 2);
    assert.equal(demands.B.turn, 2);
    assert.equal(demands.B.cards, 2);
  });

  test('generic costs demand no colour', () => {
    assert.deepEqual(colorDemands([{ mana_cost: '{2}', cmc: 2 }]), {});
  });
});

describe('buildDeck', () => {
  test('builds a legal-sized Commander deck', () => {
    const deck = buildDeck(graveyardCollection(), { commander, format: 'commander' });

    assert.equal(deck.summary.totalCards, 100, 'commander plus 99');
    assert.equal(deck.summary.lands, 36);
    assert.equal(deck.summary.spells, 63);
  });

  test('honours singleton', () => {
    const deck = buildDeck(graveyardCollection(), { commander, format: 'commander' });
    for (const entry of deck.mainboard) {
      assert.equal(entry.quantity, 1, `${entry.name} appears more than once`);
    }
  });

  test('never includes the commander in the 99', () => {
    const pool = [...graveyardCollection(), { ...commander, available: 2 }];
    const deck = buildDeck(pool, { commander, format: 'commander' });
    assert.ok(!deck.mainboard.some((c) => c.name === commander.name));
  });

  test('never breaks colour identity', () => {
    const pool = [
      ...graveyardCollection(),
      ...many(20, (i) => card(`Red Card ${i}`, { color_identity: 'R', mana_cost: '{1}{R}' })),
    ];
    const deck = buildDeck(pool, { commander, format: 'commander' });
    assert.ok(!deck.mainboard.some((c) => c.name.startsWith('Red Card')));
  });

  test('fills the role quotas when the collection allows', () => {
    const deck = buildDeck(graveyardCollection(), { commander, format: 'commander' });
    assert.equal(deck.summary.roles.ramp, 10);
    assert.equal(deck.summary.roles.draw, 10);
    assert.equal(deck.summary.roles.removal, 8);
    assert.equal(deck.summary.roles.sweeper, 3);
  });

  test('reports a role it could not fill instead of failing', () => {
    // No sweepers at all in this collection.
    const pool = graveyardCollection().filter((c) => !c.name.startsWith('Wiper'));
    const deck = buildDeck(pool, { commander, format: 'commander' });

    const shortfall = deck.shortfalls.find((s) => s.code === 'sweeper');
    assert.ok(shortfall, 'a missing role should be reported');
    assert.equal(shortfall.wanted, 3);
    assert.equal(shortfall.found, 0);
    // Still a complete deck.
    assert.equal(deck.summary.totalCards, 100);
  });

  test('a collection far too small produces a deck and a size shortfall, not a throw', () => {
    const tiny = many(5, (i) => card(`Only ${i}`));
    const deck = buildDeck(tiny, { commander, format: 'commander' });

    assert.equal(deck.summary.spells, 5);
    assert.ok(deck.shortfalls.some((s) => s.kind === 'size'));
    // The mana base still fills its slots, because basics are free.
    assert.equal(deck.summary.lands, 36);
  });

  test('an empty collection is answered, not thrown at', () => {
    const deck = buildDeck([], { commander, format: 'commander' });
    assert.equal(deck.summary.spells, 0);
    assert.ok(Array.isArray(deck.shortfalls));
  });

  test('cards carry the reason they were chosen', () => {
    const deck = buildDeck(graveyardCollection(), { commander, format: 'commander' });
    assert.ok(deck.mainboard.every((c) => typeof c.reason === 'string' && c.reason.length > 0));
    assert.ok(deck.mainboard.some((c) => c.reason === 'spot removal'));
  });

  test('it picks a theme and shows the evidence for it', () => {
    const deck = buildDeck(graveyardCollection(), { commander, format: 'commander' });
    assert.equal(deck.theme.label, 'graveyard value');
    assert.ok(deck.theme.enablers > 0);
    assert.ok(deck.theme.payoffs > 0);
    assert.equal(deck.theme.strength, Math.min(deck.theme.enablers, deck.theme.payoffs));
  });

  test('with no dense theme it says so rather than inventing one', () => {
    const bland = many(80, (i) => card(`Vanilla ${i}`, { oracle_text: 'Flying.' }));
    const deck = buildDeck(bland, { commander, format: 'commander' });

    assert.equal(deck.theme, null);
    assert.ok(deck.notes.some((n) => /no theme/i.test(n)));
    assert.equal(deck.summary.totalCards, 100);
  });

  test('an explicit theme key overrides the automatic choice', () => {
    const deck = buildDeck(graveyardCollection(), {
      commander, format: 'commander', themeKey: 'aristocrats',
    });
    assert.equal(deck.theme.label, 'sacrifice and death triggers');
  });

  test('respects available copies in a format that allows playsets', () => {
    const pool = many(30, (i) => card(`Bolt ${i}`, {
      oracle_text: 'Destroy target creature.', type_line: 'Instant',
      available: i === 0 ? 4 : 1,
    }));
    const deck = buildDeck(pool, { format: 'default', identity: 'B' });
    for (const entry of deck.mainboard) {
      assert.ok(entry.quantity <= 4, `${entry.name} exceeds four copies`);
    }
  });
});

describe('resolveTheme', () => {
  test('finds a built-in theme by key', () => {
    assert.equal(resolveTheme('graveyard', []).label, 'graveyard value');
  });

  test('finds a tribe by prefixed key', () => {
    const theme = resolveTheme('tribe:Vampire', []);
    assert.equal(theme.tribe, 'Vampire');
  });

  test('an unknown key is no theme, not a crash', () => {
    assert.equal(resolveTheme('not-a-theme', []), null);
    assert.equal(resolveTheme(null, []), null);
  });
});

describe('buildManaBase', () => {
  const swamp = (i) => card(`Dual ${i}`, {
    type_line: 'Land — Swamp Island', mana_cost: '', cmc: 0, color_identity: '',
  });

  test('fills every land slot, using owned lands then basics', () => {
    const result = buildManaBase({
      spells: many(10, () => ({ mana_cost: '{1}{B}', cmc: 2 })),
      landPool: many(5, swamp),
      landCount: 36,
      deckSize: 100,
      colorIdentity: 'B',
    });

    assert.equal(result.total, 36);
    assert.equal(result.lands.filter((l) => l.isBasic).reduce((s, l) => s + l.quantity, 0), 31);
  });

  test('splits basics by how much each colour is actually wanted', () => {
    const result = buildManaBase({
      // Nine black cards to one blue: the basics should follow that.
      spells: [...many(9, () => ({ mana_cost: '{B}', cmc: 1 })), { mana_cost: '{U}', cmc: 1 }],
      landPool: [],
      landCount: 20,
      deckSize: 100,
      colorIdentity: 'UB',
    });

    const swampCount = result.lands.find((l) => l.name === 'Swamp').quantity;
    const islandCount = result.lands.find((l) => l.name === 'Island').quantity;
    assert.ok(swampCount > islandCount, 'the heavier colour should get more basics');
    assert.equal(swampCount + islandCount, 20);
  });

  test('reports a colour that came up short of its Karsten target', () => {
    const result = buildManaBase({
      // A double-pip two-drop wants around 20 sources in a 60-card deck; two
      // lands cannot serve it.
      spells: many(10, () => ({ mana_cost: '{B}{B}', cmc: 2 })),
      landPool: [],
      landCount: 2,
      deckSize: 60,
      colorIdentity: 'B',
    });

    const shortfall = result.shortfalls.find((s) => s.code === 'sources-B');
    assert.ok(shortfall);
    assert.ok(shortfall.found < shortfall.wanted);
    assert.match(shortfall.message, /black sources/);
  });

  test('a land producing nothing the deck wants is passed over', () => {
    const result = buildManaBase({
      spells: many(10, () => ({ mana_cost: '{B}', cmc: 1 })),
      landPool: many(5, (i) => card(`Forest ${i}`, {
        type_line: 'Land — Forest', mana_cost: '', cmc: 0, color_identity: '',
      })),
      landCount: 36,
      deckSize: 100,
      colorIdentity: 'B',
    });

    assert.ok(!result.lands.some((l) => l.name.startsWith('Forest')));
    assert.equal(result.total, 36);
  });
});
