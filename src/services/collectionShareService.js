import crypto from 'crypto';
import db from '../db/connection.js';
import { getInventory, getInventoryStats, getOwnedSets } from './inventoryService.js';

/**
 * A read-only view of one user's collection, reached by a link rather than an
 * account.
 *
 * Read-only is structural, not a flag: the public router mounts nothing but
 * GETs, and every function here that takes a token only reads. There is no
 * write path for a viewer to find.
 *
 * The person holding the link is a stranger to the app, so they get exactly
 * what a trade partner gets from browsePartnerInventory and no more — the
 * collection, not the decks. `total_in_decks` and `available` are stripped and
 * availability is forced to 'all', for the same reason as there: filtering to
 * "in decks" one card at a time would reconstruct what the owner has built.
 * Per-printing `user_id` and `owned_printing_id` go too; they mean nothing to
 * a viewer and are row ids on the owner's side.
 */

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

/** The owner's current link, or null when they are not sharing. */
export function getCollectionShare(userId) {
  return db.get(
    `SELECT share_token, created_at FROM collection_shares WHERE user_id = ?`,
    [userId]
  ) || null;
}

/** Start sharing. Returns the existing link if there already is one. */
export function createCollectionShare(userId) {
  const existing = getCollectionShare(userId);
  if (existing) return existing;

  db.run(
    `INSERT INTO collection_shares (user_id, share_token) VALUES (?, ?)`,
    [userId, newToken()]
  );

  return getCollectionShare(userId);
}

/**
 * Replace the token, so the old link stops working and a new one is handed
 * out. This is how a user cuts off whoever had the previous link.
 */
export function regenerateCollectionShare(userId) {
  db.run(
    `INSERT INTO collection_shares (user_id, share_token) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET share_token = excluded.share_token,
                                        created_at = CURRENT_TIMESTAMP`,
    [userId, newToken()]
  );

  return getCollectionShare(userId);
}

/** Stop sharing. Returns whether there was a link to stop. */
export function deleteCollectionShare(userId) {
  return db.run(`DELETE FROM collection_shares WHERE user_id = ?`, [userId]).changes > 0;
}

/**
 * Whose collection a token opens, or null. Anything that is not a plain hex
 * token is refused before it reaches the query.
 */
export function resolveCollectionShare(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return null;

  return db.get(
    `SELECT u.id AS user_id, u.username
       FROM collection_shares cs
       JOIN users u ON u.id = cs.user_id
      WHERE cs.share_token = ?`,
    [token]
  ) || null;
}

export function getSharedInventory(ownerId, filters = {}) {
  const result = getInventory(ownerId, {
    ...filters,
    availability: 'all',
    commander: filters.commander || 'all'
  });

  return {
    ...result,
    cards: result.cards.map(({ total_in_decks, available, printings, ...card }) => ({
      ...card,
      printings: (printings || []).map(({ user_id, owned_printing_id, ...printing }) => printing)
    }))
  };
}

/** Three of the five headline figures — the two left out describe decks. */
export function getSharedStats(ownerId) {
  const stats = getInventoryStats(ownerId);

  return {
    uniqueCards: stats.uniqueCards,
    totalCopies: stats.totalCopies,
    estimatedValue: stats.estimatedValue
  };
}

export function getSharedSets(ownerId) {
  return getOwnedSets(ownerId);
}
