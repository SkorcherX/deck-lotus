import api from '../services/api.js';
import { showLoading, hideLoading, showToast, debounce, formatMana, openModal, closeModal } from '../utils/ui.js';
import { zoomButton } from '../utils/cardZoom.js';

/**
 * A collection opened from a share link, by someone with no account.
 *
 * The trade shop's browser without the cart: same markup, same classes, same
 * filters, plus a set filter. It is reached from its own bootstrap in main.js,
 * before the auth check, the way a shared deck is.
 *
 * Read-only is enforced on the server — the public API is GETs only — so this
 * file is free to be ordinary. What it leaves out is still deliberate: no
 * "in decks", no availability, and no link to the full card detail, which
 * needs an account. Clicking a card lists the printings owned instead.
 *
 * Also here: the owner's modal for creating, copying, replacing and stopping
 * their link, opened from the inventory page.
 */

const PAGE_SIZE = 54;

const state = {
  token: null,
  owner: null,
  data: null,
  page: 1,
  totalPages: 1,
  viewMode: 'grid',
  showPrices: localStorage.getItem('inventoryShowPrices') === 'true',
  filters: { name: '', sort: 'name', type: 'all', commander: 'all', colors: [], sets: '' },
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function money(value) {
  return value == null ? '—' : `$${Number(value).toFixed(2)}`;
}

function cheapestPrice(card) {
  const prices = (card.printings || []).map((p) => p.price).filter((p) => p != null);
  return prices.length ? Math.min(...prices) : null;
}

function foilCount(card) {
  return (card.printings || [])
    .filter((printing) => printing.is_foil === 1)
    .reduce((sum, printing) => sum + printing.quantity, 0);
}

// ---------------------------------------------------------------------------
// The public view
// ---------------------------------------------------------------------------

function render() {
  const container = document.getElementById('shared-coll-grid');

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
    const printingCount = card.printings ? card.printings.length : 0;
    const price = cheapestPrice(card);
    const foils = foilCount(card);

    return `
      <div class="inventory-card-item" data-card-id="${card.card_id}">
        <div class="inventory-card-image">
          ${card.image_url ? `
            <img src="${card.image_url}" alt="${escapeHtml(card.name)}" loading="lazy" onerror="this.style.display='none'" />
          ` : ''}
          ${printingCount > 1 ? `
            <div class="inventory-printings-badge" title="${printingCount} different printings">
              <i class="ph ph-stack"></i> ${printingCount}
            </div>
          ` : ''}
          ${zoomButton(card.image_url, card.name, { className: 'on-art' })}
        </div>
        <div class="inventory-card-info">
          <div class="inventory-card-name">
            <span>${escapeHtml(card.name)}</span>
            ${foils > 0 ? `<span class="foil-badge" title="${foils} foil"><i class="ph ph-sparkle"></i> ${foils}</span>` : ''}
          </div>
          <div class="inventory-card-mana">${formatMana(card.mana_cost || '')}</div>
          <div class="inventory-card-stats">
            <span title="Copies owned">
              <i class="ph ph-stack"></i> ${card.total_owned}
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

  wireClicks(container, '.inventory-card-item');
}

function renderList(container) {
  container.className = 'inventory-list';

  // Six columns to match .inventory-list-header's grid; the last two carry
  // set count and price where the inventory page has deck columns.
  container.innerHTML = `
    <div class="inventory-list-header">
      <div>Card</div>
      <div>Type</div>
      <div>Mana</div>
      <div>Owned</div>
      <div>Printings</div>
      <div>${state.showPrices ? 'Price' : ''}</div>
    </div>
    ${state.data.cards.map((card) => {
      const price = cheapestPrice(card);

      return `
        <div class="inventory-list-item" data-card-id="${card.card_id}">
          <div class="list-col-name">
            ${zoomButton(card.image_url, card.name, { className: 'inline-glass' })}
            <span class="list-col-name-text">${escapeHtml(card.name)}</span>
          </div>
          <div>${escapeHtml((card.type_line || '').split('—')[0].trim())}</div>
          <div>${formatMana(card.mana_cost || '')}</div>
          <div>${card.total_owned}</div>
          <div>${card.printings ? card.printings.length : 0}</div>
          <div>${state.showPrices ? (price == null ? '—' : money(price)) : ''}</div>
        </div>
      `;
    }).join('')}
  `;

  wireClicks(container, '.inventory-list-item');
}

function wireClicks(container, selector) {
  container.querySelectorAll(selector).forEach((el) => {
    const cardId = parseInt(el.dataset.cardId, 10);
    el.addEventListener('click', () => {
      showCard(state.data.cards.find((card) => card.card_id === cardId));
    });
  });
}

/** Which printings, finishes and how many — what "do you have it?" needs. */
function showCard(card) {
  if (!card) return;

  document.getElementById('shared-coll-card-title').textContent = card.name;

  document.getElementById('shared-coll-card-body').innerHTML = `
    <div style="display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap;">
      ${card.image_url ? `
        <img src="${card.image_url}" alt="${escapeHtml(card.name)}"
             style="width:180px;max-width:100%;border-radius:8px;" />
      ` : ''}
      <div style="flex:1;min-width:200px;">
        <div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:0.5rem;">
          ${escapeHtml(card.type_line || '')}
        </div>
        ${(card.printings || []).map((printing) => `
          <div style="display:flex;justify-content:space-between;gap:0.5rem;padding:0.4rem 0;border-bottom:1px solid var(--border);">
            <span>
              ${zoomButton(printing.image_url, card.name, { className: 'inline-glass' })}
              ${escapeHtml((printing.set_code || '').toUpperCase())}
              ${printing.collector_number ? `<span style="color:var(--text-secondary);">#${escapeHtml(printing.collector_number)}</span>` : ''}
              ${printing.is_foil === 1 ? '<span style="color:var(--primary);">foil</span>' : ''}
              <div style="font-size:0.78rem;color:var(--text-secondary);">${escapeHtml(printing.set_name || '')}</div>
            </span>
            <span style="color:var(--text-secondary);white-space:nowrap;">
              ${printing.quantity}x · ${money(printing.price)}
            </span>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  openModal('shared-coll-card-modal');
}

function renderStats(stats) {
  document.getElementById('shared-coll-stats').innerHTML = `
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
    document.getElementById(`shared-coll-page-info${suffix}`).textContent = `Page ${state.page} of ${state.totalPages}`;
    document.getElementById(`shared-coll-prev${suffix}`).disabled = state.page <= 1;
    document.getElementById(`shared-coll-next${suffix}`).disabled = state.page >= state.totalPages;
  }
}

async function loadPage() {
  try {
    showLoading();

    const data = await api.getSharedCollectionInventory(state.token, {
      name: state.filters.name,
      sort: state.filters.sort,
      type: state.filters.type,
      commander: state.filters.commander,
      colors: state.filters.colors.join(','),
      sets: state.filters.sets,
      page: state.page,
      limit: PAGE_SIZE,
    });

    state.data = data;
    state.totalPages = data.pagination.totalPages || 1;

    render();
    renderPagination();
  } catch (error) {
    showToast('Failed to load collection: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
}

function reload() {
  state.page = 1;
  loadPage();
}

function wireViewer() {
  const search = document.getElementById('shared-coll-search');
  search.addEventListener('input', debounce(() => {
    state.filters.name = search.value.trim();
    reload();
  }, 300));

  for (const [id, key] of [
    ['shared-coll-sort', 'sort'],
    ['shared-coll-type', 'type'],
    ['shared-coll-commander', 'commander'],
    ['shared-coll-set', 'sets'],
  ]) {
    document.getElementById(id).addEventListener('change', (event) => {
      state.filters[key] = event.target.value;
      reload();
    });
  }

  document.querySelectorAll('#shared-coll-colors input[type="checkbox"]').forEach((box) => {
    box.addEventListener('change', () => {
      state.filters.colors = Array.from(
        document.querySelectorAll('#shared-coll-colors input[type="checkbox"]:checked')
      ).map((checked) => checked.value);
      reload();
    });
  });

  const priceToggle = document.getElementById('shared-coll-price-toggle');
  priceToggle.setAttribute('aria-pressed', String(state.showPrices));
  priceToggle.classList.toggle('active', state.showPrices);
  priceToggle.addEventListener('click', () => {
    state.showPrices = !state.showPrices;
    priceToggle.setAttribute('aria-pressed', String(state.showPrices));
    priceToggle.classList.toggle('active', state.showPrices);
    render();
  });

  const gridBtn = document.getElementById('shared-coll-grid-view-btn');
  const listBtn = document.getElementById('shared-coll-list-view-btn');

  gridBtn.addEventListener('click', () => {
    state.viewMode = 'grid';
    gridBtn.classList.add('active');
    listBtn.classList.remove('active');
    render();
  });

  listBtn.addEventListener('click', () => {
    state.viewMode = 'list';
    listBtn.classList.add('active');
    gridBtn.classList.remove('active');
    render();
  });

  for (const suffix of ['', '-top']) {
    document.getElementById(`shared-coll-prev${suffix}`).addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        loadPage();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });

    document.getElementById(`shared-coll-next${suffix}`).addEventListener('click', () => {
      if (state.page < state.totalPages) {
        state.page += 1;
        loadPage();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  document.getElementById('shared-coll-card-close').addEventListener('click', () => {
    closeModal('shared-coll-card-modal');
  });
}

/** Entry point for /collection/:token, called from main.js before any auth. */
export async function loadSharedCollection(token) {
  state.token = token;

  document.querySelectorAll('.page').forEach((page) => page.classList.add('hidden'));
  document.getElementById('navbar').classList.add('hidden');

  try {
    showLoading();

    const [owner, stats, { sets }] = await Promise.all([
      api.getSharedCollection(token),
      api.getSharedCollectionStats(token),
      api.getSharedCollectionSets(token),
    ]);

    state.owner = owner;

    document.title = `${owner.username}'s collection — Deck Lotus`;
    document.getElementById('shared-coll-title').textContent = `${owner.username}'s collection`;
    document.getElementById('shared-coll-brief').innerHTML = `
      <div style="font-size: 0.875rem; color: var(--text-secondary);">
        A read-only view shared by ${escapeHtml(owner.username)}. Search and filter as you like;
        nothing here can be changed.
      </div>
    `;

    document.getElementById('shared-coll-set').innerHTML =
      '<option value="">All Sets</option>' +
      sets.map((set) => `
        <option value="${escapeHtml(set.code)}">${escapeHtml(set.name)} (${escapeHtml(set.code.toUpperCase())})</option>
      `).join('');

    renderStats(stats);
    wireViewer();

    document.getElementById('shared-coll-page').classList.remove('hidden');
  } catch (error) {
    hideLoading();
    document.getElementById('shared-coll-page').classList.remove('hidden');
    document.getElementById('shared-coll-title').textContent = 'Collection unavailable';
    document.getElementById('shared-coll-brief').textContent =
      error.status === 404
        ? 'This link is not valid, or its owner has stopped sharing.'
        : 'The collection could not be loaded: ' + error.message;
    document.querySelector('#shared-coll-page .inventory-filters').classList.add('hidden');
    document.querySelectorAll('#shared-coll-page .pagination').forEach((el) => el.classList.add('hidden'));
    return;
  }

  await loadPage();
}

// ---------------------------------------------------------------------------
// The owner's side: the Share button on the inventory page
// ---------------------------------------------------------------------------

function showShare(share) {
  const on = Boolean(share && share.shareUrl);

  document.getElementById('collection-share-off').classList.toggle('hidden', on);
  document.getElementById('collection-share-on').classList.toggle('hidden', !on);
  document.getElementById('collection-share-url').value =
    on ? `${window.location.origin}${share.shareUrl}` : '';
}

async function shareAction(fn, message) {
  try {
    showLoading();
    const share = await fn();
    showShare(share);
    if (message) showToast(message, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    hideLoading();
  }
}

export function setupCollectionShare() {
  document.getElementById('inventory-share-btn').addEventListener('click', async () => {
    showShare(null);
    openModal('collection-share-modal');
    await shareAction(() => api.getCollectionShare());
  });

  document.getElementById('collection-share-close').addEventListener('click', () => {
    closeModal('collection-share-modal');
  });

  document.getElementById('collection-share-create').addEventListener('click', () => {
    shareAction(() => api.createCollectionShare(), 'Link created');
  });

  document.getElementById('collection-share-regenerate').addEventListener('click', () => {
    if (!confirm('Make a new link? Anyone with the current link will lose access.')) return;
    shareAction(() => api.regenerateCollectionShare(), 'New link created — the old one no longer works');
  });

  document.getElementById('collection-share-stop').addEventListener('click', () => {
    if (!confirm('Stop sharing? The link will stop working for everyone who has it.')) return;
    shareAction(() => api.deleteCollectionShare(), 'Sharing turned off');
  });

  document.getElementById('collection-share-copy').addEventListener('click', async () => {
    const input = document.getElementById('collection-share-url');

    try {
      await navigator.clipboard.writeText(input.value);
      showToast('Link copied', 'success');
    } catch {
      // Clipboard API is refused on plain-http origins, which a LAN Unraid
      // box usually is. Selecting the text still lets Ctrl+C work.
      input.select();
      showToast('Press Ctrl+C to copy', 'info');
    }
  });
}
