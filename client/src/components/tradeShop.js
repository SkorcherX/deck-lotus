import api from '../services/api.js';
import { showLoading, hideLoading, showToast, debounce, formatMana, openModal, closeModal } from '../utils/ui.js';
import { showCardDetail } from './cards.js';

/**
 * Shopping somebody else's collection.
 *
 * Built to feel like the inventory page rather than like a form, because that
 * is what it is: browsing cards, with a cart. It reuses the inventory grid's
 * markup and classes on purpose — a second, subtly different card grid would
 * be the thing people notice, and there is nothing here worth noticing.
 *
 * What is missing matters more than what is here. No card shows how many
 * copies are committed to decks, there is no availability filter, and nothing
 * distinguishes a card sitting in a built deck from one loose in a box. Cards
 * in decks are shoppable, and the shopper is told nothing about it; the owner
 * finds out what it costs them when they answer, and the deck tells them
 * afterwards if a slot opened up. The server strips those fields too — see
 * browsePartnerInventory — so this is not a UI-only courtesy.
 *
 * Two modes share all of it:
 *   'request' — you shop their collection and send what you want.
 *   'counter' — they asked for something, and you shop theirs to say what you
 *               want back, which completes the trade.
 */

const PAGE_SIZE = 54;

const state = {
  mode: 'request',
  partner: null,
  tradeId: null,
  // What the other side already asked for, shown while countering so the
  // choice is made against something rather than in the abstract.
  askedFor: [],
  cart: new Map(),
  data: null,
  page: 1,
  totalPages: 1,
  viewMode: 'grid',
  showPrices: localStorage.getItem('inventoryShowPrices') === 'true',
  filters: { name: '', sort: 'name', type: 'all', commander: 'all', colors: [] },
  onDone: null,
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function money(value) {
  return value == null ? '—' : `$${Number(value).toFixed(2)}`;
}

function cartKey(printingId, isFoil) {
  return `${printingId}:${isFoil ? 1 : 0}`;
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

function cartItems() {
  return [...state.cart.values()];
}

function cartTotals() {
  const items = cartItems();

  return {
    cards: items.reduce((sum, item) => sum + item.quantity, 0),
    price: items.reduce((sum, item) => sum + ((item.price ?? 0) * item.quantity), 0),
    unpriced: items.reduce((sum, item) => sum + (item.price == null ? item.quantity : 0), 0),
  };
}

/** How many copies of one printing are already in the cart. */
function pickedCount(card) {
  if (!card.printings) return 0;

  return card.printings.reduce((sum, printing) => {
    const entry = state.cart.get(cartKey(printing.printing_id, printing.is_foil === 1));
    return sum + (entry ? entry.quantity : 0);
  }, 0);
}

function addToCart(card, printing) {
  const key = cartKey(printing.printing_id, printing.is_foil === 1);
  const existing = state.cart.get(key);

  if (existing) {
    if (existing.quantity >= existing.available) {
      showToast(`They only have ${existing.available} of that copy`, 'error');
      return false;
    }
    existing.quantity += 1;
  } else {
    state.cart.set(key, {
      printingId: printing.printing_id,
      isFoil: printing.is_foil === 1,
      quantity: 1,
      available: printing.quantity,
      cardName: card.name,
      setCode: printing.set_code,
      price: printing.price,
      typeLine: card.type_line,
      colors: card.colors,
    });
  }

  updateCartCount();
  return true;
}

function updateCartCount() {
  const badge = document.getElementById('trade-shop-count');
  if (!badge) return;

  const { cards } = cartTotals();

  badge.textContent = cards;
  badge.classList.toggle('hidden', cards === 0);
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

function cheapestPrice(card) {
  const prices = (card.printings || []).map((p) => p.price).filter((p) => p != null);
  return prices.length ? Math.min(...prices) : null;
}

function foilCount(card) {
  return (card.printings || [])
    .filter((printing) => printing.is_foil === 1)
    .reduce((sum, printing) => sum + printing.quantity, 0);
}

function renderShop() {
  const container = document.getElementById('trade-shop-grid');
  if (!container) return;

  if (!state.data || !state.data.cards || state.data.cards.length === 0) {
    container.className = 'inventory-grid';
    container.innerHTML = `
      <div class="inventory-empty">
        <i class="ph ph-magnifying-glass" style="font-size: 4rem; opacity: 0.3;"></i>
        <h3>Nothing matches</h3>
        <p>Try a different filter, or clear the search.</p>
      </div>
    `;
    return;
  }

  if (state.viewMode === 'grid') renderGrid(container);
  else renderList(container);
}

function renderGrid(container) {
  container.className = 'inventory-grid';

  container.innerHTML = state.data.cards.map((card) => {
    const picked = pickedCount(card);
    const printingCount = card.printings ? card.printings.length : 0;
    const price = cheapestPrice(card);
    const foils = foilCount(card);

    return `
      <div class="inventory-card-item ${picked ? 'selected' : ''}" data-card-id="${card.card_id}">
        ${picked ? `<div class="trade-shop-picked" title="${picked} picked">${picked}</div>` : ''}
        <div class="inventory-card-image">
          ${card.image_url ? `
            <img src="${card.image_url}" alt="${escapeHtml(card.name)}" loading="lazy" onerror="this.style.display='none'" />
          ` : ''}
          ${printingCount > 1 ? `
            <div class="inventory-printings-badge" title="${printingCount} different printings">
              <i class="ph ph-stack"></i> ${printingCount}
            </div>
          ` : ''}
        </div>
        <div class="inventory-card-info">
          <div class="inventory-card-name">
            <span>${escapeHtml(card.name)}</span>
            ${foils > 0 ? `<span class="foil-badge" title="${foils} foil"><i class="ph ph-sparkle"></i> ${foils}</span>` : ''}
          </div>
          <div class="inventory-card-mana">${formatMana(card.mana_cost || '')}</div>
          <div class="inventory-card-stats">
            <span title="Copies they own">
              <i class="ph ph-stack"></i> ${card.total_owned}
            </span>
            <span class="trade-shop-add" data-card-id="${card.card_id}" title="Add to your picks">
              <i class="ph ph-plus-circle"></i> Pick
            </span>
          </div>
          ${state.showPrices ? `
            <div class="inventory-card-price ${price == null ? 'no-price' : ''}">
              ${price == null ? '—' : money(price)}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.inventory-card-item').forEach((item) => {
    const cardId = parseInt(item.dataset.cardId, 10);
    const card = state.data.cards.find((entry) => entry.card_id === cardId);

    // The whole tile is the shopping action, the way clicking a shelf item
    // puts it in the basket. Card details stay reachable through the name.
    item.addEventListener('click', (event) => {
      if (event.target.closest('.inventory-card-name span')) {
        showCardDetail(cardId);
        return;
      }

      pick(card);
    });
  });
}

function renderList(container) {
  container.className = 'inventory-list';

  // Six columns, matching .inventory-list-header's grid so the rows line up
  // with the inventory page's list view rather than drifting a column out.
  container.innerHTML = `
    <div class="inventory-list-header">
      <div>Card</div>
      <div>Type</div>
      <div>Mana</div>
      <div>Owned</div>
      <div>Picked</div>
      <div>${state.showPrices ? 'Price' : ''}</div>
    </div>
    ${state.data.cards.map((card) => {
      const picked = pickedCount(card);
      const price = cheapestPrice(card);

      return `
        <div class="inventory-list-item" data-card-id="${card.card_id}">
          <div class="list-col-name">${escapeHtml(card.name)}</div>
          <div>${escapeHtml((card.type_line || '').split('—')[0].trim())}</div>
          <div>${formatMana(card.mana_cost || '')}</div>
          <div>${card.total_owned}</div>
          <div>${picked || ''}</div>
          <div>${state.showPrices ? (price == null ? '—' : money(price)) : ''}</div>
        </div>
      `;
    }).join('')}
  `;

  container.querySelectorAll('.inventory-list-item').forEach((row) => {
    const cardId = parseInt(row.dataset.cardId, 10);
    row.addEventListener('click', () => pick(state.data.cards.find((c) => c.card_id === cardId)));
  });
}

/**
 * Put a card in the cart.
 *
 * A card owned in one printing and finish goes straight in — asking "which
 * one?" when there is only one is the sort of friction that makes people stop
 * browsing. Anything else asks, because a foil and a non-foil are different
 * cards to a trade and picking the wrong one is worse than a click.
 */
function pick(card) {
  if (!card || !card.printings || card.printings.length === 0) return;

  if (card.printings.length === 1) {
    if (addToCart(card, card.printings[0])) renderShop();
    return;
  }

  showPrintingPicker(card);
}

function showPrintingPicker(card) {
  document.getElementById('trade-shop-printing-title').textContent = card.name;

  const list = document.getElementById('trade-shop-printing-list');

  list.innerHTML = card.printings.map((printing, index) => `
    <button class="btn btn-secondary trade-shop-printing-option"
            data-index="${index}"
            style="display:flex;width:100%;justify-content:space-between;align-items:center;gap:0.75rem;margin-bottom:0.5rem;text-align:left;">
      <span>
        ${escapeHtml((printing.set_code || '').toUpperCase())}
        ${printing.collector_number ? `<span style="color:var(--text-secondary);">#${escapeHtml(printing.collector_number)}</span>` : ''}
        ${printing.is_foil === 1 ? '<span style="color:var(--accent);">foil</span>' : ''}
      </span>
      <span style="color:var(--text-secondary);">${printing.quantity} · ${money(printing.price)}</span>
    </button>
  `).join('');

  list.querySelectorAll('.trade-shop-printing-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (addToCart(card, card.printings[parseInt(btn.dataset.index, 10)])) {
        closeModal('trade-shop-printing-modal');
        renderShop();
      }
    });
  });

  openModal('trade-shop-printing-modal');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadPage() {
  try {
    showLoading();

    const [data, stats] = await Promise.all([
      api.getPartnerInventory(state.partner.id, {
        ...state.filters,
        colors: state.filters.colors.join(','),
        page: state.page,
        limit: PAGE_SIZE,
      }),
      api.getPartnerStats(state.partner.id),
    ]);

    state.data = data;
    state.totalPages = data.pagination.totalPages || 1;

    renderStats(stats);
    renderShop();
    renderPagination();
    updateCartCount();

    hideLoading();
  } catch (error) {
    hideLoading();
    showToast('Failed to load collection: ' + error.message, 'error');
  }
}

/**
 * Three figures, not five. The inventory page also shows "in decks" and
 * "available"; both describe what the owner has built, which is not on offer
 * here.
 */
function renderStats(stats) {
  document.getElementById('trade-shop-stats').innerHTML = `
    <div class="inventory-stat">
      <i class="ph ph-cards"></i>
      <div>
        <div class="stat-value">${stats.uniqueCards.toLocaleString()}</div>
        <div class="stat-label">Unique Cards</div>
      </div>
    </div>
    <div class="inventory-stat">
      <i class="ph ph-stack"></i>
      <div>
        <div class="stat-value">${stats.totalCopies.toLocaleString()}</div>
        <div class="stat-label">Total Copies</div>
      </div>
    </div>
    <div class="inventory-stat">
      <i class="ph ph-currency-dollar"></i>
      <div>
        <div class="stat-value">${money(stats.estimatedValue)}</div>
        <div class="stat-label">Est. Value</div>
      </div>
    </div>
  `;
}

function renderPagination() {
  for (const suffix of ['', '-top']) {
    const info = document.getElementById(`trade-shop-page-info${suffix}`);
    const prev = document.getElementById(`trade-shop-prev${suffix || ''}`);
    const next = document.getElementById(`trade-shop-next${suffix || ''}`);

    if (info) info.textContent = `Page ${state.page} of ${state.totalPages}`;
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= state.totalPages;
  }
}

function reload({ resetPage = true } = {}) {
  if (resetPage) state.page = 1;
  loadPage();
}

// ---------------------------------------------------------------------------
// The cart modal
// ---------------------------------------------------------------------------

function renderCart() {
  const items = cartItems();
  const container = document.getElementById('trade-cart-items');
  const totals = cartTotals();

  document.getElementById('trade-cart-title').textContent =
    state.mode === 'counter' ? 'What you want back' : 'Your picks';

  document.getElementById('trade-cart-subtitle').innerHTML = state.mode === 'counter'
    ? `${escapeHtml(state.partner.username)} asked you for ${summariseAsked()}.
       Pick what you want from their collection in return — they still have to accept.`
    : `Picked from ${escapeHtml(state.partner.username)}'s collection.
       They will choose what they want from yours before anything is agreed.`;

  document.getElementById('trade-cart-send').textContent =
    state.mode === 'counter' ? 'Send counter-offer' : 'Send request';

  if (!items.length) {
    container.innerHTML = '<div style="color:var(--text-secondary);padding:1rem 0;">Nothing picked yet.</div>';
    return;
  }

  container.innerHTML = items.map((item) => `
    <div style="display:flex;align-items:center;gap:0.5rem;padding:0.45rem 0;border-bottom:1px solid var(--border);">
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.9rem;">
          ${item.quantity}x ${escapeHtml(item.cardName)}
          <span style="color:var(--text-secondary);">${escapeHtml((item.setCode || '').toUpperCase())}</span>
          ${item.isFoil ? '<span style="color:var(--accent);font-size:0.75rem;">foil</span>' : ''}
        </div>
        <div style="font-size:0.78rem;color:var(--text-secondary);">
          ${escapeHtml((item.typeLine || '').split('—')[0].trim())} ·
          ${item.price == null ? 'unpriced' : `${money(item.price)} ea`}
        </div>
      </div>
      <input type="number" min="1" max="${item.available}" value="${item.quantity}"
             class="trade-cart-qty" data-key="${cartKey(item.printingId, item.isFoil)}" style="width:60px;" />
      <button class="btn btn-secondary btn-sm trade-cart-remove"
              data-key="${cartKey(item.printingId, item.isFoil)}">
        <i class="ph ph-x"></i>
      </button>
    </div>
  `).join('') + `
    <div style="display:flex;justify-content:space-between;padding-top:0.6rem;margin-top:0.6rem;border-top:1px solid var(--border);">
      <span>${totals.cards} card${totals.cards === 1 ? '' : 's'}</span>
      <strong>${money(totals.price)}${totals.unpriced ? ` <span style="color:var(--text-secondary);font-weight:400;">(${totals.unpriced} unpriced)</span>` : ''}</strong>
    </div>
  `;

  container.querySelectorAll('.trade-cart-qty').forEach((input) => {
    input.addEventListener('change', () => {
      const item = state.cart.get(input.dataset.key);
      if (!item) return;

      const wanted = parseInt(input.value, 10) || 1;
      item.quantity = Math.max(1, Math.min(wanted, item.available));
      input.value = item.quantity;

      renderCart();
      updateCartCount();
      renderShop();
    });
  });

  container.querySelectorAll('.trade-cart-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.cart.delete(btn.dataset.key);
      renderCart();
      updateCartCount();
      renderShop();
    });
  });
}

function summariseAsked() {
  if (!state.askedFor.length) return 'nothing';

  const names = state.askedFor.map((item) => (
    item.quantity > 1 ? `${item.quantity}x ${item.cardName}` : item.cardName
  ));

  return escapeHtml(names.length > 3
    ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
    : names.join(', '));
}

/**
 * Warn a counter-offerer what answering will cost their own decks.
 *
 * The cards leaving this user are the ones they were *asked* for, not the
 * ones they are picking — those come out of the initiator's collection. So
 * the warning is fixed the moment the request arrives and does not change as
 * the cart fills; it is shown here because this is the commit point.
 *
 * Only meaningful when countering. A request costs its initiator nothing
 * until the other side answers, so there is nothing to warn them about yet.
 */
async function refreshCounterWarnings() {
  const warnings = document.getElementById('trade-cart-warnings');

  if (state.mode !== 'counter' || !state.askedFor.length) {
    warnings.innerHTML = '';
    return;
  }

  try {
    // 'give' is relative to the person asking for the preview — this user —
    // so impact.from is their own decks.
    const impact = await api.previewTrade(state.partner.id, state.askedFor.map((item) => ({
      printingId: item.printingId,
      isFoil: item.isFoil,
      quantity: item.quantity,
      direction: 'give',
    })));

    warnings.innerHTML = impact.from.length ? `
      <div style="padding:0.75rem;border-radius:8px;background:var(--bg-tertiary);">
        <div style="font-weight:600;margin-bottom:0.25rem;">
          <i class="ph ph-warning"></i> This takes cards out of your decks
        </div>
        <ul style="margin:0;padding-left:1.1rem;font-size:0.875rem;">
          ${impact.from.map((row) => `
            <li><strong>${escapeHtml(row.cardName)}</strong>${row.isFoil ? ' (foil)' : ''} —
              ${row.decks.map((deck) => `${escapeHtml(deck.deckName)} would be ${deck.quantity} short`).join('; ')}.</li>
          `).join('')}
        </ul>
        <div style="font-size:0.8rem;color:var(--text-secondary);margin-top:0.4rem;">
          You can still trade them. Each deck will tell you afterwards, and you decide
          whether it drops the card or keeps listing it.
        </div>
      </div>
    ` : '';
  } catch {
    // A warning that cannot be computed is not worth an error in front of a
    // trade that is otherwise fine.
    warnings.innerHTML = '';
  }
}

async function sendCart() {
  const items = cartItems().map((item) => ({
    printingId: item.printingId,
    isFoil: item.isFoil,
    quantity: item.quantity,
  }));

  if (!items.length) {
    showToast('Pick at least one card', 'error');
    return;
  }

  const note = document.getElementById('trade-cart-note').value || null;

  try {
    showLoading();

    if (state.mode === 'counter') {
      await api.counterTrade(state.tradeId, items, note);
    } else {
      await api.createTradeRequest(state.partner.id, items, note);
    }

    hideLoading();
    closeModal('trade-cart-modal');

    showToast(
      state.mode === 'counter'
        ? 'Sent back — they have to accept before anything moves'
        : `Sent to ${state.partner.username} — they will pick what they want from yours`,
      'success'
    );

    window.dispatchEvent(new CustomEvent('trades:changed'));

    if (state.onDone) state.onDone();
  } catch (error) {
    hideLoading();
    showToast(error.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Open the shop.
 *
 * `partner` is whose collection is being browsed. In counter mode that is the
 * person who sent the request, and `askedFor` is what they want from you.
 */
export function openTradeShop({ mode, partner, tradeId = null, askedFor = [], onDone = null }) {
  state.mode = mode;
  state.partner = partner;
  state.tradeId = tradeId;
  state.askedFor = askedFor;
  state.cart = new Map();
  state.page = 1;
  state.filters = { name: '', sort: 'name', type: 'all', commander: 'all', colors: [] };
  state.onDone = onDone;

  document.getElementById('trade-shop-title').textContent = `${partner.username}'s collection`;
  document.getElementById('trade-shop-search').value = '';
  document.getElementById('trade-shop-sort').value = 'name';
  document.getElementById('trade-shop-type').value = 'all';
  document.getElementById('trade-shop-commander').value = 'all';
  document.getElementById('trade-cart-note').value = '';
  document.querySelectorAll('#trade-shop-colors input[type="checkbox"]').forEach((box) => {
    box.checked = false;
  });

  document.getElementById('trade-shop-brief').innerHTML = mode === 'counter'
    ? `<div style="padding:0.75rem 1rem;border-radius:8px;background:var(--bg-tertiary);font-size:0.9rem;">
         <strong>${escapeHtml(partner.username)}</strong> asked you for ${summariseAsked()}.
         Pick what you want from their collection in return.
       </div>`
    : `<div style="font-size:0.875rem;color:var(--text-secondary);">
         Pick what you would like. ${escapeHtml(partner.username)} then chooses what they want
         from your collection, and the trade only happens if you both agree.
       </div>`;

  showShopPage(true);
  loadPage();
}

function showShopPage(show) {
  document.querySelectorAll('.page').forEach((page) => {
    if (page.id !== 'auth-page') page.classList.add('hidden');
  });

  document.getElementById(show ? 'trade-shop-page' : 'trades-page').classList.remove('hidden');
}

export function setupTradeShop() {
  document.getElementById('trade-shop-back').addEventListener('click', () => {
    showShopPage(false);
    window.dispatchEvent(new CustomEvent('page:trades'));
  });

  document.getElementById('trade-shop-review').addEventListener('click', () => {
    renderCart();
    refreshCounterWarnings();
    openModal('trade-cart-modal');
  });

  document.getElementById('trade-cart-close').addEventListener('click', () => {
    closeModal('trade-cart-modal');
  });

  document.getElementById('trade-cart-keep-shopping').addEventListener('click', () => {
    closeModal('trade-cart-modal');
  });

  document.getElementById('trade-cart-send').addEventListener('click', sendCart);

  document.getElementById('trade-shop-printing-close').addEventListener('click', () => {
    closeModal('trade-shop-printing-modal');
  });

  const search = document.getElementById('trade-shop-search');
  search.addEventListener('input', debounce(() => {
    state.filters.name = search.value.trim();
    reload();
  }, 300));

  for (const [id, key] of [['trade-shop-sort', 'sort'], ['trade-shop-type', 'type'], ['trade-shop-commander', 'commander']]) {
    document.getElementById(id).addEventListener('change', (event) => {
      state.filters[key] = event.target.value;
      reload();
    });
  }

  document.querySelectorAll('#trade-shop-colors input[type="checkbox"]').forEach((box) => {
    box.addEventListener('change', () => {
      state.filters.colors = Array.from(
        document.querySelectorAll('#trade-shop-colors input[type="checkbox"]:checked')
      ).map((checked) => checked.value);
      reload();
    });
  });

  const priceToggle = document.getElementById('trade-shop-price-toggle');
  priceToggle.addEventListener('click', () => {
    state.showPrices = !state.showPrices;
    priceToggle.setAttribute('aria-pressed', String(state.showPrices));
    priceToggle.classList.toggle('active', state.showPrices);
    renderShop();
  });

  const gridBtn = document.getElementById('trade-shop-grid-view-btn');
  const listBtn = document.getElementById('trade-shop-list-view-btn');

  gridBtn.addEventListener('click', () => {
    state.viewMode = 'grid';
    gridBtn.classList.add('active');
    listBtn.classList.remove('active');
    renderShop();
  });

  listBtn.addEventListener('click', () => {
    state.viewMode = 'list';
    listBtn.classList.add('active');
    gridBtn.classList.remove('active');
    renderShop();
  });

  for (const id of ['trade-shop-prev', 'trade-shop-prev-top']) {
    document.getElementById(id).addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        loadPage();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  for (const id of ['trade-shop-next', 'trade-shop-next-top']) {
    document.getElementById(id).addEventListener('click', () => {
      if (state.page < state.totalPages) {
        state.page += 1;
        loadPage();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  // Match the inventory page's price toggle on first paint.
  priceToggle.setAttribute('aria-pressed', String(state.showPrices));
  priceToggle.classList.toggle('active', state.showPrices);
}
