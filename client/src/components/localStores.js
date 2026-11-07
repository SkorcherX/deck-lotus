/**
 * Local store prices on the Shopping page.
 *
 * Stores with a TCGplayer Pro storefront refuse lookups from anything but a
 * browser on their own site, so the lookup is a script the user pastes into
 * the store's console (built server-side from src/shared/localShop.js). Its
 * JSON is pasted back here and filed by the store's address. This page then
 * compares the stores with each other and with the list's online price, and
 * hands whatever is cheaper online to the Mana Pool optimizer for a real
 * quote with shipping and fees.
 */
import api from '../services/api.js';
import { massEntryButton } from '../utils/manaPoolHandoff.js';
import { showToast, confirmDialog, popover } from '../utils/ui.js';
import { planPurchases, storeCoverage, toCardList, CONDITIONS } from '../../../src/shared/localShop.js';

const NOTICE_KEY = 'deckLotus.localStores.noticeSeen';
const OPTIONS_KEY = 'deckLotus.localStores.options';
// Printings picked by hand, by card id. Kept per browser: a preference about
// art, not part of the list itself.
const CHOICES_KEY = 'deckLotus.shopping.printings';

const IS_FIREFOX = /firefox/i.test(navigator.userAgent);

const CHROME_STEPS = `One-time setup in Chrome or Edge:
  <ol>
    <li><a href="/api/local-stores/extension.zip" download>Download the extension</a> and unzip it.</li>
    <li>Open <code>chrome://extensions</code>, turn on <strong>Developer mode</strong>, choose
      <strong>Load unpacked</strong> and pick the unzipped <code>deck-lotus-store-prices</code> folder.</li>
    <li>Back on this page, click the extension's icon and choose <strong>connect</strong>.</li>
  </ol>`;

// Release Firefox installs only add-ons Mozilla has signed. Unlisted signing
// is free and automatic, but it needs the user's own Mozilla account, so the
// page can only point the way; the temporary route works at once but is
// forgotten when Firefox restarts.
// The signed .xpi (src/extension-signed) installs straight from this link:
// Firefox recognises the type and offers to add it. No Mozilla account needed.
const FIREFOX_STEPS = `One-time setup in Firefox:
  <ol>
    <li><a href="/api/local-stores/extension.xpi">Install the extension</a> and choose <strong>Add</strong> when Firefox asks.</li>
    <li>Back on this page, click the extension's icon (in the puzzle-piece menu) and choose <strong>connect</strong>.
      Firefox asks to allow this site and tcgplayerpro.com.</li>
  </ol>`;

let stores = null;
// Stores are the household's (migration 053). Each user can hide one from
// their view or leave it visible but out of price checks; everything that
// runs, quotes or compares reads `active()`.
const visible = () => (stores || []).filter((s) => !s.hidden);
const active = () => visible().filter((s) => s.checking);
let getItems = () => [];
let remainderQuote = null;
// The browser extension, once its bridge on this page answers: { version }.
let extension = null;
// A run in progress: { storeIds, current, done, total, name, errors }.
let run = null;
// What went wrong in the last run. Kept on the page until dismissed or the
// next run: a toast is gone before a store's error can be read or copied.
let runErrors = [];
// Cheapest priced printing per card id, from /shopping/cheapest.
const cheapest = {};

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and blocked storage: the setting just isn't remembered.
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

const money = (n) => `$${(n || 0).toFixed(2)}`;

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Clipboard where the page is a secure context; a selectable box where it is not (plain-http LAN installs). */
async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    if (fallbackEl) fallbackEl.innerHTML = '';
    return true;
  } catch {
    if (fallbackEl) {
      fallbackEl.innerHTML = `<p class="local-stores-hint">Your browser would not copy from this page. Select all in the box below and copy it.</p>
        <textarea class="form-control local-stores-copybox" readonly rows="4"></textarea>`;
      const box = fallbackEl.querySelector('textarea');
      box.value = text;
      box.focus();
      box.select();
    }
    return false;
  }
}

// How much more per copy a store may charge than online and still win the
// split: a few cents over beats paying shipping and waiting for the post.
const DEFAULT_LOCAL_PREMIUM = 0.25;

function options() {
  const saved = readStorage(OPTIONS_KEY, {});
  const premium = Number(saved.localPremium);
  return {
    minCondition: CONDITIONS.includes(saved.minCondition) ? saved.minCondition : 'LP',
    allowFoil: !!saved.allowFoil,
    localPremium: Number.isFinite(premium) && premium >= 0 ? premium : DEFAULT_LOCAL_PREMIUM,
  };
}

const planFor = (items, quoted) => planPurchases(items, quoted, { localPremium: options().localPremium });

// What to put in each store's cart: skuId → copies, per store and lookup.
// Starts as the split's picks for that store; the ticks are the user's after
// that, until the store is looked up again.
const cartPicks = new Map();
// An add-to-cart in progress: { storeId, done, total, name }.
let cartRun = null;
// The last add-to-cart answer per store: { results, error, at }.
const cartOutcome = new Map();

function picksFor(store, items, plan) {
  const key = `${store.id}|${store.fetchedAt}|${items.map((i) => `${i.name}:${i.quantity}`).join(',')}`;
  let entry = cartPicks.get(store.id);
  if (!entry || entry.key !== key) {
    const picks = new Map();
    for (const line of plan.lines) {
      for (const p of line.picks) {
        if (p.source === store.id && p.row?.skuId) picks.set(p.row.skuId, (picks.get(p.row.skuId) || 0) + p.qty);
      }
    }
    entry = { key, picks };
    cartPicks.set(store.id, entry);
  }
  return entry.picks;
}

/** Every copy a store's lookup found for the list, one row per listing. */
function storeRows(store, items) {
  const rows = [];
  for (const card of items) {
    const entry = store.result.cards.find((c) => c.name.toLowerCase() === card.name.toLowerCase());
    for (const row of entry?.rows || []) {
      if (!row.skuId) continue;
      rows.push({ ...row, name: card.name, need: card.quantity, onlineUnit: card.onlineUnit });
    }
  }
  return rows;
}

/** Wire the section once. `itemsGetter` returns the list as the Mana Pool optimizer sees it. */
export function initLocalStores(itemsGetter) {
  // Online is priced the way a store is: the cheapest printing of the card,
  // not the one the deck names. A deck listing a Secret Lair Sol Ring would
  // otherwise quote $70 online against $1.64 on a store's shelf. The
  // optimizer quote for the online part asks for that same printing.
  getItems = () => itemsGetter().map((item) => {
    const chosen = readStorage(CHOICES_KEY, {})[item.cardId];
    const best = chosen || cheapest[item.cardId];
    if (!best) return item;
    return {
      ...item,
      // A pick with no price says so; it must not borrow another printing's.
      onlineUnit: chosen ? (chosen.price ?? null) : (best.price ?? item.onlineUnit),
      setCode: best.setCode,
      collectorNumber: best.collectorNumber,
      onlineSet: best.setCode,
      onlineImage: best.imageUrl || null,
      // A printing picked by hand is bought as that printing; otherwise Mana
      // Pool is free to substitute any printing it stocks.
      exactPrinting: !!chosen,
      chosenPrinting: !!chosen,
    };
  });
  const body = document.getElementById('local-stores-body');
  if (!body || body.dataset.wired) return;
  body.dataset.wired = '1';
  body.addEventListener('click', onClick);
  body.addEventListener('change', onChange);
  body.addEventListener('submit', onSubmit);
  window.addEventListener('message', onExtensionMessage);
  window.postMessage({ source: 'deck-lotus', type: 'ping' }, location.origin);
}

function storeName(id) {
  return stores?.find((s) => s.id === id)?.name || 'store';
}

function renderRun() {
  const el = document.getElementById('local-stores-run');
  if (!el) return;
  if (!run) {
    el.innerHTML = runErrors.length ? `
      <div class="local-stores-run-errors">
        <strong><i class="ph ph-warning"></i> Some stores could not be checked</strong>
        <ul>${runErrors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-action="dismiss-errors">Dismiss</button>` : '';
    return;
  }
  const step = run.total
    ? `card ${Math.min(run.done + 1, run.total)} of ${run.total}${run.name ? ` — ${escapeHtml(run.name)}` : ''}`
    : 'opening the store…';
  el.innerHTML = `<i class="ph ph-circle-notch"></i> Checking <strong>${escapeHtml(storeName(run.current))}</strong>: ${step}
    <span class="local-stores-hint">(store ${run.storeIds.indexOf(run.current) + 1} of ${run.storeIds.length}; a tab opens in the background)</span>
    <button type="button" class="btn btn-secondary btn-sm" data-action="cancel-run">Stop</button>`;
}

/** Messages from the extension's bridge script on this page. */
async function onExtensionMessage(event) {
  const msg = event.data;
  if (event.source !== window || msg?.source !== 'deck-lotus-extension') return;
  if (msg.type === 'ready') {
    if (!extension) {
      extension = { version: msg.version };
      if (stores) render();
    }
    return;
  }
  if (cartRun) {
    if (msg.type === 'busy') {
      showToast('The extension is busy in another tab — try again when it finishes', 'warning');
      cartRun = null;
      render();
    } else if (msg.type === 'progress' && msg.storeId === cartRun.storeId) {
      Object.assign(cartRun, { done: msg.done, total: msg.total, name: msg.name });
      render();
    } else if (msg.type === 'cart-result') {
      const id = cartRun.storeId;
      cartOutcome.set(id, msg.error ? { error: msg.error } : { results: msg.result?.results || [] });
      cartRun = null;
      render();
      if (msg.error) showToast(`Could not add to the cart at ${storeName(id)}`, 'error');
      else {
        const added = (msg.result?.results || []).reduce((n, r) => n + r.added, 0);
        showToast(`${added} cop${added === 1 ? 'y' : 'ies'} added — the store's cart is open in a new tab`);
      }
    }
    return;
  }
  if (!run) return;
  if (msg.type === 'busy') {
    showToast('The extension is already checking prices in another tab', 'warning');
    run = null;
    render();
    return;
  }
  if (msg.type === 'store-start') {
    Object.assign(run, { current: msg.storeId, done: 0, total: 0, name: null });
  } else if (msg.type === 'progress') {
    Object.assign(run, { done: msg.done, total: msg.total, name: msg.name });
  } else if (msg.type === 'store-result') {
    try {
      const store = await api.importLocalStoreResults(JSON.stringify(msg.result));
      stores = stores.map((s) => (s.id === store.id ? store : s));
      remainderQuote = null;
      render();
      if (compareEl?.offsetParent) paintCompare();
    } catch (err) {
      run.errors.push(`${storeName(msg.storeId)}: ${err.message}`);
    }
  } else if (msg.type === 'store-error') {
    run.errors.push(msg.error === 'needs-permission'
      ? `${storeName(msg.storeId)}: open the store, click the Deck Lotus extension icon and choose "Allow price checks on this store".`
      : `${storeName(msg.storeId)}: ${msg.error}`);
  } else if (msg.type === 'done') {
    runErrors = run.errors;
    run = null;
    render();
    if (runErrors.length) showToast(`${runErrors.length} store${runErrors.length === 1 ? '' : 's'} could not be checked`, 'error');
    else if (!msg.cancelled) showToast('Store prices updated');
    return;
  }
  renderRun();
}

function startRun(storeIds) {
  const cards = getItems().map(({ name, quantity }) => ({ name, quantity }));
  const list = stores.filter((s) => storeIds.includes(s.id)).map(({ id, name, baseUrl }) => ({ id, name, baseUrl }));
  run = { storeIds, current: list[0]?.id, done: 0, total: 0, name: null, errors: [] };
  runErrors = [];
  window.postMessage({ source: 'deck-lotus', type: 'run', stores: list, cards, options: { ...options(), delayMs: 1000 } }, location.origin);
  render();
}

/** The list as every tab prices it: cheapest or chosen printing applied. */
export function currentItems() {
  return getItems();
}

/** Called whenever the shopping list re-renders. */
/**
 * Stores and cheapest-printing prices for the current list. Shared by the
 * Local stores, Compare and TCGplayer tabs; each fetch happens once.
 */
async function ensureData() {
  const items = getItems();
  if (stores == null) stores = await api.getLocalStores();
  const missing = [...new Set(items.map((i) => i.cardId).filter((id) => id != null && !(id in cheapest)))];
  if (missing.length) {
    try {
      const found = await api.getCheapestPrintings(missing);
      // Unpriced cards are remembered as null, so they are not asked for again.
      for (const id of missing) cheapest[id] = found[id] || null;
    } catch {
      // The deck's own printing price stays as the estimate.
    }
  }
}

/** The Local stores tab. */
export async function refreshLocalStores() {
  const body = document.getElementById('local-stores-body');
  if (!body) return;
  if (!getItems().length) {
    body.innerHTML = '<div class="local-stores-hint">There is nothing on your list to price.</div>';
    return;
  }
  remainderQuote = null;
  try {
    await ensureData();
  } catch (err) {
    body.innerHTML = `<div class="local-stores-error">${escapeHtml(err.message)}</div>`;
    return;
  }
  render();
}

// The Compare tab, remembered so a finished store check can refresh it.
let compareEl = null;
let goVenue = () => {};
let compareQuote = null;

// A rough TCGplayer shipping figure. Their cart ships per seller and we
// cannot know how many sellers it will pick, so this guesses: about one
// package per two different cards, capped (Optimize consolidates big lists),
// at a typical small-seller rate. Calibrated on one real cart — 4 cards,
// 2 packages, $5.48 — so treat it as an order of magnitude, not a quote.
const TCG_SHIP_PER_PACKAGE = 2.75;
const TCG_MAX_PACKAGES = 6;
function tcgShippingEstimate(items) {
  return shippingForCards(items.filter((c) => c.onlineUnit != null).length);
}

function shippingForCards(distinct) {
  if (!distinct) return { packages: 0, cost: 0 };
  const packages = Math.min(TCG_MAX_PACKAGES, Math.ceil(distinct / 2));
  return { packages, cost: packages * TCG_SHIP_PER_PACKAGE };
}
// The list compareQuote was taken for, and the quote still running. The
// quote is a live optimizer call, so it runs once per list rather than on
// every repaint, and a changed list (new card, other printing) asks again.
let compareQuoteKey = null;
let compareQuoting = null;

/**
 * The Compare tab: one number per way of buying, side by side, each linking
 * to the tab that explains it. This is the question the page exists to
 * answer, so it is the first tab rather than a footnote under one of them.
 */
export async function renderCompare(el, onVenue) {
  if (!el) return;
  compareEl = el;
  if (onVenue) goVenue = onVenue;
  const items = getItems();
  if (!items.length) {
    el.innerHTML = '<div class="local-stores-hint">There is nothing on your list to price.</div>';
    return;
  }
  el.innerHTML = '<div class="local-stores-hint">Working it out…</div>';
  try {
    await ensureData();
  } catch (err) {
    el.innerHTML = `<div class="local-stores-error">${escapeHtml(err.message)}</div>`;
    return;
  }
  paintCompare();
  autoQuoteManaPool(items);
}

function cartKey(items) {
  return JSON.stringify(items.map(({ name, quantity, setCode, collectorNumber, exactPrinting }) => [name, quantity, setCode, collectorNumber, !!exactPrinting]));
}

/** Fetch the Mana Pool quote for the Compare tab without waiting for a click. */
async function autoQuoteManaPool(items, { force = false } = {}) {
  const key = cartKey(items);
  if (!force && (compareQuoting === key || (compareQuote && compareQuoteKey === key))) return;
  compareQuoting = key;
  compareQuote = null;
  paintCompare();
  const quote = await quoteOnManaPool(items);
  // A newer list started its own quote while this one ran; drop this answer.
  if (compareQuoting !== key) return;
  compareQuoting = null;
  compareQuote = quote;
  compareQuoteKey = key;
  paintCompare();
}

/** Market cost of the cards a Mana Pool quote could not stock, and how many have no price. */
function notStockedCost(items, names) {
  const wanted = new Set(names.map((n) => String(n).toLowerCase()));
  let cost = 0;
  let unpriced = 0;
  for (const c of items) {
    if (!wanted.has(c.name.toLowerCase())) continue;
    if (c.onlineUnit == null) unpriced++;
    else cost += c.onlineUnit * c.quantity;
  }
  return { cost, unpriced };
}

/** Shipping guess for the online part of a split: its priced cards only. */
function splitShipping(plan) {
  const unpriced = new Set(plan.uncovered.map((u) => u.name));
  return shippingForCards(plan.online.filter((o) => !unpriced.has(o.name)).length);
}

function paintCompare() {
  if (!compareEl) return;
  const items = getItems();
  const copies = items.reduce((n, c) => n + c.quantity, 0);
  const onlineTotal = items.reduce((n, c) => n + (c.onlineUnit ?? 0) * c.quantity, 0);
  const unpriced = items.filter((c) => c.onlineUnit == null).length;
  const quoted = active().filter((st) => st.result);
  const plan = planFor(items, quoted);
  const localSplit = quoted.reduce((n, st) => n + plan.totals[st.id].cost, 0);
  const t = compareQuote?.totals;
  const mpShort = compareQuote?.unavailable?.length || 0;
  const mpMissing = notStockedCost(items, compareQuote?.unavailable || []);

  // Every way of buying, as one shape. Only options covering the whole list
  // are ranked against each other: a store with one of four copies is cheap
  // because it is selling less, and colouring it "best" would say otherwise.
  const options = [
    {
      title: 'TCGplayer',
      tag: 'estimate',
      value: onlineTotal + tcgShippingEstimate(items).cost,
      note: `Market price ${money(onlineTotal)} + about ${money(tcgShippingEstimate(items).cost)} shipping · the real cart usually runs higher${unpriced ? ` · ${unpriced} unpriced` : ''}`,
      complete: !unpriced,
      venue: 'tcgplayer',
    },
    {
      title: 'Mana Pool, delivered',
      tag: t && mpShort ? 'estimate' : undefined,
      // Cards Mana Pool has no seller for are priced at TCGplayer market, so
      // the figure covers the whole list instead of quietly leaving them out.
      value: t ? t.total_cents / 100 + mpMissing.cost : null,
      note: t ? `${t.seller_count ?? '?'} sellers, shipping and 4.2% singles fee included${mpShort
        ? ` · ${mpShort} not stocked, added at market (${money(mpMissing.cost)})`
        : ''}`
        : compareQuote?.error ? escapeHtml(compareQuote.error)
          : compareQuoting ? 'Getting a quote with shipping and fees…' : 'A real quote with shipping and fees',
      complete: !!t && !mpMissing.unpriced,
      venue: 'manapool',
      actions: t ? massEntryButton(compareQuote.massEntry, { primary: false })
        : compareQuoting ? '<span class="local-stores-hint"><i class="ph ph-circle-notch"></i> Quoting…</span>'
          : compareQuote?.error ? '<button type="button" class="btn btn-secondary btn-sm" data-compare-action="quote">Try again</button>' : '',
    },
    ...quoted.map((st) => {
      const cov = storeCoverage(items, st.result);
      const missing = items.filter((c) => !st.result.cards.some((r) => r.name.toLowerCase() === c.name.toLowerCase())).length;
      return {
        title: `${escapeHtml(st.name)} alone`,
        tag: 'pick up',
        value: cov.copies ? cov.cost : null,
        note: `${cov.copies} of ${cov.needed} copies · ${escapeHtml(ago(st.fetchedAt))}${missing ? ` · ${missing} not checked` : ''}`,
        complete: cov.copies === cov.needed,
        partial: cov.copies > 0 && cov.copies < cov.needed,
        // What the same copies would cost online: the fair yardstick for a
        // store that only has some of them.
        onlineForSame: onlineCostOfCovered(items, st.result),
        venue: 'local',
      };
    }),
    ...active().filter((st) => !st.result).map((st) => ({
      title: escapeHtml(st.name), tag: 'pick up', value: null, note: 'Prices not checked yet', venue: 'local',
    })),
  ];
  if (!active().length) {
    options.push({ title: 'Local stores', value: null, note: 'Add the stores near you to compare their shelves.', venue: 'local' });
  }
  // Only when a store actually supplies something: with no store copies the
  // split is the TCGplayer row again, and showing both read as a second,
  // cheaper way to buy the same cards. Its online part gets the same shipping
  // guess as the TCGplayer row, or skipping shipping alone would make it win.
  const storeCopies = quoted.reduce((n, st) => n + plan.totals[st.id].copies, 0);
  if (storeCopies) {
    const ship = splitShipping(plan);
    const onlineCopies = plan.online.reduce((n, i) => n + i.quantity, 0);
    options.push({
      title: 'Cheapest split',
      tag: 'stores + online',
      value: localSplit + plan.onlineEstimate + ship.cost,
      note: `Each copy wherever it is cheapest · ${storeCopies} from stores, ${onlineCopies} online${onlineCopies ? ` (incl. about ${money(ship.cost)} shipping)` : ''}`,
      complete: !plan.uncovered.length,
      venue: 'local',
    });
  }

  const ranked = options.filter((o) => o.complete && o.value != null);
  const best = ranked.length > 1 ? Math.min(...ranked.map((o) => o.value)) : null;

  const badge = (o) => {
    if (o.value == null) return '';
    if (o.partial) {
      const diff = o.onlineForSame - o.value;
      return diff >= 0.005
        ? `<span class="shop-badge is-good">Saves ${money(diff)} on these copies</span>`
        : `<span class="shop-badge is-bad">${money(-diff)} more than online for these</span>`;
    }
    if (!o.complete) return '';
    if (best != null && o.value === best) return '<span class="shop-badge is-best"><i class="ph ph-trophy"></i> Best price</span>';
    if (best != null) return `<span class="shop-badge is-bad">${money(o.value - best)} more</span>`;
    return '';
  };

  compareEl.innerHTML = `
    <p class="local-stores-hint" style="margin-top:0;">${copies} cop${copies === 1 ? 'y' : 'ies'} of ${items.length} card${items.length === 1 ? '' : 's'}.
      Options that cover the whole list are ranked; a store with only some of it shows what it saves on those copies.</p>
    <div class="shop-compare-grid">
      ${options.map((o) => `
        <div class="shop-compare-tile${best != null && o.complete && o.value === best ? ' is-best' : ''}${o.partial ? ' is-partial' : ''}">
          <div class="shop-compare-title" title="${o.title}">${o.title}</div>
          ${o.tag ? `<div class="shop-compare-tag">${o.tag}</div>` : ''}
          <div class="stat-value">${o.value != null ? money(o.value) : '—'}</div>
          <div class="shop-compare-note">${o.note}</div>
          ${badge(o)}
          <div class="shop-compare-actions">
            ${o.actions || ''}
            ${o.venue ? `<button type="button" class="btn btn-secondary btn-sm" data-compare-venue="${o.venue}">Details <i class="ph ph-arrow-right"></i></button>` : ''}
          </div>
        </div>`).join('')}
    </div>
  `;

  compareEl.querySelectorAll('[data-compare-venue]').forEach((btn) => {
    btn.addEventListener('click', () => goVenue(btn.dataset.compareVenue));
  });
  compareEl.querySelector('[data-compare-action="quote"]')?.addEventListener('click', () => {
    autoQuoteManaPool(items, { force: true });
  });
}

/** Online price of exactly the copies a store result covers. */
function onlineCostOfCovered(items, result) {
  let total = 0;
  for (const card of items) {
    const entry = result.cards.find((c) => c.name.toLowerCase() === card.name.toLowerCase());
    const had = Math.min(card.quantity, (entry?.rows || []).reduce((n, r) => n + r.qty, 0));
    total += had * (card.onlineUnit ?? 0);
  }
  return total;
}

/** A Mana Pool optimizer quote for some items, or `{ error }`. */
async function quoteOnManaPool(items) {
  const cart = items.map(({ name, quantity, setCode, collectorNumber, exactPrinting }) => ({ name, quantity, setCode, collectorNumber, exactPrinting }));
  try {
    return await api.manaPoolOptimize(cart, 'lowest_price');
  } catch (err) {
    return {
      error: err.message.includes('not configured')
        ? 'Mana Pool is not set up on this server'
        : err.message,
    };
  }
}

/**
 * The TCGplayer tab. Their API is closed to new developers, so this cannot
 * fetch live listings. It prices the list from the stored TCGplayer market
 * data and hands the list to TCGplayer's Mass Entry, which builds a cart on
 * their site.
 */
export async function renderTcgplayer(el) {
  if (!el) return;
  const items = getItems();
  if (!items.length) {
    el.innerHTML = '<div class="local-stores-hint">There is nothing on your list to price.</div>';
    return;
  }
  try {
    await ensureData();
  } catch {
    // Prices fall back to the deck's own printings.
  }
  const list = getItems();
  const total = list.reduce((n, c) => n + (c.onlineUnit ?? 0) * c.quantity, 0);
  const ship = tcgShippingEstimate(list);
  const lines = list.map((c) => `${c.quantity} ${c.name}`);
  const massEntry = `https://www.tcgplayer.com/massentry?productline=Magic&c=${encodeURIComponent(lines.join('||'))}`;

  el.innerHTML = `
    <p class="local-stores-hint" style="margin-top:0;">TCGplayer has no public API for live listings or carts, so
      this is an estimate: their <strong>market price</strong> (an average of recent sales, from the daily price
      update) at the cheapest printing of each card, plus a rough shipping guess.</p>
    <div class="local-stores-options">
      <span class="stat-value">${money(total + ship.cost)}</span>
      <span class="local-stores-hint">market estimate: ${money(total)} in cards + about ${money(ship.cost)} shipping
        (${ship.packages} package${ship.packages === 1 ? '' : 's'} guessed)</span>
    </div>
    <p class="local-stores-hint">Expect the Mass Entry cart to come in somewhat higher. It buys current listings
      (Near Mint and Lightly Played by default), which for cheap cards usually sit above the market average, and
      every seller in the cart ships separately. Its Optimize button can bring the total back down.</p>
    <div class="local-stores-options">
      <a class="btn btn-primary btn-sm" href="${escapeHtml(massEntry)}" target="_blank" rel="noopener">
        <i class="ph ph-arrow-square-out"></i> Open in TCGplayer Mass Entry
      </a>
      <button type="button" class="btn btn-secondary btn-sm" data-tcg-copy><i class="ph ph-copy"></i> Copy list</button>
    </div>
    <p class="local-stores-hint">Mass Entry finds sellers for the whole list on TCGplayer. If it opens empty, paste the
      copied list into its box. Hover a printing to see its art; click it to pick a different one.</p>
    <div data-slot="tcg-fallback"></div>
    <div class="analytics-table-wrap">
      <table class="analytics-table">
        <thead><tr><th>Card</th><th class="num">Qty</th><th>Printing</th><th class="num">Est.</th></tr></thead>
        <tbody>
          ${list.map((c) => `<tr>
            <td>${escapeHtml(c.name)}</td>
            <td class="num">${c.quantity}</td>
            <td>${c.cardId != null ? `<button type="button" class="shop-printing" data-pick-printing="${c.cardId}"
                data-card-name="${escapeHtml(c.name)}" ${c.onlineImage ? `data-art="${escapeHtml(c.onlineImage)}"` : ''}
                title="Change printing">
                ${c.onlineSet ? `${escapeHtml(c.onlineSet.toUpperCase())} #${escapeHtml(c.collectorNumber)}` : 'as listed'}
                ${c.chosenPrinting ? '<span class="shop-printing-chosen">chosen</span>' : ''}
                <i class="ph ph-caret-down"></i>
              </button>` : '<span class="local-stores-hint">as listed</span>'}</td>
            <td class="num">${c.onlineUnit != null ? money(c.onlineUnit * c.quantity) : '<span class="local-stores-hint">no price</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  el.querySelector('[data-tcg-copy]').addEventListener('click', async () => {
    if (await copyText(lines.join('\n'), el.querySelector('[data-slot="tcg-fallback"]'))) showToast('List copied');
  });
  el.querySelectorAll('[data-pick-printing]').forEach((btn) => {
    btn.addEventListener('click', () => openPrintingPicker(btn, () => renderTcgplayer(el)));
  });
}

/**
 * Pick which printing of a card to buy, by its art. "Cheapest" (the default)
 * lets every price quote substitute any printing; a pick is quoted and sent
 * to Mana Pool as exactly that printing.
 */
async function openPrintingPicker(anchor, onChange) {
  const cardId = Number(anchor.dataset.pickPrinting);
  const box = document.createElement('div');
  box.className = 'shop-printing-picker';
  box.innerHTML = '<div class="local-stores-hint" style="padding:0.5rem;">Loading printings…</div>';
  const { close } = popover(anchor, box);

  let printings;
  try {
    printings = await api.getPrintingChoices(cardId);
  } catch (err) {
    box.innerHTML = `<div class="local-stores-error" style="padding:0.5rem;">${escapeHtml(err.message)}</div>`;
    return;
  }
  const chosen = readStorage(CHOICES_KEY, {})[cardId];
  box.innerHTML = `
    <div class="shop-printing-head">${escapeHtml(anchor.dataset.cardName)}</div>
    <button type="button" class="shop-printing-option ${chosen ? '' : 'is-current'}" data-choice="">
      <span class="shop-printing-thumb shop-printing-any"><i class="ph ph-shuffle"></i></span>
      <span><strong>Cheapest available</strong><br><span class="local-stores-hint">Any printing; Mana Pool may substitute</span></span>
    </button>
    ${printings.map((pr, i) => `
      <button type="button" class="shop-printing-option ${chosen?.printingId === pr.printingId ? 'is-current' : ''}" data-choice="${i}"
        ${pr.imageUrl ? `data-art="${escapeHtml(pr.imageUrl)}"` : ''}>
        ${pr.imageUrl ? `<img class="shop-printing-thumb" src="${escapeHtml(pr.imageUrl)}" alt="" loading="lazy">` : '<span class="shop-printing-thumb"></span>'}
        <span class="shop-printing-text">
          <strong>${escapeHtml(pr.setName || pr.setCode)}</strong>
          <span class="local-stores-hint">${escapeHtml(String(pr.setCode).toUpperCase())} #${escapeHtml(pr.collectorNumber)}${pr.releaseDate ? ` · ${escapeHtml(pr.releaseDate.slice(0, 4))}` : ''}</span>
        </span>
        <span class="shop-printing-price">${pr.price != null ? money(pr.price) : '<span class="local-stores-hint">no price</span>'}</span>
      </button>`).join('')}
  `;
  box.querySelectorAll('[data-choice]').forEach((option) => {
    option.addEventListener('click', () => {
      const all = readStorage(CHOICES_KEY, {});
      if (option.dataset.choice === '') delete all[cardId];
      else all[cardId] = printings[Number(option.dataset.choice)];
      writeStorage(CHOICES_KEY, all);
      // Quotes built on the old printing no longer describe the list.
      compareQuote = null;
      remainderQuote = null;
      hideArt();
      close();
      onChange();
    });
  });
}

// One floating preview for every [data-art] element: hover a printing, see
// the card. Pointer-only; on touch the picker's thumbnails do the job.
let artEl = null;
function showArt(src, x, y) {
  if (!artEl) {
    artEl = document.createElement('img');
    artEl.className = 'shop-art-preview';
    artEl.alt = '';
    document.body.append(artEl);
  }
  if (artEl.getAttribute('src') !== src) artEl.src = src;
  const w = 244;
  const h = 340;
  const left = x + 18 + w > window.innerWidth ? x - w - 18 : x + 18;
  const top = Math.min(Math.max(8, y - h / 2), window.innerHeight - h - 8);
  artEl.style.left = `${Math.max(8, left)}px`;
  artEl.style.top = `${top}px`;
  artEl.classList.add('is-visible');
}
function hideArt() {
  artEl?.classList.remove('is-visible');
}
document.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const target = e.target.closest?.('[data-art]');
  if (target) showArt(target.dataset.art, e.clientX, e.clientY);
  else hideArt();
});
document.addEventListener('scroll', hideArt, true);

function render() {
  const body = document.getElementById('local-stores-body');
  const items = getItems();
  const opts = options();
  const noticeSeen = readStorage(NOTICE_KEY, false);

  body.innerHTML = `
    ${noticeSeen ? '' : `
      <div class="local-stores-notice">
        <i class="ph ph-info"></i>
        <div>
          <strong>Before your first lookup.</strong> Prices are looked up on the store's own site, one card a
          second, from your browser. A price check never adds to a cart — only the "Add to cart" button
          does, with the copies you tick — and Deck Lotus never contacts the store itself. Check the store's terms of use if you are unsure they are happy with it.
          <div><button type="button" class="btn btn-secondary btn-sm" data-action="ack-notice">Got it</button></div>
        </div>
      </div>`}

    <div class="local-stores-list">
      ${visible().map((s) => `
        <div class="local-stores-store${s.checking ? '' : ' local-stores-off'}">
          <input type="checkbox" data-action="toggle-checking" data-id="${s.id}" ${s.checking ? 'checked' : ''}
                 title="Include this store in price checks and comparisons" aria-label="Price-check ${escapeHtml(s.name)}">
          <div>
            <a href="${escapeHtml(s.baseUrl)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(s.name)}</strong>
              <i class="ph ph-arrow-square-out"></i></a>
            <div class="local-stores-hint">${s.fetchedAt ? `Prices from ${escapeHtml(ago(s.fetchedAt))}` : 'Not looked up yet'}${s.addedBy ? ` · added by ${escapeHtml(s.addedBy)}` : ''}</div>
          </div>
          ${extension ? `<button type="button" class="btn btn-secondary btn-sm" data-action="run-one" data-id="${s.id}" ${run || !s.checking ? 'disabled' : ''} title="Check prices at this store">
            <i class="ph ph-arrows-clockwise"></i></button>` : ''}
          <button type="button" class="btn btn-secondary btn-sm" data-action="remove-store" data-id="${s.id}" title="Remove from your list (others in the household keep it)">
            <i class="ph ph-trash"></i>
          </button>
        </div>`).join('') || '<div class="local-stores-hint">Add a store that sells through a TCGplayer Pro storefront. Stores you add are shared with everyone in the household.</div>'}
      ${(stores || []).some((s) => s.hidden) ? `
        <details class="local-stores-hidden">
          <summary class="local-stores-hint">${(stores || []).filter((s) => s.hidden).length} hidden store(s)</summary>
          ${(stores || []).filter((s) => s.hidden).map((s) => `
            <div class="local-stores-store">
              <div><strong>${escapeHtml(s.name)}</strong></div>
              <button type="button" class="btn btn-secondary btn-sm" data-action="unhide-store" data-id="${s.id}">Show again</button>
            </div>`).join('')}
        </details>` : ''}
    </div>

    <form class="local-stores-add" data-form="add-store">
      <input class="form-control" name="name" placeholder="Store name" maxlength="100" required>
      <input class="form-control" name="baseUrl" placeholder="https://yourstore.tcgplayerpro.com" required>
      <button type="submit" class="btn btn-secondary btn-sm"><i class="ph ph-plus"></i> Add store</button>
    </form>

    ${active().length ? `
      <div class="local-stores-steps">
        <div class="local-stores-options">
          <label>Worst condition
            <select class="form-control" data-option="minCondition">
              ${CONDITIONS.map((c) => `<option value="${c}" ${c === opts.minCondition ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </label>
          <label><input type="checkbox" data-option="allowFoil" ${opts.allowFoil ? 'checked' : ''}> Foils are fine</label>
          <label title="A store copy up to this much dearer than online still goes to the store in the split, to save shipping">Buy local if within $
            <input type="number" class="input-narrow" data-option="localPremium" min="0" step="0.05" value="${opts.localPremium}"> a copy
          </label>
          ${extension ? `
            <button type="button" class="btn btn-primary btn-sm" data-action="run-all" ${run ? 'disabled' : ''}>
              <i class="ph ph-storefront"></i> Check prices at ${active().length === 1 ? escapeHtml(active()[0].name) : `all ${active().length} stores`} (${items.length} cards)
            </button>` : ''}
        </div>
        <div id="local-stores-run" class="local-stores-run"></div>
        ${extension ? `
          <p class="local-stores-hint">About a second per card per store. Keep this page open while it runs.</p>` : `
          <div class="local-stores-notice">
            <i class="ph ph-puzzle-piece"></i>
            <div>
              <strong>Install the Deck Lotus browser extension to check prices with one click.</strong>
              Stores only answer price lookups from a browser on their own site, so the extension opens each store
              in a background tab and looks the cards up there.
              ${IS_FIREFOX ? FIREFOX_STEPS : CHROME_STEPS}
              Stores on <code>tcgplayerpro.com</code> are allowed when you connect. For a store on its own domain,
              open it once and choose "Allow price checks on this store" in the extension.
              <div class="local-stores-hint">Using ${IS_FIREFOX ? 'Chrome or Edge' : 'Firefox'} instead?
                ${IS_FIREFOX
                  ? '<a href="/api/local-stores/extension.zip" download>Download that version</a>'
                  : '<a href="/api/local-stores/extension.xpi">Install the Firefox version</a> (open the link in Firefox)'}.</div>
            </div>
          </div>`}
        <details class="local-stores-manual">
          <summary class="local-stores-hint">Or run the lookup by hand in the store's console</summary>
          <div class="local-stores-options">
            <button type="button" class="btn btn-secondary btn-sm" data-action="copy-script">
              <i class="ph ph-copy"></i> Copy lookup script
            </button>
          </div>
          <div data-slot="script-fallback"></div>
          <ol class="local-stores-hint">
            <li>Open a store above, press F12 and choose <strong>Console</strong>.</li>
            <li>Paste the script and press Enter. The first time, Chrome asks you to type <code>allow pasting</code>.</li>
            <li>When it finishes, press <strong>Copy results</strong> on the panel it shows, and paste them here.</li>
          </ol>
          <form class="local-stores-paste" data-form="import">
            <textarea class="form-control" name="result" rows="2" placeholder="Paste results here"></textarea>
            <button type="submit" class="btn btn-secondary btn-sm"><i class="ph ph-upload-simple"></i> Import results</button>
          </form>
        </details>
      </div>` : ''}

    <div data-slot="comparison">${renderComparison(items)}</div>
  `;
  renderRun();
}

function cellFor(card, result) {
  const entry = result?.cards.find((c) => c.name.toLowerCase() === card.name.toLowerCase());
  if (!entry) return { html: '<span class="local-stores-hint" title="Not in this lookup — run it again">—</span>', cost: null };
  if (entry.status === 'error') return { html: `<span class="local-stores-error" title="${escapeHtml(entry.error)}">error</span>`, cost: null };
  let left = card.quantity;
  let cost = 0;
  const detail = [];
  for (const row of entry.rows) {
    const qty = Math.min(row.qty, left);
    if (!qty) break;
    left -= qty;
    cost += qty * row.price;
    detail.push(`${qty}× ${row.printing} — ${row.set}, ${row.condition}${row.isFoil ? ' foil' : ''} @ ${money(row.price)}`);
  }
  const got = card.quantity - left;
  if (!got) return { html: '<span class="local-stores-hint">none</span>', cost: null };
  return {
    html: `<span title="${escapeHtml(detail.join('\n'))}">${money(cost)}${left ? ` <small class="local-stores-short">${got}/${card.quantity}</small>` : ''}</span>`,
    cost: left ? null : cost,
  };
}

function renderComparison(items) {
  const quoted = active().filter((s) => s.result);
  if (!quoted.length) return '';

  const plan = planFor(items, quoted);
  const onlineTotal = items.reduce((s, c) => s + (c.onlineUnit ?? 0) * c.quantity, 0);
  const unpricedOnline = items.filter((c) => c.onlineUnit == null).length;
  const localSplit = quoted.reduce((s, st) => s + plan.totals[st.id].cost, 0);

  const rows = items.map((card) => {
    const cells = quoted.map((s) => cellFor(card, s.result));
    const online = card.onlineUnit != null ? card.onlineUnit * card.quantity : null;
    const best = Math.min(...[...cells.map((c) => c.cost), online].filter((v) => v != null));
    const mark = (v, html) => `<td class="num${v != null && v === best ? ' local-stores-best' : ''}">${html}</td>`;
    return `<tr>
      <td>${escapeHtml(card.name)}</td>
      <td class="num">${card.quantity}</td>
      ${cells.map((c) => mark(c.cost, c.html)).join('')}
      ${mark(online, online != null
        ? `<span ${card.onlineImage ? `data-art="${escapeHtml(card.onlineImage)}"` : ''} title="${escapeHtml(card.onlineSet ? `${card.chosenPrinting ? 'Chosen' : 'Cheapest'} printing: ${card.onlineSet.toUpperCase()} #${card.collectorNumber}` : 'The printing your deck lists')}">${money(online)}</span>`
        : '<span class="local-stores-hint">no price</span>')}
    </tr>`;
  }).join('');

  return `
    <div class="local-stores-summary">
      ${quoted.map((s) => {
        const cov = storeCoverage(items, s.result);
        return `<div class="local-stores-tile">
          <div class="local-stores-hint">${escapeHtml(s.name)} alone</div>
          <div class="stat-value">${money(cov.cost)}</div>
          <div class="local-stores-hint">${cov.copies} of ${cov.needed} copies · ${escapeHtml(ago(s.fetchedAt))}</div>
          <button type="button" class="btn btn-secondary btn-sm" data-action="clear-result" data-id="${s.id}">Clear prices</button>
        </div>`;
      }).join('')}
      <div class="local-stores-tile">
        <div class="local-stores-hint">All online (estimate)</div>
        <div class="stat-value">${money(onlineTotal)}</div>
        <div class="local-stores-hint">Cheapest printing, TCGplayer market, before shipping${unpricedOnline ? ` · ${unpricedOnline} unpriced` : ''}</div>
      </div>
    </div>

    <div class="local-stores-plan">
      <h4>Cheapest split</h4>
      <ul>
        ${quoted.filter((s) => plan.totals[s.id].copies).map((s) => `
          <li><strong>${escapeHtml(s.name)}</strong> (pick up): ${plan.totals[s.id].copies} copies, ${money(plan.totals[s.id].cost)}</li>`).join('')}
        <li><strong>Online</strong>: ${plan.online.reduce((n, i) => n + i.quantity, 0)} copies,
          about ${money(plan.onlineEstimate)} + about ${money(splitShipping(plan).cost)} shipping${plan.uncovered.length ? ` (${plan.uncovered.length} cards with no price)` : ''}</li>
      </ul>
      ${plan.online.length ? `
        <div class="local-stores-options">
          <button type="button" class="btn btn-primary btn-sm" data-action="quote-remainder"><i class="ph ph-magic-wand"></i> Quote the online part on Mana Pool</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="copy-remainder"><i class="ph ph-copy"></i> Copy online part as a list</button>
        </div>
        <div data-slot="remainder-fallback"></div>
        <div data-slot="remainder-quote">${renderRemainderQuote(localSplit)}</div>` : `
        <div class="local-stores-hint">Everything is cheapest locally — ${money(localSplit)} in all.</div>`}
      <p class="local-stores-hint">Each copy goes wherever it is cheapest, comparing store prices with the online
        price per card — except that a store copy up to ${money(options().localPremium)} dearer still goes to the
        store, since buying it there saves shipping and waiting. Check the quote: a few cheap cards online may
        cost more to ship than to buy in store.</p>
    </div>

    ${quoted.map((s) => renderStoreCart(s, items, plan)).join('')}

    <div class="analytics-table-wrap">
      <table class="analytics-table">
        <thead><tr><th>Card</th><th class="num">Need</th>
          ${quoted.map((s) => `<th class="num">${escapeHtml(s.name)}</th>`).join('')}<th class="num" title="Cheapest printing at TCGplayer market price">Online est.</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="local-stores-hint">Hover a store price to see the printings and conditions it is made of.
      Store prices are a snapshot from when the script ran.</p>
  `;
}

/**
 * One store's "buy here" list: every copy its lookup found, ticked where the
 * split sends it to this store. The user changes the ticks — a card a dime
 * dearer than online is often worth buying here anyway — and the button puts
 * exactly the ticked copies in the store's cart through the extension.
 */
function renderStoreCart(store, items, plan) {
  const rows = storeRows(store, items);
  if (!rows.length) return '';
  const picks = picksFor(store, items, plan);
  const outcome = cartOutcome.get(store.id);
  const busy = cartRun?.storeId === store.id;

  return `
    <details class="local-stores-cart" data-cart-store="${store.id}" ${picks.size || outcome ? 'open' : ''}>
      <summary><strong>Buy at ${escapeHtml(store.name)}</strong>
        <span class="local-stores-hint">— ${rows.length} listing${rows.length === 1 ? '' : 's'} found; ticked ones go in the cart</span></summary>
      <div class="local-stores-options">
        <button type="button" class="btn btn-secondary btn-sm" data-action="cart-select" data-id="${store.id}" data-which="plan">Cheapest split's picks</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="cart-select" data-id="${store.id}" data-which="all">Everything here</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="cart-select" data-id="${store.id}" data-which="none">None</button>
      </div>
      <div class="analytics-table-wrap">
        <table class="analytics-table">
          <thead><tr><th></th><th>Card</th><th>Listing</th><th class="num">Each</th><th class="num" title="Store price minus the online estimate, per copy">vs online</th><th class="num">Copies</th></tr></thead>
          <tbody>
            ${rows.map((r) => {
              const qty = picks.get(r.skuId) || 0;
              const diff = r.onlineUnit != null ? r.price - r.onlineUnit : null;
              return `<tr>
                <td><input type="checkbox" data-cart-tick data-sku="${r.skuId}" ${qty ? 'checked' : ''} aria-label="Buy ${escapeHtml(r.name)} here"></td>
                <td>${escapeHtml(r.name)}${r.need > 1 ? ` <span class="local-stores-hint">(need ${r.need})</span>` : ''}</td>
                <td class="local-stores-hint">${escapeHtml(r.set)} · ${escapeHtml(r.condition)}${r.isFoil ? ' foil' : ''}</td>
                <td class="num">${money(r.price)}</td>
                <td class="num">${diff == null ? '<span class="local-stores-hint">—</span>'
                  : `<span class="${diff > 0.005 ? 'local-stores-short' : 'local-stores-best'}">${diff > 0 ? '+' : diff < 0 ? '−' : ''}${money(Math.abs(diff))}</span>`}</td>
                <td class="num"><input type="number" class="input-narrow" data-cart-qty data-sku="${r.skuId}" min="1" max="${r.qty}"
                  value="${qty || Math.min(r.qty, r.need)}" ${qty ? '' : 'disabled'} aria-label="Copies of ${escapeHtml(r.name)}">
                  <span class="local-stores-hint">/ ${r.qty}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="local-stores-options">
        <span data-cart-total>${cartTotalText(store, rows, picks)}</span>
        ${extension ? `<button type="button" class="btn btn-primary btn-sm" data-action="add-to-cart" data-id="${store.id}" ${cartRun || run || !picks.size ? 'disabled' : ''}>
            <i class="ph ph-shopping-cart"></i> ${busy ? 'Adding…' : `Add to cart at ${escapeHtml(store.name)}`}</button>`
          : '<span class="local-stores-hint">Install the extension above to add these to the store\'s cart.</span>'}
      </div>
      ${busy ? `<div class="local-stores-run"><i class="ph ph-circle-notch"></i> ${cartRun.total
        ? `Adding ${Math.min(cartRun.done + 1, cartRun.total)} of ${cartRun.total}${cartRun.name ? ` — ${escapeHtml(cartRun.name)}` : ''}`
        : 'Opening the store…'}</div>` : ''}
      ${outcome ? renderCartOutcome(store, outcome) : ''}
      <p class="local-stores-hint">The extension opens ${escapeHtml(store.name)}, adds the ticked copies to your cart there and
        leaves the cart open for you to review. It never checks out. Stock is re-checked as it adds, so a card sold since
        the lookup is reported rather than added.</p>
    </details>`;
}

function cartTotalText(store, rows, picks) {
  let copies = 0;
  let cost = 0;
  for (const r of rows) {
    const q = picks.get(r.skuId) || 0;
    copies += q;
    cost += q * r.price;
  }
  return copies
    ? `<strong>${copies} cop${copies === 1 ? 'y' : 'ies'}, ${money(cost)}</strong> <span class="local-stores-hint">at lookup prices</span>`
    : '<span class="local-stores-hint">Nothing ticked.</span>';
}

function renderCartOutcome(store, outcome) {
  if (outcome.error) {
    return `<div class="local-stores-error">${escapeHtml(outcome.error === 'needs-permission'
      ? `Open ${store.name}, click the Deck Lotus extension icon and choose "Allow price checks on this store".`
      : outcome.error)}</div>`;
  }
  const res = outcome.results;
  const added = res.reduce((n, r) => n + r.added, 0);
  const wanted = res.reduce((n, r) => n + r.wanted, 0);
  const problems = res.filter((r) => r.status !== 'added');
  const repriced = res.filter((r) => r.added && r.price != null && Math.abs(r.price - r.was) >= 0.005);
  return `
    <div class="${problems.length ? 'local-stores-run-errors' : 'local-stores-hint'}">
      <strong>${added} of ${wanted} cop${wanted === 1 ? 'y' : 'ies'} added to the cart at ${escapeHtml(store.name)}</strong>
      ${problems.length ? `<ul>${problems.map((r) => `<li>${escapeHtml(r.name)}: ${r.status === 'gone'
        ? 'no longer in stock'
        : r.status === 'partial' ? `only ${r.added} of ${r.wanted} left` : escapeHtml(r.error || 'could not be added')}</li>`).join('')}</ul>` : ''}
      ${repriced.length ? `<div>Price changed since the lookup: ${repriced.map((r) => `${escapeHtml(r.name)} ${money(r.was)} → ${money(r.price)}`).join(', ')}</div>` : ''}
    </div>`;
}

function startCart(storeId) {
  const store = stores.find((s) => s.id === storeId);
  const items = getItems();
  const picks = cartPicks.get(storeId)?.picks || new Map();
  const list = storeRows(store, items)
    .filter((r) => picks.get(r.skuId))
    .map((r) => ({ name: r.name, productId: r.productId, skuId: r.skuId, qty: picks.get(r.skuId), price: r.price }));
  if (!list.length) return;
  cartRun = { storeId, done: 0, total: 0, name: null };
  cartOutcome.delete(storeId);
  window.postMessage({ source: 'deck-lotus', type: 'cart', store: { id: store.id, name: store.name, baseUrl: store.baseUrl }, items: list }, location.origin);
  render();
}

function renderRemainderQuote(localSplit) {
  if (!remainderQuote) return '';
  if (remainderQuote.error) return `<div class="local-stores-error">${escapeHtml(remainderQuote.error)}</div>`;
  const t = remainderQuote.totals;
  const cents = (c) => money((c || 0) / 100);
  return `
    <table class="analytics-table local-stores-quote">
      ${t ? `
        <tr><td>Mana Pool subtotal</td><td class="num">${cents(t.subtotal_cents)}</td></tr>
        <tr><td>Shipping (${t.seller_count ?? '?'} sellers)</td><td class="num">${cents(t.shipping_cents)}</td></tr>
        ${t.buyer_fee_cents ? `<tr><td title="Mana Pool charges buyers 4.2% on single cards">Singles fee (4.2%)${t.fee_estimated ? ' · est.' : ''}</td><td class="num">${cents(t.buyer_fee_cents)}</td></tr>` : ''}
        <tr><td><strong>Mana Pool total</strong></td><td class="num"><strong>${cents(t.total_cents)}</strong></td></tr>
        <tr><td>Local pickups</td><td class="num">${money(localSplit)}</td></tr>
        <tr><td><strong>Everything</strong></td><td class="num"><strong>${money(localSplit + (t.total_cents || 0) / 100)}</strong></td></tr>` : ''}
    </table>
    ${remainderQuote.unavailable?.length ? `<div class="local-stores-error">No Mana Pool seller for: ${escapeHtml(remainderQuote.unavailable.join(', '))}</div>` : ''}
    ${t ? massEntryButton(remainderQuote.massEntry, { label: 'Buy the online part on Mana Pool' }) : ''}
  `;
}

function currentPlan() {
  const items = getItems();
  return { items, plan: planFor(items, active().filter((s) => s.result)) };
}

async function onClick(event) {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const body = document.getElementById('local-stores-body');
  const action = el.dataset.action;

  if (action === 'add-to-cart') {
    startCart(Number(el.dataset.id));
  } else if (action === 'cart-select') {
    const store = stores.find((s) => s.id === Number(el.dataset.id));
    const { items, plan } = currentPlan();
    picksFor(store, items, plan);
    const entry = cartPicks.get(store.id);
    if (el.dataset.which === 'plan') {
      cartPicks.delete(store.id);
    } else {
      entry.picks = new Map();
      if (el.dataset.which === 'all') {
        // Up to what each card needs, cheapest listing first (the lookup's order).
        const left = new Map(items.map((i) => [i.name.toLowerCase(), i.quantity]));
        for (const r of storeRows(store, items)) {
          const k = r.name.toLowerCase();
          const q = Math.min(r.qty, left.get(k) || 0);
          if (q) entry.picks.set(r.skuId, q);
          left.set(k, (left.get(k) || 0) - q);
        }
      }
    }
    render();
  } else if (action === 'run-all') {
    startRun(active().map((s) => s.id));
  } else if (action === 'run-one') {
    startRun([Number(el.dataset.id)]);
  } else if (action === 'cancel-run') {
    window.postMessage({ source: 'deck-lotus', type: 'cancel' }, location.origin);
  } else if (action === 'dismiss-errors') {
    runErrors = [];
    renderRun();
  } else if (action === 'ack-notice') {
    writeStorage(NOTICE_KEY, true);
    render();
  } else if (action === 'remove-store') {
    const store = stores.find((s) => s.id === Number(el.dataset.id));
    const ok = await confirmDialog({
      title: 'Remove store?',
      message: `${store.name} and your last price lookup there come off your list. Everyone else in the household keeps it, and you can show it again later.`,
      confirmText: 'Remove', danger: true,
    });
    if (!ok) return;
    await api.deleteLocalStore(store.id);
    stores = stores.map((s) => (s.id === store.id ? { ...s, hidden: true, result: null, fetchedAt: null } : s));
    render();
    paintCompare();
  } else if (action === 'unhide-store') {
    const store = await api.setLocalStorePrefs(Number(el.dataset.id), { hidden: false });
    stores = stores.map((s) => (s.id === store.id ? store : s));
    render();
    paintCompare();
  } else if (action === 'clear-result') {
    const id = Number(el.dataset.id);
    await api.clearLocalStoreResults(id);
    stores = stores.map((s) => (s.id === id ? { ...s, result: null, fetchedAt: null } : s));
    render();
  } else if (action === 'copy-script') {
    el.disabled = true;
    try {
      const cards = getItems().map(({ name, quantity }) => ({ name, quantity }));
      const { script } = await api.buildLocalStoreScript(cards, options());
      if (await copyText(script, body.querySelector('[data-slot="script-fallback"]'))) {
        showToast('Lookup script copied — paste it into a store\'s console');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      el.disabled = false;
    }
  } else if (action === 'copy-remainder') {
    const text = toCardList(currentPlan().plan.online);
    if (await copyText(text, body.querySelector('[data-slot="remainder-fallback"]'))) showToast('Online list copied');
  } else if (action === 'quote-remainder') {
    const { items, plan } = currentPlan();
    // The optimizer needs a set and number per card, which the plan does not
    // carry; the shopping list's own entry for the card supplies them.
    const byName = new Map(items.map((i) => [i.name.toLowerCase(), i]));
    const cart = plan.online.map((o) => {
      const item = byName.get(o.name.toLowerCase());
      return { name: o.name, quantity: o.quantity, setCode: item?.setCode, collectorNumber: item?.collectorNumber, exactPrinting: item?.exactPrinting };
    });
    el.disabled = true;
    el.innerHTML = '<i class="ph ph-circle-notch"></i> Quoting…';
    try {
      remainderQuote = await api.manaPoolOptimize(cart, 'lowest_price');
    } catch (err) {
      remainderQuote = { error: err.message.includes('not configured')
        ? 'Mana Pool is not configured — set MANAPOOL_USER_EMAIL and MANAPOOL_API_TOKEN on the server.'
        : err.message };
    }
    render();
  }
}

async function onChange(event) {
  const toggle = event.target.closest('[data-action="toggle-checking"]');
  if (toggle) {
    try {
      const store = await api.setLocalStorePrefs(Number(toggle.dataset.id), { checking: toggle.checked });
      stores = stores.map((s) => (s.id === store.id ? store : s));
    } catch (err) {
      showToast(err.message, 'error');
    }
    render();
    paintCompare();
    return;
  }
  const cartInput = event.target.closest('[data-cart-tick], [data-cart-qty]');
  if (cartInput) {
    const box = cartInput.closest('[data-cart-store]');
    const store = stores.find((s) => s.id === Number(box.dataset.cartStore));
    const { items, plan } = currentPlan();
    const picks = picksFor(store, items, plan);
    const sku = Number(cartInput.dataset.sku);
    const qtyInput = box.querySelector(`[data-cart-qty][data-sku="${sku}"]`);
    const tick = box.querySelector(`[data-cart-tick][data-sku="${sku}"]`);
    const max = Number(qtyInput.max) || 1;
    const qty = Math.min(max, Math.max(1, Math.floor(Number(qtyInput.value) || 1)));
    qtyInput.value = qty;
    qtyInput.disabled = !tick.checked;
    if (tick.checked) picks.set(sku, qty);
    else picks.delete(sku);
    box.querySelector('[data-cart-total]').innerHTML = cartTotalText(store, storeRows(store, items), picks);
    const btn = box.querySelector('[data-action="add-to-cart"]');
    if (btn) btn.disabled = !!(cartRun || run || !picks.size);
    return;
  }
  const el = event.target.closest('[data-option]');
  if (!el) return;
  const opts = options();
  opts[el.dataset.option] = el.type === 'checkbox' ? el.checked
    : el.type === 'number' ? Math.max(0, Number(el.value) || 0) : el.value;
  writeStorage(OPTIONS_KEY, opts);
  if (el.dataset.option === 'localPremium') {
    // The split, and the ticks it suggests, follow the new allowance.
    cartPicks.clear();
    remainderQuote = null;
    render();
    paintCompare();
  }
}

async function onSubmit(event) {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  try {
    if (form.dataset.form === 'add-store') {
      const store = await api.addLocalStore(data.get('name'), data.get('baseUrl'));
      const known = stores.some((s) => s.id === store.id);
      stores = known
        ? stores.map((s) => (s.id === store.id ? store : s))
        : [...stores, store].sort((a, b) => a.name.localeCompare(b.name));
      showToast(known ? `${store.name} was already shared in the household — it is back on your list` : `Added ${store.name} for the household`);
    } else {
      const text = String(data.get('result') || '').trim();
      if (!text) return;
      const store = await api.importLocalStoreResults(text);
      stores = stores.map((s) => (s.id === store.id ? store : s));
      remainderQuote = null;
      showToast(`Prices from ${store.name} imported`);
    }
    render();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
