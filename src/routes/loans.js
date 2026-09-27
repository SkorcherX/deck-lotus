import express from 'express';
import {
  listLoans,
  requestLoans,
  approveLoan,
  declineLoan,
  cancelLoan,
  requestReturn,
  markReturned,
  countLoanActions,
} from '../services/loanService.js';
import { authenticate } from '../middleware/auth.js';
import { sendLoanRequested, sendLoanReturnRequested } from '../services/notificationService.js';

const router = express.Router();

/** Service errors are things a user got wrong, written to be shown as-is. */
function badRequest(res, error) {
  res.status(400).json({ error: error.message });
}

/** GET /api/loans — everything lent and borrowed, split by side. */
router.get('/', authenticate, (req, res, next) => {
  try {
    res.json(listLoans(req.user.id));
  } catch (error) {
    next(error);
  }
});

/** GET /api/loans/action-count — badge: requests to answer, returns asked of you. */
router.get('/action-count', authenticate, (req, res, next) => {
  try {
    res.json({ count: countLoanActions(req.user.id) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/loans/request — ask to borrow cards from `lenderId`'s collection. */
router.post('/request', authenticate, async (req, res) => {
  try {
    const { lenderId, items, note } = req.body || {};
    if (!lenderId) return res.status(400).json({ error: 'Who are you borrowing from?' });

    const result = requestLoans(req.user.id, parseInt(lenderId, 10), items, note);

    // Best effort, same as trades: a failed push must not undo a recorded request.
    await sendLoanRequested(req.user.username, result.loans).catch((error) => {
      console.warn('Loan notification failed:', error.message);
    });

    res.status(201).json(result);
  } catch (error) {
    badRequest(res, error);
  }
});

const ACTIONS = {
  approve: approveLoan,
  decline: declineLoan,
  cancel: cancelLoan,
  'request-return': requestReturn,
  returned: markReturned,
};

/** POST /api/loans/:id/:action — approve, decline, cancel, request-return, returned. */
router.post('/:id/:action', authenticate, async (req, res) => {
  const handler = ACTIONS[req.params.action];
  if (!handler) return res.status(404).json({ error: 'Unknown loan action' });

  try {
    const loan = handler(parseInt(req.params.id, 10), req.user.id);

    if (req.params.action === 'request-return') {
      await sendLoanReturnRequested(loan).catch((error) => {
        console.warn('Loan notification failed:', error.message);
      });
    }

    res.json(loan);
  } catch (error) {
    badRequest(res, error);
  }
});

export default router;
