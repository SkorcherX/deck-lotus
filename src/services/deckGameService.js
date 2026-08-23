import db from '../db/connection.js';

/**
 * A deck's match record, kept as a log of individual games.
 *
 * Totals are always derived, never stored. A stored counter and a game log
 * can disagree — and when they do there is no way to tell which one is the
 * lie — so there is only ever one copy of the truth here.
 */

const RESULTS = ['win', 'loss', 'draw'];

function assertOwnsDeck(deckId, userId) {
  const deck = db.get(
    `SELECT id, name, format FROM decks WHERE id = ? AND user_id = ?`,
    [deckId, userId]
  );

  if (!deck) {
    throw new Error('Deck not found or access denied');
  }

  return deck;
}

function normalizeGame(input, deck) {
  const result = String(input.result || '').toLowerCase();

  if (!RESULTS.includes(result)) {
    throw new Error(`result must be one of: ${RESULTS.join(', ')}`);
  }

  // A game with no date given is one being logged as it finishes.
  const playedAt = input.playedAt
    ? String(input.playedAt).slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(playedAt)) {
    throw new Error('playedAt must be a YYYY-MM-DD date');
  }

  const trimmed = (value) => {
    const text = value === undefined || value === null ? '' : String(value).trim();
    return text === '' ? null : text;
  };

  return {
    result,
    playedAt,
    opponent: trimmed(input.opponent),
    opponentDeck: trimmed(input.opponentDeck),
    // Defaults to the deck's own format so the common case needs no typing,
    // while a deck played in more than one format can still say which.
    format: trimmed(input.format) || deck?.format || null,
    notes: trimmed(input.notes),
  };
}

/** Record one game. */
export function addDeckGame(deckId, userId, input) {
  const deck = assertOwnsDeck(deckId, userId);
  const game = normalizeGame(input, deck);

  const result = db.run(
    `INSERT INTO deck_games
       (deck_id, user_id, result, played_at, opponent, opponent_deck, format, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      deckId,
      userId,
      game.result,
      game.playedAt,
      game.opponent,
      game.opponentDeck,
      game.format,
      game.notes,
    ]
  );

  return getDeckGame(result.lastInsertRowid, userId);
}

/** Correct a game that was entered wrong. */
export function updateDeckGame(gameId, userId, input) {
  const existing = db.get(
    `SELECT g.*, d.format as deck_format
       FROM deck_games g
       JOIN decks d ON g.deck_id = d.id
      WHERE g.id = ? AND g.user_id = ?`,
    [gameId, userId]
  );

  if (!existing) {
    throw new Error('Game not found or access denied');
  }

  const game = normalizeGame(
    {
      result: input.result ?? existing.result,
      playedAt: input.playedAt ?? existing.played_at,
      opponent: input.opponent ?? existing.opponent,
      opponentDeck: input.opponentDeck ?? existing.opponent_deck,
      format: input.format ?? existing.format,
      notes: input.notes ?? existing.notes,
    },
    { format: existing.deck_format }
  );

  db.run(
    `UPDATE deck_games
        SET result = ?, played_at = ?, opponent = ?, opponent_deck = ?, format = ?, notes = ?
      WHERE id = ? AND user_id = ?`,
    [
      game.result,
      game.playedAt,
      game.opponent,
      game.opponentDeck,
      game.format,
      game.notes,
      gameId,
      userId,
    ]
  );

  return getDeckGame(gameId, userId);
}

export function deleteDeckGame(gameId, userId) {
  const result = db.run(
    `DELETE FROM deck_games WHERE id = ? AND user_id = ?`,
    [gameId, userId]
  );

  return result.changes > 0;
}

export function getDeckGame(gameId, userId) {
  return db.get(
    `SELECT * FROM deck_games WHERE id = ? AND user_id = ?`,
    [gameId, userId]
  );
}

/** Every game for a deck, newest first, with the record they add up to. */
export function getDeckGames(deckId, userId, { limit = 200 } = {}) {
  assertOwnsDeck(deckId, userId);

  const games = db.all(
    `SELECT * FROM deck_games
      WHERE deck_id = ? AND user_id = ?
      ORDER BY played_at DESC, id DESC
      LIMIT ?`,
    [deckId, userId, Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500)]
  );

  return { games, record: getDeckRecord(deckId, userId) };
}

function shapeRecord(row) {
  const wins = row?.wins || 0;
  const losses = row?.losses || 0;
  const draws = row?.draws || 0;
  const played = wins + losses + draws;

  return {
    wins,
    losses,
    draws,
    played,
    // Draws count as played but not as wins, which is how a match record is
    // normally read. Null rather than 0 when nothing has been played, so the
    // UI can show "no games yet" instead of a discouraging 0%.
    winRate: played === 0 ? null : Math.round((wins / played) * 1000) / 10,
  };
}

export function getDeckRecord(deckId, userId) {
  const row = db.get(
    `SELECT
       SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) as wins,
       SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) as losses,
       SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) as draws
     FROM deck_games
     WHERE deck_id = ? AND user_id = ?`,
    [deckId, userId]
  );

  return shapeRecord(row);
}

/**
 * Records for every one of a user's decks, keyed by deck id.
 *
 * One query for the whole deck list rather than one per deck — the list page
 * renders every deck at once and would otherwise fan out.
 */
export function getDeckRecords(userId) {
  const rows = db.all(
    `SELECT deck_id,
       SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) as wins,
       SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) as losses,
       SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) as draws
     FROM deck_games
     WHERE user_id = ?
     GROUP BY deck_id`,
    [userId]
  );

  return new Map(rows.map((row) => [row.deck_id, shapeRecord(row)]));
}
