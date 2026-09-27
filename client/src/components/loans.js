import api from '../services/api.js';
import { showLoading, hideLoading, showToast, confirmDialog } from '../utils/ui.js';

/**
 * The Loaned & Borrowed page.
 *
 * A loan never moves ownership — the card stays in the lender's collection —
 * so this page is the only place that says where a lent card physically is.
 * Borrowers see which of their own decks list each card; lenders never see
 * the borrower's decks (see loanService.js shapeLoan).
 */

let showClosed = false;

const STATUS_LABELS = {
  requested: 'Requested',
  active: 'On loan',
  return_requested: 'Return requested',
  returned: 'Returned',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

const OPEN = new Set(['requested', 'active', 'return_requested']);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function formatDay(value) {
  if (!value) return '';
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function statusLine(loan) {
  const who = escapeHtml(loan.counterpartyName);
  const lent = loan.role === 'lent';

  switch (loan.status) {
    case 'requested':
      return lent ? `${who} asked to borrow this` : `Waiting for ${who} to lend it`;
    case 'active':
      return lent ? `With ${who} since ${formatDay(loan.lentAt)}` : `From ${who} since ${formatDay(loan.lentAt)}`;
    case 'return_requested':
      return lent
        ? `You asked ${who} for it back on ${formatDay(loan.returnRequestedAt)}`
        : `<strong>${who} wants this back</strong> (asked ${formatDay(loan.returnRequestedAt)})`;
    default:
      return `${STATUS_LABELS[loan.status]} ${formatDay(loan.resolvedAt)}`;
  }
}

function actionButtons(loan) {
  const buttons = [];
  const btn = (action, label, cls = 'btn-secondary') =>
    `<button class="btn ${cls} btn-sm loan-action" data-id="${loan.id}" data-action="${action}">${label}</button>`;

  if (loan.canApprove) buttons.push(btn('approve', 'Lend it', 'btn-primary'));
  if (loan.canDecline) buttons.push(btn('decline', 'Decline'));
  if (loan.canCancel) buttons.push(btn('cancel', 'Cancel request'));
  if (loan.canRequestReturn) buttons.push(btn('request-return', 'Ask for it back', 'btn-primary'));
  if (loan.canMarkReturned) {
    buttons.push(btn('returned', loan.role === 'lent' ? 'I got it back' : 'Mark returned',
      loan.status === 'return_requested' && loan.role === 'borrowed' ? 'btn-primary' : 'btn-secondary'));
  }

  return buttons.join('');
}

function renderLoan(loan) {
  const decks = loan.decks.length
    ? `<div style="font-size:0.8rem;color:var(--text-secondary);">In your deck${loan.decks.length === 1 ? '' : 's'}:
         ${loan.decks.map((d) => escapeHtml(d.name)).join(', ')}</div>`
    : '';

  const needsYou = (loan.role === 'lent' && loan.status === 'requested')
    || (loan.role === 'borrowed' && loan.status === 'return_requested');

  return `
    <div class="card" style="display:flex;align-items:center;gap:0.75rem;padding:0.6rem 0.8rem;${needsYou ? 'border-color:var(--primary);' : ''}">
      ${loan.imageUrl
        ? `<img src="${escapeHtml(loan.imageUrl)}" alt="" loading="lazy" style="width:48px;border-radius:4px;" />`
        : ''}
      <div style="flex:1;min-width:0;">
        <div>
          ${loan.quantity}x <strong>${escapeHtml(loan.cardName)}</strong>
          <span style="color:var(--text-secondary);">${escapeHtml((loan.setCode || '').toUpperCase())} ${escapeHtml(loan.collectorNumber || '')}</span>
          ${loan.isFoil ? '<span style="color:var(--primary);font-size:0.75rem;">foil</span>' : ''}
          <span style="font-size:0.72rem;padding:0.05rem 0.4rem;border-radius:999px;background:var(--bg-tertiary);margin-left:0.25rem;">
            ${STATUS_LABELS[loan.status] || loan.status}
          </span>
        </div>
        <div style="font-size:0.85rem;">${statusLine(loan)}</div>
        ${decks}
        ${loan.note ? `<div style="font-size:0.8rem;color:var(--text-secondary);font-style:italic;">“${escapeHtml(loan.note)}”</div>` : ''}
      </div>
      <div style="display:flex;gap:0.35rem;flex-wrap:wrap;justify-content:flex-end;">${actionButtons(loan)}</div>
    </div>`;
}

function renderSection(containerId, loans, emptyText) {
  const container = document.getElementById(containerId);
  const shown = showClosed ? loans : loans.filter((l) => OPEN.has(l.status));

  container.innerHTML = shown.length
    ? shown.map(renderLoan).join('')
    : `<div style="color:var(--text-secondary);font-size:0.9rem;">${emptyText}</div>`;
}

async function loadLoans() {
  try {
    showLoading();
    const { lent, borrowed } = await api.getLoans();
    hideLoading();

    renderSection('loans-borrowed', borrowed, 'You are not borrowing anything.');
    renderSection('loans-lent', lent, 'Nothing of yours is out on loan.');
  } catch (error) {
    hideLoading();
    showToast(error.message, 'error');
  }
}

const CONFIRMS = {
  approve: {
    title: 'Lend this card?',
    message: 'It stays in your collection, but stops counting toward your own decks until it comes back.',
    confirmText: 'Lend it',
  },
  'request-return': {
    title: 'Ask for it back?',
    message: 'The borrower is told you want the card returned.',
    confirmText: 'Ask for it back',
  },
  returned: {
    title: 'Mark as returned?',
    message: 'The card counts toward the owner\'s decks again, and stops counting toward the borrower\'s.',
    confirmText: 'Returned',
  },
};

async function runAction(id, action) {
  const confirm = CONFIRMS[action];
  if (confirm && !(await confirmDialog(confirm))) return;

  try {
    showLoading();
    await api.loanAction(id, action);
    hideLoading();
    window.dispatchEvent(new CustomEvent('loans:changed'));
    await loadLoans();
  } catch (error) {
    hideLoading();
    showToast(error.message, 'error');
  }
}

export async function refreshLoanBadge() {
  const badge = document.getElementById('loan-action-badge');
  if (!badge) return;

  try {
    const { count } = await api.getLoanActionCount();
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  } catch {
    badge.classList.add('hidden');
  }
}

export function setupLoans() {
  const page = document.getElementById('loans-page');

  page.addEventListener('click', (event) => {
    const button = event.target.closest('.loan-action');
    if (button) runAction(Number(button.dataset.id), button.dataset.action);
  });

  document.getElementById('loans-show-closed').addEventListener('change', (event) => {
    showClosed = event.target.checked;
    loadLoans();
  });

  window.addEventListener('page:loans', loadLoans);
}
