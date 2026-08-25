import api from './services/api.js';
import { setupAuth } from './components/auth.js';
import { setupDecks } from './components/decks.js';
import { setupDeckBuilder } from './components/deckBuilder.js';
import { setupCards } from './components/cards.js';
import { setupSettings } from './components/settings.js';
import { setupAudit } from './components/audit.js';
import { setupShopping } from './components/shopping.js';
import { setupInventory } from './components/inventory.js';
import { setupMaintenanceWatch, stopMaintenanceWatch, fetchMaintenanceStatus } from './components/maintenance.js';
import { setupScan } from './components/scan.js';
import { setupSharedDeck, loadSharedDeck } from './components/sharedDeck.js';
import { parsePath, setRoute, onPopState, isExternalPath, DEFAULT_PAGE } from './utils/router.js';
import { setupPriceMonitoring } from './components/priceMonitoring.js';
import { setupTrades, refreshTradeBadge } from './components/trades.js';
import { setupTradeShop } from './components/tradeShop.js';
import { setupUserMenu } from './components/userMenu.js';
import { showLoading, hideLoading } from './utils/ui.js';
import { initTheme, currentTheme, applyTheme } from './utils/theme.js';
import { getTheme } from './themes/registry.js';

class App {
  constructor() {
    this.currentPage = 'decks';
    this.init();
  }

  async init() {
    // Reconcile the theme with the registry. The inline script in index.html
    // already stamped one before first paint from localStorage alone, so this
    // is not what avoids the flash — it is what corrects a stored slug that no
    // longer ships, and what wires up the art slots from the manifest.
    initTheme();

    // Setup navigation and components first (before async auth check)
    // This ensures event listeners are registered before any events are dispatched
    this.setupNavigation();
    this.setupComponents();

    // Check if this is a shared deck URL
    const path = window.location.pathname;
    if (path.startsWith('/share/')) {
      const token = path.split('/share/')[1];
      await loadSharedDeck(token);
      return;
    }

    // Check if user is already logged in
    if (api.token) {
      try {
        showLoading();
        const profile = await api.getProfile();
        await this.showApp(profile && profile.user);
      } catch (error) {
        // A failed profile check normally means the session is done. But the
        // card tables being mid-rebuild fails it too, and throwing the user
        // out to a login screen they cannot get past — while their collection
        // appears to be gone — is the worst possible reading of a routine
        // update. Hold them instead, and carry on once it finishes.
        const maintenance = await fetchMaintenanceStatus();

        if (maintenance && maintenance.state === 'running') {
          setupMaintenanceWatch();
          window.addEventListener('maintenance:finished', () => this.init(), { once: true });
        } else {
          api.logout();
          this.showAuthPage();
        }
      } finally {
        hideLoading();
      }
    } else {
      this.showAuthPage();
    }
  }

  showAuthPage() {
    stopMaintenanceWatch();
    document.getElementById('auth-page').classList.remove('hidden');
    document.getElementById('navbar').classList.add('hidden');
    this.hideAllPages();
  }

  async showApp(user) {
    // The account's theme wins over whatever this browser had stored, so the
    // choice follows the user to a new device. Skipped when they already
    // match; applying it also re-mirrors to localStorage, so the next
    // pre-paint gets it right without waiting for the profile.
    if (user && user.theme && user.theme !== currentTheme()) {
      await applyTheme(user.theme);
    }

    document.getElementById('auth-page').classList.add('hidden');
    document.getElementById('navbar').classList.remove('hidden');
    document.getElementById('app-footer').classList.remove('hidden');
    this.renderFooterTheme();
    document.addEventListener('theme:changed', () => this.renderFooterTheme());
    await setupUserMenu();

    // Watch for card-data updates. Only for signed-in users: they are the
    // ones with a collection that would appear to empty out mid-session.
    setupMaintenanceWatch();

    // A trade waiting for an answer is the one thing here that needs the
    // user rather than the other way round, so the count is shown up front
    // and refreshed whenever a trade is answered.
    refreshTradeBadge();
    window.addEventListener('trades:changed', refreshTradeBadge);

    // Whatever the URL asked for — a bookmark, a refresh, a link someone
    // pasted — rather than always the deck list. 'replace' because this is
    // the first entry in the session and there is nothing to go back to.
    const route = parsePath(window.location.pathname);
    this.showPage(route.page, { history: 'replace', deckId: route.deckId });
  }

  renderFooterTheme() {
    const el = document.getElementById('app-footer-theme');
    if (!el) return;
    const theme = getTheme(currentTheme());
    el.textContent = theme ? `Theme: ${theme.name}` : '';
  }

  hideAllPages() {
    document.querySelectorAll('.page').forEach(page => {
      if (page.id !== 'auth-page') {
        page.classList.add('hidden');
      }
    });
  }

  /**
   * Show a page, and put it in the address bar.
   *
   * `history: 'push'` is the default because that is what a click is — a move
   * the user should be able to undo with Back. 'replace' corrects the URL
   * without adding an entry (resolving `/` to `/decks`, say) and 'none' is for
   * a popstate, where the browser has already moved and pushing again would
   * fight it.
   */
  showPage(pageName, { history = 'push', deckId = null } = {}) {
    // Components that hold a resource while their page is visible — the scan
    // page's camera stream — need to know they are being navigated away from.
    if (this.currentPage && this.currentPage !== pageName) {
      window.dispatchEvent(new CustomEvent('page:leave', { detail: { page: this.currentPage } }));
    }

    this.currentPage = pageName;

    if (history !== 'none') {
      setRoute(pageName, { deckId }, { replace: history === 'replace' });
    }

    // The deck builder is a page like any other as far as history is
    // concerned, but it has to fetch before it can render, so it owns its own
    // showing. Everything below here is for the plain pages.
    if (pageName === 'deck-builder') {
      this.hideAllPages();
      window.dispatchEvent(new CustomEvent('open-deck', { detail: { deckId, fromHistory: true } }));
      return;
    }

    // Hide all pages
    this.hideAllPages();

    // Show selected page
    const page = document.getElementById(`${pageName}-page`);
    if (page) {
      page.classList.remove('hidden');
    }

    // Update nav links
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.remove('active');
      if (link.dataset.page === pageName) {
        link.classList.add('active');
      }
    });

    // Trigger page-specific logic
    switch (pageName) {
      case 'decks':
        window.dispatchEvent(new CustomEvent('page:decks'));
        break;
      case 'cards':
        window.dispatchEvent(new CustomEvent('page:cards'));
        break;
      case 'shopping':
        window.dispatchEvent(new CustomEvent('page:shopping'));
        break;
      case 'inventory':
        window.dispatchEvent(new CustomEvent('page:inventory'));
        break;
      case 'scan':
        window.dispatchEvent(new CustomEvent('page:scan'));
        break;
      case 'trades':
        window.dispatchEvent(new CustomEvent('page:trades'));
        break;
      case 'price-monitoring':
        window.dispatchEvent(new CustomEvent('page:price-monitoring'));
        break;
      case 'settings':
        window.dispatchEvent(new CustomEvent('page:settings'));
        break;
      case 'audit':
        window.dispatchEvent(new CustomEvent('page:audit'));
        break;
    }
  }

  setupNavigation() {
    // Nav links
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const page = link.dataset.page;
        this.showPage(page);
      });
    });

    // Settings lives in the avatar menu rather than the top row, so it has no
    // .nav-link to hang off. The menu asks for the page by event instead of
    // reaching into the app.
    window.addEventListener('navigate', (e) => {
      const page = e.detail?.page;
      if (page) this.showPage(page, { deckId: e.detail?.deckId ?? null });
    });

    // Back and forward. The browser has already moved by the time this fires,
    // so the page is shown without touching history again.
    onPopState(({ page, deckId }) => {
      if (!api.token) return this.showAuthPage();
      this.showPage(page, { history: 'none', deckId });
    });
  }

  setupComponents() {
    setupAuth(async (user) => {
      await this.showApp(user);
    });
    setupDecks();
    setupDeckBuilder();
    setupCards();
    setupShopping();
    setupInventory();
    setupScan();
    setupSettings();
    setupAudit();
    setupPriceMonitoring();
    setupTrades();
    setupTradeShop();
    setupSharedDeck();
  }
}

// Start the app
new App();
