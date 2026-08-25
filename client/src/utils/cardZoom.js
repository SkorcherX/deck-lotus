/**
 * The magnifying glass that sits on every card shown in a list.
 *
 * Card art is printed at thumbnail size everywhere in this app — the grid
 * tiles, the shopping rows, the deck lists — which is enough to recognise a
 * card and not nearly enough to read one. This opens the printing's own image
 * at full size so the rules text is legible and the art is worth looking at.
 *
 * Two things are deliberate here:
 *
 * - The click is caught in the *capture* phase on `document`, not by a
 *   listener per button. Every list in the app re-renders its rows from an
 *   HTML string and wires row clicks afterwards, so a bubbling handler would
 *   arrive after the row had already opened its detail modal. Capturing lets
 *   the glass stop the event before the row ever sees it, and means a newly
 *   appended page of cards needs no wiring at all.
 * - The back face is probed rather than declared. Scryfall image URLs contain
 *   `/front/` for single- and double-faced cards alike, so the URL cannot say
 *   whether a back exists, and the list payloads that feed most of these
 *   buttons carry no `layout`. Asking the browser to load the back and showing
 *   the flip control only if it arrives costs one request on an explicit user
 *   action and keeps every call site down to an image URL and a name.
 */

// Scryfall serves the same image at several sizes under a path segment. The
// lists hand us whatever size they render at; the zoom always wants the big one.
const SIZE_SEGMENTS = ['/small/', '/normal/', '/art_crop/', '/border_crop/'];

/**
 * Upgrade a card image URL to the largest size available. Anything that is not
 * a recognised Scryfall size path is returned untouched.
 */
export function largeImageUrl(url) {
  if (!url) return url;
  for (const segment of SIZE_SEGMENTS) {
    if (url.includes(segment)) return url.replace(segment, '/large/');
  }
  return url;
}

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Markup for the glass. Returns an empty string when there is no image, so a
 * call site can drop it into a template unconditionally.
 *
 * @param {string} imageUrl  any size of the card's image
 * @param {string} name      card name, for the tooltip and the caption
 * @param {object} [opts]
 * @param {string} [opts.className] extra classes for placement
 */
export function zoomButton(imageUrl, name, { className = '' } = {}) {
  if (!imageUrl) return '';
  const label = `Enlarge ${name || 'card'}`;
  return `<button type="button" class="card-zoom-btn ${className}" ` +
    `data-zoom-src="${escapeAttr(imageUrl)}" data-zoom-name="${escapeAttr(name || '')}" ` +
    `title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">` +
    `<i class="ph ph-magnifying-glass-plus" aria-hidden="true"></i></button>`;
}

/**
 * Open the viewer directly, for the places that already have a click of their
 * own and only want the overlay.
 */
export function showCardZoom(imageUrl, name = '') {
  if (!imageUrl) return null;

  const frontUrl = largeImageUrl(imageUrl);
  const overlay = document.createElement('div');
  overlay.className = 'modal card-zoom-modal';
  overlay.innerHTML = `
    <div class="card-zoom-content" role="dialog" aria-modal="true" aria-label="${escapeAttr(name || 'Card image')}">
      <button type="button" class="card-zoom-close" aria-label="Close">
        <i class="ph ph-x" aria-hidden="true"></i>
      </button>
      <img class="card-zoom-image" src="${escapeAttr(frontUrl)}" alt="${escapeAttr(name || 'Card')}">
      <div class="card-zoom-bar">
        ${name ? `<span class="card-zoom-name">${escapeAttr(name)}</span>` : ''}
        <button type="button" class="btn btn-secondary card-zoom-flip hidden">
          <i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Flip
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const img = overlay.querySelector('.card-zoom-image');
  const flipBtn = overlay.querySelector('.card-zoom-flip');

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  // Clicking the backdrop or the picture itself dismisses; this is a viewer,
  // not a form, so there is nothing on it worth guarding against a stray click.
  overlay.addEventListener('click', close);

  // Offer the flip only once the back face has actually loaded. Single-faced
  // cards 404 here and the control simply never appears.
  const backUrl = frontUrl.includes('/front/') ? frontUrl.replace('/front/', '/back/') : null;
  if (backUrl) {
    const probe = new Image();
    probe.addEventListener('load', () => {
      if (!overlay.isConnected) return;
      flipBtn.classList.remove('hidden');
      let flipped = false;
      flipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        flipped = !flipped;
        img.src = flipped ? backUrl : frontUrl;
      });
    });
    probe.src = backUrl;
  }

  return { el: overlay, close };
}

// One listener for the whole app. See the note at the top of the file for why
// this captures rather than bubbles.
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.card-zoom-btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  showCardZoom(btn.dataset.zoomSrc, btn.dataset.zoomName);
}, true);
