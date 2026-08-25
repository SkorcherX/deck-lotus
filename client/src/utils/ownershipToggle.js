import api from '../services/api.js';
import { confirmDialog, showToast } from './ui.js';

/**
 * The ownership tick, and the question it has to ask before it destroys
 * anything.
 *
 * Pressing this button while a card is owned does not remove *a* copy — it
 * removes every printing and every finish of that card, whatever the
 * quantities were. Sixteen copies of Mountain across five rows is one press.
 * The button is 32px (16px in the deck builder's compact view), rendered fifty
 * times a page, and has no undo.
 *
 * The server is the thing that actually refuses: a request without
 * `confirmRemoveAll` comes back with `requiresConfirmation` and the counts,
 * having written nothing. This helper turns that into the prompt, and exists
 * once because Browse Cards and the deck builder both wire the same button and
 * had drifted into two copies of the same handler.
 *
 * Returns `{ owned, changed }`. `changed: false` means the user backed out and
 * the caller should leave its button exactly as it was — the state on screen
 * is still the truth.
 */
export async function toggleOwnership(cardId, cardName = 'this card') {
  const first = await api.toggleCardOwnership(cardId);

  if (!first.requiresConfirmation) {
    showToast(first.owned ? 'Added to collection' : 'Removed from collection', 'success', 1500);
    return { owned: first.owned, changed: true };
  }

  const copies = first.copyCount;
  const printings = first.printingCount;
  const foils = first.foilCount;

  // The numbers are the whole point of the prompt. "Are you sure?" over a
  // collection you cannot see the size of is not a question anyone can answer.
  const parts = [
    `${copies} cop${copies === 1 ? 'y' : 'ies'}`,
    `${printings} printing${printings === 1 ? '' : 's'}`,
  ];
  if (foils > 0) parts.push(`${foils} foil${foils === 1 ? '' : 's'}`);

  const ok = await confirmDialog({
    title: `Remove all of ${cardName}?`,
    message: `This deletes ${parts.join(', ')} from your collection. `
      + 'To remove a single copy, use the card page instead.',
    confirmText: `Remove all ${copies}`,
    cancelText: 'Keep them',
    danger: true,
  });

  if (!ok) return { owned: true, changed: false };

  const removed = await api.toggleCardOwnership(cardId, { confirmRemoveAll: true });
  showToast(`Removed ${copies} cop${copies === 1 ? 'y' : 'ies'} from collection`, 'success', 2500);
  return { owned: removed.owned, changed: true };
}

/**
 * The button's own markup, so its accessible name and its state cannot drift
 * between the four places it is rendered.
 *
 * It used to be an empty 32px circle whose only state signal was a background
 * colour — a screen reader read fifty anonymous buttons, and red/green
 * colourblind users could not tell owned from unowned at all. This is the
 * control that decides whether you own a card, so it says so: a name that
 * names the card and the action, `aria-pressed` for the state, and a `title`
 * for the pointer.
 *
 * The icon differs by state as well as the colour (a filled tick versus an
 * empty ring), which is the part that survives being unable to see the hue.
 */
export function ownershipToggleAttrs(card, { isOwned = card.is_owned } = {}) {
  const name = card.name || 'this card';
  const label = isOwned
    ? `Owned: ${name}. Removes every copy from your collection.`
    : `Not owned: ${name}. Adds one copy to your collection.`;

  return `data-card-id="${card.id ?? card.card_id}" data-card-name="${escapeAttr(name)}"`
    + ` aria-pressed="${isOwned ? 'true' : 'false'}" aria-label="${escapeAttr(label)}"`
    + ` title="${escapeAttr(label)}"`;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Repaint a toggle after a successful change. Colour, icon and the accessible
 * name move together — the name going stale is the failure nobody would see.
 */
export function paintOwnershipToggle(buttonEl, isOwned) {
  const name = buttonEl.dataset.cardName || 'this card';
  const label = isOwned
    ? `Owned: ${name}. Removes every copy from your collection.`
    : `Not owned: ${name}. Adds one copy to your collection.`;

  buttonEl.classList.toggle('owned', isOwned);
  buttonEl.style.background = isOwned
    ? 'rgb(var(--success-rgb) / 0.9)'
    : 'rgb(var(--scrim-rgb) / 0.8)';
  buttonEl.innerHTML = isOwned
    ? '<i class="ph-fill ph-check-circle"></i>'
    : '<i class="ph ph-circle"></i>';
  buttonEl.setAttribute('aria-pressed', isOwned ? 'true' : 'false');
  buttonEl.setAttribute('aria-label', label);
  buttonEl.setAttribute('title', label);
}
