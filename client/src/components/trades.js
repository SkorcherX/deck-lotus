import api from '../services/api.js';
import { showLoading, hideLoading, showToast, debounce, confirmDialog, celebrate } from '../utils/ui.js';
import { openTradeShop } from './tradeShop.js';

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

function money(value) {
  return value == null ? '—' : `$${Number(value).toFixed(2)}`;
}

/**
 * Colour pips, using the same mana font the rest of the app uses.
 *
 * An empty list means colourless, which is a real answer and worth showing —
 * a card with no pips at all reads as missing data.
 */
function colorPips(colors) {
  if (!colors || !colors.length) return '<i class="ms ms-c ms-cost" title="Colourless"></i>';

  return colors
    .map((color) => `<i class="ms ms-${String(color).toLowerCase()} ms-cost"></i>`)
    .join('');
}

/**
 * The part of a type line before the em dash — "Creature", "Instant" — which
 * is what someone weighing a trade actually scans for. Subtypes make the row
 * long without helping.
 */
function shortType(typeLine) {
  if (!typeLine) return '';
  return typeLine.split('—')[0].trim();
}

/** Name, set and finish: the line that identifies the card. */
function cardLine(item) {
  const set = item.setCode ? ` <span style="color:var(--text-secondary);">${escapeHtml(item.setCode.toUpperCase())}</span>` : '';
  return `${item.quantity}x ${escapeHtml(item.cardName)}${set}${finishLabel(item.isFoil)}`;
}

/**
 * The second line: what the card is and what it is worth. Together with
 * cardLine this is everything needed to judge a swap without opening the card.
 */
function cardDetail(item) {
  const unit = item.unitPrice ?? item.price;
  const line = unit == null ? null : unit * item.quantity;

  const value = unit == null
    ? '<span title="No synced price for this printing">unpriced</span>'
    : (item.quantity > 1 ? `${money(unit)} ea · ${money(line)}` : money(unit));

  return `
    <div style="font-size:0.78rem;color:var(--text-secondary);display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;">
      <span>${colorPips(item.colors)}</span>
      <span>${escapeHtml(shortType(item.typeLine))}</span>
      <span>·</span>
      <span>${value}</span>
    </div>
  `;
}

/**
 * Running total for one side. Unpriced copies are called out rather than
 * counted as free, so a total is never quietly wrong.
 */
function totalsLine(totals) {
  if (!totals.cards) return '';

  const unpriced = totals.unpriced
    ? ` <span style="color:var(--text-secondary);">(${totals.unpriced} unpriced)</span>`
    : '';

  return `
    <div style="display:flex;justify-content:space-between;gap:0.5rem;padding-top:0.4rem;margin-top:0.4rem;border-top:1px solid var(--border);font-size:0.85rem;">
      <span>${totals.cards} card${totals.cards === 1 ? '' : 's'}</span>
      <strong>${money(totals.price)}${unpriced}</strong>
    </div>
  `;
}

/** Totals for a list of draft items, matching the server's totalsFor. */
function draftTotals(items) {
  return {
    cards: items.reduce((sum, item) => sum + item.quantity, 0),
    price: items.reduce((sum, item) => sum + ((item.price ?? 0) * item.quantity), 0),
    unpriced: items.reduce((sum, item) => sum + (item.price == null ? item.quantity : 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Trade list
// ---------------------------------------------------------------------------

const STATUS_STYLE = {
  awaiting_counter: { label: 'Shopping list sent', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' },
  pending: { label: 'Awaiting reply', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' },
  accepted: { label: 'Done', background: 'var(--success-bright)', color: 'var(--on-accent)' },
  declined: { label: 'Declined', background: 'var(--rarity-uncommon)', color: 'var(--on-accent)' },
  cancelled: { label: 'Cancelled', background: 'var(--rarity-uncommon)', color: 'var(--on-accent)' },
};

function statusBadge(status) {
  const style = STATUS_STYLE[status] || STATUS_STYLE.pending;
  return `<span style="font-size:0.75rem;padding:0.2rem 0.5rem;border-radius:4px;background:${style.background};color:${style.color};">${style.label}</span>`;
}

/** One side's cards, or a note saying this side of the trade is empty. */
function tradeSide(items, emptyLabel) {
  if (!items.length) {
    return `<div style="color:var(--text-secondary);font-size:0.875rem;">${emptyLabel}</div>`;
  }

  return items.map((item) => `
    <div style="padding:0.3rem 0;">
      <div style="font-size:0.9rem;">${cardLine(item)}</div>
      ${cardDetail(item)}
    </div>
  `).join('');
}

function tradeCard(trade) {
  const actions = [];

  if (trade.canCounter) {
    actions.push(`<button class="btn btn-primary btn-sm trade-counter" data-id="${trade.id}">Choose what you want</button>`);
  }
  if (trade.canAccept) {
    actions.push(`<button class="btn btn-primary btn-sm trade-accept" data-id="${trade.id}">Accept</button>`);
  }
  if (trade.canDecline) {
    actions.push(`<button class="btn btn-secondary btn-sm trade-decline" data-id="${trade.id}">Decline</button>`);
  }
  if (trade.canCancel) {
    actions.push(`<button class="btn btn-secondary btn-sm trade-cancel" data-id="${trade.id}">Cancel</button>`);
  }

  // A one-sided trade is a gift, and saying so reads better than showing an
  // empty column next to a full one.
  const giftLabel = trade.isGift
    ? (trade.giving.length
      ? `<span style="font-size:0.75rem;padding:0.2rem 0.5rem;border-radius:4px;background:var(--bg-tertiary);color:var(--text-secondary);"><i class="ph ph-gift"></i> Gift</span>`
      : `<span style="font-size:0.75rem;padding:0.2rem 0.5rem;border-radius:4px;background:var(--bg-tertiary);color:var(--text-secondary);"><i class="ph ph-gift"></i> Gift to you</span>`)
    : '';

  const heading = trade.viewerIsProposer
    ? `You offered ${escapeHtml(trade.counterpartyName)}`
    : `${escapeHtml(trade.counterpartyName)} offered you`;

  return `
    <div class="settings-section" style="padding:1rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:0.75rem;">
        <strong>${heading}</strong>
        <div style="display:flex;gap:0.5rem;align-items:center;">
          ${giftLabel}
          ${statusBadge(trade.status)}
          ${actions.join('')}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem;">
        <div>
          <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.25rem;">
            <i class="ph ph-arrow-up-right"></i> You send
          </div>
          ${tradeSide(trade.giving, trade.needsCounter
            ? 'Waiting on their pick from your collection.'
            : 'Nothing — this is a gift to you.')}
          ${totalsLine(trade.givingTotals)}
        </div>
        <div>
          <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.25rem;">
            <i class="ph ph-arrow-down-left"></i> You get
          </div>
          ${tradeSide(trade.receiving, trade.needsCounter
            ? 'Nothing chosen yet — pick what you want back.'
            : 'Nothing back — this is a gift.')}
          ${totalsLine(trade.receivingTotals)}
        </div>
      </div>
      ${declinedBlock(trade)}
      ${trade.note ? `<div style="margin-top:0.75rem;font-size:0.85rem;color:var(--text-secondary);font-style:italic;">${escapeHtml(trade.note)}</div>` : ''}
    </div>
  `;
}

/**
 * Cards the other side kept back when they answered.
 *
 * Shown rather than dropped: somebody who asked for six cards and got four
 * should be able to see which two were refused without diffing their own
 * request against the reply.
 */
function declinedBlock(trade) {
  if (!trade.declinedItems || !trade.declinedItems.length) return '';

  const who = trade.viewerIsProposer
    ? `${escapeHtml(trade.counterpartyName)} kept`
    : 'You kept';

  return `
    <div style="margin-top:0.75rem;padding-top:0.6rem;border-top:1px solid var(--border);font-size:0.85rem;color:var(--text-secondary);">
      <i class="ph ph-hand-palm"></i> ${who} back:
      ${trade.declinedItems.map((item) => `<span style="text-decoration:line-through;">${item.quantity}x ${escapeHtml(item.cardName)}</span>`).join(', ')}
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

  list.querySelectorAll('.trade-counter').forEach((btn) => {
    btn.addEventListener('click', () => startCounter(btn.dataset.id));
  });
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
    // Restate the swap in the confirmation. Accepting is the irreversible
    // step, so it is the right moment to see the two totals next to each
    // other one last time.
    const trade = state.trades.find((entry) => String(entry.id) === String(tradeId));

    const summary = trade
      ? `You send ${trade.givingTotals.cards} card${trade.givingTotals.cards === 1 ? '' : 's'} (${money(trade.givingTotals.price)})`
        + ` and get ${trade.receivingTotals.cards} (${money(trade.receivingTotals.price)}). `
      : '';

    const ok = await confirmDialog({
      title: trade && trade.isGift ? 'Accept this gift?' : 'Accept this trade?',
      message: `${summary}Both collections update straight away. Any deck left short will tell you.`,
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

    // Only an accept. Declining or cancelling is not a moment to mark.
    if (action === 'accept') {
      celebrate('trade', { title: 'Trade complete', detail: 'Both collections updated' });
    }
  } catch (error) {
    hideLoading();
    showToast(error.message, 'error');
  }
}

/**
 * Answer a shopping request by shopping back.
 *
 * The initiator's collection is what gets browsed, and what they asked for
 * travels along so the choice is made against something concrete rather than
 * from memory.
 */
function startCounter(tradeId) {
  const trade = state.trades.find((entry) => String(entry.id) === String(tradeId));
  if (!trade) return;

  showRequestReview(trade);
}

/**
 * Step one of answering: which of these are you actually willing to part with?
 *
 * Asked for six and happy to give four is an ordinary answer, and it used to
 * have nowhere to go — the choice was the whole list or nothing. Turning
 * cards down here keeps the negotiation alive instead of ending it, and the
 * asker is told which ones rather than left comparing lists.
 */
function showRequestReview(trade) {
  const modal = document.getElementById('modal');
  const modalBody = document.getElementById('modal-body');

  // Declines are held here while the modal is open, then handed to the shop.
  const declined = new Set();

  const render = () => {
    const keeping = trade.giving.filter((item) => !declined.has(item.id));

    modalBody.innerHTML = `
      <h2>${escapeHtml(trade.fromUsername)} asked for these</h2>
      <p style="color:var(--text-secondary);font-size:0.9rem;margin:0.5rem 0 1rem;">
        Turn down anything you would rather keep. You will pick what you want
        in return next.
      </p>
      <div style="display:flex;flex-direction:column;gap:0.35rem;">
        ${trade.giving.map((item) => {
          const isDeclined = declined.has(item.id);

          return `
            <div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem;border-radius:8px;background:var(--bg-tertiary);${isDeclined ? 'opacity:0.55;' : ''}">
              <div style="flex:1;min-width:0;">
                <div style="font-size:0.9rem;${isDeclined ? 'text-decoration:line-through;' : ''}">
                  ${cardLine(item)}
                </div>
                ${cardDetail(item)}
              </div>
              <button class="btn btn-sm ${isDeclined ? 'btn-secondary' : 'btn-primary'} review-toggle"
                      data-id="${item.id}">
                ${isDeclined ? 'Keeping' : 'Willing'}
              </button>
            </div>
          `;
        }).join('')}
      </div>
      <div style="margin-top:1rem;font-size:0.875rem;color:var(--text-secondary);">
        ${keeping.length
          ? `Willing to trade ${keeping.length} of ${trade.giving.length}.`
          : 'You have turned down everything — that is a decline, not a counter-offer.'}
      </div>
      <div style="display:flex;gap:0.5rem;margin-top:1rem;">
        <button id="review-continue" class="btn btn-primary" style="flex:1;" ${keeping.length ? '' : 'disabled'}>
          Now pick what you want
        </button>
        <button id="review-cancel" class="btn btn-secondary">Cancel</button>
      </div>
    `;

    modalBody.querySelectorAll('.review-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);

        if (declined.has(id)) declined.delete(id);
        else declined.add(id);

        render();
      });
    });

    document.getElementById('review-cancel').addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    document.getElementById('review-continue').addEventListener('click', () => {
      modal.classList.add('hidden');

      openTradeShop({
        mode: 'counter',
        tradeId: trade.id,
        partner: { id: trade.fromUserId, username: trade.fromUsername },
        // Only the cards they agreed to. The declined ones cost them nothing,
        // so they must not appear in the "this empties your decks" warning.
        askedFor: trade.giving.filter((item) => !declined.has(item.id)),
        declinedItems: trade.giving.filter((item) => declined.has(item.id)),
        declinedItemIds: [...declined],
        onDone: () => {
          showBuilder(false);
          loadTrades();
        },
      });
    });
  };

  render();
  modal.classList.remove('hidden');
}

/**
 * Start a trade by shopping somebody's collection. The picker is a plain list
 * of everyone else — with only a handful of family members on an instance,
 * anything more elaborate would be scaffolding around three names.
 */
function showPartnerPicker() {
  const modalBody = document.getElementById('modal-body');
  const modal = document.getElementById('modal');

  modalBody.innerHTML = `
    <h2>Whose collection?</h2>
    <p style="color:var(--text-secondary);font-size:0.9rem;margin:0.5rem 0 1rem;">
      Browse their cards and pick out what you would like. They choose what they
      want from yours before anything is agreed.
    </p>
    <div style="display:flex;flex-direction:column;gap:0.5rem;">
      ${state.partners.map((partner) => `
        <button class="btn btn-secondary trade-pick-partner" data-id="${partner.id}"
                style="display:flex;justify-content:space-between;align-items:center;gap:1rem;">
          <span>${escapeHtml(partner.username)}</span>
          <span style="color:var(--text-secondary);font-size:0.85rem;">${partner.card_count} cards</span>
        </button>
      `).join('')}
    </div>
  `;

  modal.classList.remove('hidden');

  modalBody.querySelectorAll('.trade-pick-partner').forEach((btn) => {
    btn.addEventListener('click', () => {
      const partner = state.partners.find((entry) => String(entry.id) === btn.dataset.id);

      modal.classList.add('hidden');

      openTradeShop({
        mode: 'request',
        partner,
        onDone: () => loadTrades(),
      });
    });
  });
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
    // Naming the consequence turns an empty column into an offer: a one-sided
    // trade is the way to even up a lopsided swap, and it should not need
    // explaining anywhere else.
    container.innerHTML = `
      <div style="color:var(--text-secondary);font-size:0.875rem;padding:0.5rem 0;">
        Nothing yet — leave this side empty to make it a gift.
      </div>
    `;
    updateGiftSummary();
    return;
  }

  container.innerHTML = items.map((item) => `
    <div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0;border-bottom:1px solid var(--border);">
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.9rem;">${cardLine(item)}</div>
        ${cardDetail(item)}
      </div>
      <input type="number" min="1" max="${item.available}" value="${item.quantity}"
             class="trade-qty" data-side="${side}" data-key="${itemKey(item)}"
             style="width:60px;" />
      <button class="btn btn-secondary btn-sm trade-remove" data-side="${side}" data-key="${itemKey(item)}">
        <i class="ph ph-x"></i>
      </button>
    </div>
  `).join('') + totalsLine(draftTotals(items));

  updateGiftSummary();

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
function addToDraft(side, printing, card) {
  const item = {
    printingId: printing.printing_id,
    isFoil: printing.is_foil === 1,
    cardName: card.name,
    setCode: printing.set_code,
    // Carried from the search result so the draft row can show what the card
    // is and what it costs without a second round trip. The price is the
    // printing's, in the finish being traded — the server values it the same
    // way when the trade is read back.
    typeLine: card.type_line,
    colors: card.colors ? String(card.colors).split(',').filter(Boolean) : [],
    price: printing.price,
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

    results.innerHTML = data.cards.map((card) => {
      const summary = {
        name: card.name,
        type_line: card.type_line,
        colors: card.colors,
      };

      return `
        <div style="padding:0.4rem 0;border-bottom:1px solid var(--border);">
          <div style="font-size:0.9rem;font-weight:600;">${escapeHtml(card.name)}</div>
          <div style="font-size:0.78rem;color:var(--text-secondary);display:flex;align-items:center;gap:0.4rem;">
            <span>${colorPips(card.colors ? String(card.colors).split(',').filter(Boolean) : [])}</span>
            <span>${escapeHtml(shortType(card.type_line))}</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-top:0.25rem;">
            ${card.printings.map((printing) => `
              <button class="btn btn-secondary btn-sm trade-add"
                      data-side="${side}"
                      data-card='${escapeHtml(JSON.stringify(summary))}'
                      data-printing='${escapeHtml(JSON.stringify(printing))}'>
                ${escapeHtml((printing.set_code || '').toUpperCase())}
                ${printing.is_foil === 1 ? '★' : ''}
                &times;${printing.quantity}
                <span style="color:var(--text-secondary);">${money(printing.price)}</span>
              </button>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');

    results.querySelectorAll('.trade-add').forEach((btn) => {
      btn.addEventListener('click', () => {
        addToDraft(
          btn.dataset.side,
          JSON.parse(btn.dataset.printing),
          JSON.parse(btn.dataset.card)
        );
      });
    });
  } catch (error) {
    results.innerHTML = `<div style="padding:0.5rem;color:var(--danger,var(--danger-dark));font-size:0.875rem;">${escapeHtml(error.message)}</div>`;
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
    warnings.innerHTML = `<div style="color:var(--danger,var(--danger-dark));font-size:0.875rem;">${escapeHtml(error.message)}</div>`;
  }
}, 350);

/**
 * The line above the send button: what this trade actually is, in a sentence,
 * with both totals side by side so a lopsided swap is obvious before it is
 * sent rather than after.
 *
 * A one-sided trade is named as a gift here and on the button, which is the
 * whole affordance — there is no separate gift mode to find, you just leave
 * one side empty.
 */
function updateGiftSummary() {
  const summary = document.getElementById('trade-summary');
  const sendBtn = document.getElementById('trade-send-btn');

  if (!summary || !state.draft) return;

  const give = draftTotals(state.draft.give);
  const receive = draftTotals(state.draft.receive);

  if (!give.cards && !receive.cards) {
    summary.innerHTML = '';
    sendBtn.textContent = 'Send Trade';
    return;
  }

  const who = escapeHtml(partnerName());

  if (give.cards && !receive.cards) {
    summary.innerHTML = giftSummary(
      `<i class="ph ph-gift"></i> Gift: you give ${give.cards} card${give.cards === 1 ? '' : 's'}
       worth ${money(give.price)} and get nothing back.`
    );
    sendBtn.textContent = 'Send Gift';
    return;
  }

  if (receive.cards && !give.cards) {
    summary.innerHTML = giftSummary(
      `<i class="ph ph-gift"></i> Gift: ${who} gives you ${receive.cards} card${receive.cards === 1 ? '' : 's'}
       worth ${money(receive.price)} and gets nothing back.`
    );
    sendBtn.textContent = 'Ask for Gift';
    return;
  }

  // Both sides have cards: show the gap, which is the number people actually
  // argue about. Unpriced copies make the gap unreliable, so say so instead of
  // presenting a difference that quietly excludes them.
  const gap = give.price - receive.price;
  const unpriced = give.unpriced + receive.unpriced;

  const balance = unpriced
    ? `${unpriced} card${unpriced === 1 ? '' : 's'} here ${unpriced === 1 ? 'has' : 'have'} no price, so the difference is incomplete.`
    : (Math.abs(gap) < 0.005
      ? 'Even, to the cent.'
      : `${gap > 0 ? 'You are giving' : `${who} is giving`} ${money(Math.abs(gap))} more.`);

  summary.innerHTML = giftSummary(`
    You send ${give.cards} (${money(give.price)}) · you get ${receive.cards} (${money(receive.price)}).
    <strong>${balance}</strong>
  `);

  sendBtn.textContent = 'Send Trade';
}

function giftSummary(inner) {
  return `
    <div style="padding:0.6rem 0.85rem;border-radius:8px;background:var(--bg-tertiary);font-size:0.875rem;">
      ${inner}
    </div>
  `;
}

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

  // What the trade would cost the *other* side's decks is deliberately not
  // reported — see previewImpact. They find out when it reaches them, and
  // showing it here would tell you which of their cards are in decks, which
  // browsing their collection is careful not to.

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
    <div style="padding:0.85rem 1rem;border-radius:8px;background:var(--bg-tertiary);border-left:3px solid var(--accent, var(--warning));">
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
  document.getElementById('trade-shop-btn').addEventListener('click', () => {
    if (!state.partners.length) {
      showToast('Nobody else has an account on this instance yet', 'error');
      return;
    }

    showPartnerPicker();
  });

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
    document.getElementById('trade-summary').innerHTML = '';
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

    // The summary names the partner, so it goes stale when they change.
    updateGiftSummary();
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
