import db from '../db/connection.js';
import { recordAudit, describeCounterparty, AUDIT_ACTIONS } from './auditService.js';
import { LIVE_LOAN_STATUSES, loanNetSql } from './loanHoldings.js';

/**
 * Lending cards between users of the same instance.
 *
 * A loan is the counterpart to a trade that moves *possession* but not
 * *ownership*. The lender's owned_printings row is never touched: the card is
 * still theirs, still in their collection, and still in the household total
 * exactly once. What a live loan changes is which decks can use the copy —
 * loanHoldings.js adds it to the borrower's hand and takes it out of the
 * lender's for readiness and shopping.
 *
 * Lifecycle, one row per card:
 *   requested        borrower asked; lender approves or declines
 *   active           the card is with the borrower
 *   return_requested the lender wants it back
 *   returned         either side confirmed it came home
 *   declined / cancelled  it never left
 *
 * Every card is keyed by printing uuid and finish, for the reasons in
 * migration 041 and CLAUDE.md's foil note.
 */

const LIVE = LIVE_LOAN_STATUSES.map((s) => `'${s}'`).join(',');

function describePrinting(printingId) {
  return db.get(
    `SELECT p.id, p.uuid, p.set_code, p.collector_number, c.name AS card_name
       FROM printings p JOIN cards c ON c.id = p.card_id
      WHERE p.id = ?`,
    [printingId]
  );
}

/** Copies of one printing and finish a user owns and has not already lent. */
export function lendableCopies(userId, printingUuid, isFoil) {
  const owned = db.get(
    `SELECT op.quantity FROM owned_printings op
       JOIN printings p ON p.id = op.printing_id
      WHERE op.user_id = ? AND p.uuid = ? AND op.is_foil = ?`,
    [userId, printingUuid, isFoil ? 1 : 0]
  )?.quantity || 0;

  return Math.max(0, owned - lentOutCopies(userId, printingUuid, isFoil));
}

/** Copies of one printing and finish currently out with somebody else. */
export function lentOutCopies(userId, printingUuid, isFoil) {
  return db.get(
    `SELECT COALESCE(SUM(quantity), 0) AS n FROM card_loans
      WHERE lender_user_id = ? AND printing_uuid = ? AND is_foil = ?
        AND status IN (${LIVE})`,
    [userId, printingUuid, isFoil ? 1 : 0]
  ).n;
}

function assertLendable(lenderId, printing, isFoil, quantity) {
  const free = lendableCopies(lenderId, printing.uuid, isFoil);

  if (free < quantity) {
    const finish = isFoil ? ' foil' : '';
    throw new Error(
      `Only ${free}${finish} cop${free === 1 ? 'y' : 'ies'} of ${printing.card_name}` +
      ` (${printing.set_code}) free to lend — the request asks for ${quantity}`
    );
  }
}

/** One audit row per party, so each side's history shows the loan. */
function logLoanEvent(loan, actorUserId, action, detail = {}) {
  for (const partyId of [loan.lender_user_id, loan.borrower_user_id]) {
    const other = partyId === loan.lender_user_id ? loan.borrower_user_id : loan.lender_user_id;
    recordAudit({
      userId: partyId,
      actorUserId,
      entityType: 'loan',
      action,
      source: 'loan',
      printingUuid: loan.printing_uuid,
      cardName: loan.card_name,
      isFoil: loan.is_foil === 1,
      detail: { loanId: loan.id, quantity: loan.quantity, counterparty: describeCounterparty(other), ...detail },
    });
  }
}

// ---------------------------------------------------------------------------
// Asking and answering
// ---------------------------------------------------------------------------

/**
 * Ask to borrow cards out of someone's collection. One loan row per card, so
 * each can be approved, returned and chased independently — a borrowed
 * playset rarely comes home all on the same night.
 */
export function requestLoans(borrowerId, lenderId, items, note = null) {
  const lender = db.get(`SELECT id, username FROM users WHERE id = ?`, [Number(lenderId)]);
  if (!lender) throw new Error('That user was not found');
  if (lender.id === Number(borrowerId)) throw new Error('You cannot borrow from yourself');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Pick at least one card to borrow');

  const rows = items.map((raw) => {
    const printingId = Number(raw.printingId);
    const quantity = Number(raw.quantity ?? 1);
    const isFoil = !!raw.isFoil;

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('Loan quantities must be whole numbers above zero');
    }

    const printing = describePrinting(printingId);
    if (!printing) throw new Error('Each loan needs a printing');

    assertLendable(lender.id, printing, isFoil, quantity);
    return { printing, isFoil, quantity };
  });

  const ids = db.transaction(() => rows.map(({ printing, isFoil, quantity }) => {
    const result = db.run(
      `INSERT INTO card_loans
         (lender_user_id, borrower_user_id, printing_uuid, is_foil, quantity, card_name, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [lender.id, borrowerId, printing.uuid, isFoil ? 1 : 0, quantity, printing.card_name, note || null]
    );
    const loan = loadLoan(result.lastInsertRowid);
    logLoanEvent(loan, borrowerId, AUDIT_ACTIONS.LOAN_REQUEST);
    return loan.id;
  }));

  return { lender, loans: ids.map((id) => getLoan(id, borrowerId)) };
}

function loadLoan(loanId) {
  return db.get(`SELECT * FROM card_loans WHERE id = ?`, [loanId]);
}

/** Load a loan and check the caller is the party this move belongs to. */
function loanFor(loanId, userId, role) {
  const loan = loadLoan(Number(loanId));
  if (!loan) throw new Error('Loan not found');

  const isLender = loan.lender_user_id === userId;
  const isBorrower = loan.borrower_user_id === userId;

  if (role === 'lender' && !isLender) throw new Error('Only the owner of the card can do that');
  if (role === 'borrower' && !isBorrower) throw new Error('Only the borrower can do that');
  if (role === 'either' && !isLender && !isBorrower) throw new Error('Loan not found');

  return loan;
}

function transition(loan, userId, from, to, action, extraSql = '', after = null) {
  if (!from.includes(loan.status)) {
    throw new Error(`This loan is already ${loan.status.replace('_', ' ')}`);
  }

  db.transaction(() => {
    db.run(`UPDATE card_loans SET status = ? ${extraSql} WHERE id = ?`, [to, loan.id]);
    logLoanEvent({ ...loan, status: to }, userId, action);
    if (after) after();
  });

  return getLoan(loan.id, userId);
}

/** The owner hands the card over. Checked again here: the collection may have changed. */
export function approveLoan(loanId, userId) {
  const loan = loanFor(loanId, userId, 'lender');
  if (loan.status !== 'requested') throw new Error(`This loan is already ${loan.status.replace('_', ' ')}`);

  const printing = db.get(
    `SELECT p.uuid, p.set_code, c.name AS card_name
       FROM printings p JOIN cards c ON c.id = p.card_id WHERE p.uuid = ?`,
    [loan.printing_uuid]
  );
  if (!printing) throw new Error('That printing no longer exists');
  assertLendable(userId, printing, loan.is_foil === 1, loan.quantity);

  return transition(loan, userId, ['requested'], 'active', AUDIT_ACTIONS.LOAN_APPROVE,
    ', lent_at = CURRENT_TIMESTAMP');
}

export function declineLoan(loanId, userId) {
  const loan = loanFor(loanId, userId, 'lender');
  return transition(loan, userId, ['requested'], 'declined', AUDIT_ACTIONS.LOAN_DECLINE,
    ', resolved_at = CURRENT_TIMESTAMP');
}

export function cancelLoan(loanId, userId) {
  const loan = loanFor(loanId, userId, 'borrower');
  return transition(loan, userId, ['requested'], 'cancelled', AUDIT_ACTIONS.LOAN_CANCEL,
    ', resolved_at = CURRENT_TIMESTAMP');
}

/** The owner wants their card back. Moves nothing — it asks. */
export function requestReturn(loanId, userId) {
  const loan = loanFor(loanId, userId, 'lender');
  return transition(loan, userId, ['active'], 'return_requested', AUDIT_ACTIONS.LOAN_RETURN_REQUEST,
    ', return_requested_at = CURRENT_TIMESTAMP');
}

/**
 * The card is home. Either side can say so: the borrower when they hand it
 * back, the lender when it turns up in their box and nobody clicked anything.
 * The borrower's decks go back to reading as short on their own — readiness
 * is derived, so there is nothing to edit.
 */
export function markReturned(loanId, userId) {
  const loan = loanFor(loanId, userId, 'either');
  return transition(loan, userId, LIVE_LOAN_STATUSES, 'returned', AUDIT_ACTIONS.LOAN_RETURN,
    ', resolved_at = CURRENT_TIMESTAMP', () => recordReturnDisruptions(loan));
}

/** Boards, in the order a shortfall eats them — same order as trades. */
const BOARD_ORDER = { maybeboard: 0, sideboard: 1, mainboard: 2 };
const BOARD = `COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END)`;

/**
 * The borrower's decks left short now the card has gone home, written as
 * deck_card_disruptions exactly as a trade would. Run inside the return's
 * transaction, after the status change, so the held count already excludes
 * this loan.
 *
 * Card level, like readiness: another printing the borrower owns fills the
 * slot, so only the true shortfall is charged — and never more than the loan
 * itself took away. Charged least-recently-updated deck first, maybeboard
 * before sideboard before mainboard, the rule allocateShortfall uses for
 * trades. Basic lands are never lent in any sense that matters, but the loan
 * rules do not exempt them, so neither does this.
 */
function recordReturnDisruptions(loan) {
  const card = db.get(`SELECT card_id FROM printings WHERE uuid = ?`, [loan.printing_uuid]);
  if (!card) return;

  const userId = loan.borrower_user_id;

  const held = db.get(
    `SELECT MAX(0,
        (SELECT COALESCE(SUM(op.quantity), 0) FROM owned_printings op
           JOIN printings op_p ON op_p.id = op.printing_id
          WHERE op.user_id = u.id AND op_p.card_id = ?)
        + ${loanNetSql('u.id', '?')}) AS n
       FROM users u WHERE u.id = ?`,
    [card.card_id, card.card_id, card.card_id, userId]
  ).n;

  const rows = db.all(
    `SELECT dc.printing_id, dc.is_foil, dc.quantity, ${BOARD} AS board_type,
            d.id AS deck_id, d.updated_at
       FROM deck_cards dc
       JOIN decks d ON d.id = dc.deck_id
       JOIN printings p ON p.id = dc.printing_id
      WHERE d.user_id = ? AND p.card_id = ?`,
    [userId, card.card_id]
  );

  const committed = rows.reduce((sum, r) => sum + r.quantity, 0);
  let left = Math.min(loan.quantity, Math.max(0, committed - held));
  if (left === 0) return;

  rows.sort((a, b) => {
    if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? -1 : 1;
    return BOARD_ORDER[a.board_type] - BOARD_ORDER[b.board_type];
  });

  for (const row of rows) {
    if (left <= 0) break;
    const take = Math.min(left, row.quantity);
    left -= take;

    db.run(
      `INSERT INTO deck_card_disruptions
         (deck_id, loan_id, printing_id, is_foil, board_type, quantity, card_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.deck_id, loan.id, row.printing_id, row.is_foil, row.board_type, take, loan.card_name]
    );
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const LOAN_SELECT = `
  SELECT l.*, lu.username AS lender_username, bu.username AS borrower_username,
         p.id AS printing_id, p.set_code, p.collector_number, p.image_url, p.card_id
    FROM card_loans l
    JOIN users lu ON lu.id = l.lender_user_id
    JOIN users bu ON bu.id = l.borrower_user_id
    LEFT JOIN printings p ON p.uuid = l.printing_uuid
`;

/**
 * A loan as one party sees it.
 *
 * `decks` — which of the viewer's decks list the card — is only ever filled
 * in for the borrower. The lender does not get to see where their card went
 * into the borrower's decks: that is the same deck-membership leak the
 * partner-browse rules in CLAUDE.md exist to prevent.
 */
function shapeLoan(row, userId, decks = []) {
  const viewerIsLender = row.lender_user_id === userId;
  const live = LIVE_LOAN_STATUSES.includes(row.status);

  return {
    id: row.id,
    status: row.status,
    role: viewerIsLender ? 'lent' : 'borrowed',
    counterpartyName: viewerIsLender ? row.borrower_username : row.lender_username,
    lenderUsername: row.lender_username,
    borrowerUsername: row.borrower_username,
    cardName: row.card_name,
    printingId: row.printing_id,
    setCode: row.set_code,
    collectorNumber: row.collector_number,
    imageUrl: row.image_url,
    isFoil: row.is_foil === 1,
    quantity: row.quantity,
    note: row.note,
    createdAt: row.created_at,
    lentAt: row.lent_at,
    returnRequestedAt: row.return_requested_at,
    resolvedAt: row.resolved_at,
    decks: viewerIsLender ? [] : decks,
    canApprove: viewerIsLender && row.status === 'requested',
    canDecline: viewerIsLender && row.status === 'requested',
    canCancel: !viewerIsLender && row.status === 'requested',
    canRequestReturn: viewerIsLender && row.status === 'active',
    canMarkReturned: live,
  };
}

/** The borrower's own decks listing each card, for "this is in your X deck". */
function borrowerDecks(userId, cardIds) {
  if (cardIds.length === 0) return new Map();

  const rows = db.all(
    `SELECT DISTINCT p.card_id, d.id AS deck_id, d.name AS deck_name
       FROM deck_cards dc
       JOIN decks d ON d.id = dc.deck_id
       JOIN printings p ON p.id = dc.printing_id
      WHERE d.user_id = ? AND p.card_id IN (${cardIds.map(() => '?').join(',')})
      ORDER BY d.name COLLATE NOCASE`,
    [userId, ...cardIds]
  );

  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.card_id)) out.set(r.card_id, []);
    out.get(r.card_id).push({ id: r.deck_id, name: r.deck_name });
  }
  return out;
}

export function getLoan(loanId, userId) {
  const row = db.get(`${LOAN_SELECT} WHERE l.id = ?`, [loanId]);
  if (!row || (row.lender_user_id !== userId && row.borrower_user_id !== userId)) return null;

  const decks = row.borrower_user_id === userId && row.card_id
    ? borrowerDecks(userId, [row.card_id]).get(row.card_id) || []
    : [];
  return shapeLoan(row, userId, decks);
}

/** Everything lent and borrowed, newest first, split by which side the viewer is on. */
export function listLoans(userId) {
  const rows = db.all(
    `${LOAN_SELECT}
      WHERE l.lender_user_id = ? OR l.borrower_user_id = ?
      ORDER BY l.created_at DESC, l.id DESC`,
    [userId, userId]
  );

  const borrowedCardIds = [...new Set(
    rows.filter((r) => r.borrower_user_id === userId && r.card_id).map((r) => r.card_id)
  )];
  const decks = borrowerDecks(userId, borrowedCardIds);

  const shaped = rows.map((r) => shapeLoan(r, userId, decks.get(r.card_id) || []));

  return {
    lent: shaped.filter((l) => l.role === 'lent'),
    borrowed: shaped.filter((l) => l.role === 'borrowed'),
  };
}

/**
 * Loans waiting on this user: requests to approve, and cards their owner has
 * asked to have back. Drives the nav badge.
 */
export function countLoanActions(userId) {
  return db.get(
    `SELECT COUNT(*) AS n FROM card_loans
      WHERE (lender_user_id = ? AND status = 'requested')
         OR (borrower_user_id = ? AND status = 'return_requested')`,
    [userId, userId]
  ).n;
}
