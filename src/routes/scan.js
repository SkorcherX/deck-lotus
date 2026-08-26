import express from 'express';
import { resolveScan, resolveScanFused } from '../services/scanService.js';
import { authenticate } from '../middleware/auth.js';
import {
  commitScanToCollection,
  commitScanToDeck,
  ownershipShortfall,
} from '../services/scanCommitService.js';

const router = express.Router();

/**
 * GET /api/scan/resolve
 * Resolve a single OCR reading into ranked candidates.
 *
 * Query: name, set, collector, limit — all optional, but at least one of name
 * or (set + collector) has to be present for a lookup to be possible.
 */
router.get('/resolve', authenticate, (req, res, next) => {
  try {
    const { name, set, collector, limit, artHash, frameHash } = req.query;

    if (!name && !(set && collector) && !artHash) {
      return res.status(400).json({
        error: 'Provide a name, a set code and collector number, or an art hash',
      });
    }

    // Text-only queries stay on the original resolver, byte for byte. This is
    // the curl-able debug path and the printing picker's backing query, and
    // both were built against that response shape; the fused resolver adds
    // `tier` and `signals`, which a text-only reading has no basis to claim.
    if (!artHash) {
      return res.json(resolveScan({
        name: name || null,
        setCode: set || null,
        collectorNumber: collector || null,
        limit: limit || 10,
      }));
    }

    res.json(resolveScanFused({
      name: name || null,
      setCode: set || null,
      collectorNumber: collector || null,
      artHash,
      frameHash: frameHash || null,
      limit: limit || 10,
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/scan/resolve
 * Batch form of the above — a scan session produces a queue of readings, and
 * resolving them in one request avoids a round trip per card.
 *
 * Body: { scans: [{ id, name, setCode, collectorNumber, artHash, frameHash }], limit }
 */
router.post('/resolve', authenticate, (req, res, next) => {
  try {
    const { scans, limit } = req.body || {};

    if (!Array.isArray(scans) || scans.length === 0) {
      return res.status(400).json({ error: 'scans must be a non-empty array' });
    }

    if (scans.length > 200) {
      return res.status(400).json({ error: 'At most 200 scans per request' });
    }

    // The batch path is the scan session's, and a session always wants the
    // tier: it is what sorts the queue into "needs a look" and "collapsed".
    // A reading with no hash still resolves, and honestly reports itself as
    // single-signal rather than borrowing a confidence it has not earned.
    const results = scans.map((scan, index) => ({
      // Echo the caller's id so the client can match results back to the queue
      // entry without relying on array order.
      id: scan?.id ?? index,
      ...resolveScanFused({
        name: scan?.name || null,
        setCode: scan?.setCode || null,
        collectorNumber: scan?.collectorNumber || null,
        artHash: scan?.artHash || null,
        frameHash: scan?.frameHash || null,
        limit: limit || 10,
      }),
    }));

    res.json({ results });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/scan/shortfall
 * Which of a reviewed session's cards the caller does not own enough of.
 *
 * Read-only, and asked before a Scan-to-Deck commit so the review screen can
 * offer "add the missing ones to my collection too". Deliberately a separate
 * call rather than part of the commit: the answer changes what the reviewer
 * chooses, so they have to see it first.
 *
 * Body: { items: [{ printingId, quantity, isFoil }] }
 */
router.post('/shortfall', authenticate, (req, res, next) => {
  try {
    const { items } = req.body || {};
    res.json({ shortfalls: ownershipShortfall(req.user.id, items) });
  } catch (error) {
    if (error.message.startsWith('Row ') || error.message.startsWith('A scan session')) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

/**
 * POST /api/scan/commit
 * Commit a reviewed scan session. The first write path this router has.
 *
 * Body: {
 *   destination: 'collection' | 'deck',
 *   deckId,                       // required for 'deck'
 *   items: [{ printingId, quantity, isFoil, boardType, isCommander }],
 *   alsoAddToCollection,          // 'deck' only; the shortfall opt-in
 * }
 *
 * The destination is an explicit field rather than being inferred from whether
 * a deckId is present. A session that meant to go to the collection and arrived
 * carrying a stale deckId must fail, not quietly go somewhere else.
 */
router.post('/commit', authenticate, (req, res, next) => {
  try {
    const { destination, deckId, items, alsoAddToCollection } = req.body || {};

    if (destination !== 'collection' && destination !== 'deck') {
      return res.status(400).json({ error: "destination must be 'collection' or 'deck'" });
    }

    if (destination === 'collection') {
      return res.json(commitScanToCollection(req.user.id, items));
    }

    if (!deckId) {
      return res.status(400).json({ error: 'deckId is required to scan into a deck' });
    }

    // The shortfall is resolved before the deck commit, so both writes can share
    // one batch id. A session that added copies to the collection and cards to a
    // deck is one action from the user's side and has to be undoable as one.
    const batchId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let addedToCollection = null;

    if (alsoAddToCollection) {
      const shortfalls = ownershipShortfall(req.user.id, items);
      if (shortfalls.length) {
        addedToCollection = commitScanToCollection(
          req.user.id,
          shortfalls.map((shortfall) => ({
            printingId: shortfall.printingId,
            quantity: shortfall.short,
            isFoil: shortfall.isFoil,
          })),
          { batchId }
        );
      }
    }

    const result = commitScanToDeck(req.user.id, Number(deckId), items, { batchId });
    res.json({ ...result, addedToCollection });
  } catch (error) {
    if (
      error.message.startsWith('Row ') ||
      error.message.startsWith('A scan session') ||
      error.message.startsWith('At most') ||
      error.message.includes('no longer exist')
    ) {
      return res.status(400).json({ error: error.message });
    }
    if (error.message.includes('access denied')) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

export default router;
