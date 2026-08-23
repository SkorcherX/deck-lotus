import express from 'express';
import { getMaintenanceStatus } from '../services/maintenanceService.js';

const router = express.Router();

/**
 * GET /api/system/maintenance
 *
 * Deliberately unauthenticated. Its whole job is to be answerable while the
 * MTGJSON import has the database mid-rewrite, and the API-key branch of
 * `authenticate` reads from SQLite — the one thing that cannot be relied on
 * at exactly the moment this endpoint matters most. It reports only whether a
 * card-data update is due or running, which is not anybody's private data.
 */
router.get('/maintenance', (req, res) => {
  res.json(getMaintenanceStatus());
});

export default router;
