import api from '../services/api.js';
import { showToast, confirmDialog, celebrate } from '../utils/ui.js';

/**
 * A deck's match record.
 *
 * Games are logged individually rather than as a running tally, so a result
 * entered in the wrong column can be corrected instead of being permanently
 * baked into a counter. The summary at the top is derived from the list below
 * it — there is no second copy of the numbers to fall out of step.
 */

const el = (id) => document.getElementById(id);

let ctx = null;
let games = [];
let record = emptyRecord();
let editingId = null;

function emptyRecord() {
  return { wins: 0, losses: 0, draws: 0, played: 0, winRate: null };
}

export function setupDeckRecord(context) {
  ctx = context;

  const openBtn = el('deck-record-btn');
  if (openBtn) openBtn.addEventListener('click', open);

  const closeBtn = el('deck-record-close');
  if (closeBtn) closeBtn.addEventListener('click', close);

  const form = el('deck-game-form');
  if (form) form.addEventListener('submit', submit);

  const cancelEdit = el('deck-game-cancel-edit');
  if (cancelEdit) cancelEdit.addEventListener('click', () => stopEditing());

  const list = el('deck-game-list');
  if (list) {
    list.addEventListener('click', (event) => {
      const editBtn = event.target.closest('[data-edit-game]');
      if (editBtn) return startEditing(parseInt(editBtn.dataset.editGame, 10));

      const deleteBtn = event.target.closest('[data-delete-game]');
      if (deleteBtn) return remove(parseInt(deleteBtn.dataset.deleteGame, 10));
    });
  }
}

/**
 * Show the record on the deck builder's own button, so the number is visible
 * without opening anything. Called by the host whenever the deck reloads.
 */
export function renderDeckRecordLabel(deckRecord) {
  record = deckRecord || emptyRecord();

  const label = el('deck-record-label');
  if (!label) return;

  label.textContent = record.played === 0
    ? 'Record'
    : `${record.wins}-${record.losses}${record.draws ? `-${record.draws}` : ''}`;
}

async function open() {
  const deckId = ctx?.getDeckId?.();
  if (!deckId) return;

  el('deck-record-modal')?.classList.remove('hidden');

  stopEditing();
  resetForm();

  await load();
}

function close() {
  el('deck-record-modal')?.classList.add('hidden');
  stopEditing();
}

async function load() {
  const deckId = ctx?.getDeckId?.();
  if (!deckId) return;

  const list = el('deck-game-list');
  if (list) list.innerHTML = '<div class="record-empty">Loading…</div>';

  try {
    const result = await api.getDeckGames(deckId);
    games = result.games || [];
    record = result.record || emptyRecord();

    renderSummary();
    renderList();
    renderDeckRecordLabel(record);
  } catch (error) {
    if (list) {
      list.innerHTML = `<div class="record-empty">Could not load the record: ${escapeHtml(error.message)}</div>`;
    }
  }
}

function renderSummary() {
  const summary = el('deck-record-summary');
  if (!summary) return;

  if (record.played === 0) {
    summary.innerHTML = '<p class="record-empty">No games logged yet.</p>';
    return;
  }

  summary.innerHTML = `
    <div class="record-figures">
      <div class="record-figure is-win">
        <span class="record-figure-value">${record.wins}</span>
        <span class="record-figure-label">Wins</span>
      </div>
      <div class="record-figure is-loss">
        <span class="record-figure-value">${record.losses}</span>
        <span class="record-figure-label">Losses</span>
      </div>
      <div class="record-figure is-draw">
        <span class="record-figure-value">${record.draws}</span>
        <span class="record-figure-label">Draws</span>
      </div>
      <div class="record-figure">
        <span class="record-figure-value">${record.winRate === null ? '—' : `${record.winRate}%`}</span>
        <span class="record-figure-label">Win rate</span>
      </div>
    </div>
  `;
}

function renderList() {
  const list = el('deck-game-list');
  if (!list) return;

  if (games.length === 0) {
    list.innerHTML = '<div class="record-empty">Nothing logged yet — add the first game above.</div>';
    return;
  }

  list.innerHTML = games.map((game) => {
    const against = [game.opponent, game.opponent_deck]
      .filter(Boolean)
      .join(' · ');

    return `
      <div class="record-row ${editingId === game.id ? 'is-editing' : ''}">
        <span class="record-result is-${escapeHtml(game.result)}">${escapeHtml(resultLabel(game.result))}</span>
        <div class="record-row-body">
          <div class="record-row-main">
            ${against ? escapeHtml(against) : '<span class="record-muted">No opponent recorded</span>'}
          </div>
          <div class="record-row-meta">
            ${escapeHtml(game.played_at)}${game.format ? ` · ${escapeHtml(game.format)}` : ''}
            ${game.notes ? ` · ${escapeHtml(game.notes)}` : ''}
          </div>
        </div>
        <div class="record-row-actions">
          <button class="btn btn-secondary btn-sm" data-edit-game="${game.id}">Edit</button>
          <button class="btn btn-danger btn-sm" data-delete-game="${game.id}">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function readForm() {
  return {
    result: el('deck-game-result')?.value,
    playedAt: el('deck-game-date')?.value,
    opponent: el('deck-game-opponent')?.value,
    opponentDeck: el('deck-game-opponent-deck')?.value,
    notes: el('deck-game-notes')?.value,
  };
}

function resetForm() {
  const date = el('deck-game-date');
  // Defaults to today, since a game is nearly always logged the day it was
  // played and an empty required date field is just an extra click.
  if (date) date.value = new Date().toISOString().slice(0, 10);

  const result = el('deck-game-result');
  if (result) result.value = 'win';

  for (const id of ['deck-game-opponent', 'deck-game-opponent-deck', 'deck-game-notes']) {
    const field = el(id);
    if (field) field.value = '';
  }
}

async function submit(event) {
  event.preventDefault();

  const deckId = ctx?.getDeckId?.();
  if (!deckId) return;

  const payload = readForm();

  try {
    const wasNewWin = !editingId && payload.result === 'win';

    if (editingId) {
      await api.updateDeckGame(deckId, editingId, payload);
      showToast('Game updated', 'success');
    } else {
      await api.addDeckGame(deckId, payload);
      showToast('Game logged', 'success');
    }

    stopEditing();
    resetForm();
    await load();

    // After load(), so the record shown is the one including this game.
    // Only a newly logged win — editing an old game into a win is bookkeeping,
    // not a moment.
    if (wasNewWin) {
      celebrate('win', {
        title: 'Win recorded',
        detail: record ? `Now ${record.wins}–${record.losses}` : '',
      });
    }
    ctx?.onChange?.();
  } catch (error) {
    showToast('Failed to save game: ' + error.message, 'error');
  }
}

function startEditing(gameId) {
  const game = games.find((entry) => entry.id === gameId);
  if (!game) return;

  editingId = gameId;

  el('deck-game-result').value = game.result;
  el('deck-game-date').value = game.played_at;
  el('deck-game-opponent').value = game.opponent || '';
  el('deck-game-opponent-deck').value = game.opponent_deck || '';
  el('deck-game-notes').value = game.notes || '';

  const submitBtn = el('deck-game-submit');
  if (submitBtn) submitBtn.textContent = 'Save changes';

  el('deck-game-cancel-edit')?.classList.remove('hidden');

  renderList();
}

function stopEditing() {
  editingId = null;

  const submitBtn = el('deck-game-submit');
  if (submitBtn) submitBtn.textContent = 'Log game';

  el('deck-game-cancel-edit')?.classList.add('hidden');
}

async function remove(gameId) {
  const deckId = ctx?.getDeckId?.();
  if (!deckId) return;

  const ok = await confirmDialog({
    title: 'Delete this game?',
    message: 'It will no longer count towards the deck’s record.',
    confirmText: 'Delete',
    danger: true,
  });

  if (!ok) return;

  try {
    await api.deleteDeckGame(deckId, gameId);

    // Editing the row that has just been deleted would post an update for a
    // game that no longer exists, so drop out of edit mode first.
    if (editingId === gameId) {
      stopEditing();
      resetForm();
    }

    await load();
    ctx?.onChange?.();
    showToast('Game deleted', 'success');
  } catch (error) {
    showToast('Failed to delete game: ' + error.message, 'error');
  }
}

function resultLabel(result) {
  return { win: 'Win', loss: 'Loss', draw: 'Draw' }[result] || result;
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
