import api from '../services/api.js';
import { showLoading, hideLoading, formatDate, showError, showToast, confirmDialog } from '../utils/ui.js';

let decks = [];

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

    try {
      showLoading();
      modal.classList.add('hidden');
      await api.createDeck(name, format, '');
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

function renderDecks() {
  const decksList = document.getElementById('decks-list');

  if (decks.length === 0) {
    decksList.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 3rem; color: var(--text-secondary);">
        <h3>No decks yet</h3>
        <p>Click "New Deck" to create your first deck!</p>
      </div>
    `;
    return;
  }

  decksList.innerHTML = decks.map(deck => {
    // Use art_crop version of the image for better background display
    const backgroundImage = deck.preview_image
      ? deck.preview_image.replace('/normal/', '/art_crop/')
      : null;

    const backgroundStyle = backgroundImage
      ? `background: linear-gradient(to bottom, rgba(0,0,0,0.7), rgba(0,0,0,0.9)), url('${backgroundImage}') center/cover no-repeat;`
      : '';

    return `
      <div class="deck-card" data-deck-id="${deck.id}" style="${backgroundStyle}">
        <div class="deck-card-header">
          <div>
            <h3>${deck.name}</h3>
            ${deck.format ? `<span class="deck-format">${deck.format}</span>` : ''}
            ${deck.traded_away_count ? `<span class="deck-format" style="background:#b45309;color:#fff;" title="Traded away, still listed in this deck">${deck.traded_away_count} traded away</span>` : ''}
          </div>
        </div>
        <div class="deck-card-stats">
          <span>Main: ${deck.mainboard_count || 0} cards</span>
          <span>Side: ${deck.sideboard_count || 0} cards</span>
          ${recordBadge(deck.record)}
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

  decksList.querySelectorAll('.deck-card').forEach(card => {
    card.addEventListener('click', () => {
      const deckId = card.dataset.deckId;
      openDeckBuilder(deckId);
    });
  });
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
