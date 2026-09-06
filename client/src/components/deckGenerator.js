/**
 * The deck generator's page: pick a format, pick a commander by looking at it,
 * pick what to build around, read what came back, and decide.
 *
 * ── Why this is a page ─────────────────────────────────────────────────────
 *
 * It began as a modal with two dropdowns, and both of them were asking for a
 * judgement they gave no basis for. A commander is chosen by reading the card
 * — a `<select>` of six hundred names is a list of strings, not a choice — and
 * a theme called "blink (18 enablers / 11 payoffs)" is a measurement that only
 * means something to a player who already knew what blink was. So the
 * commanders are browsed as card art, and every theme carries a plain-English
 * description of what a deck built that way is trying to do, with the counts
 * named in that theme's own terms underneath.
 *
 * ── Why this shows so much ─────────────────────────────────────────────────
 *
 * Every card in the proposal was chosen by matching regular expressions
 * against English card text, and that will sometimes be wrong. A page that
 * simply produced a deck would be asking to be trusted about a judgement it is
 * not entitled to. So the reason each card was picked travels with it, the
 * theme shows the counts behind it, and the gaps the collection could not fill
 * are listed rather than quietly padded.
 *
 * ── Nothing is saved until it is accepted ──────────────────────────────────
 *
 * Generating is a read. The deck only exists once the name is filled in and
 * Save is pressed, and it is created as an idea, so it cannot take cards away
 * from decks that are actually built.
 */

import api from '../services/api.js';
import { showToast, showError } from '../utils/ui.js';
import { zoomButton } from '../utils/cardZoom.js';

let proposal = null;
let commanders = [];
let themes = [];
let revisable = [];
let wired = false;

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const includeCommitted = () => Boolean($('generate-include-committed')?.checked);

/** Is the page proposing a revision of an existing deck? */
const isRevising = () =>
  document.querySelector('input[name="generate-mode"]:checked')?.value === 'revise';

/** The deck being revised, as an id, or null when building from scratch. */
function revisingDeckId() {
  if (!isRevising()) return null;
  const value = $('generate-revise-deck')?.value;
  return value ? Number(value) : null;
}

/** The chosen deck's row, for the things the page says about it. */
const revisingDeck = () => revisable.find((d) => d.id === revisingDeckId()) || null;

const chosenFormat = () => $('generate-format')?.value || 'commander';
const isCommander = () => chosenFormat() === 'commander';

/** The colours ticked, as a bare identity string. */
const chosenColors = () => [...document.querySelectorAll('.generate-color:checked')]
  .map((box) => box.value).join('');

/** The colours the commander gallery is being filtered down to. */
const galleryColors = () => [...document.querySelectorAll('.generate-commander-color:checked')]
  .map((box) => box.value);

/**
 * Commander picks its colours from the commander; every other format has to be
 * told. Swapping which section is shown keeps the page from asking for both.
 */
function applyFormat() {
  // A revision takes its format and its commander from the deck, so both
  // pickers go away rather than sitting there inviting a contradiction the
  // server would only overrule.
  const revising = isRevising();

  $('generate-commander-group')?.classList.toggle('hidden', revising || !isCommander());
  $('generate-colors-group')?.classList.toggle('hidden', revising || isCommander());

  const format = $('generate-format');
  if (format) {
    format.disabled = revising;
    format.title = revising ? 'Taken from the deck being revised' : '';
  }

  $('generate-revise-group')?.classList.toggle('hidden', !revising);
  renderRevisionNote();
}

/** What the chosen deck is, said back to the person who chose it. */
function renderRevisionNote() {
  const note = $('generate-revise-note');
  if (!note) return;

  const deck = revisingDeck();
  if (!isRevising() || !deck) { note.textContent = ''; return; }

  const parts = [
    deck.commanderName ? `led by ${deck.commanderName}` : null,
    deck.format || null,
    `${deck.cards} cards`,
    deck.status || null,
  ].filter(Boolean);

  note.textContent = `Revising ${deck.name} — ${parts.join(' · ')}. `
    + 'Nothing about this deck changes until you save the proposal as a deck of its own.';
}

/** Mana symbols as plain text — the page is dense enough without pips. */
const cost = (manaCost) => (manaCost || '').replace(/[{}]/g, ' ').trim();

const COLOR_WORDS = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };

/** "white and blue", for a colour identity string. */
function colorPhrase(identity) {
  const words = [...String(identity || '')].map((c) => COLOR_WORDS[c]).filter(Boolean);
  if (words.length === 0) return 'colourless';
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function setupDeckGenerator() {
  // The entry point from the deck list. Navigating rather than opening means
  // the choices get a URL, so Back leaves the generator instead of leaving the
  // app, and a half-made proposal survives a reload of the address bar.
  $('generate-deck-btn')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'deck-generator' } }));
  });

  window.addEventListener('page:deck-generator', onShow);
}

/**
 * Wire the page the first time it is shown, and load what it needs every time.
 *
 * The listeners are attached once — the page is never rebuilt, only hidden —
 * but the commander list is re-read on each visit, because the collection may
 * have changed since the last one.
 */
async function onShow() {
  if (!wired) {
    wire();
    wired = true;
  }

  await loadRevisableDecks();
  applyFormat();
  await reload();
}

/**
 * Load whatever the current mode needs.
 *
 * Revising skips the commander gallery entirely — the deck names its own
 * leader — and goes straight to the themes, which are measured against a pool
 * that has the deck's own cards back in it.
 */
async function reload() {
  if (isRevising()) await loadThemes();
  else if (isCommander()) await loadCommanders();
  else await loadThemes();
}

async function loadRevisableDecks() {
  const select = $('generate-revise-deck');
  if (!select) return;

  try {
    const data = await api.getRevisableDecks();
    revisable = data.decks || [];

    if (revisable.length === 0) {
      select.innerHTML = '<option value="">You have no decks to revise yet</option>';
      return;
    }

    // The chosen deck survives a reload of the list, the same way the chosen
    // commander does.
    const chosen = select.value;
    select.innerHTML = revisable.map((deck) => `
      <option value="${deck.id}">
        ${escapeHtml(deck.name)} — ${escapeHtml(deck.format || 'no format')}, ${deck.cards} cards
      </option>`).join('');
    if (revisable.some((d) => String(d.id) === String(chosen))) select.value = chosen;
  } catch (error) {
    console.error('Failed to load decks to revise:', error);
    select.innerHTML = '<option value="">Could not load your decks</option>';
  }
}

function wire() {
  // Changing any input invalidates whatever is on screen: leaving a proposal
  // visible under a commander it was not built for is how somebody saves the
  // wrong deck.
  $('generate-include-committed')?.addEventListener('change', async () => {
    resetResult();
    await reload();
  });

  $('generate-format')?.addEventListener('change', async () => {
    resetResult();
    applyFormat();
    await reload();
  });

  document.querySelectorAll('input[name="generate-mode"]').forEach((radio) => {
    radio.addEventListener('change', async () => {
      resetResult();
      applyFormat();
      await reload();
    });
  });

  $('generate-revise-deck')?.addEventListener('change', async () => {
    resetResult();
    renderRevisionNote();
    await loadThemes();
  });

  // Filtering the gallery is not choosing anything, so it redraws the tiles
  // and touches nothing else.
  $('generate-commander-search')?.addEventListener('input', renderCommanders);
  document.querySelectorAll('.generate-commander-color').forEach((box) => {
    box.addEventListener('change', renderCommanders);
  });

  document.querySelectorAll('.generate-color').forEach((box) => {
    box.addEventListener('change', async () => {
      resetResult();
      await loadThemes();
    });
  });

  // One listener on the gallery rather than one per tile: the tiles are
  // rewritten on every keystroke in the search box.
  $('generate-commander-gallery')?.addEventListener('click', async (event) => {
    const tile = event.target.closest('.generator-card');
    // The zoom glass sits inside the tile and opens the full-size image; it is
    // a look, not a choice, and cardZoom has already handled it.
    if (!tile || event.target.closest('.card-zoom-btn')) return;

    selectCommander(tile.dataset.cardId);
    resetResult();
    await loadThemes();
  });

  // Keyboard equivalent of the click above, which a real <button> would have
  // given us for free. Space is included because that is what a button does.
  $('generate-commander-gallery')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const tile = event.target.closest('.generator-card');
    if (!tile) return;
    event.preventDefault();
    tile.click();
  });

  $('generate-theme-list')?.addEventListener('click', (event) => {
    const tile = event.target.closest('.generator-theme');
    if (!tile) return;
    selectTheme(tile.dataset.themeKey || '');
    resetResult();
  });

  $('generate-run')?.addEventListener('click', run);
  $('generate-accept')?.addEventListener('click', accept);
}

function resetResult() {
  proposal = null;
  const result = $('generate-result');
  if (result) { result.innerHTML = ''; result.classList.add('hidden'); }
  $('generate-accept-row')?.classList.add('hidden');

  // The name goes with the proposal it was suggested for. The dialog got away
  // without this because closing it ended the session; a page does not close,
  // so a name suggested for a commander deck sat there through a switch to
  // Modern and would have been saved onto a deck with no commander in it.
  const name = $('generate-deck-name');
  if (name) name.value = '';
}

// --- Commanders ------------------------------------------------------------

async function loadCommanders() {
  const gallery = $('generate-commander-gallery');
  if (!gallery) return;

  gallery.innerHTML = '<div class="generator-empty">Loading your commanders…</div>';
  try {
    const data = await api.getGeneratorCommanders(includeCommitted());
    commanders = data.commanders || [];

    if (commanders.length === 0) {
      gallery.innerHTML = `
        <div class="generator-empty">
          No legendary creatures in your collection to lead a deck. Add some to your
          inventory, or switch the format above to a sixty-card one, which needs no
          commander.
        </div>`;
      $('generate-theme-list').innerHTML = '';
      return;
    }

    // A choice that survives the list being reloaded, but only if it is still
    // in it — turning off "cards in my other decks" can take a commander away.
    const chosen = $('generate-commander').value;
    if (!commanders.some((c) => String(c.cardId) === String(chosen))) {
      selectCommander(commanders[0].cardId);
    }

    renderCommanders();
    await loadThemes();
  } catch (error) {
    console.error('Failed to load commanders:', error);
    gallery.innerHTML = '<div class="generator-empty">Could not load your commanders.</div>';
  }
}

/** The commanders left after the search box and the colour ticks. */
function filteredCommanders() {
  const needle = ($('generate-commander-search')?.value || '').trim().toLowerCase();
  const colors = galleryColors();

  return commanders.filter((c) => {
    if (needle && !c.name.toLowerCase().includes(needle)) return false;
    // Every ticked colour has to be in the identity, rather than any of them:
    // ticking white and blue is a request for a deck that plays both, and an
    // "any" reading buries the Azorius commanders under every mono-white one.
    return colors.every((color) => String(c.colorIdentity || '').includes(color));
  });
}

function selectCommander(cardId) {
  const field = $('generate-commander');
  if (field) field.value = cardId == null ? '' : String(cardId);
  markSelectedCommander();
}

function markSelectedCommander() {
  const chosen = $('generate-commander')?.value;
  document.querySelectorAll('.generator-card').forEach((tile) => {
    tile.classList.toggle('selected', tile.dataset.cardId === chosen);
    tile.setAttribute('aria-pressed', tile.dataset.cardId === chosen ? 'true' : 'false');
  });
}

function renderCommanders() {
  const gallery = $('generate-commander-gallery');
  if (!gallery) return;

  const shown = filteredCommanders();
  const count = $('generate-commander-count');
  if (count) {
    count.textContent = shown.length === commanders.length
      ? `${commanders.length} commander${commanders.length === 1 ? '' : 's'} you own`
      : `${shown.length} of ${commanders.length}`;
  }

  if (shown.length === 0) {
    gallery.innerHTML = '<div class="generator-empty">No commander you own matches that.</div>';
    return;
  }

  // A div with a button role rather than a <button>: the zoom glass is itself
  // a button, and a button inside a button is invalid HTML — the parser closes
  // the outer one early, which threw the name and the mana cost out of the
  // tile and left the gallery reading as one card per row.
  gallery.innerHTML = shown.map((c) => `
    <div role="button" tabindex="0" class="generator-card" data-card-id="${c.cardId}"
         aria-pressed="false" title="${escapeHtml(c.typeLine || '')}">
      <div class="generator-card-art">
        ${c.imageUrl
          // Lazily, because a deep collection is several hundred images and
          // the gallery is scrolled rather than read all at once.
          ? `<img src="${escapeHtml(c.imageUrl)}" alt="${escapeHtml(c.name)}" loading="lazy" />`
          : `<div class="generator-card-noart">${escapeHtml(c.name)}</div>`}
        ${zoomButton(c.imageUrl, c.name)}
      </div>
      <div class="generator-card-name">${escapeHtml(c.name)}</div>
      <div class="generator-card-meta">
        ${escapeHtml(colorPhrase(c.colorIdentity))}
        ${c.manaCost ? `&middot; ${escapeHtml(cost(c.manaCost))}` : ''}
      </div>
    </div>
  `).join('');

  markSelectedCommander();
}

// --- Themes ----------------------------------------------------------------

function selectTheme(key) {
  const field = $('generate-theme');
  if (field) field.value = key || '';
  document.querySelectorAll('.generator-theme').forEach((tile) => {
    const selected = (tile.dataset.themeKey || '') === (key || '');
    tile.classList.toggle('selected', selected);
    tile.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
}

async function loadThemes() {
  const list = $('generate-theme-list');
  if (!list) return;

  const revising = isRevising();

  if (revising && !revisingDeckId()) {
    list.innerHTML = '<div class="generator-empty">Pick a deck to revise above.</div>';
    return;
  }

  const commanderCardId = (!revising && isCommander()) ? $('generate-commander')?.value : null;
  if (!revising && isCommander() && !commanderCardId) return;

  if (!revising && !isCommander() && !chosenColors()) {
    list.innerHTML = '<div class="generator-empty">Pick at least one colour above.</div>';
    return;
  }

  list.innerHTML = '<div class="generator-empty">Measuring your collection…</div>';
  try {
    const data = await api.getGeneratorThemes(commanderCardId, includeCommitted(), {
      // A revision's colours and format come from the deck, which the server
      // reads for itself; sending this page's pickers would overrule it.
      identity: revising ? '' : chosenColors(),
      format: revising ? (revisingDeck()?.format || '') : chosenFormat(),
      reviseDeckId: revisingDeckId(),
    });
    themes = data.themes || [];
    renderThemes();
  } catch (error) {
    console.error('Failed to load themes:', error);
    themes = [];
    renderThemes();
  }
}

function renderThemes() {
  const list = $('generate-theme-list');
  if (!list) return;

  // "Let it choose" first and always present: it is the answer for somebody
  // who does not yet know which of these they want, which is most of the
  // people this page was widened for.
  // The default means something different in each mode, and saying the same
  // thing in both would be wrong in one of them: from scratch it is the
  // collection's strongest theme, and on a revision it is whatever the deck is
  // already doing, read off the cards in it.
  const auto = isRevising() ? `
    <button type="button" class="generator-theme" data-theme-key="" aria-pressed="false">
      <div class="generator-theme-head">
        <span class="generator-theme-label">Keep what this deck already does</span>
      </div>
      <p class="generator-theme-blurb">
        Reads the deck's own cards for its theme and revises towards that, rather
        than rebuilding it around something else. Pick one of the others to point
        the deck somewhere new.
      </p>
    </button>` : `
    <button type="button" class="generator-theme" data-theme-key="" aria-pressed="false">
      <div class="generator-theme-head">
        <span class="generator-theme-label">Let it choose for me</span>
      </div>
      <p class="generator-theme-blurb">
        Builds around whichever of the themes below your collection supports best. A
        reasonable first try if none of them mean much to you yet — the deck it
        proposes will say which one it picked, and why.
      </p>
    </button>`;

  const cards = themes.map((theme) => `
      <button type="button" class="generator-theme" data-theme-key="${escapeHtml(theme.key)}"
              aria-pressed="false">
        <div class="generator-theme-head">
          <span class="generator-theme-label">${escapeHtml(theme.label)}</span>
          ${theme.viable
            ? ''
            // Named rather than hidden. A thin theme is still buildable and
            // sometimes the only one in a young collection; what it must not do
            // is look like the others.
            : '<span class="generator-theme-thin" title="Buildable, but your collection is short of one half of it">thin</span>'}
        </div>
        <p class="generator-theme-blurb">${escapeHtml(theme.blurb || '')}</p>
        <div class="generator-theme-counts">
          <span><strong>${theme.enablers}</strong> ${escapeHtml(theme.enablerName)}</span>
          <span><strong>${theme.payoffs}</strong> ${escapeHtml(theme.payoffName)}</span>
        </div>
        ${theme.examples && theme.examples.length ? `
          <div class="generator-theme-examples">
            e.g. ${theme.examples.slice(0, 4).map((n) => escapeHtml(n)).join(', ')}
          </div>` : ''}
      </button>`).join('');

  list.innerHTML = auto + (cards || `
    <div class="generator-empty">
      Nothing in these colours is dense enough to build around yet. "Let it choose"
      still works — it will assemble a deck out of your best cards without a theme.
    </div>`);

  // Whatever was chosen before, if it is still on offer. A theme that has gone
  // (the colours moved) falls back to letting the generator choose rather than
  // silently keeping a key nothing here shows.
  const chosen = $('generate-theme')?.value || '';
  selectTheme(themes.some((t) => t.key === chosen) ? chosen : '');
}

// --- Generating ------------------------------------------------------------

async function run() {
  const revising = isRevising();
  const commanderCardId = (!revising && isCommander()) ? $('generate-commander')?.value : null;

  if (revising && !revisingDeckId()) {
    showToast('Pick a deck to revise first', 'warning');
    return;
  }
  if (!revising && isCommander() && !commanderCardId) {
    showToast('Pick a commander first', 'warning');
    return;
  }
  if (!revising && !isCommander() && !chosenColors()) {
    showToast('Pick at least one colour first', 'warning');
    return;
  }

  const button = $('generate-run');
  button.disabled = true;
  button.textContent = 'Generating…';

  try {
    const data = await api.generateDeck({
      commanderCardId: commanderCardId ? Number(commanderCardId) : null,
      // Both left unsaid when revising, so the deck's own format and colours
      // are what the proposal is built to.
      format: revising ? null : chosenFormat(),
      themeKey: $('generate-theme')?.value || null,
      includeCommitted: includeCommitted(),
      identity: revising ? null : (chosenColors() || null),
      reviseDeckId: revisingDeckId(),
    });

    proposal = data.proposal;
    render(proposal);

    // Named after what it was built from, because a list of decks called
    // "Generated deck 3" is useless a week later.
    const name = $('generate-deck-name');
    if (name && !name.value) {
      if (proposal.revision) {
        // Named after the deck it came from, because that is the only thing
        // that tells the two apart in a list a week later.
        name.value = `${proposal.revision.deckName} (revised)`.slice(0, 80);
      } else {
        const themeLabel = proposal.theme ? ` ${proposal.theme.label}` : '';
        const lead = proposal.commanderCard?.name
          || `${chosenFormat()} ${proposal.colorIdentity || ''}`.trim();
        name.value = `${lead}${themeLabel}`.slice(0, 80);
      }
    }

    $('generate-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error('Generate failed:', error);
    showError(error.body?.error || error.message || 'Could not generate a deck');
  } finally {
    button.disabled = false;
    button.textContent = 'Generate';
  }
}

/**
 * What a revision would change, before anything about the deck itself.
 *
 * The diff is the answer to the question that was asked — "how should this
 * deck be different" — and the hundred-card list below it is only the working.
 * Cuts and additions are shown as two lists rather than a merged one: they are
 * two decisions, and a shopper reads the cut list to see what comes out of the
 * box.
 */
function renderRevision(revision) {
  const list = (rows) => rows.map((row) => `
    <li>
      <span class="generate-card-cost">${row.quantity}&times;</span>
      <span class="generate-card-name">${escapeHtml(row.name)}</span>
    </li>`).join('');

  if (revision.unchanged) {
    return `
      <div class="generate-revision">
        <div class="generate-head">No changes to ${escapeHtml(revision.deckName)}</div>
        <div class="generate-note">
          Given the cards you own, this deck is already the deck the generator would
          build. That is a real answer, not a failure to find one.
        </div>
      </div>`;
  }

  return `
    <div class="generate-revision">
      <div class="generate-head">
        What this would change about ${escapeHtml(revision.deckName)}
      </div>
      <div class="generate-note">
        ${revision.keptCount} cards stay as they are. Saving keeps
        ${escapeHtml(revision.deckName)} exactly as it is and creates a separate deck
        from this proposal, so nothing is lost if you disagree with it.
      </div>
      <div class="generate-columns">
        <div>
          <div class="generate-head">Add (${revision.added.length})</div>
          <ul>${list(revision.added) || '<li>Nothing new.</li>'}</ul>
        </div>
        <div>
          <div class="generate-head">Cut (${revision.cut.length})</div>
          <ul>${list(revision.cut) || '<li>Nothing comes out.</li>'}</ul>
        </div>
      </div>
    </div>`;
}

function render(p) {
  const result = $('generate-result');
  if (!result) return;

  const roles = p.summary.roles || {};
  const roleLabels = { ramp: 'ramp', draw: 'card draw', removal: 'removal', sweeper: 'wipes' };

  const stat = (value, label) =>
    `<div class="generate-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;

  const curve = Object.entries(p.summary.curve || {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([mv, n]) => `<span class="generate-curve-bar" title="${n} at cost ${mv}">
        <span style="height:${Math.min(100, n * 8)}px"></span><small>${mv === '7' ? '7+' : mv}</small>
      </span>`).join('');

  result.innerHTML = `
    ${p.revision ? renderRevision(p.revision) : ''}

    <div class="generate-summary">
      ${stat(p.summary.totalCards, 'cards')}
      ${stat(p.summary.lands, 'lands')}
      ${stat(p.summary.averageMv, 'avg cost')}
      ${Object.entries(roles).map(([code, n]) => stat(n, roleLabels[code] || code)).join('')}
    </div>

    ${p.theme ? `
      <div class="generate-theme-note">
        <strong>Built around ${escapeHtml(p.theme.label)}.</strong>
        ${escapeHtml(p.theme.blurb || '')}
        <span class="generate-theme-evidence">
          Your collection has ${p.theme.enablers} ${escapeHtml(p.theme.enablerName || 'enablers')}
          and ${p.theme.payoffs} ${escapeHtml(p.theme.payoffName || 'payoffs')} in these colours.
        </span>
      </div>
    ` : ''}

    ${(p.notes || []).map((n) => `<div class="generate-note">${escapeHtml(n)}</div>`).join('')}

    ${p.shortfalls && p.shortfalls.length ? `
      <div class="generate-shortfalls">
        <div class="generate-head">What your collection could not cover</div>
        <ul>${p.shortfalls.map((s) => `<li>${escapeHtml(s.message)}</li>`).join('')}</ul>
        ${p.shortfalls.some((s) => s.kind === 'role') ? `
          <button id="generate-find-gaps" class="btn btn-secondary generate-gap-btn">
            Find cards that would fill these
          </button>
        ` : ''}
      </div>
    ` : ''}

    <div id="generate-gaps" class="hidden"></div>

    <div class="generate-curve">${curve}</div>

    <details class="generate-list">
      <summary>${p.mainboard.length} spells and ${p.lands.length} land entries</summary>
      <div class="generate-columns">
        <div>
          <div class="generate-head">Spells</div>
          <ul>
            ${p.mainboard.map((c) => `
              <li>
                <span class="generate-card-cost">${escapeHtml(cost(c.manaCost))}</span>
                <span class="generate-card-name">${escapeHtml(c.name)}</span>
                <span class="generate-card-reason">${escapeHtml(c.reason || '')}</span>
              </li>`).join('')}
          </ul>
        </div>
        <div>
          <div class="generate-head">Lands</div>
          <ul>
            ${p.lands.map((l) => `
              <li>
                <span class="generate-card-cost">${l.quantity}&times;</span>
                <span class="generate-card-name">${escapeHtml(l.name)}</span>
              </li>`).join('')}
          </ul>
        </div>
      </div>
    </details>

    <div class="generate-pool">
      Chosen from ${p.pool.cards} cards${p.pool.includeCommitted
        ? ', including cards currently in your other decks'
        : ' that no other deck has claimed'}.
    </div>
  `;

  result.classList.remove('hidden');
  $('generate-accept-row')?.classList.remove('hidden');

  // Bound after the panel is written, because the button only exists when the
  // proposal actually came up short on a role.
  $('generate-find-gaps')?.addEventListener('click', findGaps);
}

/**
 * Suggest cards to buy for the roles the collection could not fill.
 *
 * A separate request rather than part of the proposal: it searches the whole
 * card database rather than the collection, and most proposals are read and
 * closed without anybody wanting to spend money.
 */
async function findGaps() {
  const button = $('generate-find-gaps');
  const target = $('generate-gaps');
  if (!button || !target) return;

  button.disabled = true;
  button.textContent = 'Looking…';

  try {
    const data = await api.getGeneratorGaps({
      commanderCardId: (!isRevising() && isCommander())
        ? Number($('generate-commander')?.value)
        : (proposal?.commanderCard?.cardId ?? null),
      format: proposal?.format || chosenFormat(),
      themeKey: $('generate-theme')?.value || null,
      includeCommitted: includeCommitted(),
      identity: isRevising() ? (proposal?.colorIdentity || null) : (chosenColors() || null),
    });

    const gaps = (data.gaps || []).filter((g) => g.suggestions.length);
    if (gaps.length === 0) {
      target.innerHTML = '<div class="generate-note">Nothing to suggest for these gaps.</div>';
      target.classList.remove('hidden');
      return;
    }

    const money = (p) => (p == null ? '—' : `$${Number(p).toFixed(2)}`);

    target.innerHTML = `
      <div class="generate-head">Cards you could buy</div>
      <div class="generate-note">
        Ranked by how often they are played, with the cheapest printing's price.
        Ticking these puts them on your shopping list as wanted cards; it does not
        change the deck.
      </div>
      ${gaps.map((gap) => `
        <div class="generate-gap">
          <div class="generate-gap-head">
            ${escapeHtml(gap.label)} &mdash; ${gap.short} short
          </div>
          <ul class="generate-gap-list">
            ${gap.suggestions.map((s) => `
              <li>
                <label>
                  <input type="checkbox" class="generate-gap-pick"
                         data-printing-id="${s.printingId}" />
                  <span class="generate-card-cost">${escapeHtml(cost(s.manaCost))}</span>
                  <span class="generate-card-name">${escapeHtml(s.name)}</span>
                  <span class="generate-gap-price">${escapeHtml(money(s.price))}</span>
                </label>
              </li>`).join('')}
          </ul>
        </div>
      `).join('')}
      <button id="generate-gap-add" class="btn btn-secondary">Add ticked cards to my shopping list</button>
    `;
    target.classList.remove('hidden');
    $('generate-gap-add')?.addEventListener('click', addGaps);
  } catch (error) {
    console.error('Gap suggestions failed:', error);
    showError(error.body?.error || error.message || 'Could not look for cards');
  } finally {
    button.disabled = false;
    button.textContent = 'Find cards that would fill these';
  }
}

async function addGaps() {
  const picked = [...document.querySelectorAll('.generate-gap-pick:checked')]
    .map((box) => ({ printingId: Number(box.dataset.printingId), quantity: 1 }));

  if (picked.length === 0) {
    showToast('Tick the cards you want first', 'warning');
    return;
  }

  const button = $('generate-gap-add');
  button.disabled = true;

  try {
    const result = await api.addGapsToShoppingList(picked);
    showToast(`Added ${result.added.length} to your shopping list`, 'success');

    // Marked as well as disabled. A disabled checkbox that looks like an
    // unticked one tells you nothing about what you just added, and the
    // obvious next move is to add it again.
    document.querySelectorAll('.generate-gap-pick:checked').forEach((box) => {
      box.checked = false;
      box.disabled = true;
      const row = box.closest('label');
      if (row && !row.querySelector('.generate-gap-added')) {
        row.classList.add('generate-gap-done');
        row.insertAdjacentHTML('beforeend', '<span class="generate-gap-added">on your list</span>');
      }
    });
  } catch (error) {
    console.error('Adding to the shopping list failed:', error);
    showError(error.body?.error || error.message || 'Could not add to the shopping list');
  } finally {
    button.disabled = false;
  }
}

async function accept() {
  if (!proposal) return;

  const name = $('generate-deck-name')?.value?.trim();
  if (!name) {
    showToast('Give the deck a name first', 'warning');
    return;
  }

  const button = $('generate-accept');
  button.disabled = true;

  try {
    const result = await api.acceptGeneratedDeck({
      name,
      format: proposal.format || chosenFormat(),
      commander: proposal.commanderCard
        ? {
          name: proposal.commanderCard.name,
          printingId: proposal.commanderCard.printingId,
          isFoil: proposal.commanderCard.isFoil,
          quantity: 1,
        }
        : null,
      // Printing ids come straight from the proposal so the deck is built out
      // of copies actually owned, rather than whatever printing a name lookup
      // happens to return first. The finish travels with the printing and
      // never on its own: they identify one row together.
      cards: [
        ...proposal.mainboard.map((c) => ({
          name: c.name, printingId: c.printingId, isFoil: c.isFoil, quantity: c.quantity,
        })),
        // The land list is two kinds of thing: basics, which carry no printing
        // because they are not tracked as inventory, and nonbasic lands picked
        // out of the collection like any other card. Hard-coding the finish
        // here was wrong for the second kind — a foil-only Maze's End came
        // back as a non-foil copy nobody owns.
        ...proposal.lands.map((l) => ({
          name: l.name,
          printingId: l.printingId || null,
          isFoil: Boolean(l.isFoil),
          quantity: l.quantity,
        })),
      ],
    });

    const missed = result.unresolved?.length
      ? `, ${result.unresolved.length} could not be matched to a printing`
      : '';
    showToast(`Saved as an idea — ${result.added} cards${missed}`, 'success');

    // Back to the deck list, where the new deck is. Staying here would leave a
    // proposal on screen that has already been saved, and the obvious next
    // press saves it a second time.
    resetResult();
    window.dispatchEvent(new CustomEvent('decks:changed'));
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'decks' } }));
  } catch (error) {
    console.error('Accept failed:', error);
    showError(error.body?.error || error.message || 'Could not save the deck');
  } finally {
    button.disabled = false;
  }
}
