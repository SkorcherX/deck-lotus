/**
 * "Mimic from my collection": rebuild the open deck — usually a list imported
 * from a deck site — out of cards you own, with a reason beside every
 * stand-in. Nothing is written until "Save as new deck", which goes through
 * the generator's accept path and so lands as an idea.
 */
import api from '../services/api.js';
import { showModal, hideModal, showToast, formatMana } from '../utils/ui.js';
import { savedPool, savePool, saveRaidChoice, raidDeckIds, raidDecksHtml } from './raidDecks.js';

let result = null;
// Every deck, for choosing which ones the mimic may take cards from.
let decks = [];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const qty = (n) => `<span class="mimic-qty">${n}×</span>`;
const nameCell = (c) => `${escapeHtml(c.name)} <span class="mimic-cost">${formatMana(c.manaCost || '')}</span>`;

function curveTable(curve) {
  const labels = ['0', '1', '2', '3', '4', '5', '6', '7+'];
  const max = Math.max(1, ...curve.original, ...curve.mimic);
  const bar = (n, cls) => `<div class="mimic-bar ${cls}" style="height:${Math.round((n / max) * 60)}px" title="${n}"></div>`;
  return `
    <div class="mimic-curve" aria-label="Mana curve, original against mimic">
      ${labels.map((label, i) => `
        <div class="mimic-curve-col">
          <div class="mimic-curve-bars">${bar(curve.original[i], 'is-original')}${bar(curve.mimic[i], 'is-mimic')}</div>
          <div class="mimic-curve-label">${label}</div>
          <div class="mimic-curve-label">${curve.original[i]}/${curve.mimic[i]}</div>
        </div>`).join('')}
    </div>
    <div class="mimic-legend"><span class="mimic-swatch is-original"></span>original <span class="mimic-swatch is-mimic"></span>mimic</div>`;
}

function roleTable(roles) {
  if (!roles.length) return '';
  return `
    <table class="mimic-table">
      <thead><tr><th>Job</th><th>Original</th><th>Mimic</th></tr></thead>
      <tbody>${roles.map((r) => `
        <tr class="${r.mimic < r.original ? 'is-short' : ''}">
          <td>${escapeHtml(r.label)}</td><td>${r.original}</td><td>${r.mimic}</td>
        </tr>`).join('')}</tbody>
    </table>`;
}

function render(m) {
  const s = m.summary;
  const commander = m.commander
    ? `<p class="mimic-note">Commander: <strong>${escapeHtml(m.commander.name)}</strong>
        ${m.commander.owned ? '— you own it.' : '— <span class="mimic-warn">not in your collection</span>; it is kept as listed because it sets the deck\'s colours.'}</p>`
    : '';
  const themes = m.deckThemes.length
    ? `<p class="mimic-note">Read as a <strong>${m.deckThemes.map((t) => escapeHtml(t.label)).join('</strong> and <strong>')}</strong> deck; stand-ins that serve that plan were preferred.</p>`
    : '';

  const standIns = m.standIns.map((x) => `
    <li class="mimic-swap ${x.match === 'loose' ? 'is-loose' : ''}">
      <div>${qty(x.quantity)}<strong>${nameCell(x.card)}</strong>
        <span class="mimic-for">for ${nameCell(x.for)}</span>
        ${x.match === 'loose' ? '<span class="mimic-tag">loose</span>' : ''}</div>
      <div class="mimic-why">${x.why.map(escapeHtml).join(' · ')}</div>
    </li>`).join('');

  const list = (rows) => rows.map((c) => `<li>${qty(c.quantity)}${nameCell(c)}</li>`).join('');

  const pool = savedPool('all');
  showModal(`Mimic: ${escapeHtml(m.deck.name)}`, `
    <div class="mimic">
      <p class="mimic-stats">
        <strong>${s.ownedCards}</strong> of ${s.originalCards} cards owned ·
        <strong>${s.closeStandIns}</strong> close stand-ins ·
        <strong>${s.standInCards - s.closeStandIns}</strong> loose ·
        <strong class="${s.missingCards ? 'mimic-warn' : ''}">${s.missingCards}</strong> with no stand-in
      </p>
      ${commander}${themes}
      <div class="mimic-option" role="radiogroup" aria-label="Cards to build from">
        ${[['free', 'Only cards no other deck is using'], ['picked', 'Also cards in decks I pick'], ['all', 'Also cards in all my other decks']]
          .map(([value, label]) => `<label><input type="radio" name="mimic-pool" value="${value}" ${pool === value ? 'checked' : ''}> ${label}</label>`).join('')}
        <div class="generator-raid-decks ${pool === 'picked' ? '' : 'hidden'}" id="mimic-raid-decks">
          ${raidDecksHtml(decks, escapeHtml, m.deck.id)}</div>
      </div>

      <h3>Mana curve</h3>${curveTable(s.curve)}
      <h3>Jobs the deck does</h3>${roleTable(s.roles)}

      ${m.standIns.length ? `<h3>Stand-ins (${s.standInCards})</h3><ul class="mimic-list">${standIns}</ul>` : ''}
      ${m.missing.length ? `<h3>No stand-in found (${s.missingCards})</h3>
        <p class="mimic-note">Nothing you own in these colours does a similar job closely enough. These are the cards to look for.</p>
        <ul class="mimic-list">${list(m.missing)}</ul>` : ''}
      <details><summary>Cards you already own (${s.ownedCards})</summary>
        <ul class="mimic-list">${list([...m.owned, ...m.basics])}</ul></details>

      <div class="mimic-save">
        <input type="text" id="mimic-name" class="input" value="${escapeHtml(`${m.deck.name} (mimic)`)}" aria-label="New deck name">
        <button id="mimic-save" class="btn btn-primary">Save as new deck</button>
      </div>
      <p class="mimic-note">Saved as an <em>idea</em>. The original deck is left as it is.</p>
    </div>`);

  document.querySelectorAll('input[name="mimic-pool"]').forEach((radio) => radio.addEventListener('change', () => {
    savePool(radio.value);
    run(m.deck.id);
  }));
  document.getElementById('mimic-raid-decks')?.addEventListener('change', (e) => {
    if (!e.target.matches('input[type="checkbox"]')) return;
    saveRaidChoice(e.target.value, e.target.checked);
    run(m.deck.id);
  });
  document.getElementById('mimic-save')?.addEventListener('click', save);
}

async function run(deckId) {
  try {
    // Mimic has always defaulted to using every deck, so it keeps that until
    // somebody picks otherwise on either screen.
    const pool = savedPool('all');
    if (pool === 'picked' && decks.length === 0) {
      decks = (await api.getRevisableDecks()).decks || [];
    }
    const { mimic } = await api.mimicDeck({
      deckId,
      includeCommitted: pool === 'all',
      releaseDeckIds: pool === 'picked' ? raidDeckIds(decks, deckId) : [],
    });
    result = mimic;
    render(mimic);
  } catch (error) {
    showToast(error.body?.error || error.message || 'Could not mimic this deck', 'error');
  }
}

async function save() {
  if (!result) return;
  const name = document.getElementById('mimic-name')?.value?.trim();
  if (!name) { showToast('Give the deck a name first', 'warning'); return; }
  const button = document.getElementById('mimic-save');
  button.disabled = true;

  const entry = (c, quantity) => ({ name: c.name, printingId: c.printingId, isFoil: c.isFoil, quantity });
  try {
    const saved = await api.acceptGeneratedDeck({
      name,
      format: result.deck.format || 'commander',
      commander: result.commander ? entry(result.commander, 1) : null,
      cards: [
        ...result.owned.map((c) => entry(c, c.quantity)),
        ...result.standIns.map((x) => entry(x.card, x.quantity)),
        ...result.basics.map((c) => entry(c, c.quantity)),
      ],
    });
    showToast(`Saved as an idea — ${saved.added} cards`, 'success');
    hideModal();
    window.dispatchEvent(new CustomEvent('decks:changed'));
  } catch (error) {
    showToast(error.body?.error || error.message || 'Could not save the deck', 'error');
  } finally {
    button.disabled = false;
  }
}

export function openMimic(deck) {
  if (!deck?.id) { showToast('Save the deck first', 'warning'); return; }
  run(deck.id);
}
