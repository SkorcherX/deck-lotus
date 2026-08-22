import api from '../services/api.js';
import { showLoading, hideLoading, showToast, debounce, confirmDialog } from '../utils/ui.js';

/**
 * Trading cards between users of the same instance.
 *
 * The point of the feature is that a swap is recorded once, by one person,
 * and both collections move together — so the two halves cannot drift apart
 * the way they do when everyone edits their own inventory by hand.
 */

const state = {
  trades: [],
  partners: [],
  draft: null,
  impact: null,
};

/** Blank trade draft against a partner. */
function newDraft(partnerId) {
  return { partnerId, give: [], receive: [], note: '' };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** Stable identity for one printing in one finish, matching the server's key. */
function itemKey(item) {
  return `${item.printingId}:${item.isFoil ? 1 : 0}`;
}

function finishLabel(isFoil) {
  return isFoil ? ' <span style="color:var(--accent);font-size:0.75rem;">foil</span>' : '';
}

function cardLine(item) {
  const set = item.setCode ? ` <span style="color:var(--text-secondary);">${escapeHtml(item.setCode.toUpperCase())}</span>` : '';
  return `${item.quantity}x ${escapeHtml(item.cardName)}${set}${finishLabel(item.isFoil)}`;
}

// ---------------------------------------------------------------------------
// Trade list
// ---------------------------------------------------------------------------

const STATUS_STYLE = {
  pending: { label: 'Awaiting reply', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' },
  accepted: { label: 'Done', background: '#16a34a', color: '#fff' },
  declined: { label: 'Declined', background: '#71717a', color: '#fff' },
  cancelled: { label: 'Cancelled', background: '#71717a', color: '#fff' },
};

function statusBadge(status) {
  const style = STATUS_STYLE[status] || STATUS_STYLE.pending;
  return `<span style="font-size:0.75rem;padding:0.2rem 0.5rem;border-radius:4px;background:${style.background};color:${style.color};">${style.label}</span>`;
}

function tradeCard(trade) {
  const giving = trade.giving.length
    ? trade.giving.map((item) => `<li>${cardLine(item)}</li>`).join('')
    : '<li style="color:var(--text-secondary);">Nothing</li>';

  const receiving = trade.receiving.length
    ? trade.receiving.map((item) => `<li>${cardLine(item)}</li>`).join('')
    : '<li style="color:var(--text-secondary);">Nothing</li>';

  const actions = [];

  if (trade.canAccept) {
    actions.push(`<button class="btn btn-primary btn-sm trade-accept" data-id="${trade.id}">Accept</button>`);
    actions.push(`<button class="btn btn-secondary btn-sm trade-decline" data-id="${trade.id}">Decline</button>`);
  }
  if (trade.canCancel) {
    actions.push(`<button class="btn btn-secondary btn-sm trade-cancel" data-id="${trade.id}">Cancel</button>`);
  }

  const heading = trade.viewerIsProposer
    ? `You offered ${escapeHtml(trade.counterpartyName)}`
    : `${escapeHtml(trade.counterpartyName)} offered you`;

  return `
    <div class="settings-section" style="padding:1rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:0.75rem;">
        <strong>${heading}</strong>
        <div style="display:flex;gap:0.5rem;align-items:center;">
          ${statusBadge(trade.status)}
          ${actions.join('')}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;">
        <div>
          <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.25rem;">
            <i class="ph ph-arrow-up-right"></i> You send
          </div>
          <ul style="margin:0;padding-left:1.1rem;font-size:0.9rem;">${giving}</ul>
        </div>
        <div>
          <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.25rem;">
            <i class="ph ph-arrow-down-left"></i> You get
          </div>
          <ul style="margin:0;padding-left:1.1rem;font-size:0.9rem;">${receiving}</ul>
        </div>
      </div>
      ${trade.note ? `<div style="margin-top:0.75rem;font-size:0.85rem;color:var(--text-secondary);font-style:italic;">${escapeHtml(trade.note)}</div>` : ''}
    </div>
  `;
}

function renderTrades() {
  const list = document.getElementById('trades-list');
  const empty = document.getElementById('trades-empty');

  if (!state.trades.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  // Trades waiting on somebody come first: they are the only ones that need
  // an action, and burying them under finished history is how they get missed.
  const pending = state.trades.filter((trade) => trade.status === 'pending');
  const history = state.trades.filter((trade) => trade.status !== 'pending');

  const section = (title, trades) => (trades.length
    ? `<h3 style="margin:1rem 0 0.5rem;font-size:0.95rem;color:var(--text-secondary);">${title}</h3>
       ${trades.map(tradeCard).join('')}`
    : '');

  list.innerHTML = section('Open', pending) + section('History', history);

  list.querySelectorAll('.trade-accept').forEach((btn) => {
    btn.addEventListener('click', () => respond(btn.dataset.id, 'accept'));
  });
  list.querySelectorAll('.trade-decline').forEach((btn) => {
    btn.addEventListener('click', () => respond(btn.dataset.id, 'decline'));
  });
  list.querySelectorAll('.trade-cancel').forEach((btn) => {
    btn.addEventListener('click', () => respond(btn.dataset.id, 'cancel'));
  });
}

/**
 * Accepting is the moment both collections move, so it is worth one
 * confirmation — and worth saying plainly what it will do.
 */
async function respond(tradeId, action) {
  if (action === 'accept') {
    const ok = await confirmDialog({
      title: 'Accept this trade?',
      message: 'Both collections update straight away. Any deck left short will tell you.',
      confirmText: 'Accept',
    });
    if (!ok) return;
  }

  try {
    showLoading();

    if (action === 'accept') await api.acceptTrade(tradeId);
    if (action === 'decline') await api.declineTrade(tradeId);
    if (action === 'cancel') await api.cancelTrade(tradeId);

    await loadTrades();
    window.dispatchEvent(new CustomEvent('trades:changed'));
    hideLoading();

    showToast(
      action === 'accept' ? 'Trade done — both collections updated' : `Trade ${action}led`,
      'success'
    );
  } catch (error) {
    hideLoading();
    showToast(error.message, 'error');
  }
}

async function loadTrades() {
  const [trades, partners] = await Promise.all([
    api.getTrades(),
    api.getTradePartners(),
  ]);

  state.trades = trades.trades;
  state.partners = partners.partners;

  renderTrades();
  renderPartnerOptions();
}

// ---------------------------------------------------------------------------
// Trade builder
// ---------------------------------------------------------------------------

function renderPartnerOptions() {
  const select = document.getElementById('trade-partner-select');
  if (!select) return;

  const previous = select.value;

  select.innerHTML =
    '<option value="">Choose someone…</option>' +
    state.partners.map((partner) => (
      `<option value="${partner.id}">${escapeHtml(partner.username)} (${partner.card_count} cards)</option>`
    )).join('');

  if (previous) select.value = previous;
}

function showBuilder(show) {
  document.getElementById('trade-builder').classList.toggle('hidden', !show);
  document.getElementById('trades-list-section').classList.toggle('hidden', show);
}

/**
 * One side of the draft: the cards moving in a single direction.
 *
 * Rendered from the draft rather than from the search results, so a card
 * stays visible after the search box is cleared.
 */
function renderDraftSide(side) {
  const container = document.getElementById(`trade-draft-${side}`);
  const items = state.draft[side];

  if (!items.length) {
    container.innerHTML = '<div style="color:var(--text-secondary);font-size:0.875rem;padding:0.5rem 0;">Nothing yet.</div>';
    return;
  }

  container.innerHTML = items.map((item) => `
    <div style="display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0;border-bottom:1px solid var(--border);">
      <div style="flex:1;font-size:0.9rem;">${cardLine(item)}</div>
      <input type="number" min="1" max="${item.available}" value="${item.quantity}"
             class="trade-qty" data-side="${side}" data-key="${itemKey(item)}"
             style="width:60px;" />
      <button class="btn btn-secondary btn-sm trade-remove" data-side="${side}" data-key="${itemKey(item)}">
        <i class="ph ph-x"></i>
      </button>
    </div>
  `).join('');

  container.querySelectorAll('.trade-qty').forEach((input) => {
    input.addEventListener('change', () => {
      const item = state.draft[input.dataset.side].find((entry) => itemKey(entry) === input.dataset.key);
      if (!item) return;

      const wanted = parseInt(input.value, 10) || 1;
      // Nobody can trade more copies than they hold; clamp rather than let the
      // server reject the whole trade at the end.
      item.quantity = Math.max(1, Math.min(wanted, item.available));
      input.value = item.quantity;

      refreshImpact();
    });
  });

  container.querySelectorAll('.trade-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.draft[btn.dataset.side] = state.draft[btn.dataset.side]
        .filter((entry) => itemKey(entry) !== btn.dataset.key);

      renderDraftSide(btn.dataset.side);
      refreshImpact();
    });
  });
}

/** Add a printing to one side, or bump it if it is already there. */
function addToDraft(side, printing, cardName) {
  const item = {
    printingId: printing.printing_id,
    isFoil: printing.is_foil === 1,
    cardName,
    setCode: printing.set_code,
    available: printing.quantity,
    quantity: 1,
  };

  const existing = state.draft[side].find((entry) => itemKey(entry) === itemKey(item));

  if (existing) {
    if (existing.quantity >= existing.available) {
      showToast(`Only ${existing.available} of those to trade`, 'error');
      return;
    }
    existing.quantity += 1;
  } else {
    state.draft[side].push(item);
  }

  renderDraftSide(side);
  refreshImpact();
}

/**
 * Search results for one side. 'give' searches the user's own collection,
 * 'receive' searches the partner's — the whole reason the partner inventory
 * endpoint exists is so a trade can be built from what they actually have
 * rather than from memory.
 */
async function runSearch(side, term) {
  const results = document.getElementById(`trade-search-results-${side}`);

  if (!term || term.length < 2) {
    results.innerHTML = '';
    return;
  }

  try {
    const data = side === 'give'
      ? await api.getInventory({ name: term, limit: 15 })
      : await api.getPartnerInventory(state.draft.partnerId, { name: term, limit: 15 });

    if (!data.cards.length) {
      results.innerHTML = '<div style="padding:0.5rem;color:var(--text-secondary);font-size:0.875rem;">Nothing owned by that name.</div>';
      return;
    }

    results.innerHTML = data.cards.map((card) => `
      <div style="padding:0.4rem 0;border-bottom:1px solid var(--border);">
        <div style="font-size:0.9rem;font-weight:600;">${escapeHtml(card.name)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-top:0.25rem;">
          ${card.printings.map((printing) => `
            <button class="btn btn-secondary btn-sm trade-add"
                    data-side="${side}"
                    data-card="${escapeHtml(card.name)}"
                    data-printing='${escapeHtml(JSON.stringify(printing))}'>
              ${escapeHtml((printing.set_code || '').toUpperCase())}
              ${printing.is_foil === 1 ? '★' : ''}
              &times;${printing.quantity}
            </button>
          `).join('')}
        </div>
      </div>
    `).join('');

    results.querySelectorAll('.trade-add').forEach((btn) => {
      btn.addEventListener('click', () => {
        addToDraft(btn.dataset.side, JSON.parse(btn.dataset.printing), btn.dataset.card);
      });
    });
  } catch (error) {
    results.innerHTML = `<div style="padding:0.5rem;color:var(--danger,#dc2626);font-size:0.875rem;">${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Ask the server what this draft would cost both sides' decks.
 *
 * Warnings, never blocks. A card being in a deck is not a reason it cannot be
 * traded — it is a reason to be told before agreeing to it.
 */
const refreshImpact = debounce(async () => {
  const warnings = document.getElementById('trade-warnings');
  const draft = state.draft;

  if (!draft || !draft.partnerId || (!draft.give.length && !draft.receive.length)) {
    warnings.innerHTML = '';
    return;
  }

  try {
    const items = [
      ...draft.give.map((item) => ({ ...item, direction: 'give' })),
      ...draft.receive.map((item) => ({ ...item, direction: 'receive' })),
    ];

    state.impact = await api.previewTrade(draft.partnerId, items);
    warnings.innerHTML = renderImpact(state.impact);
  } catch (error) {
    warnings.innerHTML = `<div style="color:var(--danger,#dc2626);font-size:0.875rem;">${escapeHtml(error.message)}</div>`;
  }
}, 350);

function partnerName() {
  const partner = state.partners.find((entry) => entry.id === Number(state.draft.partnerId));
  return partner ? partner.username : 'they';
}

/** Turn the server's shortfall figures into sentences a person can act on. */
function renderImpact(impact) {
  const blocks = [];

  const describe = (rows, who) => rows.map((row) => {
    const decks = row.decks
      .map((deck) => `${escapeHtml(deck.deckName)} (${deck.boardType === 'mainboard' ? 'main' : deck.boardType}) would be ${deck.quantity} short`)
      .join('; ');

    return `<li><strong>${escapeHtml(row.cardName)}</strong>${row.isFoil ? ' (foil)' : ''} — ${who} ${decks}.</li>`;
  }).join('');

  if (impact.from.length) {
    blocks.push(`
      <div style="padding:0.75rem;border-radius:8px;background:var(--bg-tertiary);margin-bottom:0.5rem;">
        <div style="font-weight:600;margin-bottom:0.25rem;">
          <i class="ph ph-warning"></i> This takes cards out of your decks
        </div>
        <ul style="margin:0;padding-left:1.1rem;font-size:0.875rem;">${describe(impact.from, 'your')}</ul>
        <div style="font-size:0.8rem;color:var(--text-secondary);margin-top:0.4rem;">
          You can still trade them. Each deck will tell you afterwards, and you decide
          whether it drops the card or keeps listing it.
        </div>
      </div>
    `);
  }

  if (impact.to.length) {
    blocks.push(`
      <div style="padding:0.75rem;border-radius:8px;background:var(--bg-tertiary);margin-bottom:0.5rem;">
        <div style="font-weight:600;margin-bottom:0.25rem;">
          <i class="ph ph-warning"></i> This takes cards out of ${escapeHtml(partnerName())}'s decks
        </div>
        <ul style="margin:0;padding-left:1.1rem;font-size:0.875rem;">${describe(impact.to, 'their')}</ul>
      </div>
    `);
  }

  return blocks.join('');
}

async function submitDraft() {
  const draft = state.draft;

  if (!draft.give.length && !draft.receive.length) {
    showToast('Add at least one card', 'error');
    return;
  }

  const items = [
    ...draft.give.map((item) => ({ ...item, direction: 'give' })),
    ...draft.receive.map((item) => ({ ...item, direction: 'receive' })),
  ];

  try {
    showLoading();
    await api.createTrade(draft.partnerId, items, document.getElementById('trade-note').value || null);

    state.draft = null;
    showBuilder(false);
    await loadTrades();
    window.dispatchEvent(new CustomEvent('trades:changed'));
    hideLoading();

    showToast('Trade sent — nothing moves until they accept', 'success');
  } catch (error) {
    hideLoading();
    showToast(error.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Deck disruptions
// ---------------------------------------------------------------------------

/**
 * The banner a deck shows when a card it lists has been traded away.
 *
 * Nothing has been removed from the deck at this point. The owner is being
 * asked to decide, and until they do the deck is shown exactly as they left
 * it — see the note in deckService.getDeckStats.
 */
export function renderDisruptionBanner(container, disruptions, onResolved) {
  if (!container) return;

  if (!disruptions || !disruptions.length) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = `
    <div style="padding:0.85rem 1rem;border-radius:8px;background:var(--bg-tertiary);border-left:3px solid var(--accent, #f59e0b);">
      <div style="font-weight:600;margin-bottom:0.5rem;">
        <i class="ph ph-arrows-left-right"></i>
        ${disruptions.length === 1 ? 'A card in this deck was traded away' : 'Cards in this deck were traded away'}
      </div>
      <div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:0.6rem;">
        The deck still lists ${disruptions.length === 1 ? 'it' : 'them'}. Drop
        ${disruptions.length === 1 ? 'it' : 'each one'} to make the deck match what you own,
        or keep ${disruptions.length === 1 ? 'it' : 'them'} listed if you plan to get another copy.
      </div>
      ${disruptions.map((disruption) => `
        <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;padding:0.4rem 0;border-top:1px solid var(--border);">
          <div style="flex:1;min-width:180px;font-size:0.9rem;">
            <strong>${disruption.quantity}x ${escapeHtml(disruption.cardName)}</strong>${finishLabel(disruption.isFoil)}
            <span style="color:var(--text-secondary);">
              from the ${disruption.boardType === 'mainboard' ? 'main deck' : disruption.boardType}${disruption.tradedTo ? ` — traded to ${escapeHtml(disruption.tradedTo)}` : ''}
            </span>
          </div>
          <button class="btn btn-primary btn-sm disruption-resolve" data-id="${disruption.id}" data-resolution="removed">
            Drop from deck
          </button>
          <button class="btn btn-secondary btn-sm disruption-resolve" data-id="${disruption.id}" data-resolution="kept">
            Keep listed
          </button>
        </div>
      `).join('')}
    </div>
  `;

  container.querySelectorAll('.disruption-resolve').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        showLoading();
        await api.acknowledgeDisruption(btn.dataset.id, btn.dataset.resolution);
        hideLoading();

        showToast(
          btn.dataset.resolution === 'removed'
            ? 'Removed from the deck — the deck size now reflects what you own'
            : 'Kept in the deck list',
          'success'
        );

        if (onResolved) await onResolved();
      } catch (error) {
        hideLoading();
        showToast(error.message, 'error');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function setupTrades() {
  const startBtn = document.getElementById('trade-new-btn');
  const cancelBtn = document.getElementById('trade-cancel-btn');
  const sendBtn = document.getElementById('trade-send-btn');
  const partnerSelect = document.getElementById('trade-partner-select');

  startBtn.addEventListener('click', () => {
    if (!state.partners.length) {
      showToast('Nobody else has an account on this instance yet', 'error');
      return;
    }

    state.draft = newDraft('');
    document.getElementById('trade-note').value = '';
    document.getElementById('trade-warnings').innerHTML = '';
    partnerSelect.value = '';

    renderDraftSide('give');
    renderDraftSide('receive');
    showBuilder(true);
  });

  cancelBtn.addEventListener('click', () => {
    state.draft = null;
    showBuilder(false);
  });

  sendBtn.addEventListener('click', submitDraft);

  partnerSelect.addEventListener('change', () => {
    if (!state.draft) return;

    state.draft.partnerId = partnerSelect.value;

    // The receive side is drawn from the partner's collection, so switching
    // partner invalidates it. The give side is the user's own and survives.
    state.draft.receive = [];
    document.getElementById('trade-search-results-receive').innerHTML = '';
    renderDraftSide('receive');

    document.getElementById('trade-receive-pane')
      .classList.toggle('hidden', !partnerSelect.value);

    refreshImpact();
  });

  for (const side of ['give', 'receive']) {
    const input = document.getElementById(`trade-search-${side}`);
    input.addEventListener('input', debounce(() => runSearch(side, input.value.trim()), 300));
  }

  window.addEventListener('page:trades', async () => {
    try {
      showLoading();
      showBuilder(false);
      await loadTrades();
      hideLoading();
    } catch (error) {
      hideLoading();
      showToast('Failed to load trades: ' + error.message, 'error');
    }
  });
}

/** Navbar badge: how many trades are waiting on this user. */
export async function refreshTradeBadge() {
  const badge = document.getElementById('trade-pending-badge');
  if (!badge) return;

  try {
    const { count } = await api.getPendingTradeCount();

    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  } catch {
    // A missing badge is not worth an error message.
    badge.classList.add('hidden');
  }
}
