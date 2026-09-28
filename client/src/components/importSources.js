import api from '../services/api.js';

/**
 * File imports offered inside the Bulk Add modal, one entry per platform.
 *
 * Pasted lists go through parseBulkAddText; a platform's own export is a file
 * with its own columns, so each source is resolved server-side by its own
 * endpoint and only has to supply two calls and a summary:
 *
 *   id        stable key, used as the <option> value
 *   label     what the picker shows
 *   accept    the file input's accept attribute
 *   hint      one line under the picker saying which export to use
 *   preview   (text) => dry-run result; must not write
 *   commit    (text) => { added, failed, errors }
 *   summarize (preview) => { count, lines[] } for the preview panel
 *
 * Adding a platform means a server route that resolves its export (ideally
 * ending in bulkAddToInventory with one batchId, so it can be undone from the
 * audit page) and one entry here. The modal needs no changes.
 */

function describeConditions(conditions = {}) {
  return Object.entries(conditions)
    .map(([code, n]) => `${n} ${code === 'unrecorded' ? 'no condition' : code}`)
    .join(', ');
}

export const IMPORT_SOURCES = [
  {
    id: 'cardcastle',
    label: 'CardCastle',
    accept: '.csv,text/csv',
    hint: 'A CardCastle singles export (CSV). Condition and foil are kept.',
    preview: (text) => api.importCardCastleSingles(text, true),
    commit: (text) => api.importCardCastleSingles(text, false),
    summarize(preview) {
      const lines = [
        `${preview.rows} cards in ${preview.lines} distinct lines (${describeConditions(preview.conditions)}).`,
      ];
      if (preview.byNameOnly?.length) lines.push(`${preview.byNameOnly.length} could only be matched by name — the printing will be a guess.`);
      if (preview.unresolved?.length) lines.push(`${preview.unresolved.length} rows could not be read and will be skipped.`);
      if (preview.nonEnglish) lines.push(`${preview.nonEnglish} are non-English; they import as the English printing.`);
      return { count: preview.rows, lines };
    },
  },
];

export function getImportSource(id) {
  return IMPORT_SOURCES.find((s) => s.id === id) || null;
}
