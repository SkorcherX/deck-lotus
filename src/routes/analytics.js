import express from 'express';
import { authenticate } from '../middleware/auth.js';
import db from '../db/connection.js';
import {
  getSummary, getTimeline, getSets, getColors, getValueHistory,
  getComposition, getTopCards, getSetCompletion, getDailyActivity,
  getDeckUse, getTradesAndLoans,
} from '../services/analyticsService.js';

const router = express.Router();

/**
 * Whose collection the caller may analyse.
 *
 * A regular user gets their own and nothing else, whatever the query says —
 * same rule and same shape as resolveScope in routes/audit.js. An admin may
 * pass `userIds=1,2,3` to see one other user, or a household as one combined
 * collection. Ids that are not real users are dropped; if nothing valid is
 * left the caller sees their own.
 */
export function resolveScope(req) {
  const isAdmin = req.user.is_admin === true || req.user.is_admin === 1;
  if (!isAdmin || !req.query.userIds) return [req.user.id];

  const requested = [...new Set(
    String(req.query.userIds).split(',').map((id) => parseInt(id, 10)).filter(Number.isInteger)
  )];
  if (requested.length === 0) return [req.user.id];

  const known = new Set(db.all(
    `SELECT id FROM users WHERE id IN (${requested.map(() => '?').join(',')})`, requested
  ).map((r) => r.id));
  const ids = requested.filter((id) => known.has(id));
  return ids.length ? ids : [req.user.id];
}

const section = (fn) => (req, res, next) => {
  try {
    res.json(fn(resolveScope(req)));
  } catch (error) {
    next(error);
  }
};

router.get('/summary', authenticate, section(getSummary));
router.get('/timeline', authenticate, section(getTimeline));
router.get('/sets', authenticate, section(getSets));
router.get('/colors', authenticate, section(getColors));
router.get('/value-history', authenticate, section(getValueHistory));
router.get('/composition', authenticate, section(getComposition));
router.get('/top-cards', authenticate, section((ids) => getTopCards(ids)));
router.get('/set-completion', authenticate, section(getSetCompletion));
router.get('/daily', authenticate, section(getDailyActivity));
router.get('/deck-use', authenticate, section(getDeckUse));
router.get('/trades-loans', authenticate, section(getTradesAndLoans));

export default router;
