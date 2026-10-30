/**
 * EDHREC's commander pages, read from the JSON their own site loads
 * (json.edhrec.com/pages/commanders/<slug>.json). There is no published API;
 * this is the undocumented one, so everything here is defensive — a field
 * that moves should cost a column, not the page.
 *
 * Import-free, like comboFilter.js, so it can be tested without the database.
 */

/**
 * EDHREC's URL slug for a commander. Accepts a card name ("Atraxa, Praetors'
 * Voice"), a slug, or a pasted EDHREC URL. Partner pairs are two names joined
 * by a hyphen, which falls out of the same rule when given as "A // B" or
 * "A + B"; a pasted URL is the reliable way to get one exactly.
 */
export function commanderSlug(input) {
  const raw = String(input || '').trim();
  const fromUrl = raw.match(/edhrec\.com\/(?:[a-z-]+\/)*commanders\/([a-z0-9-]+)/i);
  if (fromUrl) return fromUrl[1].toLowerCase();

  return raw
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’",.!?]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The page reduced to what we use: the commander, how many decks the numbers
 * come from, and each category's cards with inclusion (share of that
 * commander's decks that play it) and synergy (how much more than in other
 * decks of those colours). The same card can sit in more than one list —
 * "Top Cards" repeats from the type lists — so `cards` is also given once per
 * name, in the first category it appeared in.
 */
export function parseCommanderPage(json) {
  const dict = json?.container?.json_dict || {};
  const head = dict.card || {};
  const lists = [];
  const seen = new Map();

  for (const list of dict.cardlists || []) {
    const cards = [];
    for (const view of list.cardviews || []) {
      if (!view?.name) continue;
      const potential = Number(view.potential_decks) || 0;
      const card = {
        name: view.name,
        inclusion: potential ? Number(view.num_decks || 0) / potential : null,
        synergy: typeof view.synergy === 'number' ? view.synergy : null,
        numDecks: Number(view.num_decks) || 0,
      };
      cards.push(card);
      if (!seen.has(card.name)) seen.set(card.name, { ...card, category: list.header || list.tag || '' });
    }
    if (cards.length) lists.push({ tag: list.tag || '', header: list.header || list.tag || '', cards });
  }

  return {
    commander: {
      name: head.name || json?.header || null,
      numDecks: Number(head.num_decks) || null,
      colorIdentity: head.color_identity || [],
    },
    lists,
    cards: [...seen.values()],
  };
}
