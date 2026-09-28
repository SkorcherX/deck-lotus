import db from '../db/connection.js';
import { matchSealedProduct, normalizeSealedName } from '../shared/sealedMatch.js';
import { parseCsv, parseMoney } from '../shared/csv.js';

/**
 * Sealed product holdings. See migration 046 for the shape and why lots are
 * rows of their own and the catalog uuid carries no foreign key.
 *
 * A lot's value, per unit, is the first of: the owner's override, the live
 * TCGplayer price for its catalog uuid (sealed_prices, filled by the daily
 * price sync when MTGJSON's feed carries one), and the reference price an
 * import brought with it. `value_source` says which, so the page can say
 * how much to trust the number.
 */
const LOT_SELECT = `
  SELECT os.*,
         sp.name AS catalog_name,
         sp.category AS catalog_category,
         sp.subtype AS catalog_subtype,
         sp.release_date,
         sp.tcgplayer_product_id,
         spr.price AS live_price,
         spr.updated_at AS live_price_updated_at,
         COALESCE(s.name, os.set_name) AS display_set_name
    FROM owned_sealed os
    LEFT JOIN sealed_products sp ON sp.uuid = os.sealed_uuid
    LEFT JOIN sealed_prices spr ON spr.sealed_uuid = os.sealed_uuid
    LEFT JOIN sets s ON s.code = COALESCE(os.set_code, sp.set_code)
`;

function decorate(lot) {
  let unitValue = null;
  let valueSource = null;
  if (lot.price_override != null) { unitValue = lot.price_override; valueSource = 'override'; }
  else if (lot.live_price != null) { unitValue = lot.live_price; valueSource = 'tcgplayer'; }
  else if (lot.reference_price != null) { unitValue = lot.reference_price; valueSource = 'reference'; }

  return {
    ...lot,
    unit_value: unitValue,
    value_source: valueSource,
    total_value: unitValue == null ? null : unitValue * lot.quantity,
    total_cost: lot.cost_paid == null ? null : lot.cost_paid * lot.quantity,
    tcgplayer_url: lot.tcgplayer_product_id
      ? `https://www.tcgplayer.com/product/${lot.tcgplayer_product_id}`
      : null,
  };
}

/**
 * Link lots that have no catalog entry yet. An import made before the weekly
 * sync had filled `sealed_products` could match nothing; once the catalog is
 * there, the next read links them, so nobody has to re-import. Cheap: it only
 * looks at this user's unlinked lots, and only within their set.
 */
function linkUnmatched(userId) {
  const unlinked = db.all(
    `SELECT id, name, set_code FROM owned_sealed WHERE user_id = ? AND sealed_uuid IS NULL AND set_code IS NOT NULL`,
    [userId]
  );
  if (!unlinked.length) return;
  if (!db.get(`SELECT 1 FROM sealed_products LIMIT 1`)) return;

  const bySet = new Map();
  for (const lot of unlinked) {
    if (!bySet.has(lot.set_code)) {
      bySet.set(lot.set_code, db.all(`SELECT uuid, name, category FROM sealed_products WHERE set_code = ?`, [lot.set_code]));
    }
    const match = matchSealedProduct(lot.name, bySet.get(lot.set_code));
    if (match) {
      db.run(
        `UPDATE owned_sealed SET sealed_uuid = ?, category = COALESCE(category, ?), updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND sealed_uuid IS NULL`,
        [match.uuid, match.category, lot.id]
      );
    }
  }
}

export function listSealed(userId) {
  linkUnmatched(userId);
  const lots = db.all(`${LOT_SELECT} WHERE os.user_id = ? ORDER BY display_set_name, os.name`, [userId])
    .map(decorate);

  const totals = lots.reduce((t, l) => {
    t.items += l.quantity;
    if (l.total_value != null) t.value += l.total_value;
    if (l.total_cost != null) t.cost += l.total_cost;
    return t;
  }, { items: 0, value: 0, cost: 0 });

  return { lots, totals: { ...totals, lots: lots.length } };
}

function getLot(userId, id) {
  const lot = db.get(`${LOT_SELECT} WHERE os.user_id = ? AND os.id = ?`, [userId, id]);
  return lot ? decorate(lot) : null;
}

/** Search MTGJSON's sealed catalog by name. */
export function searchCatalog(query, limit = 25) {
  const q = normalizeSealedName(query);
  if (!q) return [];
  const terms = q.split(' ').filter(Boolean);
  return db.all(
    `SELECT sp.uuid, sp.name, sp.set_code, sp.category, sp.subtype, sp.release_date,
            s.name AS set_name, spr.price AS live_price
       FROM sealed_products sp
       LEFT JOIN sets s ON s.code = sp.set_code
       LEFT JOIN sealed_prices spr ON spr.sealed_uuid = sp.uuid
      WHERE ${terms.map(() => '(sp.name_normalized LIKE ? OR LOWER(COALESCE(s.name, \'\')) LIKE ?)').join(' AND ')}
      ORDER BY sp.release_date DESC, sp.name
      LIMIT ?`,
    [...terms.flatMap((t) => [`%${t}%`, `%${t}%`]), Math.min(Number(limit) || 25, 100)]
  );
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

function cleanFields(input) {
  const out = {};
  if (input.sealedUuid !== undefined) out.sealed_uuid = input.sealedUuid || null;
  if (input.name !== undefined) out.name = String(input.name).trim();
  if (input.setName !== undefined) out.set_name = input.setName || null;
  if (input.setCode !== undefined) out.set_code = input.setCode ? String(input.setCode).toUpperCase() : null;
  if (input.category !== undefined) out.category = input.category || null;
  if (input.quantity !== undefined) {
    const q = Number(input.quantity);
    if (!Number.isInteger(q) || q < 1) throw new Error('Quantity must be a whole number of at least 1');
    out.quantity = q;
  }
  for (const [key, col] of [['costPaid', 'cost_paid'], ['priceOverride', 'price_override'], ['referencePrice', 'reference_price']]) {
    if (input[key] !== undefined) {
      const v = num(input[key]);
      if (v !== null && (!Number.isFinite(v) || v < 0)) throw new Error(`${key} must be a positive number`);
      out[col] = v;
    }
  }
  if (input.referencePriceDate !== undefined) out.reference_price_date = input.referencePriceDate || null;
  if (input.notes !== undefined) out.notes = input.notes || null;
  if (input.acquiredAt !== undefined) out.acquired_at = input.acquiredAt || null;
  return out;
}

export function addSealed(userId, input) {
  const fields = cleanFields({ quantity: 1, ...input });

  // Picking from the catalog fills the name and set, so a caller only has to
  // send the uuid.
  if (fields.sealed_uuid) {
    const product = db.get(`SELECT * FROM sealed_products WHERE uuid = ?`, [fields.sealed_uuid]);
    if (!product) throw new Error('That sealed product is not in the catalog');
    fields.name = fields.name || product.name;
    fields.set_code = fields.set_code || product.set_code;
    fields.category = fields.category || product.category;
  }
  if (!fields.name) throw new Error('A name, or a catalog product, is required');

  const cols = Object.keys(fields);
  const { lastInsertRowid } = db.run(
    `INSERT INTO owned_sealed (user_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
    [userId, ...cols.map((c) => fields[c])]
  );
  return getLot(userId, lastInsertRowid);
}

export function updateSealed(userId, id, input) {
  if (!getLot(userId, id)) throw Object.assign(new Error('Sealed item not found'), { statusCode: 404 });
  const fields = cleanFields(input);
  if (fields.name === '') throw new Error('Name cannot be empty');
  const cols = Object.keys(fields);
  if (cols.length) {
    db.run(
      `UPDATE owned_sealed SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND id = ?`,
      [...cols.map((c) => fields[c]), userId, id]
    );
  }
  return getLot(userId, id);
}

export function deleteSealed(userId, id) {
  const { changes } = db.run(`DELETE FROM owned_sealed WHERE user_id = ? AND id = ?`, [userId, id]);
  if (!changes) throw Object.assign(new Error('Sealed item not found'), { statusCode: 404 });
  return { success: true };
}

/**
 * Import a CardCastle portfolio export (or anything with the same columns).
 *
 * Each row becomes a lot. The product is matched to MTGJSON's catalog within
 * its set where it can be; a row that matches nothing is still imported,
 * unlinked, because the box exists whether or not the catalog knows it. The
 * export's "Market Price (As of <date>)" becomes the reference price with that
 * date, and "Price Override" (when non-zero) the override.
 *
 * Rows for other games are skipped and reported.
 */
export function importSealedCsv(userId, csvText) {
  const rows = parseCsv(csvText);
  const result = { imported: 0, matched: 0, unmatched: [], skipped: [] };
  if (rows.length === 0) return result;

  const header = Object.keys(rows[0]);
  const marketCol = header.find((h) => /^market price/i.test(h));
  const marketDate = marketCol?.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null;

  const setsByName = new Map(db.all(`SELECT code, name FROM sets`).map((s) => [s.name.toLowerCase(), s.code]));
  const catalogFor = new Map();
  const candidatesFor = (setCode) => {
    const k = setCode || '*';
    if (!catalogFor.has(k)) {
      catalogFor.set(k, setCode
        ? db.all(`SELECT uuid, name, set_code, category FROM sealed_products WHERE set_code = ?`, [setCode])
        : []);
    }
    return catalogFor.get(k);
  };

  db.transaction(() => {
    for (const [i, row] of rows.entries()) {
      const name = row['Product Name'] || row.Name || '';
      const category = row.Category || '';
      if (!name) { result.skipped.push({ row: i + 2, reason: 'No product name' }); continue; }
      if (category && !/magic/i.test(category)) {
        result.skipped.push({ row: i + 2, name, reason: `Not Magic: ${category}` });
        continue;
      }

      const setName = row.Set || row['Set Name'] || null;
      const setCode = setName
        ? setsByName.get(setName.toLowerCase())
          || setsByName.get(setName.replace(/^Universes Beyond:\s*/i, '').toLowerCase())
          || null
        : null;
      const match = matchSealedProduct(name, candidatesFor(setCode));

      const override = parseMoney(row['Price Override']);
      addSealed(userId, {
        sealedUuid: match?.uuid || null,
        name,
        setName,
        setCode: setCode || match?.set_code || null,
        category: match?.category || null,
        quantity: Math.max(1, parseInt(row.Quantity, 10) || 1),
        costPaid: parseMoney(row['Average Cost Paid']),
        referencePrice: marketCol ? parseMoney(row[marketCol]) : null,
        referencePriceDate: marketDate,
        priceOverride: override ? override : null,
        notes: row.Notes || null,
        acquiredAt: row['Date Added'] || null,
      });

      result.imported++;
      if (match) result.matched++;
      else result.unmatched.push({ row: i + 2, name });
    }
  });

  return result;
}
