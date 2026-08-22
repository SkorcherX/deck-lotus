// ntfy.sh push notification integration
// Requires NTFY_TOPIC env var. NTFY_URL defaults to https://ntfy.sh

function getNtfyUrl() {
  const base = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return null;
  return `${base}/${topic}`;
}

export function isConfigured() {
  return !!process.env.NTFY_TOPIC;
}

export async function sendPriceAlert({ cardName, foundPrice, threshold, condition }) {
  const url = getNtfyUrl();
  if (!url) {
    console.warn('ntfy not configured (NTFY_TOPIC missing), skipping notification');
    return;
  }

  const condLabel = { nm: 'NM', lp: 'LP', mp: 'MP', hp: 'HP', dm: 'DM', any: 'Any' }[condition] || condition.toUpperCase();
  const title = `Price Alert: ${cardName}`;
  const message = threshold != null
    ? `${cardName} (${condLabel}) is now $${foundPrice.toFixed(2)} — below your $${threshold.toFixed(2)} threshold!`
    : `${cardName} (${condLabel}) hit a new low: $${foundPrice.toFixed(2)}!`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Title: title,
      Priority: 'default',
      Tags: 'moneybag,card_index',
      'Content-Type': 'text/plain',
    },
    body: message,
  });

  if (!res.ok) {
    throw new Error(`ntfy notification failed: ${res.status}`);
  }
}

/** One line summarising a side of a trade, e.g. "2x Lightning Bolt, Brainstorm". */
function summarise(items) {
  if (items.length === 0) return 'nothing';

  const names = items.map((i) => (i.quantity > 1 ? `${i.quantity}x ${i.cardName}` : i.cardName));

  return names.length > 3
    ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
    : names.join(', ');
}

async function push({ title, message, tags, priority = 'default' }) {
  const url = getNtfyUrl();

  if (!url) {
    console.warn('ntfy not configured (NTFY_TOPIC missing), skipping notification');
    return;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Title: title,
      Priority: priority,
      Tags: tags,
      'Content-Type': 'text/plain',
    },
    body: message,
  });

  if (!res.ok) {
    throw new Error(`ntfy notification failed: ${res.status}`);
  }
}

/**
 * A trade is waiting for someone to answer.
 *
 * The trade is shaped from the proposer's point of view, so `giving` is what
 * the recipient stands to receive. Worded from the recipient's side, since
 * they are the one who has to act on it.
 */
export async function sendTradeProposed(trade) {
  await push({
    title: `Trade from ${trade.fromUsername}`,
    message:
      `${trade.fromUsername} wants to send you ${summarise(trade.giving)}` +
      ` for ${summarise(trade.receiving)}.`,
    tags: 'handshake,card_index',
  });
}

/**
 * Somebody has been shopping your collection and wants an answer.
 *
 * Shaped from the initiator's point of view, so `receiving` is what they have
 * asked you for. Worded to the owner, because the next move is theirs: they
 * pick what they want back.
 */
export async function sendTradeRequested(trade) {
  await push({
    title: `${trade.fromUsername} wants to trade`,
    message:
      `${trade.fromUsername} has picked out ${summarise(trade.receiving)} from your collection.` +
      ` Have a look through theirs and choose what you want back.`,
    tags: 'shopping_cart,card_index',
  });
}

/**
 * A shopping request came back with a second half, so the trade is now whole
 * and waiting on whoever started it.
 *
 * Shaped from the counter-offerer's point of view: `receiving` is what they
 * picked out of the initiator's collection.
 */
export async function sendTradeCountered(trade) {
  // Cards they kept back are worth naming here rather than leaving the asker
  // to spot what is missing from their own list.
  const turnedDown = trade.declinedItems.length
    ? ` They are hanging on to ${summarise(trade.declinedItems)}.`
    : '';

  await push({
    title: `${trade.toUsername} answered your request`,
    message:
      `They want ${summarise(trade.receiving)} for the ${summarise(trade.giving)} you asked for.` +
      `${turnedDown} It is yours to accept or turn down.`,
    tags: 'handshake,card_index',
  });
}

/** A trade went through, and both collections have already moved. */
export async function sendTradeAccepted(trade) {
  await push({
    title: `Trade accepted: ${trade.toUsername} and ${trade.fromUsername}`,
    message: 'Both collections have been updated. Any deck left short will say so.',
    tags: 'white_check_mark,card_index',
  });
}
