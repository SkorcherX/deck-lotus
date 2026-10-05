/**
 * "Mimic from my collection": rebuild the open deck — usually a list imported
 * from a deck site — out of cards you own, with a reason beside every
 * stand-in. Nothing is written until "Save as new deck", which goes through
 * the generator's accept path and so lands as an idea.
 */
import api from '../services/api.js';
import { showModal, hideModal, showToast, formatMana } from '../utils/ui.js';

let result = null;

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

  showModal(`Mimic: ${escapeHtml(m.deck.name)}`, `
    <div class="mimic">
      <p class="mimic-stats">
        <strong>${s.ownedCards}</strong> of ${s.originalCards} cards owned ·
        <strong>${s.closeStandIns}</strong> close stand-ins ·
        <strong>${s.standInCards - s.closeStandIns}</strong> loose ·
        <strong class="${s.missingCards ? 'mimic-warn' : ''}">${s.missingCards}</strong> with no stand-in
      </p>
      ${commander}${themes}
      <label class="mimic-option"><input type="checkbox" id="mimic-committed" ${m.pool.includeCommitted ? 'checked' : ''}>
        Use cards that are in my other decks</label>

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

  document.getElementById('mimic-committed')?.addEventListener('change', (e) => run(m.deck.id, e.target.checked));
  document.getElementById('mimic-save')?.addEventListener('click', save);
}

async function run(deckId, includeCommitted = true) {
  try {
    const { mimic } = await api.mimicDeck({ deckId, includeCommitted });
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
  run(deck.id, true);
}
