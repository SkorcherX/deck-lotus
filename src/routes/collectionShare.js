import express from 'express';
import {
  getCollectionShare,
  createCollectionShare,
  regenerateCollectionShare,
  deleteCollectionShare,
  resolveCollectionShare,
  getSharedInventory,
  getSharedStats,
  getSharedSets,
} from '../services/collectionShareService.js';
import { authenticate } from '../middleware/auth.js';
import { RARITIES } from '../shared/rarities.js';

const router = express.Router();

const PAGE_LIMIT_MAX = 200;

function shareBody(share) {
  return share
    ? { shareToken: share.share_token, shareUrl: `/collection/${share.share_token}`, createdAt: share.created_at }
    : { shareToken: null, shareUrl: null, createdAt: null };
}

// ---------------------------------------------------------------------------
// The owner managing their link
// ---------------------------------------------------------------------------

/** GET /api/collection-share — the current link, if any. */
router.get('/', authenticate, (req, res, next) => {
  try {
    res.json(shareBody(getCollectionShare(req.user.id)));
  } catch (error) {
    next(error);
  }
});

/** POST /api/collection-share — start sharing (idempotent). */
router.post('/', authenticate, (req, res, next) => {
  try {
    res.json(shareBody(createCollectionShare(req.user.id)));
  } catch (error) {
    next(error);
  }
});

/** POST /api/collection-share/regenerate — new link; the old one dies. */
router.post('/regenerate', authenticate, (req, res, next) => {
  try {
    res.json(shareBody(regenerateCollectionShare(req.user.id)));
  } catch (error) {
    next(error);
  }
});

/** DELETE /api/collection-share — stop sharing. */
router.delete('/', authenticate, (req, res, next) => {
  try {
    deleteCollectionShare(req.user.id);
    res.json(shareBody(null));
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Someone with the link. No authentication, and nothing but GETs: this half
// of the router has no way to change anything, which is the whole guarantee.
// ---------------------------------------------------------------------------

function withOwner(req, res, next) {
  const owner = resolveCollectionShare(req.params.token);

  if (!owner) {
    return res.status(404).json({ error: 'This collection link is not valid, or sharing was turned off' });
  }

  req.shareOwner = owner;
  next();
}

/** GET /api/collection-share/public/:token — whose collection this is. */
router.get('/public/:token', withOwner, (req, res) => {
  res.json({ username: req.shareOwner.username });
});

/** GET /api/collection-share/public/:token/inventory — same filters as /api/inventory, minus availability. */
router.get('/public/:token/inventory', withOwner, (req, res, next) => {
  try {
    const { name, colors, type, sets, sort, commander, rarity, page = 1, limit = 50 } = req.query;

    res.json(getSharedInventory(req.shareOwner.user_id, {
      names: name ? [].concat(name) : [],
      colors: colors ? colors.split(',') : [],
      type,
      sets: sets ? sets.split(',') : [],
      sort: sort || 'name',
      commander: commander || 'all',
      rarity: RARITIES.includes(rarity) ? rarity : 'all',
      page: Math.max(1, parseInt(page, 10) || 1),
      limit: Math.min(PAGE_LIMIT_MAX, Math.max(1, parseInt(limit, 10) || 50)),
    }));
  } catch (error) {
    next(error);
  }
});

router.get('/public/:token/stats', withOwner, (req, res, next) => {
  try {
    res.json(getSharedStats(req.shareOwner.user_id));
  } catch (error) {
    next(error);
  }
});

router.get('/public/:token/sets', withOwner, (req, res, next) => {
  try {
    res.json({ sets: getSharedSets(req.shareOwner.user_id) });
  } catch (error) {
    next(error);
  }
});

export default router;
