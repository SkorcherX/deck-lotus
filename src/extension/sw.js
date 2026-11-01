// Service worker: runs a price check across the stores Deck Lotus asked for.
//
// Each store is opened in a background tab and the lookup (lookup.js,
// generated from src/shared/localShop.js) runs inside it, so every request is
// an ordinary same-origin request from the store's own page in the user's own
// browser — the same thing the user would do by hand, one card a second.
// Nothing touches a cart. The tab is closed when the store is done.

const BRIDGE_PREFIX = 'deck-lotus-bridge-';
let current = null;

async function connectedSites() {
  const { sites = [] } = await chrome.storage.local.get('sites');
  return sites;
}

async function hasPermission(origin) {
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('The store page did not load.')); }, 60000);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') { cleanup(); resolve(); }
    }
    function cleanup() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function send(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

async function checkStore(store, cards, options, pageTabId) {
  if (!(await hasPermission(store.baseUrl))) {
    send(pageTabId, { type: 'store-error', storeId: store.id, error: 'needs-permission' });
    return;
  }
  const tab = await chrome.tabs.create({ url: store.baseUrl, active: false });
  current.tabId = tab.id;
  try {
    await waitForLoad(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lookup.js'] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [cards, options, store.id],
      func: (cards, options, storeId) => globalThis.__deckLotusLookup(cards, options, (i, n, name) => {
        chrome.runtime.sendMessage({ type: 'lookup-progress', storeId, done: i, total: n, name });
      }),
    });
    if (!result) throw new Error('The lookup did not return anything.');
    send(pageTabId, { type: 'store-result', storeId: store.id, result });
  } catch (err) {
    send(pageTabId, { type: 'store-error', storeId: store.id, error: String(err?.message || err) });
  } finally {
    current.tabId = null;
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'lookup-progress') {
    // From the store tab: pass it on to the Deck Lotus page that asked.
    if (current) send(current.pageTabId, { type: 'progress', storeId: message.storeId, done: message.done, total: message.total, name: message.name });
    return;
  }
  if (message.type === 'cancel') {
    if (current) {
      current.cancelled = true;
      if (current.tabId) chrome.tabs.remove(current.tabId).catch(() => {});
    }
    return;
  }
  if (message.type !== 'run' || !sender.tab) return;

  (async () => {
    // Only a page the user connected may start a run.
    const sites = await connectedSites();
    if (!sites.includes(new URL(sender.url).origin)) return;
    const pageTabId = sender.tab.id;
    if (current) {
      send(pageTabId, { type: 'busy' });
      return;
    }
    current = { pageTabId, tabId: null, cancelled: false };
    try {
      for (const store of message.stores || []) {
        if (current.cancelled) break;
        send(pageTabId, { type: 'store-start', storeId: store.id });
        await checkStore(store, message.cards || [], message.options || {}, pageTabId);
      }
    } finally {
      send(pageTabId, { type: 'done', cancelled: current.cancelled });
      current = null;
    }
  })();
});

// The popup asks for these after the user grants the site.
async function registerBridge(origin) {
  const id = BRIDGE_PREFIX + btoa(origin).replace(/[^a-z0-9]/gi, '');
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!existing.length) {
    await chrome.scripting.registerContentScripts([{ id, matches: [`${origin}/*`], js: ['bridge.js'], runAt: 'document_idle' }]);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type !== 'connect-site' && message.type !== 'disconnect-site') return;
  (async () => {
    const id = BRIDGE_PREFIX + btoa(message.origin).replace(/[^a-z0-9]/gi, '');
    const sites = await connectedSites();
    if (message.type === 'connect-site') {
      await registerBridge(message.origin);
      if (!sites.includes(message.origin)) sites.push(message.origin);
    } else {
      await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
      if (sites.includes(message.origin)) sites.splice(sites.indexOf(message.origin), 1);
    }
    await chrome.storage.local.set({ sites });
    reply({ ok: true });
  })();
  return true;
});
