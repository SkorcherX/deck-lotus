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
- Deployment is Docker on Unraid. Env var changes require recreating the
  container, not just restarting the app or reloading the page.
