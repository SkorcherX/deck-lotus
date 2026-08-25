import express from 'express';
import {
  getShoppingList,
  addWantedCard,
  addWantedCardsBulk,
  setWantedQuantity,
  removeWantedCard,
  clearWantedCards,
  cheapestPrintingOf,
  getBulkBinList,
  setBulkThreshold,
} from '../services/shoppingService.js';
import {
  getFoundPile,
  toggleFound,
  setFoundQuantity,
  clearFoundPile,
} from '../services/foundPileService.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/** deckIds arrives as a comma-separated query param on both list endpoints. */
function parseDeckIds(param) {
  if (!param) return [];
  return param
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id));
}

/**
 * GET /api/shopping
 * Get shopping list for selected decks
 * Query params: deckIds (comma-separated list of deck IDs), includeContested
 *
 * The wanted list is always included, with or without decks — see
 * getShoppingList.
 *
 * `includeContested` stays off unless asked for, and the reasoning in
 * getShoppingList holds: a copy tied up in another deck needs no purchase, and
 * every consumer of this payload reads `quantityNeeded || 1`. It is exposed
 * because without it a deck could say "Short 1, in other decks" while the
 * Shopping page — the obvious place to go next — showed nothing and explained
 * nothing. Only the bulk view could ask, and only the bulk view could answer.
 */
router.get('/', authenticate, (req, res, next) => {
  try {
    const shoppingList = getShoppingList(req.user.id, parseDeckIds(req.query.deckIds), {
      includeContested: req.query.includeContested === 'true',
    });
    res.json(shoppingList);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/shopping/wanted
 * Add one card to the wanted list.
 *
 * Takes a printingId, or a cardId for callers that only know the card —
 * Browse Cards works at card level, and resolving the cheapest printing here
 * keeps that choice in one place rather than in the page.
 */
router.post('/wanted', authenticate, (req, res, next) => {
  try {
    const { cardId, quantity, isFoil, note } = req.body || {};
    let { printingId } = req.body || {};

    if (!printingId && cardId) {
      printingId = cheapestPrintingOf(parseInt(cardId, 10));

      if (!printingId) {
        return res.status(404).json({ error: 'No printing found for that card' });
      }
    }

    if (!printingId) {
      return res.status(400).json({ error: 'A printingId or cardId is required' });
    }

    const added = addWantedCard(req.user.id, {
      printingId: parseInt(printingId, 10),
      quantity,
      isFoil,
      note,
    });

    res.json({ added });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/shopping/wanted/bulk
 * Add a pasted block of card lines. Never fails as a whole: lines that
 * resolved to nothing come back in `unresolved` for the caller to show.
 */
router.post('/wanted/bulk', authenticate, (req, res, next) => {
  try {
    const { text } = req.body || {};

    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'Nothing to add' });
    }

    res.json(addWantedCardsBulk(req.user.id, String(text)));
  } catch (error) {
    next(error);
  }
});

/** PATCH /api/shopping/wanted/:id — set an exact count. */
router.patch('/wanted/:id', authenticate, (req, res, next) => {
  try {
    const { quantity } = req.body || {};
    res.json(setWantedQuantity(req.user.id, parseInt(req.params.id, 10), quantity));
  } catch (error) {
    next(error);
  }
});

/** DELETE /api/shopping/wanted/:id */
router.delete('/wanted/:id', authenticate, (req, res, next) => {
  try {
    res.json(removeWantedCard(req.user.id, parseInt(req.params.id, 10)));
  } catch (error) {
    next(error);
  }
});

/** DELETE /api/shopping/wanted — empty the list. */
router.delete('/wanted', authenticate, (req, res, next) => {
  try {
    res.json(clearWantedCards(req.user.id));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/shopping/bulk
 * The bulk-bin list: cheap cards to look for while rummaging at a shop.
 *
 * Query params: deckIds, threshold, commonsOnly, includeContested. The last
 * three are the on-page controls; only the threshold is remembered between
 * visits, and only when saved explicitly via PUT below — changing the number
 * to see what a different shop would yield should not rewrite your default.
 */
router.get('/bulk', authenticate, (req, res, next) => {
  try {
    const { threshold, commonsOnly, includeContested } = req.query;

    const list = getBulkBinList(req.user.id, parseDeckIds(req.query.deckIds), {
      threshold: threshold !== undefined ? threshold : undefined,
      // Both default to on, so only an explicit 'false' turns them off.
      commonsOnly: commonsOnly !== 'false',
      includeContested: includeContested !== 'false',
    });

    res.json(list);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/shopping/bulk/threshold
 * Remember this price ceiling for next time.
 */
router.put('/bulk/threshold', authenticate, (req, res, next) => {
  try {
    const threshold = setBulkThreshold(req.user.id, req.body?.threshold);
    res.json({ threshold });
  } catch (error) {
    next(error);
  }
});

/**
 * The found pile — cards ticked off at a shop.
 *
 * Deliberately not an inventory write: see migration 036. These endpoints only
 * record what was picked up; turning the pile into owned cards goes through
 * the normal bulk-add path, where printings get chosen.
 */

/** GET /api/shopping/found — the pile, for the review screen and the ticks. */
router.get('/found', authenticate, (req, res, next) => {
  try {
    res.json({ found: getFoundPile(req.user.id) });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/shopping/found — toggle one card.
 *
 * A toggle, because the button is pressed over a bulk box one-handed and the
 * second press is a misclick correction. Saved on the press so a trip
 * survives the phone dying.
 */
router.post('/found', authenticate, (req, res, next) => {
  try {
    const cardId = parseInt(req.body?.cardId, 10);

    if (!Number.isFinite(cardId)) {
      return res.status(400).json({ error: 'cardId is required' });
    }

    res.json(toggleFound(req.user.id, cardId, { quantity: req.body?.quantity }));
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: error.message });
    next(error);
  }
});

/** PUT /api/shopping/found/:cardId — how many copies. Zero unfinds it. */
router.put('/found/:cardId', authenticate, (req, res, next) => {
  try {
    const cardId = parseInt(req.params.cardId, 10);

    if (!Number.isFinite(cardId)) {
      return res.status(400).json({ error: 'cardId is required' });
    }

    res.json(setFoundQuantity(req.user.id, cardId, req.body?.quantity));
  } catch (error) {
    next(error);
  }
});

/** DELETE /api/shopping/found — empty the pile once it has been dealt with. */
router.delete('/found', authenticate, (req, res, next) => {
  try {
    res.json({ cleared: clearFoundPile(req.user.id) });
  } catch (error) {
    next(error);
  }
});

export default router;
