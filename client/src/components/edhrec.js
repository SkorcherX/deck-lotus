import api from '../services/api.js';
import { showLoading, hideLoading, showToast } from '../utils/ui.js';
import { showCardDetail } from './cards.js';
import { TYPES, typeOf } from '../../../src/shared/pullLayout.js';

/**
 * The EDHREC page: type a commander, see the cards EDHREC says its decks run,
 * each marked with how many you own and how many are free (not in a deck, not
 * lent out). Picked cards can go to the shopping list or into a new `idea`
 * deck, which readiness and the shopping list then take over from.
 *
 * The server caches each commander for a day (src/services/edhrecService.js);
 * Refresh asks EDHREC again.
 *
 * Cards are shown in sections by type, filed the way the pull list files them
 * (pullLayout.js: Creature wins, so an Artifact Creature is a creature), and
 * sorted within each section. Hovering a name shows the card.
 */

let state = {
  data: null, query: '', filter: 'all', category: 'all',
  sort: 'inclusion', desc: true, grouped: true, picked: new Set(),
};

const RARITY_RANK = { common: 1, uncommon: 2, rare: 3, mythic: 4, special: 5 };

// Each sort's natural first direction: the most-played, most synergistic,
// rarest and dearest first; mana value and name low to high.
const SORTS = {
  inclusion: { label: 'Inclusion', desc: true, value: (c) => c.inclusion ?? -1 },
  synergy: { label: 'Synergy', desc: true, value: (c) => c.synergy ?? -2 },
  cmc: { label: 'Mana value', desc: false, value: (c) => c.cmc ?? 99 },
  rarity: { label: 'Rarity', desc: true, value: (c) => RARITY_RANK[c.rarity] ?? 0 },
  price: { label: 'Price', desc: true, value: (c) => c.price ?? -1 },
  have: { label: 'Have', desc: true, value: (c) => (c.isBasic ? 1e6 : c.available * 1000 + c.owned) },
  name: { label: 'Name', desc: false, value: (c) => c.name },
};

const SECTION_LABELS = {
  creature: 'Creatures', planeswalker: 'Planeswalkers', battle: 'Battles', instant: 'Instants',
  sorcery: 'Sorceries', artifact: 'Artifacts', enchantment: 'Enchantments', land: 'Lands',
  other: 'Other', unknown: 'Not in the card database',
};

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
  const { data, filter, category, sort, desc } = state;
  if (!data) return [];
  const inCategory = category === 'all'
    ? null
    : new Set(data.categories.find((c) => c.tag === category)?.names || []);
  const rows = data.cards.filter((c) => FILTERS[filter](c) && (!inCategory || inCategory.has(c.name)));
  const value = (SORTS[sort] || SORTS.inclusion).value;
  const dir = desc ? -1 : 1;
  // Ties fall back to inclusion, then name, so equal mana values still read
  // most-played first.
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const primary = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return primary * dir
      || (b.inclusion ?? 0) - (a.inclusion ?? 0)
      || a.name.localeCompare(b.name);
  });
}

/** Rows split into type sections in TYPES order; cards the database lacks last. */
function sections(rows) {
  if (!state.grouped) return [{ key: 'all', label: null, rows }];
  const byType = new Map();
  for (const c of rows) {
    const key = c.matched ? typeOf(c) : 'unknown';
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(c);
  }
  return [...TYPES.map((t) => t.key), 'unknown']
    .filter((key) => byType.has(key))
    .map((key) => ({ key, label: SECTION_LABELS[key], rows: byType.get(key) }));
}

function rarityCell(c) {
  if (!c.rarity) return '';
  const letter = c.rarity === 'special' ? 'S' : c.rarity[0].toUpperCase();
  return `<span class="rarity-badge rarity-${c.rarity} edhrec-rarity" title="${escapeHtml(c.rarity)}">${letter}</span>`;
}

function sortHeader(key, text, cls = '', title = '') {
  const on = state.sort === key;
  const arrow = on ? `<i class="ph ph-caret-${state.desc ? 'down' : 'up'}"></i>` : '';
  const sort = on ? (state.desc ? 'descending' : 'ascending') : 'none';
  return `<th class="${cls} edhrec-sortable${on ? ' sorted' : ''}" data-sort="${key}"${title ? ` title="${escapeHtml(title)}"` : ''} aria-sort="${sort}">${text}${arrow}</th>`;
}

function rowHtml(c) {
  return `
    <tr class="${FILTERS.owned(c) ? 'edhrec-row-owned' : ''}">
      <td><input type="checkbox" data-pick="${escapeHtml(c.name)}" ${state.picked.has(c.name) ? 'checked' : ''} /></td>
      <td>${c.cardId
        ? `<a href="#" class="edhrec-card" data-card-id="${c.cardId}" data-image="${escapeHtml(c.imageUrl || '')}">${escapeHtml(c.name)}</a>`
        : escapeHtml(c.name)}</td>
      <td class="num">${c.cmc ?? ''}</td>
      <td class="edhrec-center">${rarityCell(c)}</td>
      <td class="edhrec-muted">${escapeHtml(c.category)}</td>
      <td class="num">${pct(c.inclusion)}</td>
      <td class="num">${signedPct(c.synergy)}</td>
      <td class="num">${ownedCell(c)}</td>
      <td class="num">${c.isBasic ? '—' : money(c.price)}</td>
    </tr>`;
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
  hidePreview();
  const el = document.getElementById('edhrec-result');
  const { data } = state;
  if (!data) {
    el.innerHTML = `<div class="sealed-empty">Look up a commander to see the cards EDHREC recommends and which of them you already own.</div>`;
    return;
  }

  const s = data.summary;
  const rows = visibleCards();
  const allPicked = rows.length > 0 && rows.every((c) => state.picked.has(c.name));
  const groups = sections(rows);

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
      <select data-control="sort" aria-label="Sort by">
        ${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${state.sort === k ? 'selected' : ''}>Sort: ${v.label}</option>`).join('')}
      </select>
      <button type="button" class="btn btn-sm btn-secondary" data-action="direction" title="Reverse the order">
        <i class="ph ph-sort-${state.desc ? 'descending' : 'ascending'}"></i> ${state.desc ? 'High → low' : 'Low → high'}
      </button>
      <label class="edhrec-toggle"><input type="checkbox" data-action="grouped" ${state.grouped ? 'checked' : ''} /> Sections by type</label>
    </div>

    <div class="edhrec-actions">
      <span class="edhrec-muted">${state.picked.size} picked${state.picked.size ? ` · ${pickedForShopping().toBuy.length} to buy` : ''}</span>
      <button type="button" class="btn btn-sm btn-secondary" data-action="shopping" ${state.picked.size ? '' : 'disabled'}>
        <i class="ph ph-shopping-cart btn-icon"></i> Add to shopping list
      </button>
      <button type="button" class="btn btn-sm btn-secondary" data-action="add-to-deck" ${state.picked.size ? '' : 'disabled'}>
        <i class="ph ph-plus-square btn-icon"></i> Add to deck
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
          ${sortHeader('name', 'Card')}
          ${sortHeader('cmc', 'MV', 'num', 'Mana value')}
          ${sortHeader('rarity', 'Rarity', 'edhrec-center', 'Lowest rarity it has been printed at')}
          <th>Category</th>
          ${sortHeader('inclusion', 'Inclusion', 'num', "Share of this commander's decks that run it")}
          ${sortHeader('synergy', 'Synergy', 'num', 'How much more often than in other decks of these colours')}
          ${sortHeader('have', 'Have', 'num', 'Free to use / owned')}
          ${sortHeader('price', 'Price', 'num')}
        </tr></thead>
        ${groups.map((g) => {
          const groupPicked = g.rows.every((c) => state.picked.has(c.name));
          const head = g.label
            ? `<tr class="edhrec-section">
                <td><input type="checkbox" data-pick-section="${g.key}" ${groupPicked ? 'checked' : ''} title="Pick every card in this section" /></td>
                <td colspan="8">${escapeHtml(g.label)} <span class="edhrec-muted">${g.rows.length}</span></td>
              </tr>`
            : '';
          return `<tbody>${head}${g.rows.map(rowHtml).join('')}</tbody>`;
        }).join('')}
      </table>
      ${rows.length ? '' : '<div class="sealed-empty">No cards match this filter.</div>'}
    </div>
  `;
}

/**
 * Pick a sort. A header pressed twice reverses it; anything newly picked
 * starts in its natural direction.
 */
function setSort(key, fromHeader) {
  if (!SORTS[key]) return;
  if (fromHeader && state.sort === key) state.desc = !state.desc;
  else { state.sort = key; state.desc = SORTS[key].desc; }
  render();
}

// The hover preview shares the deck builder's #card-preview element. It sits
// beside the name rather than over it, so the row stays readable, and it
// ignores the pointer so it never steals the hover that opened it.
const PREVIEW_WIDTH = 250;
const PREVIEW_HEIGHT = Math.round(PREVIEW_WIDTH * 680 / 488);
const isTouch = () => ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

function showPreview(link) {
  const url = link.dataset.image;
  const preview = document.getElementById('card-preview');
  const img = document.getElementById('card-preview-img');
  if (!url || !preview || !img) return;

  // The normal image may already be cached and shows at once; the large one
  // replaces it when it arrives, unless the pointer has moved on by then.
  const large = url.replace('/normal/', '/large/');
  img.src = url;
  img.dataset.want = large;
  if (large !== url) {
    const loader = new Image();
    loader.onload = () => { if (img.dataset.want === large) img.src = large; };
    loader.src = large;
  }

  const box = link.getBoundingClientRect();
  const margin = 8;
  let left = box.right + 16;
  if (left + PREVIEW_WIDTH > window.innerWidth - margin) left = box.left - PREVIEW_WIDTH - 16;
  left = Math.max(margin, left);
  const top = Math.min(
    Math.max(margin, box.top + box.height / 2 - PREVIEW_HEIGHT / 2),
    window.innerHeight - PREVIEW_HEIGHT - margin
  );
  preview.style.left = `${left}px`;
  preview.style.top = `${top}px`;
  preview.style.right = 'auto';
  preview.classList.remove('hidden');
}

function hidePreview() {
  document.getElementById('card-preview')?.classList.add('hidden');
  const img = document.getElementById('card-preview-img');
  if (img) delete img.dataset.want;
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

/**
 * Picks split by whether they need buying. Picks usually span filters — the
 * owned cards picked for the deck, then the missing ones to buy — so the
 * shopping list takes only cards with no free copy unless told otherwise.
 * A free copy can still be added on purpose (wanting a second one).
 */
function pickedForShopping() {
  const byName = new Map(state.data.cards.map((c) => [c.name, c]));
  const picks = pickedNames().map((n) => byName.get(n)).filter((c) => c && !c.isBasic);
  return {
    toBuy: picks.filter((c) => !(c.available > 0)).map((c) => c.name),
    have: picks.filter((c) => c.available > 0).map((c) => c.name),
  };
}

/** Three-way choice: 'buy' (only cards to buy), 'all', or null (cancelled). */
function chooseShoppingScope(toBuy, have) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    const list = have.slice(0, 8).map(escapeHtml).join(', ') + (have.length > 8 ? `, and ${have.length - 8} more` : '');
    overlay.innerHTML = `
      <div class="modal-content modal-sm confirm-dialog">
        <div class="confirm-icon"><i class="ph-fill ph-shopping-cart"></i></div>
        <h2>You already have ${have.length} of these</h2>
        <p>${have.length} picked card${have.length === 1 ? ' has' : 's have'} a free copy in your collection: ${list}.</p>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-act="cancel">Cancel</button>
          <button class="btn btn-secondary" data-act="all">Add all ${toBuy.length + have.length}</button>
          ${toBuy.length ? `<button class="btn btn-primary" data-act="buy">Add the ${toBuy.length} I need</button>` : ''}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) return done(null);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) done(act === 'cancel' ? null : act);
    });
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-act="buy"], [data-act="all"]').focus();
  });
}

async function addToShopping() {
  const { toBuy, have } = pickedForShopping();
  if (!toBuy.length && !have.length) return showToast('Only basic lands picked — those are never on the shopping list', 'info');
  let names = toBuy;
  if (have.length) {
    const scope = await chooseShoppingScope(toBuy, have);
    if (!scope) return;
    if (scope === 'all') names = [...toBuy, ...have];
  }
  showLoading();
  try {
    const result = await api.addWantedCardsBulk(names.map((n) => `1 ${n}`).join('\n'));
    const missed = result.unresolved?.length || 0;
    showToast(`Added ${result.added.length} to the shopping list${missed ? ` (${missed} not found)` : ''}`, missed ? 'warning' : 'success', 6000, {
      action: { label: 'View list', onClick: () => window.dispatchEvent(new CustomEvent('shopping:open-list')) },
    });
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
    openDeck(result.deck.id);
  } catch (error) {
    showToast(error.message || 'Could not create the deck', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Through the app's navigation, not a bare open-deck event, so the address
 * bar becomes /decks/:id. With the bare event the URL kept pointing at the
 * last deck visited, and a refresh reloaded *that* deck — which, with two
 * decks for one commander, looked like the EDHREC additions being lost.
 */
function openDeck(deckId) {
  window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'deck-builder', deckId } }));
}

// Building first: that is the deck EDHREC is most often filling out. Then
// ideas, finished decks, and retired ones last.
const STATUS_ORDER = { building: 0, idea: 1, ready: 2, retired: 3 };
const STATUS_LABEL = { building: 'Building', idea: 'Idea', ready: 'Ready', retired: 'Retired' };

/** "3 min ago" / "yesterday" from a SQLite UTC timestamp — enough to tell two decks apart. */
function editedAgo(stamp) {
  const then = new Date(String(stamp).replace(' ', 'T') + (String(stamp).endsWith('Z') ? '' : 'Z'));
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Pick one of the user's decks; resolves to its id, or null if cancelled. */
function chooseDeck(decks, commander, count) {
  return new Promise((resolve) => {
    const same = (d) => commander && d.commander_name === commander;
    // Same commander first, and among those the one edited most recently:
    // that is the deck being worked on. Two decks for one commander (an
    // EDHREC import and the copy actually being built, say) otherwise sorted
    // by status and name, which could pre-select the one not being edited.
    const sorted = [...decks].sort((a, b) =>
      Number(same(b)) - Number(same(a))
      || (same(a) && same(b) ? String(b.updated_at || '').localeCompare(String(a.updated_at || '')) : 0)
      || (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
      || String(a.name).localeCompare(String(b.name)));
    const preselect = sorted[0]?.id;

    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-content modal-sm confirm-dialog edhrec-deck-picker">
        <h2>Add ${count} card${count === 1 ? '' : 's'} to a deck</h2>
        <p>Cards the deck already lists are skipped. Owned cards go in at the printing you hold.</p>
        <div class="edhrec-deck-list" role="radiogroup">
          ${sorted.map((d) => `
            <label class="edhrec-deck-option">
              <input type="radio" name="edhrec-deck" value="${d.id}" ${d.id === preselect ? 'checked' : ''}>
              <span>
                <strong>${escapeHtml(d.name)}</strong>
                <span class="edhrec-muted">${escapeHtml(STATUS_LABEL[d.status] || d.status || '')}
                  · ${escapeHtml(d.format || 'no format')} · ${d.mainboard_count || 0} cards${same(d) ? ' · same commander' : ''}
                  ${d.updated_at ? ` · edited ${escapeHtml(editedAgo(d.updated_at))}` : ''}</span>
              </span>
            </label>`).join('')}
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-act="cancel">Cancel</button>
          <button class="btn btn-primary" data-act="ok">Add to deck</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const chosen = () => Number(overlay.querySelector('input[name="edhrec-deck"]:checked')?.value) || null;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) return done(null);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') done(null);
      else if (act === 'ok') done(chosen());
    });
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('input:checked')?.focus();
  });
}

async function addToDeck() {
  const names = pickedNames();
  let decks;
  try {
    ({ decks = [] } = await api.getDecks());
  } catch (error) {
    return showToast(error.message || 'Could not load your decks', 'error');
  }
  if (!decks.length) return showToast('You have no decks yet — use "New idea deck" instead', 'info');

  const deckId = await chooseDeck(decks, state.data.commander.name, names.length);
  if (!deckId) return;

  showLoading();
  try {
    const result = await api.addEdhrecCardsToDeck(deckId, names);
    const notes = [];
    if (result.skipped?.length) notes.push(`${result.skipped.length} already in it`);
    if (result.unresolved?.length) notes.push(`${result.unresolved.length} not found`);
    showToast(
      `Added ${result.added.length} to ${result.deck.name}${notes.length ? ` (${notes.join(', ')})` : ''}`,
      result.unresolved?.length ? 'warning' : 'success',
      6000,
      { action: { label: 'Open deck', onClick: () => openDeck(deckId) } }
    );
  } catch (error) {
    showToast(error.message || 'Could not add to the deck', 'error');
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

// Commander autocomplete on the lookup box. Picking a name looks it up at
// once; a pasted EDHREC URL gets no suggestions and is looked up on Enter.
let suggestTimer = null;
let suggestSeq = 0;
let activeSuggestion = -1;

function closeSuggestions() {
  clearTimeout(suggestTimer);
  suggestSeq++;
  activeSuggestion = -1;
  const box = document.getElementById('edhrec-suggestions');
  box?.classList.add('hidden');
  document.querySelector('#edhrec-form [name="q"]')?.setAttribute('aria-expanded', 'false');
}

function markActive(box) {
  box.querySelectorAll('.search-result-item').forEach((el, i) => {
    el.classList.toggle('active', i === activeSuggestion);
    if (i === activeSuggestion) el.scrollIntoView({ block: 'nearest' });
  });
}

function setupSuggestions(form) {
  const input = form.q;
  const box = document.getElementById('edhrec-suggestions');
  if (!input || !box) return;

  const pick = (name) => {
    input.value = name;
    closeSuggestions();
    lookup(name);
  };

  input.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const q = input.value.trim();
    if (q.length < 2 || /edhrec\.com|^https?:/i.test(q)) return closeSuggestions();
    suggestTimer = setTimeout(async () => {
      const seq = ++suggestSeq;
      let commanders = [];
      try {
        ({ commanders = [] } = await api.suggestEdhrecCommanders(q));
      } catch {
        return;
      }
      // A slower answer to an older query must not replace a newer one.
      if (seq !== suggestSeq) return;
      activeSuggestion = -1;
      if (!commanders.length) return closeSuggestions();
      box.innerHTML = commanders.map((c, i) => `
        <div class="search-result-item" role="option" data-index="${i}" data-name="${escapeHtml(c.name)}">
          <strong>${escapeHtml(c.name)}</strong>
          <span class="edhrec-suggest-type">${escapeHtml(c.typeLine || '')}</span>
        </div>`).join('');
      box.classList.remove('hidden');
      input.setAttribute('aria-expanded', 'true');
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    const items = box.querySelectorAll('.search-result-item');
    if (box.classList.contains('hidden') || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      activeSuggestion = (activeSuggestion + step + items.length) % items.length;
      markActive(box);
    } else if (e.key === 'Enter' && activeSuggestion >= 0) {
      e.preventDefault();
      pick(items[activeSuggestion].dataset.name);
    } else if (e.key === 'Escape') {
      closeSuggestions();
    }
  });

  // mousedown, not click: it fires before the input's blur closes the list.
  box.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.search-result-item');
    if (!item) return;
    e.preventDefault();
    pick(item.dataset.name);
  });
  input.addEventListener('blur', () => setTimeout(closeSuggestions, 100));
}

export function setupEdhrec() {
  const form = document.getElementById('edhrec-form');
  const result = document.getElementById('edhrec-result');
  if (!form || !result) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    closeSuggestions();
    lookup(form.q.value.trim());
  });
  setupSuggestions(form);

  result.addEventListener('click', (e) => {
    const filter = e.target.closest('[data-filter]');
    if (filter) { state.filter = filter.dataset.filter; render(); return; }

    const card = e.target.closest('.edhrec-card');
    if (card) {
      e.preventDefault();
      showCardDetail(Number(card.dataset.cardId));
      return;
    }

    const header = e.target.closest('[data-sort]');
    if (header) { setSort(header.dataset.sort, true); return; }

    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'refresh') lookup(state.query, true);
    else if (action === 'direction') { state.desc = !state.desc; render(); }
    else if (action === 'shopping') addToShopping();
    else if (action === 'deck') createDeck();
    else if (action === 'add-to-deck') addToDeck();
    else if (action === 'copy') copyList();
    else if (action === 'clear') { state.picked.clear(); render(); }
  });

  if (!isTouch()) {
    result.addEventListener('mouseover', (e) => {
      const link = e.target.closest('.edhrec-card');
      if (link && !link.contains(e.relatedTarget)) showPreview(link);
    });
    result.addEventListener('mouseout', (e) => {
      const link = e.target.closest('.edhrec-card');
      if (link && !link.contains(e.relatedTarget)) hidePreview();
    });
  }
  // A scroll or a page change would leave the preview pointing at nothing.
  window.addEventListener('scroll', hidePreview, { passive: true });
  window.addEventListener('page:leave', hidePreview);

  result.addEventListener('change', (e) => {
    const control = e.target.dataset.control;
    if (control === 'sort') { setSort(e.target.value, false); return; }
    if (control) { state[control] = e.target.value; render(); return; }

    if (e.target.dataset.action === 'grouped') { state.grouped = e.target.checked; render(); return; }

    const section = e.target.dataset.pickSection;
    if (section) {
      const group = sections(visibleCards()).find((g) => g.key === section);
      for (const c of group?.rows || []) {
        if (e.target.checked) state.picked.add(c.name); else state.picked.delete(c.name);
      }
      render();
      return;
    }

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
