import express from 'express';
import {
  getUserDecks,
  getDeckById,
  createDeck,
  updateDeck,
  deleteDeck,
  addCardToDeck,
  updateDeckCard,
  removeCardFromDeck,
  removeCardFromDeckByCardId,
  getDeckStats,
  createDeckShare,
  getDeckByShareToken,
  deleteDeckShare,
  importSharedDeck,
  cloneDeck,
  checkDeckLegality,
  DECK_STATUSES,
} from '../services/deckService.js';
import {
  getDeckGames,
  addDeckGame,
  updateDeckGame,
  deleteDeckGame,
  getDeckRecord,
} from '../services/deckGameService.js';
import { checkFormatRules } from '../services/formatRulesService.js';
import { getDeckPrice } from '../services/pricingService.js';
import { parseDeckList, importDeck } from '../services/importService.js';
import {
  analyzeDeckPrintings,
  analyzeSpecificSet,
  applyPrintingOptimization,
  getAvailableSets
} from '../services/printingOptimizerService.js';
import { authenticate, optionalAuthenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/decks
 * Get all decks for current user
 */
router.get('/', authenticate, (req, res, next) => {
  try {
    const decks = getUserDecks(req.user.id);
    res.json({ decks });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/decks
 * Create new deck
 */
router.post('/', authenticate, (req, res, next) => {
  try {
    const { name, format, description, status } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Deck name is required' });
    }

    // Caught here as well as in the service so a bad value is a 400 the client
    // can show, rather than a thrown Error surfacing as a 500.
    if (status !== undefined && !DECK_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${DECK_STATUSES.join(', ')}` });
    }

    const deck = createDeck(req.user.id, name, format, description, { status });
    res.status(201).json({ deck });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/decks/:id
 * Get deck by ID
 */
router.get('/:id', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const deck = getDeckById(deckId, req.user.id);

    if (!deck) {
      return res.status(404).json({ error: 'Deck not found' });
    }

    res.json({ deck });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/decks/:id
 * Update deck
 */
router.put('/:id', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const { name, format, description, status } = req.body;

    if (status !== undefined && !DECK_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${DECK_STATUSES.join(', ')}` });
    }

    const deck = updateDeck(deckId, req.user.id, { name, format, description, status });
    res.json({ deck });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/decks/:id
 * Delete deck
 */
router.delete('/:id', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const success = deleteDeck(deckId, req.user.id);

    if (!success) {
      return res.status(404).json({ error: 'Deck not found' });
    }

    res.json({ message: 'Deck deleted successfully' });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/decks/:id/stats
 * Get deck statistics
 */
router.get('/:id/stats', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const stats = getDeckStats(deckId, req.user.id);

    if (!stats) {
      return res.status(404).json({ error: 'Deck not found' });
    }

    res.json(stats);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/decks/:id/price
 * Get deck total price
 */
router.get('/:id/price', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const price = getDeckPrice(deckId);
    res.json(price);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/decks/:id/cards
 * Add card to deck
 */
router.post('/:id/cards', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const { printingId, quantity, isSideboard, isCommander, boardType, isFoil } = req.body;

    if (!printingId) {
      return res.status(400).json({ error: 'printingId is required' });
    }

    const deck = addCardToDeck(
      deckId,
      req.user.id,
      printingId,
      quantity || 1,
      isSideboard || false,
      isCommander || false,
      boardType,
      isFoil || false
    );

    res.json({ deck });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/decks/:id/cards/:cardId
 * Update card in deck
 */
router.put('/:id/cards/:cardId', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const deckCardId = parseInt(req.params.cardId);
    const { quantity, isSideboard, isCommander, printingId, boardType, isFoil } = req.body;

    const deck = updateDeckCard(deckId, req.user.id, deckCardId, {
      quantity,
      isSideboard,
      isCommander,
      printingId,
      boardType,
      isFoil,
    });

    res.json({ deck });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/decks/:id/cards/:cardId
 * Remove card from deck
 */
router.delete('/:id/cards/:cardId', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const deckCardId = parseInt(req.params.cardId);

    const deck = removeCardFromDeck(deckId, req.user.id, deckCardId);

    res.json({ deck });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/decks/:id/cards/by-card-id/:cardId
 * Remove every copy of a card (all printings, all boards) from a deck —
 * the "Remove from Deck" counterpart to the quick "+ Add to Deck" action,
 * which likewise doesn't ask which printing/board.
 */
router.delete('/:id/cards/by-card-id/:cardId', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const cardId = parseInt(req.params.cardId);

    const deck = removeCardFromDeckByCardId(deckId, req.user.id, cardId);

    res.json({ deck });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/decks/:id/clone
 * Copy a deck, cards and all, into a new deck. Partial decks copy as they are:
 * an unfinished list is a template, not an error.
 */
router.post('/:id/clone', authenticate, (req, res, next) => {
  try {
    const { name } = req.body || {};
    const deck = cloneDeck(parseInt(req.params.id, 10), req.user.id, name);

    res.status(201).json({ deck });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

/**
 * POST /api/decks/import
 * Import deck from text
 */
router.post('/import', authenticate, (req, res, next) => {
  try {
    const { name, format, deckList } = req.body;

    if (!name || !deckList) {
      return res.status(400).json({ error: 'Name and deck list are required' });
    }

    // Parse deck list
    const cardList = parseDeckList(deckList);

    if (cardList.length === 0) {
      return res.status(400).json({ error: 'No valid cards found in deck list' });
    }

    // Import deck
    const result = importDeck(req.user.id, name, format, cardList);

    // Return the created deck
    const deck = getDeckById(result.deckId, req.user.id);

    res.status(201).json({
      deck,
      imported: result.imported,
      notFound: result.notFound,
      // The lines that resolved to nothing come back so the person who pasted
      // them can see which ones to fix, rather than being told the import
      // succeeded and finding an empty deck.
      unresolved: result.unresolved,
      message: `Successfully imported ${result.imported} cards${result.notFound > 0 ? ` (${result.notFound} not found)` : ''}`
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/decks/:id/share
 * Create or get share link for deck
 */
router.post('/:id/share', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const shareToken = createDeckShare(deckId, req.user.id);

    res.json({
      shareToken,
      shareUrl: `/share/${shareToken}`
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/decks/:id/share
 * Delete/deactivate share link for deck
 */
router.delete('/:id/share', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const success = deleteDeckShare(deckId, req.user.id);

    if (!success) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    res.json({ message: 'Share link deleted successfully' });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/decks/share/:token
 * Get shared deck by token (public, no auth required)
 */
router.get('/share/:token', optionalAuthenticate, (req, res, next) => {
  try {
    const { token } = req.params;
    const deck = getDeckByShareToken(token);

    if (!deck) {
      return res.status(404).json({ error: 'Shared deck not found or no longer available' });
    }

    // Include user auth status for frontend to show appropriate buttons
    res.json({
      deck,
      isAuthenticated: !!req.user
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/decks/share/:token/import
 * Import a shared deck to user's collection
 */
router.post('/share/:token/import', authenticate, (req, res, next) => {
  try {
    const { token } = req.params;
    const deck = importSharedDeck(token, req.user.id);

    res.status(201).json({
      deck,
      message: 'Deck imported successfully'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/decks/:id/legality/:format
 * Check deck legality for a specific format
 */
router.get('/:id/legality/:format', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const { format } = req.params;

    const result = checkDeckLegality(deckId, req.user.id, format);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/decks/:id/rules
 * Check the deck against its format's hard rules. Pass ?format= to check
 * against a format other than the one saved on the deck.
 */
router.get('/:id/rules', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const { format } = req.query;

    res.json(checkFormatRules(deckId, req.user.id, format || null));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/decks/:id/optimize-printings
 * Analyze deck and get printing optimization suggestions
 */
router.get('/:id/optimize-printings', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const topN = parseInt(req.query.topN) || 5;
    const excludeCommander = req.query.excludeCommander === 'true';

    const result = analyzeDeckPrintings(deckId, req.user.id, topN, excludeCommander);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/decks/:id/optimize-printings/sets
 * Get all available sets for the deck
 */
router.get('/:id/optimize-printings/sets', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);

    const sets = getAvailableSets(deckId, req.user.id);
    res.json({ sets });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/decks/:id/optimize-printings/analyze-set
 * Analyze a specific set for optimization
 */
router.post('/:id/optimize-printings/analyze-set', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const { setCode } = req.body;

    if (!setCode) {
      return res.status(400).json({ error: 'setCode is required' });
    }

    const result = analyzeSpecificSet(deckId, req.user.id, setCode);

    if (!result) {
      return res.status(404).json({ error: 'No cards found for this set' });
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/decks/:id/optimize-printings/apply
 * Apply printing optimization changes to deck
 */
router.post('/:id/optimize-printings/apply', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const { changes } = req.body;

    if (!changes || !Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({ error: 'changes array is required' });
    }

    const result = applyPrintingOptimization(deckId, req.user.id, changes);

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Match record
// ---------------------------------------------------------------------------

/**
 * GET /api/decks/:id/games
 * Every game logged for a deck, newest first, plus the record they total to.
 */
router.get('/:id/games', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    res.json(getDeckGames(deckId, req.user.id, { limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/decks/:id/games
 * Log a game.
 */
router.post('/:id/games', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const game = addDeckGame(deckId, req.user.id, req.body || {});

    res.status(201).json({ game, record: getDeckRecord(deckId, req.user.id) });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/decks/:id/games/:gameId
 * Correct a game that was entered wrong — the reason the record is a log and
 * not a pair of counters.
 */
router.put('/:id/games/:gameId', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const game = updateDeckGame(parseInt(req.params.gameId), req.user.id, req.body || {});

    res.json({ game, record: getDeckRecord(deckId, req.user.id) });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/decks/:id/games/:gameId
 */
router.delete('/:id/games/:gameId', authenticate, (req, res, next) => {
  try {
    const deckId = parseInt(req.params.id);
    const removed = deleteDeckGame(parseInt(req.params.gameId), req.user.id);

    if (!removed) {
      return res.status(404).json({ error: 'Game not found' });
    }

    res.json({ success: true, record: getDeckRecord(deckId, req.user.id) });
  } catch (error) {
    next(error);
  }
});

export default router;
