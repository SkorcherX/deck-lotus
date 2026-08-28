import db from '../db/connection.js';
import { recordDeckEvent, AUDIT_ACTIONS } from './auditService.js';
// One parser for both paste boxes — see the note in cardLines.js about the two
// having drifted apart while a comment claimed they agreed.
import { parseCardLine } from '../shared/cardLines.js';

/**
 * Parse deck list from various formats
 * Supports: Moxfield, Arena, MTGO, plain text
 */
export function parseDeckList(text) {
  const lines = text.trim().split('\n').filter(line => line.trim());
  const cards = [];
  let currentSection = 'mainboard'; // mainboard, sideboard, commander

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines
    if (!trimmedLine) continue;

    // Check for section headers. The word has to be the whole line (bar a
    // colon or a count) — now that a bare card name is a valid line,
    // "Commander's Sphere" must not be read as the start of a section.
    if (/^(sideboard|commander|deck|companion)[:\s]*\d*$/i.test(trimmedLine)) {
      if (/^sideboard/i.test(trimmedLine)) currentSection = 'sideboard';
      if (/^commander/i.test(trimmedLine)) currentSection = 'commander';
      if (/^deck/i.test(trimmedLine)) currentSection = 'mainboard';
      continue;
    }

    // Parse card line
    const parsed = parseCardLine(trimmedLine);
    if (parsed) {
      cards.push({
        ...parsed,
        line: trimmedLine,
        isSideboard: currentSection === 'sideboard',
        isCommander: currentSection === 'commander'
      });
    }
  }

  return cards;
}


/**
 * Normalize card name for database lookup
 * Handles DFC (double-faced card) separator differences between sources
 */
function normalizeCardName(name) {
  // Convert single slash with spaces to double slash (Moxfield -> MTGJSON format)
  // Example: "Kefka, Court Mage / Kefka, Ruler of Ruin" -> "Kefka, Court Mage // Kefka, Ruler of Ruin"
  return name.replace(/\s\/\s/g, ' // ');
}

/**
 * Find card in database by name and optional set/collector number
 */
export function findCard(name, setCode = null, collectorNumber = null) {
  // Set code plus collector number identifies a single printing on its own,
  // which is why the inventory bulk add accepts lines that carry no name.
  if (setCode && collectorNumber && !name) {
    return db.get(
      `SELECT c.id, c.name, p.id as printing_id, p.set_code, p.collector_number
       FROM printings p
       JOIN cards c ON c.id = p.card_id
       WHERE p.set_code = ? AND p.collector_number = ? COLLATE NOCASE
       LIMIT 1`,
      [setCode.toUpperCase(), String(collectorNumber)]
    ) || null;
  }

  if (!name) return null;

  // Normalize the card name for consistent matching
  const normalizedName = normalizeCardName(name);

  // Try exact match with set and collector number
  if (setCode && collectorNumber) {
    const card = db.get(
      `SELECT c.id, c.name, p.id as printing_id, p.set_code, p.collector_number
       FROM cards c
       JOIN printings p ON c.id = p.card_id
       WHERE c.name = ? AND p.set_code = ? AND p.collector_number = ?
       LIMIT 1`,
      [normalizedName, setCode, collectorNumber]
    );
    if (card) return card;

    // Fallback: Try matching as front face of DFC with set and collector number
    const dfcCard = db.get(
      `SELECT c.id, c.name, p.id as printing_id, p.set_code, p.collector_number
       FROM cards c
       JOIN printings p ON c.id = p.card_id
       WHERE c.name LIKE ? AND p.set_code = ? AND p.collector_number = ?
       LIMIT 1`,
      [normalizedName + ' //%', setCode, collectorNumber]
    );
    if (dfcCard) return dfcCard;
  }

  // Try match with set only
  if (setCode) {
    const card = db.get(
      `SELECT c.id, c.name, p.id as printing_id, p.set_code, p.collector_number
       FROM cards c
       JOIN printings p ON c.id = p.card_id
       WHERE c.name = ? AND p.set_code = ?
       LIMIT 1`,
      [normalizedName, setCode]
    );
    if (card) return card;

    // Fallback: Try matching as front face of DFC with set only
    const dfcCard = db.get(
      `SELECT c.id, c.name, p.id as printing_id, p.set_code, p.collector_number
       FROM cards c
       JOIN printings p ON c.id = p.card_id
       WHERE c.name LIKE ? AND p.set_code = ?
       LIMIT 1`,
      [normalizedName + ' //%', setCode]
    );
    if (dfcCard) return dfcCard;
  }

  // Fall back to name-only search
  const card = db.get(
    `SELECT c.id, c.name, p.id as printing_id, p.set_code, p.collector_number
     FROM cards c
     JOIN printings p ON c.id = p.card_id
     WHERE c.name = ?
     LIMIT 1`,
    [normalizedName]
  );
  if (card) return card;

  // Final fallback: Try matching as front face of DFC (name only)
  const dfcCard = db.get(
    `SELECT c.id, c.name, p.id as printing_id, p.set_code, p.collector_number
     FROM cards c
     JOIN printings p ON c.id = p.card_id
     WHERE c.name LIKE ?
     LIMIT 1`,
    [normalizedName + ' //%']
  );

  return dfcCard;
}

/**
 * Import deck from parsed card list
 */
export function importDeck(userId, deckName, format, cardList) {
  // Create deck
  const result = db.prepare(
    `INSERT INTO decks (user_id, name, format, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`
  ).run(userId, deckName, format || '');

  const deckId = result.lastInsertRowid;

  // Pasting a decklist is the other bulk entry point where a wrong set code
  // or collector number turns into the wrong printing without anybody
  // noticing, so it is logged line by line, the same as an inventory import.
  const batchId = `deck-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  recordDeckEvent({
    userId,
    action: AUDIT_ACTIONS.DECK_CREATE,
    source: 'deck_import',
    deckId,
    deckName: deckName,
    detail: { batchId, format: format || null, lines: cardList.length },
  });

  // Add cards to deck. Finish and board are part of a deck card's identity —
  // deck_cards is keyed UNIQUE(deck_id, printing_id, board_type, is_foil) since
  // migration 038 — so the same printing listed twice has to add up rather than
  // collide.
  const insertCard = db.prepare(
    `INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_commander, board_type, is_foil)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  // Process each card in the list
  let imported = 0;
  let notFound = 0;
  // Lines that resolved to nothing are handed back rather than only logged:
  // a deck that comes out empty with a success message reads as the import
  // being broken, when it is usually three bad set codes.
  const unresolved = [];

  for (const cardData of cardList) {
    const card = findCard(cardData.name, cardData.setCode, cardData.collectorNumber);

    if (!card) {
      notFound++;
      unresolved.push({
        line: cardData.line ?? null,
        name: cardData.name ?? null,
        setCode: cardData.setCode ?? null,
        collectorNumber: cardData.collectorNumber ?? null,
        quantity: cardData.quantity,
      });
      console.warn(`Card not found: ${cardData.name || ''}${cardData.setCode ? ` (${cardData.setCode})` : ''}${cardData.collectorNumber ? ` ${cardData.collectorNumber}` : ''}`);
      continue;
    }

    const isFoil = cardData.isFoil ? 1 : 0;
    const boardType = cardData.isSideboard ? 'sideboard' : 'mainboard';
    const isSideboard = boardType === 'sideboard' ? 1 : 0;

    // Matched on the board, the same thing the key is on. Looking one up by
    // is_sideboard and inserting by board_type is how the two disagreed.
    const existing = db.get(
      `SELECT id, quantity FROM deck_cards
       WHERE deck_id = ? AND printing_id = ? AND board_type = ? AND is_foil = ?`,
      [deckId, card.printing_id, boardType, isFoil]
    );

    const before = existing?.quantity || 0;

    if (existing) {
      db.run(
        `UPDATE deck_cards SET quantity = quantity + ? WHERE id = ?`,
        [cardData.quantity, existing.id]
      );
    } else {
      insertCard.run(
        deckId,
        card.printing_id,
        cardData.quantity,
        isSideboard,
        cardData.isCommander ? 1 : 0,
        boardType,
        isFoil
      );
    }

    // What the line said, next to what it resolved to.
    recordDeckEvent({
      userId,
      action: AUDIT_ACTIONS.DECK_CARD_ADD,
      source: 'deck_import',
      deckId,
      deckName,
      printingId: card.printing_id,
      quantityBefore: before,
      quantityAfter: before + cardData.quantity,
      detail: {
        batchId,
        boardType,
        entered: {
          cardName: cardData.name ?? null,
          setCode: cardData.setCode ?? null,
          collectorNumber: cardData.collectorNumber ?? null,
          quantity: cardData.quantity,
          isFoil: !!cardData.isFoil,
        },
      },
    });

    imported++;
  }

  return { deckId, imported, notFound, unresolved };
}
