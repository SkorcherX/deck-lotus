import api from '../services/api.js';
import { debounce, formatMana, showToast } from '../utils/ui.js';
import { loadSubtypeOptions } from './inventory.js';
import { canBeCommander, deckUsesCommanders, setCommander } from '../utils/commander.js';

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
let filters = { name: '', subtype: '', type: 'all', rarity: 'all', colors: [], maxCmc: null, role: null, onlyFree: false, formatLegal: false, identityOnly: false };
let page = 1;

// "Fits this deck": rank by the deck's themes rather than by name. The themes
// are read off the deck unless picked here; null for the second means "let the
// server decide", '' means "none". Kept apart from `filters` so the guidance
// actions that replace the filters do not silently switch it off.
let fit = { on: false, main: '', second: null };
let feed = { items: [], total: 0, totalPages: 1 };
let undoStack = [];
let busy = false;

const PAGE_SIZE = 60;

// Human wording for the role filters the deck advisor can hand us, so the chip
// reads as a sentence rather than as the key the API expects.
const ROLE_LABELS = {
  'removal-permanent': 'removal that hits non-creatures',
  'graveyard-hate': 'graveyard hate',
  'card-advantage': 'card advantage',
  'interaction': 'interaction',
  'instant-sorcery': 'instants and sorceries',
  'finisher': 'ways to win'
};

const el = (id) => document.getElementById(id);

/**
 * The toggle's label says what pressing it will do, not what is on screen.
 *
 * It used to read "From Inventory" in both states, so once the panel was open
 * there was nothing to suggest the same button closed it again — people went
 * looking for a way back to the deck and did not find one. Every place that
 * opens or closes the panel goes through here, so the two cannot drift apart.
 */
function setTogglePresentation(open) {
  const toggle = el('inventory-panel-toggle');
  if (!toggle) return;

  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? '← Back to Deck' : 'From Inventory';
  toggle.classList.toggle('is-open', open);
}

export function setupInventoryPanel(context) {
  ctx = context;

  const toggle = el('inventory-panel-toggle');
  const panel = el('inventory-panel');
  const closeBtn = el('inventory-panel-close');

  if (toggle) {
    toggle.addEventListener('click', () => {
      const opening = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !opening);
      setTogglePresentation(opening);
      if (opening) {
        page = 1;
        loadSubtypeOptions();
        loadFeed();
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      panel.classList.add('hidden');
      setTogglePresentation(false);
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

  // Creature type, matched as a whole type ("Elf", not "El"), so a half-typed
  // word shows nothing rather than a misleading near-match.
  const subtype = el('inventory-panel-subtype');
  if (subtype) {
    subtype.addEventListener('input', debounce(() => {
      filters.subtype = subtype.value;
      page = 1;
      loadFeed();
    }, 250));
  }

  const rarityFilter = el('inventory-panel-rarity');
  if (rarityFilter) {
    rarityFilter.addEventListener('change', () => {
      filters.rarity = rarityFilter.value;
      page = 1;
      loadFeed();
    });
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

  const fitBox = el('inventory-panel-fit');
  if (fitBox) {
    fitBox.addEventListener('change', () => {
      fit = { on: fitBox.checked, main: '', second: null };
      page = 1;
      loadFeed();
    });
  }

  el('inventory-panel-fit-main')?.addEventListener('change', (event) => {
    fit.main = event.target.value;
    // The old second may now be the main; let the server pick again.
    fit.second = null;
    page = 1;
    loadFeed();
  });

  el('inventory-panel-fit-second')?.addEventListener('change', (event) => {
    fit.second = event.target.value;
    page = 1;
    loadFeed();
  });

  const colorBar = el('inventory-panel-colors');
  if (colorBar) {
    colorBar.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-color]');
      if (!chip) return;

      const color = chip.dataset.color;
      filters.colors = filters.colors.includes(color)
        ? filters.colors.filter((c) => c !== color)
        : [...filters.colors, color];

      chip.classList.toggle('is-on', filters.colors.includes(color));
      chip.setAttribute('aria-pressed', String(filters.colors.includes(color)));
      page = 1;
      loadFeed();
    });
  }

  // The mana-value filter only ever arrives from a guidance action, so its
  // only control is a way to drop it again.
  const cmcNote = el('inventory-panel-cmc-note');
  if (cmcNote) {
    cmcNote.addEventListener('click', () => {
      filters.maxCmc = null;
      syncFilterControls();
      page = 1;
      loadFeed();
    });
  }

  // Same story for the role filter: it can only arrive from a suggestion, so
  // the only control it needs is a way to drop it again.
  const roleNote = el('inventory-panel-role-note');
  if (roleNote) {
    roleNote.addEventListener('click', () => {
      filters.role = null;
      syncFilterControls();
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
  filters = { name: '', subtype: '', type: 'all', rarity: 'all', colors: [], maxCmc: null, role: null, onlyFree: false, formatLegal: false, identityOnly: false };
  // Themes belong to the deck they were read from.
  fit = { on: false, main: '', second: null };
  const fitBox = el('inventory-panel-fit');
  if (fitBox) fitBox.checked = false;

  syncFilterControls();

  const panel = el('inventory-panel');
  if (panel) panel.classList.add('hidden');

  setTogglePresentation(false);

  renderUndo();
}

/**
 * Open the panel showing the cards a piece of guidance is about — the "3
 * lands short" advice is only useful if it can put those lands in front of
 * you. Replaces the current filters rather than adding to them, so the
 * result always matches what was asked for.
 */
export function openInventoryPanelWith({ type = 'all', colors = [], maxCmc = null, role = null } = {}) {
  filters = {
    name: '',
    subtype: '',
    type: type || 'all',
    rarity: 'all',
    colors: [...colors],
    maxCmc,
    role,
    onlyFree: false,
    formatLegal: false,
    identityOnly: false
  };
  page = 1;

  syncFilterControls();

  const panel = el('inventory-panel');
  if (panel) panel.classList.remove('hidden');
  setTogglePresentation(true);

  loadFeed();
  panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Push the current filter state onto the controls, so the UI does not lie. */
function syncFilterControls() {
  const search = el('inventory-panel-search');
  if (search) search.value = filters.name;

  const subtype = el('inventory-panel-subtype');
  if (subtype) subtype.value = filters.subtype;

  const typeFilter = el('inventory-panel-type');
  if (typeFilter) typeFilter.value = filters.type;

  const rarityFilter = el('inventory-panel-rarity');
  if (rarityFilter) rarityFilter.value = filters.rarity;

  for (const [id, key] of [
    ['inventory-panel-only-free', 'onlyFree'],
    ['inventory-panel-format-legal', 'formatLegal'],
    ['inventory-panel-identity', 'identityOnly']
  ]) {
    const box = el(id);
    if (box) box.checked = Boolean(filters[key]);
  }

  document.querySelectorAll('#inventory-panel-colors [data-color]').forEach((chip) => {
    const on = filters.colors.includes(chip.dataset.color);
    chip.classList.toggle('is-on', on);
    chip.setAttribute('aria-pressed', String(on));
  });

  const cmcNote = el('inventory-panel-cmc-note');
  if (cmcNote) {
    cmcNote.classList.toggle('hidden', !filters.maxCmc);
    cmcNote.textContent = filters.maxCmc ? `mana value ${filters.maxCmc} or less ✕` : '';
  }

  const roleNote = el('inventory-panel-role-note');
  if (roleNote) {
    roleNote.classList.toggle('hidden', !filters.role);
    roleNote.textContent = filters.role ? `${ROLE_LABELS[filters.role] || filters.role} ✕` : '';
  }
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
      subtype: filters.subtype,
      type: filters.type,
      rarity: filters.rarity,
      colors: filters.colors,
      maxCmc: filters.maxCmc,
      role: filters.role,
      fit: fit.on,
      fitTheme: fit.main,
      fitSecondary: fit.second,
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
  if (item.lent > 0) parts.push(`${item.lent} lent out`);

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

  renderFitBar();

  const deck = ctx?.getDeck?.();
  const showCommander = deckUsesCommanders(deck);
  const commanderIds = new Set(
    (deck?.cards || []).filter((c) => c.is_commander).map((c) => c.printing_id)
  );

  if (feed.items.length === 0) {
    list.innerHTML = fit.on && feed.fit && feed.fit.themes.length === 0
      ? `<div class="inventory-panel-empty">
          This deck is not leaning on any theme yet, so there is nothing to rank
          against. Add a few cards that share a plan, or pick a theme above.
        </div>`
      : `<div class="inventory-panel-empty">
          No cards in your collection match these filters.
        </div>`;
  } else {
    list.innerHTML = feed.items.map((item) => {
      const name = escapeHtml(item.cardName);

      // The card image is how most people recognise a card, so it leads. The
      // stored URL is the "normal" size; "large" is the same path.
      // A stale or unreachable image should degrade to the card's name, not a
      // broken-image icon — the tile still has to be usable offline.
      const art = item.imageUrl
        ? `<img class="ip-art" src="${escapeHtml(item.imageUrl)}" alt="${name}" loading="lazy" decoding="async">
           <div class="ip-art ip-art-missing" hidden><span>${name}</span></div>`
        : `<div class="ip-art ip-art-missing"><span>${name}</span></div>`;

      return `
        <div class="inventory-panel-card${item.free < 0 ? ' is-over' : ''}${item.inThisDeck > 0 ? ' in-deck' : ''}"
             data-printing-id="${item.printingId}"
             data-is-foil="${item.isFoil ? '1' : '0'}">
          <div class="ip-art-wrap">
            ${art}
            ${item.isFoil ? '<span class="ip-foil">foil</span>' : ''}
            ${item.inThisDeck > 0 ? `<span class="ip-in-deck">${item.inThisDeck}</span>` : ''}
          </div>
          <div class="ip-body">
            <div class="ip-name" title="${name}">${name}</div>
            <div class="ip-meta">
              <span class="ip-set">${escapeHtml(item.setCode || '')} ${escapeHtml(item.collectorNumber || '')}</span>
              <span class="ip-mana">${formatMana(item.manaCost)}</span>
            </div>
            <div class="ip-avail">${availabilityLine(item)}</div>
            ${item.fit ? `<div class="ip-fit">${fitLine(item.fit)}</div>` : ''}
            <div class="ip-controls">
              <button class="ip-btn" data-action="minus" aria-label="Remove one ${name}"
                      ${item.inThisDeck > 0 ? '' : 'disabled'}>−</button>
              <span class="ip-qty" aria-live="polite">${item.inThisDeck}</span>
              <button class="ip-btn" data-action="plus" aria-label="Add one ${name}">+</button>
              ${showCommander && canBeCommander(item) ? `
                <button class="ip-btn ip-commander${commanderIds.has(item.printingId) ? ' active' : ''}"
                        data-action="commander"
                        title="${commanderIds.has(item.printingId) ? 'Remove as Commander' : 'Set as Commander'}"
                        aria-pressed="${commanderIds.has(item.printingId)}"
                        aria-label="${commanderIds.has(item.printingId) ? 'Remove' : 'Set'} ${name} as commander">⚔️</button>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('img.ip-art').forEach((img) => {
      img.addEventListener('error', () => {
        const fallback = img.nextElementSibling;
        img.hidden = true;
        if (fallback) fallback.hidden = false;
      });
    });

    list.querySelectorAll('.ip-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.inventory-panel-card');
        const printingId = parseInt(row.dataset.printingId, 10);
        const isFoil = row.dataset.isFoil === '1';

        if (btn.dataset.action === 'commander') {
          toggleCommanderFromPanel(printingId, isFoil);
          return;
        }

        adjust(printingId, isFoil, btn.dataset.action === 'plus' ? 1 : -1, true);
      });
    });
  }

  renderPager();
}

/** "graveyard value: payoff · Zombie tribal: enabler" */
function fitLine(itemFit) {
  const ROLE = { both: 'enabler and payoff', payoff: 'payoff', enabler: 'enabler' };
  return itemFit.reasons
    .map((r) => `<strong>${escapeHtml(r.label)}</strong>: ${ROLE[r.role] || r.role}`)
    .join(' · ');
}

/**
 * Which themes the list is ranked for, as two pickers. Filled from what the
 * server actually used, so it shows the themes it read off the deck rather
 * than a guess at them.
 */
function renderFitBar() {
  const bar = el('inventory-panel-fit-bar');
  if (!bar) return;
  const info = fit.on ? feed.fit : null;
  bar.classList.toggle('hidden', !info);
  if (!info) return;

  const [main, second] = info.themes;
  const source = el('inventory-panel-fit-source');
  if (source) source.textContent = info.fromPlan ? "Ranked by this deck's plan:" : 'Ranked for';
  // A theme the deck does not lean on can still have been picked by name, so
  // the in-use ones are always offered even if they are not in the options.
  const offered = [...info.options];
  for (const t of info.themes) {
    if (!offered.some((o) => o.key === t.key)) offered.push(t);
  }
  const option = (t, selected) =>
    `<option value="${escapeHtml(t.key)}"${selected ? ' selected' : ''}>${escapeHtml(t.label)}</option>`;

  const mainSelect = el('inventory-panel-fit-main');
  if (mainSelect) {
    mainSelect.innerHTML = offered.length
      ? offered.map((t) => option(t, main && t.key === main.key)).join('')
      : '<option value="">no theme found</option>';
  }

  const secondSelect = el('inventory-panel-fit-second');
  if (secondSelect) {
    secondSelect.innerHTML = '<option value="">nothing else</option>'
      + offered.filter((t) => !main || t.key !== main.key)
        .map((t) => option(t, second && t.key === second.key)).join('');
  }
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

/**
 * Name a card in the collection as the deck's commander.
 *
 * The flag lives on a deck_cards row, so a card that is not in the deck yet has
 * to be added before it can be flagged — which is what someone picking a
 * commander from their collection means anyway.
 */
async function toggleCommanderFromPanel(printingId, isFoil) {
  const deck = ctx?.getDeck?.();
  if (!deck || busy) return;

  busy = true;

  try {
    const inDeck = (d) => (d.cards || []).find((c) =>
      c.printing_id === printingId &&
      !!c.is_foil === isFoil &&
      (c.board_type || 'mainboard') === 'mainboard'
    );

    let current = deck;
    let row = inDeck(current);

    if (!row) {
      await api.addCardToDeck(deck.id, printingId, 1, false, false, 'mainboard', isFoil);
      current = await ctx.refreshDeck();
      row = inDeck(current || {});
      if (!row) throw new Error('the card could not be added to the deck');
    }

    const { pairedWithPartner } =
      await setCommander(deck.id, current, row.deck_card_id, !row.is_commander);

    await ctx.refreshDeck();
    await loadFeed();

    showToast(
      row.is_commander
        ? 'Commander removed'
        : (pairedWithPartner ? '⚔️ Partner commander set!' : '⚔️ Commander set!'),
      'success',
      2000
    );
  } catch (error) {
    showToast('Could not set the commander: ' + error.message, 'error');
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
