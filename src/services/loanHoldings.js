/**
 * SQL for what a user *holds* of a card, as opposed to what they own.
 *
 * Deliberately import-free, like deckPriority.js, so readiness and shopping
 * can both build on it without a dependency tangle.
 *
 * A live loan (active, or active with a return asked for) puts the copy in
 * the borrower's hands and out of the lender's. Ownership never moves — see
 * migration 041 — so every "owned" count that answers "can this deck be
 * played?" has to add this correction, or a borrowed card still reads as
 * missing and a lent one as sitting in the binder.
 *
 * Takes column expressions rather than binding `?`s, so it slots into the
 * existing correlated subqueries without reshuffling their parameter order.
 */

export const LIVE_LOAN_STATUSES = ['active', 'return_requested'];

const LIVE = `(${LIVE_LOAN_STATUSES.map((s) => `'${s}'`).join(',')})`;

/**
 * Borrowed minus lent copies of card `cardCol` for user `userCol`, at card
 * level (any printing, either finish) — the same looseness readiness and
 * shopping already use for owned copies.
 */
export function loanNetSql(userCol, cardCol) {
  return `(
    COALESCE((SELECT SUM(lb.quantity) FROM card_loans lb
               JOIN printings lb_p ON lb_p.uuid = lb.printing_uuid
              WHERE lb.borrower_user_id = ${userCol} AND lb_p.card_id = ${cardCol}
                AND lb.status IN ${LIVE}), 0)
    - COALESCE((SELECT SUM(ll.quantity) FROM card_loans ll
               JOIN printings ll_p ON ll_p.uuid = ll.printing_uuid
              WHERE ll.lender_user_id = ${userCol} AND ll_p.card_id = ${cardCol}
                AND ll.status IN ${LIVE}), 0)
  )`;
}
