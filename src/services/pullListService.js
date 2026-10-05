/**
 * The pull list: what to take out of physical storage to assemble a deck,
 * and how far through that somebody is.
 *
 * One row per printing and finish the deck lists — the exact copy to look
 * for, not just the card — with everything that helps find it on a shelf:
 * colour, type, rarity, set and number, foil, the conditions owned. Grouping
 * into storage piles is `groupPullRows` in src/shared/pullLayout.js, done on
 * the client so a layout change regroups instantly.
 *
 * Nothing here changes a deck or a collection. Progress is its own table.
 */
import db from '../db/connection.js';
import { getDeckReadiness } from './deckReadinessService.js';
import { normalizeLayout, DEFAULT_PULL_LAYOUT } from '../shared/pullLayout.js';
import { isBasicLand } from './basicLands.js';

function ownDeck(userId, deckId) {
  const deck = db.get('SELECT id, name, format, status FROM decks WHERE id = ? AND user_id = ?', [deckId, userId]);
  if (!deck) throw new Error('That deck is not one of yours');
  return deck;
}

export function getPullLayout(userId) {
  const row = db.get('SELECT pull_layout FROM users WHERE id = ?', [userId]);
  if (!row?.pull_layout) return normalizeLayout(DEFAULT_PULL_LAYOUT);
  try {
    return normalizeLayout(JSON.parse(row.pull_layout));
  } catch {
    return normalizeLayout(DEFAULT_PULL_LAYOUT);
  }
}

export function savePullLayout(userId, layout) {
  const clean = normalizeLayout(layout);
  db.run('UPDATE users SET pull_layout = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(clean), userId]);
  return clean;
}

export function getPullList(userId, deckId) {
  const deck = ownDeck(userId, deckId);

  // Maybeboard cards are not part of the deck, so they are not pulled.
  // Mainboard and sideboard copies of one printing are one pile to pull from.
  const rows = db.all(
    `SELECT p.uuid, dc.is_foil, SUM(dc.quantity) AS quantity, MAX(dc.is_commander) AS is_commander,
            MAX(CASE WHEN COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) = 'sideboard' THEN 1 ELSE 0 END) AS in_sideboard,
            p.id AS printing_id, p.set_code, p.collector_number, p.rarity, p.image_url,
            s.name AS set_name, s.keyrune_code, c.id AS card_id, c.name, c.mana_cost, c.cmc, c.colors, c.type_line
       FROM deck_cards dc
       JOIN printings p ON dc.printing_id = p.id
       JOIN cards c ON p.card_id = c.id
       LEFT JOIN sets s ON p.set_code = s.code
      WHERE dc.deck_id = ?
        AND COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) != 'maybeboard'
      GROUP BY p.id, dc.is_foil`,
    [deckId]
  );

  const progress = new Map(
    db.all('SELECT printing_uuid, is_foil, pulled FROM deck_pull_progress WHERE deck_id = ?', [deckId])
      .map((r) => [`${r.printing_uuid}|${r.is_foil}`, r.pulled])
  );

  // The conditions owned of this exact printing and finish, so somebody with
  // an NM and an LP copy knows which to look for.
  const conditionsStmt = `SELECT condition, SUM(quantity) AS quantity FROM owned_printings
     WHERE user_id = ? AND printing_id = ? AND is_foil = ? AND quantity > 0 GROUP BY condition`;

  // Other decks of the caller's that list the card — any printing — so a
  // copy sleeved elsewhere is fetched from that deck box rather than searched
  // for in storage. These are the caller's own decks; nothing of a partner's.
  const elsewhereStmt = `SELECT DISTINCT d.id, d.name, d.status FROM deck_cards dc
       JOIN decks d ON dc.deck_id = d.id
       JOIN printings p ON dc.printing_id = p.id
      WHERE d.user_id = ? AND d.id != ? AND p.card_id = ?
        AND COALESCE(dc.board_type, 'mainboard') != 'maybeboard'
      ORDER BY d.name`;

  const readiness = getDeckReadiness(userId, deckId);
  const missingByCard = new Map((readiness?.shortfalls || [])
    .filter((s) => (s.missing || 0) > 0)
    .map((s) => [s.cardId, s.missing]));

  const cards = [];
  const basics = [];
  for (const row of rows) {
    if (isBasicLand(row)) {
      basics.push({ name: row.name, quantity: row.quantity });
      continue;
    }
    cards.push({
      key: `${row.uuid}|${row.is_foil ? 1 : 0}`,
      uuid: row.uuid,
      isFoil: Boolean(row.is_foil),
      quantity: row.quantity,
      pulled: Math.min(row.quantity, progress.get(`${row.uuid}|${row.is_foil ? 1 : 0}`) || 0),
      isCommander: Boolean(row.is_commander),
      inSideboard: Boolean(row.in_sideboard),
      cardId: row.card_id,
      name: row.name,
      manaCost: row.mana_cost || '',
      cmc: Number(row.cmc) || 0,
      colors: row.colors || '',
      typeLine: row.type_line || '',
      rarity: row.rarity || '',
      setCode: row.set_code,
      setName: row.set_name || row.set_code,
      keyrune: row.keyrune_code || row.set_code,
      collectorNumber: row.collector_number,
      imageUrl: row.image_url,
      conditions: db.all(conditionsStmt, [userId, row.printing_id, row.is_foil ? 1 : 0])
        .map((c) => ({ condition: c.condition, quantity: c.quantity })),
      // Readiness counts by card, across printings; a missing copy is charged
      // to every printing row of that card, which is the honest reading when
      // the deck lists the card twice in different printings.
      missing: missingByCard.get(row.card_id) || 0,
      alsoIn: db.all(elsewhereStmt, [userId, deckId, row.card_id]),
    });
  }

  // Basics summed by name: they are free and usually in a pile of their own.
  const basicTotals = new Map();
  for (const b of basics) basicTotals.set(b.name, (basicTotals.get(b.name) || 0) + b.quantity);

  return {
    deck,
    layout: getPullLayout(userId),
    cards,
    basics: [...basicTotals].map(([name, quantity]) => ({ name, quantity }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function setPulled(userId, deckId, { uuid, isFoil = false, pulled }) {
  ownDeck(userId, deckId);
  const n = Math.max(0, Math.floor(Number(pulled) || 0));
  if (!uuid) throw new Error('A printing is required');
  if (n === 0) {
    db.run('DELETE FROM deck_pull_progress WHERE deck_id = ? AND printing_uuid = ? AND is_foil = ?',
      [deckId, uuid, isFoil ? 1 : 0]);
  } else {
    db.run(
      `INSERT INTO deck_pull_progress (deck_id, printing_uuid, is_foil, pulled, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(deck_id, printing_uuid, is_foil) DO UPDATE SET pulled = excluded.pulled, updated_at = CURRENT_TIMESTAMP`,
      [deckId, uuid, isFoil ? 1 : 0, n]
    );
  }
  return { uuid, isFoil: Boolean(isFoil), pulled: n };
}

export function resetPulled(userId, deckId) {
  ownDeck(userId, deckId);
  db.run('DELETE FROM deck_pull_progress WHERE deck_id = ?', [deckId]);
  return { reset: true };
}
