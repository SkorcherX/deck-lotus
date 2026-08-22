import express from 'express';
import {
  listTrades,
  getTradeById,
  createTrade,
  createTradeRequest,
  counterTrade,
  acceptTrade,
  declineTrade,
  cancelTrade,
  listTradePartners,
  browsePartnerInventory,
  browsePartnerStats,
  previewImpact,
  countPendingIncoming,
  getDisruptions,
  acknowledgeDisruption,
} from '../services/tradeService.js';
import { authenticate } from '../middleware/auth.js';
import {
  sendTradeProposed,
  sendTradeAccepted,
  sendTradeRequested,
  sendTradeCountered,
} from '../services/notificationService.js';

const router = express.Router();

/**
 * The service throws plain Errors for the things a user can get wrong —
 * trading cards they do not have, accepting somebody else's trade. Those are
 * 400s, not 500s, and the message is written to be shown as-is.
 */
function badRequest(res, error) {
  res.status(400).json({ error: error.message });
}

/**
 * GET /api/trades
 * Every trade the user is part of, newest first. ?status=pending to narrow.
 */
router.get('/', authenticate, (req, res, next) => {
  try {
    res.json({ trades: listTrades(req.user.id, { status: req.query.status || null }) });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/trades/partners
 * Everyone else on this instance, for the "trade with" picker.
 */
router.get('/partners', authenticate, (req, res, next) => {
  try {
    res.json({ partners: listTradePartners(req.user.id) });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/trades/pending-count
 * Badge count for the navbar.
 */
router.get('/pending-count', authenticate, (req, res, next) => {
  try {
    res.json({ count: countPendingIncoming(req.user.id) });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/trades/partners/:userId/inventory
 * Browse what somebody else owns, so a trade can be built from their
 * collection instead of from memory. Read-only, and stripped of anything
 * saying which of their cards are committed to decks — see
 * browsePartnerInventory.
 */
router.get('/partners/:userId/inventory', authenticate, (req, res, next) => {
  try {
    const { name, colors, type, sets, sort, commander, page = 1, limit = 54 } = req.query;

    res.json(browsePartnerInventory(req.user.id, parseInt(req.params.userId, 10), {
      name,
      colors: colors ? colors.split(',') : [],
      type,
      sets: sets ? sets.split(',') : [],
      sort: sort || 'name',
      commander: commander || 'all',
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    }));
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * GET /api/trades/partners/:userId/stats
 * Headline figures for the collection being shopped, minus the two that
 * describe their decks.
 */
router.get('/partners/:userId/stats', authenticate, (req, res, next) => {
  try {
    res.json(browsePartnerStats(req.user.id, parseInt(req.params.userId, 10)));
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * POST /api/trades/preview
 * What a draft trade would cost both sides' decks, before proposing it.
 */
router.post('/preview', authenticate, (req, res, next) => {
  try {
    const { toUserId, items } = req.body;

    if (!toUserId) {
      return res.status(400).json({ error: 'A trade partner is required' });
    }

    res.json(previewImpact(req.user.id, parseInt(toUserId, 10), items));
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * GET /api/trades/disruptions
 * Cards traded away that a deck still lists, awaiting acknowledgement.
 */
router.get('/disruptions', authenticate, (req, res, next) => {
  try {
    const deckId = req.query.deckId ? parseInt(req.query.deckId, 10) : null;
    res.json({ disruptions: getDisruptions(req.user.id, deckId) });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/trades/disruptions/:id/acknowledge
 * Decide what the deck becomes: 'removed' shrinks it, 'kept' leaves it
 * listing a card the owner no longer holds.
 */
router.post('/disruptions/:id/acknowledge', authenticate, (req, res, next) => {
  try {
    const resolution = req.body?.resolution;
    res.json(acknowledgeDisruption(parseInt(req.params.id, 10), req.user.id, resolution));
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * GET /api/trades/:id
 */
router.get('/:id', authenticate, (req, res, next) => {
  try {
    const trade = getTradeById(parseInt(req.params.id, 10), req.user.id);

    if (!trade) return res.status(404).json({ error: 'Trade not found' });

    res.json(trade);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/trades
 * Propose a trade. Nothing moves until the other side accepts.
 */
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { toUserId, items, note } = req.body;

    if (!toUserId) {
      return res.status(400).json({ error: 'A trade partner is required' });
    }

    const trade = createTrade(req.user.id, parseInt(toUserId, 10), items, note);

    // Best effort: a push notification failing must not undo a trade that is
    // already recorded.
    await sendTradeProposed(trade).catch((error) => {
      console.warn('Trade notification failed:', error.message);
    });

    res.status(201).json(trade);
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * POST /api/trades/request
 * Start a trade by shopping: send across what you want out of somebody's
 * collection and let them name their own half.
 */
router.post('/request', authenticate, async (req, res, next) => {
  try {
    const { toUserId, items, note } = req.body;

    if (!toUserId) {
      return res.status(400).json({ error: 'A trade partner is required' });
    }

    const trade = createTradeRequest(req.user.id, parseInt(toUserId, 10), items, note);

    await sendTradeRequested(trade).catch((error) => {
      console.warn('Trade notification failed:', error.message);
    });

    res.status(201).json(trade);
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * POST /api/trades/:id/counter
 * Answer a shopping request: turn down any of the cards you would rather
 * keep, name what you want in return, and hand the trade back to the
 * initiator to accept.
 */
router.post('/:id/counter', authenticate, async (req, res, next) => {
  try {
    const { items, note, declinedItemIds } = req.body;

    const trade = counterTrade(
      parseInt(req.params.id, 10), req.user.id, items, note, declinedItemIds
    );

    await sendTradeCountered(trade).catch((error) => {
      console.warn('Trade notification failed:', error.message);
    });

    res.json(trade);
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * POST /api/trades/:id/accept
 * Moves both collections and records any deck left short, in one transaction.
 */
router.post('/:id/accept', authenticate, async (req, res, next) => {
  try {
    const trade = acceptTrade(parseInt(req.params.id, 10), req.user.id);

    await sendTradeAccepted(trade).catch((error) => {
      console.warn('Trade notification failed:', error.message);
    });

    res.json(trade);
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * POST /api/trades/:id/decline
 */
router.post('/:id/decline', authenticate, (req, res, next) => {
  try {
    res.json(declineTrade(parseInt(req.params.id, 10), req.user.id));
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * POST /api/trades/:id/cancel
 */
router.post('/:id/cancel', authenticate, (req, res, next) => {
  try {
    res.json(cancelTrade(parseInt(req.params.id, 10), req.user.id));
  } catch (error) {
    badRequest(res, error);
  }
});

export default router;
