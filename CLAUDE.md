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
