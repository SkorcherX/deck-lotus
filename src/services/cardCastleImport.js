import db from '../db/connection.js';
import { parseCsv } from '../shared/csv.js';
import { normalizeCondition } from '../shared/conditions.js';
import { bulkAddToInventory } from './inventoryService.js';

/**
 * Import a CardCastle singles export into a collection, keeping condition.
 *
 * Columns used: Card Name, Set Name, Collector Number, Condition, Foil,
 * JSON ID (a Scryfall id). Each row is resolved to a printing by, in order,
 * its Scryfall id, its set name + collector number, and finally its name —
 * then handed to `bulkAddToInventory` as set code + collector number, so the
 * write, the audit batch and the owned_cards mirror are exactly a bulk add's.
 *
 * CardCastle writes one row per copy; identical copies are folded together
 * first so the audit log reads as "4 × NM" rather than four separate adds.
 *
 * `dryRun` resolves and reports without writing, so the page can show what
 * would happen to a four-thousand-row file before anything moves.
 */
export function importCardCastleSingles(userId, csvText, { dryRun = false, actorUserId } = {}) {
  const rows = parseCsv(csvText);
  const bySfid = db.prepare(`SELECT set_code, collector_number FROM printings WHERE scryfall_id = ? LIMIT 1`);
  const setsByName = new Map(db.all(`SELECT code, name FROM sets`).map((s) => [s.name.toLowerCase(), s.code]));
  const byNumber = db.prepare(`SELECT 1 FROM printings WHERE set_code = ? AND collector_number = ? COLLATE NOCASE LIMIT 1`);

  const folded = new Map();
  const unresolved = [];
  const conditionCounts = {};
  let nonEnglish = 0;

  for (const [i, row] of rows.entries()) {
    const cardName = row['Card Name'] || '';
    const isFoil = /^(foil|etched)/i.test(row.Foil || '');
    const condition = normalizeCondition(row.Condition);
    if (row.Language && row.Language.toLowerCase() !== 'en') nonEnglish++;

    let setCode = null;
    let collectorNumber = row['Collector Number'] || null;

    const sf = row['JSON ID'] && bySfid.get(row['JSON ID']);
    if (sf) {
      setCode = sf.set_code;
      collectorNumber = sf.collector_number;
    } else {
      const byName = row['Set Name'] && setsByName.get(row['Set Name'].toLowerCase());
      if (byName && collectorNumber && byNumber.get(byName, collectorNumber)) setCode = byName;
    }

    if (!setCode && !cardName) {
      unresolved.push({ row: i + 2, cardName, setName: row['Set Name'], reason: 'No card name or printing' });
      continue;
    }

    const item = setCode
      ? { cardName, setCode, collectorNumber, isFoil, condition }
      // Last resort: the name, in the set if we know it, and bulk add's own
      // resolver picks a printing — reported so it can be checked.
      : { cardName, setCode: setsByName.get((row['Set Name'] || '').toLowerCase()) || undefined, isFoil, condition, byNameOnly: true, row: i + 2 };

    const key = JSON.stringify([item.cardName, item.setCode, item.collectorNumber, isFoil, condition]);
    const prev = folded.get(key);
    if (prev) prev.quantity += 1;
    else folded.set(key, { ...item, quantity: 1 });
    conditionCounts[condition || 'unrecorded'] = (conditionCounts[condition || 'unrecorded'] || 0) + 1;
  }

  const items = [...folded.values()];
  const summary = {
    rows: rows.length,
    lines: items.length,
    byNameOnly: items.filter((i) => i.byNameOnly).map(({ cardName, setCode, row }) => ({ cardName, setCode, row })),
    conditions: conditionCounts,
    nonEnglish,
    unresolved,
  };

  if (dryRun) return { dryRun: true, ...summary };

  const clean = items.map(({ byNameOnly, row, ...rest }) => rest);
  const result = db.transaction(() => bulkAddToInventory(userId, clean, {
    source: 'bulk_add',
    actorUserId,
    batchId: `cardcastle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }));

  return { ...summary, ...result };
}
