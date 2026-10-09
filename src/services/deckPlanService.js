/**
 * A deck's saved plan — see migration 047.
 *
 * Read leniently and written strictly: a plan that fails to parse reads as no
 * plan rather than breaking the deck page, and everything written is checked
 * and bounded, because the generator and the panel both trust it.
 */
import db from '../db/connection.js';
import { clampShare } from './deckGeneratorService.js';
import { customTheme } from './cardSynergyService.js';

const MAX_KEPT = 200;
const KEY = /^[a-z0-9:+'’ -]{1,60}$/i;

/** The stored JSON as a plan object, or null. */
export function parsePlan(raw) {
  if (!raw) return null;
  try {
    const plan = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return plan && typeof plan === 'object' ? normalizePlan(plan) : null;
  } catch {
    return null;
  }
}

function normalizePlan(plan) {
  // A custom theme's key is its phrases, so it is checked by parsing it, and
  // stored in the canonical form the parse rebuilds.
  const key = (value) => {
    if (typeof value !== 'string') return null;
    if (value.startsWith('custom:')) return customTheme(value)?.key ?? null;
    return KEY.test(value) ? value : null;
  };
  const themeKey = key(plan.themeKey);
  const keep = Array.isArray(plan.keep)
    ? [...new Set(plan.keep.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().slice(0, 200)))].slice(0, MAX_KEPT)
    : [];

  return {
    themeKey,
    // A second theme only means something beside a first, and never the same one.
    secondaryThemeKey: themeKey && key(plan.secondaryThemeKey) !== themeKey ? key(plan.secondaryThemeKey) : null,
    secondaryShare: plan.secondaryShare == null ? null : clampShare(plan.secondaryShare),
    keep,
  };
}

export function getDeckPlan(userId, deckId) {
  const deck = db.get('SELECT plan FROM decks WHERE id = ? AND user_id = ?', [deckId, userId]);
  if (!deck) throw new Error('That deck is not one of yours');
  return parsePlan(deck.plan);
}

/**
 * Save a plan, or clear it with null. A plan with nothing in it is stored as
 * no plan, so "has a plan" always means somebody chose something.
 */
export function saveDeckPlan(userId, deckId, plan) {
  const deck = db.get('SELECT id FROM decks WHERE id = ? AND user_id = ?', [deckId, userId]);
  if (!deck) throw new Error('That deck is not one of yours');

  const clean = plan ? normalizePlan(plan) : null;
  const empty = !clean || (!clean.themeKey && clean.keep.length === 0);

  db.run('UPDATE decks SET plan = ? WHERE id = ?', [empty ? null : JSON.stringify(clean), deckId]);
  return empty ? null : clean;
}
