import api from '../services/api.js';
import { showLoading, hideLoading, formatDate, showError, showToast, confirmDialog } from '../utils/ui.js';

let decks = [];

/**
 * The manual status vocabulary, mirroring DECK_STATUSES on the server.
 *
 * Deliberately not the words the derived readiness badge uses. The two sit on
 * the same card — status is what you intend, readiness is what your collection
 * says — and a hand-set "Needs Buying" next to a computed "Ready" would read as
 * the app contradicting itself rather than as two different facts.
 */
const DECK_STATUSES = [
  { value: 'ready', label: 'Ready' },
  { value: 'building', label: 'Building' },
  { value: 'idea', label: 'Idea' },
  { value: 'retired', label: 'Retired' },
];

const STATUS_LABELS = Object.fromEntries(DECK_STATUSES.map((s) => [s.value, s.label]));

// 'all' plus one entry per status. Retired decks are included in 'all' rather
// than hidden by default: a status you set yourself vanishing from the list is
// how decks get lost.
let statusFilter = 'all';
let deckSort = 'updated';

export function setupDecks() {
  const newDeckBtn = document.getElementById('new-deck-btn');
  const importDeckBtn = document.getElementById('import-deck-btn');

  newDeckBtn.addEventListener('click', () => {
    showNewDeckModal();
  });

  importDeckBtn.addEventListener('click', () => {
    showImportModal();
  });

  // Load decks when page is shown
  window.addEventListener('page:decks', loadDecks);

  // Logging a game from the deck builder changes a record shown on this page,
  // so the list is re-read rather than kept from the last visit.
  window.addEventListener('decks:changed', loadDecks);
}

function showNewDeckModal() {
  const modal = document.getElementById('modal');
  const modalBody = document.getElementById('modal-body');

  modalBody.innerHTML = `
    <h2>Create New Deck</h2>
    <form id="new-deck-form" style="margin-top: 1.5rem;">
      <div class="form-group">
        <label for="new-deck-name">Deck Name</label>
        <input type="text" id="new-deck-name" required autofocus>
      </div>
      <div class="form-group">
        <label for="new-deck-format">Format (Optional)</label>
        <select id="new-deck-format">
          <option value="">Select Format</option>
          <option value="standard">Standard</option>
          <option value="modern">Modern</option>
          <option value="commander">Commander</option>
          <option value="legacy">Legacy</option>
          <option value="vintage">Vintage</option>
          <option value="pauper">Pauper</option>
        </select>
      </div>
      <div class="form-group">
        <label for="new-deck-status">Status</label>
        <select id="new-deck-status">
          ${DECK_STATUSES.map(
            (s) => `<option value="${s.value}" ${s.value === 'building' ? 'selected' : ''}>${s.label}</option>`
          ).join('')}
        </select>
      </div>
      <div style="display: flex; gap: 0.5rem; margin-top: 1.5rem;">
        <button type="submit" class="btn btn-primary" style="flex: 1;">Create Deck</button>
        <button type="button" class="btn btn-secondary" id="cancel-new-deck">Cancel</button>
      </div>
    </form>
  `;

  modal.classList.remove('hidden');

  // Handle form submission
  document.getElementById('new-deck-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-deck-name').value;
    const format = document.getElementById('new-deck-format').value;
    const status = document.getElementById('new-deck-status').value;

    try {
      showLoading();
      modal.classList.add('hidden');
      await api.createDeck(name, format, '', status);
      await loadDecks();
      hideLoading();
    } catch (error) {
      hideLoading();
      showError('Failed to create deck: ' + error.message);
    }
  });

  // Handle cancel
  document.getElementById('cancel-new-deck').addEventListener('click', () => {
    modal.classList.add('hidden');
  });
}

async function loadDecks() {
  try {
    showLoading();
    const result = await api.getDecks();
    decks = result.decks;
    renderDecks();
    hideLoading();
  } catch (error) {
    hideLoading();
    showToast('Failed to load decks: ' + error.message, 'error');
  }
}

/**
 * The filter chips and sort control above the grid.
 *
 * Counts are shown per status so an empty result is self-explaining — a
 * "Retired (0)" chip you can see is better than clicking it and wondering
 * whether the filter is broken.
 */
function renderDecksToolbar() {
  const toolbar = document.getElementById('decks-toolbar');
  if (!toolbar) return;

  const countFor = (value) =>
    value === 'all' ? decks.length : decks.filter((d) => (d.status || 'building') === value).length;

  const chip = (value, label) => `
    <button class="deck-filter-chip" data-status-filter="${value}"
            aria-pressed="${statusFilter === value}">
      ${label} (${countFor(value)})
    </button>`;

  toolbar.innerHTML = `
    ${chip('all', 'All')}
    ${DECK_STATUSES.map((s) => chip(s.value, s.label)).join('')}
    <div class="decks-toolbar-spacer"></div>
    <select id="deck-sort" class="deck-status-select" aria-label="Sort decks">
      <option value="updated" ${deckSort === 'updated' ? 'selected' : ''}>Recently updated</option>
      <option value="readiness" ${deckSort === 'readiness' ? 'selected' : ''}>Needs work first</option>
      <option value="name" ${deckSort === 'name' ? 'selected' : ''}>Name</option>
    </select>
  `;

  toolbar.querySelectorAll('[data-status-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      statusFilter = btn.dataset.statusFilter;
      renderDecks();
    });
  });

  toolbar.querySelector('#deck-sort').addEventListener('change', (e) => {
    deckSort = e.target.value;
    renderDecks();
  });
}

/**
 * Filtering and sorting happen here rather than server-side: the list endpoint
 * already returns every deck a user owns, and a round trip per chip click would
 * be a request to re-fetch data the page is holding.
 */
function visibleDecks() {
  const filtered =
    statusFilter === 'all'
      ? [...decks]
      : decks.filter((d) => (d.status || 'building') === statusFilter);

  switch (deckSort) {
    case 'readiness':
      // Worst first — the whole point of the sort is surfacing what needs a
      // shop trip or a teardown, so a deck with no readiness data sinks.
      return filtered.sort(
        (a, b) =>
          (b.readiness?.rank || 0) - (a.readiness?.rank || 0) ||
          (b.readiness?.missingCopies || 0) - (a.readiness?.missingCopies || 0) ||
          a.name.localeCompare(b.name)
      );
    case 'name':
      return filtered.sort((a, b) => a.name.localeCompare(b.name));
    case 'updated':
    default:
      // The server already returns them in updated_at order.
      return filtered;
  }
}

function renderDecks() {
  const decksList = document.getElementById('decks-list');

  renderDecksToolbar();

  if (decks.length === 0) {
    decksList.innerHTML = `
      <div class="empty-state">
        <i class="ph ph-cards-three empty-state-icon" aria-hidden="true"></i>
        <h3>No decks yet</h3>
        <p>Click "New Deck" to create your first deck!</p>
      </div>
    `;
    return;
  }

  const shown = visibleDecks();

  if (shown.length === 0) {
    decksList.innerHTML = `
      <div class="empty-state">
        <i class="ph ph-funnel empty-state-icon" aria-hidden="true"></i>
        <h3>No ${STATUS_LABELS[statusFilter] || ''} decks</h3>
        <p>Nothing here yet — try another status.</p>
      </div>
    `;
    return;
  }

  decksList.innerHTML = shown.map(deck => {
    // Use art_crop version of the image for better background display
    const backgroundImage = deck.preview_image
      ? deck.preview_image.replace('/normal/', '/art_crop/')
      : null;

    const backgroundStyle = backgroundImage
      ? `background: linear-gradient(to bottom, rgb(var(--scrim-rgb) / 0.7), rgb(var(--scrim-rgb) / 0.9)), url('${backgroundImage}') center/cover no-repeat;`
      : '';

    return `
      <div class="deck-card" data-deck-id="${deck.id}" data-status="${deck.status || 'building'}" style="${backgroundStyle}">
        <div class="deck-card-header">
          <div>
            <h3>${deck.name}</h3>
            ${deck.format ? `<span class="deck-format">${deck.format}</span>` : ''}
            ${deck.traded_away_count ? `<span class="deck-format" style="background:var(--drift-traded-amber);color:var(--on-accent);" title="Traded away, still listed in this deck">${deck.traded_away_count} traded away</span>` : ''}
          </div>
          <select class="deck-status-select" data-deck-id="${deck.id}" aria-label="Status for ${deck.name.replace(/"/g, '&quot;')}">
            ${DECK_STATUSES.map(
              (s) => `<option value="${s.value}" ${(deck.status || 'building') === s.value ? 'selected' : ''}>${s.label}</option>`
            ).join('')}
          </select>
        </div>
        <div class="deck-card-stats">
          <span>Main: ${deck.mainboard_count || 0} cards</span>
          <span>Side: ${deck.sideboard_count || 0} cards</span>
          ${recordBadge(deck.record)}
          ${readinessBadge(deck.readiness)}
        </div>
        <div class="deck-card-actions">
          <button class="btn btn-primary btn-edit" data-deck-id="${deck.id}">Edit</button>
          <button class="btn btn-secondary btn-clone" data-deck-id="${deck.id}" data-deck-name="${deck.name.replace(/"/g, '&quot;')}">Clone</button>
          <button class="btn btn-danger btn-delete" data-deck-id="${deck.id}">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  // Add event listeners
  decksList.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const deckId = btn.dataset.deckId;
      openDeckBuilder(deckId);
    });
  });

  decksList.querySelectorAll('.btn-clone').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showCloneModal(btn.dataset.deckId, btn.dataset.deckName);
    });
  });

  decksList.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deckId = btn.dataset.deckId;

      const ok = await confirmDialog({
        title: 'Delete deck?',
        message: 'This permanently deletes the deck and its contents.',
        confirmText: 'Delete',
        danger: true,
      });
      if (ok) {
        try {
          showLoading();
          await api.deleteDeck(deckId);
          await loadDecks();
          hideLoading();
          showToast('Deck deleted', 'success');
        } catch (error) {
          hideLoading();
          showToast('Failed to delete deck: ' + error.message, 'error');
        }
      }
    });
  });

  decksList.querySelectorAll('.deck-status-select').forEach(select => {
    // The whole card opens the deck builder, so every interaction with the
    // control has to stop there — otherwise picking a status navigates away
    // before the change lands.
    select.addEventListener('click', (e) => e.stopPropagation());

    select.addEventListener('change', async (e) => {
      e.stopPropagation();
      const deckId = parseInt(select.dataset.deckId, 10);
      const status = select.value;
      const deck = decks.find((d) => d.id === deckId);
      const previous = deck?.status || 'building';

      // Updated locally first so the chip counts and any active filter move
      // with the change instead of lagging a request behind.
      if (deck) deck.status = status;
      renderDecks();

      try {
        await api.updateDeck(deckId, { status });
      } catch (error) {
        if (deck) deck.status = previous;
        renderDecks();
        showToast('Failed to update status: ' + error.message, 'error');
      }
    });
  });

  decksList.querySelectorAll('.deck-card').forEach(card => {
    card.addEventListener('click', () => {
      const deckId = card.dataset.deckId;
      openDeckBuilder(deckId);
    });
  });
}

/**
 * Whether the deck can actually be sleeved up, derived from the collection on
 * every read and never stored.
 *
 * Two shortfalls are not the same errand, so they do not get the same badge:
 * cards you do not own need a shop, cards owned but committed to another deck
 * need a teardown. The title spells out both, since the badge only has room
 * for the blocking one.
 */
function readinessBadge(readiness) {
  if (!readiness || readiness.state === 'empty') return '';

  const detail = [];
  if (readiness.missingCopies) {
    detail.push(`${readiness.missingCopies} copies not in your collection`);
  }
  if (readiness.contestedCopies) {
    detail.push(`${readiness.contestedCopies} copies committed to other decks`);
  }

  const title = detail.length ? detail.join('; ') : 'Every card owned and free';

  // A dot, not the label. The words belong on the deck page, where there is
  // room for them and something to do about them; here they wrapped across
  // three lines and pushed the buttons around. The label is still in the
  // tooltip, and it is still what screen readers get.
  return `<span class="deck-readiness is-dot" data-state="${readiness.state}"
                title="${readiness.label} — ${title}">${readiness.label}</span>`;
}

/**
 * The deck's win-loss record, shown only once there is one. A deck nobody has
 * played yet reading "0-0" invites the question of whether the feature is
 * broken; showing nothing says the same thing without the doubt.
 */
function recordBadge(record) {
  if (!record || !record.played) return '';

  const draws = record.draws ? `-${record.draws}` : '';

  return `<span title="${record.wins} won, ${record.losses} lost` +
    `${record.draws ? `, ${record.draws} drawn` : ''}">` +
    `${record.wins}-${record.losses}${draws}` +
    `${record.winRate === null ? '' : ` (${record.winRate}%)`}</span>`;
}

/**
 * Cloning is how a half-built deck becomes a template: copy the shell, then
 * flesh out the copy. The name is asked for up front because two decks called
 * the same thing are hard to tell apart in the list.
 */
function showCloneModal(deckId, deckName) {
  const modal = document.getElementById('modal');
  const modalBody = document.getElementById('modal-body');

  modalBody.innerHTML = `
    <h2>Clone Deck</h2>
    <p style="margin-top: 0.5rem; color: var(--text-secondary);">
      Copies every card in <strong>${deckName}</strong>, mainboard and sideboard, into a new deck.
    </p>
    <form id="clone-deck-form" style="margin-top: 1.5rem;">
      <div class="form-group">
        <label for="clone-deck-name">New Deck Name</label>
        <input type="text" id="clone-deck-name" value="${deckName} (copy)" required autofocus>
      </div>
      <div style="display: flex; gap: 0.5rem; margin-top: 1.5rem;">
        <button type="submit" class="btn btn-primary" style="flex: 1;">Clone Deck</button>
        <button type="button" class="btn btn-secondary" id="cancel-clone-deck">Cancel</button>
      </div>
    </form>
  `;

  modal.classList.remove('hidden');

  document.getElementById('clone-deck-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('clone-deck-name').value;

    try {
      showLoading();
      modal.classList.add('hidden');
      const result = await api.cloneDeck(deckId, name);
      await loadDecks();
      hideLoading();
      showToast('Deck cloned', 'success');

      if (result.deck && result.deck.id) {
        openDeckBuilder(result.deck.id);
      }
    } catch (error) {
      hideLoading();
      showToast('Failed to clone deck: ' + error.message, 'error');
    }
  });

  document.getElementById('cancel-clone-deck').addEventListener('click', () => {
    modal.classList.add('hidden');
  });
}

function openDeckBuilder(deckId) {
  // Dispatch event to open deck builder
  window.dispatchEvent(new CustomEvent('open-deck', { detail: { deckId } }));
}

function showImportModal() {
  const modal = document.getElementById('import-deck-modal');
  modal.classList.remove('hidden');

  // Clear form
  document.getElementById('import-deck-name').value = '';
  document.getElementById('import-deck-format').value = '';
  document.getElementById('import-deck-list').value = '';
  const unresolvedBox = document.getElementById('import-deck-unresolved');
  unresolvedBox.classList.add('hidden');
  unresolvedBox.innerHTML = '';

  // Handle close
  document.getElementById('import-modal-close').onclick = () => {
    modal.classList.add('hidden');
  };

  document.getElementById('cancel-import').onclick = () => {
    modal.classList.add('hidden');
  };

  // Handle form submission
  const form = document.getElementById('import-deck-form');
  form.onsubmit = async (e) => {
    e.preventDefault();

    const name = document.getElementById('import-deck-name').value;
    const format = document.getElementById('import-deck-format').value;
    const deckList = document.getElementById('import-deck-list').value;

    try {
      showLoading();
      modal.classList.add('hidden');

      const result = await api.importDeck(name, format, deckList);

      hideLoading();

      const unresolved = result.unresolved || [];

      await loadDecks();

      // Lines nobody could match are shown against the list they came from,
      // so they can be corrected and re-pasted. Telling someone the import
      // succeeded and handing them an empty deck is what made this look
      // broken.
      if (unresolved.length > 0) {
        showToast(
          `Imported ${result.imported} cards, ${unresolved.length} line${unresolved.length === 1 ? '' : 's'} not found`,
          'warning',
          5000
        );

        unresolvedBox.innerHTML = `
          <strong>Lines that could not be matched:</strong>
          <ul style="margin: 0.5rem 0 0 1.25rem; font-family: monospace; font-size: 0.875rem;">
            ${unresolved.map(item => `<li>${escapeHtml(item.line || item.name || '')}</li>`).join('')}
          </ul>
        `;
        unresolvedBox.classList.remove('hidden');
        modal.classList.remove('hidden');
        return;
      }

      showToast(`Successfully imported ${result.imported} cards!`, 'success', 3000);

      if (result.deck && result.deck.id) {
        setTimeout(() => {
          openDeckBuilder(result.deck.id);
        }, 500);
      }
    } catch (error) {
      hideLoading();
      modal.classList.remove('hidden');
      showToast('Failed to import deck: ' + error.message, 'error');
    }
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
