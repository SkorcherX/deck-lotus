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

/**
 * Every store in the household, with this user's own settings and lookup.
 * Stores are shared (migration 053): anyone's addition shows up for everyone,
 * and `hidden`/`checking` are each user's own say over it. Hidden stores are
 * returned too, flagged, so the page can offer them back.
 */
export function listStores(userId) {
  return db.all(`
    SELECT s.id, s.name, s.base_url, s.created_at, s.created_by, u.username AS created_by_name,
           COALESCE(pf.hidden, 0) AS hidden, COALESCE(pf.checking, 1) AS checking,
           q.fetched_at, q.payload
    FROM local_stores s
    LEFT JOIN users u ON u.id = s.created_by
    LEFT JOIN local_store_prefs pf ON pf.store_id = s.id AND pf.user_id = @u
    LEFT JOIN local_store_quotes q ON q.store_id = s.id AND q.user_id = @u
    ORDER BY s.name COLLATE NOCASE
  `, { u: userId }).map((row) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    createdAt: row.created_at,
    addedBy: row.created_by === userId ? null : row.created_by_name,
    hidden: !!row.hidden,
    checking: !!row.checking,
    fetchedAt: row.fetched_at,
    result: readQuote(row),
  }));
}

function getStore(storeId) {
  const store = db.get(`SELECT id, name, base_url FROM local_stores WHERE id = ?`, [storeId]);
  if (!store) throw new LocalStoreError('Store not found', 404);
  return store;
}

function storeFor(userId, id) {
  return listStores(userId).find((s) => s.id === Number(id));
}

/** Upsert this user's settings for a store; omitted fields keep their value. */
export function setStorePrefs(userId, storeId, { hidden, checking } = {}) {
  const store = getStore(storeId);
  const current = db.get(`SELECT hidden, checking FROM local_store_prefs WHERE user_id = ? AND store_id = ?`, [userId, store.id])
    || { hidden: 0, checking: 1 };
  db.run(`
    INSERT INTO local_store_prefs (user_id, store_id, hidden, checking) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, store_id) DO UPDATE SET hidden = excluded.hidden, checking = excluded.checking
  `, [userId, store.id,
    hidden == null ? current.hidden : (hidden ? 1 : 0),
    checking == null ? current.checking : (checking ? 1 : 0)]);
  return storeFor(userId, store.id);
}

/**
 * Add a store for the household. An address somebody already added is not
 * an error: it is the same shop, so it comes back onto this user's view.
 */
export function addStore(userId, { name, baseUrl }) {
  const cleanName = String(name || '').trim().slice(0, 100);
  if (!cleanName) throw new LocalStoreError('Give the store a name.');
  const origin = normalizeStoreUrl(baseUrl);
  const existing = db.get(`SELECT id FROM local_stores WHERE base_url = ?`, [origin]);
  if (existing) return setStorePrefs(userId, existing.id, { hidden: false, checking: true });
  const { lastInsertRowid } = db.run(
    `INSERT INTO local_stores (created_by, name, base_url) VALUES (?, ?, ?)`,
    [userId, cleanName, origin]
  );
  return storeFor(userId, lastInsertRowid);
}

/** Rename or re-address a store. Shared, so the change is everyone's. */
export function updateStore(userId, storeId, { name, baseUrl }) {
  const store = getStore(storeId);
  const cleanName = name == null ? store.name : String(name).trim().slice(0, 100);
  if (!cleanName) throw new LocalStoreError('Give the store a name.');
  const origin = baseUrl == null ? store.base_url : normalizeStoreUrl(baseUrl);
  if (origin !== store.base_url && db.get(`SELECT id FROM local_stores WHERE base_url = ?`, [origin])) {
    throw new LocalStoreError('That store is already on the list.', 409);
  }
  db.run(`UPDATE local_stores SET name = ?, base_url = ? WHERE id = ?`, [cleanName, origin, store.id]);
  // A quote taken from the old address is not a quote for the new one.
  if (origin !== store.base_url) db.run(`DELETE FROM local_store_quotes WHERE store_id = ?`, [store.id]);
  return storeFor(userId, store.id);
}

/**
 * Take a store off this user's view, along with their lookup there. Others
 * keep it. Once nobody in the household still sees it, the row goes.
 */
export function removeStore(userId, storeId) {
  const store = getStore(storeId);
  setStorePrefs(userId, store.id, { hidden: true });
  db.run(`DELETE FROM local_store_quotes WHERE store_id = ? AND user_id = ?`, [store.id, userId]);
  const stillSeen = db.get(`
    SELECT 1 FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM local_store_prefs pf WHERE pf.user_id = u.id AND pf.store_id = ? AND pf.hidden = 1)
    LIMIT 1
  `, [store.id]);
  if (!stillSeen) db.run(`DELETE FROM local_stores WHERE id = ?`, [store.id]);
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
  const store = db.get(`SELECT id FROM local_stores WHERE base_url = ?`, [result.origin]);
  if (!store) {
    throw new LocalStoreError(`These results came from ${result.origin}, which is not one of your stores. Add it first.`, 404);
  }
  db.run(`
    INSERT INTO local_store_quotes (store_id, user_id, fetched_at, payload, imported_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(store_id, user_id) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload,
                                                 imported_at = excluded.imported_at
  `, [store.id, userId, result.fetchedAt, JSON.stringify(result)]);
  // Pasting a lookup from a store is asking to use it.
  return setStorePrefs(userId, store.id, { hidden: false });
}

export function clearResult(userId, storeId) {
  const store = getStore(storeId);
  db.run(`DELETE FROM local_store_quotes WHERE store_id = ? AND user_id = ?`, [store.id, userId]);
}
