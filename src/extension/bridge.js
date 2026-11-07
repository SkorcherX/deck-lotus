// Runs on the Deck Lotus page the user connected in the popup. It only
// relays: page → extension for a run request, extension → page for progress
// and results. window.postMessage is the one channel a page and a content
// script share.
(() => {
  if (window.__deckLotusBridge) return;
  window.__deckLotusBridge = true;
  const version = chrome.runtime.getManifest().version;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'deck-lotus') return;
    if (event.data.type === 'ping') {
      window.postMessage({ source: 'deck-lotus-extension', type: 'ready', version }, location.origin);
    } else if (event.data.type === 'run') {
      chrome.runtime.sendMessage({ type: 'run', stores: event.data.stores, cards: event.data.cards, options: event.data.options });
    } else if (event.data.type === 'cart') {
      chrome.runtime.sendMessage({ type: 'cart', store: event.data.store, items: event.data.items });
    } else if (event.data.type === 'cancel') {
      chrome.runtime.sendMessage({ type: 'cancel' });
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    window.postMessage({ source: 'deck-lotus-extension', ...message }, location.origin);
  });

  window.postMessage({ source: 'deck-lotus-extension', type: 'ready', version }, location.origin);
})();
