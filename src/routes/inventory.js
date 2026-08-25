import express from 'express';
import {
  getInventory,
  getInventoryStats,
  searchCardsForInventoryAdd,
  bulkAddToInventory,
  resolveBulkAddItems,
  getAvailability,
  getBuilderInventory,
  getOwnedSets,
} from '../services/inventoryService.js';
import { addOwnedPrintingQuantity } from '../services/cardService.js';
import { AUDIT_SOURCES } from '../services/auditService.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * Where the client says a change came from, for the audit log.
 *
 * Checked against the known list rather than stored as sent: the value ends
 * up in a filter dropdown, and letting a caller invent one turns that
 * dropdown into a list of whatever anybody has ever posted. An unrecognised
 * value falls back to the endpoint's own default rather than being rejected —
 * a mislabelled audit row is better than a refused inventory add.
 */
function auditSource(requested, fallback) {
  return AUDIT_SOURCES.includes(requested) ? requested : fallback;
}

/**
 * GET /api/inventory
 * Get paginated inventory list with filters
 */
router.get('/', authenticate, (req, res, next) => {
  try {
    const {
      name,
      colors,
      type,
      sets,
      sort,
      availability,
      commander,
      page = 1,
      limit = 50
    } = req.query;

    const filters = {
      // The inventory filter bar sends one `name` param per chip, so express
      // hands us either a string or an array. Both collapse to a list here.
      names: name ? [].concat(name) : [],
      colors: colors ? colors.split(',') : [],
      type,
      sets: sets ? sets.split(',') : [],
      sort: sort || 'name',
      availability: availability || 'all',
      commander: commander || 'all',
      page: parseInt(page),
      limit: parseInt(limit)
    };

    const result = getInventory(req.user.id, filters);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/inventory/stats
 * Get collection statistics
 */
router.get('/stats', authenticate, (req, res, next) => {
  try {
    const stats = getInventoryStats(req.user.id);
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/inventory/search
 * Quick-add search
 */
router.get('/search', authenticate, (req, res, next) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.length < 2) {
      return res.json({ cards: [] });
    }

    const cards = searchCardsForInventoryAdd(req.user.id, q, parseInt(limit));
    res.json({ cards });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/inventory/sets
 * Get sets that the user owns cards from
 */
router.get('/sets', authenticate, (req, res, next) => {
  try {
    const sets = getOwnedSets(req.user.id);
    res.json({ sets });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/inventory/bulk-add
 * Bulk import cards to inventory
 */
router.post('/bulk-add', authenticate, (req, res, next) => {
  try {
    const { items, source } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    const result = bulkAddToInventory(req.user.id, items, {
      source: auditSource(source, 'bulk_add'),
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/inventory/availability
 * How many copies of each printing and finish are still free to spend.
 * Pass deckId to exclude the deck being edited from the committed count.
 */
router.get('/availability', authenticate, (req, res, next) => {
  try {
    const { deckId, printingIds } = req.query;

    const ids = printingIds
      ? String(printingIds).split(',').map((id) => parseInt(id, 10)).filter(Number.isInteger)
      : null;

    const items = getAvailability(
      req.user.id,
      deckId ? parseInt(deckId, 10) : null,
      ids
    );

    res.json({ items });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/inventory/builder
 * Owned printings with availability, for the deck builder's inventory panel.
 */
router.get('/builder', authenticate, (req, res, next) => {
  try {
    const { deckId, name, type, colors, colorIdentity, maxCmc, onlyFree, format, role, page, limit } = req.query;

    const result = getBuilderInventory(
      req.user.id,
      deckId ? parseInt(deckId, 10) : null,
      {
        name,
        type,
        colors: colors ? String(colors).split(',').filter(Boolean) : [],
        colorIdentity,
        maxCmc,
        onlyFree: onlyFree === 'true' || onlyFree === '1',
        format,
        role,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? Math.min(parseInt(limit, 10), 200) : 60
      }
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/inventory/bulk-resolve
 * Resolve bulk-add lines to printings without writing anything, so the
 * preview can show which card each line maps to.
 */
router.post('/bulk-resolve', authenticate, (req, res, next) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    res.json({ items: resolveBulkAddItems(items) });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/inventory/quick-add
 * Quick-add a single card to inventory
 *
 * `quantity` is how many copies to ADD, not what the row should end up
 * holding. It used to be passed straight to setOwnedPrintingQuantity, so
 * quick-adding one copy of a card you owned five of left you owning one — and
 * answered 200. The name of this endpoint is "add"; it now adds.
 *
 * The response carries `quantity` (the row's new total) and `added`, so a
 * caller can tell the user what they now have rather than guessing.
 */
router.post('/quick-add', authenticate, (req, res, next) => {
  try {
    const { printingId, quantity = 1, isFoil = false, source } = req.body;

    if (!printingId) {
      return res.status(400).json({ error: 'printingId is required' });
    }

    // Rejected here rather than silently coerced: a client sending 0 or -1
    // means something this endpoint cannot do, and quietly adding 1 instead
    // would be the same class of surprise this fix exists to remove.
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: 'quantity must be a whole number of at least 1' });
    }

    const result = addOwnedPrintingQuantity(req.user.id, printingId, quantity, isFoil, {
      source: auditSource(source, 'quick_add'),
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
