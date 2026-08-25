/**
 * URLs for the app's pages, so the browser's back button works.
 *
 * Until this existed the address bar never changed: every page was a `.page`
 * div toggled between `hidden` and not, and navigation was a class swap. The
 * browser therefore had exactly one history entry for the whole session, so
 * pressing Back left the app entirely and came back as a cold load — which
 * reads as being thrown out to the login screen. Reload lost your place too,
 * and a page could not be linked to or opened in a new tab.
 *
 * Real paths rather than `#/hash` ones: the server already serves index.html
 * for unknown paths (the SPA catch-all in src/server.js, which the /share/
 * links depend on), and Vite's dev server does the same, so a refresh on
 * /inventory works without anything new on the server side.
 *
 * This module knows nothing about showing or hiding anything. It turns a URL
 * into a route and a route into a URL, and tells its caller when the route
 * changed. Keeping it that way is what lets it be tested without a DOM.
 */

/** Page name → path. The first entry is the default. */
export const ROUTES = [
  ['decks', '/decks'],
  ['cards', '/cards'],
  ['inventory', '/inventory'],
  ['shopping', '/shopping'],
  ['scan', '/scan'],
  ['trades', '/trades'],
  // The trade shop is a page for history's sake but not a linkable one: see
  // the note on parsePath below.
  ['trade-shop', '/trades/shop'],
  ['price-monitoring', '/price-monitoring'],
  ['settings', '/settings'],
  ['audit', '/audit'],
];

const PATH_BY_PAGE = new Map(ROUTES);
const PAGE_BY_PATH = new Map(ROUTES.map(([page, path]) => [path, page]));

export const DEFAULT_PAGE = ROUTES[0][0];

/**
 * Paths this router deliberately does not own.
 *
 * A shared deck is a public page with its own bootstrap in main.js, reached by
 * people who are not logged in and may not have an account. Treating it as an
 * app route would put it behind the auth check.
 */
export function isExternalPath(pathname) {
  return pathname.startsWith('/share/');
}

/**
 * A URL path to a route: `{ page, deckId }`.
 *
 * Anything unrecognised resolves to the default page rather than erroring. A
 * stale bookmark or a typo should land somewhere useful, and there is no
 * 404 page to send it to.
 */
export function parsePath(pathname) {
  const clean = (pathname || '/').replace(/\/+$/, '') || '/';

  if (clean === '/' || clean === '') return { page: DEFAULT_PAGE };

  // The deck builder is the one route carrying an id. It is also the page
  // where a missing Back button hurt most: opening a deck, then wanting to go
  // back to the list, is the single most common move in the app.
  const deckMatch = clean.match(/^\/decks\/(\d+)$/);
  if (deckMatch) return { page: 'deck-builder', deckId: Number(deckMatch[1]) };

  // /trades/shop resolves like any other page, but unlike the deck builder it
  // cannot be rebuilt from its URL: the shop carries who you are trading with,
  // what they have already asked for, and a callback to run when you are done.
  // None of that is in the path, and inventing a partner would be worse than
  // not opening. It exists as a route so Back closes the shop; opened cold it
  // sends the user to the trades list instead (see tradeShop.js).
  if (clean === '/trades/shop') return { page: 'trade-shop' };

  const page = PAGE_BY_PATH.get(clean);
  return page ? { page } : { page: DEFAULT_PAGE };
}

/** A route to a URL path. The inverse of parsePath. */
export function pathFor(page, params = {}) {
  if (page === 'deck-builder') {
    // A deck builder with no id has nothing to show, so it addresses the deck
    // list instead of inventing a URL that would 404 back to the default.
    return params.deckId != null ? `/decks/${params.deckId}` : '/decks';
  }

  return PATH_BY_PAGE.get(page) || PATH_BY_PAGE.get(DEFAULT_PAGE);
}

/** Does the browser already sit on this route? */
export function isCurrentPath(page, params = {}) {
  return window.location.pathname.replace(/\/+$/, '') === pathFor(page, params).replace(/\/+$/, '');
}

/**
 * Put a route in the address bar.
 *
 * `replace` is for corrections rather than movements — landing on `/` and
 * resolving it to `/decks`, or restoring the intended page after a login.
 * Pushing in those cases would leave a history entry that navigates back to
 * the same place, which is the classic "Back does nothing" bug.
 */
export function setRoute(page, params = {}, { replace = false } = {}) {
  const path = pathFor(page, params);

  if (replace || isCurrentPath(page, params)) {
    window.history.replaceState({ page, ...params }, '', path);
  } else {
    window.history.pushState({ page, ...params }, '', path);
  }
}

/**
 * Call `onRoute` whenever the user moves through history.
 *
 * Only popstate: in-app navigation calls setRoute and shows the page itself,
 * because doing both from here would mean every click travelled through the
 * history stack before anything appeared.
 */
export function onPopState(onRoute) {
  window.addEventListener('popstate', () => {
    onRoute(parsePath(window.location.pathname));
  });
}
