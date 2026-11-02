import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { getCommanderRecommendations, createIdeaDeck, addCardsToDeck, suggestCommanders, EdhrecError } from '../services/edhrecService.js';

const router = express.Router();

function fail(res, next, error) {
  if (error instanceof EdhrecError) return res.status(error.statusCode).json({ error: error.message });
  return next(error);
}

/**
 * GET /api/edhrec/commander?q=<name or EDHREC URL>[&refresh=1]
 * EDHREC's card recommendations for a commander, marked with what the caller
 * owns. Cached a day per commander; `refresh` forces a new lookup.
 */
router.get('/commander', authenticate, async (req, res, next) => {
  try {
    res.json(await getCommanderRecommendations(req.user.id, req.query.q, { refresh: req.query.refresh === '1' }));
  } catch (error) {
    fail(res, next, error);
  }
});

/** GET /api/edhrec/commanders?q= — commander names for the lookup box's autocomplete. */
router.get('/commanders', authenticate, (req, res, next) => {
  try {
    res.json({ commanders: suggestCommanders(String(req.query.q || '')) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/edhrec/deck — `{ name, commander, cardNames }` → a new idea deck. */
router.post('/deck', authenticate, (req, res, next) => {
  try {
    res.status(201).json(createIdeaDeck(req.user.id, req.body || {}));
  } catch (error) {
    fail(res, next, error);
  }
});

/** POST /api/edhrec/deck/:id/cards — `{ cardNames }` → added to an existing deck. */
router.post('/deck/:id/cards', authenticate, (req, res, next) => {
  try {
    res.json(addCardsToDeck(req.user.id, { deckId: Number(req.params.id), cardNames: req.body?.cardNames }));
  } catch (error) {
    fail(res, next, error);
  }
});

export default router;
