/**
 * The pull list: a full-screen checklist for taking a deck's cards out of
 * physical storage, grouped the way the storage is arranged (see
 * src/shared/pullLayout.js) so the shelves are walked once, front to back.
 *
 * The card image is the largest thing on each row on purpose — art is
 * recognised faster than a name is read — and tapping it opens the full-size
 * zoom. Ticks are saved as they are made, so a pull can be stopped and picked
 * up later on another device. Nothing here changes the deck or the collection.
 */
import api from '../services/api.js';
import { showToast, formatMana } from '../utils/ui.js';
import { showCardZoom } from '../utils/cardZoom.js';
import {
  groupPullRows, normalizeLayout, SECTIONS, RARITIES, DEFAULT_PULL_LAYOUT,
} from '../../../src/shared/pullLayout.js';

const OVERLAY_ID = 'pull-list-overlay';
const HIDE_KEY = 'pullList.hidePulled';

let state = null; // { deck, layout, cards, basics, hidePulled }

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function readHide() {
  try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; }
}
function writeHide(on) {
  try { localStorage.setItem(HIDE_KEY, on ? '1' : '0'); } catch { /* per-viewer nicety only */ }
}

const COLOR_VAR = { W: '--mana-w', U: '--mana-u', B: '--mana-b', R: '--mana-r', G: '--mana-g' };

/** The coloured stripe down a row's edge: the card's colours, side by side. */
function stripe(card) {
  const colors = [...new Set(String(card.colors || '').toUpperCase().replace(/[^WUBRG]/g, ''))];
  if (colors.length === 0) return 'var(--mana-colorless-a)';
  if (colors.length === 1) return `var(${COLOR_VAR[colors[0]]})`;
  const step = 100 / colors.length;
  return `linear-gradient(to bottom, ${colors.map((c, i) => `var(${COLOR_VAR[c]}) ${i * step}% ${(i + 1) * step}%`).join(', ')})`;
}

function mainTypeLabel(typeLine) {
  const front = String(typeLine || '').split('//')[0].split('—')[0].trim();
  return front.replace(/^(Legendary|Basic|Snow|World|Tribal|Kindred)\s+/gi, '') || 'Card';
}

const totals = () => state.cards.reduce((acc, c) => {
  acc.need += c.quantity;
  acc.pulled += Math.min(c.pulled, c.quantity);
  return acc;
}, { need: 0, pulled: 0 });

function copyBoxes(card) {
  // One box per copy: a playset pulled two at a time shows as half done,
  // rather than all-or-nothing.
  return Array.from({ length: card.quantity }, (_, i) => `
    <button type="button" class="pull-copy ${i < card.pulled ? 'is-pulled' : ''}"
      data-key="${escapeHtml(card.key)}" data-copy="${i + 1}"
      aria-pressed="${i < card.pulled}" aria-label="Copy ${i + 1} of ${card.quantity} pulled">
      <i class="ph ${i < card.pulled ? 'ph-check-square' : 'ph-square'}" aria-hidden="true"></i>
    </button>`).join('');
}

function cardRow(card) {
  const done = card.pulled >= card.quantity;
  const conditions = card.conditions.filter((c) => c.condition).map((c) => `${c.quantity}× ${c.condition}`).join(', ');
  const rarity = String(card.rarity || '').toLowerCase();
  return `
    <li class="pull-card ${done ? 'is-done' : ''}" data-key="${escapeHtml(card.key)}" style="--pull-stripe:${stripe(card)}">
      <button type="button" class="pull-card-art" data-zoom="${escapeHtml(card.key)}" aria-label="Enlarge ${escapeHtml(card.name)}">
        ${card.imageUrl
          ? `<img src="${escapeHtml(card.imageUrl)}" alt="${escapeHtml(card.name)}" loading="lazy">`
          : `<span class="pull-card-noart">${escapeHtml(card.name)}</span>`}
      </button>
      <div class="pull-card-info">
        <div class="pull-card-name">
          <span class="pull-card-qty">${card.quantity}×</span> ${escapeHtml(card.name)}
          <span class="pull-card-cost">${formatMana(card.manaCost || '')}</span>
        </div>
        <div class="pull-badges">
          <span class="pull-badge">${escapeHtml(mainTypeLabel(card.typeLine))}</span>
          <span class="pull-badge pull-rarity rarity-${escapeHtml(rarity)}">${escapeHtml(rarity || 'unknown')}</span>
          ${card.isFoil ? '<span class="pull-badge pull-foil">✦ Foil</span>' : ''}
          ${card.isCommander ? '<span class="pull-badge">Commander</span>' : ''}
          ${card.inSideboard ? '<span class="pull-badge">Sideboard</span>' : ''}
        </div>
        <div class="pull-card-print">
          <i class="ss ss-${escapeHtml(String(card.keyrune || '').toLowerCase())} pull-set-${escapeHtml(rarity)}" aria-hidden="true"></i>
          ${escapeHtml(card.setName)} · ${escapeHtml(String(card.setCode || '').toUpperCase())} #${escapeHtml(card.collectorNumber)}
          ${conditions ? ` · ${escapeHtml(conditions)}` : ''}
        </div>
        ${card.alsoIn.length ? `<div class="pull-card-note"><i class="ph ph-stack" aria-hidden="true"></i>
          Also in ${card.alsoIn.map((d) => `<strong>${escapeHtml(d.name)}</strong> (${escapeHtml(d.status)})`).join(', ')}</div>` : ''}
        ${card.missing ? `<div class="pull-card-note is-warn"><i class="ph ph-warning" aria-hidden="true"></i>
          ${card.missing} ${card.missing === 1 ? 'copy is' : 'copies are'} not in your collection</div>` : ''}
        <div class="pull-copies">${copyBoxes(card)}</div>
      </div>
    </li>`;
}

function layoutEditor() {
  const { splitByType } = state.layout;
  return `
    <details class="pull-layout-editor">
      <summary><i class="ph ph-sliders-horizontal" aria-hidden="true"></i> How my storage is sorted</summary>
      <p class="pull-hint">Every section is sorted by rarity. Tick the rarities that you also split by card type.</p>
      <table class="pull-layout-table">
        <thead><tr><th></th>${RARITIES.filter((r) => r.key !== 'special').map((r) => `<th>${r.label}</th>`).join('')}</tr></thead>
        <tbody>${SECTIONS.map((s) => `
          <tr><th>${s.label}</th>${RARITIES.filter((r) => r.key !== 'special').map((r) => `
            <td><input type="checkbox" class="pull-split" data-section="${s.key}" data-rarity="${r.key}"
              aria-label="${s.label} ${r.label} split by type" ${(splitByType[s.key] || []).includes(r.key) ? 'checked' : ''}></td>`).join('')}
          </tr>`).join('')}</tbody>
      </table>
      <button type="button" class="btn btn-secondary btn-sm" id="pull-layout-default">Reset to default</button>
    </details>`;
}

function render() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  const scroll = overlay.querySelector('.pull-body')?.scrollTop || 0;
  const t = totals();
  const pct = t.need ? Math.round((t.pulled / t.need) * 100) : 0;

  const visible = state.hidePulled ? state.cards.filter((c) => c.pulled < c.quantity) : state.cards;
  const piles = groupPullRows(visible, state.layout);
  const cantPull = state.cards.filter((c) => c.missing > 0);

  overlay.innerHTML = `
    <div class="pull-shell">
      <header class="pull-header">
        <div class="pull-title">
          <h2>Pull list · ${escapeHtml(state.deck.name)}</h2>
          <button type="button" class="btn btn-secondary" id="pull-close"><i class="ph ph-x" aria-hidden="true"></i> Close</button>
        </div>
        <div class="pull-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${t.need}" aria-valuenow="${t.pulled}">
          <div class="pull-progress-fill" style="width:${pct}%"></div>
          <span>${t.pulled} / ${t.need} pulled</span>
        </div>
        <div class="pull-tools">
          <label><input type="checkbox" id="pull-hide" ${state.hidePulled ? 'checked' : ''}> Hide pulled</label>
          <button type="button" class="btn btn-secondary btn-sm" id="pull-print"><i class="ph ph-printer" aria-hidden="true"></i> Print</button>
          <button type="button" class="btn btn-secondary btn-sm" id="pull-reset"><i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i> Start over</button>
        </div>
        ${layoutEditor()}
      </header>
      <div class="pull-body">
        ${piles.length === 0 ? `<p class="pull-hint pull-empty">${state.cards.length ? 'Everything is pulled.' : 'This deck has no cards to pull.'}</p>` : ''}
        ${piles.map((pile) => `
          <section class="pull-pile">
            <h3 class="pull-pile-head">${escapeHtml(pile.label)} <span>(${pile.rows.reduce((s, r) => s + r.quantity, 0)})</span></h3>
            <ul class="pull-cards">${pile.rows.map(cardRow).join('')}</ul>
          </section>`).join('')}
        ${state.basics.length ? `
          <section class="pull-pile">
            <h3 class="pull-pile-head">Basic lands</h3>
            <p class="pull-basics">${state.basics.map((b) => `${b.quantity} ${escapeHtml(b.name)}`).join(' · ')}</p>
          </section>` : ''}
        ${cantPull.length ? `
          <section class="pull-pile">
            <h3 class="pull-pile-head is-warn">Not in your collection (${cantPull.reduce((s, c) => s + c.missing, 0)})</h3>
            <p class="pull-hint">These are listed in the deck but you don't own enough copies. They stay in the list above so they can be ticked once you have them.</p>
            <ul class="pull-basics">${cantPull.map((c) => `<li>${c.missing}× ${escapeHtml(c.name)}</li>`).join('')}</ul>
          </section>` : ''}
      </div>
    </div>`;

  overlay.querySelector('.pull-body').scrollTop = scroll;
  wire(overlay);
}

async function savePulled(card, pulled) {
  const before = card.pulled;
  card.pulled = pulled;
  render();
  try {
    await api.setPullProgress(state.deck.id, { uuid: card.uuid, isFoil: card.isFoil, pulled });
  } catch (error) {
    card.pulled = before;
    render();
    showToast(error.body?.error || 'Could not save that tick', 'error');
  }
}

async function saveLayout(layout) {
  state.layout = normalizeLayout(layout);
  render();
  try {
    await api.savePullLayout(state.layout);
  } catch (error) {
    showToast(error.body?.error || 'Could not save the layout', 'error');
  }
}

function wire(overlay) {
  overlay.querySelector('#pull-close').addEventListener('click', close);
  overlay.querySelector('#pull-hide').addEventListener('change', (e) => {
    state.hidePulled = e.target.checked;
    writeHide(state.hidePulled);
    render();
  });
  overlay.querySelector('#pull-print').addEventListener('click', () => window.print());
  overlay.querySelector('#pull-reset').addEventListener('click', async () => {
    if (!window.confirm('Untick every card in this pull list?')) return;
    try {
      await api.resetPullProgress(state.deck.id);
      state.cards.forEach((c) => { c.pulled = 0; });
      render();
    } catch (error) {
      showToast(error.body?.error || 'Could not reset', 'error');
    }
  });

  overlay.querySelectorAll('.pull-copy').forEach((btn) => btn.addEventListener('click', () => {
    const card = state.cards.find((c) => c.key === btn.dataset.key);
    const copy = Number(btn.dataset.copy);
    // Tapping the last ticked box unticks it; any other box ticks up to it.
    savePulled(card, card.pulled === copy ? copy - 1 : copy);
  }));

  overlay.querySelectorAll('.pull-card-art').forEach((btn) => btn.addEventListener('click', () => {
    const card = state.cards.find((c) => c.key === btn.dataset.zoom);
    if (card?.imageUrl) showCardZoom(card.imageUrl, card.name);
  }));

  overlay.querySelectorAll('.pull-split').forEach((box) => box.addEventListener('change', () => {
    const next = normalizeLayout(state.layout);
    const list = new Set(next.splitByType[box.dataset.section]);
    if (box.checked) list.add(box.dataset.rarity);
    else list.delete(box.dataset.rarity);
    next.splitByType[box.dataset.section] = [...list];
    saveLayout(next);
  }));
  overlay.querySelector('#pull-layout-default').addEventListener('click', () => saveLayout(DEFAULT_PULL_LAYOUT));
}

function onKey(e) {
  if (e.key === 'Escape' && !document.querySelector('.card-zoom-modal')) close();
}

function close() {
  document.getElementById(OVERLAY_ID)?.remove();
  document.body.classList.remove('pull-list-open');
  document.removeEventListener('keydown', onKey);
  state = null;
}

export async function openPullList(deck) {
  if (!deck?.id) { showToast('Save the deck first', 'warning'); return; }
  close();
  try {
    const data = await api.getPullList(deck.id);
    state = { ...data, layout: normalizeLayout(data.layout), hidePulled: readHide() };
  } catch (error) {
    showToast(error.body?.error || 'Could not load the pull list', 'error');
    return;
  }
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'pull-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Pull list');
  document.body.appendChild(overlay);
  document.body.classList.add('pull-list-open');
  document.addEventListener('keydown', onKey);
  render();
}
