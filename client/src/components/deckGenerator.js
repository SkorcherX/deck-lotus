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

// The revised deck's own cards, and which of them are kept. Kept is reset
// when the deck changes: a tick against one deck means nothing on another.
let keepCards = [];
let keepDeckId = null;
const kept = new Set();

// The revised deck's saved plan, and which deck it has already been applied
// to — applied once, when the deck is picked, so it never fights the person
// changing things afterwards.
let deckPlan = null;
let planAppliedFor = null;

// Custom themes the page is carrying, as keys. Sent with every theme request
// so they are measured in the current colours; replaced by the canonical keys
// the server sends back, so a key here always matches a tile.
let customKeys = [];

/** A custom theme key from the two phrases — the server canonicalises it. */
const rawCustomKey = (payoff, enabler) =>
  `custom:${encodeURIComponent(payoff.trim())}|${encodeURIComponent(enabler.trim())}`;

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

/**
 * Colours ticked beyond the deck's own, when revising. The deck's colours are
 * shown ticked and locked, so only the extras count as a splash.
 */
const splashColors = () => [...document.querySelectorAll('.generate-splash:checked:not(:disabled)')]
  .map((box) => box.value).join('');

/**
 * Show the deck's colours as fixed and the rest as splash options. Hidden for
 * a commander deck: its identity is a rule of the format, not a choice.
 */
function renderSplash() {
  const group = $('generate-splash-group');
  if (!group) return;
  const deck = revisingDeck();
  const show = isRevising() && deck && !deck.commanderName;
  group.classList.toggle('hidden', !show);
  if (!show) return;

  const own = deck.colorIdentity || '';
  document.querySelectorAll('.generate-splash').forEach((box) => {
    const locked = own.includes(box.value);
    box.disabled = locked;
    if (locked) box.checked = true;
    else if (box.dataset.deckId !== String(deck.id)) box.checked = false;
    box.dataset.deckId = String(deck.id);
    box.closest('label').title = locked ? 'Already in this deck' : 'Splash this colour';
  });
}

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
  renderSplash();
  renderPlanNote();
  loadKeepCards();
}

/**
 * The deck's mainboard as a checklist. The commander and basics are left off:
 * the commander is never proposed away, and basics are rebuilt every time.
 */
async function loadKeepCards() {
  const group = $('generate-keep-group');
  if (!group) return;
  const deckId = revisingDeckId();
  group.classList.toggle('hidden', !deckId);
  if (!deckId || deckId === keepDeckId) return;

  keepDeckId = deckId;
  kept.clear();
  keepCards = [];
  deckPlan = null;
  planAppliedFor = null;
  renderKeepCards();
  renderPlanNote();

  try {
    const { deck } = await api.getDeck(deckId);
    if (keepDeckId !== deckId) return;
    const byCard = new Map();
    for (const row of deck.cards || []) {
      if (row.board_type !== 'mainboard' || row.is_commander) continue;
      if (/\bBasic\b/.test(row.type_line || '') && /\bLand\b/.test(row.type_line || '')) continue;
      const seen = byCard.get(row.card_id);
      if (seen) seen.quantity += row.quantity;
      else {
        byCard.set(row.card_id, {
          cardId: row.card_id,
          name: row.name,
          quantity: row.quantity,
          typeLine: row.type_line || '',
          imageUrl: row.image_url || null,
        });
      }
    }
    keepCards = [...byCard.values()].sort((a, b) => a.name.localeCompare(b.name));

    // The plan's kept cards are names; tick whichever of them the deck still
    // lists. One that has since left the deck simply is not offered.
    deckPlan = deck.plan || null;
    if (deckPlan) {
      // A plan built on a custom theme brings it back as a tile.
      for (const key of [deckPlan.themeKey, deckPlan.secondaryThemeKey]) {
        if (key && key.startsWith('custom:') && !customKeys.includes(key)) customKeys.push(key);
      }
      const names = new Set(deckPlan.keep || []);
      for (const c of keepCards) if (names.has(c.name)) kept.add(c.cardId);
      if (deckPlan.secondaryShare && $('generate-share')) {
        $('generate-share').value = String(Math.round(deckPlan.secondaryShare * 100));
      }
    }
  } catch (error) {
    console.error('Failed to load the deck to keep cards from:', error);
  }
  renderKeepCards();
  renderPlanNote();
  // Themes may have loaded before the plan did; measure again with the kept
  // cards in, so the plan's themes are offered and picked.
  if (deckPlan) loadThemes();
}

/** A theme key as its label, from the themes on offer. */
const themeLabel = (key) => themes.find((t) => t.key === key)?.label || key;

/** What is saved for this deck, said back in words. */
function renderPlanNote() {
  const group = $('generate-plan-group');
  const note = $('generate-plan-note');
  if (!group || !note) return;
  const show = isRevising() && Boolean(revisingDeckId());
  group.classList.toggle('hidden', !show);
  if (!show) return;

  if (!deckPlan) {
    note.textContent = 'No plan saved for this deck yet. Saving one makes these choices '
      + 'the starting point next time, and ranks "Fits this deck" in the deck builder by them.';
    return;
  }
  const parts = [];
  if (deckPlan.themeKey) {
    parts.push(`built around ${themeLabel(deckPlan.themeKey)}`
      + (deckPlan.secondaryThemeKey
        ? ` with ${Math.round((deckPlan.secondaryShare ?? 1 / 3) * 100)}% ${themeLabel(deckPlan.secondaryThemeKey)}`
        : ''));
  }
  if (deckPlan.keep?.length) parts.push(`keeping ${deckPlan.keep.length} card${deckPlan.keep.length === 1 ? '' : 's'}`);
  note.textContent = `This deck's plan: ${parts.join(', ')}.`;
}

/**
 * Add the typed theme as a tile and pick it: as the main theme when none is
 * picked, otherwise as the second. Typing a theme is a statement that it is
 * wanted, so it should not then have to be found and pressed as well.
 */
async function addCustomTheme() {
  const payoff = $('generate-custom-payoff')?.value || '';
  const enabler = $('generate-custom-enabler')?.value || '';
  if (!payoff.trim()) {
    showToast('Type what the payoff cards say first', 'warning');
    return;
  }

  const before = new Set(customKeys);
  customKeys = [...customKeys, rawCustomKey(payoff, enabler)];
  await loadThemes();

  const added = customKeys.find((key) => !before.has(key));
  const tile = themes.find((t) => t.key === added);
  if (!tile) {
    showToast(added === undefined ? 'That theme is already on the list' : 'Could not read that theme', 'warning');
    return;
  }

  if (!mainTheme()) selectThemes(added);
  else if (mainTheme() !== added) selectThemes(mainTheme(), added);
  resetResult();
  $('generate-custom-payoff').value = '';
  $('generate-custom-enabler').value = '';
  showToast(tile.strength > 0
    ? `Added — ${tile.payoffs} ${tile.payoffName} in these colours`
    : 'Added, but nothing you own in these colours matches it yet', tile.strength > 0 ? 'success' : 'warning');
}

function removeCustomTheme(key) {
  customKeys = customKeys.filter((k) => k !== key);
  if (mainTheme() === key) selectThemes(secondTheme());
  else if (secondTheme() === key) selectThemes(mainTheme());
  resetResult();
  loadThemes();
}

async function savePlan() {
  const deckId = revisingDeckId();
  if (!deckId) return;
  const button = $('generate-save-plan');
  if (button) button.disabled = true;
  try {
    const { plan } = await api.saveDeckPlan(deckId, {
      themeKey: mainTheme() || null,
      secondaryThemeKey: secondTheme() || null,
      secondaryShare: secondTheme() ? secondShare() : null,
      keep: keepCards.filter((c) => kept.has(c.cardId)).map((c) => c.name),
    });
    deckPlan = plan;
    planAppliedFor = deckId;
    renderPlanNote();
    showToast(plan ? "Saved as this deck's plan" : 'Nothing chosen, so the plan was cleared', 'success');
  } catch (error) {
    showError(error.body?.error || error.message || 'Could not save the plan');
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * The deck's cards as tiles, in a fixed alphabetical order.
 *
 * Ticking a card never moves it. It used to jump to the top of the list,
 * which read as the card vanishing from under the pointer; now the tile stays
 * put and lights up, and the "Keeping" chips above the grid are where the
 * kept cards are gathered — always all of them, whatever the filter shows.
 */
function renderKeepCards() {
  const list = $('generate-keep-list');
  if (!list) return;
  const filter = ($('generate-keep-filter')?.value || '').trim().toLowerCase();

  const rows = keepCards.filter((c) => !filter || c.name.toLowerCase().includes(filter)
    || c.typeLine.toLowerCase().includes(filter));

  list.innerHTML = rows.length === 0
    ? '<div class="generator-empty">No cards to show.</div>'
    : rows.map((c) => `
      <label class="generator-keep-tile${kept.has(c.cardId) ? ' is-kept' : ''}" data-card-id="${c.cardId}"
             title="${escapeHtml(c.typeLine)}">
        <span class="generator-keep-art">
          ${c.imageUrl
            ? `<img src="${escapeHtml(c.imageUrl)}" alt="" loading="lazy" />`
            : `<span class="generator-keep-noart">${escapeHtml(c.name)}</span>`}
          <input type="checkbox" class="generate-keep" value="${c.cardId}"
                 aria-label="Keep ${escapeHtml(c.name)}" ${kept.has(c.cardId) ? 'checked' : ''} />
          ${/* After the checkbox, never before: a label forwards its clicks to the
             first control inside it, and with the magnifier first a click on the
             tile opened the enlarged card instead of ticking it. */ ''}
          ${zoomButton(c.imageUrl, c.name)}
          <span class="generator-keep-badge">Kept</span>
        </span>
        <span class="generator-keep-name">${c.quantity > 1 ? `${c.quantity}&times; ` : ''}${escapeHtml(c.name)}</span>
      </label>`).join('');

  renderKeptSummary();
}

/** The kept cards, gathered above the grid, each one removable. */
function renderKeptSummary() {
  const chips = $('generate-keep-chips');
  if (chips) {
    const keptCards = keepCards.filter((c) => kept.has(c.cardId));
    chips.innerHTML = keptCards.length === 0
      ? '<span class="generator-note">Nothing kept yet — tick a card below.</span>'
      : `<span class="generator-keep-chips-label">Keeping:</span>${keptCards.map((c) => `
        <button type="button" class="generator-keep-chip" data-card-id="${c.cardId}"
                title="Stop keeping ${escapeHtml(c.name)}">${escapeHtml(c.name)} <span aria-hidden="true">&times;</span></button>`).join('')}`;
  }

  const head = $('generate-keep-group')?.querySelector('label');
  if (head) head.textContent = kept.size ? `Cards to keep (${kept.size})` : 'Cards to keep';
}

/**
 * Tick or untick one card. Updates the one tile and the chips in place, so
 * the grid does not re-render under the pointer or lose its scroll position.
 */
function setKept(cardId, on) {
  if (on) kept.add(cardId); else kept.delete(cardId);

  const tile = $('generate-keep-list')?.querySelector(`.generator-keep-tile[data-card-id="${cardId}"]`);
  if (tile) {
    tile.classList.toggle('is-kept', on);
    const box = tile.querySelector('.generate-keep');
    if (box) box.checked = on;
  }
  renderKeptSummary();
  resetResult();
  // Which themes the kept cards belong to has changed with them.
  loadThemes();
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

// The pull checklist's group order: WUBRG, then multicolour, then colourless,
// with lands broken out separately since they are already their own list.
const PULL_GROUPS = [
  { key: 'W', label: 'White' },
  { key: 'U', label: 'Blue' },
  { key: 'B', label: 'Black' },
  { key: 'R', label: 'Red' },
  { key: 'G', label: 'Green' },
  { key: 'gold', label: 'Multicolour' },
  { key: 'colorless', label: 'Colourless' },
];

/** Which pull group a card's colour identity belongs to. */
function pullGroupKey(colorIdentity) {
  const colors = String(colorIdentity || '').replace(/[^WUBRG]/g, '');
  if (colors.length === 0) return 'colorless';
  if (colors.length > 1) return 'gold';
  return colors;
}

/**
 * Which card was found, kept only for the life of this proposal. A pull
 * checklist is a physical-search aid, not deck data — nothing here is sent
 * anywhere, and a fresh Generate starts it empty again.
 */
let pulled = new Set();

/** Swaps (by index into proposal.revision.swaps) the person has unticked. */
let rejected = new Set();

/** A stable key for a proposal row, since neither name nor printing alone is unique. */
const pullKey = (c) => `${c.printingId ?? 'basic'}:${c.name}:${c.isFoil ? 'f' : 'n'}`;

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
    renderSplash();
    loadKeepCards();
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

  $('generate-keep-filter')?.addEventListener('input', renderKeepCards);
  $('generate-keep-list')?.addEventListener('change', (event) => {
    const box = event.target.closest('.generate-keep');
    if (!box) return;
    setKept(Number(box.value), box.checked);
  });

  $('generate-keep-chips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('.generator-keep-chip');
    if (!chip) return;
    setKept(Number(chip.dataset.cardId), false);
  });

  $('generate-revise-deck')?.addEventListener('change', async () => {
    resetResult();
    renderRevisionNote();
    renderSplash();
    loadKeepCards();
    await loadThemes();
  });

  document.querySelectorAll('.generate-splash').forEach((box) => {
    box.addEventListener('change', async () => {
      resetResult();
      await loadThemes();
    });
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
    const remove = event.target.closest('[data-remove-custom]');
    if (remove) {
      removeCustomTheme(remove.dataset.removeCustom);
      return;
    }
    const tile = event.target.closest('.generator-theme');
    if (!tile) return;
    toggleTheme(tile.dataset.themeKey || '');
    resetResult();
  });

  $('generate-save-plan')?.addEventListener('click', savePlan);
  $('generate-custom-add')?.addEventListener('click', addCustomTheme);
  for (const id of ['generate-custom-payoff', 'generate-custom-enabler']) {
    $(id)?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); addCustomTheme(); }
    });
  }

  $('generate-share')?.addEventListener('input', () => {
    renderShareNote();
    resetResult();
  });

  $('generate-run')?.addEventListener('click', run);
  $('generate-accept')?.addEventListener('click', accept);
}

function resetResult() {
  proposal = null;
  pulled = new Set();
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

const mainTheme = () => $('generate-theme')?.value || '';

/** The second theme's share of the theme slots, as a fraction. */
const secondShare = () => Number($('generate-share')?.value || 35) / 100;

/** Said in words, because "35%" of something unnamed means little. */
function renderShareNote() {
  const note = $('generate-share-note');
  if (!note) return;
  const pct = Math.round(secondShare() * 100);
  const words = pct <= 15 ? 'a few cards of it'
    : pct <= 25 ? 'about a fifth of the theme cards'
      : pct <= 40 ? 'about a third of the theme cards'
        : 'about as many as the main theme';
  note.textContent = `${pct}% — ${words}. Whatever it cannot fill goes back to the main theme.`;
}
const secondTheme = () => $('generate-theme-secondary')?.value || '';

/** Set both picks and redraw which tile is which. */
function selectThemes(main, second = '') {
  const m = main || '';
  // A second theme only means something beside a first, and never the same one.
  const s = m && second !== m ? (second || '') : '';
  if ($('generate-theme')) $('generate-theme').value = m;
  if ($('generate-theme-secondary')) $('generate-theme-secondary').value = s;
  // Only a second theme has a share to set.
  $('generate-share-group')?.classList.toggle('hidden', !s);
  renderShareNote();

  document.querySelectorAll('.generator-theme').forEach((tile) => {
    const key = tile.dataset.themeKey || '';
    const isMain = key === m;
    const isSecond = Boolean(s) && key === s;
    tile.classList.toggle('selected', isMain || isSecond);
    tile.classList.toggle('secondary', isSecond);
    tile.setAttribute('aria-pressed', isMain || isSecond ? 'true' : 'false');
    const badge = tile.querySelector('.generator-theme-pick');
    if (badge) {
      badge.textContent = isMain && key ? (s ? 'Main' : '') : isSecond ? 'Second' : '';
      badge.classList.toggle('hidden', !badge.textContent);
    }
  });
}

/**
 * A click on a theme tile. The first theme picked is the main one; a second
 * becomes the smaller share; picking a third replaces the second. Pressing a
 * chosen tile again takes it off, and the "let it choose" tile clears both.
 */
function toggleTheme(key) {
  const main = mainTheme();
  const second = secondTheme();
  if (!key) return selectThemes('');
  if (key === main) return selectThemes(second);
  if (key === second) return selectThemes(main);
  if (!main) return selectThemes(key);
  return selectThemes(main, key);
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
      splash: revising ? splashColors() : '',
      keepCardIds: revising ? [...kept] : [],
      customThemes: customKeys,
    });
    themes = data.themes || [];
    // The server's spelling of each custom key, which is what the tiles carry.
    customKeys = themes.filter((t) => t.custom).map((t) => t.key);
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
          ${theme.custom ? '<span class="generator-theme-custom-tag">yours</span>' : ''}
          <span class="generator-theme-pick hidden"></span>
          ${theme.custom ? `<span role="button" tabindex="0" class="generator-theme-remove"
                 data-remove-custom="${escapeHtml(theme.key)}" title="Remove this theme"
                 aria-label="Remove this theme">&times;</span>` : ''}
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
        ${theme.keptMatches && theme.keptMatches.length ? `
          <div class="generator-theme-kept">
            Fits ${theme.keptMatches.length} of the cards you are keeping:
            ${theme.keptMatches.slice(0, 4).map((n) => escapeHtml(n)).join(', ')}${theme.keptMatches.length > 4 ? '…' : ''}
          </div>` : ''}
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
  const offered = (key) => themes.some((t) => t.key === key);
  let main = offered(mainTheme()) ? mainTheme() : '';
  let second = offered(secondTheme()) ? secondTheme() : '';

  // A saved plan is applied once, when its deck is picked: it is the owner's
  // own earlier answer, so it beats any guess below.
  const deckId = revisingDeckId();
  if (deckPlan && deckId && planAppliedFor !== deckId && keepDeckId === deckId) {
    planAppliedFor = deckId;
    if (offered(deckPlan.themeKey)) {
      main = deckPlan.themeKey;
      second = offered(deckPlan.secondaryThemeKey) ? deckPlan.secondaryThemeKey : '';
    }
  }

  // Kept cards are a statement about what the deck is. When nothing has been
  // picked yet, the theme most of them belong to is picked for them — offered,
  // and one press away from being taken back.
  if (!main && !second && themes[0]?.keptMatches?.length) main = themes[0].key;
  if (!main) second = '';
  selectThemes(main, second);
  renderPlanNote();
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
      secondaryThemeKey: secondTheme() || null,
      secondaryShare: secondTheme() ? secondShare() : null,
      includeCommitted: includeCommitted(),
      identity: revising ? null : (chosenColors() || null),
      reviseDeckId: revisingDeckId(),
      splash: revising ? (splashColors() || null) : null,
      keepCardIds: revising ? [...kept] : [],
    });

    proposal = data.proposal;
    pulled = new Set();
    rejected = new Set();
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
        ${revision.keptCount} cards stay as they are${revision.kept?.length
          ? `, including the ${revision.kept.length} you chose to keep` : ''}. Saving keeps
        ${escapeHtml(revision.deckName)} exactly as it is and creates a separate deck
        from this proposal, so nothing is lost if you disagree with it.
      </div>
      ${revision.swaps ? renderSwaps(revision) : `
      <div class="generate-columns">
        <div>
          <div class="generate-head">Add (${revision.added.length})</div>
          <ul>${list(revision.added) || '<li>Nothing new.</li>'}</ul>
        </div>
        <div>
          <div class="generate-head">Cut (${revision.cut.length})</div>
          <ul>${list(revision.cut) || '<li>Nothing comes out.</li>'}</ul>
        </div>
      </div>`}
    </div>`;
}

/**
 * The revision as swaps, each one a decision of its own.
 *
 * A swap is ticked to take it. Unticking keeps the old card: the saved deck
 * gets the cut card back in place of the one that would have replaced it.
 * Nothing about the proposal itself changes, so the reasons and the list
 * below stay what the generator actually said.
 */
function renderSwaps(revision) {
  const line = (row) => `${row.quantity}&times; ${escapeHtml(row.name)}`;
  const swaps = revision.swaps.map((swap, i) => `
    <li class="generate-swap${rejected.has(i) ? ' is-rejected' : ''}">
      <label>
        <input type="checkbox" class="generate-swap-toggle" data-swap="${i}" ${rejected.has(i) ? '' : 'checked'} />
        <span class="generate-swap-cards">
          <span class="generate-swap-cut">${line(swap.cut)}</span>
          <span class="generate-swap-arrow" aria-label="replaced by">&rarr;</span>
          <span class="generate-swap-add">${escapeHtml(swap.add.name)}</span>
        </span>
      </label>
      <div class="generate-swap-why">${swap.why.map(escapeHtml).join(' · ')}</div>
    </li>`).join('');

  const rest = (rows, label) => rows.length ? `
    <div>
      <div class="generate-head">${label} (${rows.length})</div>
      <ul>${rows.map((row) => `<li>${line(row)}</li>`).join('')}</ul>
    </div>` : '';

  return `
    ${revision.swaps.length ? `
      <div class="generate-head">Swaps (${revision.swaps.length})</div>
      <div class="generate-note">Untick a swap to keep the card it would replace.</div>
      <ul class="generate-swaps">${swaps}</ul>` : ''}
    <div class="generate-columns">
      ${rest(revision.unpairedAdded || [], 'Also added')}
      ${rest(revision.unpairedCut || [], 'Also cut')}
    </div>`;
}

/**
 * The cards to save: the proposal, with every unticked swap undone — the
 * replacement taken back out, the original put back in its own printing.
 */
function cardsToSave(cards) {
  const swaps = proposal?.revision?.swaps || [];
  const out = cards.map((c) => ({ ...c }));
  for (const i of rejected) {
    const swap = swaps[i];
    if (!swap) continue;
    const row = out.find((c) => c.name === swap.add.name && c.quantity > 0);
    if (row) row.quantity -= swap.quantity;
    out.push({
      name: swap.cut.name, printingId: swap.cut.printingId, isFoil: swap.cut.isFoil, quantity: swap.quantity,
    });
  }
  return out.filter((c) => c.quantity > 0);
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

    ${p.secondaryTheme ? `
      <div class="generate-theme-note">
        <strong>With a share of ${escapeHtml(p.secondaryTheme.label)}</strong>
        — ${p.secondaryTheme.cards ?? 0} cards picked for it
        (asked for ${Math.round((p.secondaryTheme.share ?? 1 / 3) * 100)}% of the theme slots).<br>
        ${escapeHtml(p.secondaryTheme.blurb || '')}
        <span class="generate-theme-evidence">
          Your collection has ${p.secondaryTheme.enablers} ${escapeHtml(p.secondaryTheme.enablerName || 'enablers')}
          and ${p.secondaryTheme.payoffs} ${escapeHtml(p.secondaryTheme.payoffName || 'payoffs')} in these colours.
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

    ${renderPullChecklist(p)}

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
  wirePullChecklist();
  wireSwaps();
}

/**
 * The physical pull list: every card in the proposal, grouped by colour and
 * alphabetised within it, with art so it can be matched against a box of
 * cards rather than a spreadsheet. Lands come last as their own group,
 * because they are usually stored apart from spells.
 *
 * Ticking a row is a "found it" mark for this session only — it never
 * touches the deck or the collection, which is why `pulled` lives only in
 * memory and is cleared on every fresh Generate.
 */
function renderPullChecklist(p) {
  const rows = [
    ...p.mainboard.map((c) => ({ ...c, group: pullGroupKey(c.colorIdentity) })),
    ...p.lands.map((l) => ({ ...l, group: 'land' })),
  ];
  if (rows.length === 0) return '';

  const groups = [...PULL_GROUPS, { key: 'land', label: 'Lands' }]
    .map((g) => ({ ...g, rows: rows.filter((r) => r.group === g.key) }))
    .filter((g) => g.rows.length > 0);

  groups.forEach((g) => g.rows.sort((a, b) => a.name.localeCompare(b.name)));

  const totalCopies = rows.reduce((sum, r) => sum + (r.quantity || 1), 0);
  const foundCopies = rows.reduce(
    (sum, r) => sum + (pulled.has(pullKey(r)) ? (r.quantity || 1) : 0), 0,
  );

  const row = (c) => {
    const key = pullKey(c);
    const found = pulled.has(key);
    return `
      <li class="pull-row${found ? ' pull-row-found' : ''}">
        <label>
          <input type="checkbox" class="pull-check" data-pull-key="${escapeHtml(key)}" ${found ? 'checked' : ''} />
          <span class="pull-row-art">
            ${c.imageUrl
              ? `<img src="${escapeHtml(c.imageUrl)}" alt="${escapeHtml(c.name)}" loading="lazy" />`
              : ''}
          </span>
          <span class="pull-row-qty">${c.quantity || 1}&times;</span>
          <span class="pull-row-name">${escapeHtml(c.name)}</span>
          <span class="pull-row-cost">${escapeHtml(cost(c.manaCost))}</span>
        </label>
      </li>`;
  };

  return `
    <details class="generate-list pull-checklist" open>
      <summary>
        Pull checklist &mdash; <span id="pull-progress">${foundCopies} / ${totalCopies}</span> found
      </summary>
      <div class="generate-note">
        Tick a card off as you find it in your storage. This is just for finding the
        cards physically — it does not change the deck or your collection.
      </div>
      ${groups.map((g) => `
        <div class="pull-group">
          <div class="pull-group-head">${escapeHtml(g.label)} (${g.rows.length})</div>
          <ul class="pull-group-list">${g.rows.map(row).join('')}</ul>
        </div>
      `).join('')}
    </details>`;
}

function wireSwaps() {
  $('generate-result')?.querySelectorAll('.generate-swap-toggle').forEach((box) => {
    box.addEventListener('change', () => {
      const i = Number(box.dataset.swap);
      if (box.checked) rejected.delete(i);
      else rejected.add(i);
      box.closest('.generate-swap')?.classList.toggle('is-rejected', !box.checked);
    });
  });
}

function wirePullChecklist() {
  const list = $('generate-result');
  if (!list) return;

  list.querySelectorAll('.pull-check').forEach((box) => {
    box.addEventListener('change', () => {
      const key = box.dataset.pullKey;
      if (box.checked) pulled.add(key);
      else pulled.delete(key);
      box.closest('.pull-row')?.classList.toggle('pull-row-found', box.checked);
      updatePullProgress();
    });
  });
}

function updatePullProgress() {
  if (!proposal) return;
  const rows = [...proposal.mainboard, ...proposal.lands];
  const total = rows.reduce((sum, r) => sum + (r.quantity || 1), 0);
  const found = rows.reduce(
    (sum, r) => sum + (pulled.has(pullKey(r)) ? (r.quantity || 1) : 0), 0,
  );
  const progress = $('pull-progress');
  if (progress) progress.textContent = `${found} / ${total}`;
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
      cards: cardsToSave([
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
      ]),
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
