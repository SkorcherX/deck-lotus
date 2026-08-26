import express from 'express';
import { resolveScan, resolveScanFused } from '../services/scanService.js';
import { authenticate } from '../middleware/auth.js';

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

export default router;
