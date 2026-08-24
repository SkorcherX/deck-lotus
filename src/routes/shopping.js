import express from 'express';
import {
  getShoppingList,
  addWantedCard,
  addWantedCardsBulk,
  setWantedQuantity,
  removeWantedCard,
  clearWantedCards,
  cheapestPrintingOf,
} from '../services/shoppingService.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/shopping
 * Get shopping list for selected decks
 * Query params: deckIds (comma-separated list of deck IDs)
 *
 * The wanted list is always included, with or without decks — see
 * getShoppingList.
 */
router.get('/', authenticate, (req, res, next) => {
  try {
    const deckIdsParam = req.query.deckIds;
    let deckIds = [];

    if (deckIdsParam) {
      deckIds = deckIdsParam.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    }

    const shoppingList = getShoppingList(req.user.id, deckIds);
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

export default router;
