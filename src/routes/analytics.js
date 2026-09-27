import express from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  getSummary, getTimeline, getSets, getColors, getValueHistory,
} from '../services/analyticsService.js';

const router = express.Router();

// Always the caller's own collection — no userId is read from the query.
const section = (fn) => (req, res, next) => {
  try {
    res.json(fn(req.user.id));
  } catch (error) {
    next(error);
  }
};

router.get('/summary', authenticate, section(getSummary));
router.get('/timeline', authenticate, section(getTimeline));
router.get('/sets', authenticate, section(getSets));
router.get('/colors', authenticate, section(getColors));
router.get('/value-history', authenticate, section(getValueHistory));

export default router;
