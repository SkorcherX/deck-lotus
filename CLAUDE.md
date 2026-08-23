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
- `scripts/import-mtgjson.js` clears `printings`, which cascades `trade_items`
  and `deck_card_disruptions` away. Both are backed up and restored there by
  printing `uuid`, same as `deck_cards` and `owned_printings`; a pending trade
  that comes back empty is cancelled rather than left in a shape nobody agreed
  to.
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
- Deployment is Docker on Unraid. Env var changes require recreating the
  container, not just restarting the app or reloading the page.
