/**
 * What counts as a board wipe.
 *
 * This has its own file because the predicate was badly wrong and the way it
 * was wrong is worth keeping a record of. It used to end with
 * `each (creature|player sacrifices)`, and that one clause matched 1,127 cards
 * on its own — "put a +1/+1 counter on each creature you control" and every
 * other card that merely counts creatures. `isSweeper` fired on 4.7% of every
 * card ever printed, and the deck generator duly filled its three board-wipe
 * slots with an Abzan Falconer.
 *
 * The cases below are real cards, and most of them are here because they broke
 * a version of this predicate.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { isSweeper } from '../src/services/cardRoleService.js';

/** Oracle text as the cards table stores it. */
const card = (name, oracle_text, type_line = 'Sorcery') => ({ name, oracle_text, type_line });

describe('isSweeper — the wipes it must catch', () => {
  const wipes = [
    card('Wrath of God', 'Destroy all creatures. They can\'t be regenerated.'),
    card('Languish', 'All creatures get -4/-4 until end of turn.'),
    card('Toxic Deluge',
      'Choose a number X. You lose X life, then all creatures get -X/-X until end of turn.'),
    card('Blasphemous Act', 'Blasphemous Act deals 13 damage to each creature.'),
    card('Fault Line', 'Fault Line deals X damage to each creature without flying and each player.'),
    card('Massacre Wurm',
      'When Massacre Wurm enters, creatures your opponents control get -2/-2 until end of turn.',
      'Creature — Phyrexian Wurm'),
    card('Evacuation', 'Return all creatures to their owners\' hands.', 'Instant'),
    card('Living Death',
      'Each player exiles all creature cards from their graveyard, then sacrifices all creatures '
      + 'they control, then puts all cards they exiled this way onto the battlefield.'),
    card('Slaughter the Strong',
      'Each player chooses any number of creatures they control with total power 4 or less, then '
      + 'sacrifices all other creatures they control.'),
    card('Necrotic Hex',
      'Each player sacrifices six creatures of their choice. You create six tapped 2/2 black '
      + 'Zombie creature tokens.'),
    card('Wave of Vitriol',
      'Each player sacrifices all artifacts, enchantments, and nonbasic lands they control.'),
    card('Armageddon', 'Destroy all lands.'),
    // Farewell is the reason the zone is not used as an exclusion: one of its
    // modes exiles all graveyards, and excluding on that threw the card away.
    card('Farewell',
      'Choose one or more — • Exile all artifacts. • Exile all creatures. • Exile all '
      + 'enchantments. • Exile all graveyards.'),
    // Overload turns "target" into "each", so these are wipes in the only mode
    // anybody casts them for.
    card('Damn',
      'Destroy target creature. A creature destroyed this way can\'t be regenerated. '
      + 'Overload {2}{W}{W} (You may cast this spell for its overload cost. If you do, change '
      + '"target" in its text to "each.")'),
    card('Cyclonic Rift',
      'Return target nonland permanent you don\'t control to its owner\'s hand. Overload {6}{U} '
      + '(You may cast this spell for its overload cost. If you do, change "target" in its text '
      + 'to "each.")', 'Instant'),
    card('Extinction Event',
      'Choose odd or even. Exile each creature with mana value of the chosen quality.'),
  ];

  for (const c of wipes) {
    test(c.name, () => assert.equal(isSweeper(c), true));
  }
});

describe('isSweeper — what it must not catch', () => {
  const notWipes = [
    // The two a real generated deck put in its board-wipe slots.
    card('Plumb the Forbidden',
      'As an additional cost to cast this spell, you may sacrifice one or more creatures. When '
      + 'you do, copy this spell for each creature sacrificed this way. You draw a card and lose '
      + '1 life.', 'Instant'),
    card('Merchant of Venom',
      'Menace When Merchant of Venom enters, each player sacrifices a creature of their choice. '
      + 'Whenever a player sacrifices a permanent, put a +1/+1 counter on Merchant of Venom.',
      'Creature — Vampire'),
    // Counting creatures is not sweeping them. This shape was the bulk of the
    // 1,127 false positives.
    card('Abzan Ascendancy',
      'When Abzan Ascendancy enters, put a +1/+1 counter on each creature you control.',
      'Enchantment'),
    card('Abzan Falconer',
      'Outlast {W}. Each creature you control with a +1/+1 counter on it has flying.',
      'Creature — Human Soldier'),
    // Zones that are not the board.
    card('Rest in Peace',
      'When Rest in Peace enters, exile all graveyards. If a card or token would be put into a '
      + 'graveyard from anywhere, exile it instead.', 'Enchantment'),
    card('Divining Witch',
      '{1}{B}, {T}, Discard a card: Choose a card name. Exile the top six cards of your library, '
      + 'then reveal cards from the top of your library until you reveal a card with the chosen '
      + 'name. Put that card into your hand and exile all other cards revealed this way.',
      'Creature — Human Wizard'),
    card('Hypnox',
      'Flying When Hypnox enters, if you cast it from your hand, exile all cards from target '
      + 'opponent\'s hand.', 'Creature — Horror'),
    // Overloaded, but it pumps rather than removes.
    card('Teleportal',
      'Target creature you control gets +1/+0 until end of turn and can\'t be blocked this turn. '
      + 'Overload {3}{U}{R}', 'Instant'),
    // A shrink that kills nothing is an anthem in reverse.
    card('Cumber Stone', 'Creatures your opponents control get -1/-0.', 'Artifact'),
    // Ordinary cards.
    card('Murder', 'Destroy target creature.', 'Instant'),
    card('Sol Ring', '{T}: Add {C}{C}.', 'Artifact'),
    card('Cultivate',
      'Search your library for up to two basic land cards, reveal those cards, put one onto the '
      + 'battlefield tapped and the other into your hand, then shuffle.'),
  ];

  for (const c of notWipes) {
    test(c.name, () => assert.equal(isSweeper(c), false));
  }
});
