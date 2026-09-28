import api from '../services/api.js';
import { showLoading, hideLoading, showToast, confirmDialog } from '../utils/ui.js';

/**
 * "Import CardCastle" on the inventory page: a singles export, condition and
 * finish kept. The file is resolved once without writing so the confirmation
 * can say what is about to happen to a collection-sized file, then imported.
 */
function describeConditions(conditions) {
  return Object.entries(conditions)
    .map(([code, n]) => `${n} ${code === 'unrecorded' ? 'no condition' : code}`)
    .join(', ');
}

async function importFile(file) {
  const csv = await file.text();
  showLoading();
  let preview;
  try {
    preview = await api.importCardCastleSingles(csv, true);
  } catch (error) {
    hideLoading();
    showToast(`Could not read that file: ${error.message}`, 'error');
    return;
  }
  hideLoading();

  const lines = [
    `${preview.rows} cards in ${preview.lines} distinct lines (${describeConditions(preview.conditions)}).`,
  ];
  if (preview.byNameOnly.length) lines.push(`${preview.byNameOnly.length} could only be matched by name — the printing will be a guess.`);
  if (preview.unresolved.length) lines.push(`${preview.unresolved.length} rows could not be read and will be skipped.`);
  if (preview.nonEnglish) lines.push(`${preview.nonEnglish} are non-English; they import as the English printing.`);

  const ok = await confirmDialog({
    title: 'Import CardCastle collection',
    message: lines.join('<br>'),
    confirmText: `Add ${preview.rows} cards`,
    icon: 'ph-upload-simple',
  });
  if (!ok) return;

  showLoading();
  try {
    const result = await api.importCardCastleSingles(csv, false);
    const failed = result.failed ? ` · ${result.failed} failed` : '';
    showToast(`Added ${result.added} cards${failed}. Undo from the audit page if needed.`, result.failed ? 'error' : 'success', 7000);
    if (result.errors?.length) console.warn('CardCastle import errors', result.errors);
    window.dispatchEvent(new CustomEvent('page:inventory'));
  } catch (error) {
    showToast(`Import failed: ${error.message}`, 'error');
  } finally {
    hideLoading();
  }
}

export function setupCardCastleImport() {
  const button = document.getElementById('inventory-cardcastle-btn');
  const input = document.getElementById('inventory-cardcastle-file');
  if (!button || !input) return;

  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files[0]) importFile(input.files[0]);
    input.value = '';
  });
}
