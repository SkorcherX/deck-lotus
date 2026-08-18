import express from 'express';
import { resolveScan } from '../services/scanService.js';
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
    const { name, set, collector, limit } = req.query;

    if (!name && !(set && collector)) {
      return res.status(400).json({
        error: 'Provide a name, or a set code and collector number',
      });
    }

    res.json(resolveScan({
      name: name || null,
      setCode: set || null,
      collectorNumber: collector || null,
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
 * Body: { scans: [{ name, setCode, collectorNumber, id }], limit }
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

    const results = scans.map((scan, index) => ({
      // Echo the caller's id so the client can match results back to the queue
      // entry without relying on array order.
      id: scan?.id ?? index,
      ...resolveScan({
        name: scan?.name || null,
        setCode: scan?.setCode || null,
        collectorNumber: scan?.collectorNumber || null,
        limit: limit || 10,
      }),
    }));

    res.json({ results });
  } catch (error) {
    next(error);
  }
});

export default router;
