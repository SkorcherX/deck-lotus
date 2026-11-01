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
import { showToast, confirmDialog } from '../utils/ui.js';
import { planPurchases, storeCoverage, toCardList, CONDITIONS } from '../../../src/shared/localShop.js';

const NOTICE_KEY = 'deckLotus.localStores.noticeSeen';
const OPTIONS_KEY = 'deckLotus.localStores.options';

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
const FIREFOX_STEPS = `One-time setup in Firefox:
  <ol>
    <li><a href="/api/local-stores/extension-firefox.zip" download>Download the extension</a> (keep it zipped).</li>
    <li>Firefox only keeps add-ons that Mozilla has signed. Signing is free: on
      <a href="https://addons.mozilla.org/developers/addon/submit/distribution" target="_blank" rel="noopener">addons.mozilla.org</a>
      choose <strong>On your own</strong>, upload the zip, and download the signed <code>.xpi</code> it gives back
      (usually within minutes). Open that file in Firefox to install it.
      <div class="local-stores-hint">To try it first: open <code>about:debugging#/runtime/this-firefox</code> and choose
        <strong>Load Temporary Add-on</strong> with the zip. It is removed when Firefox restarts.</div></li>
    <li>Back on this page, click the extension's icon (in the puzzle-piece menu) and choose <strong>connect</strong>.
      Firefox asks to allow this site and tcgplayerpro.com.</li>
  </ol>`;

let stores = null;
let getItems = () => [];
let remainderQuote = null;
// The browser extension, once its bridge on this page answers: { version }.
let extension = null;
// A run in progress: { storeIds, current, done, total, name, errors }.
let run = null;
// What went wrong in the last run. Kept on the page until dismissed or the
// next run: a toast is gone before a store's error can be read or copied.
let runErrors = [];

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

function options() {
  const saved = readStorage(OPTIONS_KEY, {});
  return {
    minCondition: CONDITIONS.includes(saved.minCondition) ? saved.minCondition : 'LP',
    allowFoil: !!saved.allowFoil,
  };
}

/** Wire the section once. `itemsGetter` returns the list as the Mana Pool optimizer sees it. */
export function initLocalStores(itemsGetter) {
  getItems = itemsGetter;
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

/** Called whenever the shopping list re-renders. */
export async function refreshLocalStores() {
  const section = document.getElementById('local-stores-section');
  if (!section) return;
  const items = getItems();
  section.style.display = items.length ? '' : 'none';
  if (!items.length) return;
  remainderQuote = null;
  if (stores == null) {
    try {
      stores = await api.getLocalStores();
    } catch (err) {
      document.getElementById('local-stores-body').innerHTML =
        `<div class="local-stores-error">${escapeHtml(err.message)}</div>`;
      return;
    }
  }
  render();
}

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
          second, from your browser. Nothing is added to a cart and Deck Lotus never contacts the
          store itself. Check the store's terms of use if you are unsure they are happy with it.
          <div><button type="button" class="btn btn-secondary btn-sm" data-action="ack-notice">Got it</button></div>
        </div>
      </div>`}

    <div class="local-stores-list">
      ${(stores || []).map((s) => `
        <div class="local-stores-store">
          <div>
            <a href="${escapeHtml(s.baseUrl)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(s.name)}</strong>
              <i class="ph ph-arrow-square-out"></i></a>
            <div class="local-stores-hint">${s.fetchedAt ? `Prices from ${escapeHtml(ago(s.fetchedAt))}` : 'Not looked up yet'}</div>
          </div>
          ${extension ? `<button type="button" class="btn btn-secondary btn-sm" data-action="run-one" data-id="${s.id}" ${run ? 'disabled' : ''} title="Check prices at this store">
            <i class="ph ph-arrows-clockwise"></i></button>` : ''}
          <button type="button" class="btn btn-secondary btn-sm" data-action="remove-store" data-id="${s.id}" title="Remove store">
            <i class="ph ph-trash"></i>
          </button>
        </div>`).join('') || '<div class="local-stores-hint">Add a store that sells through a TCGplayer Pro storefront.</div>'}
    </div>

    <form class="local-stores-add" data-form="add-store">
      <input class="form-control" name="name" placeholder="Store name" maxlength="100" required>
      <input class="form-control" name="baseUrl" placeholder="https://yourstore.tcgplayerpro.com" required>
      <button type="submit" class="btn btn-secondary btn-sm"><i class="ph ph-plus"></i> Add store</button>
    </form>

    ${stores?.length ? `
      <div class="local-stores-steps">
        <div class="local-stores-options">
          <label>Worst condition
            <select class="form-control" data-option="minCondition">
              ${CONDITIONS.map((c) => `<option value="${c}" ${c === opts.minCondition ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </label>
          <label><input type="checkbox" data-option="allowFoil" ${opts.allowFoil ? 'checked' : ''}> Foils are fine</label>
          ${extension ? `
            <button type="button" class="btn btn-primary btn-sm" data-action="run-all" ${run ? 'disabled' : ''}>
              <i class="ph ph-storefront"></i> Check prices at ${stores.length === 1 ? escapeHtml(stores[0].name) : `all ${stores.length} stores`} (${items.length} cards)
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
                <a href="${IS_FIREFOX ? '/api/local-stores/extension.zip' : '/api/local-stores/extension-firefox.zip'}" download>Download that version</a>.</div>
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
  const quoted = (stores || []).filter((s) => s.result);
  if (!quoted.length) return '';

  const plan = planPurchases(items, quoted);
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
      ${mark(online, online != null ? money(online) : '<span class="local-stores-hint">no price</span>')}
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
        <div class="local-stores-hint">TCGplayer market, before shipping${unpricedOnline ? ` · ${unpricedOnline} unpriced` : ''}</div>
      </div>
    </div>

    <div class="local-stores-plan">
      <h4>Cheapest split</h4>
      <ul>
        ${quoted.filter((s) => plan.totals[s.id].copies).map((s) => `
          <li><strong>${escapeHtml(s.name)}</strong> (pick up): ${plan.totals[s.id].copies} copies, ${money(plan.totals[s.id].cost)}</li>`).join('')}
        <li><strong>Online</strong>: ${plan.online.reduce((n, i) => n + i.quantity, 0)} copies,
          about ${money(plan.onlineEstimate)} before shipping${plan.uncovered.length ? ` (${plan.uncovered.length} cards with no price)` : ''}</li>
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
        price per card. Shipping is not part of that choice, so check the quote: a few cheap cards online may cost
        more to ship than to buy in store.</p>
    </div>

    <div class="analytics-table-wrap">
      <table class="analytics-table">
        <thead><tr><th>Card</th><th class="num">Need</th>
          ${quoted.map((s) => `<th class="num">${escapeHtml(s.name)}</th>`).join('')}<th class="num">Online est.</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="local-stores-hint">Hover a store price to see the printings and conditions it is made of.
      Store prices are a snapshot from when the script ran.</p>
  `;
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
        ${t.buyer_fee_cents ? `<tr><td>Buyer fee</td><td class="num">${cents(t.buyer_fee_cents)}</td></tr>` : ''}
        <tr><td><strong>Mana Pool total</strong></td><td class="num"><strong>${cents(t.total_cents)}</strong></td></tr>
        <tr><td>Local pickups</td><td class="num">${money(localSplit)}</td></tr>
        <tr><td><strong>Everything</strong></td><td class="num"><strong>${money(localSplit + (t.total_cents || 0) / 100)}</strong></td></tr>` : ''}
    </table>
    ${remainderQuote.unavailable?.length ? `<div class="local-stores-error">No Mana Pool seller for: ${escapeHtml(remainderQuote.unavailable.join(', '))}</div>` : ''}
    ${t ? `<a href="https://manapool.com/cart" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">Open Mana Pool cart <i class="ph ph-arrow-square-out"></i></a>` : ''}
  `;
}

function currentPlan() {
  const items = getItems();
  return { items, plan: planPurchases(items, (stores || []).filter((s) => s.result)) };
}

async function onClick(event) {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const body = document.getElementById('local-stores-body');
  const action = el.dataset.action;

  if (action === 'run-all') {
    startRun(stores.map((s) => s.id));
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
      title: 'Remove store?', message: `${store.name} and its last price lookup will be removed.`, confirmText: 'Remove', danger: true,
    });
    if (!ok) return;
    await api.deleteLocalStore(store.id);
    stores = stores.filter((s) => s.id !== store.id);
    render();
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
      return { name: o.name, quantity: o.quantity, setCode: item?.setCode, collectorNumber: item?.collectorNumber };
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

function onChange(event) {
  const el = event.target.closest('[data-option]');
  if (!el) return;
  const opts = options();
  opts[el.dataset.option] = el.type === 'checkbox' ? el.checked : el.value;
  writeStorage(OPTIONS_KEY, opts);
}

async function onSubmit(event) {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  try {
    if (form.dataset.form === 'add-store') {
      const store = await api.addLocalStore(data.get('name'), data.get('baseUrl'));
      stores = [...stores, store].sort((a, b) => a.name.localeCompare(b.name));
      showToast(`Added ${store.name}`);
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
