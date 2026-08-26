/**
 * The scan session: everything between framing a card and writing anything.
 *
 * The shape of this is the whole point of the feature. You scan for a few
 * minutes, glance over what came out, and *then* choose where it goes. Nothing
 * commits as you scan — not the confident rows, not any of it — because the
 * value of scanning a stack is that you never have to stop, and the value of
 * reviewing is that you see the whole thing at once, where a wrong card stands
 * out against its neighbours in a way it never does one at a time.
 *
 * Confidence therefore does not decide whether a card is committed. It decides
 * how much of your attention it asks for: rows the art and the text
 * independently agreed on collapse behind a count, and everything else is
 * expanded and waiting. Every row can still be opened, corrected or deleted,
 * and the collapsed ones are one click from being shown.
 *
 * ── The two destinations ─────────────────────────────────────────────────────
 * **Collection** is "I now own these". **Deck** is "this pile of cards I
 * already own is a deck", and it must not touch inventory — the commonest use
 * is scanning a deck you sleeved out of your own binder, and adding those to
 * the collection would double every one of them. The server enforces the split;
 * this module just never pretends they are the same button.
 *
 * Session state is deliberately in memory and nowhere else. It is not written
 * to localStorage: a half-reviewed session restored days later, resolved
 * against a card database that has since been rebuilt, is a worse outcome than
 * losing it. The captures themselves are object URLs and could not be restored
 * anyway.
 */
import api from '../services/api.js';

/** Tiers, mirrored from scanService.js. Only `confident` collapses a row. */
const TIER = {
  CONFIDENT: 'confident',
  PICK_PRINTING: 'pick-printing',
  CONFLICT: 'conflict',
  UNSURE: 'unsure',
};

/** What each tier is telling the reviewer to do. Shown on the row. */
const TIER_LABEL = {
  // No longer only "art and text agree": an art match with exactly one printing
  // behind it is confident on its own, and with the reader off that is the
  // common case rather than the exception.
  [TIER.CONFIDENT]: 'Matched',
  [TIER.PICK_PRINTING]: 'Card known — pick the printing',
  [TIER.CONFLICT]: 'Art and text disagree',
  [TIER.UNSURE]: 'Needs checking',
};

const state = {
  /** Rows, newest first, matching the capture strip. */
  rows: [],
  /** 'scanning' | 'review'. */
  phase: 'scanning',
  /** Show confident rows expanded during review. */
  showConfident: false,
  /** Every card in this session is foil — for scanning a foil binder. */
  sessionFoil: false,
  /**
   * Collapse `pick-printing` rows too, taking the closest printing.
   *
   * The art hash names the card outright but cannot separate reprints that
   * share an illustration, so a bulk box resolves to a wall of "pick the
   * printing" — accurate, and far too slow to work through if what you are
   * doing is counting what you own rather than cataloguing which printing.
   * Off by default: the frame hash orders those candidates but was never
   * strong enough to be believed on its own, so this is a deliberate trade of
   * printing accuracy for speed and has to be asked for.
   */
  autoPickPrinting: false,
  /** Cached deck list for the destination picker. */
  decks: null,
  committing: false,
};

const el = (id) => document.getElementById(id);

/** A row's chosen candidate, or null while it is still unresolved. */
function chosen(row) {
  if (!row.candidates?.length) return null;
  return row.candidates.find((candidate) => candidate.printingId === row.printingId)
    || row.candidates[0];
}

/** Rows that are ready to commit — a printing picked and not deleted. */
function committable() {
  return state.rows.filter((row) => !row.deleted && chosen(row));
}

/** Tiers that collapse out of the review table rather than being looked at. */
function collapses(row) {
  if (row.tier === TIER.CONFIDENT) return true;
  // Only when asked for, and only where a printing was actually offered — an
  // empty candidate list is not something to wave through. See autoPickPrinting.
  return state.autoPickPrinting && row.tier === TIER.PICK_PRINTING && !!chosen(row);
}

/** Rows the reviewer genuinely has to look at. */
function needsReview() {
  return state.rows.filter((row) => !row.deleted && !collapses(row));
}

function confidentRows() {
  return state.rows.filter((row) => !row.deleted && collapses(row));
}

/** Thumbnail width in the review table. Matches .scan-row-thumb in the CSS. */
const THUMB_WIDTH = 112;

/**
 * Shrink a rectified capture to a thumbnail data URL, and let the original go.
 *
 * This is not a rendering nicety, it is the reason a long session does not run
 * the phone out of memory. A rectified card is around 400x560 RGBA — close to
 * a megabyte each — and a session is a stack of cards, so holding the
 * ImageData for every row costs tens of megabytes and climbs for as long as
 * the scanning goes on. The review table only ever shows it a hundred pixels
 * wide; everything past that is being carried for nothing.
 *
 * Twice the display width, so it stays sharp on a phone's 2x screen.
 */
function thumbnailOf(imageData) {
  if (!imageData?.width) return null;

  try {
    const full = document.createElement('canvas');
    full.width = imageData.width;
    full.height = imageData.height;
    full.getContext('2d').putImageData(imageData, 0, 0);

    const scale = (THUMB_WIDTH * 2) / imageData.width;
    const thumb = document.createElement('canvas');
    thumb.width = Math.round(imageData.width * scale);
    thumb.height = Math.round(imageData.height * scale);

    const context = thumb.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(full, 0, 0, thumb.width, thumb.height);

    // JPEG rather than PNG: this is a photograph, and the review table may hold
    // a hundred of them at once.
    return thumb.toDataURL('image/jpeg', 0.72);
  } catch {
    // A thumbnail is a convenience; a row without one still reviews fine.
    return null;
  }
}

/**
 * Take a capture into the session.
 *
 * Added immediately, unresolved. The read and the resolve happen behind the
 * capture loop and land later — a session must never make the person holding
 * the cards wait for OCR, which is seconds per card.
 */
function addCapture(entry) {
  const row = {
    id: entry.id,
    at: entry.at,
    // The thumbnail, deliberately not the capture. See thumbnailOf.
    thumbUrl: thumbnailOf(entry.card),
    artHash: entry.artHash || null,
    frameHash: entry.frameHash || null,
    reading: null,
    tier: null,
    candidates: [],
    printingId: null,
    quantity: 1,
    isFoil: state.sessionFoil,
    boardType: 'mainboard',
    isCommander: false,
    deleted: false,
    resolving: true,
    // Set once the reviewer chooses a printing themselves. See applyResolution.
    picked: false,
  };

  state.rows.unshift(row);
  render();
  return row;
}

/**
 * Attach a resolver result to its row.
 *
 * Called by scan.js once a capture has been read and resolved, so the session
 * does not duplicate the read queue — there is one reader and it is already
 * serialised.
 */
function applyResolution(id, { reading, tier, candidates }) {
  const row = state.rows.find((candidate) => candidate.id === id);
  if (!row) return;

  row.reading = reading || null;
  row.tier = tier || TIER.UNSURE;
  row.candidates = candidates || [];
  row.resolving = false;

  // Called more than once per row now: the art hash answers immediately, and an
  // optional OCR read can refine the same row later. A hand-picked printing
  // survives that second landing; anything else takes the new best.
  if (!row.picked) {
    row.printingId = candidates?.[0]?.printingId ?? null;
  }

  render();
}

/** Mark a capture that could not be read at all, so it still shows up. */
function applyFailure(id, message) {
  const row = state.rows.find((candidate) => candidate.id === id);
  if (!row) return;

  row.resolving = false;
  row.tier = TIER.UNSURE;
  row.error = message;
  render();
}

function reset() {
  state.rows = [];
  state.phase = 'scanning';
  state.showConfident = false;
  render();
}

// ── rendering ───────────────────────────────────────────────────────────────

function renderSummary() {
  const summary = el('scan-session-summary');
  if (!summary) return;

  const live = state.rows.filter((row) => !row.deleted);
  const pending = live.filter((row) => row.resolving).length;
  const attention = needsReview().length;

  const parts = [`${live.length} card${live.length === 1 ? '' : 's'}`];
  if (pending) parts.push(`${pending} still reading`);
  if (attention) parts.push(`${attention} need${attention === 1 ? 's' : ''} a look`);
  else if (live.length) parts.push('all agreed');

  summary.textContent = parts.join(' · ');

  // The same figure, compressed for the action bar, where it sits beside Review
  // and is the only running total on screen while scanning.
  const count = el('scan-count');
  if (count) {
    count.textContent = live.length
      ? `${live.length} card${live.length === 1 ? '' : 's'}${attention ? ` · ${attention} to check` : ''}`
      : 'No cards yet';
  }
}

function candidateOption(candidate, selectedId) {
  const option = document.createElement('option');
  option.value = String(candidate.printingId);
  option.selected = candidate.printingId === selectedId;
  option.textContent =
    `${candidate.name} — ${candidate.setCode} ${candidate.collectorNumber}` +
    (candidate.isPromo ? ' (promo)' : '');
  return option;
}

function renderRow(row) {
  const node = document.createElement('div');
  node.className = `scan-row scan-row-${row.tier || 'pending'}`;
  node.dataset.rowId = String(row.id);

  const pick = chosen(row);

  const thumb = document.createElement('div');
  thumb.className = 'scan-row-thumb';
  if (row.thumbUrl) {
    const img = document.createElement('img');
    img.src = row.thumbUrl;
    img.alt = 'Captured card';
    thumb.appendChild(img);
  }

  const match = document.createElement('div');
  match.className = 'scan-row-match';

  if (row.resolving) {
    match.textContent = 'Reading…';
  } else if (!pick) {
    match.textContent = row.error ? `Could not read: ${row.error}` : 'No match found';
    match.classList.add('scan-row-empty');
  } else {
    // The matched card's own art, beside the capture. Two pictures side by side
    // is the fastest check there is — far quicker than reading a set code back.
    if (pick.imageUrl) {
      const img = document.createElement('img');
      img.src = pick.imageUrl;
      img.alt = pick.name;
      img.className = 'scan-row-art';
      match.appendChild(img);
    }

    const details = document.createElement('div');
    details.className = 'scan-row-details';

    const picker = document.createElement('select');
    picker.className = 'scan-row-printing';
    picker.setAttribute('aria-label', 'Printing');
    for (const candidate of row.candidates) {
      picker.appendChild(candidateOption(candidate, pick.printingId));
    }
    picker.addEventListener('change', (event) => {
      row.printingId = Number(event.target.value);
      // Sticky: the art resolves in milliseconds but an OCR refinement can land
      // seconds later, and it must not silently undo a printing the reviewer
      // has already chosen by hand.
      row.picked = true;
      render();
    });

    const tierChip = document.createElement('span');
    tierChip.className = `scan-row-tier scan-row-tier-${row.tier}`;
    tierChip.textContent = TIER_LABEL[row.tier] || 'Needs checking';

    details.append(picker, tierChip);
    match.appendChild(details);
  }

  const controls = document.createElement('div');
  controls.className = 'scan-row-controls';

  const quantity = document.createElement('input');
  quantity.type = 'number';
  quantity.min = '1';
  quantity.max = '999';
  quantity.value = String(row.quantity);
  quantity.className = 'scan-row-qty';
  quantity.setAttribute('aria-label', 'Quantity');
  quantity.addEventListener('change', (event) => {
    row.quantity = Math.max(1, Math.min(999, Number(event.target.value) || 1));
    event.target.value = String(row.quantity);
  });

  const foilLabel = document.createElement('label');
  foilLabel.className = 'scan-row-foil';
  const foil = document.createElement('input');
  foil.type = 'checkbox';
  foil.checked = row.isFoil;
  foil.addEventListener('change', (event) => { row.isFoil = event.target.checked; });
  foilLabel.append(foil, document.createTextNode(' Foil'));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn-icon scan-row-remove';
  remove.title = 'Remove from session';
  remove.textContent = '✕';
  remove.addEventListener('click', () => {
    row.deleted = true;
    render();
  });

  controls.append(quantity, foilLabel, remove);

  // Which board a card goes on only exists as a question when the destination
  // is a deck, so it is not rendered until one is chosen.
  if (state.destination === 'deck') {
    const board = document.createElement('select');
    board.className = 'scan-row-board';
    board.setAttribute('aria-label', 'Board');
    for (const [value, label] of [
      ['mainboard', 'Main'],
      ['sideboard', 'Side'],
      ['maybeboard', 'Maybe'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = row.boardType === value;
      board.appendChild(option);
    }
    board.addEventListener('change', (event) => { row.boardType = event.target.value; });

    const commanderLabel = document.createElement('label');
    commanderLabel.className = 'scan-row-commander';
    const commander = document.createElement('input');
    commander.type = 'checkbox';
    commander.checked = row.isCommander;
    commander.addEventListener('change', (event) => {
      row.isCommander = event.target.checked;
    });
    commanderLabel.append(commander, document.createTextNode(' Cmdr'));

    controls.insertBefore(board, remove);
    controls.insertBefore(commanderLabel, remove);
  }

  node.append(thumb, match, controls);
  return node;
}

function renderReview() {
  const list = el('scan-review-list');
  if (!list) return;

  list.textContent = '';

  const attention = needsReview();
  const agreed = confidentRows();

  for (const row of attention) list.appendChild(renderRow(row));

  if (agreed.length) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'scan-confident-toggle';
    toggle.textContent = state.showConfident
      ? `Hide the ${agreed.length} the art and text agreed on`
      : `${agreed.length} more where the art and text agreed — review these too`;
    toggle.addEventListener('click', () => {
      state.showConfident = !state.showConfident;
      render();
    });
    list.appendChild(toggle);

    if (state.showConfident) {
      for (const row of agreed) list.appendChild(renderRow(row));
    }
  }

  if (!attention.length && !agreed.length) {
    const empty = document.createElement('p');
    empty.className = 'scan-review-empty';
    empty.textContent = 'Nothing in this session yet.';
    list.appendChild(empty);
  }
}

function render() {
  renderSummary();

  const panel = el('scan-session-panel');
  if (panel) panel.classList.toggle('hidden', state.rows.length === 0);

  const reviewing = state.phase === 'review';
  el('scan-review')?.classList.toggle('hidden', !reviewing);
  // Hidden with nothing to review as well as during review: the button now lives
  // in the scan action bar rather than at the head of this panel, so it is on
  // screen from the moment the page opens and must not offer an empty list.
  el('scan-review-start')?.classList.toggle('hidden', reviewing || state.rows.length === 0);

  // Which of the two the page is doing. The phone layout hangs off these: while
  // scanning the camera fills the viewport and the controls stick to its foot,
  // while reviewing the whole capture side is gone and the list has the screen.
  const page = el('scan-page');
  if (page) {
    page.classList.toggle('scan-page-scanning', !reviewing);
    page.classList.toggle('scan-page-reviewing', reviewing);
  }

  if (reviewing) renderReview();

  const commit = el('scan-commit');
  if (commit) {
    const ready = committable().length;
    commit.disabled = state.committing || ready === 0 || !state.destination
      || (state.destination === 'deck' && !state.deckId);
    // The label names the destination only once one has been chosen. Defaulting
    // to the collection wording reads as though the collection is where this is
    // going — which for a deck scan is the one misunderstanding that actually
    // costs something.
    commit.textContent = state.committing
      ? 'Committing…'
      : !state.destination
        ? 'Choose a destination'
        : state.destination === 'deck'
          ? `Add ${ready} card${ready === 1 ? '' : 's'} to the deck`
          : `Add ${ready} card${ready === 1 ? '' : 's'} to my collection`;
  }

  el('scan-deck-picker')?.classList.toggle('hidden', state.destination !== 'deck');
  el('scan-shortfall')?.classList.toggle('hidden', state.destination !== 'deck');
}

// ── committing ──────────────────────────────────────────────────────────────

/** The reviewed rows, in the shape the commit endpoint takes. */
function commitItems() {
  return committable().map((row) => {
    const pick = chosen(row);
    return {
      printingId: pick.printingId,
      quantity: row.quantity,
      isFoil: row.isFoil,
      boardType: row.boardType,
      isCommander: row.isCommander,
    };
  });
}

function setStatus(message, isError = false) {
  const status = el('scan-session-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('scan-status-error', isError);
}

/**
 * Ask what the collection does not cover, before a deck commit.
 *
 * Shown rather than acted on. A card in a deck that the collection does not
 * know about usually means the collection is stale, but it can equally mean the
 * card is borrowed — and only the person holding it knows which.
 */
async function refreshShortfall() {
  const target = el('scan-shortfall');
  if (!target || state.destination !== 'deck') return;

  const items = commitItems();
  if (!items.length) {
    target.textContent = '';
    return;
  }

  try {
    const { shortfalls } = await api.scanShortfall(items);

    if (!shortfalls.length) {
      target.textContent = 'Your collection already covers every card in this deck.';
      target.classList.remove('scan-shortfall-warn');
      return;
    }

    const total = shortfalls.reduce((sum, row) => sum + row.short, 0);
    target.classList.add('scan-shortfall-warn');
    target.textContent =
      `${total} copy/copies across ${shortfalls.length} printing(s) are not in your ` +
      `collection. Leave this unticked if they are borrowed — your decks will ` +
      `correctly report them as short.`;

    const label = document.createElement('label');
    label.className = 'scan-shortfall-optin';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'scan-also-collection';
    label.append(box, document.createTextNode(' Also add these to my collection'));
    target.appendChild(label);
  } catch (error) {
    target.textContent = `Could not check your collection: ${error.message}`;
  }
}

async function commit() {
  const items = commitItems();
  if (!items.length) return;

  state.committing = true;
  render();
  setStatus('Committing…');

  try {
    let result;

    if (state.destination === 'deck') {
      const alsoAdd = el('scan-also-collection')?.checked || false;
      result = await api.commitScanToDeck(state.deckId, items, alsoAdd);
      setStatus(
        `Added ${result.committed} card(s) to the deck` +
        (result.addedToCollection
          ? `, and ${result.addedToCollection.committed} to your collection.`
          : ', leaving your collection untouched.')
      );
    } else {
      result = await api.commitScanToCollection(items);
      setStatus(`Added ${result.committed} card(s) to your collection.`);
    }

    // The session is spent. Clearing it is what stops the commonest double-add:
    // pressing the button twice, or scanning on top of a committed batch.
    reset();
    window.dispatchEvent(new CustomEvent('scan:committed', { detail: result }));
  } catch (error) {
    setStatus(`Nothing was committed: ${error.message}`, true);
  } finally {
    state.committing = false;
    render();
  }
}

async function loadDecks() {
  if (state.decks) return state.decks;
  try {
    const response = await api.getDecks();
    state.decks = response.decks || response || [];
  } catch {
    state.decks = [];
  }
  return state.decks;
}

async function chooseDestination(destination) {
  state.destination = destination;

  // Painted before the awaits below, not after. Loading the deck list and
  // asking the server about the shortfall are both network calls, and pressing
  // a destination button has to change the screen at the moment it is pressed —
  // otherwise the button looks dead on a slow connection, and stays dead if
  // either call fails.
  render();

  if (destination === 'deck') {
    const picker = el('scan-deck-select');
    if (picker && !picker.dataset.filled) {
      const decks = await loadDecks();
      for (const deck of decks) {
        const option = document.createElement('option');
        option.value = String(deck.id);
        option.textContent = deck.name;
        picker.appendChild(option);
      }
      picker.dataset.filled = '1';
      state.deckId = decks[0] ? decks[0].id : null;
    }
    await refreshShortfall();
  }

  render();
}

// ── wiring ──────────────────────────────────────────────────────────────────

export function setupScanSession() {
  window.addEventListener('scan:capture', (event) => addCapture(event.detail));
  window.addEventListener('scan:resolved', (event) => {
    const { id, ...rest } = event.detail;
    applyResolution(id, rest);
  });
  window.addEventListener('scan:read-failed', (event) => {
    applyFailure(event.detail.id, event.detail.message);
  });

  el('scan-review-start')?.addEventListener('click', () => {
    state.phase = 'review';
    // Stop the camera, rather than leaving it firing into the list being worked
    // through. Auto-capture does not know a review is happening, so a session
    // reviewed in front of a live lens grows new rows while you read it — which
    // is both confusing and unbounded. Sent as an event because the session
    // deliberately knows nothing about the camera; scan.js owns that.
    window.dispatchEvent(new CustomEvent('scan:review-opened'));
    render();
  });

  el('scan-review-back')?.addEventListener('click', () => {
    state.phase = 'scanning';
    render();
  });

  el('scan-session-clear')?.addEventListener('click', () => {
    if (state.rows.length && !window.confirm('Discard this scan session?')) return;
    reset();
    setStatus('');
  });

  el('scan-session-autopick')?.addEventListener('change', (event) => {
    state.autoPickPrinting = event.target.checked;
    render();
  });

  el('scan-session-foil')?.addEventListener('change', (event) => {
    state.sessionFoil = event.target.checked;
    // Applies to what is already in the session as well as what follows: the
    // toggle is flipped after realising the whole binder is foil, not before.
    for (const row of state.rows) row.isFoil = state.sessionFoil;
    render();
  });

  for (const [id, destination] of [
    ['scan-dest-collection', 'collection'],
    ['scan-dest-deck', 'deck'],
  ]) {
    el(id)?.addEventListener('click', () => chooseDestination(destination));
  }

  el('scan-deck-select')?.addEventListener('change', async (event) => {
    state.deckId = Number(event.target.value);
    await refreshShortfall();
    render();
  });

  el('scan-commit')?.addEventListener('click', commit);

  render();
}

// Exported for tests: the tiering and commit-shape logic is worth checking
// without a browser.
export const _internals = { state, committable, needsReview, commitItems, TIER };
