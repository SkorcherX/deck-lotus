import api from '../services/api.js';
import { showLoading, hideLoading, formatMana, showToast, showError, debounce, confirmDialog } from '../utils/ui.js';

let selectedDeckIds = new Set();
let shoppingData = null;
let allDecks = [];
let filters = {
  priceMin: null,
  priceMax: null,
  rarity: null,
  colors: null,
  setSearch: '',
  sortBy: 'setName', // setName, price, releaseDate
  budgetMode: false,
  compactView: false, // Toggle between full and compact view
};
/**
 * Which lens the page is showing.
 *
 * 'sets' groups by set and is for buying singles online. 'bulk' is the flat
 * A-Z list you read standing at a shop's cheap-card boxes. Same underlying
 * shopping list; different question being asked of it.
 */
let viewMode = 'sets';
let bulkData = null;

// commonsOnly and includeContested are session-only on purpose — they are
// "what am I looking at right now" switches. The threshold is the one that
// persists, and only when saved explicitly.
let bulkOptions = {
  threshold: null,
  commonsOnly: true,
  includeContested: true,
};

let sessionState = {
  skipped: new Set(), // rows hidden for this visit only
};

/**
 * The found pile: cards ticked off at a shop, keyed by card id.
 *
 * Not a session set and not inventory. Marking a card found used to call
 * addOwnedCard, which claimed something untrue — the copy you pull out of a
 * bulk box shares a *name* with the card your deck lists and almost never its
 * printing, so the collection ended up holding a set and collector number
 * nobody chose. The tick is now its own record, saved server-side on every
 * press (a trip has to survive a phone dying), reversible on a second press
 * (the button is used one-handed over a box), and turned into inventory later
 * through the normal bulk add, where printings are actually picked.
 */
let foundPile = new Map();

// Mana Pool's /search page 404s, but /card/{slug} goes straight to the
// card's page — same slugging Mana Pool itself uses (lowercase, non
// alphanumerics collapsed to single hyphens, no leading/trailing hyphen).
/**
 * Why a four-of is only quoting three.
 *
 * The list shops for the shortfall, not for what the deck lists, so a
 * partially-owned card shows fewer copies than the deck asks for. Without
 * saying so the number just looks wrong — and the reflex is to assume the
 * page has lost a copy somewhere.
 */
function ownedHint(card) {
  if (!card.owned || !card.listed || card.owned >= card.listed) return '';

  const title = `Your decks list ${card.listed}; you already own ${card.owned}`;
  return `<span class="shopping-owned-hint" title="${title}">owns ${card.owned}/${card.listed}</span>`;
}

function manaPoolCardUrl(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://manapool.com/card/${slug}`;
}

export function setupShopping() {
  window.addEventListener('page:shopping', loadShoppingData);

  document.getElementById('shopping-optimize-btn')?.addEventListener('click', runShoppingOptimizer);
  document.getElementById('shopping-mode-sets')?.addEventListener('click', () => switchViewMode('sets'));
  document.getElementById('shopping-mode-bulk')?.addEventListener('click', () => switchViewMode('bulk'));
  setupWantedList();
}

/**
 * Swap lenses.
 *
 * The by-set filters do not travel: they operate on set grouping and price of
 * the deck's own printing, neither of which the bulk view uses. Showing them
 * above a list they cannot affect would be worse than hiding them.
 */
function switchViewMode(mode) {
  if (viewMode === mode) return;
  viewMode = mode;

  const bulk = mode === 'bulk';

  document.getElementById('shopping-mode-sets')?.setAttribute('aria-selected', String(!bulk));
  document.getElementById('shopping-mode-bulk')?.setAttribute('aria-selected', String(bulk));

  document.getElementById('shopping-filters-section')?.classList.toggle('hidden', bulk);
  document.getElementById('shopping-sets-section')?.classList.toggle('hidden', bulk);
  document.getElementById('shopping-bulk-section')?.classList.toggle('hidden', !bulk);

  // The Mana Pool optimizer quotes the printings the by-set list names. The
  // bulk list is about walking into a shop, so the two do not belong on screen
  // together.
  const optimizer = document.getElementById('shopping-optimizer-section');
  if (optimizer) optimizer.style.display = bulk ? 'none' : '';

  if (bulk) refreshBulkData();
}

/** Re-read whichever list is on screen. */
async function refreshActiveView() {
  if (viewMode === 'bulk') return refreshBulkData();
  return refreshShoppingData();
}

/**
 * Repaint the list on screen from data already held.
 *
 * Ticking a card off is a session decision, not a reason to go back to the
 * server — and marking one found in either view calls addOwnedCard, so the
 * next real refresh drops it from both.
 */
function repaintActiveList() {
  if (viewMode === 'bulk') return renderBulkList();
  return renderShoppingList();
}

// ---------------------------------------------------------------------------
// The wanted list — cards being shopped for with no deck behind them
// ---------------------------------------------------------------------------

/**
 * Wire the two ways onto the list: one card at a time, or a pasted block.
 *
 * Both land in the same place, and the list they land in is merged with the
 * deck-derived one server-side. Nothing below this point knows the difference,
 * which is why the filters, the totals and the Mana Pool optimizer all work on
 * wanted cards without being told about them.
 */
function setupWantedList() {
  const search = document.getElementById('shopping-wanted-search');
  const results = document.getElementById('shopping-wanted-results');

  if (search && results) {
    search.addEventListener('input', debounce(async () => {
      const query = search.value.trim();

      if (query.length < 2) {
        results.classList.add('hidden');
        results.innerHTML = '';
        return;
      }

      try {
        const { cards = [] } = await api.searchForInventoryAdd(query);
        renderWantedSearchResults(cards);
      } catch (error) {
        console.error('Wanted-card search failed:', error);
      }
    }, 250));

    // Clicking away closes the dropdown; without this it hangs over the deck
    // selector below and swallows the clicks meant for it.
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.shopping-wanted-search')) {
        results.classList.add('hidden');
      }
    });
  }

  const bulkToggle = document.getElementById('shopping-wanted-bulk-toggle');
  const bulk = document.getElementById('shopping-wanted-bulk');

  bulkToggle?.addEventListener('click', () => {
    bulk?.classList.toggle('hidden');
    if (!bulk?.classList.contains('hidden')) {
      document.getElementById('shopping-wanted-bulk-text')?.focus();
    }
  });

  document.getElementById('shopping-wanted-bulk-cancel')?.addEventListener('click', () => {
    bulk?.classList.add('hidden');
  });

  document.getElementById('shopping-wanted-bulk-add')?.addEventListener('click', addWantedBulk);

  document.getElementById('shopping-wanted-clear')?.addEventListener('click', async () => {
    if (!window.confirm('Remove every card from your wanted list?')) return;

    try {
      const { cleared } = await api.clearWantedCards();
      showToast(`Removed ${cleared} card${cleared === 1 ? '' : 's'}`, 'success');
      await refreshShoppingData();
    } catch (error) {
      showToast('Could not clear the list: ' + error.message, 'error');
    }
  });
}

function renderWantedSearchResults(cards) {
  const results = document.getElementById('shopping-wanted-results');
  if (!results) return;

  if (cards.length === 0) {
    results.innerHTML = '<div class="search-result-item">No cards found</div>';
    results.classList.remove('hidden');
    return;
  }

  results.innerHTML = cards.map((card) => `
    <div class="search-result-item" data-card-id="${card.card_id}" data-printing-id="${card.cheapest_printing_id || ''}">
      <div>
        <strong>${escapeHtml(card.name)}</strong>
        ${card.type_line ? `<div class="shopping-wanted-result-type">${escapeHtml(card.type_line)}</div>` : ''}
      </div>
      ${card.total_owned ? `<span class="shopping-wanted-owned">own ${card.total_owned}</span>` : ''}
    </div>
  `).join('');

  results.classList.remove('hidden');

  results.querySelectorAll('.search-result-item[data-card-id]').forEach((item) => {
    item.addEventListener('click', async () => {
      // The printing is sent when the search knew one, and the card id
      // otherwise — the server resolves the cheapest printing either way, so
      // a search result that came back without one is still addable.
      const printingId = item.dataset.printingId;
      const body = printingId
        ? { printingId: parseInt(printingId, 10) }
        : { cardId: parseInt(item.dataset.cardId, 10) };

      try {
        const { added } = await api.addWantedCard(body);
        showToast(`Added ${added.name} to your list`, 'success', 1500);

        const search = document.getElementById('shopping-wanted-search');
        if (search) search.value = '';
        results.classList.add('hidden');

        await refreshShoppingData();
      } catch (error) {
        showToast('Could not add that card: ' + error.message, 'error');
      }
    });
  });
}

async function addWantedBulk() {
  const textarea = document.getElementById('shopping-wanted-bulk-text');
  const resultEl = document.getElementById('shopping-wanted-bulk-result');
  const text = textarea?.value.trim();

  if (!text) {
    showToast('Paste some card lines first', 'warning');
    return;
  }

  try {
    const result = await api.addWantedCardsBulk(text);

    // Lines that resolved to nothing are shown rather than counted: a paste
    // that added 47 of 50 is only useful if you can see which three failed,
    // and the usual cause is a set code that needs correcting by hand.
    if (resultEl) {
      resultEl.classList.remove('hidden');
      resultEl.innerHTML = `
        <div class="shopping-bulk-summary">
          Added ${result.added.length} of ${result.parsed} line${result.parsed === 1 ? '' : 's'}.
        </div>
        ${result.unresolved.length ? `
          <div class="shopping-bulk-unresolved">
            <strong>Could not match:</strong>
            <ul>
              ${result.unresolved.map((u) => `<li>${escapeHtml(u.line || u.name || '(blank)')}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
      `;
    }

    if (result.added.length > 0) {
      textarea.value = '';
      await refreshShoppingData();
    }
  } catch (error) {
    showToast('Could not add those cards: ' + error.message, 'error');
  }
}

/** Change or remove one wanted row from the list rendered below. */
async function updateWanted(itemId, quantity) {
  try {
    if (quantity <= 0) {
      await api.removeWantedCard(itemId);
    } else {
      await api.setWantedQuantity(itemId, quantity);
    }
    await refreshShoppingData();
  } catch (error) {
    showToast('Could not update the list: ' + error.message, 'error');
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

async function runShoppingOptimizer() {
  if (!shoppingData?.sets?.length) {
    showToast('Load your shopping list first', 'warning');
    return;
  }

  // Gather all needed cards (not marked found/skipped)
  const items = [];
  for (const set of shoppingData.sets) {
    for (const card of set.cards) {
      const key = `${card.printingId}`;
      if (isFound(card.cardId) || sessionState.skipped.has(key)) continue;
      // quantityNeeded, not 1: the optimizer is quoting a basket, and asking
      // Mana Pool for one copy of a card you need four of prices the wrong
      // basket. Entries carry no bare `quantity` — the deck half keeps its
      // counts per deck and the wanted half in its own row, and the server
      // reconciles the two into this one number.
      const wanted = card.quantityNeeded || 1;
      const existing = items.find(i => i.name === card.name);
      if (existing) {
        existing.quantity += wanted;
      } else {
        items.push({
          name: card.name,
          quantity: wanted,
          setCode: card.setCode,
          collectorNumber: card.collectorNumber,
        });
      }
    }
  }

  if (!items.length) {
    showToast('No cards to optimize', 'warning');
    return;
  }

  const model = document.getElementById('shopping-optimizer-strategy')?.value || 'lowest_price';
  const btn = document.getElementById('shopping-optimize-btn');
  const resultsEl = document.getElementById('shopping-optimizer-results');
  btn.disabled = true;
  btn.innerHTML = '<i class="ph ph-circle-notch"></i> Optimizing…';
  resultsEl.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-secondary);">Finding best deals across Mana Pool sellers…</div>';

  try {
    const result = await api.manaPoolOptimize(items, model);
    renderShoppingOptimizerResults(result, resultsEl);
  } catch (err) {
    resultsEl.innerHTML = `<div style="color:var(--danger-light);padding:1rem;border-radius:6px;background:rgb(var(--danger-light-rgb) / 0.1);">
      <i class="ph ph-warning"></i> ${err.message}
      ${!err.message.includes('not configured') ? '' : '<br><small>Set MANAPOOL_API_TOKEN in your server .env to use the optimizer.</small>'}
    </div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ph ph-magic-wand"></i> Optimize Cart';
  }
}

function renderShoppingOptimizerResults(result, el) {
  // API response: { cart: [{ inventory_id, quantity_selected }], totals: {...}, unavailable: string[] }
  const totals = result.totals;
  const cart = result.cart ?? [];
  const unavailable = result.unavailable ?? [];

  if (!totals && !cart.length && !unavailable.length) {
    el.innerHTML = '<div style="color:var(--text-secondary);padding:1rem;">No results returned from Mana Pool optimizer.</div>';
    return;
  }

  const fmt = cents => `$${(cents / 100).toFixed(2)}`;
  const sellerCount = totals?.seller_count ?? '?';
  const totalCents = totals?.total_cents ?? 0;
  const unavailableHtml = unavailable.length ? `
    <div style="color:var(--danger-light);padding:0.75rem;border-radius:8px;background:rgb(var(--danger-light-rgb) / 0.1);margin-bottom:0.75rem;">
      <div style="font-size:0.8rem;font-weight:700;margin-bottom:0.35rem;">
        <i class="ph ph-warning"></i> No sellers available on Mana Pool (${unavailable.length})
      </div>
      <div style="font-size:0.8rem;color:var(--text-secondary);">${unavailable.join(', ')}</div>
    </div>
  ` : '';

  el.innerHTML = `
    ${totals ? `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:0.5rem;">
      <span style="font-size:1rem;font-weight:700;color:var(--success-bright);">
        <i class="ph ph-check-circle"></i> ${fmt(totalCents)} total across ${sellerCount} seller${sellerCount !== 1 ? 's' : ''}
      </span>
      <a href="https://manapool.com/cart" target="_blank" rel="noopener" class="btn btn-primary btn-sm">
        Complete on Mana Pool <i class="ph ph-arrow-square-out"></i>
      </a>
    </div>
    <div style="background:var(--bg-tertiary);border-radius:8px;padding:0.75rem;margin-bottom:0.75rem;">
        <div style="display:flex;justify-content:space-between;padding:0.2rem 0;font-size:0.85rem;">
          <span>Subtotal</span><span>${fmt(totals.subtotal_cents ?? 0)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:0.2rem 0;font-size:0.85rem;">
          <span>Shipping</span><span>${fmt(totals.shipping_cents ?? 0)}</span>
        </div>
        ${totals.buyer_fee_cents ? `
        <div style="display:flex;justify-content:space-between;padding:0.2rem 0;font-size:0.85rem;">
          <span>Buyer fee</span><span>${fmt(totals.buyer_fee_cents)}</span>
        </div>` : ''}
        <div style="display:flex;justify-content:space-between;padding:0.3rem 0 0;font-size:0.95rem;font-weight:700;border-top:1px solid var(--border-color);margin-top:0.25rem;">
          <span>Total</span><span style="color:var(--primary);">${fmt(totalCents)}</span>
        </div>
      </div>
    ` : ''}
    ${unavailableHtml}
    ${cart.length ? `
    <div style="font-size:0.8rem;color:var(--text-secondary);text-align:center;">
      ${cart.length} item${cart.length !== 1 ? 's' : ''} selected — click "Complete on Mana Pool" to review and checkout.
    </div>
    ` : ''}
  `;
}

async function loadShoppingData() {
  try {
    showLoading();

    // Get user's decks first
    const decksResult = await api.getDecks();
    allDecks = decksResult.decks;

    // Select all decks by default
    selectedDeckIds = new Set(allDecks.map(d => d.id));

    // The pile before the list: what is already ticked off decides which rows
    // the list is allowed to show.
    await loadFoundPile();

    // Get shopping data
    const result = await api.getShoppingList(Array.from(selectedDeckIds));
    shoppingData = result;

    renderDeckSelector();
    renderFilters();
    renderShoppingList();
    hideLoading();
  } catch (error) {
    hideLoading();
    showError('Failed to load shopping data: ' + error.message);
  }
}

function renderDeckSelector() {
  const container = document.getElementById('shopping-deck-selector');

  if (allDecks.length === 0) {
    container.innerHTML = '<p style="color: var(--text-secondary);">No decks found</p>';
    return;
  }

  container.innerHTML = `
    <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap;">
      <button id="select-all-decks" class="btn btn-secondary btn-sm">Select All</button>
      <button id="deselect-all-decks" class="btn btn-secondary btn-sm">Deselect All</button>
    </div>
    <div class="deck-selector-grid">
      ${allDecks.map(deck => `
        <label class="deck-selector-item">
          <input
            type="checkbox"
            value="${deck.id}"
            ${selectedDeckIds.has(deck.id) ? 'checked' : ''}
            class="deck-checkbox"
          />
          <span class="deck-selector-name">${deck.name}</span>
          ${deck.format ? `<span class="deck-selector-format">${deck.format}</span>` : ''}
        </label>
      `).join('')}
    </div>
  `;

  // Add event listeners
  document.getElementById('select-all-decks').addEventListener('click', () => {
    selectedDeckIds = new Set(allDecks.map(d => d.id));
    document.querySelectorAll('.deck-checkbox').forEach(cb => cb.checked = true);
    refreshActiveView();
  });

  document.getElementById('deselect-all-decks').addEventListener('click', () => {
    selectedDeckIds.clear();
    document.querySelectorAll('.deck-checkbox').forEach(cb => cb.checked = false);
    refreshActiveView();
  });

  document.querySelectorAll('.deck-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const deckId = parseInt(e.target.value);
      if (e.target.checked) {
        selectedDeckIds.add(deckId);
      } else {
        selectedDeckIds.delete(deckId);
      }
      refreshActiveView();
    });
  });
}

function renderFilters() {
  const filtersContainer = document.getElementById('shopping-filters');
  if (!filtersContainer) return;

  filtersContainer.innerHTML = `
    <div class="shopping-filters-grid">
      <!-- Price Filters -->
      <div class="filter-group">
        <label>Price Range</label>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <input
            type="number"
            id="price-min"
            placeholder="Min $"
            min="0"
            step="0.01"
            value="${filters.priceMin || ''}"
            class="filter-input"
            style="width: 80px;"
          />
          <span>to</span>
          <input
            type="number"
            id="price-max"
            placeholder="Max $"
            min="0"
            step="0.01"
            value="${filters.priceMax || ''}"
            class="filter-input"
            style="width: 80px;"
          />
          <label class="checkbox-label">
            <input type="checkbox" id="budget-mode" ${filters.budgetMode ? 'checked' : ''} />
            Budget Mode
          </label>
        </div>
      </div>

      <!-- Rarity Filter -->
      <div class="filter-group">
        <label>Rarity</label>
        <select id="rarity-filter" class="filter-select">
          <option value="">All Rarities</option>
          <option value="common" ${filters.rarity === 'common' ? 'selected' : ''}>Common</option>
          <option value="uncommon" ${filters.rarity === 'uncommon' ? 'selected' : ''}>Uncommon</option>
          <option value="rare" ${filters.rarity === 'rare' ? 'selected' : ''}>Rare</option>
          <option value="mythic" ${filters.rarity === 'mythic' ? 'selected' : ''}>Mythic</option>
        </select>
      </div>

      <!-- Color Filter -->
      <div class="filter-group">
        <label>Color Identity</label>
        <select id="color-filter" class="filter-select">
          <option value="">All Colors</option>
          <option value="W" ${filters.colors === 'W' ? 'selected' : ''}>White</option>
          <option value="U" ${filters.colors === 'U' ? 'selected' : ''}>Blue</option>
          <option value="B" ${filters.colors === 'B' ? 'selected' : ''}>Black</option>
          <option value="R" ${filters.colors === 'R' ? 'selected' : ''}>Red</option>
          <option value="G" ${filters.colors === 'G' ? 'selected' : ''}>Green</option>
          <option value="C" ${filters.colors === 'C' ? 'selected' : ''}>Colorless</option>
        </select>
      </div>

      <!-- Sort By -->
      <div class="filter-group">
        <label>Sort Sets By</label>
        <select id="sort-by" class="filter-select">
          <option value="setName" ${filters.sortBy === 'setName' ? 'selected' : ''}>Set Name</option>
          <option value="totalPrice" ${filters.sortBy === 'totalPrice' ? 'selected' : ''}>Total Value (High to Low)</option>
          <option value="releaseDate" ${filters.sortBy === 'releaseDate' ? 'selected' : ''}>Release Date (Newest First)</option>
          <option value="cardCount" ${filters.sortBy === 'cardCount' ? 'selected' : ''}>Card Count</option>
        </select>
      </div>

      <!-- Set Search -->
      <div class="filter-group">
        <label>Search Sets</label>
        <input
          type="text"
          id="set-search"
          placeholder="Filter by set name..."
          value="${filters.setSearch}"
          class="filter-input"
        />
      </div>

      <!-- Action Buttons -->
      <div class="filter-group" style="display: flex; gap: 0.5rem; align-items: flex-end;">
        <label class="checkbox-label">
          <input type="checkbox" id="compact-view" ${filters.compactView ? 'checked' : ''} />
          Compact View
        </label>
        <button id="clear-filters-btn" class="btn btn-secondary btn-sm">Clear Filters</button>
        <button id="export-list-btn" class="btn btn-primary btn-sm">
          <i class="ph ph-export"></i> Export
        </button>
      </div>
    </div>
  `;

  // Add event listeners for filters
  document.getElementById('price-min').addEventListener('input', (e) => {
    filters.priceMin = e.target.value ? parseFloat(e.target.value) : null;
    renderShoppingList();
  });

  document.getElementById('price-max').addEventListener('input', (e) => {
    filters.priceMax = e.target.value ? parseFloat(e.target.value) : null;
    renderShoppingList();
  });

  document.getElementById('budget-mode').addEventListener('change', (e) => {
    filters.budgetMode = e.target.checked;
    renderShoppingList();
  });

  document.getElementById('rarity-filter').addEventListener('change', (e) => {
    filters.rarity = e.target.value || null;
    renderShoppingList();
  });

  document.getElementById('color-filter').addEventListener('change', (e) => {
    filters.colors = e.target.value || null;
    renderShoppingList();
  });

  document.getElementById('sort-by').addEventListener('change', (e) => {
    filters.sortBy = e.target.value;
    renderShoppingList();
  });

  document.getElementById('set-search').addEventListener('input', (e) => {
    filters.setSearch = e.target.value.toLowerCase();
    renderShoppingList();
  });

  document.getElementById('compact-view').addEventListener('change', (e) => {
    filters.compactView = e.target.checked;
    renderShoppingList();
  });

  document.getElementById('clear-filters-btn').addEventListener('click', () => {
    filters = {
      priceMin: null,
      priceMax: null,
      rarity: null,
      colors: null,
      setSearch: '',
      sortBy: 'setName',
      budgetMode: false,
      compactView: filters.compactView, // Preserve compact view setting
    };
    renderFilters();
    renderShoppingList();
  });

  document.getElementById('export-list-btn').addEventListener('click', exportShoppingList);
}

// ---------------------------------------------------------------------------
// The bulk-bin view
// ---------------------------------------------------------------------------

async function refreshBulkData() {
  try {
    showLoading();
    bulkData = await api.getBulkBinList(Array.from(selectedDeckIds), bulkOptions);
    // The server answers with the stored threshold on the first call, when the
    // page has none yet. Adopting it here keeps the box showing what the list
    // was actually built with.
    if (bulkOptions.threshold == null) bulkOptions.threshold = bulkData.threshold;
    renderBulkControls();
    renderBulkList();
    hideLoading();
  } catch (error) {
    hideLoading();
    showError('Failed to build bulk list: ' + error.message);
  }
}

function renderBulkControls() {
  const container = document.getElementById('shopping-bulk-controls');
  if (!container) return;

  const threshold = bulkOptions.threshold ?? 1;

  container.innerHTML = `
    <div class="bulk-controls">
      <div class="filter-group">
        <label for="bulk-threshold">Max price per card</label>
        <div class="bulk-threshold-row">
          <span class="bulk-threshold-prefix">$</span>
          <input type="number" id="bulk-threshold" class="filter-input"
                 min="0" max="1000" step="0.25" value="${threshold}" style="width: 90px;" />
          <button id="bulk-threshold-save" class="btn btn-secondary btn-sm" title="Remember this for next time">
            Save as default
          </button>
        </div>
      </div>

      <div class="filter-group">
        <label>Show</label>
        <label class="checkbox-label">
          <input type="checkbox" id="bulk-commons-only" ${bulkOptions.commonsOnly ? 'checked' : ''} />
          Commons &amp; uncommons only
        </label>
        <label class="checkbox-label">
          <input type="checkbox" id="bulk-include-contested" ${bulkOptions.includeContested ? 'checked' : ''} />
          Cards tied up in other decks
        </label>
      </div>

      <div class="filter-group bulk-controls-actions">
        <button id="bulk-export-btn" class="btn btn-primary btn-sm">
          <i class="ph ph-export"></i> Copy list
        </button>
      </div>
    </div>
  `;

  // Changing the number rebuilds the list but does not save it: trying $2 to
  // see what a different shop would yield should not rewrite your default.
  const thresholdInput = document.getElementById('bulk-threshold');
  thresholdInput.addEventListener('change', () => {
    bulkOptions.threshold = parseFloat(thresholdInput.value) || 0;
    refreshBulkData();
  });

  document.getElementById('bulk-threshold-save').addEventListener('click', async () => {
    try {
      const saved = await api.saveBulkThreshold(bulkOptions.threshold ?? 1);
      bulkOptions.threshold = saved.threshold;
      showToast(`Default set to $${saved.threshold.toFixed(2)}`, 'success');
    } catch (error) {
      showToast('Could not save the default: ' + error.message, 'error');
    }
  });

  document.getElementById('bulk-commons-only').addEventListener('change', (e) => {
    bulkOptions.commonsOnly = e.target.checked;
    refreshBulkData();
  });

  document.getElementById('bulk-include-contested').addEventListener('change', (e) => {
    bulkOptions.includeContested = e.target.checked;
    refreshBulkData();
  });

  document.getElementById('bulk-export-btn').addEventListener('click', exportBulkList);
}

/**
 * One flat alphabetical column.
 *
 * No set grouping, on purpose: the boxes at a shop are not sorted by set — or
 * by anything else — so the list is ordered for the person reading it. Each
 * line still names the set and collector number of the printing being quoted,
 * so a card in hand can be checked against the price.
 */
function renderBulkList() {
  const container = document.getElementById('shopping-bulk-container');
  if (!container) return;

  if (!bulkData) {
    container.innerHTML = '';
    return;
  }

  // Found cards stay on screen, struck through, so a misclick over a bulk box
  // can be undone by pressing the same button again. They stop counting
  // toward the trip, which is what `outstanding` is for.
  const visible = bulkData.cards.filter((card) => !sessionState.skipped.has(bulkKey(card)));
  const outstanding = visible.filter((card) => !isFound(card.cardId));

  if (visible.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 3rem; color: var(--text-secondary);">
        <i class="ph ph-tray" style="font-size: 4rem; opacity: 0.3;"></i>
        <h3>Nothing under $${(bulkOptions.threshold ?? 1).toFixed(2)}</h3>
        <p>${bulkExclusionNote() || 'Try raising the price or selecting more decks.'}</p>
      </div>
    `;
    return;
  }

  const copies = outstanding.reduce((sum, c) => sum + c.quantity, 0);
  const total = outstanding.reduce((sum, c) => sum + c.lineTotal, 0);

  container.innerHTML = `
    <div class="bulk-summary">
      <strong>${outstanding.length}</strong> cards · <strong>${copies}</strong> copies ·
      about <strong>$${total.toFixed(2)}</strong>
      ${bulkExclusionNote() ? `<span class="bulk-summary-note">${bulkExclusionNote()}</span>` : ''}
    </div>

    <ol class="bulk-list">
      ${visible.map(bulkRow).join('')}
    </ol>

    ${bulkData.unpriced.length ? `
      <div class="bulk-unpriced">
        <h4><i class="ph ph-question"></i> No price data — check these by hand (${bulkData.unpriced.length})</h4>
        <p>${bulkData.unpriced.map((c) => `${c.quantity}x ${c.name}`).join(', ')}</p>
      </div>
    ` : ''}
  `;
}

/**
 * "You own this, it is in Deck B."
 *
 * A contested row is on the list because a deck you are *not* shopping for is
 * holding the copy you own. The row used to say only "1 in other decks" beside
 * the name of the deck you are shopping for, which reads as though the list
 * were quoting a card you already have for a deck that already has it. Naming
 * the deck that is holding it is the whole explanation for the row.
 *
 * The count stays the one the server worked out — it is capped by what the
 * selected decks actually list, which the per-deck quantities here are not —
 * so this only supplies names. Where several decks hold copies the names go in
 * the title rather than the line: this list is read at arm's length in a shop,
 * and three deck names inline is not something you can scan past.
 */
function contestedNote(card) {
  if (!card.contested) return '';

  const holders = (card.heldBy || []).map((d) => d.deckName).filter(Boolean);

  const where =
    holders.length === 1 ? `in ${escapeHtml(holders[0])}`
    : holders.length > 1 ? `in ${holders.length} other decks`
    // No names came back — the copies are owned but sitting in no deck at all,
    // or the lookup found nothing. Say the honest, vaguer thing rather than
    // inventing a deck.
    : 'owned elsewhere';

  const title = holders.length
    ? `You own ${card.contested}, currently in: ${holders.join(', ')}`
    : `You own ${card.contested} of these already`;

  return `<span class="bulk-contested" title="${escapeHtml(title)}">
       <i class="ph ph-arrows-split"></i> ${card.contested} ${where}
     </span>`;
}

/** Session keys are card-level here; the by-set view keys on printing. */
function bulkKey(card) {
  return `card-${card.cardId}`;
}

/**
 * The colour pips at the head of a bulk row.
 *
 * This list is read while flipping through a box a card a second, and the
 * thing you can tell about a card before you have read a word of it is its
 * colour. So the pips are the leftmost thing on the row and every row gets the
 * same width for them, whether it uses it or not — an aligned column can be
 * scanned straight down, a ragged one has to be read.
 *
 * Colour identity rather than mana cost, and a colourless card gets a pip of
 * its own rather than a blank: blank reads as missing data, and "this one is
 * an artifact" is exactly as useful to know as "this one is red".
 */
function colorPips(card) {
  const colors = card.colors || [];
  const symbols = colors.length ? colors : ['C'];

  const label = colors.length
    ? colors.join('')
    : 'Colourless';

  return `<span class="bulk-colors" title="${label}" aria-label="${label}">
      ${symbols.map((c) => `<i class="ms ms-${c.toLowerCase()} ms-cost"></i>`).join('')}
    </span>`;
}

function bulkRow(card) {
  // Rendered even when there is nothing to put in it: an omitted cell lets the
  // grid pull the price left on that row alone, which is the ragged edge this
  // column exists to avoid.
  const where = card.setCode
    ? `<span class="bulk-printing">${card.setCode.toUpperCase()} #${card.collectorNumber}</span>`
    : '<span class="bulk-printing is-empty"></span>';

  const contested = contestedNote(card);

  // Which decks want it. Labelled "For" whenever the row is also naming the
  // deck that is holding your copy, because otherwise the line carries two
  // deck names with nothing to say which is which — and the reading that
  // costs you money is the wrong one.
  const wantedBy = card.decks.map((d) => d.deckName).filter(Boolean);
  const decks = wantedBy.length
    ? `${card.contested ? 'For ' : ''}${wantedBy.join(', ')}`
    : card.wanted ? 'On your wanted list' : '';

  const found = isFound(card.cardId);

  return `
    <li class="bulk-row${found ? ' is-found' : ''}" data-card-key="${bulkKey(card)}" data-found="${found}">
      ${colorPips(card)}
      <span class="bulk-qty">${card.quantity}x</span>
      <span class="bulk-name">${card.name}</span>
      ${where}
      <span class="bulk-price">$${card.price.toFixed(2)}</span>
      <span class="bulk-meta">
        ${contested}
        <span class="bulk-decks">${decks}</span>
      </span>
      <span class="bulk-actions">
        <button class="btn-icon found-btn${found ? ' is-found' : ''}" data-card-key="${bulkKey(card)}" data-card-id="${card.cardId}"
                title="${found ? 'Press again to unmark' : 'Found it!'}" aria-pressed="${found}">
          <i class="ph ph-check${found ? '-circle' : ''}"></i>
        </button>
        <button class="btn-icon skip-btn" data-card-key="${bulkKey(card)}" title="Skip">
          <i class="ph ph-x"></i>
        </button>
      </span>
    </li>
  `;
}

/**
 * Why the list is shorter than the shopping list.
 *
 * A filtered-out card and a lost card look identical while you are standing at
 * a box, so the exclusions are counted rather than silently applied.
 */
function bulkExclusionNote() {
  if (!bulkData) return '';

  const parts = [];
  if (bulkData.excluded.overThreshold) parts.push(`${bulkData.excluded.overThreshold} over the price`);
  if (bulkData.excluded.tooRare) parts.push(`${bulkData.excluded.tooRare} too rare for a bin`);

  return parts.length ? `${parts.join(', ')} hidden` : '';
}

function exportBulkList() {
  if (!bulkData || bulkData.cards.length === 0) {
    showToast('Nothing to export', 'warning');
    return;
  }

  // What is on screen, not what was fetched: cards already ticked off should
  // not come back in the copy you paste into your phone.
  const visible = bulkData.cards.filter(
    (card) => !isFound(card.cardId) && !sessionState.skipped.has(bulkKey(card))
  );

  const threshold = bulkOptions.threshold ?? 1;
  const copies = visible.reduce((sum, c) => sum + c.quantity, 0);
  const total = visible.reduce((sum, c) => sum + c.lineTotal, 0);

  const lines = [
    'BULK BIN LIST',
    `Under $${threshold.toFixed(2)} · ${copies} copies · ~$${total.toFixed(2)}`,
    ''.padEnd(40, '='),
    '',
  ];

  for (const card of visible) {
    const where = card.setCode ? ` — ${card.setCode.toUpperCase()} #${card.collectorNumber}` : '';
    const holders = (card.heldBy || []).map((d) => d.deckName).filter(Boolean);
    const note = card.contested
      ? `  (own ${card.contested}${holders.length ? `, in ${holders.join(', ')}` : ''})`
      : '';
    // Padded so the colours line up in a monospaced paste the same way the
    // pips line up on screen. {C} for colourless, as the pips do.
    const colors = `{${(card.colors || []).join('') || 'C'}}`.padEnd(7);
    lines.push(`[ ] ${colors} ${card.quantity}x ${card.name}${where} — $${card.price.toFixed(2)}${note}`);
  }

  if (bulkData.unpriced.length) {
    lines.push('', 'No price data (check these by hand):');
    for (const card of bulkData.unpriced) {
      lines.push(`[ ] ${card.quantity}x ${card.name}`);
    }
  }

  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    showToast('Bulk list copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy to clipboard', 'error');
  });
}

async function refreshShoppingData() {
  // Deselecting every deck no longer means there is nothing to fetch: the
  // wanted list comes back either way, and short-circuiting here is what used
  // to blank the page the moment the last deck was unticked.
  try {
    showLoading();
    const result = await api.getShoppingList(Array.from(selectedDeckIds));
    shoppingData = result;
    renderShoppingList();
    hideLoading();
  } catch (error) {
    hideLoading();
    showError('Failed to refresh shopping data: ' + error.message);
  }
}

/**
 * The count and the clear button on the wanted-list section.
 *
 * Reads from the merged payload rather than tracking its own copy — the list
 * on screen and the number above it come from the same fetch, so they cannot
 * disagree after an add.
 */
function renderWantedSummary() {
  const count = document.getElementById('shopping-wanted-count');
  const clear = document.getElementById('shopping-wanted-clear');
  const total = shoppingData?.totalWanted || 0;

  if (count) {
    count.textContent = total === 0
      ? 'Nothing on your list yet'
      : `${total} card${total === 1 ? '' : 's'} on your list`;
  }

  clear?.classList.toggle('hidden', total === 0);
}

function applyFiltersToData(data) {
  if (!data || !data.sets) return data;

  let filteredSets = data.sets.map(set => {
    // Filter cards within each set
    let filteredCards = set.cards.filter(card => {
      // Found cards drop out of the by-set list, and out of the totals and
      // the Mana Pool cart with it — this is the buying view, and quoting a
      // card already sitting in your pocket is the bug. Pressing the tick
      // again is done from the found-pile bar above the list.
      const cardKey = `${card.printingId}`;
      if (isFound(card.cardId) || sessionState.skipped.has(cardKey)) {
        return false;
      }

      // Price filter
      if (filters.priceMin !== null && card.price < filters.priceMin) return false;
      if (filters.priceMax !== null && card.price > filters.priceMax) return false;

      // Rarity filter
      if (filters.rarity && card.rarity && card.rarity.toLowerCase() !== filters.rarity) return false;

      // Color filter
      if (filters.colors && card.colorIdentity && !card.colorIdentity.includes(filters.colors)) return false;

      return true;
    });

    // Budget mode: sort cards by price (cheapest first)
    if (filters.budgetMode) {
      filteredCards = filteredCards.sort((a, b) => (a.price || 999) - (b.price || 999));
    }

    return {
      ...set,
      cards: filteredCards,
      // Priced per copy needed, not per distinct card. A list that quotes one
      // copy of a four-of is not an estimate of anything.
      totalPrice: filteredCards.reduce(
        (sum, card) => sum + (card.price || 0) * (card.quantityNeeded || 1),
        0
      ),
      cardCount: filteredCards.length,
    };
  });

  // Filter out sets with no cards
  filteredSets = filteredSets.filter(set => set.cards.length > 0);

  // Apply set search filter
  if (filters.setSearch) {
    filteredSets = filteredSets.filter(set =>
      set.setName.toLowerCase().includes(filters.setSearch)
    );
  }

  // Sort sets
  filteredSets.sort((a, b) => {
    switch (filters.sortBy) {
      case 'totalPrice':
        return (b.totalPrice || 0) - (a.totalPrice || 0);
      case 'releaseDate':
        return (b.releaseDate || '').localeCompare(a.releaseDate || '');
      case 'cardCount':
        return b.cardCount - a.cardCount;
      case 'setName':
      default:
        return a.setName.localeCompare(b.setName);
    }
  });

  return {
    ...data,
    sets: filteredSets,
    totalCards: filteredSets.reduce((sum, set) => sum + set.cards.length, 0),
    totalPrice: filteredSets.reduce((sum, set) => sum + (set.totalPrice || 0), 0),
  };
}

function renderShoppingList() {
  const container = document.getElementById('shopping-list-container');
  const stats = document.getElementById('shopping-stats');

  renderWantedSummary();

  // Only genuinely-nothing is empty now — no decks picked *and* nothing on the
  // wanted list.
  if (!shoppingData || (selectedDeckIds.size === 0 && !(shoppingData.totalWanted > 0))) {
    container.innerHTML = `
      <div style="text-align: center; padding: 3rem; color: var(--text-secondary);">
        <i class="ph ph-shopping-cart" style="font-size: 4rem; opacity: 0.3;"></i>
        <h3>Nothing to shop for yet</h3>
        <p>Pick a deck above, or search for a card you want.</p>
      </div>
    `;
    stats.innerHTML = '';
    return;
  }

  // Apply filters
  const filteredData = applyFiltersToData(shoppingData);

  if (filteredData.sets.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 3rem; color: var(--text-secondary);">
        <i class="ph ph-check-circle" style="font-size: 4rem; opacity: 0.3;"></i>
        <h3>No cards match your filters!</h3>
        <p>Try adjusting your filters or you might own everything already.</p>
      </div>
    `;
    stats.innerHTML = '';
    return;
  }

  // Render statistics
  stats.innerHTML = `
    <div class="shopping-stat">
      <i class="ph ph-cards"></i>
      <div>
        <div class="stat-value">${filteredData.totalCards}</div>
        <div class="stat-label">Cards Needed</div>
      </div>
    </div>
    <div class="shopping-stat">
      <i class="ph ph-stack"></i>
      <div>
        <div class="stat-value">${filteredData.sets.length}</div>
        <div class="stat-label">Sets</div>
      </div>
    </div>
    <div class="shopping-stat">
      <i class="ph ph-currency-dollar"></i>
      <div>
        <div class="stat-value">$${(filteredData.totalPrice || 0).toFixed(2)}</div>
        <div class="stat-label">Total Est. Cost</div>
      </div>
    </div>
    <div class="shopping-stat">
      <i class="ph ph-folder"></i>
      <div>
        <div class="stat-value">${selectedDeckIds.size}</div>
        <div class="stat-label">Decks Selected</div>
      </div>
    </div>
  `;

  // Show optimizer section when there are cards to buy
  const optimizerSection = document.getElementById('shopping-optimizer-section');
  if (optimizerSection) {
    optimizerSection.style.display = filteredData.totalCards > 0 ? '' : 'none';
    document.getElementById('shopping-optimizer-results').innerHTML = '';
  }

  // Render expand/collapse all buttons + sets
  container.innerHTML = `
    <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap;">
      <button id="expand-all-sets" class="btn btn-secondary btn-sm">
        <i class="ph ph-caret-down"></i> Expand All
      </button>
      <button id="collapse-all-sets" class="btn btn-secondary btn-sm">
        <i class="ph ph-caret-up"></i> Collapse All
      </button>
    </div>
    ${filteredData.sets.map(set => `
      <div class="shopping-set-card">
        <div class="shopping-set-header" data-set-code="${set.setCode}">
          <div class="shopping-set-info">
            <h3>${set.setName} (${set.setCode.toUpperCase()})</h3>
            <span class="shopping-set-count">
              ${set.cards.length} card${set.cards.length !== 1 ? 's' : ''}
              ${set.totalPrice ? ` • $${set.totalPrice.toFixed(2)}` : ''}
            </span>
          </div>
          <i class="ph ph-caret-down shopping-set-toggle"></i>
        </div>
        <div class="shopping-set-content collapsed" id="set-${set.setCode}">
          ${renderSetCards(set.cards)}
        </div>
      </div>
    `).join('')}
  `;

  // Add expand/collapse all functionality
  document.getElementById('expand-all-sets').addEventListener('click', () => {
    document.querySelectorAll('.shopping-set-content').forEach(content => {
      content.classList.remove('collapsed');
    });
    document.querySelectorAll('.shopping-set-toggle').forEach(toggle => {
      toggle.classList.add('rotated');
    });
  });

  document.getElementById('collapse-all-sets').addEventListener('click', () => {
    document.querySelectorAll('.shopping-set-content').forEach(content => {
      content.classList.add('collapsed');
    });
    document.querySelectorAll('.shopping-set-toggle').forEach(toggle => {
      toggle.classList.remove('rotated');
    });
  });

  // Add toggle functionality for individual sets
  document.querySelectorAll('.shopping-set-header').forEach(header => {
    header.addEventListener('click', () => {
      const setCode = header.dataset.setCode;
      const content = document.getElementById(`set-${setCode}`);
      const toggle = header.querySelector('.shopping-set-toggle');

      content.classList.toggle('collapsed');
      toggle.classList.toggle('rotated');
    });
  });
}

function renderSetCards(cards) {
  if (filters.compactView) {
    // Compact view - just a simple list
    return `
      <div class="shopping-cards-compact">
        ${cards.map(card => {
          const deckDetails = card.decks.map(d => {
            const boardIcon = d.boardType === 'sideboard' ? '📋' : d.boardType === 'maybeboard' ? '🤔' : '📚';
            return `${d.deckName} (${boardIcon} ${d.boardType})`;
          }).join(', ');
          const totalQuantity = card.quantityNeeded || 1;
          const isHighPriority = card.decks.length >= 3;
          const cardKey = `${card.printingId}`;

          return `
            <div class="shopping-card-compact ${isHighPriority ? 'high-priority' : ''}" data-card-key="${cardKey}">
              <div class="compact-card-main">
                <span class="compact-card-qty">${totalQuantity}x</span>
                ${card.wanted ? '<span class="wanted-badge" title="On your wanted list"><i class="ph ph-bookmark-simple"></i></span>' : ''}
                <span class="compact-card-name">${card.name}</span>
                ${ownedHint(card)}
                <span class="compact-card-number">#${card.collectorNumber || '?'}</span>
                ${card.price ? `<span class="compact-card-price">$${card.price.toFixed(2)}</span>` : ''}
                ${isHighPriority ? `<span class="compact-priority-badge" title="Format staple!"><i class="ph ph-star-fill"></i></span>` : ''}
              </div>
              <div class="compact-card-details">
                <span class="compact-card-decks">${deckDetails || (card.wanted ? 'On your wanted list' : '')}</span>
                <div class="compact-card-actions">
                  <button class="btn-icon found-btn" data-card-key="${cardKey}" data-card-id="${card.cardId}" title="Found it!">
                    <i class="ph ph-check"></i>
                  </button>
                  <button class="btn-icon skip-btn" data-card-key="${cardKey}" title="Skip">
                    <i class="ph ph-x"></i>
                  </button>
                  <a href="${manaPoolCardUrl(card.name)}" target="_blank" rel="noopener" class="btn-icon" title="Buy on Mana Pool" style="text-decoration:none;color:inherit;">
                    <i class="ph ph-shopping-cart-simple"></i>
                  </a>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // Full view with images
  return `
    <div class="shopping-cards-list">
      ${cards.map(card => {
        const deckDetails = card.decks.map(d => {
          const boardIcon = d.boardType === 'sideboard' ? '📋' : d.boardType === 'maybeboard' ? '🤔' : '📚';
          const boardLabel = d.boardType.charAt(0).toUpperCase() + d.boardType.slice(1);
          return `<div style="margin-top: 0.25rem;">
            ${boardIcon} <strong>${d.deckName}</strong>: ${boardLabel} (${d.quantity}x)
          </div>`;
        }).join('');
        const totalQuantity = card.quantityNeeded || 1;
        const isMultiDeck = card.decks.length > 1;
        const isHighPriority = card.decks.length >= 3; // Format staple
        const cardKey = `${card.printingId}`;

        return `
          <div class="shopping-card-item ${isHighPriority ? 'high-priority' : ''}" data-card-key="${cardKey}">
            <div class="shopping-card-image">
              ${card.imageUrl ? `
                <img
                  src="${card.imageUrl}"
                  alt="${card.name}"
                  loading="lazy"
                  onerror="this.style.display='none'"
                />
              ` : ''}
            </div>
            <div class="shopping-card-info">
              <div class="shopping-card-name-row">
                <span class="shopping-card-name">${card.name}</span>
                ${ownedHint(card)}
                ${isMultiDeck ? `
                  <span class="multi-deck-badge ${isHighPriority ? 'high-priority-badge' : ''}"
                        title="${isHighPriority ? 'Format staple! Appears in ' + card.decks.length + ' decks' : 'Appears in ' + card.decks.length + ' decks'}">
                    <i class="ph ph-stack"></i> ${card.decks.length}
                  </span>
                ` : ''}
              </div>
              <div class="shopping-card-mana">${formatMana(card.manaCost || '')}</div>
              <div class="shopping-card-type">${card.typeLine || ''}</div>
              <div class="shopping-card-rarity">
                <span class="rarity-badge rarity-${card.rarity ? card.rarity.toLowerCase() : 'common'}">
                  ${card.rarity || 'Common'}
                </span>
                <span class="collector-number">#${card.collectorNumber || '?'}</span>
                ${card.price ? `<span class="card-price">$${card.price.toFixed(2)}</span>` : ''}
              </div>
              ${card.decks.length ? `
                <div class="shopping-card-decks">
                  <strong>Needed for:</strong>
                  ${deckDetails}
                </div>
              ` : ''}
              ${card.wanted ? `
                <div class="shopping-card-wanted">
                  <strong>On your list</strong>
                  ${card.wanted.note ? `<div class="shopping-card-wanted-note">${escapeHtml(card.wanted.note)}</div>` : ''}
                  ${card.wanted.alreadyOwned ? '<div class="shopping-card-wanted-owned">You already own a copy</div>' : ''}
                  <div class="shopping-wanted-qty">
                    <button class="btn-icon wanted-step" data-wanted-id="${card.wanted.id}" data-to="${card.wanted.quantity - 1}" title="One fewer">
                      <i class="ph ph-minus"></i>
                    </button>
                    <span class="shopping-wanted-qty-value">${card.wanted.quantity}</span>
                    <button class="btn-icon wanted-step" data-wanted-id="${card.wanted.id}" data-to="${card.wanted.quantity + 1}" title="One more">
                      <i class="ph ph-plus"></i>
                    </button>
                    <button class="btn-icon wanted-remove" data-wanted-id="${card.wanted.id}" title="Take off the list">
                      <i class="ph ph-trash"></i>
                    </button>
                  </div>
                </div>
              ` : ''}
              ${totalQuantity > 1 ? `
                <div class="shopping-card-quantity">
                  <strong>Copies to buy:</strong> ${totalQuantity}x
                  ${card.price ? ` • $${(card.price * totalQuantity).toFixed(2)}` : ''}
                </div>
              ` : ''}
              <div class="shopping-card-actions">
                <button class="btn btn-sm btn-success found-btn" data-card-key="${cardKey}" data-card-id="${card.cardId}">
                  <i class="ph ph-check"></i> Found It!
                </button>
                <button class="btn btn-sm btn-secondary skip-btn" data-card-key="${cardKey}">
                  <i class="ph ph-x"></i> Skip
                </button>
                <a href="${manaPoolCardUrl(card.name)}" target="_blank" rel="noopener" class="btn btn-sm btn-secondary" title="Buy on Mana Pool" style="text-decoration:none;">
                  <i class="ph ph-shopping-cart-simple"></i> Mana Pool
                </a>
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Export shopping list
function exportShoppingList() {
  if (!shoppingData || shoppingData.sets.length === 0) {
    showToast('No cards to export', 'warning');
    return;
  }

  const filteredData = applyFiltersToData(shoppingData);
  let exportText = `SHOPPING LIST\n`;
  exportText += `Generated: ${new Date().toLocaleString()}\n`;
  exportText += `Total Cards: ${filteredData.totalCards}\n`;
  exportText += `Total Est. Cost: $${(filteredData.totalPrice || 0).toFixed(2)}\n`;
  exportText += `\n${'='.repeat(50)}\n\n`;

  filteredData.sets.forEach(set => {
    exportText += `${set.setName} (${set.setCode.toUpperCase()})\n`;
    exportText += `${set.cards.length} cards • $${(set.totalPrice || 0).toFixed(2)}\n`;
    exportText += `${'-'.repeat(50)}\n`;

    set.cards.forEach(card => {
      const totalQty = card.quantityNeeded || 1;
      const deckDetails = card.decks.map(d => `${d.deckName} (${d.boardType}, ${d.quantity}x)`).join(', ');
      const price = card.price ? ` • $${(card.price * totalQty).toFixed(2)}` : '';
      exportText += `${totalQty}x ${card.name} (#${card.collectorNumber})${price}\n`;

      // A wanted card has no deck to name, and printing "Decks: " with
      // nothing after it in a list you take to a shop reads as a bug.
      if (deckDetails) {
        exportText += `   Decks: ${deckDetails}\n`;
      } else if (card.wanted) {
        exportText += `   Wanted${card.wanted.note ? `: ${card.wanted.note}` : ''}\n`;
      }
    });
    exportText += `\n`;
  });

  // Copy to clipboard
  navigator.clipboard.writeText(exportText).then(() => {
    showToast('Shopping list copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy to clipboard', 'error');
  });
}

// ---------------------------------------------------------------------------
// The found pile
// ---------------------------------------------------------------------------

/** Is this card already in the pile? Card-level, like the pile itself. */
function isFound(cardId) {
  return cardId != null && foundPile.has(Number(cardId));
}

/**
 * Read the pile from the server.
 *
 * Re-read on every load of the page rather than kept in memory, because the
 * pile is filled on a phone in a shop and reviewed on a desktop at home —
 * two devices, one list, which is the whole point of persisting it.
 */
async function loadFoundPile() {
  try {
    const result = await api.getFoundPile();
    foundPile = new Map((result.found || []).map((row) => [Number(row.cardId), row]));
  } catch (error) {
    console.error('Failed to load found pile:', error);
    foundPile = new Map();
  }
  renderFoundBar();
}

/**
 * Tick a card, or untick it.
 *
 * The server call is what makes it real, so the repaint waits for it: a tick
 * that looked like it saved and did not is worse than a slow button, when the
 * thing being protected is a trip you cannot repeat.
 */
async function toggleFoundCard(cardId) {
  const id = Number(cardId);

  try {
    const result = await api.toggleFoundCard(id);

    if (result.found) {
      foundPile.set(id, { cardId: id, name: result.name, quantity: result.quantity || 1 });
      showToast(`${result.name} added to your found pile`, 'success', 1500);
    } else {
      foundPile.delete(id);
      showToast('Unmarked', 'info', 1200);
    }
  } catch (error) {
    console.error('Failed to toggle found card:', error);
    showToast('Could not save that — try again', 'error', 2500);
    return;
  }

  renderFoundBar();
  repaintActiveList();
}

/**
 * The bar above both lists.
 *
 * Hidden while the pile is empty: an always-present "0 found" is noise on
 * every visit that is not a shopping trip.
 */
function renderFoundBar() {
  const bar = document.getElementById('shopping-found-bar');
  if (!bar) return;

  if (foundPile.size === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }

  const rows = [...foundPile.values()];
  const copies = rows.reduce((sum, row) => sum + (row.quantity || 1), 0);
  const open = bar.dataset.open === 'true';

  bar.classList.remove('hidden');
  bar.innerHTML = `
    <div class="shopping-found-summary">
      <span class="shopping-found-count">
        <i class="ph ph-hand-grabbing"></i>
        <strong>${rows.length}</strong> found · <strong>${copies}</strong> copies
      </span>
      <span class="shopping-found-note">Not in your collection yet — review to add them.</span>
      <button class="btn btn-sm btn-secondary" id="found-toggle-review">
        ${open ? 'Hide' : 'Review'} <i class="ph ph-caret-${open ? 'up' : 'down'}"></i>
      </button>
    </div>
    ${open ? foundDrawer(rows) : ''}
  `;
}

/**
 * The review drawer.
 *
 * Quantities are editable here and nowhere else: the tick out in a shop is a
 * yes/no, and a stepper on a row you are tapping past a box is a misclick
 * waiting to happen. Adding to the collection is one deliberate press and goes
 * through the same bulk add the paste box uses, so printings resolve the way
 * they do everywhere else.
 */
function foundDrawer(rows) {
  return `
    <div class="shopping-found-drawer">
      <ul class="shopping-found-list">
        ${rows.map((row) => `
          <li class="shopping-found-row">
            <span class="shopping-found-qty">
              <button class="btn-icon found-step" data-card-id="${row.cardId}" data-to="${(row.quantity || 1) - 1}" title="One fewer">
                <i class="ph ph-minus"></i>
              </button>
              <strong>${row.quantity || 1}</strong>
              <button class="btn-icon found-step" data-card-id="${row.cardId}" data-to="${(row.quantity || 1) + 1}" title="One more">
                <i class="ph ph-plus"></i>
              </button>
            </span>
            <span class="shopping-found-name">${escapeHtml(row.name)}</span>
            <button class="btn-icon found-remove" data-card-id="${row.cardId}" title="Take off the pile">
              <i class="ph ph-x"></i>
            </button>
          </li>
        `).join('')}
      </ul>
      <div class="shopping-found-actions">
        <button class="btn btn-primary btn-sm" id="found-add-all">
          <i class="ph ph-plus-circle"></i> Add all to collection
        </button>
        <button class="btn btn-secondary btn-sm" id="found-copy">
          <i class="ph ph-copy"></i> Copy list
        </button>
        <button class="btn btn-secondary btn-sm" id="found-clear">
          <i class="ph ph-trash"></i> Clear pile
        </button>
      </div>
      <p class="shopping-found-hint">
        Adding resolves each card by name to its default printing. If the copy
        you found is from a different set, add that printing from the card page
        instead and take the row off this pile.
      </p>
    </div>
  `;
}

/**
 * Turn the pile into inventory.
 *
 * The pile is only cleared once the add reports every row landed, and a
 * partial result leaves it alone: a list of what you are actually holding is
 * worth more than a tidy empty pile, and the failures are exactly the rows
 * that still need a decision.
 */
async function addFoundPileToCollection() {
  const rows = [...foundPile.values()];
  if (rows.length === 0) return;

  const ok = await confirmDialog({
    title: 'Add found cards to your collection?',
    message: `${rows.length} card(s) will be added, each resolved by name to its default printing.`,
    confirmText: 'Add them',
  });
  if (!ok) return;

  try {
    showLoading();
    const result = await api.bulkAddToInventory(
      rows.map((row) => ({ cardName: row.name, quantity: row.quantity || 1 }))
    );

    const added = result?.added ?? result?.result?.added ?? 0;
    const failed = result?.failed ?? result?.result?.failed ?? 0;

    if (failed > 0) {
      showToast(`Added ${added}; ${failed} could not be matched and are still on the pile`, 'warning', 4000);
    } else {
      await api.clearFoundPile();
      foundPile.clear();
      showToast(`Added ${added} card(s) to your collection`, 'success');
    }
  } catch (error) {
    console.error('Failed to add found pile:', error);
    showError('Could not add those cards — the pile is untouched');
  } finally {
    hideLoading();
    renderFoundBar();
    await refreshActiveView();
  }
}

// Found-pile controls. Delegated, because the bar repaints on every change.
document.addEventListener('click', async (e) => {
  const bar = document.getElementById('shopping-found-bar');
  if (!bar) return;

  if (e.target.closest('#found-toggle-review')) {
    bar.dataset.open = bar.dataset.open === 'true' ? 'false' : 'true';
    renderFoundBar();
    return;
  }

  const step = e.target.closest('.found-step');
  if (step) {
    const cardId = Number(step.dataset.cardId);
    const to = Number(step.dataset.to);

    try {
      const result = await api.setFoundQuantity(cardId, to);
      if (result.found) {
        const row = foundPile.get(cardId);
        if (row) row.quantity = result.quantity;
      } else {
        foundPile.delete(cardId);
      }
    } catch (error) {
      console.error('Failed to set found quantity:', error);
      showToast('Could not save that — try again', 'error', 2500);
      return;
    }

    renderFoundBar();
    repaintActiveList();
    return;
  }

  const remove = e.target.closest('.found-remove');
  if (remove) {
    await toggleFoundCard(Number(remove.dataset.cardId));
    return;
  }

  if (e.target.closest('#found-add-all')) {
    await addFoundPileToCollection();
    return;
  }

  if (e.target.closest('#found-copy')) {
    const text = [...foundPile.values()]
      .map((row) => `${row.quantity || 1} ${row.name}`)
      .join('\n');

    navigator.clipboard.writeText(text)
      .then(() => showToast('Found pile copied to clipboard', 'success'))
      .catch(() => showToast('Failed to copy to clipboard', 'error'));
    return;
  }

  if (e.target.closest('#found-clear')) {
    const ok = await confirmDialog({
      title: 'Clear the found pile?',
      message: 'This forgets what you picked up. It does not change your collection.',
      confirmText: 'Clear',
      danger: true,
    });
    if (!ok) return;

    try {
      await api.clearFoundPile();
      foundPile.clear();
    } catch (error) {
      console.error('Failed to clear found pile:', error);
      showToast('Could not clear the pile', 'error', 2500);
      return;
    }

    renderFoundBar();
    await refreshActiveView();
  }
});

// Session tracking setup
document.addEventListener('click', async (e) => {
  const foundBtn = e.target.closest('.found-btn');
  if (foundBtn) {
    const cardId = parseInt(foundBtn.dataset.cardId, 10);

    // No card id means nothing can be recorded against a card, so say so
    // rather than hiding the row and looking like it worked.
    if (!Number.isFinite(cardId)) {
      showToast('Cannot mark this row found', 'warning', 2000);
      return;
    }

    await toggleFoundCard(cardId);
  }

  if (e.target.closest('.skip-btn')) {
    const btn = e.target.closest('.skip-btn');
    const cardKey = btn.dataset.cardKey;
    sessionState.skipped.add(cardKey);
    showToast('Card skipped', 'info', 1500);
    repaintActiveList();
  }

  // Wanted-list quantity. Stepping to zero removes the row, which is what the
  // minus button on a single copy is asking for.
  const step = e.target.closest('.wanted-step');
  if (step) {
    await updateWanted(parseInt(step.dataset.wantedId, 10), parseInt(step.dataset.to, 10));
  }

  const remove = e.target.closest('.wanted-remove');
  if (remove) {
    await updateWanted(parseInt(remove.dataset.wantedId, 10), 0);
  }
});
