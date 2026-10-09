// ntfy.sh push notification integration.
//
// Configured in Settings (stored in app-settings.json) with the NTFY_URL /
// NTFY_TOPIC / NTFY_TOKEN env vars as the fallback for anything left blank.
// Settings win so the topic can be changed without recreating the container.
import { getSettings } from './settingsService.js';

const DEFAULT_URL = 'https://ntfy.sh';

/**
 * The ntfy config in force, and where each part came from. `overrides` lets
 * the test button try values the admin has typed but not yet saved.
 */
export function resolveNtfyConfig(overrides = {}) {
  const stored = getSettings().notifications || {};
  const pick = (key, envName, fallback = '') => {
    const override = typeof overrides[key] === 'string' ? overrides[key].trim() : '';
    if (override) return { value: override, source: 'form' };
    if (stored[key]) return { value: stored[key], source: 'settings' };
    if (process.env[envName]) return { value: process.env[envName], source: 'env' };
    return { value: fallback, source: fallback ? 'default' : null };
  };

  const url = pick('ntfyUrl', 'NTFY_URL', DEFAULT_URL);
  const topic = pick('ntfyTopic', 'NTFY_TOPIC');
  const token = pick('ntfyToken', 'NTFY_TOKEN');

  return {
    url: url.value.replace(/\/$/, ''),
    urlSource: url.source,
    topic: topic.value,
    topicSource: topic.source,
    token: token.value,
    tokenSource: token.source,
  };
}

export function isConfigured() {
  return !!resolveNtfyConfig().topic;
}

/**
 * The one place a notification leaves the server. Throws on an HTTP failure so
 * the test button can report it; scheduled callers already catch.
 */
async function post({ title, message, tags, priority = 'default' }, overrides) {
  const config = resolveNtfyConfig(overrides);
  if (!config.topic) {
    console.warn('ntfy not configured (no topic set), skipping notification');
    return { sent: false };
  }

  const headers = {
    Title: title,
    Priority: priority,
    Tags: tags,
    'Content-Type': 'text/plain',
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  let res;
  try {
    res = await fetch(`${config.url}/${encodeURIComponent(config.topic)}`, {
      method: 'POST',
      headers,
      body: message,
    });
  } catch (err) {
    throw new Error(`Could not reach ntfy server ${config.url} (${err.cause?.code || err.message})`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ntfy notification failed: ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  return { sent: true, url: config.url, topic: config.topic };
}

/**
 * A test push, so an admin can confirm their phone is subscribed to the topic
 * the server is actually sending to.
 */
export async function sendTestNotification(overrides = {}, sentBy = 'an admin') {
  const config = resolveNtfyConfig(overrides);
  if (!config.topic) throw new Error('No ntfy topic set');
  return post({
    title: 'Deck Lotus test notification',
    message: `Sent by ${sentBy} from Settings. If you can read this, price alerts and trade notices will reach you on topic "${config.topic}".`,
    tags: 'bell,card_index',
  }, overrides);
}

export async function sendPriceAlert({ cardName, foundPrice, threshold, condition }) {
  const condLabel = { nm: 'NM', lp: 'LP', mp: 'MP', hp: 'HP', dm: 'DM', any: 'Any' }[condition] || condition.toUpperCase();
  const title = `Price Alert: ${cardName}`;
  const message = threshold != null
    ? `${cardName} (${condLabel}) is now $${foundPrice.toFixed(2)} — below your $${threshold.toFixed(2)} threshold!`
    : `${cardName} (${condLabel}) hit a new low: $${foundPrice.toFixed(2)}!`;

  return post({ title, message, tags: 'moneybag,card_index' });
}

/** One line summarising a side of a trade, e.g. "2x Lightning Bolt, Brainstorm". */
function summarise(items) {
  if (items.length === 0) return 'nothing';

  const names = items.map((i) => (i.quantity > 1 ? `${i.quantity}x ${i.cardName}` : i.cardName));

  return names.length > 3
    ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
    : names.join(', ');
}

async function push(notice) {
  await post(notice);
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

/** Somebody wants to borrow cards out of your collection. */
export async function sendLoanRequested(borrowerName, loans) {
  await push({
    title: `${borrowerName} wants to borrow cards`,
    message:
      `${borrowerName} asked to borrow ${summarise(loans)}.` +
      ' The cards stay in your collection — approve it on the Loans page once you hand them over.',
    tags: 'handshake,card_index',
  });
}

/** An owner wants their card back. */
export async function sendLoanReturnRequested(loan) {
  await push({
    title: `${loan.lenderUsername} wants a card back`,
    message: `${loan.lenderUsername} has asked for ${loan.quantity}x ${loan.cardName} to be returned.`,
    tags: 'leftwards_arrow_with_hook,card_index',
  });
}
