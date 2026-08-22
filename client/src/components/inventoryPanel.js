import api from '../services/api.js';
import { debounce, formatMana, showToast } from '../utils/ui.js';

/**
 * Build a deck from cards you already own.
 *
 * The panel writes straight to the deck rather than holding a draft: every
 * plus and minus is a real change to deck_cards, so saving and resuming are
 * just opening the deck again.
 *
 * The host (deckBuilder) owns the deck, so it passes in a way to read it and a
 * way to re-render after a change.
 */

let ctx = null;              // { getDeck, refreshDeck }
let filters = { name: '', type: 'all', onlyFree: false, formatLegal: false, identityOnly: false };
let page = 1;
let feed = { items: [], total: 0, totalPages: 1 };
let undoStack = [];
let busy = false;

const PAGE_SIZE = 60;

const el = (id) => document.getElementById(id);

export function setupInventoryPanel(context) {
  ctx = context;

  const toggle = el('inventory-panel-toggle');
  const panel = el('inventory-panel');
  const closeBtn = el('inventory-panel-close');

  if (toggle) {
    toggle.addEventListener('click', () => {
      const opening = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !opening);
      toggle.setAttribute('aria-expanded', String(opening));
      if (opening) {
        page = 1;
        loadFeed();
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      panel.classList.add('hidden');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    });
  }

  const search = el('inventory-panel-search');
  if (search) {
    search.addEventListener('input', debounce(() => {
      filters.name = search.value;
      page = 1;
      loadFeed();
    }, 250));
  }

  const typeFilter = el('inventory-panel-type');
  if (typeFilter) {
    typeFilter.addEventListener('change', () => {
      filters.type = typeFilter.value;
      page = 1;
      loadFeed();
    });
  }

  for (const [id, key] of [
    ['inventory-panel-only-free', 'onlyFree'],
    ['inventory-panel-format-legal', 'formatLegal'],
    ['inventory-panel-identity', 'identityOnly']
  ]) {
    const box = el(id);
    if (!box) continue;
    box.addEventListener('change', () => {
      filters[key] = box.checked;
      page = 1;
      loadFeed();
    });
  }

  const undoBtn = el('inventory-panel-undo');
  if (undoBtn) undoBtn.addEventListener('click', undoLast);

  const prev = el('inventory-panel-prev');
  const next = el('inventory-panel-next');
  if (prev) prev.addEventListener('click', () => { if (page > 1) { page--; loadFeed(); } });
  if (next) next.addEventListener('click', () => { if (page < feed.totalPages) { page++; loadFeed(); } });
}

/** Called by the host when a different deck is loaded. */
export function resetInventoryPanel() {
  undoStack = [];
  page = 1;
  filters = { name: '', type: 'all', onlyFree: false, formatLegal: false, identityOnly: false };

  const panel = el('inventory-panel');
  if (panel) panel.classList.add('hidden');

  const toggle = el('inventory-panel-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');

  const search = el('inventory-panel-search');
  if (search) search.value = '';

  renderUndo();
}

/** Refresh the panel's numbers after the deck changed elsewhere. */
export function refreshInventoryPanel() {
  const panel = el('inventory-panel');
  if (panel && !panel.classList.contains('hidden')) loadFeed();
}

/**
 * The colour identity a Commander deck is confined to: the union of the
 * identities of the cards flagged as commanders.
 */
function commanderIdentity(deck) {
  if (!deck || deck.format !== 'commander') return null;

  const commanders = (deck.cards || []).filter((c) => c.is_commander);
  if (commanders.length === 0) return null;

  const colors = new Set();
  for (const c of commanders) {
    for (const color of (c.color_identity || '').split(',')) {
      if (color.trim()) colors.add(color.trim());
    }
  }

  // A colourless commander still confines the deck, so return an empty string
  // rather than null — null would mean "no filter".
  return [...colors].join('');
}

async function loadFeed() {
  const deck = ctx?.getDeck?.();
  const list = el('inventory-panel-list');
  if (!deck || !list) return;

  const identity = filters.identityOnly ? commanderIdentity(deck) : null;

  list.setAttribute('aria-busy', 'true');

  try {
    feed = await api.getBuilderInventory({
      deckId: deck.id,
      name: filters.name,
      type: filters.type,
      onlyFree: filters.onlyFree,
      format: filters.formatLegal ? deck.format : null,
      colorIdentity: identity,
      page,
      limit: PAGE_SIZE
    });

    renderFeed();
  } catch (error) {
    list.innerHTML = `<div class="inventory-panel-empty">Could not load your collection: ${error.message}</div>`;
  } finally {
    list.removeAttribute('aria-busy');
  }
}

/**
 * "4 owned · 3 in other decks · 1 free" — the sentence, not the bare number,
 * because the number alone does not say what to do about it.
 */
function availabilityLine(item) {
  if (item.unlimited) return '<span class="avail-unlimited">basic land · unlimited</span>';

  const parts = [`${item.owned} owned`];
  if (item.committed > 0) parts.push(`${item.committed} in other decks`);
  if (item.inThisDeck > 0) parts.push(`${item.inThisDeck} here`);

  const over = item.free < 0;
  parts.push(
    over
      ? `<span class="avail-over">${Math.abs(item.free)} short</span>`
      : `<span class="avail-free">${item.free} free</span>`
  );

  return parts.join(' · ');
}

function renderFeed() {
  const list = el('inventory-panel-list');
  const count = el('inventory-panel-count');

  if (count) {
    count.textContent = feed.total === 1 ? '1 card' : `${feed.total} cards`;
  }

  if (feed.items.length === 0) {
    list.innerHTML = `<div class="inventory-panel-empty">
      No cards in your collection match these filters.
    </div>`;
  } else {
    list.innerHTML = feed.items.map((item) => `
      <div class="inventory-panel-row${item.free < 0 ? ' is-over' : ''}"
           data-printing-id="${item.printingId}"
           data-is-foil="${item.isFoil ? '1' : '0'}">
        <div class="ip-name">
          ${escapeHtml(item.cardName)}
          ${item.isFoil ? '<span class="ip-foil">foil</span>' : ''}
        </div>
        <div class="ip-meta">
          ${escapeHtml(item.typeLine || '')}
          <span class="ip-set">${escapeHtml(item.setCode || '')} ${escapeHtml(item.collectorNumber || '')}</span>
        </div>
        <div class="ip-avail">${availabilityLine(item)}</div>
        <div class="ip-mana">${formatMana(item.manaCost)}</div>
        <div class="ip-controls">
          <button class="ip-btn" data-action="minus" aria-label="Remove one ${escapeHtml(item.cardName)}"
                  ${item.inThisDeck > 0 ? '' : 'disabled'}>−</button>
          <span class="ip-qty" aria-live="polite">${item.inThisDeck}</span>
          <button class="ip-btn" data-action="plus" aria-label="Add one ${escapeHtml(item.cardName)}">+</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.ip-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.inventory-panel-row');
        adjust(
          parseInt(row.dataset.printingId, 10),
          row.dataset.isFoil === '1',
          btn.dataset.action === 'plus' ? 1 : -1,
          true
        );
      });
    });
  }

  renderPager();
}

function renderPager() {
  const pager = el('inventory-panel-pager');
  const label = el('inventory-panel-page');
  if (!pager || !label) return;

  pager.classList.toggle('hidden', feed.totalPages <= 1);
  label.textContent = `Page ${feed.page} of ${feed.totalPages}`;

  const prev = el('inventory-panel-prev');
  const next = el('inventory-panel-next');
  if (prev) prev.disabled = feed.page <= 1;
  if (next) next.disabled = feed.page >= feed.totalPages;
}

/**
 * Apply a change of `delta` copies of one printing-and-finish to the deck's
 * mainboard. Every mutation goes through here, which is what makes undo cheap.
 */
async function adjust(printingId, isFoil, delta, recordUndo) {
  const deck = ctx?.getDeck?.();
  if (!deck || busy) return;

  busy = true;

  try {
    if (delta > 0) {
      await api.addCardToDeck(deck.id, printingId, delta, false, false, 'mainboard', isFoil);
    } else {
      const existing = (deck.cards || []).find((c) =>
        c.printing_id === printingId &&
        !!c.is_foil === isFoil &&
        (c.board_type || 'mainboard') === 'mainboard'
      );

      if (!existing) return;

      // The service removes the row when quantity reaches zero.
      await api.updateDeckCard(deck.id, existing.deck_card_id, {
        quantity: existing.quantity + delta
      });
    }

    if (recordUndo) {
      undoStack.push({ printingId, isFoil, delta });
      renderUndo();
    }

    await ctx.refreshDeck();
    await loadFeed();
  } catch (error) {
    showToast('Could not update the deck: ' + error.message, 'error');
  } finally {
    busy = false;
  }
}

async function undoLast() {
  const last = undoStack.pop();
  renderUndo();
  if (!last) return;

  await adjust(last.printingId, last.isFoil, -last.delta, false);
}

function renderUndo() {
  const btn = el('inventory-panel-undo');
  if (!btn) return;

  btn.disabled = undoStack.length === 0;
  btn.textContent = undoStack.length > 0 ? `Undo (${undoStack.length})` : 'Undo';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
