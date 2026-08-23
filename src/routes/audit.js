import express from 'express';
import { listAuditEntries, getAuditFilterOptions } from '../services/auditService.js';
import { authenticate } from '../middleware/auth.js';
import db from '../db/connection.js';

const router = express.Router();

/**
 * Which users' history the caller is allowed to read.
 *
 * A regular user sees their own and nothing else. An admin may ask for
 * another user's, or for everybody's, because somebody has to be able to find
 * a bad import made by whoever in the household made it.
 *
 * This is deliberately the only place the scope is decided. Taking user ids
 * from the query without this check would let anyone read anyone's collection
 * history — which, for a household that trades, is the same information the
 * partner-browse rules go out of their way not to reveal.
 */
function resolveScope(req) {
  const isAdmin = req.user.is_admin === true || req.user.is_admin === 1;
  const requested = req.query.userId;

  if (!isAdmin) {
    return [req.user.id];
  }

  if (requested === 'all') {
    return db.all('SELECT id FROM users').map((row) => row.id);
  }

  if (requested) {
    const id = parseInt(requested, 10);
    return Number.isInteger(id) ? [id] : [req.user.id];
  }

  return [req.user.id];
}

/**
 * GET /api/audit
 * Paginated history, newest first.
 */
router.get('/', authenticate, (req, res, next) => {
  try {
    const { action, entityType, source, search, from, to, page = 1, limit = 50 } = req.query;

    const result = listAuditEntries(resolveScope(req), {
      action: action || null,
      entityType: entityType || null,
      source: source || null,
      search: search || null,
      from: from || null,
      to: to || null,
      page,
      limit,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/audit/filters
 * The filter values actually present in the caller's history, plus — for an
 * admin — the users they can scope to.
 */
router.get('/filters', authenticate, (req, res, next) => {
  try {
    const isAdmin = req.user.is_admin === true || req.user.is_admin === 1;
    const options = getAuditFilterOptions(resolveScope(req));

    res.json({
      ...options,
      isAdmin,
      users: isAdmin
        ? db.all('SELECT id, username FROM users ORDER BY username')
        : [],
    });
  } catch (error) {
    next(error);
  }
});

export default router;
