import api from '../services/api.js';
import { showToast, debounce } from '../utils/ui.js';

/**
 * The audit log page.
 *
 * Built around one job: a batch of cards was entered wrong — usually a bulk
 * paste with the wrong set code — and somebody needs to see exactly what was
 * typed and what it turned into, so they can put it right. Everything on the
 * page serves finding that batch: the search box covers card name, set code,
 * collector number and deck name; the date range narrows to the evening it
 * happened; and a row that came from a bulk import shows the line as entered
 * next to the printing it actually resolved to.
 */

const el = (id) => document.getElementById(id);

let state = {
  search: '',
  entityType: '',
  action: '',
  source: '',
  userId: '',
  from: '',
  to: '',
  page: 1,
  limit: 50,
};

let pagination = { page: 1, pages: 0, total: 0 };
let loaded = false;

export function setupAudit() {
  window.addEventListener('page:audit', () => {
    if (!loaded) {
      loaded = true;
      loadFilterOptions();
    }
    load();
  });

  const search = el('audit-search');
  if (search) {
    search.addEventListener('input', debounce(() => {
      state.search = search.value.trim();
      state.page = 1;
      load();
    }, 250));
  }

  for (const [id, key] of [
    ['audit-entity', 'entityType'],
    ['audit-action', 'action'],
    ['audit-source', 'source'],
    ['audit-user', 'userId'],
    ['audit-from', 'from'],
    ['audit-to', 'to'],
  ]) {
    const control = el(id);
    if (!control) continue;

    control.addEventListener('change', () => {
      state[key] = control.value;
      state.page = 1;

      // The action and source lists are drawn from what the selected scope
      // actually contains, so switching user has to redraw them or the
      // dropdowns describe somebody else's history.
      if (key === 'userId') loadFilterOptions();

      load();
    });
  }

  const clear = el('audit-clear');
  if (clear) {
    clear.addEventListener('click', () => {
      // The user scope is deliberately kept: an admin who has switched to
      // another user's history is still looking at that user, and silently
      // bouncing them back to their own would read as the filter failing.
      const userId = state.userId;
      state = { ...state, search: '', entityType: '', action: '', source: '', from: '', to: '', page: 1, userId };
      syncControls();
      load();
    });
  }

  const prev = el('audit-prev');
  if (prev) {
    prev.addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        load();
      }
    });
  }

  const next = el('audit-next');
  if (next) {
    next.addEventListener('click', () => {
      if (state.page < pagination.pages) {
        state.page += 1;
        load();
      }
    });
  }
}

function syncControls() {
  const set = (id, value) => {
    const control = el(id);
    if (control) control.value = value;
  };

  set('audit-search', state.search);
  set('audit-entity', state.entityType);
  set('audit-action', state.action);
  set('audit-source', state.source);
  set('audit-from', state.from);
  set('audit-to', state.to);
}

async function loadFilterOptions() {
  try {
    const result = await api.getAuditFilters(state.userId || null);

    fillSelect('audit-action', result.actions, 'All actions', describeAction);
    fillSelect('audit-source', result.sources, 'All sources', describeSource);

    const userSelect = el('audit-user');
    const userGroup = el('audit-user-group');
    if (userSelect && userGroup) {
      // Only an admin gets the user picker; for everybody else the scope is
      // fixed at their own history and a disabled control would just raise
      // the question of whose else they could see.
      //
      // The whole group hides, not just the select — otherwise a stray
      // "User" label is left sitting in the filter bar with nothing under it.
      userGroup.classList.toggle('hidden', !result.isAdmin);

      if (result.isAdmin) {
        const options = [
          '<option value="">My history</option>',
          '<option value="all">Everyone</option>',
          ...result.users.map(
            (user) => `<option value="${user.id}">${escapeHtml(user.username)}</option>`
          ),
        ];
        userSelect.innerHTML = options.join('');
        userSelect.value = state.userId;
      }
    }
  } catch (error) {
    console.error('Failed to load audit filters:', error);
  }
}

function fillSelect(id, values, allLabel, label) {
  const select = el(id);
  if (!select) return;

  const current = select.value;

  select.innerHTML = [
    `<option value="">${allLabel}</option>`,
    ...values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(label(value))}</option>`),
  ].join('');

  // Keep the current choice if it still exists in the new scope.
  select.value = values.includes(current) ? current : '';
}

async function load() {
  const list = el('audit-list');
  if (!list) return;

  list.innerHTML = '<div class="audit-empty">Loading…</div>';

  try {
    const result = await api.getAuditLog(state);
    pagination = result.pagination;
    render(result.entries);
  } catch (error) {
    list.innerHTML = `<div class="audit-empty">Could not load the audit log: ${escapeHtml(error.message)}</div>`;
    showToast('Failed to load audit log: ' + error.message, 'error');
  }
}

function render(entries) {
  const list = el('audit-list');
  const count = el('audit-count');

  if (count) {
    count.textContent = pagination.total === 0
      ? 'No entries'
      : `${pagination.total} entr${pagination.total === 1 ? 'y' : 'ies'}`;
  }

  if (entries.length === 0) {
    list.innerHTML = `
      <div class="audit-empty">
        Nothing matches those filters. History starts from when the audit log
        was added — changes made before that were not recorded.
      </div>
    `;
    renderPager();
    return;
  }

  list.innerHTML = entries.map(renderEntry).join('');
  renderPager();
}

function renderEntry(entry) {
  const when = new Date(entry.created_at.replace(' ', 'T') + 'Z');
  const stamp = Number.isNaN(when.getTime())
    ? entry.created_at
    : when.toLocaleString();

  return `
    <div class="audit-entry audit-${escapeHtml(entry.entity_type)}">
      <div class="audit-entry-main">
        <span class="audit-badge audit-badge-${escapeHtml(entry.entity_type)}">${escapeHtml(describeAction(entry.action))}</span>
        <span class="audit-subject">${subjectOf(entry)}</span>
        ${quantityOf(entry)}
      </div>
      <div class="audit-entry-meta">
        <span>${escapeHtml(stamp)}</span>
        <span>${escapeHtml(describeSource(entry.source))}</span>
        ${actorOf(entry)}
      </div>
      ${enteredAs(entry)}
    </div>
  `;
}

/** The other side of a trade, where the row knows it. */
function counterpartyOf(entry) {
  const name = entry.detail?.counterparty?.username;
  return name ? ` <span class="audit-in">with</span> ${escapeHtml(name)}` : '';
}

/** What the change was about: a card, a deck, or a trade. */
function subjectOf(entry) {
  if (entry.card_name) {
    const printing = [entry.set_code, entry.collector_number].filter(Boolean).join(' ');
    const foil = entry.is_foil ? ' <span class="audit-foil">foil</span>' : '';
    const deck = entry.deck_name
      ? ` <span class="audit-in">in</span> ${escapeHtml(entry.deck_name)}`
      : '';

    // A card that left the collection raises "where did it go?" immediately,
    // and the source pill down in the meta line is not where anyone looks for
    // the answer. Naming the trade partner on the row itself is the
    // difference between a removal that is explained and one that reads as
    // cards going missing.
    return `<strong>${escapeHtml(entry.card_name)}</strong>` +
      (printing ? ` <span class="audit-printing">${escapeHtml(printing)}</span>` : '') +
      foil + deck + counterpartyOf(entry);
  }

  if (entry.deck_name) {
    return `<strong>${escapeHtml(entry.deck_name)}</strong>`;
  }

  if (entry.trade_id) {
    return `<strong>Trade #${entry.trade_id}</strong>${counterpartyOf(entry)}`;
  }

  // A card change whose name could not be recovered still gets a subject
  // rather than an empty line: the printing is what there is to go on, and a
  // blank row is indistinguishable from a rendering fault.
  const printing = [entry.set_code, entry.collector_number].filter(Boolean).join(' ');
  if (printing) {
    return `<span class="audit-unnamed">Unknown card</span> <span class="audit-printing">${escapeHtml(printing)}</span>`;
  }

  return '';
}

function quantityOf(entry) {
  if (entry.quantity_before === null || entry.quantity_after === null) return '';

  const delta = entry.quantity_delta;

  // A change that moved no copies — swapping a card's printing or board —
  // has no quantity worth showing, and "+0" reads like a bug.
  if (!delta) return '';

  const sign = delta > 0 ? '+' : '';

  return `
    <span class="audit-quantity ${delta > 0 ? 'is-up' : 'is-down'}">
      ${sign}${delta}
      <span class="audit-quantity-detail">(${entry.quantity_before} → ${entry.quantity_after})</span>
    </span>
  `;
}

function actorOf(entry) {
  // Only worth showing when somebody other than the collection's owner made
  // the change — which in practice means the far side of a trade.
  if (!entry.actor_username || entry.actor_user_id === entry.user_id) {
    return `<span>${escapeHtml(entry.username || '')}</span>`;
  }

  return `<span>${escapeHtml(entry.username || '')} · by ${escapeHtml(entry.actor_username)}</span>`;
}

/**
 * For a bulk import, the line as typed. This is the whole point of the page:
 * "Lightning Bolt / M10 / 146" resolving to a printing from a different set
 * is invisible unless both halves are shown side by side.
 */
function enteredAs(entry) {
  const entered = entry.detail?.entered;
  if (!entered) return '';

  const typed = [
    entered.cardName,
    entered.setCode ? `(${entered.setCode})` : null,
    entered.collectorNumber,
  ].filter(Boolean).join(' ');

  if (!typed) return '';

  const resolved = [entry.card_name, entry.set_code ? `(${entry.set_code})` : null, entry.collector_number]
    .filter(Boolean).join(' ');

  const mismatch = typed.toLowerCase() !== resolved.toLowerCase();

  return `
    <div class="audit-entered ${mismatch ? 'is-mismatch' : ''}">
      entered as <code>${escapeHtml(typed)}</code>
      ${mismatch ? `→ matched <code>${escapeHtml(resolved)}</code>` : ''}
    </div>
  `;
}

function renderPager() {
  const pager = el('audit-pager');
  const label = el('audit-page-label');
  const prev = el('audit-prev');
  const next = el('audit-next');

  if (!pager) return;

  pager.classList.toggle('hidden', pagination.pages <= 1);

  if (label) label.textContent = `Page ${pagination.page} of ${pagination.pages}`;
  if (prev) prev.disabled = pagination.page <= 1;
  if (next) next.disabled = pagination.page >= pagination.pages;
}

const ACTION_LABELS = {
  'inventory.add': 'Added to collection',
  'inventory.remove': 'Removed from collection',
  'inventory.set': 'Quantity changed',
  'deck.create': 'Deck created',
  'deck.update': 'Deck edited',
  'deck.delete': 'Deck deleted',
  'deck.card_add': 'Card added to deck',
  'deck.card_update': 'Deck card changed',
  'deck.card_remove': 'Card removed from deck',
  'trade.create': 'Trade started',
  'trade.accept': 'Trade accepted',
  'trade.decline': 'Trade declined',
  'trade.cancel': 'Trade cancelled',
  'trade.counter': 'Counter-offer sent',
};

const SOURCE_LABELS = {
  bulk_add: 'Bulk import',
  bulk_remove: 'Bulk remove',
  quick_add: 'Quick add',
  card_page: 'Card page',
  deck_builder: 'Deck builder',
  deck_import: 'Deck import',
  trade: 'Trade',
  scan: 'Scan',
  scanner: 'Phone scanner',
  api: 'API',
};

function describeAction(action) {
  return ACTION_LABELS[action] || action;
}

function describeSource(source) {
  return SOURCE_LABELS[source] || source;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
