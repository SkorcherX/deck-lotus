/**
 * Local game store price lookups against a TCGplayer Pro storefront.
 *
 * The shop's API turns away anything that is not a browser on its own site,
 * so none of this runs on the server against the shop. The lookup half
 * (everything up to `lookupCards`) is serialised by `buildLookupScript` into
 * a snippet the user pastes into the shop's console; the server only ever
 * builds that text and reads back what the snippet produced. The planning
 * half compares those results with each other and with online prices.
 *
 * Import-free on purpose, like shoppingMerge.js: the snippet is built from
 * these functions' source text, so each lookup function may reference only
 * the others in SNIPPET_FUNCTIONS and its own arguments.
 */

export const RESULT_FORMAT = 'deck-lotus-local-store';
export const RESULT_VERSION = 1;
export const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];
export const DEFAULT_OPTIONS = { minCondition: 'LP', allowFoil: false, delayMs: 1000 };

/** NM 0 … DMG 4, from TCGplayer's wording ("Lightly Played Foil"); unknown → 99. */
export function conditionRank(conditionName) {
  const name = String(conditionName || '').replace(/\s+foil$/i, '').trim().toLowerCase();
  const ranks = {
    'near mint': 0, nm: 0,
    'lightly played': 1, lp: 1,
    'moderately played': 2, mp: 2,
    'heavily played': 3, hp: 3,
    damaged: 4, dmg: 4,
  };
  return name in ranks ? ranks[name] : 99;
}

/** "Fire // Ice" → "Fire". The shop's search does better on one face. */
export function frontFace(name) {
  return String(name || '').split('//')[0].trim();
}

/**
 * Does a shop product name describe this card? Product names carry variants
 * in trailing parentheses ("Sol Ring (1604) (Rainbow Foil)") and sometimes a
 * " - Dwarven" suffix; tokens ("Sol Ring Token") must not match. Either face
 * of a split card counts, so "Fire" matches "Fire // Ice".
 */
export function nameMatches(wanted, productName) {
  const clean = (s) => String(s || '')
    .toLowerCase()
    .replace(/(\s*\([^)]*\))+\s*$/, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const want = clean(wanted);
  const product = clean(productName);
  if (!want || !product) return false;
  if (want === product) return true;
  const wantFaces = want.split(/\s*\/\/\s*/);
  const productFaces = product.split(/\s*\/\/\s*/);
  return wantFaces.some((w) => productFaces.includes(w));
}

/**
 * Pick the cheapest in-stock copies for one card, across printings and
 * conditions. `card` is { name, quantity, foil }; `products` the matching
 * search items; `skusByProductId` the inventory answer keyed by product id.
 * Foil SKUs are taken for a foil line, or for any line when allowFoil is on;
 * a foil line falls back to non-foil stock only when allowFoil is on.
 */
export function allocate(card, products, skusByProductId, options) {
  const maxRank = conditionRank(options.minCondition || 'LP');
  const all = [];
  for (const product of products) {
    for (const sku of skusByProductId[product.id] || []) {
      if (!(sku.quantity > 0) || typeof sku.price !== 'number') continue;
      if (sku.languageName && sku.languageName !== 'English') continue;
      if (conditionRank(sku.conditionName) > maxRank) continue;
      all.push({
        productId: product.id,
        skuId: sku.skuId,
        printing: product.name,
        set: product.setName || '',
        condition: String(sku.conditionName || '').replace(/\s+foil$/i, ''),
        isFoil: !!sku.isFoil,
        price: sku.price,
        stock: sku.quantity,
      });
    }
  }

  let candidates;
  if (card.foil) {
    candidates = all.filter((c) => c.isFoil);
    if (!candidates.length && options.allowFoil) candidates = all;
  } else {
    candidates = options.allowFoil ? all : all.filter((c) => !c.isFoil);
  }
  candidates.sort((a, b) => a.price - b.price);

  const rows = [];
  let taken = 0;
  for (const c of candidates) {
    if (taken >= card.quantity) break;
    const qty = Math.min(c.stock, card.quantity - taken);
    rows.push({ ...c, qty });
    taken += qty;
  }
  return { taken, short: card.quantity - taken, rows };
}

/**
 * Run the lookups one request at a time. `fetchJson(path, body?)` is the
 * caller's: same-origin fetch in the snippet, fixtures in tests. Retries only
 * on 429/5xx (errors carrying `status`), and a card that fails is reported as
 * an error row so the run carries on.
 */
export async function lookupCards(cards, options, io) {
  const delayMs = Math.max(1000, options.delayMs || 1000);
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let first = true;

  async function call(path, body) {
    for (let attempt = 0; ; attempt++) {
      if (!first) await sleep(delayMs);
      first = false;
      try {
        return await io.fetchJson(path, body);
      } catch (err) {
        const retryable = err && (err.status === 429 || err.status >= 500);
        if (!retryable || attempt >= 3) throw err;
        await sleep(delayMs * 2 ** (attempt + 1));
      }
    }
  }

  const results = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (io.onProgress) io.onProgress(i, cards.length, card.name);
    try {
      const products = [];
      const size = 50;
      for (let from = 0, page = 0; page < 4; page++, from += size) {
        const res = await call('/api/catalog/search', {
          query: frontFace(card.name),
          context: null,
          filters: { productLineName: ['Magic: The Gathering'], availableItems: ['Exclude Out of Stock'] },
          from,
          size,
          sort: [{ field: 'in-stock-price-sort', order: 'asc' }],
        });
        const items = (res && res.products && res.products.items) || [];
        for (const item of items) if (nameMatches(card.name, item.name)) products.push(item);
        const total = (res && res.products && res.products.totalItems) || 0;
        if (items.length < size || from + size >= total) break;
      }

      const skusByProductId = {};
      for (let j = 0; j < products.length; j += 20) {
        const ids = products.slice(j, j + 20).map((p) => p.id).join(',');
        const res = await call(`/api/inventory/skus?productIds=${ids}`);
        for (const entry of res || []) skusByProductId[entry.productId] = entry.skus || [];
      }

      const { taken, short, rows } = allocate(card, products, skusByProductId, options);
      results.push({
        name: card.name, quantity: card.quantity, foil: !!card.foil, taken, rows,
        status: taken === 0 ? 'none' : short > 0 ? 'short' : 'ok',
      });
    } catch (err) {
      results.push({
        name: card.name, quantity: card.quantity, foil: !!card.foil, taken: 0, rows: [],
        status: 'error', error: String((err && err.message) || err),
      });
    }
  }
  if (io.onProgress) io.onProgress(cards.length, cards.length, null);
  return results;
}

const SNIPPET_FUNCTIONS = [conditionRank, frontFace, nameMatches, allocate, lookupCards];

/**
 * The whole paste-into-the-console script, with the card list baked in. It
 * talks only to whatever site it is pasted on, so one script serves every
 * store; the result names its origin and the import files it under the store
 * with that address.
 */
export function buildLookupScript(cards, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const list = cards.map((c) => ({ name: String(c.name), quantity: Math.max(1, c.quantity | 0), foil: !!c.foil }));
  return `(async () => {
${SNIPPET_FUNCTIONS.map((fn) => fn.toString()).join('\n\n')}

const CARDS = ${JSON.stringify(list)};
const OPTIONS = ${JSON.stringify(opts)};

const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;width:340px;padding:14px;background:#14161c;color:#e8e8ea;font:13px/1.4 system-ui,sans-serif;border:1px solid #444;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.5)';
const title = document.createElement('div');
title.style.cssText = 'font-weight:700;margin-bottom:6px';
title.textContent = 'Deck Lotus price check';
const status = document.createElement('div');
const button = document.createElement('button');
button.style.cssText = 'margin-top:10px;padding:6px 12px;cursor:pointer;display:none';
button.textContent = 'Copy results';
panel.append(title, status, button);
document.body.append(panel);

async function fetchJson(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit' }
    : { credentials: 'omit' });
  if (!res.ok) { const e = new Error('HTTP ' + res.status + ' ' + path.split('?')[0]); e.status = res.status; throw e; }
  return res.json();
}

const started = Date.now();
const cards = await lookupCards(CARDS, OPTIONS, {
  fetchJson,
  onProgress: (i, n, name) => {
    status.textContent = name ? 'Looking up ' + (i + 1) + ' of ' + n + ': ' + name : 'Done: ' + n + ' cards in ' + Math.round((Date.now() - started) / 1000) + 's';
  },
});
const result = { format: ${JSON.stringify(RESULT_FORMAT)}, version: ${RESULT_VERSION}, origin: location.origin, fetchedAt: new Date().toISOString(), options: OPTIONS, cards };
const text = JSON.stringify(result);
window.deckLotusResult = text;
const found = cards.filter((c) => c.taken > 0).length;
status.textContent += ' — ' + found + ' in stock. Press the button, then paste into Deck Lotus.';
button.style.display = '';
button.onclick = async () => {
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied!'; }
  catch { console.log(text); button.textContent = 'Copy failed — printed to the console'; }
};
console.log('Deck Lotus: results are also in window.deckLotusResult');
})();`;
}

/**
 * lookup.js for the browser extension (src/extension): the same lookup
 * functions, exposed as one global the extension calls inside a store tab.
 * Extensions may not run code fetched at runtime, so this is generated into
 * the extension's download rather than sent with each request.
 */
export function buildExtensionLookup() {
  return `// Generated from src/shared/localShop.js — do not edit by hand.
${SNIPPET_FUNCTIONS.map((fn) => fn.toString()).join('\n\n')}

globalThis.__deckLotusLookup = async (cards, options, onProgress) => {
  async function fetchJson(path, body) {
    const res = await fetch(path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit' }
      : { credentials: 'omit' });
    if (!res.ok) { const e = new Error('HTTP ' + res.status + ' ' + path.split('?')[0]); e.status = res.status; throw e; }
    return res.json();
  }
  const results = await lookupCards(cards, options, { fetchJson, onProgress });
  return { format: ${JSON.stringify(RESULT_FORMAT)}, version: ${RESULT_VERSION}, origin: location.origin,
    fetchedAt: new Date().toISOString(), options, cards: results };
};
`;
}

/**
 * Check and tidy a pasted result. Everything in it came from the clipboard,
 * so numbers are coerced, strings cut short and unknown fields dropped.
 * Throws with a message fit to show the user.
 */
export function parseLookupResult(input) {
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input); } catch { throw new Error('That is not the JSON the lookup script copies.'); }
  }
  if (!data || data.format !== RESULT_FORMAT || !Array.isArray(data.cards)) {
    throw new Error('That is not the JSON the lookup script copies.');
  }
  let origin;
  try { origin = new URL(data.origin).origin; } catch { throw new Error('The result does not say which store it came from.'); }
  const fetchedAt = new Date(data.fetchedAt);
  if (isNaN(fetchedAt)) throw new Error('The result has no fetch time.');

  const str = (v, n = 200) => String(v ?? '').slice(0, n);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const cards = data.cards.slice(0, 2000).map((c) => {
    const rows = (Array.isArray(c.rows) ? c.rows : []).slice(0, 50).map((r) => ({
      productId: num(r.productId),
      skuId: num(r.skuId),
      printing: str(r.printing),
      set: str(r.set),
      condition: str(r.condition, 40),
      isFoil: !!r.isFoil,
      price: Math.max(0, num(r.price)),
      qty: Math.max(0, Math.floor(num(r.qty))),
    })).filter((r) => r.qty > 0);
    const taken = rows.reduce((s, r) => s + r.qty, 0);
    const status = ['ok', 'short', 'none', 'error'].includes(c.status) ? c.status : (taken ? 'ok' : 'none');
    return {
      name: str(c.name), quantity: Math.max(1, Math.floor(num(c.quantity))), foil: !!c.foil,
      taken, rows, status, ...(c.error ? { error: str(c.error, 300) } : {}),
    };
  });
  return {
    format: RESULT_FORMAT, version: RESULT_VERSION, origin, fetchedAt: fetchedAt.toISOString(),
    options: {
      minCondition: CONDITIONS.includes(data.options?.minCondition) ? data.options.minCondition : DEFAULT_OPTIONS.minCondition,
      allowFoil: !!data.options?.allowFoil,
    },
    cards,
  };
}

const key = (name) => String(name || '').trim().toLowerCase();

/**
 * Where to buy each copy. `cards` is the shopping list ({ name, quantity,
 * onlineUnit }); `stores` is [{ id, name, result }] with parsed results.
 * Copies are pooled — every store's allocated copies plus unlimited online
 * copies at `onlineUnit` — and the cheapest `quantity` taken, a store winning
 * a tie. Online is per-card only: shipping and fees come from Mana Pool's
 * optimizer on the online remainder, which is why `online` is returned as a
 * list ready to send there.
 */
export function planPurchases(cards, stores) {
  const byStore = stores.map((s) => ({
    ...s,
    cardsByName: new Map((s.result?.cards || []).map((c) => [key(c.name), c])),
  }));
  const totals = Object.fromEntries(byStore.map((s) => [s.id, { copies: 0, cost: 0 }]));
  const online = [];
  const uncovered = [];
  let onlineEstimate = 0;

  const lines = cards.map((card) => {
    const pool = [];
    for (const s of byStore) {
      for (const row of s.cardsByName.get(key(card.name))?.rows || []) {
        for (let i = 0; i < row.qty; i++) pool.push({ source: s.id, price: row.price, row });
      }
    }
    pool.sort((a, b) => a.price - b.price);

    const picks = [];
    let left = card.quantity;
    for (const copy of pool) {
      if (left === 0) break;
      if (card.onlineUnit != null && copy.price > card.onlineUnit) break;
      const last = picks[picks.length - 1];
      if (last && last.source === copy.source && last.row === copy.row) last.qty++;
      else picks.push({ source: copy.source, price: copy.price, qty: 1, row: copy.row });
      totals[copy.source].copies++;
      totals[copy.source].cost += copy.price;
      left--;
    }
    if (left > 0) {
      if (card.onlineUnit != null) {
        picks.push({ source: 'online', price: card.onlineUnit, qty: left });
        online.push({ name: card.name, quantity: left });
        onlineEstimate += card.onlineUnit * left;
      } else {
        online.push({ name: card.name, quantity: left });
        uncovered.push({ name: card.name, quantity: left });
      }
    }
    return { name: card.name, quantity: card.quantity, picks };
  });

  for (const t of Object.values(totals)) t.cost = Math.round(t.cost * 100) / 100;
  return { lines, totals, online, onlineEstimate: Math.round(onlineEstimate * 100) / 100, uncovered };
}

/** What one store alone would charge for the list: covered copies and their cost. */
export function storeCoverage(cards, result) {
  const byName = new Map((result?.cards || []).map((c) => [key(c.name), c]));
  let copies = 0;
  let cost = 0;
  let needed = 0;
  for (const card of cards) {
    needed += card.quantity;
    let left = card.quantity;
    for (const row of byName.get(key(card.name))?.rows || []) {
      const qty = Math.min(row.qty, left);
      copies += qty;
      cost += qty * row.price;
      left -= qty;
    }
  }
  return { copies, needed, cost: Math.round(cost * 100) / 100 };
}

/** "2 Sol Ring" lines for pasting into Mana Pool's list import. */
export function toCardList(items) {
  return items.map((i) => `${i.quantity} ${i.name}`).join('\n');
}
