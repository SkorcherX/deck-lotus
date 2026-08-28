/**
 * Parsing one line of a pasted card list.
 *
 * ── Why this is shared, and why it lives here ───────────────────────────────
 * There are two boxes people paste card lists into — the deck importer and the
 * inventory bulk add — and they are supposed to accept the same thing, because
 * people paste the same text into both. That was written down and then not
 * enforced, and the two drifted: the deck importer learned the Moxfield form
 * `1 Abundant Growth (ECC) 97` and the inventory parser never did, so the same
 * line imported into a deck and came back "Card not found" from the inventory.
 *
 * A comment saying two copies must agree is not a mechanism. One function is.
 *
 * It lives in `src/shared` for the reason `cardHash.js` does: the browser
 * resolves this at build time, when the whole repo is present, so the client
 * may reach into the server tree; the server resolves it at runtime inside an
 * image that ships `src` and the *built* client but never `client/src`, so it
 * must never reach the other way. No DOM, no Node built-ins, no imports.
 *
 * ── The formats ─────────────────────────────────────────────────────────────
 *   Lightning Bolt                 quantity defaults to one
 *   4 Lightning Bolt               plain
 *   4x Lightning Bolt              the x is optional
 *   1 Abundant Growth (ECC) 97     Moxfield, Archidekt, Deckbox
 *   1 Abundant Growth (ECC)        the collector number is optional
 *   4 Lightning Bolt [M21]         TCGplayer
 *   1 FDN 1                        set and collector number, no name at all
 *   ... *F*  or  ... (F)           foil, marker anywhere on the line
 *   // comment                     dropped
 */

/**
 * @returns {{quantity: number, name: string|null, setCode: string|null,
 *            collectorNumber: string|null, isFoil: boolean} | null}
 *   Null for a line that carries no card — blank, or a comment.
 */
export function parseCardLine(line) {
  if (typeof line !== 'string') return null;

  let rest = line.trim();

  // Comment lines from exported lists.
  if (!rest || /^(\/\/|#)/.test(rest)) return null;

  // The foil marker can sit anywhere, so it is taken out before anything else
  // tries to read the end of the line. `(F)` is stripped here and so cannot be
  // mistaken for a set code by the Moxfield branch below.
  const isFoil = /\*F\*/i.test(rest) || /\(F\)/i.test(rest);
  rest = rest.replace(/\*F\*/gi, '').replace(/\(F\)/gi, '').trim();

  // Leading quantity. A line with no count means one copy.
  const quantityMatch = rest.match(/^(\d+)\s*x?\s+(.+)$/i);
  const quantity = quantityMatch ? parseInt(quantityMatch[1], 10) : 1;
  const remainder = (quantityMatch ? quantityMatch[2] : rest).trim();

  if (!remainder) return null;

  // Set code and collector number, with no card name. The second token must
  // contain a digit so real two-word card names ("Sol Ring") do not match, and
  // the set code is short enough that a leading word of a card name
  // ("Borrowing 100,000 Arrows") will not be mistaken for one.
  const setNumber = remainder.match(
    /^([A-Za-z0-9]{2,6})[\s-]+([A-Za-z0-9★†-]*\d[A-Za-z0-9★†-]*)$/
  );
  if (setNumber) {
    return {
      quantity,
      name: null,
      setCode: setNumber[1].toUpperCase(),
      collectorNumber: setNumber[2],
      isFoil,
    };
  }

  // Moxfield and friends: "Card Name (SET) 123", the collector number optional.
  // The set group is alphanumerics only, so a card whose name carries a
  // parenthetical of real words — "Erase (Not the Urza's Legacy One)" — falls
  // through to being treated as a name, which is what it is.
  const moxfield = remainder.match(/^(.+?)\s*\(([A-Z0-9]+)\)\s*([A-Z0-9-]+)?$/i);
  if (moxfield) {
    return {
      quantity,
      name: moxfield[1].trim() || null,
      setCode: moxfield[2].toUpperCase(),
      collectorNumber: moxfield[3] || null,
      isFoil,
    };
  }

  // TCGplayer: "Card Name [SET]".
  const tcg = remainder.match(/^(.+?)\s*\[([A-Z0-9]+)\]$/i);
  if (tcg) {
    return {
      quantity,
      name: tcg[1].trim() || null,
      setCode: tcg[2].toUpperCase(),
      collectorNumber: null,
      isFoil,
    };
  }

  return { quantity, name: remainder, setCode: null, collectorNumber: null, isFoil };
}
