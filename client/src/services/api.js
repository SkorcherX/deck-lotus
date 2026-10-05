// API Client for Deck Lotus

class ApiClient {
  constructor() {
    this.baseURL = '/api';
    this.token = localStorage.getItem('token');
  }

  setToken(token) {
    this.token = token;
    if (token) {
      localStorage.setItem('token', token);
    } else {
      localStorage.removeItem('token');
    }
  }

  async request(endpoint, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${this.baseURL}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Request failed' }));
      const error = new Error(body.error || `HTTP ${response.status}`);
      // The status and the rest of the body travel with the error. A caller
      // that can do something specific about a 409 — show what the row really
      // holds — cannot do it from a message string alone.
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return response.json();
  }

  // Auth methods
  async register(username, email, password) {
    const data = await this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    });
    this.setToken(data.accessToken);
    return data;
  }

  async login(username, password) {
    const data = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    this.setToken(data.accessToken);
    return data;
  }

  logout() {
    this.setToken(null);
  }

  async getProfile() {
    return this.request('/auth/me');
  }

  async getUserStats() {
    return this.request('/auth/stats');
  }

  async getApiKeys() {
    return this.request('/auth/api-keys');
  }

  async updatePreferences(payload) {
    return this.request('/auth/preferences', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  async updateAvatar(payload) {
    return this.request('/auth/avatar', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  async uploadAvatar(file) {
    const formData = new FormData();
    formData.append('avatar', file);

    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    // Deliberately bypasses this.request() — it always sets
    // Content-Type: application/json, which breaks multipart uploads. The
    // browser sets the correct multipart boundary itself when Content-Type
    // is left unset.
    const response = await fetch(`${this.baseURL}/auth/avatar/upload`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  async createApiKey(name) {
    return this.request('/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  // Card methods
  async searchCards(query, limit = 20, type = null, rarity = null) {
    const params = new URLSearchParams({ q: query, limit });
    if (type) params.append('type', type);
    if (rarity && rarity !== 'all') params.append('rarity', rarity);
    return this.request(`/cards/search?${params}`);
  }

  async browseCards(filters = {}) {
    const params = new URLSearchParams();
    if (filters.name) params.append('name', filters.name);
    if (filters.colors) params.append('colors', filters.colors); // Already a string from frontend
    if (filters.type) params.append('type', filters.type);
    if (filters.rarities) params.append('rarities', filters.rarities);
    if (filters.sort) params.append('sort', filters.sort);
    if (filters.sets) params.append('sets', filters.sets); // Already a string from frontend
    if (filters.subtypes) params.append('subtypes', filters.subtypes); // Already a string from frontend
    if (filters.cmcMin !== null && filters.cmcMin !== undefined) params.append('cmcMin', filters.cmcMin);
    if (filters.cmcMax !== null && filters.cmcMax !== undefined) params.append('cmcMax', filters.cmcMax);
    if (filters.onlyOwned) params.append('onlyOwned', filters.onlyOwned);
    if (filters.page) params.append('page', filters.page);
    if (filters.limit) params.append('limit', filters.limit);
    return this.request(`/cards/browse?${params}`);
  }

  async getCard(id) {
    return this.request(`/cards/${id}`);
  }

  async getCardPrintings(id) {
    return this.request(`/cards/${id}/printings`);
  }

  async advancedSearch(filters) {
    const params = new URLSearchParams(filters);
    return this.request(`/cards/advanced?${params}`);
  }

  // Removing ownership deletes every printing and finish of the card, so the
  // server refuses to do it on a single request unless `confirmRemoveAll` says
  // the user was shown what it costs. Without it, an owned card comes back
  // untouched with `requiresConfirmation` and the counts to put in the prompt.
  async toggleCardOwnership(cardId, { confirmRemoveAll = false } = {}) {
    return this.request(`/cards/${cardId}/owned`, {
      method: 'POST',
      body: JSON.stringify({ confirmRemoveAll }),
    });
  }

  async getUserOwnedCards() {
    return this.request('/cards/owned/all');
  }

  async getCardOwnershipStatus(cardId) {
    return this.request(`/cards/${cardId}/owned`);
  }

  async getCardOwnershipAndUsage(cardId) {
    return this.request(`/cards/${cardId}/ownership-usage`);
  }

  // `expectedQuantity` turns this into a compare-and-set: pass what the page
  // was showing and a row somebody else has changed since answers 409 instead
  // of quietly taking their copies with it. Omit it for a write that should
  // land regardless.
  //
  // `condition` is optional: send it (even '') to set that condition's row,
  // leave it out to set the total across conditions as before.
  async setOwnedPrintingQuantity(printingId, quantity, isFoil = false, { expectedQuantity, condition, source } = {}) {
    return this.request(`/cards/printings/${printingId}/quantity`, {
      method: 'POST',
      body: JSON.stringify({
        quantity, isFoil, expectedQuantity, source,
        ...(condition === undefined ? {} : { condition }),
      }),
    });
  }

  /** Move one row's copies from one condition to another ('' = not recorded). */
  async changeOwnedCondition(printingId, isFoil, from, to) {
    return this.request(`/cards/printings/${printingId}/condition`, {
      method: 'POST',
      body: JSON.stringify({ isFoil, from, to }),
    });
  }

  // Deck methods
  async getDecks() {
    return this.request('/decks');
  }

  async getDeck(id) {
    return this.request(`/decks/${id}`);
  }

  async createDeck(name, format, description, status) {
    return this.request('/decks', {
      method: 'POST',
      body: JSON.stringify({ name, format, description, status }),
    });
  }

  async updateDeck(id, updates) {
    return this.request(`/decks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async deleteDeck(id) {
    return this.request(`/decks/${id}`, {
      method: 'DELETE',
    });
  }

  async addCardToDeck(deckId, printingId, quantity = 1, isSideboard = false, isCommander = false, boardType = null, isFoil = false) {
    return this.request(`/decks/${deckId}/cards`, {
      method: 'POST',
      body: JSON.stringify({ printingId, quantity, isSideboard, isCommander, boardType, isFoil }),
    });
  }

  // Removes every copy of a card (all printings, all boards) from a deck.
  async removeCardFromDeckByCardId(deckId, cardId) {
    return this.request(`/decks/${deckId}/cards/by-card-id/${cardId}`, {
      method: 'DELETE',
    });
  }

  async updateDeckCard(deckId, cardId, updates) {
    return this.request(`/decks/${deckId}/cards/${cardId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async removeDeckCard(deckId, cardId) {
    return this.request(`/decks/${deckId}/cards/${cardId}`, {
      method: 'DELETE',
    });
  }

  async getDeckStats(deckId) {
    return this.request(`/decks/${deckId}/stats`);
  }

  async getDeckPrice(deckId) {
    return this.request(`/decks/${deckId}/price`);
  }

  async importDeck(name, format, deckList) {
    return this.request('/decks/import', {
      method: 'POST',
      body: JSON.stringify({ name, format, deckList }),
    });
  }

  async cloneDeck(deckId, name) {
    return this.request(`/decks/${deckId}/clone`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  // Deck sharing methods
  async createDeckShare(deckId) {
    return this.request(`/decks/${deckId}/share`, {
      method: 'POST',
    });
  }

  async deleteDeckShare(deckId) {
    return this.request(`/decks/${deckId}/share`, {
      method: 'DELETE',
    });
  }

  async getSharedDeck(token) {
    return this.request(`/decks/share/${token}`);
  }

  async importSharedDeck(token) {
    return this.request(`/decks/share/${token}/import`, {
      method: 'POST',
    });
  }

  async checkDeckLegality(deckId, format) {
    return this.request(`/decks/${deckId}/legality/${format}`);
  }

  // Printing optimization methods
  async analyzeDeckPrintings(deckId, topN = 5, excludeCommander = false) {
    return this.request(`/decks/${deckId}/optimize-printings?topN=${topN}&excludeCommander=${excludeCommander}`);
  }

  async getOptimizationSets(deckId) {
    return this.request(`/decks/${deckId}/optimize-printings/sets`);
  }

  async analyzeSpecificSet(deckId, setCode) {
    return this.request(`/decks/${deckId}/optimize-printings/analyze-set`, {
      method: 'POST',
      body: JSON.stringify({ setCode }),
    });
  }

  async applyPrintingOptimization(deckId, changes) {
    return this.request(`/decks/${deckId}/optimize-printings/apply`, {
      method: 'POST',
      body: JSON.stringify({ changes }),
    });
  }

  // Set methods
  async getSets() {
    return this.request('/sets');
  }

  async getSet(code) {
    return this.request(`/sets/${code}`);
  }

  // Subtype methods
  async getSubtypes() {
    return this.request('/cards/subtypes');
  }

  async getSetCards(code, page = 1) {
    return this.request(`/sets/${code}/cards?page=${page}`);
  }

  async getCollectionClearSummary() {
    return this.request('/inventory/collection/summary');
  }

  // The typed phrase travels with the request: the server checks it too, so
  // the confirmation cannot be lost by skipping the dialog.
  async clearCollection(confirm) {
    return this.request('/inventory/collection', {
      method: 'DELETE',
      body: JSON.stringify({ confirm }),
    });
  }

  // Admin methods
  // Unauthenticated on the server: it has to answer while the card tables are
  // being rebuilt, which is when an API-key lookup could not.
  async getMaintenanceStatus() {
    return this.request('/system/maintenance');
  }

  async syncDatabase(warnSeconds) {
    return this.request('/admin/sync', {
      method: 'POST',
      body: JSON.stringify(warnSeconds === undefined ? {} : { warnSeconds }),
    });
  }

  async getSyncStatus() {
    return this.request('/admin/sync-status');
  }

  async createBackup() {
    // Returns a backup JSON object
    return this.request('/admin/backup', { method: 'POST' });
  }

  async restoreBackup(backup, overwrite = false) {
    return this.request('/admin/restore', {
      method: 'POST',
      body: JSON.stringify({ backup, overwrite }),
    });
  }

  // Backup management methods
  async getBackups() {
    return this.request('/admin/backups');
  }

  async downloadBackupFile(filename) {
    return this.request(`/admin/backups/${filename}`);
  }

  async deleteBackupFile(filename) {
    return this.request(`/admin/backups/${filename}`, {
      method: 'DELETE',
    });
  }

  async createBackupNow() {
    return this.request('/admin/backup/create', {
      method: 'POST',
    });
  }

  async restoreFromBackupFile(filename, overwrite = false) {
    return this.request('/admin/restore-from-file', {
      method: 'POST',
      body: JSON.stringify({ filename, overwrite }),
    });
  }

  async getBackupConfig() {
    return this.request('/admin/backup-config');
  }

  async saveBackupConfig(config) {
    return this.request('/admin/backup-config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  // User management methods (admin only)
  async getAllUsers() {
    return this.request('/admin/users');
  }

  async updateUser(userId, updates) {
    return this.request(`/admin/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async deleteUser(userId) {
    return this.request(`/admin/users/${userId}`, {
      method: 'DELETE',
    });
  }

  async resetUserPassword(userId, password) {
    return this.request(`/admin/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }

  // Public auth config (no auth required) — used to hide the Register option
  async getAuthConfig() {
    return this.request('/auth/config');
  }

  // App settings (admin only)
  async getAdminSettings() {
    return this.request('/admin/settings');
  }

  async updateAdminSettings(updates) {
    return this.request('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  // Shopping methods
  async getBulkBinList(deckIds, { threshold, commonsOnly, includeContested } = {}) {
    const params = new URLSearchParams();
    if (deckIds && deckIds.length) params.set('deckIds', deckIds.join(','));
    if (threshold != null) params.set('threshold', String(threshold));
    if (commonsOnly === false) params.set('commonsOnly', 'false');
    if (includeContested === false) params.set('includeContested', 'false');

    const query = params.toString();
    return this.request(`/shopping/bulk${query ? `?${query}` : ''}`);
  }

  async saveBulkThreshold(threshold) {
    return this.request('/shopping/bulk/threshold', {
      method: 'PUT',
      body: JSON.stringify({ threshold }),
    });
  }

  // `includeContested` widens the list to copies you own but have committed to
  // a deck you did not select. They need no purchase, so they are off unless
  // the page asks — see the note on GET /api/shopping.
  async getShoppingList(deckIds, { includeContested = false } = {}) {
    const params = new URLSearchParams();
    if (deckIds && deckIds.length > 0) {
      params.append('deckIds', deckIds.join(','));
    }
    if (includeContested) params.append('includeContested', 'true');
    return this.request(`/shopping?${params}`);
  }

  // The wanted list: cards being shopped for that no deck asked for.
  async addWantedCard(body) {
    return this.request('/shopping/wanted', { method: 'POST', body: JSON.stringify(body) });
  }

  async addWantedCardsBulk(text) {
    return this.request('/shopping/wanted/bulk', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  }

  async setWantedQuantity(itemId, quantity) {
    return this.request(`/shopping/wanted/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity }),
    });
  }

  async removeWantedCard(itemId) {
    return this.request(`/shopping/wanted/${itemId}`, { method: 'DELETE' });
  }

  async clearWantedCards() {
    return this.request('/shopping/wanted', { method: 'DELETE' });
  }

  // The found pile: cards ticked off at a shop but not yet owned. Marking one
  // found deliberately does NOT touch the collection — the printing you pull
  // out of a bulk box is rarely the one your deck lists, so the pile is
  // reviewed at home and added through the normal bulk-add path.
  async getFoundPile() {
    return this.request('/shopping/found');
  }

  async toggleFoundCard(cardId) {
    return this.request('/shopping/found', {
      method: 'POST',
      body: JSON.stringify({ cardId }),
    });
  }

  async setFoundQuantity(cardId, quantity) {
    return this.request(`/shopping/found/${cardId}`, {
      method: 'PUT',
      body: JSON.stringify({ quantity }),
    });
  }

  async clearFoundPile() {
    return this.request('/shopping/found', { method: 'DELETE' });
  }

  // Inventory methods
  async getInventory(filters = {}) {
    const params = new URLSearchParams();
    // One `name` param per chip, plus the unpinned term from the search box;
    // the server ANDs them together and cannot tell the two apart, which is
    // the point — an unpinned term filters exactly like a pinned one, it just
    // does not survive the next thing typed.
    for (const term of [].concat(filters.names || filters.name || [])) {
      if (term) params.append('name', term);
    }
    if (filters.liveName) params.append('name', filters.liveName);
    if (filters.colors && filters.colors.length > 0) params.append('colors', filters.colors.join(','));
    if (filters.type && filters.type !== 'all') params.append('type', filters.type);
    if (filters.sets && filters.sets.length > 0) params.append('sets', filters.sets.join(','));
    // Pinned creature-type chips plus the one being typed, all ANDed.
    const subtypes = [...(filters.subtypes || []), filters.liveSubtype].filter(Boolean);
    if (subtypes.length > 0) params.append('subtypes', subtypes.join(','));
    if (filters.sort) params.append('sort', filters.sort);
    if (filters.availability) params.append('availability', filters.availability);
    if (filters.commander) params.append('commander', filters.commander);
    if (filters.condition && filters.condition !== 'all') params.append('condition', filters.condition);
    if (filters.rarity && filters.rarity !== 'all') params.append('rarity', filters.rarity);
    if (filters.page) params.append('page', filters.page);
    if (filters.limit) params.append('limit', filters.limit);

    const queryString = params.toString();
    return this.request(`/inventory${queryString ? '?' + queryString : ''}`);
  }

  async getInventoryStats() {
    return this.request('/inventory/stats');
  }

  // Admin cross-user inventory methods
  async getAdminInventory(userIds, filters = {}) {
    const params = new URLSearchParams();
    params.append('userIds', userIds.join(','));
    // Same as getInventory: chips plus the unpinned search term.
    for (const term of [].concat(filters.names || filters.name || [])) {
      if (term) params.append('name', term);
    }
    if (filters.liveName) params.append('name', filters.liveName);
    if (filters.colors && filters.colors.length > 0) params.append('colors', filters.colors.join(','));
    if (filters.type && filters.type !== 'all') params.append('type', filters.type);
    if (filters.sets && filters.sets.length > 0) params.append('sets', filters.sets.join(','));
    // Pinned creature-type chips plus the one being typed, all ANDed.
    const subtypes = [...(filters.subtypes || []), filters.liveSubtype].filter(Boolean);
    if (subtypes.length > 0) params.append('subtypes', subtypes.join(','));
    if (filters.sort) params.append('sort', filters.sort);
    if (filters.availability) params.append('availability', filters.availability);
    if (filters.commander) params.append('commander', filters.commander);
    if (filters.condition && filters.condition !== 'all') params.append('condition', filters.condition);
    if (filters.rarity && filters.rarity !== 'all') params.append('rarity', filters.rarity);
    if (filters.page) params.append('page', filters.page);
    if (filters.limit) params.append('limit', filters.limit);

    return this.request(`/admin/inventory?${params}`);
  }

  async getAdminInventoryStats(userIds) {
    const params = new URLSearchParams();
    params.append('userIds', userIds.join(','));
    return this.request(`/admin/inventory/stats?${params}`);
  }

  async searchForInventoryAdd(query, rarity = null) {
    const params = new URLSearchParams({ q: query });
    if (rarity && rarity !== 'all') params.append('rarity', rarity);
    return this.request(`/inventory/search?${params}`);
  }

  async getInventorySets() {
    return this.request('/inventory/sets');
  }

  async exportInventory(shape = 'precise', condition = 'all') {
    return this.request(`/inventory/export?shape=${encodeURIComponent(shape)}&condition=${encodeURIComponent(condition)}`);
  }

  /** A CardCastle singles export; `dryRun` reports without writing. */
  async importCardCastleSingles(csv, dryRun = false) {
    return this.request('/inventory/import-cardcastle', {
      method: 'POST',
      body: JSON.stringify({ csv, dryRun }),
    });
  }

  // Sealed product
  async getSealed() {
    return this.request('/sealed');
  }

  async searchSealedCatalog(q) {
    return this.request(`/sealed/catalog?q=${encodeURIComponent(q)}`);
  }

  async addSealed(item) {
    return this.request('/sealed', { method: 'POST', body: JSON.stringify(item) });
  }

  async updateSealed(id, changes) {
    return this.request(`/sealed/${id}`, { method: 'PUT', body: JSON.stringify(changes) });
  }

  async deleteSealed(id) {
    return this.request(`/sealed/${id}`, { method: 'DELETE' });
  }

  async importSealedCsv(csv) {
    return this.request('/sealed/import', { method: 'POST', body: JSON.stringify({ csv }) });
  }

  async bulkAddToInventory(items) {
    return this.request('/inventory/bulk-add', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  // --- The deck generator ---------------------------------------------------
  // Generating writes nothing; only acceptGeneratedDeck creates anything.

  async getGeneratorCommanders(includeCommitted = true) {
    return this.request(`/decks/generate/commanders?includeCommitted=${includeCommitted}`);
  }

  async getRevisableDecks() {
    return this.request('/decks/generate/decks');
  }

  async getGeneratorThemes(commanderCardId, includeCommitted = true, extra = {}) {
    const params = new URLSearchParams({ includeCommitted: String(includeCommitted) });
    if (commanderCardId != null) params.set('commanderCardId', commanderCardId);
    // A 60-card format has no commander, so the colours and the format itself
    // have to be stated.
    if (extra.identity) params.set('identity', extra.identity);
    if (extra.format) params.set('format', extra.format);
    // A revision measures its themes against a pool that includes the deck's
    // own cards, so the id travels with the question.
    if (extra.reviseDeckId) params.set('reviseDeckId', extra.reviseDeckId);
    if (extra.splash) params.set('splash', extra.splash);
    if (extra.keepCardIds && extra.keepCardIds.length) params.set('keepCardIds', extra.keepCardIds.join(','));
    // Repeated rather than joined: a custom theme's key holds commas.
    for (const key of extra.customThemes || []) params.append('customTheme', key);
    return this.request(`/decks/generate/themes?${params}`);
  }

  async saveDeckPlan(deckId, plan) {
    return this.request(`/decks/${deckId}/plan`, {
      method: 'PUT',
      body: JSON.stringify(plan === null ? { plan: null } : plan),
    });
  }

  async generateDeck(options) {
    return this.request('/decks/generate', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  async getGeneratorGaps(options) {
    return this.request('/decks/generate/gaps', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  async addGapsToShoppingList(items) {
    return this.request('/decks/generate/gaps/shopping-list', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  async mimicDeck(payload) {
    return this.request('/decks/generate/mimic', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async acceptGeneratedDeck(payload) {
    return this.request('/decks/generate/accept', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async getDeckRules(deckId, format = null) {
    const query = format ? `?format=${encodeURIComponent(format)}` : '';
    return this.request(`/decks/${deckId}/rules${query}`);
  }

  async getBuilderInventory({ deckId, name, type, subtype, rarity, colors, maxCmc, onlyFree, format, colorIdentity, role, fit = false, fitTheme = '', fitSecondary = null, page = 1, limit = 60 } = {}) {
    const params = new URLSearchParams();
    if (deckId) params.set('deckId', deckId);
    if (name) params.set('name', name);
    if (type && type !== 'all') params.set('type', type);
    if (rarity && rarity !== 'all') params.set('rarity', rarity);
    if (subtype && subtype.trim()) params.set('subtype', subtype.trim());
    if (colors && colors.length) params.set('colors', colors.join(','));
    if (maxCmc !== null && maxCmc !== undefined) params.set('maxCmc', maxCmc);
    if (onlyFree) params.set('onlyFree', 'true');
    if (format) params.set('format', format);
    if (role) params.set('role', role);
    if (fit) {
      params.set('fit', 'true');
      if (fitTheme) params.set('fitTheme', fitTheme);
      // '' means "no second theme", so it is sent; null means "read it off the deck".
      if (fitSecondary !== null && fitSecondary !== undefined) params.set('fitSecondary', fitSecondary);
    }
    // An empty string is meaningful here: a colourless commander confines the
    // deck to colourless cards, so it must be sent rather than dropped.
    if (colorIdentity !== null && colorIdentity !== undefined) params.set('colorIdentity', colorIdentity);
    params.set('page', page);
    params.set('limit', limit);

    return this.request(`/inventory/builder?${params.toString()}`);
  }

  async getAvailability({ deckId = null, printingIds = null } = {}) {
    const params = new URLSearchParams();
    if (deckId) params.set('deckId', deckId);
    if (printingIds && printingIds.length) params.set('printingIds', printingIds.join(','));

    const query = params.toString();
    return this.request(`/inventory/availability${query ? `?${query}` : ''}`);
  }

  async resolveBulkAddItems(items) {
    return this.request('/inventory/bulk-resolve', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  async resolveBulkRemoveItems(items) {
    return this.request('/inventory/bulk-remove-resolve', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  async removeCardsFromCollection(cardIds, confirm) {
    return this.request('/inventory/remove-cards', {
      method: 'POST',
      body: JSON.stringify({ cardIds, confirm }),
    });
  }

  async bulkRemoveFromInventory(items) {
    return this.request('/inventory/bulk-remove', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  // `quantity` is how many copies to add, not the total to end up with. The
  // server increments; the response carries the row's new total back.
  //
  // `source` is the audit label for where the click came from, so the history
  // can tell the Inventory flyout apart from the card page. Anything the
  // server does not recognise falls back to 'quick_add'.
  async quickAddToInventory(printingId, quantity = 1, isFoil = false, source = undefined) {
    return this.request('/inventory/quick-add', {
      method: 'POST',
      body: JSON.stringify({ printingId, quantity, isFoil, source }),
    });
  }

  // Price monitoring methods
  async getPriceMonitoringStatus() {
    return this.request('/price-monitoring/status');
  }

  async getPriceWatches() {
    return this.request('/price-monitoring');
  }

  async createPriceWatch(data) {
    return this.request('/price-monitoring', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updatePriceWatch(id, data) {
    return this.request(`/price-monitoring/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deletePriceWatch(id) {
    return this.request(`/price-monitoring/${id}`, {
      method: 'DELETE',
    });
  }

  async getPriceWatchHistory(id) {
    return this.request(`/price-monitoring/${id}/history`);
  }

  async runPriceChecksNow() {
    return this.request('/price-monitoring/check-now', { method: 'POST' });
  }

  async getPriceCheckSchedule() {
    return this.request('/price-monitoring/schedule');
  }

  async setPriceCheckSchedule(schedule) {
    return this.request('/price-monitoring/schedule', { method: 'POST', body: JSON.stringify({ schedule }) });
  }

  // Mana Pool methods
  async manaPoolStatus() {
    return this.request('/manapool/status');
  }

  async manaPoolOptimize(items, model = 'lowest_price') {
    return this.request('/manapool/optimize', {
      method: 'POST',
      body: JSON.stringify({ items, model }),
    });
  }

  async manaPoolValidateDeck(commanderNames, otherCards, format = 'commander') {
    return this.request('/manapool/validate-deck', {
      method: 'POST',
      body: JSON.stringify({ commanderNames, otherCards, format }),
    });
  }

  async manaPoolCardInfo(names) {
    return this.request('/manapool/card-info', {
      method: 'POST',
      body: JSON.stringify({ names }),
    });
  }

  // Trade methods
  async getTrades(status = null) {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.request(`/trades${query}`);
  }

  async getTrade(id) {
    return this.request(`/trades/${id}`);
  }

  async getTradePartners() {
    return this.request('/trades/partners');
  }

  async getPendingTradeCount() {
    return this.request('/trades/pending-count');
  }

  async getPartnerInventory(userId, params = {}) {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== '' && value != null)
    ).toString();

    return this.request(`/trades/partners/${userId}/inventory${query ? `?${query}` : ''}`);
  }

  // A read-only link to your own collection
  async getCollectionShare() {
    return this.request('/collection-share');
  }

  async createCollectionShare() {
    return this.request('/collection-share', { method: 'POST' });
  }

  async regenerateCollectionShare() {
    return this.request('/collection-share/regenerate', { method: 'POST' });
  }

  async deleteCollectionShare() {
    return this.request('/collection-share', { method: 'DELETE' });
  }

  // Someone else's collection, opened from that link (no account needed)
  async getSharedCollection(token) {
    return this.request(`/collection-share/public/${encodeURIComponent(token)}`);
  }

  async getSharedCollectionInventory(token, params = {}) {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== '' && value != null)
    ).toString();

    return this.request(`/collection-share/public/${encodeURIComponent(token)}/inventory${query ? `?${query}` : ''}`);
  }

  async getSharedCollectionStats(token) {
    return this.request(`/collection-share/public/${encodeURIComponent(token)}/stats`);
  }

  async getSharedCollectionSets(token) {
    return this.request(`/collection-share/public/${encodeURIComponent(token)}/sets`);
  }

  async getPartnerStats(userId) {
    return this.request(`/trades/partners/${userId}/stats`);
  }

  async createTradeRequest(toUserId, items, note = null) {
    return this.request('/trades/request', {
      method: 'POST',
      body: JSON.stringify({ toUserId, items, note }),
    });
  }

  async counterTrade(id, items, note = null, declinedItemIds = []) {
    return this.request(`/trades/${id}/counter`, {
      method: 'POST',
      body: JSON.stringify({ items, note, declinedItemIds }),
    });
  }

  async previewTrade(toUserId, items) {
    return this.request('/trades/preview', {
      method: 'POST',
      body: JSON.stringify({ toUserId, items }),
    });
  }

  async createTrade(toUserId, items, note = null) {
    return this.request('/trades', {
      method: 'POST',
      body: JSON.stringify({ toUserId, items, note }),
    });
  }

  async acceptTrade(id) {
    return this.request(`/trades/${id}/accept`, { method: 'POST' });
  }

  async declineTrade(id) {
    return this.request(`/trades/${id}/decline`, { method: 'POST' });
  }

  async cancelTrade(id) {
    return this.request(`/trades/${id}/cancel`, { method: 'POST' });
  }

  async getTradeDisruptions(deckId = null) {
    const query = deckId ? `?deckId=${deckId}` : '';
    return this.request(`/trades/disruptions${query}`);
  }

  async acknowledgeDisruption(id, resolution) {
    return this.request(`/trades/disruptions/${id}/acknowledge`, {
      method: 'POST',
      body: JSON.stringify({ resolution }),
    });
  }

  // Card loans
  async getLoans() {
    return this.request('/loans');
  }

  async getLoanActionCount() {
    return this.request('/loans/action-count');
  }

  async requestLoans(lenderId, items, note = null) {
    return this.request('/loans/request', {
      method: 'POST',
      body: JSON.stringify({ lenderId, items, note }),
    });
  }

  /** action: approve | decline | cancel | request-return | returned */
  async loanAction(id, action) {
    return this.request(`/loans/${id}/${action}`, { method: 'POST' });
  }

  // Deck match record
  async getDeckGames(deckId) {
    return this.request(`/decks/${deckId}/games`);
  }

  async addDeckGame(deckId, game) {
    return this.request(`/decks/${deckId}/games`, {
      method: 'POST',
      body: JSON.stringify(game),
    });
  }

  async updateDeckGame(deckId, gameId, game) {
    return this.request(`/decks/${deckId}/games/${gameId}`, {
      method: 'PUT',
      body: JSON.stringify(game),
    });
  }

  async deleteDeckGame(deckId, gameId) {
    return this.request(`/decks/${deckId}/games/${gameId}`, {
      method: 'DELETE',
    });
  }

  // Audit log
  async getAuditLog(filters = {}) {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(filters)) {
      if (value !== null && value !== undefined && value !== '') {
        params.append(key, value);
      }
    }

    const query = params.toString();
    return this.request(`/audit${query ? `?${query}` : ''}`);
  }

  async getAuditFilters(userId = null) {
    const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    return this.request(`/audit/filters${query}`);
  }

  /**
   * One section of the analytics page. `userIds` is admin-only — the server
   * ignores it for anyone else and answers with their own collection.
   */
  async getAnalytics(section, userIds = null) {
    if (!userIds?.length) return this.request(`/analytics/${section}`);
    const sep = section.includes('?') ? '&' : '?';
    return this.request(`/analytics/${section}${sep}userIds=${userIds.join(',')}`);
  }
}

export default new ApiClient();
