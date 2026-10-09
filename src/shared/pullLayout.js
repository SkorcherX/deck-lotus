/**
 * Grouping a deck's pull list the way the cards sit in physical storage.
 *
 * A pull list sorted any other way than the shelves are sorted sends somebody
 * back and forth across the room; one sorted the same way lets them walk the
 * storage once, front to back. So this is a *layout*, not a sort order:
 *
 *   section  (a colour, Multicolour, Colourless, Lands)
 *     rarity (Mythic, Rare, Uncommon, Common)
 *       type — only for the rarities that section is split by
 *
 * The type split is per section because volume is per section: a collection
 * with a deep pile of white commons and a thin pile of white uncommons splits
 * the first by type and not the second, and the multicolour section, where
 * uncommons are the plentiful rarity, is split the other way round. A fixed
 * "colour → rarity → type" chain could not describe that.
 *
 * Colour is the card's printed colour, not its colour identity: a mono-green
 * card with a white activated ability is filed as green, because that is what
 * somebody looking at the card files it under.
 *
 * Import-free and shared by the server and the client, so changing the layout
 * regroups the list without a round trip.
 */

export const COLOR_SECTIONS = [
  { key: 'W', label: 'White' },
  { key: 'U', label: 'Blue' },
  { key: 'B', label: 'Black' },
  { key: 'R', label: 'Red' },
  { key: 'G', label: 'Green' },
];

export const SECTIONS = [
  ...COLOR_SECTIONS,
  { key: 'multicolor', label: 'Multicolour' },
  { key: 'colorless', label: 'Colourless' },
  { key: 'land', label: 'Lands' },
];

export const RARITIES = [
  { key: 'mythic', label: 'Mythic' },
  { key: 'rare', label: 'Rare' },
  { key: 'uncommon', label: 'Uncommon' },
  { key: 'common', label: 'Common' },
  { key: 'special', label: 'Special' },
];

/**
 * Creature first, so an Artifact Creature files under Creature — the usual
 * convention, and the one that keeps every body in one place.
 */
export const TYPES = [
  { key: 'creature', label: 'Creature' },
  { key: 'planeswalker', label: 'Planeswalker' },
  { key: 'battle', label: 'Battle' },
  { key: 'instant', label: 'Instant' },
  { key: 'sorcery', label: 'Sorcery' },
  { key: 'artifact', label: 'Artifact' },
  { key: 'enchantment', label: 'Enchantment' },
  { key: 'land', label: 'Land' },
  { key: 'other', label: 'Other' },
];

/**
 * Which rarities each section is split by type. Mono-coloured and colourless
 * sections split commons; Multicolour splits uncommons.
 */
export const DEFAULT_PULL_LAYOUT = {
  splitByType: {
    W: ['common'], U: ['common'], B: ['common'], R: ['common'], G: ['common'],
    multicolor: ['uncommon'],
    colorless: ['common'],
    land: [],
  },
};

const SECTION_KEYS = new Set(SECTIONS.map((s) => s.key));
const RARITY_KEYS = new Set(RARITIES.map((r) => r.key));

/** A stored layout, made safe: unknown sections and rarities are dropped. */
export function normalizeLayout(layout) {
  const split = {};
  const given = layout && typeof layout === 'object' ? layout.splitByType : null;
  for (const key of SECTION_KEYS) {
    const list = given && Array.isArray(given[key]) ? given[key] : DEFAULT_PULL_LAYOUT.splitByType[key];
    split[key] = [...new Set(list.filter((r) => RARITY_KEYS.has(r)))];
  }
  return { splitByType: split };
}

function colorsOf(card) {
  const raw = Array.isArray(card.colors) ? card.colors.join('') : String(card.colors || '');
  return [...new Set(raw.toUpperCase().replace(/[^WUBRG]/g, ''))];
}

const typeLine = (card) => String(card.type_line ?? card.typeLine ?? '').toLowerCase();

export function isLandCard(card) {
  // The front face decides: a modal DFC with a land on the back is a spell.
  return /\bland\b/.test(typeLine(card).split('//')[0]);
}

export function sectionOf(card) {
  if (isLandCard(card)) return 'land';
  const colors = colorsOf(card);
  if (colors.length > 1) return 'multicolor';
  if (colors.length === 1) return colors[0];
  return 'colorless';
}

export function rarityOf(card) {
  const r = String(card.rarity || '').toLowerCase();
  return RARITY_KEYS.has(r) && r !== 'special' ? r : (r ? 'special' : 'common');
}

export function typeOf(card) {
  const line = typeLine(card).split('//')[0];
  const found = TYPES.find((t) => t.key !== 'other' && new RegExp(`\\b${t.key}\\b`).test(line));
  return found ? found.key : 'other';
}

const labelOf = (list, key) => list.find((x) => x.key === key)?.label || key;
const indexOf = (list, key) => {
  const i = list.findIndex((x) => x.key === key);
  return i === -1 ? list.length : i;
};

/**
 * Group rows into storage piles, in walking order.
 *
 * @param rows   card-like rows: name, colors, type_line (or typeLine), rarity
 * @param layout a pull layout (normalised here)
 * @returns [{ key, section, rarity, type, label, rows }] — `type` is null for
 *          a pile that is not split by type. Rows within a pile are A–Z.
 */
export function groupPullRows(rows, layout = DEFAULT_PULL_LAYOUT) {
  const { splitByType } = normalizeLayout(layout);
  const piles = new Map();

  for (const row of rows) {
    const section = sectionOf(row);
    const rarity = rarityOf(row);
    const type = (splitByType[section] || []).includes(rarity) ? typeOf(row) : null;
    const key = `${section}|${rarity}|${type || ''}`;
    if (!piles.has(key)) {
      piles.set(key, {
        key,
        section,
        rarity,
        type,
        label: [labelOf(SECTIONS, section), labelOf(RARITIES, rarity), type && labelOf(TYPES, type)]
          .filter(Boolean).join(' · '),
        rows: [],
      });
    }
    piles.get(key).rows.push(row);
  }

  const ordered = [...piles.values()].sort((a, b) => indexOf(SECTIONS, a.section) - indexOf(SECTIONS, b.section)
    || indexOf(RARITIES, a.rarity) - indexOf(RARITIES, b.rarity)
    || indexOf(TYPES, a.type) - indexOf(TYPES, b.type));

  for (const pile of ordered) {
    pile.rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  return ordered;
}
