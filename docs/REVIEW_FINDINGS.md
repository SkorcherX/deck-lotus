# Functional Review — Findings

Running log for the review described in [FUNCTIONAL_REVIEW_PLAN.md](FUNCTIONAL_REVIEW_PLAN.md).
Nothing here has been fixed; fixes are separate branches once the review is done.

Environment: `npm run test:env:fresh` on the scrubbed fixture, port 3100.
Fixture as reset on 2026-08-25.

Severity: **high** = cards can be lost or mis-allocated · **med** = wrong or
unreachable information · **low** = polish · **scale** = fine now, not at 10x.

---

## Stage 0 — Baseline

### Fixture contents

| | |
|---|---|
| Users | `admin` (id 1, admin), `Valoxi` (2), `MacTheCat` (3), `Viewaskewfool` (4) |
| Decks | 11 — admin 5 (2 ready, 2 building, 1 idea), Valoxi 4 building, MacTheCat 2 building |
| `owned_printings` | 1,535 rows / 1,921 copies / 90 foil copies across 3 users |
| `deck_cards` | 744 rows |
| Trades | 10 — 5 accepted, 3 declined, 2 cancelled |
| `audit_log` | 1,244 rows |
| Reference | 35,016 cards · 112,815 printings · 868 sets · 446,525 prices |
| Journal mode | WAL · `foreign_keys` on |
| Last migration | 036-add-found-pile |

### Integrity checks — all clean

Orphan rows (owned_printings, deck_cards, trade_items, audit_log, decks): **0**.
Duplicate rows against the `owned_printings` and `deck_cards` unique keys: **0**.
Non-positive quantities anywhere: **0**. The fixture is internally consistent,
which means anything the later stages break was broken by the app, not inherited.

### Gaps the later stages have to construct

The fixture has **no** `pending` or `awaiting_counter` trade, **no** declined
trade item, **no** `deck_card_disruptions`, **no** `deck_games`, **no**
`found_cards`, and one lone `shopping_list_items` row. Every live path in
Stages 4 and 5 therefore has to be built by hand — the fixture only contains
trades that already finished. `Viewaskewfool` owns nothing at all, which makes
them the natural subject for empty-state checks.

### Findings

**S0-1 · low · `test:env:reset` dies with a raw stack trace if the server is up.**
`rmSync` on the held database file throws `EPERM` and Node prints ten lines of
internal frames. The script already refuses to touch the live database with a
friendly message, so the shape exists — this path just doesn't use it. Expected
"stop the running test server first"; got `Error: EPERM, Permission denied`.

**S0-2 · low · the password re-check never goes quiet.**
Every reset prints `↻ Reset 4 passwords to "test" (the fixture was scrubbed by
an older scrub-db.js)`. The commit describes this as a check that stays silent
once the fixture is correct, but the master fixture still carries the bad
hashes, so it rewrites on every single run and the message stops meaning
anything. Re-scrubbing the master once would silence it permanently.

---

## Stage 1 — Read-only walkthrough

Swept `/decks`, `/cards`, `/shopping`, `/inventory`, `/trades`, `/scan`,
`/price-monitoring`, `/audit` at 375px and ~785px, as `admin`. No page overflows
the document horizontally at either width, and no page threw a console error.

> Note on method: screenshots are unavailable in this session (the browser pane
> will not composite), so this pass is measured from the DOM — geometry,
> computed styles, accessible names — rather than looked at. Colour and visual
> balance still need eyes on them; everything below is measured, not judged.

### Findings

**S1-1 · med · unknown `/api/*` GETs return `200 text/html`, not `404 JSON`.**
`GET /api/definitely-not-a-real-endpoint` → **200**, `text/html`, 162 KB of the
SPA shell. Confirmed in source: [src/server.js:88](src/server.js:88) mounts
`app.get('*', …)` → `index.html` ahead of `notFoundHandler` on line 94, with no
`/api` guard. Real routes still 404 correctly (`/api/decks/99999` → 404 JSON),
and non-GET verbs reach the 404 handler — it is GETs only, which is the
asymmetry that makes it confusing. A client calling a typo'd or renamed
endpoint gets `200 OK` and then a JSON parse error, so the failure reads as
"the server is broken" rather than "that route is gone". This is exactly the
class of thing that makes a card-loss bug hard to trace, and it ships 162 KB
per wrong call.

**S1-2 · med · the ownership toggle on Browse Cards has no accessible name and
signals state by colour alone.**
49 of them on a 50-card page. `<button class="ownership-toggle-btn">`, 32×32,
no text content, no `aria-label`, no `title`; owned vs not-owned is
`rgb(var(--success-rgb)/.9)` vs `rgb(var(--scrim-rgb)/.8)` and nothing else. A
screen reader announces fifty anonymous buttons, and a red/green-colourblind
user cannot tell owned from unowned. This is the control that decides whether
you own a card, which is the thing this review exists to protect.

**S1-3 · flag for Stage 2 · that toggle is keyed on `data-card-id`, not a
printing.**
Ownership lives in `owned_printings` per printing *and* finish. A browse-grid
toggle keyed on card id must be choosing a printing on the user's behalf.
Which one, and what it does when you already own a different printing of the
same card, is a Stage 2 question — noted here because it was spotted in the
markup.

**S1-4 · med (mobile) · deck readiness is a 10×10 dot whose verdict lives only
in a `title` tooltip.**
`span.deck-readiness.is-dot`, 10×10px, `title="Ready — Every card owned and
free"` / `"Short 58 to buy · 6 in other decks"`. Tooltips do not fire on touch,
so on a phone the deck list conveys readiness by colour alone, in a 10px dot —
below any tap-target minimum and unreadable if you cannot separate the hues.
CLAUDE.md is right that the wording wrapped badly inside the card; the fix
chosen removed the wording entirely on the surface where it is hardest to
recover. The builder chip is currently the only place the words exist.

**S1-5 · low · sub-24px controls, including one that re-allocates the collection.**
`.deck-status-select` is 20px high. Changing a deck's status changes its
priority claim on cards (`deckPriority`), so this 20px control silently
re-derives readiness and shortfalls across every other deck — the smallest
target on the page is one of the most consequential. Also: native 13×13
checkboxes on Inventory and Scan, 20×20 deck checkboxes on Shopping, an 18px
`select.form-control` on Shopping.

**S1-6 · low · `select.scan-camera-select` is squashed to 21px wide** and has no
accessible name — on the page whose entire premise is picking the right camera.

**S1-7 · low · nav is at capacity at 785px and has no scroll affordance.**
`.nav-links` is `overflow-x: auto` with `scrollWidth` 344 vs `clientWidth` 215
at 375px, so *Price Watch* and *Audit Log* sit off-screen on load. They are
reachable by swiping, but there is no fade, arrow or visible scrollbar saying
so. Eight destinations is already more than fits; this is the nav's ceiling,
not a comfortable margin.

**S1-8 · low · DFC names truncate in Inventory** — `Adventurous Eater // Have a
Bite` needs 238px in a 200px box. The `//` names are the long ones and they are
also the ones where knowing which half you are looking at matters.

### Scale observations (carried to Stage 7)

**S1-9 · scale · the Shopping page renders 3,903 visible elements and 458
interactive controls** — for an account with 5 decks and a single wanted item.
It is by an order of magnitude the heaviest page in the app (next is Inventory
at 943 elements / 38 controls). Nothing about it is per-user; it is per-card,
and the card count is the number that grows.

**S1-10 · scale · `/api/decks` is the slowest endpoint in the app at 56 ms warm
(364 ms cold) for 5 decks.** Everything else answers in 2–6 ms; `/api/inventory`
is 153 ms for 50 rows. `/api/decks` carries the readiness derivation, and the
deck list is the app's home page. Whether 5→50 decks is linear or worse is the
first thing Stage 7 should measure.

**S1-11 · scale · rate limiting is commented out** at
[src/server.js:52](src/server.js:52), marked "REMOVED for self-hosted app".
Correct for a household; a decision to revisit before the app is exposed to
anyone outside it.

### Checked and clear

- Maintenance polling backs off properly — 30 s idle, 4 s active
  ([client/src/components/maintenance.js:7](client/src/components/maintenance.js:7)).
  No busy-poll.
- `/api/system/maintenance` answers 200 with `state: "idle"` and needs no auth,
  as designed.
- No horizontal document overflow on any page at 375px or 785px.
- No uncaught console errors during the sweep.
- Deck list renders exactly one node per deck — no leaked or duplicated cards.

---

## Stage 4 — Trades

**No findings.** This is the stage that was expected to produce them, and it did
not. Seven trades were driven through the real HTTP API as three users, with the
household total re-derived from SQLite around every state change.

### What was exercised

| Scenario | Result |
|---|---|
| Full proposal, accepted | conserved |
| Foil leg alongside a non-foil leg | only foil rows moved |
| Shopping request → counter with a decline → accepted | conserved |
| One-sided gift | conserved |
| Trade that leaves a `ready` deck short | disruption recorded, deck untouched |
| Acknowledge `removed` / `kept` / twice | correct, idempotent |
| Accept after the card was spent elsewhere | rolled back whole |
| 10 adversarial payloads | all rejected, nothing moved |

### Conservation

After every scenario, the collection was diffed printing-by-printing and
finish-by-finish against the **pristine master fixture**. Exactly one entry
differs — `Temple of Silence (FDN)`, 2 → 1 — which is the copy the
failure-injection step deliberately destroyed through the card-page endpoint to
create the race. Every other printing and finish in the household is at its
baseline value. Row counts legitimately drift (a row is deleted at zero and
created on the receiving side); **copies** are the invariant, and copies held.

Integrity after all of it: 0 non-positive quantities, 0 duplicate keys, 0 orphans.

### The specific claims in CLAUDE.md, checked

- **Both sides move in one transaction.** Held under the injected failure: the
  accept threw `Temple of Silence: only 0 copies left, the trade needs 1` and
  *nothing* moved — not even the legs that would have succeeded. The trade stayed
  `pending` and remained fixable rather than being closed in a state nobody agreed to.
- **`awaiting_user_id` governs, not the original roles.** The proposer cannot
  accept their own trade; after a counter-offer the ball moves to the initiator
  and the counter-offerer is then refused with "This trade is not waiting on
  you". A half-finished shopping request cannot be accepted by *either* party.
- **Declined rows are marked, not deleted.** The declined item stayed on the
  trade, was excluded from the movement, survived acceptance, and was visible to
  the person who asked (`declinedItems` in the payload, with `declined: true`).
- **Partner browsing hides deck membership.** Rows come back with
  `card_id, name, mana_cost, cmc, colors, type_line, oracle_text, image_url,
  total_owned, max_price, printings` — no `total_in_decks`, no `available`.
- **`previewImpact` reports only the caller's decks.** `to: []` is hardcoded
  ([src/services/tradeService.js:180](src/services/tradeService.js:180)). Probing
  a card the *partner's* own ready deck depends on returned `{"from":[],"to":[]}` —
  the probe learns nothing. The caller's own side still works: offering a card
  `Deathbloom` depends on returned the deck, board and shortfall.
- **Basic lands are exempt.** Trading away admin's every copy of an `Island`
  that a deck lists 12 of raised no disruption.
- **Decks are never edited by a trade.** `Deathbloom` stayed at 60 cards through
  an accept that left it short, and only dropped to 59 when its owner chose
  `removed`.

### Access control, checked

An uninvolved third user got **404** — not 403 — when reading the trade, so the
response does not confirm that the trade exists. They could not accept it, and
could not acknowledge the other party's disruption ("Disruption not found",
again not an authorisation error that would confirm the row).

### Two design notes carried forward (not defects)

**S4-A · scale · anyone can browse anyone's whole collection.**
`assertTradeable` ([src/services/tradeService.js:806](src/services/tradeService.js:806))
checks only that the partner exists and is not you, and `listTradePartners`
returns every other account on the instance. Correct for a household where
everyone already trusts everyone. At 20 users it means no opt-out and no
blocking — a Stage 7 question about what changes before the app meets someone
outside the house.

**S4-B · note · the double-accept race is currently unreachable, by accident of
the driver.** `acceptTrade` checks status and *then* opens the transaction, which
is a check-then-act. It is safe today only because better-sqlite3 is synchronous
and the app is one process, so two accepts cannot interleave. That safety is a
property of the deployment, not of the code — it would not survive a second
worker process. Worth a comment recording why it is safe, so nobody adds
clustering and quietly removes the guarantee.

---

## Stage 2 — Inventory integrity

Run against a freshly reset fixture. Three findings, two of them the most
serious in the review so far — and they share one root cause: **the controls
labelled "add" write an absolute quantity.**

### Findings

**S2-1 · high · one press of the ownership toggle deletes every printing and
every finish of a card.**

`POST /api/cards/:id/owned` → `toggleCardOwnership`
([src/services/cardService.js:650](src/services/cardService.js:650)). Measured
on the fixture, as `admin`:

| | |
|---|---|
| Before | `Mountain` — 5 rows, **16 copies**, including 1 foil (10E, FDN foil, 3× J25) |
| One press | `{"owned":false,"message":"Card removed from collection"}` |
| After | **0 rows** |
| Press again | 1 copy of 10E #376 — the alphabetically first printing |

A second run on `Forest` deleted **20 copies across 12 rows** the same way.

The delete is `DELETE FROM owned_printings WHERE user_id = ? AND printing_id IN
(SELECT p.id FROM printings p WHERE p.card_id = ?)` — every printing, both
finishes, any quantity. The re-add inserts `quantity 1` of
`ORDER BY set_code, collector_number LIMIT 1` with no `is_foil`, so the button
is not a toggle in any reversible sense: it is *delete everything* and then
*add one arbitrary thing*.

This is the control described in **S1-2** — a 32×32 icon button with no
accessible name, whose only state signal is colour, rendered 49 times per page
of the browse grid. There is no confirmation step.

Two mitigations, both real: every deleted row **is** written to the audit log
with its prior quantity and finish (`detail: {"via":"toggle_ownership"}`), so
the damage is reconstructable by hand; and the toggle only fires on a card you
already own, so it cannot surprise you on a card you were adding.

**S2-2 · high · the Inventory page's quick-add destroys copies and reports
success.**

[client/src/components/inventory.js:774](client/src/components/inventory.js:774):

```js
await api.setOwnedPrintingQuantity(printingId, 1, isFoil);
showToast(isFoil ? 'Foil card added to inventory!' : 'Card added to inventory!', 'success');
```

The `1` is a hardcoded **absolute** quantity — `api.setOwnedPrintingQuantity`
posts to `/cards/printings/:id/quantity`, which is a setter. Measured: `Burst
Lightning`, admin owned **5**, one quick-add → **1**. Four copies gone, and the
toast says the card was added.

It is reached from two user click handlers — the flyout's add button and a
click anywhere on the printing row
([inventory.js:740](client/src/components/inventory.js:740) and
[:749](client/src/components/inventory.js:749)) — so a mis-click on a row in
the printing flyout is enough.

The API endpoint has the same problem independently: `POST
/api/inventory/quick-add` passes its `quantity` (default 1) straight into
`setOwnedPrintingQuantity`, so `quick-add` with no quantity **sets** the row to
1 — measured 4 → 1. Anything driving the API by key hits this too.

**S2-3 · med · concurrent edits silently lose one.**

Both collection endpoints take an absolute quantity, so two tabs that each read
4 and each add one both write 5. Measured: start 4, two concurrent writes, end
**5** — a user who added one copy in each of two tabs expects 6. Both requests
returned 200; nothing indicates a write was discarded. Low likelihood in a
household, but it is the same absolute-write root cause as S2-1 and S2-2, and
it is the failure mode that leaves no trace in the UI.

### Checked and clear

**Bulk-add is exemplary and is the model the other paths should follow.** It
increments (`quantity = quantity + ?`), keeps foil and non-foil apart, stamps
`source=bulk_add`, stamps a `batchId`, **and** records the text the user
actually typed:

```json
{"batchId":"bulk-…-egvpo7","entered":{"cardName":"Hinterland Sanctifier",
 "setCode":"FDN","collectorNumber":"730","quantity":2,"isFoil":false}}
```

That is enough to pull one bad paste back out as a unit, which is exactly what
CLAUDE.md claims for it.

- **Audit sources are correct** where a write actually happens: `quick_add`
  stamps `quick_add`, `card_page` stamps `card_page`, `bulk_add` stamps
  `bulk_add`.
- **Foil separation holds on every ordinary path.** Setting the foil quantity,
  zeroing the foil row, and bulk-adding a foil all left the non-foil row
  untouched, and vice versa.
- **Zeroing a row logs the prior quantity**, so a mis-typed zero is recoverable.
- **The nameless `1 FDN 730` form resolves**, via `bulk-resolve`, to the right
  printing with the right card name.

### The theme

`setOwnedPrintingQuantity` is the right choke point and it does its job — it
logs, it handles finish, it keeps the legacy mirror in step. The bugs are all
in the *callers*: three different affordances that a user reads as "add one"
or "mark as owned" are wired to a setter. The fix is not in the choke point,
it is in giving the callers an increment path — and in making
`toggleCardOwnership` stop being a bulk delete.

---

## Stage 3 — Decks and allocation

The headline claim — `deckPriority` — is **correct in all sixteen status
pairs**. The findings are in the deck-card data model, not the allocation rule.

### The priority matrix

One non-basic card (`Fire Elemental`), owned exactly once, listed once by each
of two fresh decks. Every status pair, readiness read back from `/api/decks`:

| D1 status | contested by D2 when D2 is | verdict |
|---|---|---|
| ready | ready | ✓ |
| building | ready, building | ✓ |
| idea | ready, building, idea | ✓ |
| retired | ready, building, idea, retired | ✓ |

Sixteen of sixteen match `DECK_PRIORITY`. A less committed deck never took a
card from a more committed one; equal statuses always contested. The readiness
payload distinguishes the two cases properly — `missingCopies: 0,
contestedCopies: 1`, label `"Short 1, in other decks"` — so a contested card is
never reported as one you do not own.

### Findings

**S3-1 · med · the `deck_cards` unique key is on `is_sideboard`, but the app has
three boards.**

`UNIQUE(deck_id, printing_id, is_sideboard, is_foil)` — a boolean — while
`board_type` carries `mainboard` / `sideboard` / `maybeboard`. Worse,
`addCardToDeck` checks for an existing row on **`board_type`**
([src/services/deckService.js:326](src/services/deckService.js:326)) but
inserts `is_sideboard` from a *separate* argument
([:342](src/services/deckService.js:342)). The check and the constraint
therefore disagree about what makes a row unique.

Measured — same printing, same deck, three boards:

```
boardType=mainboard  -> 200 ok
boardType=sideboard  -> 500 UNIQUE constraint failed: deck_cards.deck_id,
                             deck_cards.printing_id, deck_cards.is_sideboard,
                             deck_cards.is_foil
boardType=maybeboard -> 500 (same)
```

A card on the mainboard **cannot also be on the maybeboard**, no matter what
the client sends, because the key has no third state — and "I own this and I am
considering it for this deck" is precisely what a maybeboard is for. The
failure also surfaces as a **500 with raw SQLite internals in the response
body**, which is both a poor error and more schema detail than a client needs.

Foil is handled correctly here: foil and non-foil of the same printing on the
same board do get separate rows, as CLAUDE.md requires.

**S3-2 · med · `board_type` and `is_sideboard` desynchronise on the same row.**

Sending `boardType: 'sideboard'` without also sending `isSideboard: true`
writes `board_type='sideboard', is_sideboard=0`:

```
id 1541  printing 338932  board_type 'sideboard'  is_sideboard 0
```

The row now says two different things. Readiness and shopping both read
`COALESCE(board_type, CASE WHEN is_sideboard = 1 …)`, so they follow
`board_type` and stay correct — but the UNIQUE key follows `is_sideboard`, and
any future code that reads `is_sideboard` directly will disagree with them.
`is_sideboard` should be derived from `board_type` rather than passed
alongside it.

**S3-3 · med · updating a deck card with an id that matches nothing returns 200.**

`PUT /api/decks/:id/cards/:cardId` takes a **`deck_cards` row id**. Passing a
printing id — an easy mistake, since `POST .../cards` takes a `printingId` —
returns `200 ok` and changes nothing. Measured: sent `quantity: 99`, got 200,
deck unchanged. A silent no-op on a write endpoint is the shape of bug that
gets diagnosed as "the app lost my edit".

**S3-4 · low · the main shopping list cannot show contested cards.**

`getShoppingList` supports `includeContested`, and the reasoning for defaulting
it off is sound and documented — a contested card needs no *purchase*. But
`GET /api/shopping` never passes the option
([src/routes/shopping.js:42](src/routes/shopping.js:42)); only
`/api/shopping/bulk` exposes it. So a deck can say **"Short 1, in other decks"**
on the deck list while the Shopping page — the obvious place to go next —
offers nothing and explains nothing. The two pages are each correct and
together they leave a dead end. This is a journey gap, not a counting bug.

### Checked and clear

- **Readiness and shopping do not disagree.** The apparent divergence in the
  nine contested pairs is `includeContested` working as designed: readiness
  answers "can I assemble this now", shopping answers "what must I buy". Both
  answers were right in every pair.
- **Deck import survives a partial list.** A paste mixing good lines, the
  nameless `1 FDN 1` set-and-collector form, an invented card name, a bad set
  code, a blank line and a comment imported 4 cards and returned both
  unresolvable lines **with their original text** for the user to fix.
- **`cloneDeck` copies a partial deck exactly** — same rows, same quantities,
  same boards.
- **Records are derived, not stored.** 3 games → `{wins:2, losses:1, winRate:66.7}`;
  deleting the last win → `{wins:1, losses:1, winRate:50}`. No win/loss/draw
  column exists on `decks`.
- **Legality answers locally.** `GET /:id/legality/commander` → 200 with no
  Mana Pool credentials configured, and `/rules` independently reported the
  deck-size violation — the two paths are still distinct, as CLAUDE.md says.
- **Basic lands stay off the derived buy list**, including a deck listing
  4 `Island`.

---

## Stage 5 — Shopping, found pile, bulk bin

The two rules this stage exists to protect — `quantityNeeded` as the **larger**
of the two claims, and "Found it!" never touching the collection — both hold.
Two findings, neither a counting bug.

### `quantityNeeded` is the max, not the sum

Confirmed in both directions, on a card admin owns none of:

| deck needs | wanted | `quantityNeeded` |
|---|---|---|
| 4 | — | 4 |
| 4 | 2 | **4** (not 6) |
| 4 | 9 | **9** |

`Math.max(forDecks, forWanted)` at
[src/services/shoppingMerge.js:190](src/services/shoppingMerge.js:190). The
playset-quoted-as-five failure CLAUDE.md warns about does not occur.

Every downstream consumer reads that one number rather than re-deriving a
count: the bulk-bin view quotes `toBuy 3` against the list's
`quantityNeeded 3`, and the text export uses `card.quantityNeeded || 1`
([client/src/components/shopping.js:1419](client/src/components/shopping.js:1419)).
The bulk bin adds `contested` on top deliberately and keeps it in a separate
field, so the line can still say which copies are a purchase and which are a
card you already own elsewhere.

### Findings

**S5-1 · med · retired decks are on the buy list by default.**

The Shopping page selects **every** deck on load —
`selectedDeckIds = new Set(allDecks.map(d => d.id))`
([client/src/components/shopping.js:440](client/src/components/shopping.js:440),
and again in "Select all" at
[:491](client/src/components/shopping.js:491)) — with no status filter.

Measured: a `retired` deck listing 4 copies of a card admin does not own put
that card on the default shopping list *and* in the bulk-bin list.

This contradicts the intent recorded in
[src/services/deckPriority.js](src/services/deckPriority.js): retired is
"out of rotation", ranked below idea precisely so a shelved deck stops making
its needs everyone else's problem. The allocation rule honours that; the
Shopping page's default selection does not, so you are quoted cards to buy for
decks you have explicitly shelved. The headline totals inherit it too — 6 decks
selected, 141 cards.

It is a default, not a counting error: unticking the deck fixes it, and
shopping for a retired deck you selected *on purpose* is legitimate. The
question is only what should be ticked on arrival.

**S5-2 · low · an unconfigured Mana Pool answers 500.**

`GET /api/manapool/status` correctly reports `{"configured": false}`, but
`POST /optimize` and `POST /validate-deck` both return **500**:

> Mana Pool integration not configured (MANAPOOL_USER_EMAIL and
> MANAPOOL_API_TOKEN missing). Both MANAPOOL_USER_EMAIL and MANAPOOL_API_TOKEN
> are required.

The message is genuinely good — it names both variables and states that both
are required, which is exactly the trap CLAUDE.md documents. The status code is
wrong: a deliberate non-configuration is an expected client-visible state
(503, or 400), not a server fault, and a 500 puts it in the logs as a crash.

### Checked and clear

- **"Found it!" does not touch the collection.** Pressing it left the printing
  at 0 and the household total unchanged, and wrote a single `found_cards` row.
  Pressing again removed the row. `found_cards` carries `card_name` denormalised
  beside the plain-integer `card_id`, the same shape as `audit_log`.
- **The found pile reaches the collection intact.** 3 found copies →
  `bulk-add` → 3 copies on one printing, logged as `bulk_add` with a `batchId`
  and the entered text. The pile is deliberately *not* cleared by the add; the
  client clears it only when nothing failed, so unmatched rows survive for a
  second look.
- **The list self-corrects.** Acquiring one copy of a card a deck needs 3 of
  moved the list from "need 3" to "need 2" with no further action.
- **Basic lands stay off the derived list** (re-confirmed here).

### One note on the docs

CLAUDE.md describes found cards as being "turned into inventory through the
normal `bulkAddToInventory` path, where printings get chosen". In practice the
printing is chosen *for* you by name resolution — the found pile sends only
`{cardName, quantity}`, and my test card resolved to an Unhinged printing. The
app is honest about it (the confirm dialog says "each resolved by name to its
default printing", and the panel tells you to add a different printing from the
card page), so this is a wording drift in the notes rather than a defect — but
"printings get chosen" reads as though the user picks, and they do not.

---

## Stage 6 — Backup, restore, and the weekly rebuild

The stage where a bug is invisible until the day it matters. **The round-trip
and the rebuild are both clean**, and the rebuild turned out to rest on a
structural property worth writing down.

### The round-trip, on production-shaped data

Backed up, wiped **every** user-scoped table to zero, restored, and diffed —
row counts *and* content fingerprints keyed on `uuid`/`username` rather than
surrogate ids:

```
owned_cards 1407 · owned_printings 1535 · audit_log 1244 · deck_cards 744
trades 10 · trade_items 28 · decks 11 · shopping_list_items 2
found_cards 1 · deck_games 2 · deck_shares 1 · users 4
```

All fifteen tables returned to identical counts, and all eleven fingerprints
compared **byte-identical**. Foil rows specifically: `owned_printings` 84 → 84,
`deck_cards` 36 → 36 — the version 1 bug does not recur.

The fixture leaves `deck_games`, `deck_shares` and `found_cards` empty, so I
seeded them first; a round-trip over empty tables would have proved nothing
about exactly the tables most recently added.

**Coverage is complete.** All fifteen user-scoped tables appear in the backup.
Card identity travels as `printing_uuid` (owned_printings, shopping_list_items,
trade_items, deck_cards) or `card_name` (owned_cards, found_cards), never as a
rebuildable id.

### The weekly rebuild, simulated

A full reimport needs a multi-gigabyte download, so I simulated the part that
can actually lose data: on a copy of the fixture, `DELETE FROM printings`, then
rebuild it with **every id reassigned** and the uuids unchanged, then run the
same restore-by-uuid logic `scripts/import-mtgjson.js` uses.

The cascade is real — clearing `printings` took `owned_printings`,
`deck_cards`, `trade_items`, `deck_card_disruptions` and `shopping_list_items`
all to **zero**. `audit_log` survived untouched at 1,244 rows, exactly because
it has no foreign key.

After restore, every one came back intact:

| | before | after |
|---|---|---|
| owned_printings rows / copies / **foil rows** | 1535 / 1921 / **84** | 1535 / 1921 / **84** |
| deck_cards rows / **foil rows** | 744 / **36** | 744 / **36** |
| trade_items | 29 | 29 |
| deck_card_disruptions | 1 | 1 |
| shopping_list_items | 1 | 1 |

The `INSERT OR IGNORE` foil-collapse that CLAUDE.md warns about does not occur:
`is_foil` is in both the backup query and the insert, so the two rows keep
distinct keys.

### The property the rebuild rests on — worth adding to CLAUDE.md

`printings.id` is `INTEGER PRIMARY KEY **AUTOINCREMENT**`, and
`sqlite_sequence` for it currently reads **451284** while live ids run
338470–451284. AUTOINCREMENT never reuses an id, *including after
`DELETE FROM printings`* — so each weekly rebuild assigns ids strictly above
every id that has ever existed.

That is what makes the deliberate retention of `audit_log.printing_id` safe
rather than merely tolerable. Measured on the simulated rebuild: **0** audit
rows with a stale `printing_id` resolve to any printing. A wrong join returns
nothing instead of the wrong card.

It is also fragile in a way nothing currently guards. If `printings.id` ever
became a plain `INTEGER PRIMARY KEY` — which *does* reuse ids — every stale
audit `printing_id` would silently start resolving to whichever card now holds
that number, and the audit log would quietly begin lying about which card
moved. CLAUDE.md says "re-join on `printing_uuid`, never on `printing_id`";
the reason that rule is survivable at all is AUTOINCREMENT, and that is not
written down anywhere.

(Corroborating the code's own comment: exactly **8** audit rows carry a
`printing_id` with no `printing_uuid` — the pre-951ddd1 rows for which the id
really is the last handle. Dropping `printing_id` from the backup would strand
those 8 and nothing else.)

### Findings

**S6-1 · med · the sync schedule's invariant is documented but not enforced.**

`SYNC_CRON = '55 2 * * 0'` ([src/services/syncService.js:18](src/services/syncService.js:18))
and `WARNING_LEAD_MS = 5 * 60 * 1000`
([src/services/maintenanceService.js:14](src/services/maintenanceService.js:14))
currently agree: 02:55 + 5 min = the advertised 03:00. But they are two
constants in two files with no shared definition and **no test asserting the
relationship**. CLAUDE.md says they "have to move together"; nothing makes them.
Changing either one alone silently moves the sync off its advertised hour, or
shortens the warning to nothing. A one-line test deriving 03:00 from both would
close it.

**S6-2 · low · a wrong `DATABASE_PATH` silently creates an empty database.**

Found by making the mistake: running a script without `DATABASE_PATH` set had
`src/db/connection.js` create a brand-new empty SQLite file at the default path
rather than fail. The server migrates on startup, so the result is a
fully-working app with an empty collection and no error anywhere.

On Unraid that is precisely the shape of a volume that did not mount — and
"my collection is empty" with the app otherwise healthy is the panic the
maintenance notice exists to prevent, arriving by a route the notice does not
cover. Refusing to create a database unless a flag says to (as `init-db` would)
would turn a silent empty start into a startup error.

*(No data was lost: the file I created was empty, at a path with no live
database in this checkout, and has been removed.)*

### Checked and clear

- **`/api/system/maintenance` needs no auth and touches no database.**
  Unauthenticated `curl` → **200**, while `/api/decks`, `/api/inventory` and
  `/api/audit` all → 401. `maintenanceService.js` imports no database module at
  all — grep for a `db.` reference returns nothing — so the state really is
  in-memory and answerable mid-rebuild, as CLAUDE.md claims.
- **Pending trades left empty are cancelled.** The `UPDATE trades SET status =
  'cancelled'` guard exists and is scoped to `pending`/`awaiting_counter` with
  zero remaining items. Worth noting it only fires for a trade that lost
  *every* item — a partially-emptied trade survives in a shape neither party
  agreed to. That matches the documented intent ("comes back empty"), so it is
  a question for you rather than a defect.
- **Shopping lists are deliberately left alone** on a partial loss, as
  documented — a list that lost a row is still a coherent list.
- **The timezone is logged at startup**
  ([src/services/syncService.js:138](src/services/syncService.js:138)).
  Source-verified only: the test environment sets `DISABLE_SCHEDULED_JOBS`, so
  the line does not appear in its log.

---

## Stage 7 — Scale

Synthetic dataset on top of the fixture: a **whale** account with **20,000
owned printings across 50 decks** of 100 cards (overlapping, so the decks
genuinely contest each other), plus **20 extra users** with 300 printings each
— 25 accounts and 27,535 owned rows in total. `admin` (515 printings, 5 decks)
stayed as the control.

### S7-1 · high · the deck list takes **2 minutes 46 seconds**, and it blocks the whole server

`GET /api/decks` — the app's home page — with the whale's 50 decks:

| | rows | time |
|---|---|---|
| admin, 1 deck | 41 | 11 ms |
| admin, all 5 decks | 288 | 53 ms |
| whale, **one** deck | 80 | **6,851 ms** |
| whale, all 50 decks | 1,942 | **165,677 ms** |

That is not 40× slower for 40× the data — it is roughly **470× worse per row**.
The readiness query (`claimRows` in
[src/services/deckReadinessService.js](src/services/deckReadinessService.js))
degrades superlinearly because its `OWNED_TOTAL` correlated subquery was being
driven from `owned_printings`: for *every* (deck, card) row it scanned all
20,000 of the whale's owned rows. 1,942 × 20,000 ≈ 39 million lookups.

**The blast radius is the whole instance, not one user.** better-sqlite3 is
synchronous and Node is single-threaded, so those 166 seconds occupy the only
thread there is — no other request is served while one runs. Observed directly:
with the whale's deck list in flight the server sat at **805 seconds of CPU**
and requests from *other* accounts timed out. One user with a big collection
takes the app down for everybody.

### S7-2 · the fix is one command, and it is not a schema change

`sqlite_stat1` **does not exist** — `ANALYZE` has never been run, so SQLite's
planner has no statistics and guesses row counts. It guessed wrong.

Running `ANALYZE` once (499 ms, no schema change, no new index):

| | before | after `ANALYZE` |
|---|---|---|
| admin, all 5 decks | 53 ms | **7 ms** |
| whale, one deck | 6,851 ms | **1 ms** |
| whale, **all 50 decks** | **165,677 ms** | **34 ms** |

**~4,900×**, from a one-off command. The plan flips from scanning
`owned_printings` to `SEARCH op_p USING COVERING INDEX idx_printings_card_id`
— an index that already exists and was simply not being chosen.

I also tried adding a covering index (`owned_printings(printing_id, user_id,
quantity)`). With statistics present it made **no further difference** (2 ms
either way), so it is not needed — the fix is purely `ANALYZE`. I dropped the
index and re-measured to confirm the numbers above stand without it.

Two things to do with this:

1. Run `ANALYZE` on startup, or as a migration.
2. **Run it again at the end of `scripts/import-mtgjson.js`.** The weekly sync
   rebuilds `printings` wholesale, which makes existing statistics stale — the
   one job most likely to silently re-create this problem.

This also explains why nothing looked wrong until now: at fixture scale the bad
plan cost 53 ms and nobody noticed. The plan was always wrong; only the data
was small.

### After `ANALYZE`: where the app actually stands at 40× data

| endpoint | admin | whale | ratio |
|---|---|---|---|
| `GET /api/decks` | 14 ms | 32 ms | 2.3× |
| `GET /api/inventory?limit=54` | 23 ms | 366 ms | 15.9× |
| `GET /api/inventory/stats` | 8 ms | **346 ms** | **43.3×** |
| `GET /api/inventory/sets` | 11 ms | 68 ms | 6.2× |
| `GET /api/shopping` (all decks) | 15 ms | 327 ms | 21.8× |
| `GET /api/shopping/bulk` (all decks) | — | 352 ms | — |
| `GET /api/audit`, `/trades/partners`, `/cards/browse` | — | unchanged | 1.0× |

Everything is usable. `/api/inventory/stats` has the worst *ratio* (43×) and is
the next one to look at, but 346 ms is not a problem yet. Nothing else scales
with collection size at all.

### S7-3 · scale · the Shopping page renders everything, and at 20k that is 22 screens

Stage 1 flagged 3,903 elements for a 5-deck account. The same page as the whale:

| | admin | whale |
|---|---|---|
| DOM nodes | — | **20,121** |
| visible elements | 3,903 | **11,703** |
| interactive controls | 458 | **1,640** |
| page height | — | **22,487 px — 22 screens of scroll** |
| deck checkboxes | 5 | 50 |
| payload | — | 191 KB |

There is no pagination, windowing or virtualisation: every needed card renders
at once. It still *works* — 7 MB of JS heap, no lock-up — but 1,640 controls
and 22 screens is past the point where the page can be read, and it grows with
the collection rather than the user count.

### S7-4 · scale · the trade-partner picker is a plain dropdown

`GET /api/trades/partners` returns all 24 accounts, unpaginated and unfiltered,
into a single `<select>` with 25 options and no search field. It answers in
15 ms, so this is presentation only — but "pick a person" via a 25-item native
dropdown is already awkward, and the endpoint has no notion of recency,
favourites, or who you have actually traded with. Combine with **S4-A** (anyone
may browse anyone) and the user-facing model simply has no concept of a
relationship — which is what the [user-tagging idea](FEATURE_IDEAS.md) is for.

### Checked and clear

- **Admin/user separation holds at the API.** As the non-admin whale,
  `GET /api/admin/users` → `"Admin access required"`.
- **WAL is on**, and no lock contention was observed — because there is none to
  observe. Writes are synchronous in a single process, so they serialise by
  construction. That is also exactly why S7-1 is an instance-wide outage rather
  than one slow page: there is no second thread to serve anyone else. It is the
  same single-process assumption noted in **S4-B**, seen from the other side.
- **Audit log does not degrade** with 25 users or 27k rows (5 ms).
- **`/api/cards/browse` is flat** at 156 ms regardless of account — it reads
  reference data, which does not grow with users.

---

## Stage 8 — Consolidation

Seven stages, 28 findings. **Nothing in the trade engine, the backup format or
the allocation rule was wrong** — the three places most likely to lose a card
all held under deliberate attack. Every real defect is in a *caller*: a button
wired to the wrong function, a default selection, a page that renders
everything, a planner with no statistics.

### The ranking

Ordered by what it costs you, divided by what it costs to fix.

| # | id | severity | what happens | effort |
|---|---|---|---|---|
| 1 | **S7-1** | high | deck list takes 2m46s at 50 decks and blocks the whole server for everyone | **one command** |
| 2 | **S2-1** | high | one press of an unlabelled button deletes every printing and finish of a card (16–20 copies) | small |
| 3 | **S2-2** | high | Inventory quick-add sets the quantity to 1 and reports "Card added" — 5 copies → 1 | **one line** |
| 4 | S5-1 | med | retired decks are ticked by default, so shelved decks are quoted as cards to buy | small |
| 5 | S3-1 | med | a card cannot be on both mainboard and maybeboard; fails as a 500 leaking SQL | migration |
| 6 | S1-2 | med | the ownership toggle has no accessible name; owned/not-owned is colour only | small |
| 7 | S1-4 | med | deck readiness on mobile is a 10×10 dot with the verdict only in a tooltip | small |
| 8 | S1-1 | med | unknown `/api/*` GETs return 200 + 162 KB of HTML instead of 404 JSON | **one line** |
| 9 | S6-1 | med | cron expression and warning lead-time can drift apart silently | one test |
| 10 | S3-3 | med | `PUT /decks/:id/cards/:id` with a wrong id returns 200 and changes nothing | small |
| 11 | S2-3 | med | two concurrent edits silently lose one (absolute writes) | medium |
| 12 | S3-2 | med | `board_type` and `is_sideboard` can disagree on the same row | small |
| 13 | S5-2 | low | unconfigured Mana Pool answers 500 instead of 503 | one line |
| 14 | S6-2 | low | a wrong `DATABASE_PATH` silently creates an empty database | small |
| 15 | S3-4 | low | "Short 1, in other decks" leads to a Shopping page that offers nothing | small |
| 16 | S1-5/6/7/8 | low | sub-24px controls, 21px camera picker, no nav scroll affordance, DFC truncation | small each |
| 17 | S0-1/S0-2 | low | test harness papercuts | tiny |
| — | S8-1 | low | 2 historical audit rows carry no card identity (found by the new check) | none |

Carried as scale/design rather than defects: **S7-3** (Shopping renders 20,121
nodes / 22 screens), **S7-4** (25-option partner dropdown), **S4-A** (anyone may
browse anyone), **S4-B** (accept is check-then-act, safe only single-process),
**S1-9/10/11**.

### What I would do, in order

**Fix now — the three that lose cards or take the app down.**

1. **`ANALYZE` (S7-1).** 165,677 ms → 34 ms. Run it as a migration *and* at the
   end of `scripts/import-mtgjson.js`, because the weekly rebuild is what makes
   statistics stale. Confirmed: the pristine fixture — and therefore
   production — has no `sqlite_stat1` today. This is the single highest-value
   change in the review and it touches no schema.
2. **Quick-add (S2-2).** `client/src/components/inventory.js:774` passes a
   hardcoded `1` to a setter. It needs the current quantity plus one, or an
   increment endpoint. One line, and it stops a daily flow from destroying
   copies while saying "added".
3. **The ownership toggle (S2-1).** Stop it being a bulk delete. At minimum:
   confirm before removing more than one row, and say what will be removed. The
   fuller fix is to make it add one copy and never remove — removal already has
   a better home on the card page, where finish and printing are visible.

**Then the mis-allocation and honesty fixes:** S5-1 (don't tick retired decks),
S3-1/S3-2 (`board_type` as the real key, `is_sideboard` derived), S1-1 (guard
the SPA catch-all), S3-3 (404 instead of a silent no-op).

**Then presentation:** S1-2 and S1-4 together — both are "state conveyed by
colour alone", and both sit on the paths this review exists to protect.

### Tests worth having

The review's own instruments, kept:

- **`scripts/check-integrity.mjs` — written and committed as part of this
  stage.** 13 read-only checks: referential integrity across the three tables
  the weekly import can strand, both unique keys, non-positive quantities,
  `board_type` vs `is_sideboard` agreement, open trades that nobody can answer,
  audit rows that cannot name their card, and whether `ANALYZE` has been run.
  Exits non-zero, so it can run in CI or a cron. It already earned itself:
  pointed at the fixture it found **S8-1**, two historical audit rows with no
  card identity (current code populates them — verified in Stage 2 — so these
  predate the denormalisation).
- **A trade conservation test.** The Stage 4 harness in essence: propose,
  counter with a decline, accept, and assert the household copy count per
  printing *and finish* is unchanged. This is the test that would have caught
  every card-loss bug the review looked for, and there isn't one today.
- **A cron/lead-time test (S6-1).** Three lines: derive 03:00 from `SYNC_CRON`
  and from `WARNING_LEAD_MS` and assert they agree.
- **A readiness priority test.** The 16-pair matrix from Stage 3, as a table
  test. `deckPriority` is correct today and is exactly the kind of rule that
  breaks silently when a fifth status is added.
- **Extend `backupRoundTrip.test.js`** to seed `deck_games`, `deck_shares` and
  `found_cards` before the round-trip. They are empty in the fixture, so the
  existing test proves nothing about the three most recently added tables.

### Suggested branches

One fix per branch, smallest first:

| branch | contents |
|---|---|
| `fix/analyze-query-statistics` | S7-1 — ANALYZE as a migration + at the end of the import |
| `fix/quick-add-increments` | S2-2 — plus the `/api/inventory/quick-add` endpoint semantics |
| `fix/ownership-toggle-not-destructive` | S2-1, S1-2 — behaviour and accessible name together |
| `fix/api-404-json` | S1-1 — guard the catch-all; S5-2, S3-3 as sibling status-code fixes |
| `fix/shopping-default-deck-selection` | S5-1, and S3-4 while in the same file |
| `fix/deck-board-type-key` | S3-1, S3-2 — the migration; do this one alone |
| `fix/readiness-label-on-mobile` | S1-4, and the S1-5/6/7/8 polish set |
| `test/integrity-and-conservation` | the tests above |

### One documentation change worth making

CLAUDE.md should record that **`printings.id` is `AUTOINCREMENT`, and that this
is load-bearing**. It is why keeping a stale `audit_log.printing_id` is safe:
ids are never reused, so a wrong join returns nothing instead of the wrong
card. If that column ever became a plain `INTEGER PRIMARY KEY`, the audit log
would quietly start naming the wrong cards. The existing rule ("re-join on
`printing_uuid`, never on `printing_id`") is survivable *because* of this, and
the reason is written down nowhere.

Two smaller notes: the found pile resolves printings *for* you rather than
letting you choose (the wording in CLAUDE.md implies otherwise), and the
retired-deck exemption in `deckPriority.js` is honoured by the allocation rule
but contradicted by the Shopping page's default selection.

### What held

Worth stating plainly, because it is most of the app:

- **Trades.** Seven trades — proposals, counters, declines, gifts, disruptions,
  a failed accept — moved 1,921 copies with exactly zero drift. Both sides move
  in one transaction; a failure rolls back whole; `awaiting_user_id` governs;
  declined rows persist and never move; the privacy boundary does not leak deck
  membership even under one-card-at-a-time probing.
- **Backup and the weekly rebuild.** A wipe-and-restore of every user-scoped
  table came back byte-identical, foil rows included. A simulated reimport with
  every printing id reassigned lost nothing.
- **Allocation.** `deckPriority` is correct in all sixteen status pairs.
- **The shopping merge.** `quantityNeeded` is the larger claim, never the sum,
  and every downstream consumer reads that one number.
- **Bulk-add** is the model the other write paths should copy: it increments,
  keeps finishes apart, stamps `source` and `batchId`, and records the text you
  typed.
