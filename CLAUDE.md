# CLAUDE.md

## This is a fork

This repo is a fork of `madeofpendletonwool/deck-lotus`, maintained by SkorcherX
to run fixes and features locally (Unraid/Docker).

Remotes:

- `origin` → `SkorcherX/deck-lotus` — our fork. We push here.
- `upstream` → `madeofpendletonwool/deck-lotus` — the original. Read-only; we
  pull their updates from here, never push.

## Change workflow — follow this every time

Never commit directly to `main`. Every change, however small, goes on a branch:

```bash
git checkout -b fix/short-description     # or feat/ or docs/
# make the edits
git add -A && git commit -m "Message"
git push -u origin fix/short-description
```

Then merge into `main` so a rebuilt image picks it up:

```bash
git checkout main && git merge fix/short-description && git push origin main
```

Optional cleanup once merged:

```bash
git branch -d fix/short-description && git push origin --delete fix/short-description
```

Ask before pushing or merging — those are the outward-facing steps. Making the
branch and the commits is the routine part.

## Syncing with upstream

```bash
git fetch upstream && git checkout main && git merge upstream/main && git push origin main
```

Our `main` has diverged from upstream (it carries our fixes), so these merges
create merge commits rather than fast-forwarding. That is expected. If upstream
independently fixes something we already fixed, expect a conflict in that file
and resolve it in favour of keeping the behaviour we rely on.

## Contributing back

Pushing a branch to `origin` does not notify the original author. Opening a pull
request against `madeofpendletonwool/deck-lotus` is a separate, deliberate step
taken on GitHub — only do it when explicitly asked.

## Notes on the codebase

- Mana Pool integration requires **both** `MANAPOOL_USER_EMAIL` and
  `MANAPOOL_API_TOKEN`. Setting only one leaves the integration disabled.
  See `src/services/manaPoolService.js` (`isConfigured` / `assertConfigured`).
- "Check Legality" and "Validate Deck" are deliberately different code paths:
  legality is checked locally against the MTGJSON data in the app's SQLite
  database and needs no credentials; Validate Deck proxies to Mana Pool's
  `/deck` endpoint and does. They are not duplicates.
- Foil copies are separate rows in **both** `owned_printings`
  (`UNIQUE(user_id, printing_id, is_foil)`) and `deck_cards`
  (`UNIQUE(deck_id, printing_id, is_sideboard, is_foil)`). Anything reading or
  writing either row must carry `is_foil`, or it will silently act on the wrong
  finish — including the backup/restore in `scripts/import-mtgjson.js`, where
  dropping it collapses two rows onto one key and `INSERT OR IGNORE` discards
  the second. Foil copies price off `price_type = 'foil'`, falling back to
  `normal`.
- Trades exist to keep the household total honest: `acceptTrade` moves both
  users' `owned_printings` inside one transaction, so a card cannot be added by
  one person without being removed from the other. Never move inventory for a
  trade outside that transaction.
- Browsing another user's collection must never reveal deck membership. That
  is why `browsePartnerInventory` strips `total_in_decks` and `available`,
  forces `availability: 'all'`, and why `previewImpact` reports only the
  caller's own decks — returning the partner's shortfalls let a shopper probe
  one card at a time to learn what they had built. Any new field on the
  partner-browse or preview paths has to be checked against this.
- A collection can also be shared with someone who has no account, through
  `/collection/:token` (`collection_shares`, one link per user;
  `src/services/collectionShareService.js`). It follows the partner-browse rule
  above — no `total_in_decks`, no `available`, availability forced to `all` —
  and additionally strips per-printing `user_id`/`owned_printing_id`. Its
  public router (`/api/collection-share/public/...`) is GET-only on purpose:
  read-only is structural, not a flag, so never mount a write there.
  Regenerating the link replaces the token in place, which is how an owner
  cuts off whoever had the old one.
- Answering a shopping request is per-card: `trade_items.declined` marks the
  ones the owner would rather keep. Declined rows are never deleted — the
  person who asked has to be able to see what was turned down — so anything
  that moves cards or totals a side must filter on `declined = 0`. `loadItems`
  already does; new queries need to.
- Trades have two shapes: a complete proposal (`pending`) and a shopping
  request (`awaiting_counter`) where one person has picked what they want and
  the other has yet to pick theirs. `trades.awaiting_user_id` says whose turn
  it is — the old "only the recipient can accept" rule stops holding the
  moment a counter-offer sends the trade back the other way.
- A trade that leaves a deck short writes a `deck_card_disruptions` row instead
  of editing the deck. The deck is shown exactly as listed until its owner
  acknowledges it and picks `removed` (deck shrinks; `checkFormatRules` then
  reports the size violation by itself) or `kept`. Nothing expires or
  auto-applies these — an unread one is the point.
- `scripts/import-mtgjson.js` clears `printings`, which cascades `trade_items`,
  `deck_card_disruptions` and `shopping_list_items` away. All three are backed
  up and restored there by printing `uuid`, same as `deck_cards` and
  `owned_printings`; a pending trade that comes back empty is cancelled rather
  than left in a shape nobody agreed to, while a shopping list that lost a row
  is still a coherent list and is left alone.
- The shopping list has two halves and only one of them is stored. What your
  decks need is derived on every read; `shopping_list_items` holds cards wanted
  on their own account. `groupIntoSets` in `src/services/shoppingMerge.js`
  merges them, and that module is deliberately import-free so it can be tested
  where the SQLite driver will not build. The number it produces —
  `quantityNeeded` — is the **larger** of the two claims, never their sum: a
  card is usually on the wanted list *because* a deck wants it, and adding them
  quotes a playset as five. Everything downstream (filters, totals, the Mana
  Pool cart optimizer, the export) reads that one number, so a new consumer
  should use it rather than re-deriving a count from `decks`.
- The weekly MTGJSON sync runs on a cron in `src/services/syncService.js`,
  and node-cron reads a bare expression in the *process's* timezone — which in
  a container with no `TZ` is UTC. "Sundays at 3 AM" therefore fired at 8 PM
  Saturday Pacific until `SYNC_TIMEZONE` was added. Set it (`TZ` is the
  fallback) or the schedule does not mean what it says; startup logs the zone
  it resolved, which is the quickest way to confirm.
- The cron fires five minutes *before* the sync is due, not at it. That lead
  time is the warning users get, so the expression and `WARNING_LEAD_MS` in
  `src/services/maintenanceService.js` have to move together to keep the sync
  starting at its advertised hour.
- Anything a user sees while the import is running must be answerable without
  touching SQLite — the tables are mid-rebuild for those minutes. That is why
  `/api/system/maintenance` is unauthenticated (the API-key branch of
  `authenticate` reads the database) and why maintenance state lives in memory.
  A signed-in user whose collection appears to empty out with no explanation
  reads it as data loss; that is the whole reason the notice exists.
- The audit log (`audit_log`, `src/services/auditService.js`) deliberately
  **denormalises** the card it is talking about — name, set code, collector
  number — and holds `printing_id` as a plain integer with no foreign key.
  `scripts/import-mtgjson.js` clears `printings` every sync, so a real FK
  would either cascade the history away or block the import. `printing_uuid`
  is the identifier that survives a reimport; re-join on that, never on
  `printing_id`. The table is not backed up/restored by the import script
  because nothing in it references a row the import touches.
- Audit writes must never throw. `recordAudit` swallows its own errors on
  purpose: a collection edit that succeeded must not be reported as failed
  because the history could not be written. Keep new writers going through it.
- `setOwnedPrintingQuantity` is the choke point every collection change goes
  through — quick-add, the card page, and both sides of an accepted trade. Its
  fifth argument is the audit context (`source`, and `tradeId`/`actorUserId`
  where relevant). A new caller that omits it still logs, but as `api`, which
  makes the entry much harder to trace back. Bulk paths (`bulkAddToInventory`,
  `importDeck`, `importSharedDeck`, `applyPrintingOptimization`) additionally
  stamp a `batchId` into `detail` so one import can be pulled back out as a
  unit — that is what makes a mis-entered bulk add correctable.
- A user's audit scope is resolved server-side in `src/routes/audit.js`
  (`resolveScope`), never taken from the query. Rows are scoped by
  `audit_log.user_id` — whose collection moved — while `actor_user_id` records
  who caused it. That split is what stops a trade's audit rows from leaking the
  partner's deck names, the same concern the partner-browse rules exist for.
- Deck records are a log (`deck_games`), not a pair of counters. Totals are
  always derived — `getDeckRecord`/`getDeckRecords` in
  `src/services/deckGameService.js`. Do not cache a win/loss count onto
  `decks`: a stored total and the log can disagree, and then neither can be
  trusted. `deck_games` hangs off `decks`, which the MTGJSON import never
  clears, so it is safe from the weekly rebuild.
- The deck-list parser (`src/services/importService.js`) and the inventory
  bulk-add parser (`client/src/components/inventory.js`) accept the same line
  formats on purpose — people paste the same text into both boxes, including
  the nameless `1 FDN 1` set-and-collector form. Lines that resolve to nothing
  come back as `unresolved` so the import modal can list them; a deck import
  never fails as a whole, because a partial list is a legitimate starting
  point that `cloneDeck` is built to copy.
- The theme wizard (`client/public/tools/theme-forge.html`) is a plain static
  page outside the bundle, but it imports `slots.js` and `prompt.js` from
  `/tools/`, which do not exist there on disk: the `theme-forge-modules` plugin
  in `client/vite.config.js` serves them in dev and copies them at build. That
  indirection is what keeps the slot spec and the prompt wording in one place
  instead of pasted into the page. Adding another module the page needs means
  adding it to `FORGE_MODULES`, or the page dies on load with its own message.
- Art prompts name the page background as an exact hex, repeatedly. That is not
  verbosity: the rails are opaque `background-image`s with no mask over them, so
  art that faded to a generic near-black shows as a lighter stripe down the side
  of the window and nothing downstream can fix it. The colour therefore has to be
  chosen *before* the anchor art exists, which is why the wizard asks for it in
  step 3 and why palette extraction then takes the surface hue from that choice
  rather than from the artwork.
- Basic lands are free, everywhere. `src/services/basicLands.js` holds the one
  predicate (`isBasicLandSql` for queries, `isBasicLand` for rows) used by
  inventory availability, trades, deck readiness and the shopping list. It is
  deliberately *basic* lands and not lands: exempting every land would drop
  fetches and duals — the most expensive things on a buy list — off it
  silently. A deck short of nothing but Islands reads as ready.
- "Found it!" on the shopping and bulk-bin lists does **not** add to the
  collection, and must not be changed back. The card pulled out of a bulk box
  shares a name with the one the deck lists and almost never its printing, so
  the tick writes to `found_cards` (see migration 036) — a saved-on-press,
  press-again-to-undo pile that is reviewed at home and turned into inventory
  through the normal `bulkAddToInventory` path, where printings get chosen.
  `found_cards.card_id` is a plain integer with the name denormalised beside
  it, same shape and same reason as `audit_log`.
- Readiness has two surfaces and they say different amounts. The deck list
  shows a bare coloured dot (the label is in the tooltip) because the wording
  wrapped to three lines inside the card; the deck builder shows the wording as
  a chip in the price row, and the per-card breakdown only when that chip is
  pressed. Anything that grows the label has to survive both.
- The backup format (`src/services/backupService.js`) is at version 2, and the
  rule that shapes it is the weekly MTGJSON sync: `cards` and `printings` are
  rebuilt every time, so those tables are never backed up and **nothing may be
  stored as a `printing_id` or `card_id`**. A printing travels as its `uuid`,
  a card as its `name`. Version 1 got this partly right and still lost data —
  it saved `owned_cards` (the legacy presence table, quantity always 1) and
  called it the collection while `owned_printings` went unsaved, and it dropped
  `is_foil` from `deck_cards` where finish is half the unique key. Adding a
  user-scoped table means adding it here too, or a restore silently loses it.
  `test/integration/backupRoundTrip.test.js` backs up, wipes and restores, and
  is the only thing that catches this class of bug — a backup that never gets
  restored looks perfect.
- A deck's status is a claim on cards, not just a label. `deckPriority.js`
  ranks them ready(1) > building(2) > idea(3) > retired(4), and a deck's cards
  are contested **only by decks at least as committed as it is**. Without this
  an EDHREC list left as an `idea` reported a sleeved `ready` deck as short of
  cards sitting in its own box. Equal statuses still contest each other — two
  ready decks over one copy is a real shortfall, which is why this is a
  priority order rather than a rule exempting ready decks. Retired sits below
  idea: out of rotation, so its cards read as available, though it still gets
  a readiness verdict of its own. Readiness (`deckReadinessService.js`) and
  shopping (`shoppingService.js`) share the rule and must stay in step —
  including `decksHoldingCards`, which names the holders behind the count and
  would otherwise name a deck the count never included.
- A scanned price is two claims, and both can be wrong in the same direction.
  The scanner's `COALESCE(normal, foil)` covers 10,972 of 112,815 printings
  that have no normal price — and those are the showcase and serialised ones,
  so the substituted figure is the most inflated available. It therefore
  travels with a `priceType`, and the UI marks a foil-derived figure. Separately,
  where the art matched several printings of one card (`printingsOfBest > 1`)
  there is no single price to quote: `fuseScanResult` reports a `priceRange`
  across them and the live panel shows the span, banding on the low end. Both
  came out of one scan — Flusterstorm from an SOA precon priced at $208.59, the
  foil-only SOA 148, when the card in hand was SOA 18 at $9.78.
- Prices refresh daily, on their own cron, separately from the weekly MTGJSON
  sync (`runPriceSync` / `PRICE_SYNC_START` in `src/services/syncService.js`,
  `PRICES_ONLY=true` in `scripts/import-mtgjson.js`). It is safe to run without
  a maintenance notice precisely because it touches nothing but `prices`, which
  key on `printing_uuid` — the moment it clears or rebuilds anything else that
  stops being true. It skips itself while a full sync is running or pending.
  The prune of rows the feed no longer carries is scoped to **the providers
  that run actually saw**: on the day it was written AllPricesToday carried
  tcgplayer and cardkingdom and no cardmarket at all, and an unscoped prune
  deleted 158,000 cardmarket prices because MTGJSON's file was short a provider
  that morning.
- Deployment is Docker on Unraid. Env var changes require recreating the
  container, not just restarting the app or reloading the page.
- Removing selected cards from the inventory page goes through
  `removeCardsFromCollection` (`POST /api/inventory/remove-cards`), which
  requires `confirm: "CONFIRM"` server-side and stamps one `batchId` on every
  row it deletes. The way back is the audit page: tick removals (or "Select
  whole batch", which filters on `detail.batchId`) and "Copy as import list"
  builds Moxfield lines via `src/shared/auditRecovery.js` for Bulk Add. Trade
  removals are excluded on purpose — re-adding them would double-count a card
  the partner now holds. `test/integration/removeAndRecover.test.js` pins the
  round trip, foils included.
- A loan (`card_loans`, `src/services/loanService.js`) moves possession, never
  ownership: the lender's `owned_printings` row is not touched, so the card
  stays in their collection and the household total is unchanged. While a
  loan is `active` or `return_requested`, `loanNetSql` in `loanHoldings.js`
  adds the copy to the borrower's held count and removes it from the
  lender's — readiness and shopping both wrap their owned count in it, and
  any new "can this deck be played" count must too. A lent copy is also not
  tradeable (`tradeableCopies` in `tradeService.js`). The printing is held by
  `printing_uuid` with no FK, same reason as `audit_log`, so the MTGJSON
  import needs no backup/restore for it; `backupService` does carry it. Only
  the borrower sees which of their decks list a borrowed card — the lender
  never does, per the partner-browse rule above. Returning a loan writes
  `deck_card_disruptions` rows for the borrower (with `loan_id` set, not
  `trade_id`), charged only for the real card-level shortfall and never more
  than the loan's quantity — the same acknowledge-to-resolve flow as trades.
  On the lender's inventory, live loans show as `total_lent_out` / `lent_to`
  and come off `available`; `availability: 'lent_out'` filters to them.
  `browsePartnerInventory` and the collection share strip both fields.
- The in-browser card scanner is gone — the Android companion app
  (`deck-lotus-android`) replaced it. The **server** half stays and is not
  dead code: the phone calls `POST /api/scan/resolve`, `/api/scan/shortfall`
  and `/api/scan/commit`, plus `/api/inventory/bulk-add`, and its bundled
  `card-hashes.bin` / `card-identities.db` are built here by
  `scripts/build-card-hashes.mjs`, `pack-card-hashes.mjs` and
  `build_android_db.mjs`. `GET /api/scan/resolve`, `/hash-index`,
  `/identity` and `POST /api/scan/printings` were only ever called by the
  browser scanner; they are wired into the hash-index refresh in
  `syncService.js`, so removing them is a separate, deliberate job. The
  `scan` audit source label is kept so historical rows still read correctly.
- The analytics page (`src/services/analyticsService.js`, `/api/analytics/*`)
  takes a scope of user ids decided by `resolveScope` in
  `src/routes/analytics.js`: a regular user always gets their own, whatever
  the query says; an admin may pass `userIds` for another user or a household
  combined. In a combined scope a trade or loan between two members never left
  the group, so it is not counted as cards in, out or lent out — it shows as
  `withinGroup`. A new analytics query must take the scope, not a single id. Its activity timeline reads `audit_log`, not
  `owned_printings.created_at` — the audit log is the only record of removals,
  and until this feature `import-mtgjson.js` reset `created_at` to sync day on
  every restore. Value history lives in `collection_value_snapshots`, one row
  per user per day, written by `recordValueSnapshots` at the end of
  `runPriceSync` because prices keep no history of their own. It holds no
  printing or card id, so the import never touches it; `backupService`
  carries it. Charts take colours from `token()`/`tokenRgba()` and rebuild on
  `theme:changed` — Chart.js paints to a canvas, where `var()` is not a colour.
  Deck use (`getDeckUse`) splits copies exactly as the Inventory page's
  `available` does (owned − in decks − lent out) and leaves basic lands out;
  if one changes, change the other, or the two pages disagree about what is
  idle. Trade and loan stats count from the caller's side only — totals, never
  the partner's cards or decks.
- Price history (`price_history`, migration 044) is recorded by
  `recordPriceHistory` after each daily price refresh, for **owned printings
  only** (anyone's, both finishes, TCGplayer) — tracking every printing would
  be ~300k rows a day for cards nobody holds. So a printing's history starts
  the day someone adds it, and "biggest movers" can only ever speak about held
  cards. Keyed by `printing_uuid` with no FK (the weekly import clears
  `printings`), pruned past `PRICE_HISTORY_DAYS`. It is market data, not user
  data, so `backupService` deliberately does not carry it. Movers are priced
  the way `OWNED_COPY_PRICE` prices a copy — foil falls back to normal — and
  compared against the same price type on the baseline day.
- Card condition (TCGplayer scale: NM/LP/MP/HP/DMG, `src/shared/conditions.js`)
  is **optional** and part of `owned_printings`' key (migration 045):
  `UNIQUE(user_id, printing_id, is_foil, condition)`, with `''` meaning "not
  recorded" (NOT NULL, because SQLite lets NULLs duplicate under UNIQUE).
  `setOwnedPrintingQuantity` has two modes: pass `context.condition` (even
  `''`) to set that one row; omit it and the quantity is the *total* across
  conditions — growth lands unrecorded, shrinkage comes out in
  `REMOVAL_ORDER` (unrecorded, then DMG→NM). Every pre-condition caller uses
  the second mode, which is what keeps them behaving as before. A new query
  that reads one `(printing, is_foil)` quantity must `SUM`, or it silently
  reads one condition's row. Trades carry the grade across: `takeOwnedCopies`
  reports which conditions left, and the receiver gets exactly those. Backup
  and the MTGJSON restore carry `condition`.
- Sealed product (migration 046, `sealedService.js`, `/api/sealed`):
  `sealed_products` is MTGJSON's catalog, rebuilt every sync like `printings`,
  so `owned_sealed.sealed_uuid` has no FK and may be NULL (a box the catalog
  doesn't know is still owned). Lots, not products: two boxes at different
  costs are two rows. Value = override → live price (`sealed_prices`, filled
  from AllPricesToday when it carries the uuid; separate from `prices`, which
  has an FK to printings) → the import's dated reference price. Unlinked lots
  are re-matched on read (`linkUnmatched`), so an import made before the
  catalog existed links itself after the next sync. Matching
  (`src/shared/sealedMatch.js`) requires the product-kind tokens to agree
  exactly — a Draft box never matches a Set box. `backupService` carries
  `owned_sealed`.
- CardCastle imports: singles via `POST /api/inventory/import-cardcastle`
  (`cardCastleImport.js`, resolves Scryfall id → set name + number → name,
  then goes through `bulkAddToInventory` with one batchId), sealed via
  `POST /api/sealed/import`. Both accept the raw CSV (`src/shared/csv.js`).
- Condition travels in card lists as an asterisked marker — `*NM*`, `*LP*`,
  `*MP*`, `*HP*`, `*DMG*` — parsed anywhere on the line by `parseCardLine`,
  like `*F*`. The precise inventory export writes it, so an export pasted into
  Bulk Add restores conditions; asterisks keep it from being read as a
  `[SET]` or `(SET)`. The simple export is summed per card and finish and
  deliberately carries none. Inventory and export both take a `condition`
  filter: `all`, `unrecorded` (the `''` rows) or a code.
- A deck's plan (`decks.plan`, migration 047, `src/services/deckPlanService.js`)
  is one JSON column: `{ themeKey, secondaryThemeKey, secondaryShare, keep }`.
  Kept cards are stored by **name**, never `card_id`, for the backup rule
  above; the revise page ticks whichever of them the deck still lists. The
  plan pre-fills the revise page once per deck pick and is the default for
  "Fits this deck" (`deckFitThemes`) — an explicitly picked theme always
  overrides it. A plan with no theme and no kept cards is stored as NULL, so
  "has a plan" means somebody chose something. `backupService` carries it.
- The generator's mana base (`buildManaBase`) caps lands that enter tapped
  early at `MAX_SLOW_LANDS` (1, or 2 in Commander); kept lands count against
  it but are never refused. `entersTapped` in `cardRoleService.js` sorts land
  wording into `always` / `early` (slow lands, tapped fetches — both capped)
  and `conditional` (shocks, check lands, fast lands — not capped). Lands are
  scored on colours the deck wants, theme fit, and tapped-ness; a land making
  no wanted colour gets in only by serving the theme. `landProduces` reads
  every symbol in an "Add …" clause (duals), fetches as what they find, and
  treats strings-attached rainbow mana — commander-identity outside
  Commander, "spend this mana only", "could produce", paid filters — as no
  colour at all.
- Adding cards answers with their price: quick add returns `card` and
  `bulkAddToInventory` returns `cards`, both from `describeAddedPrinting`
  (priced like `OWNED_COPY_PRICE`; `price` is null, not 0, when unpriced).
  The page colours them with `src/shared/priceBands.js`, which mirrors the
  Android app's `PriceBand` thresholds — change one, change the other. The
  `--price-band-*` tokens are locked across themes like rarity. On the
  Inventory page, collection search is the primary field and quick add sits
  behind the "Add cards" button (key `A`) on purpose: an always-open add box
  in that spot got typed searches into it and added cards by accident.
- Mimic (`src/services/deckMimicService.js`, `POST /api/decks/generate/mimic`,
  the deck builder's "Mimic" button) rebuilds an existing deck — usually an
  imported list — card by card from the collection: owned copies first, then a
  stand-in scored on shared role predicates, theme enabler/payoff sides, card
  type, keywords, creature type, size and mana value, assigned globally like
  `pairSwaps`. A stand-in sharing no role or theme is labelled `loose`, not
  passed off as a match. The commander is never substituted. It writes nothing;
  saving goes through `acceptProposal`, so the copy is a new `idea` and the
  original is untouched. The core is pure, like the generator.
