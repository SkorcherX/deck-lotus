import api from '../services/api.js';
import { showLoading, hideLoading, showToast } from '../utils/ui.js';
import { showCardDetail } from './cards.js';

/**
 * The EDHREC page: type a commander, see the cards EDHREC says its decks run,
 * each marked with how many you own and how many are free (not in a deck, not
 * lent out). Picked cards can go to the shopping list or into a new `idea`
 * deck, which readiness and the shopping list then take over from.
 *
 * The server caches each commander for a day (src/services/edhrecService.js);
 * Refresh asks EDHREC again.
 */

let state = { data: null, query: '', filter: 'all', category: 'all', sort: 'inclusion', picked: new Set() };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const pct = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);
const signedPct = (n) => (n == null ? '—' : `${n >= 0 ? '+' : '−'}${Math.round(Math.abs(n) * 100)}%`);

// Basic lands count as had and free, as everywhere else (basicLands.js).
const FILTERS = {
  all: () => true,
  owned: (c) => c.owned > 0 || c.isBasic,
  available: (c) => c.available > 0 || c.isBasic,
  missing: (c) => c.matched && c.owned === 0 && !c.isBasic,
};

function visibleCards() {
  const { data, filter, category, sort } = state;
  if (!data) return [];
  const inCategory = category === 'all'
    ? null
    : new Set(data.categories.find((c) => c.tag === category)?.names || []);
  const rows = data.cards.filter((c) => FILTERS[filter](c) && (!inCategory || inCategory.has(c.name)));
  const by = {
    inclusion: (a, b) => (b.inclusion ?? 0) - (a.inclusion ?? 0),
    synergy: (a, b) => (b.synergy ?? -1) - (a.synergy ?? -1),
    price: (a, b) => (b.price ?? 0) - (a.price ?? 0),
    name: (a, b) => a.name.localeCompare(b.name),
  }[sort];
  return by ? [...rows].sort(by) : rows;
}

function ownedCell(c) {
  if (!c.matched) return '<span class="edhrec-muted" title="No card by this name in the local database">not found</span>';
  if (c.isBasic) return '<span class="edhrec-free" title="Basic lands are never counted short">basic</span>';
  if (c.owned === 0) return '<span class="edhrec-missing">0</span>';
  const parts = [`${c.owned} owned`];
  if (c.inDecks) parts.push(`${c.inDecks} in decks`);
  if (c.lentOut) parts.push(`${c.lentOut} lent out`);
  return `<span class="${c.available > 0 ? 'edhrec-free' : 'edhrec-busy'}" title="${escapeHtml(parts.join(', '))}">${c.available} / ${c.owned}</span>`;
}

function render() {
  const el = document.getElementById('edhrec-result');
  const { data } = state;
  if (!data) {
    el.innerHTML = `<div class="sealed-empty">Look up a commander to see the cards EDHREC recommends and which of them you already own.</div>`;
    return;
  }

  const s = data.summary;
  const rows = visibleCards();
  const allPicked = rows.length > 0 && rows.every((c) => state.picked.has(c.name));

  el.innerHTML = `
    <div class="edhrec-head">
      <div>
        <h3>${escapeHtml(data.commander.name || data.slug)}</h3>
        <div class="edhrec-muted">
          ${data.commander.numDecks ? `${data.commander.numDecks.toLocaleString()} decks on EDHREC · ` : ''}
          fetched ${escapeHtml(data.fetchedAt)} UTC${data.stale ? ' (EDHREC unreachable — showing the saved copy)' : ''}
          · <a href="${escapeHtml(data.url)}" target="_blank" rel="noopener">open on EDHREC</a>
        </div>
      </div>
      <button type="button" class="btn btn-secondary" data-action="refresh" title="Ask EDHREC again instead of using today's saved copy">
        <i class="ph ph-arrows-clockwise btn-icon"></i> Refresh
      </button>
    </div>

    <div class="sealed-summary">
      <div class="sealed-stat"><span>Recommended</span><strong>${s.total}</strong></div>
      <div class="sealed-stat"><span>Owned</span><strong>${s.owned}</strong></div>
      <div class="sealed-stat"><span>Free to use</span><strong>${s.available}</strong></div>
      <div class="sealed-stat"><span>Missing</span><strong>${s.missing}</strong></div>
      <div class="sealed-stat" title="Cheapest TCGplayer printing of each missing card, basics left out"><span>Missing cost</span><strong>${money(s.missingCost)}</strong></div>
    </div>

    <div class="edhrec-controls">
      <div class="edhrec-chips">
        ${Object.keys(FILTERS).map((f) => `
          <button type="button" class="btn btn-sm ${state.filter === f ? 'btn-primary' : 'btn-secondary'}" data-filter="${f}">
            ${{ all: 'All', owned: 'Owned', available: 'Free to use', missing: 'Missing' }[f]}
          </button>`).join('')}
      </div>
      <select data-control="category">
        <option value="all">All categories</option>
        ${data.categories.map((c) => `<option value="${escapeHtml(c.tag)}" ${state.category === c.tag ? 'selected' : ''}>${escapeHtml(c.header)} (${c.names.length})</option>`).join('')}
      </select>
      <select data-control="sort">
        ${['inclusion', 'synergy', 'price', 'name'].map((k) => `<option value="${k}" ${state.sort === k ? 'selected' : ''}>Sort: ${k}</option>`).join('')}
      </select>
    </div>

    <div class="edhrec-actions">
      <span class="edhrec-muted">${state.picked.size} picked</span>
      <button type="button" class="btn btn-sm btn-secondary" data-action="shopping" ${state.picked.size ? '' : 'disabled'}>
        <i class="ph ph-shopping-cart btn-icon"></i> Add to shopping list
      </button>
      <button type="button" class="btn btn-sm btn-secondary" data-action="deck" ${state.picked.size ? '' : 'disabled'}>
        <i class="ph ph-cards btn-icon"></i> New idea deck
      </button>
      <button type="button" class="btn btn-sm btn-secondary" data-action="copy" ${state.picked.size ? '' : 'disabled'}>
        <i class="ph ph-copy btn-icon"></i> Copy list
      </button>
      <button type="button" class="btn btn-sm btn-secondary" data-action="clear" ${state.picked.size ? '' : 'disabled'}>Clear</button>
    </div>

    <div class="edhrec-table-wrap">
      <table class="sealed-table edhrec-table">
        <thead><tr>
          <th><input type="checkbox" data-action="pick-all" ${allPicked ? 'checked' : ''} title="Pick every card shown" /></th>
          <th>Card</th><th>Category</th>
          <th class="num" title="Share of this commander's decks that run it">Inclusion</th>
          <th class="num" title="How much more often than in other decks of these colours">Synergy</th>
          <th class="num" title="Free to use / owned">Have</th>
          <th class="num">Price</th>
        </tr></thead>
        <tbody>
          ${rows.map((c) => `
            <tr class="${FILTERS.owned(c) ? 'edhrec-row-owned' : ''}">
              <td><input type="checkbox" data-pick="${escapeHtml(c.name)}" ${state.picked.has(c.name) ? 'checked' : ''} /></td>
              <td>${c.cardId
                ? `<a href="#" class="edhrec-card" data-card-id="${c.cardId}">${escapeHtml(c.name)}</a>`
                : escapeHtml(c.name)}</td>
              <td class="edhrec-muted">${escapeHtml(c.category)}</td>
              <td class="num">${pct(c.inclusion)}</td>
              <td class="num">${signedPct(c.synergy)}</td>
              <td class="num">${ownedCell(c)}</td>
              <td class="num">${c.isBasic ? '—' : money(c.price)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${rows.length ? '' : '<div class="sealed-empty">No cards match this filter.</div>'}
    </div>
  `;
}

async function lookup(query, refresh = false) {
  if (!query) return;
  showLoading();
  try {
    const data = await api.getEdhrecCommander(query, refresh);
    if (!state.data || state.data.slug !== data.slug) {
      state = { ...state, picked: new Set(), category: 'all' };
    }
    state.data = data;
    state.query = query;
    render();
  } catch (error) {
    showToast(error.message || 'EDHREC lookup failed', 'error', 5000);
  } finally {
    hideLoading();
  }
}

function pickedNames() {
  // In the table's order, so a copied list reads the way it was shown.
  return state.data.cards.map((c) => c.name).filter((n) => state.picked.has(n));
}

async function addToShopping() {
  const basics = new Set(state.data.cards.filter((c) => c.isBasic).map((c) => c.name));
  const names = pickedNames().filter((n) => !basics.has(n));
  if (!names.length) return showToast('Only basic lands picked — those are never on the shopping list', 'info');
  showLoading();
  try {
    const result = await api.addWantedCardsBulk(names.map((n) => `1 ${n}`).join('\n'));
    const missed = result.unresolved?.length || 0;
    showToast(`Added ${result.added.length} to the shopping list${missed ? ` (${missed} not found)` : ''}`, missed ? 'warning' : 'success');
  } catch (error) {
    showToast(error.message || 'Could not add to the shopping list', 'error');
  } finally {
    hideLoading();
  }
}

async function createDeck() {
  const commander = state.data.commander.name;
  showLoading();
  try {
    const result = await api.createEdhrecDeck({ commander, cardNames: pickedNames() });
    const missed = result.unresolved?.length || 0;
    showToast(`Created idea deck "${result.deck.name}" with ${result.imported} cards${missed ? ` (${missed} not found)` : ''}`, missed ? 'warning' : 'success');
    window.dispatchEvent(new CustomEvent('open-deck', { detail: { deckId: result.deck.id } }));
  } catch (error) {
    showToast(error.message || 'Could not create the deck', 'error');
  } finally {
    hideLoading();
  }
}

async function copyList() {
  const text = pickedNames().map((n) => `1 ${n}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${state.picked.size} cards`);
  } catch {
    showToast('Clipboard unavailable in this browser', 'error');
  }
}

export function setupEdhrec() {
  const form = document.getElementById('edhrec-form');
  const result = document.getElementById('edhrec-result');
  if (!form || !result) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    lookup(form.q.value.trim());
  });

  result.addEventListener('click', (e) => {
    const filter = e.target.closest('[data-filter]');
    if (filter) { state.filter = filter.dataset.filter; render(); return; }

    const card = e.target.closest('.edhrec-card');
    if (card) {
      e.preventDefault();
      showCardDetail(Number(card.dataset.cardId));
      return;
    }

    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'refresh') lookup(state.query, true);
    else if (action === 'shopping') addToShopping();
    else if (action === 'deck') createDeck();
    else if (action === 'copy') copyList();
    else if (action === 'clear') { state.picked.clear(); render(); }
  });

  result.addEventListener('change', (e) => {
    const control = e.target.dataset.control;
    if (control) { state[control] = e.target.value; render(); return; }

    if (e.target.dataset.action === 'pick-all') {
      for (const c of visibleCards()) {
        if (e.target.checked) state.picked.add(c.name); else state.picked.delete(c.name);
      }
      render();
      return;
    }
    const name = e.target.dataset.pick;
    if (name != null) {
      if (e.target.checked) state.picked.add(name); else state.picked.delete(name);
      render();
    }
  });

  window.addEventListener('page:edhrec', () => {
    render();
    form.q.focus();
  });
}
