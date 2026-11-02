import db from '../db/connection.js';
import { buildLookupScript, parseLookupResult, DEFAULT_OPTIONS, CONDITIONS } from '../shared/localShop.js';

/**
 * Local stores and their pasted-back price lookups.
 *
 * Nothing here contacts a store. The stores' APIs refuse non-browser
 * clients, and the lookup is meant to be the user's own, in their own
 * browser, so the server's part is building the script and filing the
 * result it produced.
 */

export class LocalStoreError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** An https origin, or an error the user can act on. */
export function normalizeStoreUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim().replace(/^(?!https?:\/\/)/i, 'https://'));
  } catch {
    throw new LocalStoreError('That is not a web address.');
  }
  if (url.protocol !== 'https:') throw new LocalStoreError('The store address must start with https://');
  return url.origin;
}

function readQuote(row) {
  if (!row.payload) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

export function listStores(userId) {
  return db.all(`
    SELECT s.id, s.name, s.base_url, s.created_at, q.fetched_at, q.payload
    FROM local_stores s
    LEFT JOIN local_store_quotes q ON q.store_id = s.id
    WHERE s.user_id = ?
    ORDER BY s.name COLLATE NOCASE
  `, [userId]).map((row) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    createdAt: row.created_at,
    fetchedAt: row.fetched_at,
    result: readQuote(row),
  }));
}

function getStore(userId, storeId) {
  const store = db.get(`SELECT id, name, base_url FROM local_stores WHERE id = ? AND user_id = ?`, [storeId, userId]);
  if (!store) throw new LocalStoreError('Store not found', 404);
  return store;
}

export function addStore(userId, { name, baseUrl }) {
  const cleanName = String(name || '').trim().slice(0, 100);
  if (!cleanName) throw new LocalStoreError('Give the store a name.');
  const origin = normalizeStoreUrl(baseUrl);
  if (db.get(`SELECT id FROM local_stores WHERE user_id = ? AND base_url = ?`, [userId, origin])) {
    throw new LocalStoreError('That store is already on your list.', 409);
  }
  const { lastInsertRowid } = db.run(
    `INSERT INTO local_stores (user_id, name, base_url) VALUES (?, ?, ?)`,
    [userId, cleanName, origin]
  );
  return listStores(userId).find((s) => s.id === Number(lastInsertRowid));
}

export function updateStore(userId, storeId, { name, baseUrl }) {
  const store = getStore(userId, storeId);
  const cleanName = name == null ? store.name : String(name).trim().slice(0, 100);
  if (!cleanName) throw new LocalStoreError('Give the store a name.');
  const origin = baseUrl == null ? store.base_url : normalizeStoreUrl(baseUrl);
  if (origin !== store.base_url
    && db.get(`SELECT id FROM local_stores WHERE user_id = ? AND base_url = ?`, [userId, origin])) {
    throw new LocalStoreError('That store is already on your list.', 409);
  }
  db.run(`UPDATE local_stores SET name = ?, base_url = ? WHERE id = ?`, [cleanName, origin, store.id]);
  // A quote taken from the old address is not a quote for the new one.
  if (origin !== store.base_url) db.run(`DELETE FROM local_store_quotes WHERE store_id = ?`, [store.id]);
  return listStores(userId).find((s) => s.id === store.id);
}

export function removeStore(userId, storeId) {
  const store = getStore(userId, storeId);
  db.run(`DELETE FROM local_stores WHERE id = ?`, [store.id]);
}

/**
 * The console script for a card list. One script fits every store — it
 * looks up against whichever site it is pasted on — so it takes no store.
 */
export function buildScript({ cards, options } = {}) {
  if (!Array.isArray(cards) || !cards.length) throw new LocalStoreError('There are no cards to look up.');
  if (cards.length > 1000) throw new LocalStoreError('That is more than 1,000 cards; look up a smaller list.');
  const list = cards
    .map((c) => ({ name: String(c?.name || '').trim(), quantity: Math.max(1, parseInt(c?.quantity, 10) || 1), foil: !!c?.foil }))
    .filter((c) => c.name);
  const opts = {
    minCondition: CONDITIONS.includes(options?.minCondition) ? options.minCondition : DEFAULT_OPTIONS.minCondition,
    allowFoil: !!options?.allowFoil,
    delayMs: DEFAULT_OPTIONS.delayMs,
  };
  return { script: buildLookupScript(list, opts), cards: list.length };
}

/**
 * File a pasted result under the store whose address it came from. The
 * origin decides, not a store picked in the UI: pasting a result into the
 * wrong column would quote one shop's shelf under another's name.
 */
export function importResult(userId, input) {
  let result;
  try {
    result = parseLookupResult(input);
  } catch (err) {
    throw new LocalStoreError(err.message);
  }
  const store = db.get(`SELECT id FROM local_stores WHERE user_id = ? AND base_url = ?`, [userId, result.origin]);
  if (!store) {
    throw new LocalStoreError(`These results came from ${result.origin}, which is not one of your stores. Add it first.`, 404);
  }
  db.run(`
    INSERT INTO local_store_quotes (store_id, fetched_at, payload, imported_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(store_id) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload,
                                        imported_at = excluded.imported_at
  `, [store.id, result.fetchedAt, JSON.stringify(result)]);
  return listStores(userId).find((s) => s.id === store.id);
}

export function clearResult(userId, storeId) {
  const store = getStore(userId, storeId);
  db.run(`DELETE FROM local_store_quotes WHERE store_id = ?`, [store.id]);
}
