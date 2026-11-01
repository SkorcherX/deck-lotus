import express from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  listStores, addStore, updateStore, removeStore, buildScript, importResult, clearResult, LocalStoreError,
} from '../services/localStoreService.js';
import { buildExtensionZip, extensionVersion } from '../services/extensionPackage.js';

const router = express.Router();

function handle(fn) {
  return (req, res, next) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof LocalStoreError) return res.status(error.statusCode).json({ error: error.message });
      next(error);
    }
  };
}

/**
 * GET /api/local-stores/extension.zip — the store-price browser extension.
 * Public on purpose: it is the app's own code, holds nothing of the user's,
 * and a plain link cannot carry the Authorization header.
 */
router.get('/extension.zip', (req, res) => {
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="deck-lotus-store-prices.zip"',
  });
  res.send(buildExtensionZip('chrome'));
});

/**
 * GET /api/local-stores/extension-firefox.zip — the same extension with the
 * Firefox manifest. Unsigned: a release Firefox loads it only as a temporary
 * add-on until it has been signed through addons.mozilla.org.
 */
router.get('/extension-firefox.zip', (req, res) => {
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="deck-lotus-store-prices-firefox.zip"',
  });
  res.send(buildExtensionZip('firefox'));
});

router.get('/extension', (req, res) => res.json({ version: extensionVersion() }));

/** GET /api/local-stores — the caller's stores, each with its latest pasted result. */
router.get('/', authenticate, handle((req, res) => res.json(listStores(req.user.id))));

/** POST /api/local-stores — `{ name, baseUrl }`. */
router.post('/', authenticate, handle((req, res) => res.status(201).json(addStore(req.user.id, req.body || {}))));

router.patch('/:id', authenticate, handle((req, res) => res.json(updateStore(req.user.id, Number(req.params.id), req.body || {}))));

router.delete('/:id', authenticate, handle((req, res) => {
  removeStore(req.user.id, Number(req.params.id));
  res.json({ ok: true });
}));

/** POST /api/local-stores/script — `{ cards: [{ name, quantity, foil? }], options? }` → the console script. */
router.post('/script', authenticate, handle((req, res) => res.json(buildScript(req.body || {}))));

/** POST /api/local-stores/results — `{ result }`, the JSON the script copied. */
router.post('/results', authenticate, handle((req, res) => res.json(importResult(req.user.id, req.body?.result))));

router.delete('/:id/results', authenticate, handle((req, res) => {
  clearResult(req.user.id, Number(req.params.id));
  res.json({ ok: true });
}));

export default router;
