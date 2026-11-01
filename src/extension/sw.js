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

// Connecting a Deck Lotus site. The popup names the site and then asks for
// the permission; the rest happens here once it is granted, because Firefox
// closes the popup the moment its permission prompt appears, so nothing the
// popup meant to do afterwards would run.
const bridgeId = (origin) => BRIDGE_PREFIX + btoa(origin).replace(/[^a-z0-9]/gi, '');

async function connectSite(origin) {
  const id = bridgeId(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!existing.length) {
    await chrome.scripting.registerContentScripts([{ id, matches: [`${origin}/*`], js: ['bridge.js'], runAt: 'document_idle' }]);
  }
  const sites = await connectedSites();
  if (!sites.includes(origin)) await chrome.storage.local.set({ sites: [...sites, origin] });
  // Registered scripts only reach pages loaded from now on; the open ones get it now.
  for (const tab of await chrome.tabs.query({ url: `${origin}/*` })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['bridge.js'] }).catch(() => {});
  }
}

async function disconnectSite(origin) {
  await chrome.scripting.unregisterContentScripts({ ids: [bridgeId(origin)] }).catch(() => {});
  const sites = await connectedSites();
  await chrome.storage.local.set({ sites: sites.filter((s) => s !== origin) });
}

chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  const { pendingConnect } = await chrome.storage.local.get('pendingConnect');
  if (pendingConnect && origins.includes(`${pendingConnect}/*`)) {
    await chrome.storage.local.remove('pendingConnect');
    await connectSite(pendingConnect);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type === 'pending-connect') {
    chrome.storage.local.set({ pendingConnect: message.origin });
    // Already granted (a reconnect): onAdded will not fire, so finish here.
    chrome.permissions.contains({ origins: [`${message.origin}/*`] }).then((granted) => {
      if (granted) chrome.storage.local.remove('pendingConnect').then(() => connectSite(message.origin));
    });
    return;
  }
  if (message.type !== 'disconnect-site') return;
  disconnectSite(message.origin).then(() => reply({ ok: true }));
  return true;
});
