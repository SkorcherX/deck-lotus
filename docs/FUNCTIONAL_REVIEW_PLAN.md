# Functional Review Plan

A staged pass over deck-lotus, run against the test environment
(`npm run test:env:fresh`, port 3100, accounts `admin` / `Valoxi` /
`MacTheCat` / `Viewaskewfool`, password `test`), looking for four classes of
problem:

1. **Card loss** — a quantity that goes down and does not come back up
   somewhere else.
2. **Mis-allocation** — a copy counted for two decks, or a foil counted as a
   normal, or a deck told it is short of a card it is holding.
3. **Usability** — where the thing you need next is, and how many presses away.
4. **Scale** — what breaks at 10 users, 50 decks, 20k cards that is fine now.

Every stage produces findings in one shared format: *what I did, what I
expected, what happened, severity, and whether it is a bug or a design
question*. Nothing is fixed during the review — fixes are separate branches
afterwards, so the record of what was found stays intact.

## Ground rules

- **Reset between stages that write.** `npm run test:env:reset` — otherwise a
  stage inherits the previous stage's half-finished trade and the results stop
  meaning anything.
- **Read the database to confirm, not the UI.** A screen that says the right
  number over a wrong row is the failure mode we care about most. Every
  conservation claim gets checked with SQL against `owned_printings`,
  `deck_cards`, `trade_items`, `found_cards`, `audit_log`.
- **Record the SQL.** A query that proves a total is conserved becomes a
  regression test candidate; the ones that find something become the test.
- **Multi-user checks use two real sessions**, two browser contexts, not one
  account pretending. The privacy rules in CLAUDE.md are all about what the
  *other* session can see.

---

## Stage 0 — Baseline and instrumentation

Before touching anything, establish what the fixture contains and what "correct"
looks like, so later stages have a number to compare against.

- Inventory the fixture: users, decks per user and their statuses, distinct
  printings owned, foil vs normal rows, open trades, disruptions, shopping list
  and found-pile rows.
- Write the **conservation query set**: total copies owned per user per
  printing/finish; total allocated per deck; the derived shortfall. Save these
  in `scripts/` or the review notes so every later stage re-runs the same ones.
- Capture a full API surface map: every route, its auth requirement, and whether
  it writes. This is the checklist Stages 2–6 walk.
- Note the browser console and server log baseline — existing warnings, so a new
  one in a later stage stands out.

**Output:** a baseline snapshot plus the query set. No findings expected.

---

## Stage 1 — Read-only walkthrough (usability and layout)

One pass through the app as a user, changing nothing. This is the stage that
catches placement and crowding, and it has to happen before we know where the
bodies are buried.

- Every page at desktop, tablet and mobile widths, light and dark theme: deck
  list, deck builder, inventory, card page, shopping list, bulk bin, trades,
  trade shop, audit, settings, admin, shared deck, scan.
- For each: what is the primary action, is it above the fold, how many presses
  from the home screen, and does anything important live only in a tooltip.
- Specifically check the two readiness surfaces (list dot vs builder chip) —
  CLAUDE.md flags that anything growing the label has to survive both.
- Empty states and long states: a user with no decks; a deck with 300 cards; a
  card name at maximum length; a set with a very long name.
- Keyboard reachability and focus order on the flows that get used daily
  (quick-add, deck search).

**Output:** a usability findings list, ranked by how often the flow is used.

---

## Stage 2 — Inventory integrity

The core promise: a card you own stays owned, at the finish you own it in.

- Quick-add, card page, and bulk add — the three writers into
  `setOwnedPrintingQuantity`. Confirm each stamps a distinguishable audit
  `source`, and that bulk paths stamp a `batchId`.
- Foil separation end to end: add a foil and a normal of the same printing,
  confirm two rows, confirm both show, confirm editing one does not move the
  other, confirm prices come off `foil` with a `normal` fallback.
- Set quantity to zero — is the row removed, and is that recoverable from the
  audit log.
- Bulk-add parser vs deck-import parser on the same pasted text, including the
  nameless `1 FDN 1` form; the two are meant to agree.
- Concurrency: two tabs editing the same printing's quantity. Does last-write
  silently discard the other.

---

## Stage 3 — Decks and allocation

- Build a contested case deliberately: one copy of a card, two decks. Walk it
  through every status pair (ready/ready, ready/idea, retired/building) and
  confirm `deckPriority` behaves as documented — including `decksHoldingCards`
  naming the same decks the count came from.
- Basic lands read as free everywhere: inventory availability, readiness,
  shopping, trades. And that non-basic lands do *not*.
- Deck import: a list with unresolvable lines completes partially and reports
  them; `cloneDeck` copies the partial result.
- Sideboard and foil as part of the deck-card unique key — move a card between
  main and sideboard and confirm nothing collapses.
- Deck records (`deck_games`) derive totals rather than storing them; delete a
  game and confirm the record moves.
- Format legality vs Validate Deck — confirm they are still distinct paths and
  that legality works with no Mana Pool credentials configured.

---

## Stage 4 — Trades (the highest-risk area)

Trades are the only place inventory moves between users, so they get the most
attention.

- Full proposal (`pending`) accepted: assert conservation — the household total
  of every printing/finish is identical before and after, inside one
  transaction.
- Shopping request (`awaiting_counter`): confirm `awaiting_user_id` governs who
  can act, and that the "only the recipient can accept" assumption is not still
  hiding somewhere.
- Declined items: confirm declined rows persist, are visible to the asker, and
  are excluded from every total and every move.
- Privacy: as user B, browse A's inventory and confirm `total_in_decks` /
  `available` are absent, availability is forced to `all`, and `previewImpact`
  reports only B's own decks. Try to probe one card at a time for A's shortfalls
  and confirm it yields nothing.
- Disruptions: accept a trade that leaves a deck short, confirm the deck renders
  unchanged until acknowledged, and that both `removed` and `kept` land
  correctly — with `checkFormatRules` reporting the size violation on its own.
- Failure injection: kill the server mid-accept (or force an error) and confirm
  no half-moved inventory.
- Audit scope: confirm a trade's rows are scoped by whose collection moved, and
  that neither side's deck names leak through `actor_user_id`.

---

## Stage 5 — Shopping, found pile, bulk bin

- `quantityNeeded` is the **larger** of the two claims, never the sum — verify
  with a card both wanted and deck-needed, and check every downstream consumer
  (filters, totals, Mana Pool cart optimizer, export) reads that one number.
- "Found it!" writes to `found_cards` and does **not** touch inventory; undo by
  pressing again; the review-at-home path into `bulkAddToInventory` picks
  printings properly.
- Shopping list after a deck's status changes, after a trade, after a card is
  acquired — does it self-correct.
- Mana Pool: confirm the integration is cleanly disabled with only one of the
  two env vars set, and that the UI says so rather than failing obscurely.

---

## Stage 6 — Backup, restore, and the weekly rebuild

The class of bug here is invisible until the day it matters.

- Round-trip on the real-shaped fixture: back up, wipe, restore, and diff every
  user-scoped table. Extend `backupRoundTrip.test.js` to cover anything it
  currently misses.
- Confirm nothing in the backup is a `printing_id` or `card_id`; audit every
  user-scoped table against the backup's table list and flag any that is not
  covered.
- Simulate a reimport: clear `printings` on the test copy and run the
  backup/restore inside `import-mtgjson.js`. Confirm foil rows survive, pending
  trades that come back empty are cancelled, shopping lists are left alone, and
  audit rows re-join on `printing_uuid`.
- Maintenance mode: confirm `/api/system/maintenance` answers without touching
  SQLite and that a signed-in user sees the notice rather than an empty
  collection.
- Sync scheduling: confirm the resolved timezone is logged, and that the cron
  expression and `WARNING_LEAD_MS` still agree on the advertised hour.

---

## Stage 7 — Scale and future users

Everything above is correctness. This stage asks what stops working when the
household grows.

- **Data volume:** generate a synthetic user with 20k owned printings and 50
  decks on a copy of the fixture. Time the inventory page, deck readiness,
  shopping derivation, and search. Find the first query that goes superlinear
  and check its indexes.
- **User count:** what is per-user and what is global? Trade partner selection,
  admin screens, notification lists, and the audit log all currently assume a
  handful of people. At 20 users, which of them becomes a wall of names with no
  search or pagination?
- **UI crowding:** the deck list card, the price row chips, the trade shop
  columns — which layouts were sized for the current content and break at 3x.
- **Auth and roles:** is there a meaningful separation between admin and user
  today, and what would need to exist before this was handed to someone outside
  the household.
- **Concurrency:** two users trading simultaneously, and SQLite's single-writer
  behaviour under it. Confirm WAL is on and measure where lock contention starts.

---

## Stage 8 — Consolidate

- Rank every finding: card-loss and mis-allocation first, then usability by
  frequency of use, then scale by how soon it bites.
- Split into: fix now / test now / design decision for you / accepted.
- Turn the queries that found something into tests — the conservation set from
  Stage 0 is the natural home for the trade and backup ones.
- Produce the list of follow-up branches, each scoped to one fix.

---

## Suggested order

Stages 0 and 1 first and together — the baseline and the read-only walkthrough
cost little and inform everything after. Then 4 (trades) before 2 and 3, because
it is where cards actually disappear. 5 and 6 next. 7 last, since it needs a
synthetic dataset and answers questions that are not yet urgent.
