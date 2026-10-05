/**
 * Which other decks a generated or mimicked deck may take cards from.
 *
 * Shared by the deck generator and Mimic so the two remember one answer:
 * somebody who has said "the Goblins deck is sleeved, leave it alone" once
 * should not have to say it again on the other screen.
 *
 * Three pool choices: `free` (no other deck's cards), `picked` (cards in the
 * decks ticked here) and `all`. A deck nobody has ticked or unticked defaults
 * by status — a ready deck has had its cards pulled, so taking from it is real
 * work; a building or idea deck usually has not. Retired decks are not
 * offered: they claim nothing to begin with.
 */
const POOL_KEY = 'deckGenerator.pool';
const RAID_KEY = 'deckGenerator.raidDecks';
const POOLS = ['free', 'picked', 'all'];

export function savedPool(fallback = 'free') {
  try {
    const saved = localStorage.getItem(POOL_KEY);
    return POOLS.includes(saved) ? saved : fallback;
  } catch {
    return fallback;
  }
}

export function savePool(value) {
  try { localStorage.setItem(POOL_KEY, value); } catch { /* storage blocked */ }
}

function savedChoices() {
  try { return JSON.parse(localStorage.getItem(RAID_KEY) || '{}') || {}; } catch { return {}; }
}

export function saveRaidChoice(deckId, raidable) {
  const saved = savedChoices();
  saved[deckId] = Boolean(raidable);
  try { localStorage.setItem(RAID_KEY, JSON.stringify(saved)); } catch { /* storage blocked */ }
}

const offered = (decks, exceptId) =>
  decks.filter((d) => d.status !== 'retired' && d.id !== exceptId);

function isRaidable(deck, saved) {
  return deck.id in saved ? Boolean(saved[deck.id]) : deck.status !== 'ready';
}

/** Deck ids whose cards count as free under `picked`. */
export function raidDeckIds(decks, exceptId = null) {
  const saved = savedChoices();
  return offered(decks, exceptId).filter((d) => isRaidable(d, saved)).map((d) => d.id);
}

/** Checkbox rows for the decks, ready first. */
export function raidDecksHtml(decks, escapeHtml, exceptId = null) {
  const list = offered(decks, exceptId);
  if (list.length === 0) return '<p class="generator-note">You have no other decks to take from.</p>';
  const saved = savedChoices();
  const order = { ready: 0, building: 1, idea: 2 };
  return [...list]
    .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.name.localeCompare(b.name))
    .map((d) => `
      <label class="generator-raid-deck">
        <input autocomplete="off" type="checkbox" value="${d.id}" ${isRaidable(d, saved) ? 'checked' : ''} />
        <span class="generator-raid-name">${escapeHtml(d.name)}</span>
        <span class="generator-raid-status">${escapeHtml(d.status || 'building')}</span>
      </label>`).join('');
}
