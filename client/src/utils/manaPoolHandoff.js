/**
 * Handing a list to Mana Pool.
 *
 * Their Mass Entry page takes the list in the link: `/add-deck?deck=` and the
 * lines ("2 Vampiric Tutor (CMR) 156", one per line) as base64 with the
 * trailing `=` padding dropped. That is the format EDHREC's "Buy on Mana
 * Pool" links use; it is not in Mana Pool's documentation, so if it ever stops
 * working, this is the one place to change. The lines are the ones the quote
 * was built from, so Mana Pool is shown the same printings.
 *
 * A cart itself cannot be filled from outside: the API's only way to reserve
 * stock is a pending order against the buyer's account.
 */

const MASS_ENTRY_URL = 'https://manapool.com/add-deck';

/** Base64 of UTF-8 text, unpadded, as Mana Pool's `deck` parameter expects. */
export function encodeDeckParam(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=+$/, '');
}

export function massEntryUrl(text) {
  return `${MASS_ENTRY_URL}?deck=${encodeURIComponent(encodeDeckParam(text))}`;
}

/** A "Buy on Mana Pool" link that opens Mass Entry already filled in. */
export function massEntryButton(text, { primary = true, label = 'Buy on Mana Pool' } = {}) {
  if (!text) return '';
  return `<a class="btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-sm" href="${massEntryUrl(text)}"
      target="_blank" rel="noopener" title="Opens Mana Pool's Mass Entry with this list filled in">
    <i class="ph ph-arrow-square-out"></i> ${label}
  </a>`;
}
