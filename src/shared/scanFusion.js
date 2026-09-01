/**
 * The pure half of scan resolution: fusion, tiers and set biasing.
 *
 * Everything here is arithmetic over candidates that someone else looked up —
 * no database, no index, no filesystem. That split is the point. The device is
 * about to run this search itself (docs/ON_DEVICE_MATCHING.md: a five-probe
 * match measured 12ms on the phone against 626-741ms of asking the server), and
 * a second copy of the tier rules living in the client is exactly how the two
 * ends start disagreeing about what `confident` means. So the rules live here,
 * beside cardHash.js and cardGeometry.js, for the same reason those do.
 *
 * `scanService.resolveScanFused` remains the server's entry point: it does the
 * text lookup, the index passes and the hydration, then hands the result to
 * `fuseScanResult` below. The thresholds live here too, since a client that
 * searches the index has to agree with the server about what counts as a match.
 */

import { ART_HASH_BYTES } from './cardHash.js';

const ART_BITS = ART_HASH_BYTES * 8;
/**
 * How far a capture's art hash may sit from a reference and still be considered
 * the same illustration, as a fraction of the hash width.
 *
 * Measured against real Scryfall art (see cardHash.js): a same-illustration
 * pair sat at 12.5% and the closest pair of genuinely distinct cards at 39.2%.
 * 22% was placed between those, nearer the tolerant end — the measurement
 * compared two clean scans, while a real capture also carries glare, white
 * balance and a hand-held angle, and the cost of the two errors is not
 * symmetric. A miss puts one card in the review pile, where the user was going
 * to look anyway; a false match that agrees with a bad OCR read is how a wrong
 * card gets marked confident. The fusion in scanService is what keeps that
 * second case from being decided here alone.
 *
 * ── Why 27% and not 22% ─────────────────────────────────────────────────────
 * Two cards in a recorded session sat at 64 bits against a budget of 56, with
 * the nearest *wrong* card at 90 and 92. Both were the right answer, missed by
 * eight bits, with nearly thirty bits of clear air above them — and across four
 * sessions the hash has never once ranked a wrong card first.
 *
 * The move is safe because there is almost nothing in the band to let in.
 * Measured over the reference set itself: for 1505 sampled cards, the distance
 * to the nearest reference that is a *different* card.
 *
 *     0- 27 : 19 cards        ← genuine art sharing under two names
 *    28- 79 : 15 cards        ← nearly empty
 *    80-105 : 1471 cards      ← where distinct cards actually live
 *
 * Raising the bar from 56 to 69 admits three more of 1505, 1.5% to 1.7%. The
 * bulk does not begin until 80, so 69 sits inside the empty band with room on
 * both sides rather than on the edge of the population.
 *
 * The 19 close pairs are not hash failures. They are one illustration printed
 * under two names — Alchemy rebalances against their originals, the two faces
 * of a transforming card, the un-set sticker goblins — and offering both is
 * right, not a false positive.
 *
 * ART_STRONG_THRESHOLD is deliberately unchanged, so nothing newly reaches
 * `confident`: a match admitted by this widening still lands in review, which
 * is the whole reason widening it is cheap.
 *
 * ── Why 30% and not 27% ─────────────────────────────────────────────────────
 * Sleeves. A sleeved card costs roughly twenty bits — measured on the same nine
 * cards shot sleeved and bare in the same light — and it put a run of true
 * matches at 70 to 76, just the wrong side of 69. Five captures across five
 * recorded sessions sat in that strip.
 *
 * The crowding measurement was repeated for the step, sampling 401 references
 * against all 112,815, distance to the nearest reference that is a different
 * card:
 *
 *     0- 39 :  1.2%           ← genuine art sharing, as before
 *    60- 69 :  0.5%
 *    70- 79 :  1.0%           ← what this step admits
 *    80- 89 : 27.7%           ← the population starts here
 *    90-    : 69.6%
 *
 * So 77 bits still sits below the bulk, and 82 would not — which is why the
 * step stops here despite 0.32 scoring two matches better on these bundles.
 *
 * What the five recovered captures actually were is the part worth trusting:
 * replayed across the sleeved sessions they came back as Fertile Ground, Ingot
 * Chewer and Jungle Shrine — in each case the same card the *unsleeved* run of
 * the same stack had identified in that position. Not one of them was a card
 * that could not have been on the table. Every one landed in `unsure`, since
 * the strong threshold has not moved.
 *
 *     bundle              at 0.27   at 0.30
 *     sleeved desk          4/9       5/9
 *     sleeved kitchen       4/9       6/9
 *     bare kitchen          7/9       7/9
 *     bare, worker build    8/9       8/9
 *     sleeved, latest       6/9       8/9
 */
export const ART_MATCH_THRESHOLD = 0.3;

/**
 * Distance below which the top match is treated as unambiguous. Well inside the
 * same-illustration measurement, so a clean capture short-circuits the rest.
 */
export const ART_STRONG_THRESHOLD = 0.16;

/** Whether the best match is close enough to be believed on its own. */
export function isStrongMatch(match) {
  return Boolean(match) && match.artDistance / ART_BITS <= ART_STRONG_THRESHOLD;
}

/**
 * How close a match sits to the threshold, as a confidence in 0..1.
 *
 * Linear between an exact hit and a match sitting on the threshold, so the
 * number means the same thing as the text-side confidences resolveScan
 * produces and the two can be fused.
 */
export function matchConfidence(artDistance, threshold = ART_MATCH_THRESHOLD) {
  return Math.max(0, Math.min(1, 1 - artDistance / ART_BITS / threshold));
}

/**
 * What the two signals together concluded, and therefore how much of the
 * reviewer's attention this row needs.
 *
 * `confident` is the only tier that lets a row collapse out of the review
 * table, so it is deliberately the narrowest of the four. The rest all mean
 * "look at this" and differ only in what the reviewer is being asked to decide.
 */
export const SCAN_TIERS = {
  /** Art and text independently reached the same printing. Nothing to decide. */
  CONFIDENT: 'confident',
  /**
   * The art is certain but the printing is not — reprints sharing one
   * illustration, or a pre-2015 card with no collector block to read. The
   * reviewer is picking a printing, not a card.
   */
  PICK_PRINTING: 'pick-printing',
  /** Both signals are strong and they disagree. The reviewer picks between them. */
  CONFLICT: 'conflict',
  /** Weak, or only one signal spoke. The old text-only behaviour. */
  UNSURE: 'unsure',
};

/**
 * How close two printings of one card have to sit before the art is treated as
 * having no opinion about which is which, in bits of the 256-bit art hash.
 *
 * Reprints share an illustration, so what separates their references is not the
 * picture — it is the difference between two scans of one picture. A recorded
 * session put four printings of Seaside Citadel at exactly 50, three of Ingot
 * Chewer within 4, and reordered all of them when the same photograph was
 * hashed at another rung of the framing ladder.
 *
 * 12 bits, and the anchor is elsewhere in this pipeline: hashing *the same
 * pixels* at the camera's resolution rather than the reference's moved the art
 * hash 10-12 bits, flat, at every size (see HASH_HEIGHT). A gap that a change
 * of scale can manufacture on identical input is not evidence about which
 * printing is in someone's hand.
 *
 * Measured against three recorded ECC sessions — how many of nine cards came
 * back as the ECC printing that was actually on the table:
 *
 *      tie bits    6     12    20    30
 *      session A   7/9   8/9   8/9   9/9
 *      session B   3/9   8/9   8/9   8/9
 *      session C   6/9   6/9   6/9   6/9
 *
 * Most of it arrives by 12 and the rest is bought by overriding differences
 * large enough to be real — a borderless or showcase printing genuinely differs
 * from a normal one, and 30 is most of the way to the 41 bits that separate a
 * confident match from an unsure one. So: 12.
 */
const PRINTING_TIE_BITS = 12;

/**
 * The run of leading candidates the art could not separate.
 *
 * Contiguous from the front, and all one card: anything below a candidate the
 * art genuinely separated is not tied with the winner however close it looks.
 * Returns how many, which is 0 or 1 when there is nothing to order.
 */
function tiedRun(merged) {
  const best = merged[0];
  if (!best || best.artDistance === null || best.artDistance === undefined) return 0;

  let end = 0;
  while (
    end < merged.length &&
    merged[end].cardId === best.cardId &&
    Number.isFinite(merged[end].artDistance) &&
    merged[end].artDistance - best.artDistance <= PRINTING_TIE_BITS
  ) {
    end++;
  }

  return end;
}

/**
 * Order tied printings: by the sets a session has already been sure about, and
 * then — where that says nothing — toward the cheaper printing.
 *
 * The set tally is the stronger evidence and sorts first, so this never
 * overrides it; the price only ever separates printings the tally scored
 * equally, which in a session that has resolved nothing is all of them.
 *
 * Why price at all. Among reprints the art has tied, the list is currently led
 * by whichever printing a few bits of resampling favoured, and the candidates
 * are not equally likely to be the card in someone's hand: the dear one is dear
 * because it is scarce. The Flusterstorm that started this was $9.78 as SOA 18
 * and $208.59 as the foil-only SOA 148, and there are a great many more of the
 * first. Leading with the cheaper one is right more often, and it fails softly
 * — a printing shown first still goes to review, and the reviewer is choosing
 * from the same list either way.
 *
 * Unpriced printings sort last. Not a claim that they are expensive: a price we
 * do not have cannot be the reason to promote something over one we do.
 *
 * Three rules, and the whole value of this depends on keeping them. They hold
 * for the price exactly as they held for the tally:
 *
 * 1. **Only printings of the card that already won.** This never changes which
 *    *card* is first. Neither a tally about sets nor a difference in price is
 *    evidence about identity.
 * 2. **Only where the art is genuinely tied**, within PRINTING_TIE_BITS. A
 *    distance the art actually separated is evidence; overriding it would be
 *    preferring a guess to a measurement of the picture.
 * 3. **Never promotes anything.** Tiers are decided before this runs, so a
 *    biased order cannot turn a printing choice into a `confident` one. Both
 *    rules are hints about which card is likelier to be in a pile, not proof
 *    about the one in hand.
 *
 * Mutates `merged` in place. Returns whether the price was what moved the
 * leader, so a recording can say when the order shown was the art's, the
 * stack's, or this.
 */
function applySetBias(merged, setBias) {
  if (!merged.length) return false;

  const tally = new Map(
    Object.entries(setBias || {})
      .filter(([code, count]) => code && Number.isFinite(count) && count > 0)
      .map(([code, count]) => [String(code).toUpperCase(), count])
  );

  const end = tiedRun(merged);
  if (end < 2) return false;

  const tied = merged.slice(0, end);
  const score = (candidate) => tally.get(String(candidate.setCode || '').toUpperCase()) || 0;

  // The tally's answer on its own, so the caller can be told which of the two
  // rules actually moved the leader. Stable within equal scores: the art's own
  // order is the fallback, not an alphabetical or arbitrary one.
  const bySet = [...tied].sort((a, b) => score(b) - score(a));

  const priceOf = (candidate) =>
    typeof candidate.price === 'number' && Number.isFinite(candidate.price)
      ? candidate.price
      : Infinity;

  const ordered = [...tied].sort((a, b) => score(b) - score(a) || priceOf(a) - priceOf(b));

  merged.splice(0, end, ...ordered);

  return ordered[0] !== bySet[0];
}

/**
 * Fuse a text lookup and an art-hash search into a ranked, tiered result.
 *
 * The pure core of `resolveScanFused`: given candidates someone else has looked
 * up, decide the order, the tier and the signals. See that function for why the
 * two signals are fused at all.
 *
 * @param {object} input
 * @param {{query: object, candidates: Array}} input.text  What resolveScan returned.
 * @param {Array<{artHash: string|null, frameHash: string|null}>} input.probes
 *        The framings offered, for the count reported in signals.
 * @param {{artHash: string|null, frameHash: string|null}} input.probe
 *        The framing that won, whose hashes are echoed back in `query`.
 * @param {number|null} input.probeIndex  Which framing that was, or null on no match.
 * @param {Array} input.hashMatches       The winning framing's matches, best first.
 * @param {Map<number, object>} [input.hydrated]
 *        Candidates for printings the art found and the text did not.
 * @param {object|null} [input.nearest]   Nearest reference, when nothing matched.
 * @param {object|null} [input.setBias]   Per-session tally of resolved sets.
 * @param {number} [input.cap]            Candidates to return.
 */
export function fuseScanResult({
  text,
  probes,
  probe = { artHash: null, frameHash: null },
  probeIndex = null,
  hashMatches = [],
  hydrated = null,
  nearest = null,
  setBias = null,
  cap = 10,
}) {
  const { artHash = null, frameHash = null } = probe || {};

  if (!hashMatches.length) {
    // No hash signal at all — no capture hash, no hash file, or nothing within
    // threshold. Reported honestly as single-signal rather than dressed up.
    //
    // When there was a hash and it simply matched nothing, `nearest` says how
    // close the nearest reference was. "No match" alone cannot distinguish a
    // capture framed slightly wrong, which is recoverable, from one that is not
    // a card at all — and a review screen full of bare "no match" rows leaves
    // nobody, including whoever has to fix it, any idea which they are looking
    // at.
    return {
      query: { ...text.query, artHash, frameHash },
      tier: SCAN_TIERS.UNSURE,
      candidates: text.candidates.slice(0, cap),
      signals: {
        text: text.candidates.length,
        hash: 0,
        agreed: false,
        bestArtDistance: null,
        nearest,
        probes: probes.length,
        probeIndex: null,
        // Stated rather than left undefined: the art matched nothing here, so
        // whatever the reader proposed is a proposal. A caller reading a
        // missing field as falsy would get the right answer by luck, and the
        // one thing this flag must never do is let a misread card be announced
        // as settled.
        nameCertain: false,
      },
    };
  }

  const textById = new Map(text.candidates.map((candidate) => [candidate.printingId, candidate]));
  const hashById = new Map(hashMatches.map((match) => [match.printingId, match]));

  const merged = [];

  for (const match of hashMatches) {
    const existing = textById.get(match.printingId);

    if (existing) {
      merged.push({
        ...existing,
        artDistance: match.artDistance,
        frameDistance: match.frameDistance,
        hashConfidence: match.confidence,
        // Agreement beats either signal alone, but the result stays under 1: it
        // is still a scan, and the review step is not a formality.
        //
        // Combined as a noisy-or rather than a mean, and that is the whole
        // point: agreement must never rank a printing *below* what one signal
        // alone already gave it. A mean does exactly that whenever the two
        // differ — averaging a strong read against a weak-but-correct one lands
        // between them, and the fixed bonus is not always enough to climb back.
        //
        // Seen on a real capture: OCR read "Springleaf Drum / ECL / 0260" at
        // 0.84 and the art independently found the same printing, but at 54 of
        // its 56-bit budget, so hash confidence was 0.041. The mean scored the
        // agreed printing 0.5*0.84 + 0.5*0.041 + 0.2 = 0.64, while three basic
        // lands the collector number alone had turned up kept 0.803 and took
        // the top of the list. Both signals were right, they agreed, and fusing
        // them buried the answer under Plains.
        //
        // Noisy-or is monotone in both inputs and never falls below either, so
        // a weak second signal can only ever help. It also repairs `agreed`
        // below, which asks whether the merged winner is the text's winner and
        // was reading false for the same reason.
        confidence:
          Math.round(
            Math.min(0.99, 1 - (1 - existing.confidence) * (1 - match.confidence)) * 1000
          ) / 1000,
        matchedBy: [...existing.matchedBy, 'art-hash'],
      });
      continue;
    }

    // Printings the hash found and the text did not still have to be shown. On
    // a pre-2015 card the hash is the *only* signal there is, and dropping its
    // finds for want of a collector block would discard the one thing that
    // worked. The caller supplies them, because turning a printing id into a
    // name and a price is a database question and this module does not ask
    // those; one with nothing to hydrate from simply carries fewer candidates.
    const row = hydrated ? hydrated.get(match.printingId) : null;
    if (!row) continue;

    merged.push({
      ...row,
      artDistance: match.artDistance,
      frameDistance: match.frameDistance,
      hashConfidence: match.confidence,
      confidence: Math.round(match.confidence * 1000) / 1000,
      nameSimilarity: null,
      matchedBy: ['art-hash'],
    });
  }

  // Text-only candidates keep their place, below anything the art agreed with.
  for (const candidate of text.candidates) {
    if (hashById.has(candidate.printingId)) continue;
    merged.push({ ...candidate, artDistance: null, frameDistance: null, hashConfidence: null });
  }

  // Printings the art actually found rank above printings only the text
  // proposed, and confidence orders within each group rather than across them.
  //
  // Without this a bad read does not merely fail to help, it actively buries
  // the right answer — because a text candidate's confidence says how
  // unambiguous the *database lookup* was, not how good the *read* was. Two
  // real captures, both with the art already correct:
  //
  //   OCR "A 7C POLSON 07 / CON" -> Darklit Gargoyle [CON 7] at 0.825,
  //      over Scarblade's Malice, which the art had at 42 bits and 0.392.
  //   OCR "M4 10 F / 195 ECL EN" -> Clachan Festival [ECL 10] at 0.788,
  //      over Safewright Cavalry, which the art had at 58 bits and 0.161.
  //
  // Both reads were noise. Both resolved to exactly one printing, which is what
  // made them look certain, and a wrong card went to the top of the list.
  //
  // This is only reached when the art matched something — the no-match case
  // returns above — so it never reorders a text-only result, and it cannot
  // disturb the case the fusion exists for: reprints sharing one illustration
  // are all art-backed, so the text still orders freely among them. What it
  // gives up is the case where the art matches a wrong card within threshold
  // *and* the text alone finds the right one. That is the rarer failure by a
  // wide margin — a different card lands within threshold about 1.7% of the
  // time, nearly always genuine art sharing — and the row still goes to review
  // with both offered.
  const artBacked = (candidate) => candidate.artDistance !== null && candidate.artDistance !== undefined;
  merged.sort((a, b) => (artBacked(b) ? 1 : 0) - (artBacked(a) ? 1 : 0) || b.confidence - a.confidence);

  const best = merged[0] || null;
  const bestHash = hashMatches[0];
  const bestText = text.candidates[0] || null;

  // Do the two signals name the same printing? Deliberately not "is either one
  // confident": a strong text read and a strong art match pointing at different
  // printings is exactly the case that must never collapse out of review.
  const agreed = Boolean(
    bestText && hashById.has(bestText.printingId) && best && best.printingId === bestText.printingId
  );

  // Printings whose art the search actually agreed with. "Only one printing
  // matched" is a claim about the art, not about the merged list, which also
  // carries every text-only candidate below it.
  const strongEnough = hashMatches.filter(isStrongMatch);

  // How many printings of the *same card* the art found. A reprint shares its
  // illustration with every other printing of it, so wherever this is above one
  // the art has named the card and has nothing whatever to say about which
  // printing is in the hand — the differences between them are the framing's
  // noise, not evidence.
  //
  // A recorded session settled this. Nine cards from one ECC precon, unsleeved,
  // came back naming half a dozen different sets: Seaside Citadel tied at 50
  // across MKC, BLC, ECC and PLST, Ingot Chewer at 64 across CM2, ECC and JVC,
  // and Abundant Growth was called `confident` for DMC at 36 while ECC — the
  // card actually on the table — sat outside the top four. Re-hashed at a
  // different rung of the probe ladder the order changed again. Which of a set
  // of reprints wins is decided by a few bits of resampling.
  //
  // That matters more here than a ranking usually would: this app stores and
  // prices *printings*, so collapsing a reprint out of review at `confident`
  // files the wrong set into someone's collection at the wrong price, silently.
  const bestCardSiblings = best
    ? merged.filter((candidate) => artBacked(candidate) && candidate.cardId === best.cardId)
    : [];
  const bestCardPrintings = bestCardSiblings.length;

  // What the printings still on the table are worth, low to high.
  //
  // The scanner quotes `best.price` — the top candidate's — and where the
  // printing is undecided that is a coin flip presented as a fact. Flusterstorm
  // was scanned out of an SOA precon and priced at $208.59, which is what the
  // foil-only SOA 148 goes for; the card in the hand was SOA 18, at $9.78.
  // Both were art-backed candidates of the same card, and which of them led the
  // list is decided by a few bits of resampling.
  //
  // So where more than one printing is in play the range is reported and the
  // caller shows it instead of a single figure. Null when there is nothing to
  // disagree about — one printing, or no priced ones — so a caller can simply
  // check for it rather than compare a low against a high.
  const siblingPrices = bestCardSiblings
    .map((candidate) => candidate.price)
    .filter((price) => typeof price === 'number' && Number.isFinite(price));
  const priceRange =
    siblingPrices.length > 1 && Math.min(...siblingPrices) !== Math.max(...siblingPrices)
      ? { low: Math.min(...siblingPrices), high: Math.max(...siblingPrices) }
      : null;

  const priceBiased = applySetBias(merged, setBias);

  // Whether the art agreed on *which card this is*, as distinct from which
  // printing of it. Every art-backed candidate belonging to one card means
  // there is nothing left to decide about the name, however many printings are
  // still on the table.
  //
  // Measured over nine recorded sessions: 61 captures resolved to something,
  // and in all 61 every candidate within the match threshold shared a single
  // card name. Not one had two names to choose between. So a tier of `unsure`
  // has been reporting doubt about the name that the evidence never had — it is
  // a printing-level verdict, and the name deserves its own.
  const nameCertain = Boolean(
    best && artBacked(best) && merged.filter(artBacked).every((c) => c.cardId === best.cardId)
  );

  let tier;
  if (agreed && isStrongMatch(bestHash)) {
    tier = SCAN_TIERS.CONFIDENT;
  } else if (!bestText && strongEnough.length === 1 && bestCardPrintings === 1) {
    // The art is certain and it matched exactly one printing in the whole
    // reference set — one printing of one card, so there is genuinely nothing
    // left to decide. Requiring a text read here would have meant a tesseract
    // pass to confirm an answer that had no alternative, which is what made
    // every card need review when the reader is off.
    //
    // The second half of that test is the one bought with a recorded session:
    // "only one printing scored strongly" is not the same claim as "only one
    // printing of this card matched at all". A reprint whose siblings sit just
    // the wrong side of the strong threshold used to collapse out of review on
    // the strength of a gap that is framing noise.
    tier = SCAN_TIERS.CONFIDENT;
  } else if (!bestText && isStrongMatch(bestHash)) {
    // The art is certain and there is nothing to place it with: a pre-2015 card,
    // a collector block lost to glare, or — much the commonest — a card printed
    // more than once. The card is known, the printing is not.
    tier = SCAN_TIERS.PICK_PRINTING;
  } else if (bestText && isStrongMatch(bestHash) && !agreed) {
    tier = SCAN_TIERS.CONFLICT;
  } else {
    tier = SCAN_TIERS.UNSURE;
  }

  return {
    query: { ...text.query, artHash, frameHash },
    tier,
    candidates: merged.slice(0, cap),
    signals: {
      text: text.candidates.length,
      hash: hashMatches.length,
      // Printings of the winning card the art matched. Above one means the
      // printing was chosen by hand, not by the scanner.
      printingsOfBest: bestCardPrintings,
      // The spread across those printings, where they disagree. See above.
      priceRange,
      // Whether a session's set tally was used to order tied printings, so a
      // recording says when the order shown was the art's and when it was the
      // stack's. See applySetBias.
      setBiased: !!setBias && bestCardPrintings > 1,
      // And whether the price was what moved the leader, which is only ever
      // among printings the tally scored equally. See applySetBias.
      priceBiased,
      // The name is settled even where the printing is not. See above.
      nameCertain,
      agreed,
      bestArtDistance: bestHash ? bestHash.artDistance : null,
      // Which of the offered framings won. On its own it is trivia; across a
      // recorded session it says whether the expansions are centred on where
      // detection actually stops, which is the only way to tune them on
      // evidence rather than on a guess about black borders.
      probes: probes.length,
      probeIndex,
    },
  };
}
