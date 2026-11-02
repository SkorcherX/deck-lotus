import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { isConfigured, optimizeCart, validateDeck, getCardInfoBulk, withSinglesFee } from '../services/manaPoolService.js';
import { getManaPoolStock, expandToStock, massEntryText } from '../services/manaPoolStock.js';
import db from '../db/connection.js';
import { NOT_A_STAND_IN } from '../shared/standInPrintings.js';

const router = express.Router();

router.get('/status', authenticate, (req, res) => {
  res.json({ configured: isConfigured() });
});

// Proxy to POST /buyer/optimizer
// Body: { items: [{ name, quantity, condition?, foil?, setCode?, collectorNumber?, exactPrinting? }], model? }
//
// Lines are spread over the printings Mana Pool actually stocks first (see
// manaPoolStock.js) unless `exactPrinting` says the user chose one. The
// answer carries `massEntry`, the same lines as text for Mana Pool's Mass
// Entry page, which has no documented way to be filled from a link.
router.post('/optimize', authenticate, async (req, res, next) => {
  try {
    const { items, model } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'items array is required' });

    let lines = items;
    let notStocked = [];
    try {
      const excludedSets = new Set(db.all(
        `SELECT code FROM sets WHERE type IN (${NOT_A_STAND_IN.map(() => '?').join(',')})`, NOT_A_STAND_IN,
      ).map((r) => String(r.code).toUpperCase()));
      const expanded = expandToStock(items, await getManaPoolStock(), { excludedSets });
      lines = expanded.lines;
      notStocked = expanded.unavailable;
    } catch (err) {
      // Without the feed the lines go as listed, which is how this used to work.
      console.warn('Mana Pool stock feed unavailable:', err.message);
    }

    const result = lines.length
      ? await optimizeCart(lines, model || 'lowest_price')
      : { cart: [], totals: null, unavailable: [] };
    const unavailable = [...new Set([
      ...(result.unavailable || []),
      ...notStocked.map((u) => u.name),
    ])];
    res.json({ ...result, totals: withSinglesFee(result.totals), unavailable, notStocked, massEntry: massEntryText(lines) });
  } catch (err) {
    next(err);
  }
});

// Proxy to POST /deck
// Body: { commanderNames: string[], otherCards: string[], format? }
router.post('/validate-deck', authenticate, async (req, res, next) => {
  try {
    const { commanderNames, otherCards, format } = req.body;
    if (!otherCards?.length) return res.status(400).json({ error: 'otherCards is required' });
    const result = await validateDeck(commanderNames || [], otherCards, format || 'commander');
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Proxy to POST /card_info
// Body: { names: string[] }
router.post('/card-info', authenticate, async (req, res, next) => {
  try {
    const { names } = req.body;
    if (!names?.length) return res.status(400).json({ error: 'names array is required' });
    const result = await getCardInfoBulk(names);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
