import express from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  listSealed,
  searchCatalog,
  addSealed,
  updateSealed,
  deleteSealed,
  importSealedCsv,
} from '../services/sealedService.js';

const router = express.Router();

/** Validation errors are written to be shown as-is; a 404 keeps its status. */
function fail(res, next, error) {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
  if (error instanceof Error && !/SQLITE/.test(error.code || '')) return res.status(400).json({ error: error.message });
  return next(error);
}

/** GET /api/sealed — the caller's sealed lots with totals. */
router.get('/', authenticate, (req, res, next) => {
  try {
    res.json(listSealed(req.user.id));
  } catch (error) {
    next(error);
  }
});

/** GET /api/sealed/catalog?q= — search MTGJSON's sealed product list. */
router.get('/catalog', authenticate, (req, res, next) => {
  try {
    res.json({ products: searchCatalog(req.query.q || '', req.query.limit) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/sealed/import — a CardCastle portfolio CSV, as `{ csv }`. */
router.post('/import', authenticate, (req, res, next) => {
  try {
    if (!req.body?.csv) return res.status(400).json({ error: 'csv is required' });
    res.json(importSealedCsv(req.user.id, req.body.csv));
  } catch (error) {
    fail(res, next, error);
  }
});

router.post('/', authenticate, (req, res, next) => {
  try {
    res.status(201).json(addSealed(req.user.id, req.body || {}));
  } catch (error) {
    fail(res, next, error);
  }
});

router.put('/:id', authenticate, (req, res, next) => {
  try {
    res.json(updateSealed(req.user.id, parseInt(req.params.id, 10), req.body || {}));
  } catch (error) {
    fail(res, next, error);
  }
});

router.delete('/:id', authenticate, (req, res, next) => {
  try {
    res.json(deleteSealed(req.user.id, parseInt(req.params.id, 10)));
  } catch (error) {
    fail(res, next, error);
  }
});

export default router;
