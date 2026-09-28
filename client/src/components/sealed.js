import api from '../services/api.js';
import { showLoading, hideLoading, showToast, confirmDialog, debounce } from '../utils/ui.js';

/**
 * The Sealed page: boxes, bundles and packs, one row per lot (see migration
 * 046 — two boxes bought at different prices are two cost bases).
 *
 * Value per unit comes from, in order: the owner's override, a live TCGplayer
 * price when MTGJSON's feed carries one for the product, and the reference
 * price an import brought (dated). The source is shown next to the number so
 * a stale reference figure is never mistaken for today's market.
 */

let state = { lots: [], totals: null };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function sourceNote(lot) {
  switch (lot.value_source) {
    case 'override': return 'your price';
    case 'tcgplayer': return 'TCGplayer';
    case 'reference': return lot.reference_price_date ? `as of ${lot.reference_price_date}` : 'imported';
    default: return 'no price';
  }
}

function render() {
  const list = document.getElementById('sealed-list');
  const summary = document.getElementById('sealed-summary');
  const { lots, totals } = state;

  if (totals) {
    const gain = totals.cost ? totals.value - totals.cost : null;
    summary.innerHTML = `
      <div class="sealed-stat"><span>Items</span><strong>${totals.items}</strong></div>
      <div class="sealed-stat"><span>Cost</span><strong>${money(totals.cost)}</strong></div>
      <div class="sealed-stat"><span>Value</span><strong>${money(totals.value)}</strong></div>
      ${gain == null ? '' : `<div class="sealed-stat"><span>Gain</span><strong style="color:${gain >= 0 ? 'var(--success)' : 'var(--danger)'}">${gain >= 0 ? '+' : '−'}${money(Math.abs(gain))}</strong></div>`}
    `;
  }

  if (!lots.length) {
    list.innerHTML = `<div class="sealed-empty">No sealed product yet. Add a box, or import a CardCastle portfolio export.</div>`;
    return;
  }

  list.innerHTML = `
    <table class="sealed-table">
      <thead><tr>
        <th>Product</th><th class="num">Qty</th><th class="num">Cost ea</th>
        <th class="num">Value ea</th><th class="num">Total</th><th></th>
      </tr></thead>
      <tbody>
        ${lots.map((lot) => `
          <tr data-id="${lot.id}">
            <td>
              <div class="sealed-name">${escapeHtml(lot.name)}
                ${lot.sealed_uuid ? '' : '<span class="sealed-unlinked" title="Not matched to MTGJSON\'s catalog, so no live price">unlinked</span>'}
              </div>
              <div class="sealed-meta">${escapeHtml(lot.display_set_name || lot.set_code || '')}${lot.acquired_at ? ` · added ${escapeHtml(lot.acquired_at)}` : ''}${lot.notes ? ` · ${escapeHtml(lot.notes)}` : ''}
                ${lot.tcgplayer_url ? ` · <a href="${lot.tcgplayer_url}" target="_blank" rel="noopener">TCGplayer</a>` : ''}</div>
            </td>
            <td class="num"><input type="number" min="1" step="1" class="sealed-edit" data-field="quantity" value="${lot.quantity}"></td>
            <td class="num"><input type="number" min="0" step="0.01" class="sealed-edit" data-field="costPaid" value="${lot.cost_paid ?? ''}" placeholder="—"></td>
            <td class="num">
              <input type="number" min="0" step="0.01" class="sealed-edit" data-field="priceOverride" value="${lot.price_override ?? ''}" placeholder="${lot.unit_value != null && lot.value_source !== 'override' ? Number(lot.unit_value).toFixed(2) : '—'}" title="Leave blank to use the market price">
              <div class="sealed-source">${sourceNote(lot)}</div>
            </td>
            <td class="num">${money(lot.total_value)}</td>
            <td><button class="btn btn-secondary btn-sm sealed-delete" title="Remove this lot"><i class="ph ph-trash"></i></button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

async function load() {
  try {
    state = await api.getSealed();
    render();
  } catch (error) {
    showToast(`Could not load sealed product: ${error.message}`, 'error');
  }
}

async function saveField(input) {
  const id = Number(input.closest('tr').dataset.id);
  const raw = input.value.trim();
  const value = raw === '' ? null : Number(raw);
  if (input.dataset.field === 'quantity' && (!Number.isInteger(value) || value < 1)) {
    showToast('Quantity must be at least 1 — use the bin to remove a lot', 'error');
    return load();
  }
  try {
    await api.updateSealed(id, { [input.dataset.field]: value });
    await load();
  } catch (error) {
    showToast(error.message, 'error');
    load();
  }
}

async function removeLot(button) {
  const row = button.closest('tr');
  const lot = state.lots.find((l) => l.id === Number(row.dataset.id));
  const ok = await confirmDialog({
    title: 'Remove sealed lot',
    message: `Remove ${lot.quantity} × ${escapeHtml(lot.name)}?`,
    confirmText: 'Remove',
    danger: true,
  });
  if (!ok) return;
  await api.deleteSealed(lot.id);
  showToast('Removed', 'success');
  load();
}

async function searchCatalog(query) {
  const results = document.getElementById('sealed-catalog-results');
  if (query.trim().length < 2) { results.innerHTML = ''; return; }
  const { products } = await api.searchSealedCatalog(query);
  results.innerHTML = products.length
    ? products.map((p) => `
        <button type="button" class="sealed-catalog-option" data-uuid="${p.uuid}">
          <strong>${escapeHtml(p.name)}</strong>
          <span>${escapeHtml(p.set_name || p.set_code || '')}${p.release_date ? ` · ${escapeHtml(p.release_date)}` : ''}${p.live_price ? ` · ${money(p.live_price)}` : ''}</span>
        </button>`).join('')
    : `<div class="sealed-meta" style="padding:0.5rem;">Nothing in the catalog matches. You can still add it by name below.</div>`;
}

function readForm() {
  const form = document.getElementById('sealed-add-form');
  const get = (name) => form.elements[name].value.trim();
  return {
    sealedUuid: form.dataset.uuid || null,
    name: get('name') || undefined,
    quantity: Number(get('quantity') || 1),
    costPaid: get('costPaid') === '' ? null : Number(get('costPaid')),
    priceOverride: get('priceOverride') === '' ? null : Number(get('priceOverride')),
    notes: get('notes') || null,
    acquiredAt: get('acquiredAt') || null,
  };
}

function resetForm() {
  const form = document.getElementById('sealed-add-form');
  form.reset();
  delete form.dataset.uuid;
  document.getElementById('sealed-catalog-results').innerHTML = '';
  document.getElementById('sealed-picked').textContent = '';
}

async function importFile(file) {
  const csv = await file.text();
  showLoading();
  try {
    const result = await api.importSealedCsv(csv);
    const parts = [`Imported ${result.imported} lot${result.imported === 1 ? '' : 's'}`, `${result.matched} matched to the catalog`];
    if (result.skipped.length) parts.push(`${result.skipped.length} skipped (not Magic)`);
    showToast(parts.join(' · '), 'success', 6000);
    load();
  } catch (error) {
    showToast(`Import failed: ${error.message}`, 'error');
  } finally {
    hideLoading();
  }
}

export function setupSealed() {
  const page = document.getElementById('sealed-page');
  if (!page) return;

  page.addEventListener('change', (event) => {
    if (event.target.classList.contains('sealed-edit')) saveField(event.target);
  });
  page.addEventListener('click', (event) => {
    const del = event.target.closest('.sealed-delete');
    if (del) return removeLot(del);

    const option = event.target.closest('.sealed-catalog-option');
    if (option) {
      const form = document.getElementById('sealed-add-form');
      form.dataset.uuid = option.dataset.uuid;
      form.elements.name.value = option.querySelector('strong').textContent;
      document.getElementById('sealed-picked').textContent = 'Linked to the MTGJSON catalog';
      document.getElementById('sealed-catalog-results').innerHTML = '';
    }
  });

  const search = debounce((q) => searchCatalog(q).catch(() => {}), 250);
  document.getElementById('sealed-add-form').elements.name.addEventListener('input', (event) => {
    delete event.target.form.dataset.uuid;
    document.getElementById('sealed-picked').textContent = '';
    search(event.target.value);
  });

  document.getElementById('sealed-add-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.addSealed(readForm());
      showToast('Added', 'success');
      resetForm();
      load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  const fileInput = document.getElementById('sealed-import-file');
  document.getElementById('sealed-import-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) importFile(fileInput.files[0]);
    fileInput.value = '';
  });

  window.addEventListener('page:sealed', load);
}
