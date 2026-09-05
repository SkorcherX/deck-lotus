import { parseCardLine } from '../../../src/shared/cardLines.js';
import api from '../services/api.js';
import { showLoading, hideLoading, formatMana, showToast, showError, confirmDialog, debounce } from '../utils/ui.js';
import { showCardDetail } from './cards.js';
import { zoomButton } from '../utils/cardZoom.js';

// 54 = 9 rows of 6 at the grid's usual column count, so a full page ends on
// a complete row instead of trailing off mid-row.
const PAGE_SIZE = 54;

let inventoryData = null;
let currentPage = 1;
let totalPages = 1;
let viewMode = 'grid'; // 'grid' or 'list'
let filters = {
  // One entry per committed chip. `names` all have to match (narrowing);
  // `sets` match any of the listed codes (widening) — a card is only ever
  // printed in one set per printing, so ANDing them would match nothing.
  names: [],
  // What is currently in the search box but has not been pinned. It filters
  // exactly like a chip — narrowing, alongside them — but it is replaced by
  // the next thing typed rather than added to. That is the whole difference
  // between looking up another card and refining the search you are in.
  liveName: '',
  sets: [],
  colors: [],
  type: 'all',
  sort: 'name',
  availability: 'all',
  commander: 'all',
};
let showPrices = localStorage.getItem('inventoryShowPrices') === 'true';
// Endless scroll replaces the pager: pages are appended as the reader reaches
// the bottom rather than swapped in. `loadingMore` stops the observer firing a
// second fetch for the page already in flight.
let endlessScroll = localStorage.getItem('inventoryEndlessScroll') === 'true';
let loadingMore = false;
let scrollObserver = null;
let quickSearchTimeout = null;
// code -> set name, for labelling set chips. Empty until the sets the user
// owns have loaded; an unrecognised code still filters, it just shows bare.
let ownedSetNames = new Map();
let selectedCards = new Set(); // Track selected card IDs for multi-select
let selectMode = false; // Whether multi-select mode is active

// Admin cross-user inventory view. selectedUserIds is null for "just me"
// (the normal, non-admin path); once set, loadInventoryData fetches through
// the admin endpoints instead of the regular per-user ones.
let currentUserId = null;
let allUsers = [];
let selectedUserIds = null;

export function setupInventory() {
  // Load inventory data when page is shown
  window.addEventListener('page:inventory', async () => {
    await setupAdminUserFilter();
    await Promise.all([loadOwnedSetOptions(), loadInventoryData()]);
  });

  // Setup filter listeners
  setupFilterListeners();

  // Setup bulk add modal
  setupBulkAddModal();

  // Setup bulk remove modal
  setupBulkRemoveModal();

  // Setup export modal
  setupExportModal();

  // Setup quick search
  setupQuickSearch();

  // Setup view toggle
  setupViewToggle();

  // Setup price toggle
  setupPriceToggle();

  // Setup pagination
  setupPagination();

  // Setup endless scroll
  setupEndlessScroll();

  // Setup bulk actions
  setupBulkActions();
}

function setupFilterListeners() {
  setupSearchChips();

  // Sort
  const sortSelect = document.getElementById('inventory-sort');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      filters.sort = e.target.value;
      currentPage = 1;
      // Sorting by price with prices hidden orders rows by an invisible value,
      // so reveal them. Leaving them on is harmless if the user sorts away again.
      if (filters.sort.startsWith('price_') && !showPrices) {
        setShowPrices(true, { render: false }); // loadInventoryData renders below
      }
      loadInventoryData();
    });
  }

  // Type
  const typeSelect = document.getElementById('inventory-type');
  if (typeSelect) {
    typeSelect.addEventListener('change', (e) => {
      filters.type = e.target.value;
      currentPage = 1;
      loadInventoryData();
    });
  }

  // Availability
  const availabilitySelect = document.getElementById('inventory-availability');
  if (availabilitySelect) {
    availabilitySelect.addEventListener('change', (e) => {
      filters.availability = e.target.value;
      currentPage = 1;
      loadInventoryData();
    });
  }

  // Commander eligibility
  const commanderSelect = document.getElementById('inventory-commander');
  if (commanderSelect) {
    commanderSelect.addEventListener('change', (e) => {
      filters.commander = e.target.value;
      currentPage = 1;
      loadInventoryData();
    });
  }

  // Color checkboxes
  const colorCheckboxes = document.querySelectorAll('#inventory-colors input[type="checkbox"]');
  colorCheckboxes.forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      filters.colors = Array.from(document.querySelectorAll('#inventory-colors input[type="checkbox"]:checked'))
        .map(cb => cb.value);
      currentPage = 1;
      loadInventoryData();
    });
  });
}

// The search box filters by card name or by set code depending on the mode
// dropdown beside it.
//
// Typing filters straight away and REPLACES whatever was typed before it.
// Pressing Enter pins the current term as a chip, and pinned terms stack:
// filter to a set, flip the dropdown, then search names within it.
//
// It used to be Enter or nothing, which meant every search appended. Since
// name chips all have to match, looking up a second card after a first one
// reliably returned nothing at all — the two terms were being read as one
// card's name. Making the unpinned term transient fixes that without giving
// up the narrowing, because narrowing is now something you ask for.
function setupSearchChips() {
  const input = document.getElementById('inventory-search');
  const mode = document.getElementById('inventory-search-mode');
  const chips = document.getElementById('inventory-filter-chips');
  if (!input || !mode || !chips) return;

  const applyMode = () => {
    const isSet = mode.value === 'set';
    // Names filter as you type, so the old "press Enter" hint would be
    // describing the wrong thing. Set codes still need it: a partial code is
    // not a filter worth running, so set mode really does wait for Enter.
    input.placeholder = isSet
      ? 'Filter by set code, press Enter...'
      : 'Filter by name...';
    // The set list is only a useful suggestion in set mode; leaving it
    // attached in name mode offers set codes while typing a card name.
    if (isSet) {
      input.setAttribute('list', 'inventory-set-codes');
    } else {
      input.removeAttribute('list');
    }
  };

  mode.addEventListener('change', () => {
    // The live term belongs to the mode it was typed in — carrying a
    // half-typed card name over into set mode would filter by a set code
    // that does not exist and silently empty the list.
    setLiveTerm('', mode.value);
    input.value = '';
    applyMode();
    input.focus();
  });
  applyMode();

  input.addEventListener('input', debounce(() => {
    setLiveTerm(input.value, mode.value);
  }, 250));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();

      // Pinning and the live term are the same value, so clear the live one
      // first — otherwise the term is applied twice, once as a chip and once
      // as itself, which is harmless for results and wrong in the count.
      const value = input.value;
      if (value.trim()) {
        clearLiveTerm();
        input.value = '';
        addFilterChip(mode.value, value);
      }
      return;
    }

    // Backspace in an empty box takes back the chip you just pinned.
    if (e.key === 'Backspace' && input.value === '') {
      const last = activeChips().pop();
      if (last) {
        e.preventDefault();
        removeFilterChip(last.kind, last.value);
      }
    }
  });

  chips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-chip-remove]');
    if (!btn) return;
    removeFilterChip(btn.dataset.kind, btn.dataset.value);
  });

  renderFilterChips();
}

/**
 * Apply what is currently typed, without pinning it.
 *
 * Set mode is deliberately not filtered live: a set code is only meaningful
 * once it is complete, and filtering on "M" then "M1" then "M10" empties the
 * list twice on the way to an answer. Names are the opposite — every prefix
 * of a name is a useful filter.
 */
function setLiveTerm(rawValue, mode) {
  const value = mode === 'set' ? '' : String(rawValue).trim();
  if (value === filters.liveName) return;

  filters.liveName = value;
  currentPage = 1;
  loadInventoryData();
}

/** Drop the live term without triggering a fetch — for callers about to do one. */
function clearLiveTerm() {
  filters.liveName = '';
}

// Chips in the order they were committed, so backspace removes the newest.
function activeChips() {
  return [
    ...filters.sets.map((value) => ({ kind: 'set', value })),
    ...filters.names.map((value) => ({ kind: 'name', value })),
  ];
}

// Returns true when the term was accepted, so the caller knows to clear the
// box. A blank or already-present term is a no-op rather than a duplicate.
function addFilterChip(kind, rawValue) {
  const value = kind === 'set'
    ? String(rawValue).trim().toUpperCase()
    : String(rawValue).trim();
  if (!value) return false;

  const list = kind === 'set' ? filters.sets : filters.names;
  const exists = list.some((entry) => entry.toLowerCase() === value.toLowerCase());
  if (exists) return true;

  list.push(value);
  currentPage = 1;
  renderFilterChips();
  loadInventoryData();
  return true;
}

function removeFilterChip(kind, value) {
  const list = kind === 'set' ? filters.sets : filters.names;
  const index = list.findIndex((entry) => entry === value);
  if (index === -1) return;

  list.splice(index, 1);
  currentPage = 1;
  renderFilterChips();
  loadInventoryData();
}

function renderFilterChips() {
  const container = document.getElementById('inventory-filter-chips');
  if (!container) return;

  const chips = activeChips();
  container.classList.toggle('hidden', chips.length === 0);

  container.innerHTML = chips.map(({ kind, value }) => {
    const setName = kind === 'set' ? ownedSetNames.get(value) : null;
    const label = kind === 'set'
      ? `Set: ${escapeHtml(value)}${setName ? ` <span class="filter-chip-note">${escapeHtml(setName)}</span>` : ''}`
      : `Name: ${escapeHtml(value)}`;

    return `
      <span class="filter-chip filter-chip-${kind}">
        ${label}
        <button
          type="button"
          class="filter-chip-remove"
          data-chip-remove
          data-kind="${kind}"
          data-value="${escapeHtml(value)}"
          aria-label="Remove filter ${escapeHtml(value)}"
        >&times;</button>
      </span>
    `;
  }).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

// Suggestions for the set-code box, and the code -> name map the set chips
// label themselves with. Failure is not worth surfacing: the filter still
// works when typed by hand, it just loses the autocomplete.
async function loadOwnedSetOptions() {
  const datalist = document.getElementById('inventory-set-codes');
  if (!datalist) return;

  try {
    const { sets = [] } = await api.getInventorySets();
    ownedSetNames = new Map(sets.map((set) => [set.code.toUpperCase(), set.name]));
    datalist.innerHTML = sets.map((set) => `
      <option value="${escapeHtml(set.code.toUpperCase())}">${escapeHtml(set.name)}</option>
    `).join('');
    renderFilterChips();
  } catch (error) {
    console.error('Failed to load owned sets for filter:', error);
  }
}

// Fetches the current user's admin status once per page visit and, for
// admins, renders the "Viewing Inventory For" checklist. Non-admins never see
// the control — their own inventory is the only thing they can view.
async function setupAdminUserFilter() {
  const row = document.getElementById('inventory-admin-user-filter');
  const checklist = document.getElementById('inventory-user-checklist');
  if (!row || !checklist) return;

  try {
    const profile = await api.getProfile();
    currentUserId = profile.user.id;

    if (!profile.user.is_admin) {
      row.classList.add('hidden');
      selectedUserIds = null;
      return;
    }

    const { users } = await api.getAllUsers();
    allUsers = users;
    row.classList.remove('hidden');

    // "Everyone" leads the list rather than sitting after it: with more than a
    // handful of users the boxes wrap onto several lines, and a toggle you
    // have to hunt for at the end of them is worse than no toggle. It doubles
    // as the state readout — indeterminate whenever the selection is partial —
    // so the row says which of the three cases you are in without counting
    // ticks. If the list keeps growing this is the control that becomes a
    // dropdown; the per-user boxes are what will not scale.
    checklist.innerHTML = `
      <label class="inventory-user-checkbox inventory-user-all">
        <input type="checkbox" id="inventory-user-all" />
        Everyone
      </label>
      ${allUsers.map(u => `
        <label class="inventory-user-checkbox">
          <input type="checkbox" value="${u.id}" ${u.id === currentUserId ? 'checked' : ''} />
          ${u.username}${u.id === currentUserId ? ' (me)' : ''}
        </label>
      `).join('')}
    `;

    syncUserAllToggle();

    if (!checklist.dataset.wired) {
      checklist.dataset.wired = 'true';
      checklist.addEventListener('change', (e) => {
        // "Everyone" drives the others rather than being one of them, so it is
        // applied first and then falls through to the same read-and-load path.
        if (e.target.id === 'inventory-user-all') {
          const on = e.target.checked;
          checklist.querySelectorAll('input[value]').forEach((cb) => {
            // Unticking "Everyone" leaves you looking at your own collection,
            // which is the only selection that is never empty.
            cb.checked = on || parseInt(cb.value, 10) === currentUserId;
          });
        }

        let checked = Array.from(checklist.querySelectorAll('input[value]:checked'))
          .map(cb => parseInt(cb.value, 10));

        // Refuse to leave nobody selected — re-check the box that was just
        // unchecked rather than sending an empty filter to the server.
        if (checked.length === 0) {
          e.target.checked = true;
          checked = [parseInt(e.target.value, 10)];
        }

        // Only me, checked → behave exactly like a regular user (no admin
        // endpoints, no owners breakdown clutter on every card).
        selectedUserIds = (checked.length === 1 && checked[0] === currentUserId) ? null : checked;

        syncUserAllToggle();
        currentPage = 1;
        loadInventoryData();
      });
    }
  } catch (error) {
    console.error('Failed to load admin user filter:', error);
    row.classList.add('hidden');
    selectedUserIds = null;
  }
}

/**
 * Point the "Everyone" box at the current selection: on when every user is
 * ticked, indeterminate when some are, off when only one is.
 */
function syncUserAllToggle() {
  const checklist = document.getElementById('inventory-user-checklist');
  const all = document.getElementById('inventory-user-all');
  if (!checklist || !all) return;

  const boxes = Array.from(checklist.querySelectorAll('input[value]'));
  const checked = boxes.filter((cb) => cb.checked).length;

  all.checked = checked === boxes.length;
  all.indeterminate = checked > 0 && checked < boxes.length;
}

function setupViewToggle() {
  const gridBtn = document.getElementById('inventory-grid-view-btn');
  const listBtn = document.getElementById('inventory-list-view-btn');

  if (gridBtn) {
    gridBtn.addEventListener('click', () => {
      viewMode = 'grid';
      gridBtn.classList.add('active');
      listBtn?.classList.remove('active');
      renderInventory();
    });
  }

  if (listBtn) {
    listBtn.addEventListener('click', () => {
      viewMode = 'list';
      listBtn.classList.add('active');
      gridBtn?.classList.remove('active');
      renderInventory();
    });
  }
}

// Single place that owns the price-visibility state, so the $ button and the
// price sort options cannot drift out of sync.
function setShowPrices(next, { render = true } = {}) {
  showPrices = next;
  localStorage.setItem('inventoryShowPrices', String(showPrices));

  const priceBtn = document.getElementById('inventory-price-toggle');
  if (priceBtn) {
    priceBtn.classList.toggle('active', showPrices);
    priceBtn.setAttribute('aria-pressed', String(showPrices));
    priceBtn.title = showPrices ? 'Hide prices' : 'Show prices';
  }

  // Prices are already in the loaded payload — no refetch needed
  if (render) renderInventory();
}

function setupPriceToggle() {
  const priceBtn = document.getElementById('inventory-price-toggle');
  if (!priceBtn) return;

  // Restore the persisted state on load, without rendering an empty grid
  setShowPrices(showPrices, { render: false });

  priceBtn.addEventListener('click', () => setShowPrices(!showPrices));
}

// How many owned copies of this card are foil, across all its printings.
function getFoilCount(card) {
  return (card.printings || [])
    .filter(p => p.is_foil)
    .reduce((sum, p) => sum + (p.quantity || 0), 0);
}

// Admin multi-user view only: "alice: 2, bob: 1" — who contributes this
// card's copies, so a combined total isn't opaque about whose collection it
// came from.
function getOwnersTooltip(card) {
  if (!card.owners || card.owners.length === 0) return '';
  return card.owners.map(o => `${o.username}: ${o.quantity}`).join(', ');
}

// Summarises the last-synced price for a card row.
// Inventory rows group all owned printings of a card, which can carry different
// prices, so report the dearest unit price and break the rest out in the tooltip.
function getPriceSummary(card) {
  const priced = (card.printings || []).filter(p => p.price > 0);
  if (!priced.length) return null;

  const unit = Math.max(...priced.map(p => p.price));
  const total = priced.reduce((sum, p) => sum + p.price * p.quantity, 0);
  const unpriced = (card.printings || []).length - priced.length;

  const lines = priced.map(p =>
    `${p.set_code?.toUpperCase() || '?'}${p.is_foil ? ' (foil)' : ''} x${p.quantity} — $${p.price.toFixed(2)} ea`
  );
  if (unpriced > 0) lines.push(`${unpriced} printing${unpriced > 1 ? 's' : ''} with no synced price`);
  lines.push(`Total owned value: $${total.toFixed(2)}`);

  return { unit, total, tooltip: lines.join('\n') };
}

// Bottom bar plus its mirror above the grid, so paging through a full page
// of cards doesn't require scrolling down and back up just to reach "Next".
function setupPagination() {
  ['inventory-prev-page', 'inventory-prev-page-top'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        loadInventoryData();
      }
    });
  });

  ['inventory-next-page', 'inventory-next-page-top'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (currentPage < totalPages) {
        currentPage++;
        loadInventoryData();
      }
    });
  });
}

let activePrintingFlyout = null; // Track active flyout

function setupQuickSearch() {
  const searchInput = document.getElementById('inventory-quick-search');
  const resultsContainer = document.getElementById('inventory-quick-results');

  if (!searchInput || !resultsContainer) return;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();

    if (quickSearchTimeout) clearTimeout(quickSearchTimeout);

    if (query.length < 2) {
      resultsContainer.classList.add('hidden');
      resultsContainer.innerHTML = '';
      closePrintingFlyout();
      return;
    }

    quickSearchTimeout = setTimeout(async () => {
      try {
        // Use the general card search - it groups by unique card names
        const result = await api.searchCards(query, 15);
        // Deduplicate by card name (in case API returns multiple printings)
        const uniqueCards = deduplicateCardsByName(result.cards);
        renderQuickSearchResults(uniqueCards);
      } catch (error) {
        console.error('Quick search failed:', error);
      }
    }, 200);
  });

  // Hide results when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.inventory-quick-add') && !e.target.closest('.printing-flyout')) {
      resultsContainer.classList.add('hidden');
      closePrintingFlyout();
    }
  });

  // Show results when focusing input with existing results
  searchInput.addEventListener('focus', () => {
    if (resultsContainer.innerHTML.trim()) {
      resultsContainer.classList.remove('hidden');
    }
  });
}

function deduplicateCardsByName(cards) {
  const seen = new Map();
  for (const card of cards) {
    if (!seen.has(card.name)) {
      seen.set(card.name, card);
    }
  }
  return Array.from(seen.values());
}

function renderQuickSearchResults(cards) {
  const resultsContainer = document.getElementById('inventory-quick-results');
  if (!resultsContainer) return;

  if (!cards || cards.length === 0) {
    resultsContainer.innerHTML = '<div class="quick-result-empty">No cards found</div>';
    resultsContainer.classList.remove('hidden');
    return;
  }

  resultsContainer.innerHTML = cards.map(card => `
    <div class="quick-result-item" data-card-id="${card.id}" data-card-name="${card.name}">
      ${card.image_url ? `
        <img src="${card.large_image_url || card.image_url}"
             class="quick-result-image"
             data-fallback="${card.image_url}"
             alt="${card.name}"
             onerror="this.src=this.dataset.fallback">
      ` : '<div class="quick-result-image-placeholder"></div>'}
      <div class="quick-result-info">
        <span class="quick-result-name">${card.name}</span>
        <span class="quick-result-type">${card.type_line || ''}</span>
      </div>
      <div class="quick-result-mana">${formatMana(card.mana_cost || '')}</div>
      <button class="btn btn-sm btn-secondary show-printings-btn" data-card-id="${card.id}" title="Choose printing">
        <i class="ph ph-caret-right"></i>
      </button>
    </div>
  `).join('');

  resultsContainer.classList.remove('hidden');

  // Add click handlers for showing printings flyout
  resultsContainer.querySelectorAll('.show-printings-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = parseInt(btn.dataset.cardId);
      const itemEl = btn.closest('.quick-result-item');
      await showPrintingsFlyout(cardId, itemEl);
    });
  });

  // Also show printings on row click
  resultsContainer.querySelectorAll('.quick-result-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.show-printings-btn')) return;
      const cardId = parseInt(item.dataset.cardId);
      await showPrintingsFlyout(cardId, item);
    });
  });
}

async function showPrintingsFlyout(cardId, anchorEl) {
  // Close existing flyout
  closePrintingFlyout();

  try {
    // Get all printings for this card
    const result = await api.getCardPrintings(cardId);
    const printings = result.printings || [];

    if (printings.length === 0) {
      showToast('No printings found', 'warning');
      return;
    }

    // Create flyout
    const flyout = document.createElement('div');
    flyout.className = 'printing-flyout';
    flyout.innerHTML = `
      <div class="printing-flyout-header">
        <input type="text" class="printing-flyout-search" placeholder="Filter by set..." autocomplete="off">
        <span class="printing-flyout-count">${printings.length} printings</span>
        <label class="printing-flyout-foil" title="Add the foil version of this printing">
          <input type="checkbox" class="printing-foil-checkbox"> <i class="ph ph-sparkle"></i> Foil
        </label>
      </div>
      <div class="printing-flyout-list">
        ${printings.map(p => `
          <div class="printing-flyout-item" data-printing-id="${p.id}" data-set-code="${p.set_code.toLowerCase()}" data-set-name="${(p.set_name || '').toLowerCase()}">
            <img src="${p.image_url}" alt="${p.set_code}" onerror="this.style.display='none'">
            <div class="printing-flyout-info">
              <span class="printing-flyout-set">${p.set_code.toUpperCase()}</span>
              <span class="printing-flyout-num">#${p.collector_number || '?'}</span>
              ${p.rarity ? `<span class="printing-flyout-rarity">${p.rarity}</span>` : ''}
            </div>
            <button class="btn btn-sm btn-success printing-add-btn" data-printing-id="${p.id}">
              <i class="ph ph-plus"></i>
            </button>
          </div>
        `).join('')}
      </div>
    `;

    // Position flyout next to the anchor element
    const resultsContainer = document.getElementById('inventory-quick-results');
    const containerRect = resultsContainer.getBoundingClientRect();

    flyout.style.position = 'fixed';
    flyout.style.left = `${containerRect.right + 8}px`;
    flyout.style.top = `${containerRect.top}px`;
    flyout.style.maxHeight = `${Math.min(400, window.innerHeight - containerRect.top - 20)}px`;

    document.body.appendChild(flyout);
    activePrintingFlyout = flyout;

    // Highlight the selected item
    document.querySelectorAll('.quick-result-item').forEach(el => el.classList.remove('active'));
    anchorEl.classList.add('active');

    // Search filter
    const searchInput = flyout.querySelector('.printing-flyout-search');
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      flyout.querySelectorAll('.printing-flyout-item').forEach(item => {
        const setCode = item.dataset.setCode || '';
        const setName = item.dataset.setName || '';
        const matches = !query || setCode.includes(query) || setName.includes(query);
        item.style.display = matches ? 'flex' : 'none';
      });
    });

    // Focus search
    setTimeout(() => searchInput.focus(), 50);

    // Add handlers for adding printings
    const isFoilChecked = () => flyout.querySelector('.printing-foil-checkbox')?.checked ?? false;

    flyout.querySelectorAll('.printing-add-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const printingId = parseInt(btn.dataset.printingId);
        await quickAddPrinting(printingId, isFoilChecked());
      });
    });

    // Click on printing item to add
    flyout.querySelectorAll('.printing-flyout-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        // Toggling the foil checkbox must not also add the card
        if (e.target.closest('.printing-add-btn') || e.target.closest('.printing-flyout-foil')) return;
        const printingId = parseInt(item.dataset.printingId);
        await quickAddPrinting(printingId, isFoilChecked());
      });
    });

  } catch (error) {
    console.error('Failed to load printings:', error);
    showError('Failed to load printings');
  }
}

function closePrintingFlyout() {
  if (activePrintingFlyout) {
    activePrintingFlyout.remove();
    activePrintingFlyout = null;
  }
  document.querySelectorAll('.quick-result-item').forEach(el => el.classList.remove('active'));
}

// Reached from the flyout's add button and from a click anywhere on a printing
// row, so a mis-click lands here. It used to call setOwnedPrintingQuantity with
// a hardcoded 1 — an *absolute* quantity — which turned five owned copies into
// one and then said "Card added to inventory!". Adding one copy is what both
// affordances read as, so it adds one copy.
async function quickAddPrinting(printingId, isFoil = false) {
  try {
    const result = await api.quickAddToInventory(printingId, 1, isFoil);
    // The new total, not just "added": the number is the confirmation. If a
    // click ever lands on the wrong row again, a count that jumped the wrong
    // way is what makes it visible.
    const total = result?.quantity;
    const noun = isFoil ? 'Foil card added' : 'Card added';
    showToast(total ? `${noun} — you now have ${total}` : `${noun} to inventory!`, 'success');

    // Refresh inventory data
    await loadInventoryData();

    // Close flyout and clear search
    closePrintingFlyout();
    const searchInput = document.getElementById('inventory-quick-search');
    const resultsContainer = document.getElementById('inventory-quick-results');
    if (searchInput) searchInput.value = '';
    if (resultsContainer) {
      resultsContainer.classList.add('hidden');
      resultsContainer.innerHTML = '';
    }
  } catch (error) {
    showError('Failed to add card: ' + error.message);
  }
}

function setupBulkActions() {
  const selectToggle = document.getElementById('inventory-select-toggle');
  const selectAllBtn = document.getElementById('inventory-select-all');
  const clearSelectionBtn = document.getElementById('inventory-clear-selection');
  const removeSelectedBtn = document.getElementById('inventory-remove-selected');
  const addToDeckBtn = document.getElementById('inventory-add-to-deck');

  if (selectToggle) {
    selectToggle.addEventListener('click', () => {
      selectMode = !selectMode;
      selectToggle.classList.toggle('active', selectMode);
      if (!selectMode) {
        selectedCards.clear();
      }
      updateBulkActionsBar();
      renderInventory();
    });
  }

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      if (inventoryData?.cards) {
        inventoryData.cards.forEach(card => selectedCards.add(card.card_id));
        updateBulkActionsBar();
        renderInventory();
      }
    });
  }

  if (clearSelectionBtn) {
    clearSelectionBtn.addEventListener('click', () => {
      selectedCards.clear();
      updateBulkActionsBar();
      renderInventory();
    });
  }

  if (removeSelectedBtn) {
    removeSelectedBtn.addEventListener('click', async () => {
      if (selectedCards.size === 0) return;

      const ok = await confirmDialog({
        title: 'Remove cards?',
        message: `Remove ${selectedCards.size} card(s) from your inventory?`,
        confirmText: 'Remove',
        danger: true,
      });
      if (!ok) return;

      try {
        showLoading();
        // For each selected card, set all owned printings to 0
        for (const cardId of selectedCards) {
          const card = inventoryData.cards.find(c => c.card_id === cardId);
          if (card && card.printings) {
            for (const printing of card.printings) {
              await api.setOwnedPrintingQuantity(printing.printing_id, 0);
            }
          }
        }
        selectedCards.clear();
        await loadInventoryData();
        hideLoading();
        showToast('Cards removed from inventory', 'success');
      } catch (error) {
        hideLoading();
        showError('Failed to remove cards: ' + error.message);
      }
    });
  }

  if (addToDeckBtn) {
    addToDeckBtn.addEventListener('click', async () => {
      if (selectedCards.size === 0) return;
      await showAddToDeckModal();
    });
  }
}

async function showAddToDeckModal() {
  try {
    const result = await api.getDecks();
    const decks = result.decks;

    if (!decks || decks.length === 0) {
      showToast('Create a deck first', 'warning');
      return;
    }

    // Create a simple deck selection dropdown
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'add-to-deck-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 400px;">
        <span class="modal-close" id="add-to-deck-modal-close">&times;</span>
        <h2 style="margin-bottom: 1rem;">Add ${selectedCards.size} Card(s) to Deck</h2>
        <div class="form-group">
          <label>Select Deck</label>
          <select id="deck-select-for-add" class="filter-select" style="width: 100%;">
            ${decks.map(d => `<option value="${d.id}">${d.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin-top: 1rem;">
          <label>Add to</label>
          <select id="board-select-for-add" class="filter-select" style="width: 100%;">
            <option value="mainboard">Mainboard</option>
            <option value="sideboard">Sideboard</option>
            <option value="maybeboard">Maybeboard</option>
          </select>
        </div>
        <button id="confirm-add-to-deck" class="btn btn-primary" style="width: 100%; margin-top: 1rem;">Add to Deck</button>
      </div>
    `;

    document.body.appendChild(modal);

    // Close handlers
    const closeModal = () => {
      modal.remove();
    };

    document.getElementById('add-to-deck-modal-close').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    // Confirm handler
    document.getElementById('confirm-add-to-deck').addEventListener('click', async () => {
      const deckId = document.getElementById('deck-select-for-add').value;
      const boardType = document.getElementById('board-select-for-add').value;

      try {
        showLoading();
        let added = 0;

        for (const cardId of selectedCards) {
          const card = inventoryData.cards.find(c => c.card_id === cardId);
          if (card && card.printings && card.printings.length > 0) {
            const isSideboard = boardType === 'sideboard';
            await api.addCardToDeck(deckId, card.printings[0].printing_id, 1, isSideboard, false, boardType);
            added++;
          }
        }

        hideLoading();
        closeModal();
        showToast(`Added ${added} card(s) to deck!`, 'success');
        selectedCards.clear();
        updateBulkActionsBar();
        renderInventory();
      } catch (error) {
        hideLoading();
        showError('Failed to add cards: ' + error.message);
      }
    });
  } catch (error) {
    showError('Failed to load decks: ' + error.message);
  }
}

function updateBulkActionsBar() {
  const bulkBar = document.getElementById('inventory-bulk-actions');
  const countSpan = document.getElementById('inventory-selected-count');

  if (!bulkBar) return;

  if (selectMode && selectedCards.size > 0) {
    bulkBar.classList.remove('hidden');
    if (countSpan) {
      countSpan.textContent = `${selectedCards.size} selected`;
    }
  } else {
    bulkBar.classList.add('hidden');
  }
}

function toggleCardSelection(cardId) {
  if (selectedCards.has(cardId)) {
    selectedCards.delete(cardId);
  } else {
    selectedCards.add(cardId);
  }
  updateBulkActionsBar();
}

/**
 * The export modal: the collection as text, copied or saved.
 *
 * The list is fetched fresh each time the modal opens and again on every
 * change of shape, rather than being generated in the browser from the page's
 * rows. The page shows one filtered, paginated slice of the collection and an
 * export that quietly matched it would be a subset presented as a backup.
 */
function setupExportModal() {
  const openBtn = document.getElementById('inventory-export-btn');
  const modal = document.getElementById('inventory-export-modal');
  const closeBtn = document.getElementById('inventory-export-close');
  const textarea = document.getElementById('inventory-export-text');
  const summary = document.getElementById('inventory-export-summary');
  const copyBtn = document.getElementById('inventory-export-copy');
  const downloadBtn = document.getElementById('inventory-export-download');
  const shapeInputs = [...document.querySelectorAll('input[name="inventory-export-shape"]')];

  if (!openBtn || !modal) return;

  const selectedShape = () => shapeInputs.find((i) => i.checked)?.value || 'precise';

  async function load() {
    textarea.value = 'Loading...';
    summary.textContent = '';
    try {
      const result = await api.exportInventory(selectedShape());
      textarea.value = result.text;
      summary.textContent = `${result.cards} cards, ${result.copies} copies, ${result.lines} lines`;
    } catch (error) {
      console.error('Failed to export inventory:', error);
      textarea.value = '';
      showToast('Failed to build the export', 'error');
    }
  }

  const close = () => modal.classList.add('hidden');

  openBtn.addEventListener('click', () => {
    modal.classList.remove('hidden');
    load();
  });

  closeBtn?.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  shapeInputs.forEach((input) => input.addEventListener('change', load));

  copyBtn?.addEventListener('click', () => {
    if (!textarea.value) return;
    navigator.clipboard.writeText(textarea.value)
      .then(() => showToast('Collection copied to clipboard', 'success'))
      .catch(() => showToast('Failed to copy to clipboard', 'error'));
  });

  downloadBtn?.addEventListener('click', () => {
    if (!textarea.value) return;
    const blob = new Blob([textarea.value], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `collection-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  });
}

function setupBulkAddModal() {
  const bulkAddBtn = document.getElementById('inventory-bulk-add-btn');
  const modal = document.getElementById('bulk-add-modal');
  const closeBtn = document.getElementById('bulk-add-modal-close');
  const previewBtn = document.getElementById('bulk-add-preview-btn');
  const submitBtn = document.getElementById('bulk-add-submit-btn');

  if (bulkAddBtn) {
    bulkAddBtn.addEventListener('click', () => {
      modal?.classList.remove('hidden');
      document.getElementById('bulk-add-text').value = '';
      document.getElementById('bulk-add-preview').classList.add('hidden');
      document.getElementById('bulk-add-result').classList.add('hidden');
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      modal?.classList.add('hidden');
    });
  }

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  }

  if (previewBtn) {
    previewBtn.addEventListener('click', async () => {
      const text = document.getElementById('bulk-add-text').value;
      const items = parseBulkAddText(text);

      if (items.length === 0) {
        renderBulkAddPreview([]);
        return;
      }

      try {
        previewBtn.disabled = true;
        previewBtn.textContent = 'Looking up...';

        // Resolve server-side: lines given as set code + collector number
        // carry no card name, so the preview has to show what they resolve to.
        const result = await api.resolveBulkAddItems(items);
        renderBulkAddPreview(result.items);
      } catch (error) {
        showError('Lookup failed: ' + error.message);
      } finally {
        previewBtn.disabled = false;
        previewBtn.textContent = 'Preview';
      }
    });
  }

  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      const text = document.getElementById('bulk-add-text').value;
      const items = parseBulkAddText(text);

      if (items.length === 0) {
        showError('No valid cards to add');
        return;
      }

      try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Adding...';

        const result = await api.bulkAddToInventory(items);

        const resultDiv = document.getElementById('bulk-add-result');
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `
          <div style="color: var(--success);">Added ${result.added} cards to inventory</div>
          ${result.failed > 0 ? `
            <div style="color: var(--danger); margin-top: 0.5rem;">
              Failed: ${result.failed}
              <ul style="margin-top: 0.5rem; padding-left: 1.5rem;">
                ${result.errors.map(e => `<li>${e.cardName || [e.setCode, e.collectorNumber].filter(Boolean).join(' ') || 'Unknown card'}: ${e.error}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
        `;

        showToast(`Added ${result.added} cards!`, 'success');

        await loadInventoryData();
      } catch (error) {
        showError('Bulk add failed: ' + error.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add to Inventory';
      }
    });
  }
}

/**
 * The mirror of the bulk-add modal: same box, same parser, opposite direction.
 *
 * The one thing it does not share is going straight through on the button —
 * an accidental paste here empties rows rather than filling them, so the
 * confirmation names the count and the button that answers it is the
 * destructive-styled one.
 */
function setupBulkRemoveModal() {
  const openBtn = document.getElementById('inventory-bulk-remove-btn');
  const modal = document.getElementById('bulk-remove-modal');
  const closeBtn = document.getElementById('bulk-remove-modal-close');
  const previewBtn = document.getElementById('bulk-remove-preview-btn');
  const submitBtn = document.getElementById('bulk-remove-submit-btn');

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      modal?.classList.remove('hidden');
      document.getElementById('bulk-remove-text').value = '';
      document.getElementById('bulk-remove-preview').classList.add('hidden');
      document.getElementById('bulk-remove-result').classList.add('hidden');
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      modal?.classList.add('hidden');
    });
  }

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  }

  if (previewBtn) {
    previewBtn.addEventListener('click', async () => {
      const items = parseBulkAddText(document.getElementById('bulk-remove-text').value);

      if (items.length === 0) {
        renderBulkRemovePreview([]);
        return;
      }

      try {
        previewBtn.disabled = true;
        previewBtn.textContent = 'Looking up...';

        const result = await api.resolveBulkRemoveItems(items);
        renderBulkRemovePreview(result.items);
      } catch (error) {
        showError('Lookup failed: ' + error.message);
      } finally {
        previewBtn.disabled = false;
        previewBtn.textContent = 'Preview';
      }
    });
  }

  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      const items = parseBulkAddText(document.getElementById('bulk-remove-text').value);

      if (items.length === 0) {
        showError('No valid cards to remove');
        return;
      }

      const copies = items.reduce((sum, item) => sum + (item.quantity ?? 1), 0);

      const confirmed = await confirmDialog({
        title: 'Remove these cards?',
        message: `This takes up to ${copies} ${copies === 1 ? 'copy' : 'copies'} across `
          + `${items.length} ${items.length === 1 ? 'line' : 'lines'} out of your collection. `
          + 'It cannot be undone from here — the history page records every row if you need to put them back.',
        confirmText: `Remove ${copies} ${copies === 1 ? 'copy' : 'copies'}`,
        cancelText: 'Cancel',
        danger: true,
      });

      if (!confirmed) return;

      try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Removing...';

        const result = await api.bulkRemoveFromInventory(items);

        const describeLine = (e) => e.cardName
          || [e.setCode, e.collectorNumber].filter(Boolean).join(' ')
          || 'Unknown card';

        const resultDiv = document.getElementById('bulk-remove-result');
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `
          <div style="color: var(--success);">Removed ${result.removed} cards from inventory</div>
          ${result.warnings?.length ? `
            <div style="color: var(--warning, var(--text-secondary)); margin-top: 0.5rem;">
              Partly removed:
              <ul style="margin-top: 0.5rem; padding-left: 1.5rem;">
                ${result.warnings.map(w => `<li>${describeLine(w)}: ${w.message}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
          ${result.failed > 0 ? `
            <div style="color: var(--danger); margin-top: 0.5rem;">
              Failed: ${result.failed}
              <ul style="margin-top: 0.5rem; padding-left: 1.5rem;">
                ${result.errors.map(e => `<li>${describeLine(e)}: ${e.error}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
        `;

        showToast(`Removed ${result.removed} cards`, 'success');

        await loadInventoryData();
      } catch (error) {
        showError('Bulk remove failed: ' + error.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Remove from Inventory';
      }
    });
  }
}

/**
 * Preview for a removal. Shows the printing each line lands on and how many
 * copies are actually there, because "4 Lightning Bolt" against a collection
 * holding one is the case worth seeing before confirming.
 */
function renderBulkRemovePreview(items) {
  const previewDiv = document.getElementById('bulk-remove-preview');
  const contentDiv = document.getElementById('bulk-remove-preview-content');

  if (!previewDiv || !contentDiv) return;

  if (items.length === 0) {
    contentDiv.innerHTML = '<div style="color: var(--text-secondary);">No valid cards found</div>';
  } else {
    const describeInput = (input) => {
      if (!input) return '';
      if (input.cardName) return input.cardName;
      return `${input.setCode || '?'} ${input.collectorNumber || '?'}`;
    };

    contentDiv.innerHTML = items.map((item) => {
      if (!item.resolved) {
        return `
          <div style="display: flex; justify-content: space-between; gap: 1rem; padding: 0.25rem 0; border-bottom: 1px solid var(--border);">
            <span style="color: var(--danger);">${item.quantity}x ${describeInput(item.input)}</span>
            <span style="color: var(--danger);">${item.error}</span>
          </div>
        `;
      }

      const printing = [item.setCode, item.collectorNumber].filter(Boolean).join(' ');
      const short = item.willRemove < item.quantity;

      return `
        <div style="display: flex; justify-content: space-between; gap: 1rem; padding: 0.25rem 0; border-bottom: 1px solid var(--border);">
          <span>-${item.willRemove}x ${item.cardName}${item.isFoil ? ' <span style="color: var(--text-secondary);">(foil)</span>' : ''}</span>
          <span style="color: ${short ? 'var(--danger)' : 'var(--text-secondary)'};">
            ${printing} &middot; own ${item.owned}${short ? ` of ${item.quantity} asked` : ''}
          </span>
        </div>
      `;
    }).join('');
  }

  previewDiv.classList.remove('hidden');
}

/**
 * Turn a pasted list into bulk-add items.
 *
 * The line formats come from the shared parser, so this box and the deck
 * importer cannot drift apart again — they did, and a Moxfield line that
 * imported into a deck came back "Card not found" here. All this does is
 * rename `name` to the `cardName` the inventory API expects and drop lines
 * that carry no card.
 */
function parseBulkAddText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => parseCardLine(line))
    .filter((parsed) => parsed && (parsed.name || (parsed.setCode && parsed.collectorNumber)))
    .map(({ name, setCode, collectorNumber, quantity, isFoil }) => ({
      cardName: name,
      setCode,
      collectorNumber,
      quantity,
      isFoil,
    }));
}

function renderBulkAddPreview(items) {
  const previewDiv = document.getElementById('bulk-add-preview');
  const contentDiv = document.getElementById('bulk-add-preview-content');

  if (!previewDiv || !contentDiv) return;

  if (items.length === 0) {
    contentDiv.innerHTML = '<div style="color: var(--text-secondary);">No valid cards found</div>';
  } else {
    const describeInput = (input) => {
      if (!input) return '';
      if (input.cardName) return input.cardName;
      return `${input.setCode || '?'} ${input.collectorNumber || '?'}`;
    };

    contentDiv.innerHTML = items.map(item => {
      if (!item.resolved) {
        return `
          <div style="display: flex; justify-content: space-between; gap: 1rem; padding: 0.25rem 0; border-bottom: 1px solid var(--border);">
            <span style="color: var(--danger);">${item.quantity}x ${describeInput(item.input)}</span>
            <span style="color: var(--danger);">${item.error}</span>
          </div>
        `;
      }

      const printing = [item.setCode, item.collectorNumber].filter(Boolean).join(' ');

      return `
        <div style="display: flex; justify-content: space-between; gap: 1rem; padding: 0.25rem 0; border-bottom: 1px solid var(--border);">
          <span>${item.quantity}x ${item.cardName}${item.isFoil ? ' <span style="color: var(--text-secondary);">(foil)</span>' : ''}</span>
          <span style="color: var(--text-secondary);">${printing}</span>
        </div>
      `;
    }).join('');
  }

  previewDiv.classList.remove('hidden');
}

// Bumped on every load. Typing filters live now, so two requests can be in
// flight within a few hundred milliseconds and the slower one can land last —
// which would leave the grid showing results for a prefix of what is in the
// box. Only the newest request is allowed to write to the page.
let inventoryRequestId = 0;

async function loadInventoryData({ append = false } = {}) {
  const requestId = ++inventoryRequestId;

  try {
    // The full-page spinner is for a list being replaced. Appending keeps the
    // current rows readable and shows its own footer instead.
    if (append) {
      loadingMore = true;
      setScrollSentinel('loading');
    } else {
      showLoading();
    }

    // Load inventory and stats in parallel — admins viewing another user (or
    // a combination of users) go through the /admin/inventory endpoints,
    // everyone else through the regular per-user ones.
    const [inventoryResult, statsResult] = selectedUserIds
      ? await Promise.all([
          api.getAdminInventory(selectedUserIds, { ...filters, page: currentPage, limit: PAGE_SIZE }),
          api.getAdminInventoryStats(selectedUserIds)
        ])
      : await Promise.all([
          api.getInventory({ ...filters, page: currentPage, limit: PAGE_SIZE }),
          api.getInventoryStats()
        ]);

    // Superseded while this was in flight: drop the results rather than
    // painting them over newer ones. The spinner is deliberately left alone —
    // the request that overtook this one owns it and will hide it when it
    // renders. `loadingMore` is not: it belongs to this append, and leaving it
    // set would stall endless scroll for good.
    if (requestId !== inventoryRequestId) {
      if (append) loadingMore = false;
      return;
    }

    const newCards = inventoryResult.cards || [];

    if (append && inventoryData) {
      // Keep the accumulated list as the source of truth, so a later full
      // re-render (toggling prices, or the view mode) redraws every page the
      // reader has scrolled through rather than just the last one.
      inventoryData = {
        ...inventoryResult,
        cards: inventoryData.cards.concat(newCards)
      };
    } else {
      inventoryData = inventoryResult;
    }
    totalPages = inventoryResult.pagination.totalPages || 1;

    renderStats(statsResult);
    renderResultCount(inventoryResult.pagination.totalCards, statsResult.uniqueCards);
    renderInventory(append ? { cards: newCards, append: true } : {});
    renderPagination();
    updateBulkActionsBar();

    // A replaced list is a new list. Without this the reader stays wherever
    // they had scrolled to, which under endless scroll puts the sentinel
    // straight back in view and refetches every page they had just filtered
    // away — the new first page arrives and is immediately buried again.
    if (!append && endlessScroll) scrollToListTop();

    if (append) {
      loadingMore = false;
    }
    updateScrollSentinel();
    // An observer only reports threshold crossings. If the page that just
    // arrived was short enough to leave the sentinel still on screen, nothing
    // would fire again and loading would stall until the reader scrolled, so
    // check the position directly once the new rows have been laid out.
    if (endlessScroll) requestAnimationFrame(fillViewport);

    hideLoading();
  } catch (error) {
    loadingMore = false;
    hideLoading();
    updateScrollSentinel();
    showError('Failed to load inventory: ' + error.message);
  }
}

// How many cards the filters matched. Says so plainly against the collection
// total when anything is filtering, so a small number reads as "the filter is
// narrow" rather than "the collection is small".
function renderResultCount(matched, collectionTotal) {
  const el = document.getElementById('inventory-result-count');
  if (!el) return;

  const count = Number(matched) || 0;
  const noun = count === 1 ? 'card' : 'cards';

  el.textContent = hasActiveFilters()
    ? `${count.toLocaleString()} of ${Number(collectionTotal || 0).toLocaleString()} ${noun}`
    : `${count.toLocaleString()} ${noun}`;
}

// Every control that can narrow the list, not just the search chips — the
// count only means "of the collection" when something is actually filtering.
function hasActiveFilters() {
  return (
    filters.names.length > 0 ||
    !!filters.liveName ||
    filters.sets.length > 0 ||
    filters.colors.length > 0 ||
    (filters.type && filters.type !== 'all') ||
    filters.availability !== 'all' ||
    filters.commander !== 'all'
  );
}

function renderStats(stats) {
  const container = document.getElementById('inventory-stats');
  if (!container) return;

  container.innerHTML = `
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
      <i class="ph ph-folder"></i>
      <div>
        <div class="stat-value">${stats.inDecks.toLocaleString()}</div>
        <div class="stat-label">In Decks</div>
      </div>
    </div>
    <div class="inventory-stat">
      <i class="ph ph-check-circle"></i>
      <div>
        <div class="stat-value">${stats.available.toLocaleString()}</div>
        <div class="stat-label">Available</div>
      </div>
    </div>
    <div class="inventory-stat">
      <i class="ph ph-currency-dollar"></i>
      <div>
        <div class="stat-value">$${stats.estimatedValue.toFixed(2)}</div>
        <div class="stat-label">Est. Value</div>
      </div>
    </div>
  `;

  renderTypeBreakdown(stats.typeBreakdown);
}

/**
 * What the collection is made of, shown beside the quick-add box.
 *
 * Each chip is a filter: the type split is only half an answer without a way
 * to see the cards behind a number, and the type dropdown it drives is the
 * same one in the filter row below.
 */
function renderTypeBreakdown(breakdown) {
  const container = document.getElementById('inventory-type-breakdown');
  if (!container) return;

  const types = (breakdown || []).filter((t) => t.total_cards > 0);

  if (types.length === 0) {
    container.innerHTML = '';
    return;
  }

  const active = document.getElementById('inventory-type')?.value || 'all';

  container.innerHTML = types.map((t) => `
    <button
      type="button"
      class="inventory-type-chip${t.type === active ? ' is-active' : ''}"
      data-type="${escapeHtml(t.type)}"
    >
      ${escapeHtml(t.type)}
      <span class="inventory-type-chip-count">${t.total_cards.toLocaleString()}</span>
    </button>
  `).join('');

  container.querySelectorAll('.inventory-type-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const select = document.getElementById('inventory-type');
      if (!select) return;

      // "Other" is a bucket the breakdown invents, not a value the type
      // filter offers, so it has nothing to select — the chip stays a
      // readout. Clicking the active chip clears the filter, which is the
      // only way back to everything without reaching for the dropdown.
      const wanted = chip.dataset.type;
      if (!Array.from(select.options).some((o) => o.value === wanted)) return;

      select.value = select.value === wanted ? 'all' : wanted;
      select.dispatchEvent(new Event('change'));
    });
  });
}

// `cards` defaults to everything loaded so far. Endless scroll passes just
// the page it fetched along with append:true, so earlier rows keep their DOM
// nodes — re-rendering them would restart every card image and throw away the
// reader's place on the page.
function renderInventory({ cards = null, append = false } = {}) {
  const container = document.getElementById('inventory-grid');
  if (!container) return;

  if (!inventoryData || !inventoryData.cards || inventoryData.cards.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="ph ph-archive empty-state-icon" aria-hidden="true"></i>
        <h3>No cards in inventory</h3>
        <p>Add cards using the Quick Add search or Bulk Add button above.</p>
      </div>
    `;
    return;
  }

  const rows = cards || inventoryData.cards;
  if (viewMode === 'grid') {
    renderGridView(container, rows, append);
  } else {
    renderListView(container, rows, append);
  }
}

/**
 * When a card entered the collection, short enough to sit on a grid tile.
 *
 * Only ever shown while sorting by it. The date answers one question — where
 * does the batch I just entered stop — and on every other sort it would be a
 * column of noise on a page that is already dense.
 */
function formatAdded(value) {
  if (!value) return 'unknown';

  // SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker, which
  // Safari refuses outright and Chrome reads as local time. Naming the zone is
  // what makes the two agree, and it is what stops an evening's import showing
  // as tomorrow.
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return 'unknown';

  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The same moment in full, for the tooltip — "3d ago" is not a receipt. */
function formatAddedFull(value) {
  if (!value) return 'unknown';
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

function renderGridView(container, cards, append = false) {
  container.className = 'inventory-grid';

  const sortedByDate = filters.sort === 'added_desc' || filters.sort === 'added_asc';

  const html = cards.map(card => {
    const isSelected = selectedCards.has(card.card_id);
    const printingCount = card.printings ? card.printings.length : 0;
    const printingImages = card.printings ? card.printings.map(p => p.image_url).filter(Boolean) : [];
    const price = showPrices ? getPriceSummary(card) : null;
    const foilCount = getFoilCount(card);

    return `
      <div class="inventory-card-item ${isSelected ? 'selected' : ''}" data-card-id="${card.card_id}" data-printing-images='${JSON.stringify(printingImages)}'>
        ${selectMode ? `
          <div class="inventory-card-checkbox ${isSelected ? 'checked' : ''}" data-card-id="${card.card_id}">
            <i class="ph ${isSelected ? 'ph-check-square' : 'ph-square'}"></i>
          </div>
        ` : ''}
        <div class="inventory-card-image">
          ${card.image_url ? `
            <img src="${card.image_url}" alt="${card.name}" loading="lazy" onerror="this.style.display='none'" data-original-src="${card.image_url}" />
          ` : ''}
          ${printingCount > 1 ? `
            <div class="inventory-printings-badge" title="${printingCount} different printings owned">
              <i class="ph ph-stack"></i> ${printingCount}
            </div>
          ` : ''}
          ${zoomButton(card.image_url, card.name, { className: 'on-art' })}
        </div>
        <div class="inventory-card-info">
          <div class="inventory-card-name">
            <span>${card.name}</span>
            ${foilCount > 0 ? `<span class="foil-badge" title="${foilCount} foil ${foilCount === 1 ? 'copy' : 'copies'} owned"><i class="ph ph-sparkle"></i> ${foilCount}</span>` : ''}
            ${card.owners && card.owners.length > 0 ? `<span class="owners-badge" title="${getOwnersTooltip(card).replace(/"/g, '&quot;')}"><i class="ph ph-users"></i> ${card.owners.length}</span>` : ''}
          </div>
          <div class="inventory-card-mana">${formatMana(card.mana_cost || '')}</div>
          <div class="inventory-card-stats">
            <span class="inventory-in-decks" title="In decks">
              <i class="ph ph-folder"></i> ${card.total_in_decks}
            </span>
            <span class="inventory-available ${card.available <= 0 ? 'none-available' : ''}" title="Available">
              <i class="ph ph-check-circle"></i> ${card.available}
            </span>
          </div>
          ${showPrices ? `
            <div class="inventory-card-price ${price ? '' : 'no-price'}" title="${price ? price.tooltip.replace(/"/g, '&quot;') : 'No synced price available'}">
              ${price ? `$${price.unit.toFixed(2)}` : '—'}
            </div>
          ` : ''}
          ${sortedByDate ? `
            <div class="inventory-card-added" title="Added ${escapeHtml(formatAddedFull(card.added_at))}">
              <i class="ph ph-clock-counter-clockwise"></i> ${escapeHtml(formatAdded(card.added_at))}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  if (append) {
    container.insertAdjacentHTML('beforeend', html);
  } else {
    container.innerHTML = html;
  }

  // Add click and hover handlers. Only to rows that have not been wired up
  // yet, so appending a page does not stack a second set of listeners on
  // every card already on screen.
  container.querySelectorAll('.inventory-card-item:not([data-bound])').forEach(item => {
    item.dataset.bound = '1';
    const cardId = parseInt(item.dataset.cardId);
    const printingImages = JSON.parse(item.dataset.printingImages || '[]');

    // Checkbox click
    const checkbox = item.querySelector('.inventory-card-checkbox');
    if (checkbox) {
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCardSelection(cardId);
        // Update UI immediately
        item.classList.toggle('selected', selectedCards.has(cardId));
        checkbox.classList.toggle('checked', selectedCards.has(cardId));
        checkbox.innerHTML = `<i class="ph ${selectedCards.has(cardId) ? 'ph-check-square' : 'ph-square'}"></i>`;
      });
    }

    // Hover image cycling for multi-printing cards
    if (printingImages.length > 1) {
      let cycleInterval = null;
      let currentIndex = 0;
      const img = item.querySelector('.inventory-card-image img');

      item.addEventListener('mouseenter', () => {
        if (!img) return;
        currentIndex = 0;
        cycleInterval = setInterval(() => {
          currentIndex = (currentIndex + 1) % printingImages.length;
          img.src = printingImages[currentIndex];
        }, 1200);
      });

      item.addEventListener('mouseleave', () => {
        if (cycleInterval) {
          clearInterval(cycleInterval);
          cycleInterval = null;
        }
        // Reset to original image
        if (img && img.dataset.originalSrc) {
          img.src = img.dataset.originalSrc;
        }
      });
    }

    // Card click - show details (or toggle selection in select mode if clicking outside checkbox)
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.inventory-card-checkbox')) return;

      if (selectMode) {
        toggleCardSelection(cardId);
        item.classList.toggle('selected', selectedCards.has(cardId));
        const cb = item.querySelector('.inventory-card-checkbox');
        if (cb) {
          cb.classList.toggle('checked', selectedCards.has(cardId));
          cb.innerHTML = `<i class="ph ${selectedCards.has(cardId) ? 'ph-check-square' : 'ph-square'}"></i>`;
        }
      } else {
        await showCardDetail(cardId);
      }
    });
  });
}

function renderListView(container, cards, append = false) {
  container.className = 'inventory-list';

  const header = `
    <div class="inventory-list-header">
      ${selectMode ? '<span class="list-col-select"></span>' : ''}
      <span class="list-col-name">Name</span>
      <span class="list-col-type">Type</span>
      <span class="list-col-mana">Mana</span>
      <span class="list-col-prints">Prints</span>
      <span class="list-col-owned">Owned</span>
      <span class="list-col-decks">In Decks</span>
      <span class="list-col-available">Available</span>
      ${showPrices ? '<span class="list-col-price">Price</span>' : ''}
    </div>
  `;

  const rowsHtml = cards.map(card => {
      const isSelected = selectedCards.has(card.card_id);
      const printingCount = card.printings ? card.printings.length : 0;
      const price = showPrices ? getPriceSummary(card) : null;
      const foilCount = getFoilCount(card);
      return `
        <div class="inventory-list-item ${isSelected ? 'selected' : ''}" data-card-id="${card.card_id}">
          ${selectMode ? `
            <span class="list-col-select">
              <div class="inventory-list-checkbox ${isSelected ? 'checked' : ''}" data-card-id="${card.card_id}">
                <i class="ph ${isSelected ? 'ph-check-square' : 'ph-square'}"></i>
              </div>
            </span>
          ` : ''}
          <span class="list-col-name">
            ${zoomButton(card.image_url, card.name, { className: 'inline-glass' })}
            <span class="list-col-name-text">${card.name}</span>
            ${foilCount > 0 ? `<span class="foil-badge" title="${foilCount} foil ${foilCount === 1 ? 'copy' : 'copies'} owned"><i class="ph ph-sparkle"></i> ${foilCount}</span>` : ''}
            ${card.owners && card.owners.length > 0 ? `<span class="owners-badge" title="${getOwnersTooltip(card).replace(/"/g, '&quot;')}"><i class="ph ph-users"></i> ${card.owners.length}</span>` : ''}
          </span>
          <span class="list-col-type">${card.type_line || ''}</span>
          <span class="list-col-mana">${formatMana(card.mana_cost || '')}</span>
          <span class="list-col-prints">${printingCount > 1 ? `<i class="ph ph-stack"></i> ${printingCount}` : '1'}</span>
          <span class="list-col-owned">${card.total_owned}</span>
          <span class="list-col-decks">${card.total_in_decks}</span>
          <span class="list-col-available ${card.available <= 0 ? 'none-available' : ''}">${card.available}</span>
          ${showPrices ? `
            <span class="list-col-price ${price ? '' : 'no-price'}" title="${price ? price.tooltip.replace(/"/g, '&quot;') : 'No synced price available'}">
              ${price ? `$${price.unit.toFixed(2)}` : '—'}
            </span>
          ` : ''}
        </div>
      `;
  }).join('');

  // The header is written once; appended pages add rows beneath it.
  if (append) {
    container.insertAdjacentHTML('beforeend', rowsHtml);
  } else {
    container.innerHTML = header + rowsHtml;
  }

  // Add click handlers, skipping rows already wired up (see renderGridView).
  container.querySelectorAll('.inventory-list-item:not([data-bound])').forEach(item => {
    item.dataset.bound = '1';
    const cardId = parseInt(item.dataset.cardId);

    // Checkbox click
    const checkbox = item.querySelector('.inventory-list-checkbox');
    if (checkbox) {
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCardSelection(cardId);
        item.classList.toggle('selected', selectedCards.has(cardId));
        checkbox.classList.toggle('checked', selectedCards.has(cardId));
        checkbox.innerHTML = `<i class="ph ${selectedCards.has(cardId) ? 'ph-check-square' : 'ph-square'}"></i>`;
      });
    }

    // Row click
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.inventory-list-checkbox')) return;

      if (selectMode) {
        toggleCardSelection(cardId);
        item.classList.toggle('selected', selectedCards.has(cardId));
        const cb = item.querySelector('.inventory-list-checkbox');
        if (cb) {
          cb.classList.toggle('checked', selectedCards.has(cardId));
          cb.innerHTML = `<i class="ph ${selectedCards.has(cardId) ? 'ph-check-square' : 'ph-square'}"></i>`;
        }
      } else {
        await showCardDetail(cardId);
      }
    });
  });
}

// Endless scroll. The sentinel sits below the grid; when it comes within
// sight the next page is fetched and appended.
function setupEndlessScroll() {
  const btn = document.getElementById('inventory-endless-toggle');
  if (btn) {
    setEndlessScroll(endlessScroll, { reload: false });
    btn.addEventListener('click', () => setEndlessScroll(!endlessScroll));
  }

  const sentinel = document.getElementById('inventory-scroll-sentinel');
  if (!sentinel || typeof IntersectionObserver === 'undefined') return;

  // Fires a page early, so the next rows are usually in place before the
  // reader reaches the end of the ones they are looking at.
  scrollObserver = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    loadNextPage();
  }, { rootMargin: '600px' });

  scrollObserver.observe(sentinel);
}

// Scrolls back up to the head of the list, and only ever upwards — opening
// the page should not drag the reader past the filters to reach the grid.
function scrollToListTop() {
  const grid = document.getElementById('inventory-grid');
  if (!grid) return;

  const top = Math.max(window.scrollY + grid.getBoundingClientRect().top - 16, 0);
  if (window.scrollY > top) window.scrollTo({ top });
}

// Loads another page while the sentinel is still within the observer's margin
// of the viewport — i.e. while the rows on screen do not reach the bottom.
function fillViewport() {
  const sentinel = document.getElementById('inventory-scroll-sentinel');
  if (!sentinel || sentinel.classList.contains('hidden')) return;
  if (loadingMore || currentPage >= totalPages) return;

  const { top } = sentinel.getBoundingClientRect();
  if (top <= window.innerHeight + 600) loadNextPage();
}

function loadNextPage() {
  if (!endlessScroll || loadingMore || !inventoryData) return;
  if (currentPage >= totalPages) return;

  currentPage += 1;
  loadInventoryData({ append: true });
}

function setEndlessScroll(next, { reload = true } = {}) {
  endlessScroll = next;
  localStorage.setItem('inventoryEndlessScroll', String(next));

  const btn = document.getElementById('inventory-endless-toggle');
  if (btn) {
    btn.classList.toggle('active', next);
    btn.setAttribute('aria-pressed', String(next));
    btn.title = next ? 'Endless scroll on' : 'Endless scroll off';
  }

  if (reload) {
    // Switching modes reloads the page the reader is on rather than sending
    // them back to the first one: turning the pager back on after scrolling
    // to page 4 should leave them at page 4, not at the top of the list.
    loadInventoryData();
  } else {
    renderPagination();
    updateScrollSentinel();
  }
}

// The sentinel doubles as the footer: it says what is happening, and stops
// being watched once there is nothing left to fetch.
function updateScrollSentinel() {
  if (!endlessScroll) return setScrollSentinel('off');
  if (loadingMore) return setScrollSentinel('loading');
  if (!inventoryData || currentPage >= totalPages) return setScrollSentinel('end');
  setScrollSentinel('more');
}

function setScrollSentinel(state) {
  const sentinel = document.getElementById('inventory-scroll-sentinel');
  if (!sentinel) return;

  sentinel.classList.toggle('hidden', state === 'off');

  if (state === 'loading') {
    sentinel.innerHTML = '<i class="ph ph-circle-notch"></i> Loading more cards...';
  } else if (state === 'end') {
    // Only worth saying once the reader has actually scrolled through more
    // than one page; on a short list it states the obvious.
    sentinel.innerHTML = currentPage > 1 ? "That's everything." : '';
  } else {
    sentinel.innerHTML = '';
  }
}

function renderPagination() {
  // Endless scroll and a pager are two answers to the same question; showing
  // both leaves "Page 3 of 7" sitting under seven pages of cards.
  ['inventory-pagination', 'inventory-pagination-top'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', endlessScroll);
  });

  ['inventory-prev-page', 'inventory-prev-page-top'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = currentPage <= 1;
  });
  ['inventory-next-page', 'inventory-next-page-top'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = currentPage >= totalPages;
  });
  ['inventory-page-info', 'inventory-page-info-top'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = `Page ${currentPage} of ${totalPages}`;
  });
}
