/**
 * The deck generator's modal: pick a commander, pick what to build around,
 * look at what came back, and decide.
 *
 * ── Why this shows so much ─────────────────────────────────────────────────
 *
 * Every card in the proposal was chosen by matching regular expressions
 * against English card text, and that will sometimes be wrong. A panel that
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

let proposal = null;
let commanders = [];

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const includeCommitted = () => Boolean($('generate-include-committed')?.checked);

const chosenFormat = () => $('generate-format')?.value || 'commander';
const isCommander = () => chosenFormat() === 'commander';

/** The colours ticked, as a bare identity string. */
const chosenColors = () => [...document.querySelectorAll('.generate-color:checked')]
  .map((box) => box.value).join('');

/**
 * Commander picks its colours from the commander; every other format has to be
 * told. Swapping which control is shown keeps the panel from asking for both.
 */
function applyFormat() {
  $('generate-commander-group')?.classList.toggle('hidden', !isCommander());
  $('generate-colors-group')?.classList.toggle('hidden', isCommander());
}

/** Mana symbols as plain text — the panel is dense enough without pips. */
const cost = (manaCost) => (manaCost || '').replace(/[{}]/g, ' ').trim();

export function setupDeckGenerator() {
  const openBtn = $('generate-deck-btn');
  const modal = $('generate-deck-modal');
  if (!openBtn || !modal) return;

  const close = () => modal.classList.add('hidden');

  openBtn.addEventListener('click', async () => {
    modal.classList.remove('hidden');
    resetResult();
    applyFormat();
    if (isCommander()) await loadCommanders();
    else await loadThemes();
  });

  $('generate-deck-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // Changing either input invalidates whatever is on screen: leaving a
  // proposal visible under a commander it was not built for is how somebody
  // saves the wrong deck.
  $('generate-commander')?.addEventListener('change', async () => {
    resetResult();
    await loadThemes();
  });

  $('generate-include-committed')?.addEventListener('change', async () => {
    resetResult();
    await loadCommanders();
  });

  $('generate-format')?.addEventListener('change', async () => {
    resetResult();
    applyFormat();
    if (isCommander()) await loadCommanders();
    else await loadThemes();
  });

  document.querySelectorAll('.generate-color').forEach((box) => {
    box.addEventListener('change', async () => {
      resetResult();
      await loadThemes();
    });
  });

  $('generate-theme')?.addEventListener('change', resetResult);
  $('generate-run')?.addEventListener('click', run);
  $('generate-accept')?.addEventListener('click', accept);
}

function resetResult() {
  proposal = null;
  const result = $('generate-result');
  if (result) { result.innerHTML = ''; result.classList.add('hidden'); }
  $('generate-accept-row')?.classList.add('hidden');
}

async function loadCommanders() {
  const select = $('generate-commander');
  if (!select) return;

  select.innerHTML = '<option>Loading…</option>';
  try {
    const data = await api.getGeneratorCommanders(includeCommitted());
    commanders = data.commanders || [];

    if (commanders.length === 0) {
      select.innerHTML = '<option value="">No commanders available</option>';
      $('generate-theme').innerHTML = '';
      return;
    }

    select.innerHTML = commanders.map((c) =>
      `<option value="${c.cardId}">${escapeHtml(c.name)} — ${escapeHtml(c.colorIdentity || 'colourless')}</option>`
    ).join('');

    await loadThemes();
  } catch (error) {
    console.error('Failed to load commanders:', error);
    select.innerHTML = '<option value="">Could not load commanders</option>';
  }
}

async function loadThemes() {
  const select = $('generate-theme');
  if (!select) return;

  const commanderCardId = isCommander() ? $('generate-commander')?.value : null;
  if (isCommander() && !commanderCardId) return;

  select.innerHTML = '<option>Loading…</option>';
  try {
    const data = await api.getGeneratorThemes(commanderCardId, includeCommitted(), {
      identity: chosenColors(),
      format: chosenFormat(),
    });
    const themes = data.themes || [];

    // "Let it choose" first, then the themes with their evidence in the label.
    // The numbers are the argument for the theme, so they belong where the
    // choice is made rather than behind a tooltip.
    const options = [`<option value="">Strongest theme in these colours</option>`];
    for (const theme of themes) {
      const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      const strength = `${plural(theme.enablers, 'enabler')} / ${plural(theme.payoffs, 'payoff')}`;
      const weak = theme.viable ? '' : ' — thin';
      options.push(
        `<option value="${escapeHtml(theme.key)}">${escapeHtml(theme.label)} (${strength})${weak}</option>`
      );
    }
    select.innerHTML = options.join('');
  } catch (error) {
    console.error('Failed to load themes:', error);
    select.innerHTML = '<option value="">Strongest theme in these colours</option>';
  }
}

async function run() {
  const commanderCardId = isCommander() ? $('generate-commander')?.value : null;

  if (isCommander() && !commanderCardId) {
    showToast('Pick a commander first', 'warning');
    return;
  }
  if (!isCommander() && !chosenColors()) {
    showToast('Pick at least one colour first', 'warning');
    return;
  }

  const button = $('generate-run');
  button.disabled = true;
  button.textContent = 'Generating…';

  try {
    const data = await api.generateDeck({
      commanderCardId: commanderCardId ? Number(commanderCardId) : null,
      format: chosenFormat(),
      themeKey: $('generate-theme')?.value || null,
      includeCommitted: includeCommitted(),
      identity: chosenColors() || null,
    });

    proposal = data.proposal;
    render(proposal);

    // Named after what it was built from, because a list of decks called
    // "Generated deck 3" is useless a week later.
    const name = $('generate-deck-name');
    if (name && !name.value) {
      const themeLabel = proposal.theme ? ` ${proposal.theme.label}` : '';
      const lead = proposal.commanderCard?.name
        || `${chosenFormat()} ${proposal.colorIdentity || ''}`.trim();
      name.value = `${lead}${themeLabel}`.slice(0, 80);
    }
  } catch (error) {
    console.error('Generate failed:', error);
    showError(error.body?.error || error.message || 'Could not generate a deck');
  } finally {
    button.disabled = false;
    button.textContent = 'Generate';
  }
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
    <div class="generate-summary">
      ${stat(p.summary.totalCards, 'cards')}
      ${stat(p.summary.lands, 'lands')}
      ${stat(p.summary.averageMv, 'avg cost')}
      ${Object.entries(roles).map(([code, n]) => stat(n, roleLabels[code] || code)).join('')}
    </div>

    ${p.theme ? `
      <div class="generate-theme-note">
        Built around <strong>${escapeHtml(p.theme.label)}</strong> —
        ${p.theme.enablers} enablers and ${p.theme.payoffs} payoffs in these colours.
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
      commanderCardId: isCommander() ? Number($('generate-commander')?.value) : null,
      format: chosenFormat(),
      themeKey: $('generate-theme')?.value || null,
      includeCommitted: includeCommitted(),
      identity: chosenColors() || null,
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

    $('generate-deck-modal')?.classList.add('hidden');
    window.dispatchEvent(new CustomEvent('decks:changed'));
  } catch (error) {
    console.error('Accept failed:', error);
    showError(error.body?.error || error.message || 'Could not save the deck');
  } finally {
    button.disabled = false;
  }
}
