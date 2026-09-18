/**
 * Turning a deck into text somebody else's site will accept.
 *
 * Import-free on purpose, the same way `shoppingMerge.js` is: the interesting
 * part is the wording of each line, and that is worth testing under `node
 * --test` without a DOM or a SQLite driver anywhere near it.
 *
 * The formats differ in more than punctuation. Moxfield and Archidekt read
 * section headers and a printing, so a deck exported to them comes back with
 * the same art and the same commander. Arena and MTGO have no commander at
 * all, and MTGO has no set either — sending them a header they do not know
 * puts a line reading "Commander" into the deck as if it were a card. So the
 * shape of the export is per-target, not one string with the trimmings
 * removed.
 */

export const EXPORT_FORMATS = [
  {
    id: 'moxfield',
    label: 'Moxfield',
    hint: '1 Card Name (SET) 123 — sections, printings, foils',
  },
  {
    id: 'archidekt',
    label: 'Archidekt',
    hint: '1x Card Name (SET) 123 — sections, printings, foils',
  },
  {
    id: 'edhrec',
    label: 'EDHREC / Deckstats',
    hint: '1 Card Name — names only, commander first',
  },
  {
    id: 'arena',
    label: 'MTG Arena',
    hint: 'Deck / Sideboard, 1 Card Name (SET) 123',
  },
  {
    id: 'mtgo',
    label: 'MTGO',
    hint: 'Names only, sideboard after a blank line',
  },
  {
    id: 'text',
    label: 'Plain text',
    hint: 'Readable list with every section labelled',
  },
];

const FORMAT_IDS = new Set(EXPORT_FORMATS.map((f) => f.id));

/**
 * Which pile a row is in.
 *
 * `board_type` is the column that means it; `is_sideboard` is the legacy
 * fallback for rows written before the maybeboard existed. Same reading as the
 * deck builder's own, kept here so the export does not depend on it.
 */
function boardOf(card) {
  if (card.board_type) return card.board_type;
  return card.is_sideboard ? 'sideboard' : 'mainboard';
}

function isFoil(card) {
  return card.is_foil === 1 || card.is_foil === true;
}

function setCode(card) {
  return (card.set_code || '').toUpperCase();
}

/**
 * Split the deck the way an importing site expects to receive it.
 *
 * A commander is pulled out of whatever board it was filed under, so it lands
 * in the commander section once rather than twice — Moxfield reads a duplicate
 * as a rules violation and refuses the whole list.
 */
function partition(cards) {
  const commanders = [];
  const mainboard = [];
  const sideboard = [];
  const maybeboard = [];

  for (const card of cards || []) {
    if (card.is_commander) {
      commanders.push(card);
      continue;
    }
    const board = boardOf(card);
    if (board === 'sideboard') sideboard.push(card);
    else if (board === 'maybeboard') maybeboard.push(card);
    else mainboard.push(card);
  }

  return { commanders, mainboard, sideboard, maybeboard };
}

function plainLine(card) {
  return `${card.quantity} ${card.name}`;
}

function printingLine(card, { prefix = '', foilMarker = true } = {}) {
  const parts = [`${card.quantity}${prefix} ${card.name}`];
  const code = setCode(card);
  if (code) {
    parts.push(`(${code})`);
    if (card.collector_number) parts.push(String(card.collector_number));
  }
  if (foilMarker && isFoil(card)) parts.push('*F*');
  return parts.join(' ');
}

/**
 * Sections joined by a blank line, with empty ones dropped.
 *
 * A trailing "Sideboard" over nothing is not merely untidy: Archidekt keeps
 * the empty category and the deck arrives with a pile that was never there.
 */
function assemble(sections) {
  return sections
    .filter((section) => section && section.lines.length)
    .map((section) => (section.header ? [section.header, ...section.lines] : section.lines).join('\n'))
    .join('\n\n');
}

/**
 * Render a deck as text for one destination.
 *
 * `deck` is the shape `getDeckById` returns — `{ name, cards }` is all this
 * reads. Returns the text only; the filename is `exportFilename`'s job.
 */
export function formatDeckExport(deck, format) {
  if (!FORMAT_IDS.has(format)) {
    throw new Error(`Unknown export format: ${format}`);
  }

  const { commanders, mainboard, sideboard, maybeboard } = partition(deck?.cards);

  switch (format) {
    case 'moxfield':
      return assemble([
        { header: 'Commander', lines: commanders.map((c) => printingLine(c)) },
        { header: 'Deck', lines: mainboard.map((c) => printingLine(c)) },
        { header: 'Sideboard', lines: sideboard.map((c) => printingLine(c)) },
        { header: 'Maybeboard', lines: maybeboard.map((c) => printingLine(c)) },
      ]);

    case 'archidekt':
      return assemble([
        { header: 'Commander', lines: commanders.map((c) => printingLine(c, { prefix: 'x' })) },
        { header: 'Deck', lines: mainboard.map((c) => printingLine(c, { prefix: 'x' })) },
        { header: 'Sideboard', lines: sideboard.map((c) => printingLine(c, { prefix: 'x' })) },
        { header: 'Maybeboard', lines: maybeboard.map((c) => printingLine(c, { prefix: 'x' })) },
      ]);

    case 'edhrec':
      // No headers at all. EDHREC's box treats an unrecognised line as a card
      // it could not find and says so; the commander simply goes first, which
      // is the convention it reads.
      return assemble([
        { lines: [...commanders, ...mainboard].map(plainLine) },
      ]);

    case 'arena':
      // Arena has no commander zone. The commander is a card in the deck, and
      // the set is kept because Arena resolves printings, not just names.
      return assemble([
        {
          header: 'Deck',
          lines: [...commanders, ...mainboard].map((c) => printingLine(c, { foilMarker: false })),
        },
        {
          header: 'Sideboard',
          lines: sideboard.map((c) => printingLine(c, { foilMarker: false })),
        },
      ]);

    case 'mtgo':
      // Names only, and the blank line is the whole sideboard convention.
      return assemble([
        { lines: [...commanders, ...mainboard].map(plainLine) },
        { lines: sideboard.map(plainLine) },
      ]);

    case 'text':
    default:
      return assemble([
        { lines: [`// ${deck?.name || 'Deck'}`] },
        { header: 'Commander', lines: commanders.map((c) => printingLine(c)) },
        { header: 'Mainboard', lines: mainboard.map((c) => printingLine(c)) },
        { header: 'Sideboard', lines: sideboard.map((c) => printingLine(c)) },
        { header: 'Maybeboard', lines: maybeboard.map((c) => printingLine(c)) },
      ]);
  }
}

/**
 * A filename someone can find again in their downloads folder.
 *
 * The deck's own name leads, because the format is the thing they will
 * remember least about the file a week later.
 */
export function exportFilename(deck, format) {
  const slug = (deck?.name || 'deck')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'deck'}-${format}.txt`;
}
